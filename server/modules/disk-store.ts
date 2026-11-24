// Persistent local disk implementation of PlatformStore used only when MySQL is not configured.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_PERMISSIONS,
  DEFAULT_SYSTEM_SETTINGS,
  defaultFlags,
  defaultPlans,
  defaultProviders,
  defaultRoles,
} from "./defaults.ts";
import type {
  AnnouncementRecord,
  AuditLogRecord,
  CreditTransactionRecord,
  EmailLogRecord,
  FeatureFlagRecord,
  GenerationRecord,
  LoginHistoryRecord,
  NotificationRecord,
  NotificationTemplateRecord,
  PaymentRecord,
  PermissionRecord,
  ProjectRecord,
  ProviderConfigRecord,
  ProviderCredentialRecord,
  ProviderLogRecord,
  ProviderModelRecord,
  RoleRecord,
  SessionRecord,
  StudioAppConfigRecord,
  SubscriptionPlanRecord,
  SystemSettingRecord,
  TokenRecord,
  UserRecord,
  UserStatus,
  UserSubscriptionRecord,
} from "./platform-types.ts";
import type { PlatformStore } from "./store-interface.ts";

type WalletState = { balance: number; lifetime_granted: number; lifetime_spent: number };

type DiskData = {
  roles: RoleRecord[];
  users: UserRecord[];
  sessions: SessionRecord[];
  loginHistory: LoginHistoryRecord[];
  emailVerifications: TokenRecord[];
  passwordResets: TokenRecord[];
  providers: ProviderConfigRecord[];
  providerCredentials: ProviderCredentialRecord[];
  providerLogs: ProviderLogRecord[];
  models: ProviderModelRecord[];
  studioApps: StudioAppConfigRecord[];
  featureFlags: FeatureFlagRecord[];
  projects: ProjectRecord[];
  generations: GenerationRecord[];
  wallets: Record<string, WalletState>;
  creditTransactions: CreditTransactionRecord[];
  plans: SubscriptionPlanRecord[];
  subscriptions: UserSubscriptionRecord[];
  payments: PaymentRecord[];
  notifications: NotificationRecord[];
  notificationTemplates: NotificationTemplateRecord[];
  announcements: AnnouncementRecord[];
  emailLogs: EmailLogRecord[];
  settings: SystemSettingRecord[];
  auditLogs: AuditLogRecord[];
};

const nowIso = () => new Date().toISOString();

function emptyDiskData(): DiskData {
  const ts = nowIso();
  return {
    roles: defaultRoles(),
    users: [],
    sessions: [],
    loginHistory: [],
    emailVerifications: [],
    passwordResets: [],
    providers: defaultProviders(),
    providerCredentials: [],
    providerLogs: [],
    models: [],
    studioApps: [],
    featureFlags: defaultFlags(),
    projects: [],
    generations: [],
    wallets: {},
    creditTransactions: [],
    plans: defaultPlans(),
    subscriptions: [],
    payments: [],
    notifications: [],
    notificationTemplates: [],
    announcements: [],
    emailLogs: [],
    settings: Object.entries(DEFAULT_SYSTEM_SETTINGS).map(([k, v]) => ({
      setting_key: k,
      setting_value: v.value,
      is_public: v.is_public,
      updated_by: null,
      updated_at: ts,
    })),
    auditLogs: [],
  };
}

export class DiskPlatformStore implements PlatformStore {
  readonly engine = "local-fallback" as const;
  private readonly file: string;
  private data: DiskData = emptyDiskData();

  constructor(filePath: string) {
    this.file = filePath;
  }

