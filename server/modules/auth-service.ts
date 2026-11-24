// Authentication, session cookies, CSRF origin guards, RBAC checks, email verification & password resets.
import type { IncomingMessage } from "node:http";
import { generateOpaqueToken, hashPassword, hashToken, verifyPassword } from "../security/crypto.ts";
import type { EmailService } from "./email-service.ts";
import type { PlatformService } from "./platform-service.ts";
import type { UserRecord } from "./platform-types.ts";

export const SESSION_COOKIE_NAME = "spacix_sid";

export class AuthError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus = 401) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

export function clientIpFromReq(req: IncomingMessage): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim().slice(0, 64);
  return req.socket?.remoteAddress?.slice(0, 64) ?? null;
}

export function userAgentFromReq(req: IncomingMessage): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 500) : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function buildSessionCookie(token: string, maxAgeSeconds: number, isSecure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
    isSecure ? "SameSite=None" : "SameSite=Lax",
  ];
  if (isSecure) {
    parts.push("Secure", "Partitioned");
  }
  return parts.join("; ");
}

export function clearSessionCookie(isSecure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Max-Age=0",
    isSecure ? "SameSite=None" : "SameSite=Lax",
  ];
  if (isSecure) parts.push("Secure", "Partitioned");
  return parts.join("; ");
}

export function extractAuthToken(req: IncomingMessage): { token: string | null; viaCookie: boolean } {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return { token, viaCookie: false };
  }
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[SESSION_COOKIE_NAME];
  return sid ? { token: sid, viaCookie: true } : { token: null, viaCookie: false };
}

export function isSuperAdmin(user: UserRecord | null | undefined): boolean {
  return Boolean(user && (user.roles.includes("super_admin") || user.permissions.includes("roles.manage")));
}

export function hasPermission(user: UserRecord | null | undefined, perm: string): boolean {
  if (!user || !user.is_admin || user.status !== "active") return false;
  if (user.roles.includes("super_admin")) return true;
  return user.permissions.includes(perm);
}

export class AuthService {
  private readonly platform: PlatformService;
  private readonly email: EmailService;

  constructor(platform: PlatformService, email: EmailService) {
    this.platform = platform;
    this.email = email;
  }

  private async getSecurityConfig() {
    const settings = await this.platform.getSettingsMap(false);
    const raw = (settings.security_config ?? {}) as Record<string, unknown>;
    return {
      sessionTtlHours: Math.max(1, Math.min(720, Number(raw.sessionTtlHours ?? 168))),
      maxFailedLogins: Math.max(3, Math.min(50, Number(raw.maxFailedLogins ?? 10))),
      requireStrongPasswords: raw.requireStrongPasswords !== false,
    };
  }

  private validatePasswordPolicy(password: string, strong: boolean) {
    if (typeof password !== "string" || password.length < 8) {
      throw new AuthError("Password must be at least 8 characters long.", 400);
    }
    if (strong && (!/[a-zA-Z]/.test(password) || !/\d/.test(password))) {
      throw new AuthError("Password must include both letters and numbers.", 400);
    }
  }

  async resolveRequestUser(req: IncomingMessage): Promise<{ user: UserRecord; sessionId: string; isAdminSession: boolean } | null> {
    const { token } = extractAuthToken(req);
    if (!token) return null;
    const hit = await this.platform.store.getSessionByTokenHash(hashToken(token));
    if (!hit) return null;
    if (hit.user.status !== "active") return null;
    void this.platform.store.touchSession(hit.session.id).catch(() => {});
    return { user: hit.user, sessionId: hit.session.id, isAdminSession: hit.session.is_admin };
  }

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ user: UserRecord; token: string; ttlSeconds: number; verificationToken?: string }> {
    const registrationOpen = await this.platform.isFlagEnabled("registration_enabled", true);
    if (!registrationOpen) {
      throw new AuthError("New user registration is currently disabled by administrators.", 403);
    }
    const email = (input.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AuthError("Please enter a valid email address.", 400);
    }
    const sec = await this.getSecurityConfig();
    this.validatePasswordPolicy(input.password, sec.requireStrongPasswords);

    const existing = await this.platform.store.getUserByEmail(email);
    if (existing) {
      throw new AuthError("An account with that email already exists.", 409);
    }

    const settings = await this.platform.getSettingsMap(false);
    const defaultCredits = Math.max(0, Math.trunc(Number(settings.default_signup_credits ?? 25)));
    const requireVerify = await this.platform.isFlagEnabled("require_email_verification", false);

    const user = await this.platform.store.createUser({
      email,
      passwordHash: hashPassword(input.password),
      displayName: (input.displayName || email.split("@")[0]).trim().slice(0, 120),
      isAdmin: false,
      emailVerified: !requireVerify,
      roles: ["user"],
      initialCredits: defaultCredits,
      planId: "plan_free",
    });

    const token = generateOpaqueToken(32);
    const expiresAt = new Date(Date.now() + sec.sessionTtlHours * 3600_000).toISOString();
    await this.platform.store.createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      isAdmin: false,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresAt,
    });
    await this.platform.store.recordLoginAttempt({
      userId: user.id,
      email,
      success: true,
      isAdminPortal: false,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    let verificationToken: string | undefined;
    if (requireVerify) {
      verificationToken = generateOpaqueToken(24);
      await this.platform.store.createEmailVerification(
        user.id,
        hashToken(verificationToken),
        new Date(Date.now() + 24 * 3600_000).toISOString(),
      );
      await this.email.sendEmail({
        recipientUserId: user.id,
        recipientEmail: email,
        subject: "Verify your SPACIX account",
        body: `Use this verification code to verify your email address: ${verificationToken}`,
        templateKey: "email_verification",
      });
    }

    return { user, token, ttlSeconds: sec.sessionTtlHours * 3600, verificationToken };
  }

  async login(input: {
    email: string;
    password: string;
    adminPortal?: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ user: UserRecord; token: string; ttlSeconds: number }> {
    const email = (input.email || "").trim().toLowerCase();
    if (!email || !input.password) {
      throw new AuthError("Email and password are required.", 400);
    }

    const sec = await this.getSecurityConfig();
    const recent = await this.platform.store.listLoginHistory({ search: email, limit: 25 });
    const windowCutoff = Date.now() - 15 * 60_000;
    const recentFails = recent.filter(
      (l) => !l.success && l.email.toLowerCase() === email && new Date(l.created_at).getTime() >= windowCutoff,
    ).length;
    if (recentFails >= sec.maxFailedLogins) {
      throw new AuthError("Too many failed login attempts. Please wait 15 minutes before trying again.", 429);
    }

    const user = await this.platform.store.getUserByEmail(email);
    const ok = Boolean(user && user.password_hash && verifyPassword(input.password, user.password_hash));

    if (!ok || !user) {
      await this.platform.store.recordLoginAttempt({
        userId: user?.id ?? null,
        email,
        success: false,
        failureReason: "Invalid credentials",
        isAdminPortal: Boolean(input.adminPortal),
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      throw new AuthError("Invalid email or password.", 401);
    }

    if (user.status !== "active") {
      await this.platform.store.recordLoginAttempt({
        userId: user.id,
        email,
        success: false,
        failureReason: `Account ${user.status}`,
        isAdminPortal: Boolean(input.adminPortal),
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      throw new AuthError(`Account is ${user.status}. Contact an administrator for assistance.`, 403);
    }

    if (input.adminPortal && !user.is_admin) {
      await this.platform.store.recordLoginAttempt({
        userId: user.id,
        email,
        success: false,
        failureReason: "Missing administrator role",
        isAdminPortal: true,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      throw new AuthError("Administrator permissions are required for this portal.", 403);
    }

    const now = new Date().toISOString();
    const updated = (await this.platform.store.updateUser(user.id, { lastLoginAt: now, lastActiveAt: now })) ?? user;
    const token = generateOpaqueToken(32);
    const expiresAt = new Date(Date.now() + sec.sessionTtlHours * 3600_000).toISOString();
    await this.platform.store.createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      isAdmin: user.is_admin,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresAt,
    });
    await this.platform.store.recordLoginAttempt({
      userId: user.id,
      email,
      success: true,
      isAdminPortal: Boolean(input.adminPortal),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return { user: updated, token, ttlSeconds: sec.sessionTtlHours * 3600 };
  }

  async bootstrapSuperAdmin(input: {
    email: string;
    password: string;
    displayName: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ user: UserRecord; token: string; ttlSeconds: number }> {
    const existingAdmins = await this.platform.store.countAdmins();
    if (existingAdmins > 0) {
      throw new AuthError("Super Admin bootstrap is already complete.", 403);
    }
    const email = (input.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AuthError("Please enter a valid Super Admin email address.", 400);
    }
    const sec = await this.getSecurityConfig();
    this.validatePasswordPolicy(input.password, true);

    const existingUser = await this.platform.store.getUserByEmail(email);
    let user: UserRecord;
    if (existingUser) {
      user = (await this.platform.store.updateUser(existingUser.id, {
        passwordHash: hashPassword(input.password),
        displayName: (input.displayName || existingUser.display_name).trim(),
        isAdmin: true,
        emailVerified: true,
        status: "active",
        roles: ["super_admin"],
      }))!;
    } else {
      user = await this.platform.store.createUser({
        email,
        passwordHash: hashPassword(input.password),
        displayName: (input.displayName || "Platform Super Admin").trim(),
        isAdmin: true,
        emailVerified: true,
        roles: ["super_admin"],
        initialCredits: 1000,
        planId: "plan_studio",
      });
    }

    const token = generateOpaqueToken(32);
    const expiresAt = new Date(Date.now() + sec.sessionTtlHours * 3600_000).toISOString();
    await this.platform.store.createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      isAdmin: true,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      expiresAt,
    });
    await this.platform.store.recordAuditLog({
      admin_user_id: user.id,
      action: "bootstrap.super_admin",
      target_type: "user",
      target_id: user.id,
      details: { email },
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
    });
    return { user, token, ttlSeconds: sec.sessionTtlHours * 3600 };
  }

  async logout(req: IncomingMessage): Promise<void> {
    const resolved = await this.resolveRequestUser(req);
    if (resolved) {
      await this.platform.store.revokeSession(resolved.sessionId);
    }
  }

  async requestPasswordReset(emailRaw: string, adminUserId: string | null = null): Promise<{ issued: boolean; resetToken?: string }> {
    const email = (emailRaw || "").trim().toLowerCase();
    const user = await this.platform.store.getUserByEmail(email);
    if (!user) return { issued: false };
    const token = generateOpaqueToken(24);
    await this.platform.store.createPasswordReset(
      user.id,
      hashToken(token),
      new Date(Date.now() + 2 * 3600_000).toISOString(),
      adminUserId,
    );
    await this.email.sendEmail({
      recipientUserId: user.id,
      recipientEmail: email,
      subject: "SPACIX password reset",
      body: `Use this reset token within 2 hours to reset your SPACIX password: ${token}`,
      templateKey: "password_reset",
      sentByAdminId: adminUserId,
    });
    return { issued: true, ...(adminUserId ? { resetToken: token } : {}) };
  }

  async resetPassword(token: string, newPassword: string): Promise<UserRecord> {
    const sec = await this.getSecurityConfig();
    this.validatePasswordPolicy(newPassword, sec.requireStrongPasswords);
    const updated = await this.platform.store.consumePasswordReset(hashToken(token), hashPassword(newPassword));
    if (!updated) throw new AuthError("Invalid or expired password reset token.", 400);
    return updated;
  }

  async verifyEmail(token: string): Promise<UserRecord> {
    const updated = await this.platform.store.consumeEmailVerification(hashToken(token));
    if (!updated) throw new AuthError("Invalid or expired verification token.", 400);
    return updated;
  }
}