  async init(): Promise<void> {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<DiskData>;
        const base = emptyDiskData();
        this.data = { ...base, ...parsed };
        this.mergeDefaults();
      } catch {
        this.data = emptyDiskData();
        this.save();
      }
    } else {
      this.save();
    }
  }

  private mergeDefaults(): void {
    let dirty = false;
    const roleIds = new Set(this.data.roles.map((r) => r.id));
    for (const r of defaultRoles()) {
      if (!roleIds.has(r.id)) { this.data.roles.push(r); dirty = true; }
    }
    const flagKeys = new Set(this.data.featureFlags.map((f) => f.flag_key));
    for (const f of defaultFlags()) {
      if (!flagKeys.has(f.flag_key)) { this.data.featureFlags.push(f); dirty = true; }
    }
    const planIds = new Set(this.data.plans.map((p) => p.id));
    for (const p of defaultPlans()) {
      if (!planIds.has(p.id)) { this.data.plans.push(p); dirty = true; }
    }
    const provIds = new Set(this.data.providers.map((p) => p.id));
    for (const p of defaultProviders()) {
      if (!provIds.has(p.id)) { this.data.providers.push(p); dirty = true; }
    }
    const settingKeys = new Set(this.data.settings.map((s) => s.setting_key));
    const ts = nowIso();
    for (const [k, v] of Object.entries(DEFAULT_SYSTEM_SETTINGS)) {
      if (!settingKeys.has(k)) {
        this.data.settings.push({ setting_key: k, setting_value: v.value, is_public: v.is_public, updated_by: null, updated_at: ts });
        dirty = true;
      }
    }
    if (dirty) this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    renameSync(tmp, this.file);
  }

  private hydrateUser(u: UserRecord): UserRecord {
    const roleMap = new Map(this.data.roles.map((r) => [r.id, r]));
    const perms = new Set<string>();
    let adminRole = false;
    for (const rid of u.roles) {
      const r = roleMap.get(rid);
      if (!r) continue;
      if (r.is_admin_role) adminRole = true;
      for (const p of r.permissions) perms.add(p);
    }
    const wallet = this.data.wallets[u.id] ?? { balance: 0, lifetime_granted: 0, lifetime_spent: 0 };
    const sub = this.data.subscriptions.find((s) => s.user_id === u.id && (s.status === "active" || s.status === "trialing"));
    return {
      ...u,
      is_admin: u.is_admin || adminRole,
      permissions: [...perms],
      credit_balance: wallet.balance,
      subscription_plan_id: sub?.plan_id ?? null,
    };
  }

  // Roles & Permissions
  async listPermissions(): Promise<PermissionRecord[]> {
    return [...DEFAULT_PERMISSIONS];
  }

  async listRoles(): Promise<RoleRecord[]> {
    return [...this.data.roles];
  }

  async getRole(id: string): Promise<RoleRecord | null> {
    return this.data.roles.find((r) => r.id === id) ?? null;
  }

  async upsertRole(role: Omit<RoleRecord, "created_at" | "updated_at">): Promise<RoleRecord> {
    const ts = nowIso();
    const idx = this.data.roles.findIndex((r) => r.id === role.id);
    const next: RoleRecord = {
      ...role,
      created_at: idx >= 0 ? this.data.roles[idx].created_at : ts,
      updated_at: ts,
    };
    if (idx >= 0) this.data.roles[idx] = next;
    else this.data.roles.push(next);
    this.save();
    return next;
  }

  async deleteRole(id: string): Promise<boolean> {
    const target = this.data.roles.find((r) => r.id === id);
    if (!target || target.is_system) return false;
    this.data.roles = this.data.roles.filter((r) => r.id !== id);
    for (const u of this.data.users) {
      u.roles = u.roles.filter((rid) => rid !== id);
    }
    this.save();
    return true;
  }

  // Users
  async countUsers(): Promise<number> {
    return this.data.users.filter((u) => Boolean(u.email)).length;
  }

  async countAdmins(): Promise<number> {
    return this.data.users.filter((u) => this.hydrateUser(u).is_admin).length;
  }

  async listUsers(filter: {
    search?: string;
    role?: string;
    status?: UserStatus;
    isAdmin?: boolean;
    limit?: number;
    offset?: number;
    sort?: string;
  } = {}): Promise<{ users: UserRecord[]; total: number }> {
    let list = this.data.users.map((u) => this.hydrateUser(u));
    if (filter.search) {
      const q = filter.search.trim().toLowerCase();
      list = list.filter((u) =>
        `${u.id} ${u.email ?? ""} ${u.display_name} ${u.roles.join(" ")}`.toLowerCase().includes(q));
    }
    if (filter.role) list = list.filter((u) => u.roles.includes(filter.role!));
    if (filter.status) list = list.filter((u) => u.status === filter.status);
    if (filter.isAdmin !== undefined) list = list.filter((u) => u.is_admin === filter.isAdmin);

    const sort = filter.sort || "created_desc";
    list.sort((a, b) => {
      if (sort === "credits_desc") return b.credit_balance - a.credit_balance;
      if (sort === "name_asc") return a.display_name.localeCompare(b.display_name);
      if (sort === "created_asc") return a.created_at.localeCompare(b.created_at);
      return b.created_at.localeCompare(a.created_at);
    });
    const total = list.length;
    const offset = Math.max(0, filter.offset ?? 0);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
    return { users: list.slice(offset, offset + limit), total };
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const u = this.data.users.find((x) => x.id === id);
    return u ? this.hydrateUser(u) : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const clean = email.trim().toLowerCase();
    const u = this.data.users.find((x) => (x.email ?? "").toLowerCase() === clean);
    return u ? this.hydrateUser(u) : null;
  }

  async ensureVisitorUser(visitorKey?: string): Promise<UserRecord> {
    const key = visitorKey || "local-owner";
    const found = this.data.users.find((u) => u.visitor_key === key);
    if (found) return this.hydrateUser(found);
    const id = visitorKey ? `usr_${visitorKey.slice(0, 24)}` : "usr_local_owner";
    const ts = nowIso();
    const user: UserRecord = {
      id,
      visitor_key: key,
      email: null,
      password_hash: null,
      display_name: visitorKey ? "Studio Guest" : "Studio Owner",
      status: "active",
      email_verified: false,
      email_verified_at: null,
      is_admin: false,
      account_restrictions: null,
      roles: ["user"],
      permissions: [],
      profile: { avatar_url: null, company: null, bio: null, locale: "en", timezone: "UTC" },
      credit_balance: 0,
      subscription_plan_id: null,
      last_login_at: null,
      last_active_at: ts,
      created_at: ts,
      updated_at: ts,
    };
    this.data.users.push(user);
    this.data.wallets[id] = { balance: 0, lifetime_granted: 0, lifetime_spent: 0 };
    this.data.projects.push({ id: `prj_${id}`, user_id: id, name: "Default Project", description: "Primary studio project", created_at: ts, updated_at: ts });
    this.save();
    return this.hydrateUser(user);
  }

  async createUser(input: {
    id?: string;
    email: string;
    passwordHash: string;
    displayName: string;
    isAdmin?: boolean;
    emailVerified?: boolean;
    roles?: string[];
    initialCredits?: number;
    planId?: string | null;
  }): Promise<UserRecord> {
    const email = input.email.trim().toLowerCase();
    if (this.data.users.some((u) => (u.email ?? "").toLowerCase() === email)) {
      throw new Error("An account with this email already exists.");
    }
    const ts = nowIso();
    const id = input.id || `usr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const roles = input.roles?.length ? input.roles : [input.isAdmin ? "admin" : "user"];
    const credits = Math.max(0, Math.trunc(input.initialCredits ?? 0));
    const user: UserRecord = {
      id,
      visitor_key: null,
      email,
      password_hash: input.passwordHash,
      display_name: input.displayName.trim() || email.split("@")[0],
      status: "active",
      email_verified: Boolean(input.emailVerified),
      email_verified_at: input.emailVerified ? ts : null,
      is_admin: Boolean(input.isAdmin),
      account_restrictions: null,
      roles,
      permissions: [],
      profile: { avatar_url: null, company: null, bio: null, locale: "en", timezone: "UTC" },
      credit_balance: credits,
      subscription_plan_id: input.planId ?? null,
      last_login_at: null,
      last_active_at: ts,
      created_at: ts,
      updated_at: ts,
    };
    this.data.users.push(user);
    this.data.wallets[id] = { balance: credits, lifetime_granted: credits, lifetime_spent: 0 };
    if (credits > 0) {
      this.data.creditTransactions.unshift({
        id: `ctx_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        user_id: id,
        generation_id: null,
        admin_user_id: null,
        tx_type: "grant",
        delta: credits,
        balance_after: credits,
        reason: "Initial account credits",
        reference_id: `init_${id}`,
        created_at: ts,
      });
    }
    this.data.projects.push({ id: `prj_${id}`, user_id: id, name: "Default Project", description: "Primary studio project", created_at: ts, updated_at: ts });
    if (input.planId) {
      await this.assignSubscription({ userId: id, planId: input.planId, status: "active" });
    }
    this.save();
    return this.hydrateUser(user);
  }

  async updateUser(id: string, patch: {
    displayName?: string;
    email?: string;
    passwordHash?: string;
    status?: UserStatus;
    emailVerified?: boolean;
    isAdmin?: boolean;
    accountRestrictions?: Record<string, unknown> | null;
    roles?: string[];
    profile?: Partial<UserRecord["profile"]>;
    lastLoginAt?: string;
    lastActiveAt?: string;
  }): Promise<UserRecord | null> {
    const idx = this.data.users.findIndex((u) => u.id === id);
    if (idx < 0) return null;
    const cur = this.data.users[idx];
    const ts = nowIso();
    if (patch.email !== undefined) {
      const nextEmail = patch.email.trim().toLowerCase();
      if (this.data.users.some((u) => u.id !== id && (u.email ?? "").toLowerCase() === nextEmail)) {
        throw new Error("Another account already uses this email.");
      }
      cur.email = nextEmail;
    }
    if (patch.displayName !== undefined) cur.display_name = patch.displayName.trim();
    if (patch.passwordHash !== undefined) cur.password_hash = patch.passwordHash;
    if (patch.status !== undefined) cur.status = patch.status;
    if (patch.emailVerified !== undefined) {
      cur.email_verified = patch.emailVerified;
      cur.email_verified_at = patch.emailVerified ? (cur.email_verified_at || ts) : null;
    }
    if (patch.isAdmin !== undefined) cur.is_admin = patch.isAdmin;
    if (patch.accountRestrictions !== undefined) cur.account_restrictions = patch.accountRestrictions;
    if (patch.roles !== undefined) cur.roles = [...new Set(patch.roles)];
    if (patch.profile) cur.profile = { ...cur.profile, ...patch.profile };
    if (patch.lastLoginAt !== undefined) cur.last_login_at = patch.lastLoginAt;
    if (patch.lastActiveAt !== undefined) cur.last_active_at = patch.lastActiveAt;
    cur.updated_at = ts;
    this.save();
    return this.hydrateUser(cur);
  }

  async deleteUser(id: string): Promise<boolean> {
    const before = this.data.users.length;
    this.data.users = this.data.users.filter((u) => u.id !== id);
    if (this.data.users.length === before) return false;
    this.data.sessions = this.data.sessions.filter((s) => s.user_id !== id);
    delete this.data.wallets[id];
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.user_id !== id);
    this.data.projects = this.data.projects.filter((p) => p.user_id !== id);
    this.save();
    return true;
  }

  // Sessions & Auth
  async createSession(input: {
    userId: string;
    tokenHash: string;
    isAdmin: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
    expiresAt: string;
  }): Promise<SessionRecord> {
    const ts = nowIso();
    const s: SessionRecord = {
      id: `ses_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      user_id: input.userId,
      token_hash: input.tokenHash,
      is_admin: input.isAdmin,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
      expires_at: input.expiresAt,
      revoked_at: null,
      last_seen_at: ts,
      created_at: ts,
    };
    this.data.sessions.unshift(s);
    this.save();
    return s;
  }

  async getSessionByTokenHash(tokenHash: string): Promise<{ session: SessionRecord; user: UserRecord } | null> {
    const s = this.data.sessions.find((x) => x.token_hash === tokenHash && !x.revoked_at);
    if (!s) return null;
    if (new Date(s.expires_at).getTime() <= Date.now()) return null;
    const user = await this.getUserById(s.user_id);
    if (!user) return null;
    return { session: s, user };
  }

  async touchSession(sessionId: string): Promise<void> {
    const s = this.data.sessions.find((x) => x.id === sessionId);
    if (s) {
      s.last_seen_at = nowIso();
      const u = this.data.users.find((x) => x.id === s.user_id);
      if (u) u.last_active_at = s.last_seen_at;
      this.save();
    }
  }

  async listSessions(filter: { userId?: string; activeOnly?: boolean; limit?: number } = {}) {
    let list = [...this.data.sessions];
    if (filter.userId) list = list.filter((s) => s.user_id === filter.userId);
    if (filter.activeOnly) {
      const now = Date.now();
      list = list.filter((s) => !s.revoked_at && new Date(s.expires_at).getTime() > now);
    }
    const usersById = new Map(this.data.users.map((u) => [u.id, u]));
    return list.slice(0, filter.limit ?? 100).map((s) => ({
      ...s,
      user_email: usersById.get(s.user_id)?.email ?? null,
      display_name: usersById.get(s.user_id)?.display_name ?? "Unknown",
    }));
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const s = this.data.sessions.find((x) => x.id === sessionId);
    if (!s || s.revoked_at) return false;
    s.revoked_at = nowIso();
    this.save();
    return true;
  }

  async revokeUserSessions(userId: string): Promise<number> {
    const ts = nowIso();
    let count = 0;
    for (const s of this.data.sessions) {
      if (s.user_id === userId && !s.revoked_at) {
        s.revoked_at = ts;
        count++;
      }
    }
    if (count) this.save();
    return count;
  }

  async recordLoginAttempt(input: {
    userId: string | null;
    email: string;
    success: boolean;
    failureReason?: string | null;
    isAdminPortal?: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    this.data.loginHistory.unshift({
      id: `lgh_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      user_id: input.userId,
      email: input.email,
      success: input.success,
      failure_reason: input.failureReason ?? null,
      is_admin_portal: Boolean(input.isAdminPortal),
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
      created_at: nowIso(),
    });
    if (this.data.loginHistory.length > 2000) this.data.loginHistory.length = 2000;
    this.save();
  }

  async listLoginHistory(filter: { userId?: string; success?: boolean; search?: string; limit?: number } = {}): Promise<LoginHistoryRecord[]> {
    let list = [...this.data.loginHistory];
    if (filter.userId) list = list.filter((x) => x.user_id === filter.userId);
    if (filter.success !== undefined) list = list.filter((x) => x.success === filter.success);
    if (filter.search) {
      const q = filter.search.toLowerCase();
      list = list.filter((x) => `${x.email} ${x.ip_address ?? ""} ${x.failure_reason ?? ""}`.toLowerCase().includes(q));
    }
    return list.slice(0, filter.limit ?? 150);
  }

  async createEmailVerification(userId: string, tokenHash: string, expiresAt: string): Promise<TokenRecord> {
    const rec: TokenRecord = {
      id: `ev_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      consumed_at: null,
      created_by_admin_id: null,
      created_at: nowIso(),
    };
    this.data.emailVerifications.unshift(rec);
    this.save();
    return rec;
  }

  async consumeEmailVerification(tokenHash: string): Promise<UserRecord | null> {
    const rec = this.data.emailVerifications.find((t) => t.token_hash === tokenHash && !t.consumed_at);
    if (!rec || new Date(rec.expires_at).getTime() <= Date.now()) return null;
    rec.consumed_at = nowIso();
    const user = await this.updateUser(rec.user_id, { emailVerified: true });
    this.save();
    return user;
  }

  async createPasswordReset(userId: string, tokenHash: string, expiresAt: string, adminUserId: string | null = null): Promise<TokenRecord> {
    const rec: TokenRecord = {
      id: `pr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      consumed_at: null,
      created_by_admin_id: adminUserId,
      created_at: nowIso(),
    };
    this.data.passwordResets.unshift(rec);
    this.save();
    return rec;
  }

  async consumePasswordReset(tokenHash: string, newPasswordHash: string): Promise<UserRecord | null> {
    const rec = this.data.passwordResets.find((t) => t.token_hash === tokenHash && !t.consumed_at);
    if (!rec || new Date(rec.expires_at).getTime() <= Date.now()) return null;
    rec.consumed_at = nowIso();
    const user = await this.updateUser(rec.user_id, { passwordHash: newPasswordHash });
    if (user) await this.revokeUserSessions(user.id);
    this.save();
    return user;
  }

  // Providers & Encrypted Credentials & Logs
  async listProviders(): Promise<ProviderConfigRecord[]> {
    return [...this.data.providers].sort((a, b) => a.priority - b.priority);
  }

  async getProvider(id: string): Promise<ProviderConfigRecord | null> {
    return this.data.providers.find((p) => p.id === id) ?? null;
  }

  async upsertProvider(input: Omit<ProviderConfigRecord, "created_at" | "updated_at" | "credential_hints">): Promise<ProviderConfigRecord> {
    const ts = nowIso();
    const idx = this.data.providers.findIndex((p) => p.id === input.id);
    const hints = idx >= 0 ? this.data.providers[idx].credential_hints : {};
    const next: ProviderConfigRecord = {
      ...input,
      credential_hints: hints,
      created_at: idx >= 0 ? this.data.providers[idx].created_at : ts,
      updated_at: ts,
    };
    if (idx >= 0) this.data.providers[idx] = next;
    else this.data.providers.push(next);
    this.save();
    return next;
  }

  async updateProviderHealth(id: string, status: string, lastError: string | null): Promise<void> {
    const p = this.data.providers.find((x) => x.id === id);
    if (!p) return;
    p.health_status = status;
    p.last_error = lastError;
    p.last_tested_at = nowIso();
    p.updated_at = p.last_tested_at;
    this.save();
  }

  async deleteProvider(id: string): Promise<boolean> {
    const before = this.data.providers.length;
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    this.data.providerCredentials = this.data.providerCredentials.filter((c) => c.provider_id !== id);
    if (this.data.providers.length === before) return false;
    this.save();
    return true;
  }

  async setProviderCredential(providerId: string, key: string, encryptedValue: string, keyHint: string, updatedBy: string | null): Promise<void> {
    const ts = nowIso();
    const idx = this.data.providerCredentials.findIndex((c) => c.provider_id === providerId && c.credential_key === key);
    const rec: ProviderCredentialRecord = {
      id: idx >= 0 ? this.data.providerCredentials[idx].id : `pcred_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      provider_id: providerId,
      credential_key: key,
      encrypted_value: encryptedValue,
      key_hint: keyHint,
      updated_by: updatedBy,
      created_at: idx >= 0 ? this.data.providerCredentials[idx].created_at : ts,
      updated_at: ts,
    };
    if (idx >= 0) this.data.providerCredentials[idx] = rec;
    else this.data.providerCredentials.push(rec);
    const p = this.data.providers.find((x) => x.id === providerId);
    if (p) {
      p.credential_hints = { ...p.credential_hints, [key]: keyHint };
      p.updated_at = ts;
    }
    this.save();
  }

  async getProviderCredentials(providerId: string): Promise<ProviderCredentialRecord[]> {
    return this.data.providerCredentials.filter((c) => c.provider_id === providerId);
  }

  async appendProviderLog(log: Omit<ProviderLogRecord, "id" | "created_at">): Promise<void> {
    this.data.providerLogs.unshift({
      ...log,
      id: `plog_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      created_at: nowIso(),
    });
    if (this.data.providerLogs.length > 500) this.data.providerLogs.length = 500;
    this.save();
  }

  async listProviderLogs(providerId?: string, limit = 100): Promise<ProviderLogRecord[]> {
    let list = [...this.data.providerLogs];
    if (providerId) list = list.filter((l) => l.provider_id === providerId);
    return list.slice(0, limit);
  }

  // Models
  async listModels(filter: { providerId?: string; category?: string; enabledOnly?: boolean } = {}): Promise<ProviderModelRecord[]> {
    let list = [...this.data.models];
    if (filter.providerId) list = list.filter((m) => m.provider_id === filter.providerId);
    if (filter.category) list = list.filter((m) => m.category === filter.category);
    if (filter.enabledOnly) list = list.filter((m) => m.enabled);
    return list;
  }

  async getModel(id: string): Promise<ProviderModelRecord | null> {
    return this.data.models.find((m) => m.id === id) ?? null;
  }

  async upsertModel(model: Omit<ProviderModelRecord, "created_at" | "updated_at">): Promise<ProviderModelRecord> {
    const ts = nowIso();
    const idx = this.data.models.findIndex((m) => m.id === model.id);
    const next: ProviderModelRecord = {
      ...model,
      created_at: idx >= 0 ? this.data.models[idx].created_at : ts,
      updated_at: ts,
    };
    if (idx >= 0) this.data.models[idx] = next;
    else this.data.models.push(next);
    this.save();
    return next;
  }

  async deleteModel(id: string): Promise<boolean> {
    const before = this.data.models.length;
    this.data.models = this.data.models.filter((m) => m.id !== id);
    if (this.data.models.length === before) return false;
    this.save();
    return true;
  }

  // Studio Apps & Flags
  async listStudioApps(): Promise<StudioAppConfigRecord[]> {
    return [...this.data.studioApps];
  }

  async getStudioApp(id: string): Promise<StudioAppConfigRecord | null> {
    return this.data.studioApps.find((a) => a.id === id) ?? null;
  }

  async upsertStudioApp(cfg: StudioAppConfigRecord): Promise<StudioAppConfigRecord> {
    const ts = nowIso();
    const idx = this.data.studioApps.findIndex((a) => a.id === cfg.id);
    const next = { ...cfg, updated_at: ts };
    if (idx >= 0) this.data.studioApps[idx] = next;
    else this.data.studioApps.push(next);
    this.save();
    return next;
  }

  async setStudioSectionEnabled(section: "image" | "video" | "audio" | "utility", enabled: boolean, updatedBy: string | null): Promise<void> {
    const ts = nowIso();
    for (const app of this.data.studioApps) {
      if (app.section === section) {
        app.studio_enabled = enabled;
        app.updated_by = updatedBy;
        app.updated_at = ts;
      }
    }
    this.save();
  }

  async listFeatureFlags(): Promise<FeatureFlagRecord[]> {
    return [...this.data.featureFlags];
  }

  async upsertFeatureFlag(flag: Omit<FeatureFlagRecord, "updated_at">): Promise<FeatureFlagRecord> {
    const next: FeatureFlagRecord = { ...flag, updated_at: nowIso() };
    const idx = this.data.featureFlags.findIndex((f) => f.flag_key === flag.flag_key);
    if (idx >= 0) this.data.featureFlags[idx] = next;
    else this.data.featureFlags.push(next);
    this.save();
    return next;
  }

  // Projects & Generations
  async listProjects(userId: string): Promise<ProjectRecord[]> {
    return this.data.projects.filter((p) => p.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async createProject(userId: string, name: string, description = ""): Promise<ProjectRecord> {
    const ts = nowIso();
    const rec: ProjectRecord = {
      id: `prj_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      user_id: userId,
      name: name.trim().slice(0, 120),
      description: description.trim().slice(0, 500),
      created_at: ts,
      updated_at: ts,
    };
    this.data.projects.unshift(rec);
    this.save();
    return rec;
  }

  async syncGeneration(gen: GenerationRecord): Promise<void> {
    const idx = this.data.generations.findIndex((g) => g.id === gen.id);
    if (idx >= 0) {
      const existing = this.data.generations[idx];
      this.data.generations[idx] = {
        ...existing,
        ...gen,
        moderation_status: existing.moderation_status ?? gen.moderation_status ?? "clean",
        moderation_note: existing.moderation_note ?? gen.moderation_note ?? null,
      };
    } else {
      this.data.generations.unshift(gen);
    }
    this.save();
  }

  async listGenerations(filter: {
    userId?: string;
    appId?: string;
    providerId?: string;
    mediaType?: string;
    status?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ generations: GenerationRecord[]; total: number }> {
    let list = [...this.data.generations];
    if (filter.userId) list = list.filter((g) => g.user_id === filter.userId);
    if (filter.appId) list = list.filter((g) => g.app_id === filter.appId);
    if (filter.providerId) list = list.filter((g) => g.provider_id === filter.providerId);
    if (filter.mediaType) list = list.filter((g) => g.media_type === filter.mediaType);
    if (filter.status) list = list.filter((g) => g.status === filter.status);
    if (filter.dateFrom) list = list.filter((g) => g.created_at >= filter.dateFrom!);
    if (filter.dateTo) list = list.filter((g) => g.created_at <= filter.dateTo!);
    if (filter.search) {
      const q = filter.search.toLowerCase();
      list = list.filter((g) => `${g.id} ${g.app_id} ${g.prompt ?? ""} ${g.provider_job_id ?? ""}`.toLowerCase().includes(q));
    }
    list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const total = list.length;
    const offset = Math.max(0, filter.offset ?? 0);
    const limit = Math.max(1, Math.min(300, filter.limit ?? 50));
    return { generations: list.slice(offset, offset + limit), total };
  }

  async getGeneration(id: string): Promise<GenerationRecord | null> {
    return this.data.generations.find((g) => g.id === id) ?? null;
  }

  async updateGenerationModeration(id: string, moderationStatus: "clean" | "flagged" | "removed", note: string | null = null): Promise<GenerationRecord | null> {
    const g = this.data.generations.find((x) => x.id === id);
    if (!g) return null;
    g.moderation_status = moderationStatus;
    g.moderation_note = note;
    this.save();
    return g;
  }

  async deleteGenerationRecord(id: string): Promise<boolean> {
    const before = this.data.generations.length;
    this.data.generations = this.data.generations.filter((g) => g.id !== id);
    if (this.data.generations.length === before) return false;
    this.save();
    return true;
  }

  // Credits, Subscriptions, Payments
  async getCreditSummary(userId: string) {
    const w = this.data.wallets[userId] ?? { balance: 0, lifetime_granted: 0, lifetime_spent: 0 };
    const transactions = this.data.creditTransactions
      .filter((t) => t.user_id === userId)
      .slice(0, 100);
    return { ...w, transactions };
  }

  async listAllTransactions(filter: { userId?: string; limit?: number } = {}): Promise<CreditTransactionRecord[]> {
    let list = [...this.data.creditTransactions];
    if (filter.userId) list = list.filter((t) => t.user_id === filter.userId);
    return list.slice(0, filter.limit ?? 150);
  }

  async adjustCredits(input: {
    userId: string;
    delta: number;
    txType: CreditTransactionRecord["tx_type"];
    reason: string;
    generationId?: string | null;
    adminUserId?: string | null;
    referenceId?: string | null;
  }): Promise<{ balance: number; transaction: CreditTransactionRecord }> {
    if (input.referenceId) {
      const existing = this.data.creditTransactions.find((t) => t.reference_id === input.referenceId);
      if (existing) {
        return { balance: this.data.wallets[input.userId]?.balance ?? existing.balance_after, transaction: existing };
      }
    }
    const w = this.data.wallets[input.userId] ?? { balance: 0, lifetime_granted: 0, lifetime_spent: 0 };
    const delta = Math.trunc(input.delta);
    const nextBalance = w.balance + delta;
    if (nextBalance < 0) throw new Error("Insufficient credit balance.");
    w.balance = nextBalance;
    if (delta > 0) w.lifetime_granted += delta;
    else if (delta < 0) w.lifetime_spent += Math.abs(delta);
    this.data.wallets[input.userId] = w;
    const tx: CreditTransactionRecord = {
      id: `ctx_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      user_id: input.userId,
      generation_id: input.generationId ?? null,
      admin_user_id: input.adminUserId ?? null,
      tx_type: input.txType,
      delta,
      balance_after: nextBalance,
      reason: input.reason,
      reference_id: input.referenceId ?? null,
      created_at: nowIso(),
    };
    this.data.creditTransactions.unshift(tx);
    this.save();
    return { balance: nextBalance, transaction: tx };
  }

  async listPlans(enabledOnly = false): Promise<SubscriptionPlanRecord[]> {
    return enabledOnly ? this.data.plans.filter((p) => p.enabled) : [...this.data.plans];
  }

  async upsertPlan(plan: Omit<SubscriptionPlanRecord, "created_at" | "updated_at">): Promise<SubscriptionPlanRecord> {
    const ts = nowIso();
    const idx = this.data.plans.findIndex((p) => p.id === plan.id);
    const next: SubscriptionPlanRecord = {
      ...plan,
      created_at: idx >= 0 ? this.data.plans[idx].created_at : ts,
      updated_at: ts,
    };
    if (idx >= 0) this.data.plans[idx] = next;
    else this.data.plans.push(next);
    this.save();
    return next;
  }

  async getUserSubscription(userId: string): Promise<UserSubscriptionRecord | null> {
    return this.data.subscriptions.find((s) => s.user_id === userId && (s.status === "active" || s.status === "trialing"))
      ?? this.data.subscriptions.find((s) => s.user_id === userId)
      ?? null;
  }

  async listSubscriptions() {
    const users = new Map(this.data.users.map((u) => [u.id, u]));
    const plans = new Map(this.data.plans.map((p) => [p.id, p]));
    return this.data.subscriptions.map((s) => ({
      ...s,
      user_email: users.get(s.user_id)?.email ?? null,
      plan_name: plans.get(s.plan_id)?.name ?? s.plan_id,
    }));
  }

  async assignSubscription(input: {
    userId: string;
    planId: string;
    status: UserSubscriptionRecord["status"];
    trialDays?: number;
  }): Promise<UserSubscriptionRecord> {
    const ts = nowIso();
    for (const s of this.data.subscriptions) {
      if (s.user_id === input.userId && (s.status === "active" || s.status === "trialing")) {
        s.status = "canceled";
        s.updated_at = ts;
      }
    }
    const trialEnds = input.trialDays && input.trialDays > 0
      ? new Date(Date.now() + input.trialDays * 864e5).toISOString()
      : null;
    const sub: UserSubscriptionRecord = {
      id: `sub_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      user_id: input.userId,
      plan_id: input.planId,
      status: input.status,
      trial_ends_at: trialEnds,
      current_period_start: ts,
      current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
      cancel_at_period_end: false,
      created_at: ts,
      updated_at: ts,
    };
    this.data.subscriptions.unshift(sub);
    this.save();
    return sub;
  }

  async listPayments(filter: { userId?: string; limit?: number } = {}): Promise<PaymentRecord[]> {
    let list = [...this.data.payments];
    if (filter.userId) list = list.filter((p) => p.user_id === filter.userId);
    return list.slice(0, filter.limit ?? 150);
  }

  async recordPayment(input: Omit<PaymentRecord, "id" | "created_at">): Promise<PaymentRecord> {
    const p: PaymentRecord = {
      ...input,
      id: `pay_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      created_at: nowIso(),
    };
    this.data.payments.unshift(p);
    this.save();
    return p;
  }

  // Notifications, Templates, Announcements, Email Logs
  async listUserNotifications(userId: string, limit = 50): Promise<NotificationRecord[]> {
    return this.data.notifications.filter((n) => n.user_id === userId).slice(0, limit);
  }

  async listAllNotifications(limit = 100): Promise<NotificationRecord[]> {
    return this.data.notifications.slice(0, limit);
  }

  async createNotification(input: Omit<NotificationRecord, "id" | "read_at" | "created_at">): Promise<NotificationRecord> {
    const n: NotificationRecord = {
      ...input,
      id: `ntf_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      read_at: null,
      created_at: nowIso(),
    };
    this.data.notifications.unshift(n);
    this.save();
    return n;
  }

  async markNotificationRead(userId: string, id?: string): Promise<void> {
    const ts = nowIso();
    for (const n of this.data.notifications) {
      if (n.user_id === userId && (!id || n.id === id) && !n.read_at) {
        n.read_at = ts;
      }
    }
    this.save();
  }

  async listNotificationTemplates(): Promise<NotificationTemplateRecord[]> {
    return [...this.data.notificationTemplates];
  }

  async upsertNotificationTemplate(tpl: Omit<NotificationTemplateRecord, "created_at" | "updated_at">): Promise<NotificationTemplateRecord> {
    const ts = nowIso();
    const idx = this.data.notificationTemplates.findIndex((t) => t.id === tpl.id || t.template_key === tpl.template_key);
    const next: NotificationTemplateRecord = {
      ...tpl,
      created_at: idx >= 0 ? this.data.notificationTemplates[idx].created_at : ts,
      updated_at: ts,
    };
    if (idx >= 0) this.data.notificationTemplates[idx] = next;
    else this.data.notificationTemplates.push(next);
    this.save();
    return next;
  }

  async listAnnouncements(activeOnly = false): Promise<AnnouncementRecord[]> {
    if (!activeOnly) return [...this.data.announcements];
    const now = Date.now();
    return this.data.announcements.filter((a) => {
      if (!a.active) return false;
      if (a.starts_at && new Date(a.starts_at).getTime() > now) return false;
      if (a.ends_at && new Date(a.ends_at).getTime() < now) return false;
      return true;
    });
  }

  async upsertAnnouncement(ann: Omit<AnnouncementRecord, "created_at" | "updated_at">): Promise<AnnouncementRecord> {
    const ts = nowIso();
    const idx = this.data.announcements.findIndex((a) => a.id === ann.id);
    const next: AnnouncementRecord = {
      ...ann,
      created_at: idx >= 0 ? this.data.announcements[idx].created_at : ts,
      updated_at: ts,
    };
    if (idx >= 0) this.data.announcements[idx] = next;
    else this.data.announcements.unshift(next);
    this.save();
    return next;
  }

  async deleteAnnouncement(id: string): Promise<boolean> {
    const before = this.data.announcements.length;
    this.data.announcements = this.data.announcements.filter((a) => a.id !== id);
    if (this.data.announcements.length === before) return false;
    this.save();
    return true;
  }

  async recordEmailLog(log: Omit<EmailLogRecord, "id" | "created_at">): Promise<EmailLogRecord> {
    const rec: EmailLogRecord = { ...log, id: `eml_${randomUUID().replace(/-/g, "").slice(0, 16)}`, created_at: nowIso() };
    this.data.emailLogs.unshift(rec);
    if (this.data.emailLogs.length > 500) this.data.emailLogs.length = 500;
    this.save();
    return rec;
  }

  async listEmailLogs(limit = 100): Promise<EmailLogRecord[]> {
    return this.data.emailLogs.slice(0, limit);
  }

  // Settings & Audit Logs
  async listSettings(publicOnly = false): Promise<SystemSettingRecord[]> {
    return publicOnly ? this.data.settings.filter((s) => s.is_public) : [...this.data.settings];
  }

  async setSetting(key: string, value: unknown, isPublic: boolean, updatedBy: string | null): Promise<SystemSettingRecord> {
    const ts = nowIso();
    const idx = this.data.settings.findIndex((s) => s.setting_key === key);
    const next: SystemSettingRecord = {
      setting_key: key,
      setting_value: value,
      is_public: isPublic,
      updated_by: updatedBy,
      updated_at: ts,
    };
    if (idx >= 0) this.data.settings[idx] = next;
    else this.data.settings.push(next);
    this.save();
    return next;
  }

  async recordAuditLog(entry: Omit<AuditLogRecord, "id" | "created_at">): Promise<AuditLogRecord> {
    const rec: AuditLogRecord = { ...entry, id: `aud_${randomUUID().replace(/-/g, "").slice(0, 16)}`, created_at: nowIso() };
    this.data.auditLogs.unshift(rec);
    if (this.data.auditLogs.length > 5000) this.data.auditLogs.length = 5000;
    this.save();
    return rec;
  }

  async listAuditLogs(filter: { adminUserId?: string; action?: string; limit?: number } = {}): Promise<AuditLogRecord[]> {
    let list = [...this.data.auditLogs];
    if (filter.adminUserId) list = list.filter((a) => a.admin_user_id === filter.adminUserId);
    if (filter.action) list = list.filter((a) => a.action.toLowerCase().includes(filter.action!.toLowerCase()));
    const usersById = new Map(this.data.users.map((u) => [u.id, u.email ?? u.display_name]));
    return list.slice(0, filter.limit ?? 200).map((a) => ({
      ...a,
      admin_email: a.admin_user_id ? (usersById.get(a.admin_user_id) ?? null) : null,
    }));
  }
}
