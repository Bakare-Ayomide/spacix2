// Comprehensive RBAC-protected Admin Control Centre routes (/api/admin/*).
// Every endpoint verifies admin authentication, specific granular permission(s), and records admin_audit_logs on mutation.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { History } from "../history.ts";
import type { AnalyticsService } from "../modules/analytics-service.ts";
import { AuthError, type AuthService, clientIpFromReq, hasPermission, isSuperAdmin, userAgentFromReq } from "../modules/auth-service.ts";
import type { EmailService } from "../modules/email-service.ts";
import { type PlatformService, sanitizeUserForClient } from "../modules/platform-service.ts";
import type { UserRecord, UserStatus } from "../modules/platform-types.ts";
import type { ProviderManager } from "../modules/provider-manager.ts";
import type { App } from "../registry.ts";
import { hashPassword } from "../security/crypto.ts";

export type AdminRouteDeps = {
  platform: PlatformService;
  auth: AuthService;
  providers: ProviderManager;
  email: EmailService;
  analytics: AnalyticsService;
  history: History;
  apps: readonly App[];
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  send: (res: ServerResponse, status: number, body: unknown) => void;
  retryRun: (genId: string, adminUser: UserRecord) => Promise<unknown>;
};

function requirePerm(user: UserRecord, perm: string) {
  if (!hasPermission(user, perm)) {
    throw new AuthError(`Missing required administrator permission: ${perm}`, 403);
  }
}

export async function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  adminUser: UserRecord,
  deps: AdminRouteDeps,
): Promise<boolean> {
  // parts starts with ["api", "admin", ...]
  const [, , section, id, action] = parts;
  const { platform, auth, providers, email, analytics, history, readJsonBody, send } = deps;
  const store = platform.store;
  const ip = clientIpFromReq(req);
  const ua = userAgentFromReq(req);

  const audit = (actionName: string, targetType: string, targetId: string | null, details?: Record<string, unknown>) =>
    store.recordAuditLog({
      admin_user_id: adminUser.id,
      action: actionName,
      target_type: targetType,
      target_id: targetId,
      details: details ?? null,
      ip_address: ip,
      user_agent: ua,
    });

  try {
    // ---------------------------------------------------------------- A. Overview
    if (section === "overview" && req.method === "GET") {
      requirePerm(adminUser, "overview.read");
      send(res, 200, await analytics.getOverview());
      return true;
    }

    // ---------------------------------------------------------------- B. User Management
    if (section === "users") {
      if (req.method === "GET" && !id) {
        requirePerm(adminUser, "users.read");
        const search = url.searchParams.get("search") || undefined;
        const role = url.searchParams.get("role") || undefined;
        const status = (url.searchParams.get("status") as UserStatus | null) || undefined;
        const limit = Number(url.searchParams.get("limit") || 50);
        const offset = Number(url.searchParams.get("offset") || 0);
        const sort = url.searchParams.get("sort") || undefined;
        const resData = await store.listUsers({ search, role, status, limit, offset, sort });
        send(res, 200, {
          total: resData.total,
          users: resData.users.map((u) => sanitizeUserForClient(u)),
        });
        return true;
      }

      if (req.method === "POST" && !id) {
        requirePerm(adminUser, "users.write");
        const body = await readJsonBody(req);
        const emailAddr = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        const displayName = String(body.display_name || emailAddr.split("@")[0] || "User").trim();
        const roles = Array.isArray(body.roles) ? body.roles.map(String) : ["user"];
        const initialCredits = Number(body.credits ?? 0);
        const planId = body.plan_id ? String(body.plan_id) : "plan_free";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddr)) throw new AuthError("Valid email is required.", 400);
        if (password.length < 8) throw new AuthError("Password must be at least 8 characters.", 400);
        if (await store.getUserByEmail(emailAddr)) throw new AuthError("Email already registered.", 409);

        const roleList = await store.listRoles();
        const hasAdminRole = roles.some((rid) => roleList.find((r) => r.id === rid)?.is_admin_role);
        if (hasAdminRole) requirePerm(adminUser, "admins.write");

        const created = await store.createUser({
          email: emailAddr,
          passwordHash: hashPassword(password),
          displayName,
          isAdmin: hasAdminRole,
          emailVerified: Boolean(body.email_verified),
          roles,
          initialCredits,
          planId,
        });
        await audit("user.create", "user", created.id, { email: created.email, roles });
        send(res, 201, { user: sanitizeUserForClient(created) });
        return true;
      }

      if (req.method === "POST" && id === "bulk") {
        requirePerm(adminUser, "users.suspend");
        const body = await readJsonBody(req);
        const userIds = Array.isArray(body.user_ids) ? body.user_ids.map(String) : [];
        const bulkOp = String(body.operation || "");
        let affected = 0;
        for (const uid of userIds) {
          if (uid === adminUser.id) continue;
          if (bulkOp === "suspend") { await store.updateUser(uid, { status: "suspended" }); await store.revokeUserSessions(uid); affected++; }
          else if (bulkOp === "activate") { await store.updateUser(uid, { status: "active" }); affected++; }
          else if (bulkOp === "verify") { await store.updateUser(uid, { emailVerified: true }); affected++; }
          else if (bulkOp === "delete") { await store.deleteUser(uid); affected++; }
        }
        await audit("user.bulk", "user", null, { operation: bulkOp, count: affected, user_ids: userIds });
        send(res, 200, { ok: true, affected });
        return true;
      }

      if (id && !action && req.method === "GET") {
        requirePerm(adminUser, "users.read");
        const u = await store.getUserById(id);
        if (!u) { send(res, 404, { error: "User not found" }); return true; }
        const [credits, generations, logins, sessions, sub, notifications, projects] = await Promise.all([
          store.getCreditSummary(id),
          store.listGenerations({ userId: id, limit: 50 }),
          store.listLoginHistory({ userId: id, limit: 30 }),
          store.listSessions({ userId: id, limit: 20 }),
          store.getUserSubscription(id),
          store.listUserNotifications(id, 25),
          store.listProjects(id),
        ]);
        send(res, 200, {
          user: { ...sanitizeUserForClient(u), account_restrictions: u.account_restrictions },
          credits,
          generations: generations.generations,
          logins,
          sessions,
          subscription: sub,
          notifications,
          projects,
        });
        return true;
      }

      if (id && !action && (req.method === "PATCH" || req.method === "PUT")) {
        requirePerm(adminUser, "users.write");
        const existing = await store.getUserById(id);
        if (!existing) { send(res, 404, { error: "User not found" }); return true; }
        const body = await readJsonBody(req);
        if (body.status && body.status !== existing.status) requirePerm(adminUser, "users.suspend");
        if (Array.isArray(body.roles)) {
          const allRoles = await store.listRoles();
          const touchesAdmin = body.roles.some((rid) => allRoles.find((r) => r.id === rid)?.is_admin_role) || existing.is_admin;
          if (touchesAdmin) requirePerm(adminUser, "admins.write");
        }
        const roles = Array.isArray(body.roles) ? body.roles.map(String) : undefined;
        const allRoles = await store.listRoles();
        const isAdminNext = roles
          ? roles.some((rid) => allRoles.find((r) => r.id === rid)?.is_admin_role)
          : (typeof body.is_admin === "boolean" ? body.is_admin : undefined);

        const updated = await store.updateUser(id, {
          displayName: typeof body.display_name === "string" ? body.display_name : undefined,
          email: typeof body.email === "string" ? body.email : undefined,
          status: typeof body.status === "string" ? (body.status as UserStatus) : undefined,
          emailVerified: typeof body.email_verified === "boolean" ? body.email_verified : undefined,
          isAdmin: isAdminNext,
          roles,
          accountRestrictions: body.account_restrictions !== undefined ? (body.account_restrictions as Record<string, unknown> | null) : undefined,
          profile: body.profile && typeof body.profile === "object" ? (body.profile as Partial<UserRecord["profile"]>) : undefined,
        });
        if (body.status === "suspended" || body.status === "deactivated") {
          await store.revokeUserSessions(id);
        }
        await audit("user.update", "user", id, { fields: Object.keys(body) });
        send(res, 200, { user: updated ? sanitizeUserForClient(updated) : null });
        return true;
      }

      if (id && !action && req.method === "DELETE") {
        requirePerm(adminUser, "users.suspend");
        if (id === adminUser.id) throw new AuthError("You cannot delete your own active administrator account.", 400);
        const ok = await store.deleteUser(id);
        await audit("user.delete", "user", id);
        send(res, ok ? 200 : 404, ok ? { deleted: id } : { error: "User not found" });
        return true;
      }

      if (id && action === "credits" && req.method === "POST") {
        requirePerm(adminUser, "credits.write");
        const body = await readJsonBody(req);
        const delta = Math.trunc(Number(body.delta ?? 0));
        const reason = String(body.reason || "Administrator credit adjustment").trim();
        if (!delta) throw new AuthError("Non-zero credit delta is required.", 400);
        const result = await store.adjustCredits({
          userId: id,
          delta,
          txType: delta > 0 ? "grant" : "deduct",
          reason,
          adminUserId: adminUser.id,
        });
        await audit("credits.adjust", "user", id, { delta, reason, balance_after: result.balance });
        send(res, 200, result);
        return true;
      }

      if (id && action === "reset-password" && req.method === "POST") {
        requirePerm(adminUser, "users.write");
        const target = await store.getUserById(id);
        if (!target) { send(res, 404, { error: "User not found" }); return true; }
        const body = await readJsonBody(req);
        if (typeof body.new_password === "string" && body.new_password.trim()) {
          if (body.new_password.length < 8) throw new AuthError("Password must be at least 8 characters.", 400);
          await store.updateUser(id, { passwordHash: hashPassword(body.new_password) });
          await store.revokeUserSessions(id);
          await audit("user.password_set", "user", id);
          send(res, 200, { ok: true, mode: "direct" });
          return true;
        }
        const issued = target.email ? await auth.requestPasswordReset(target.email, adminUser.id) : { issued: false };
        await audit("user.password_reset_issued", "user", id);
        send(res, 200, issued);
        return true;
      }

      if (id && action === "notify" && req.method === "POST") {
        requirePerm(adminUser, "notifications.send");
        const target = await store.getUserById(id);
        if (!target) { send(res, 404, { error: "User not found" }); return true; }
        const body = await readJsonBody(req);
        const title = String(body.title || "").trim();
        const msgBody = String(body.body || "").trim();
        if (!title || !msgBody) throw new AuthError("Title and message body are required.", 400);
        const notif = await store.createNotification({
          user_id: id,
          sender_admin_id: adminUser.id,
          title,
          body: msgBody,
          category: String(body.category || "admin"),
          delivery_status: "delivered",
        });
        if (body.send_email && target.email) {
          await email.sendEmail({
            recipientUserId: id,
            recipientEmail: target.email,
            subject: title,
            body: msgBody,
            sentByAdminId: adminUser.id,
          });
        }
        await audit("user.notify", "user", id, { title });
        send(res, 201, { notification: notif });
        return true;
      }
    }

    // ---------------------------------------------------------------- C. Admin & Role Management
    if (section === "admins" && req.method === "GET") {
      requirePerm(adminUser, "admins.read");
      const resData = await store.listUsers({ isAdmin: true, limit: 200 });
      send(res, 200, { admins: resData.users.map((u) => sanitizeUserForClient(u)) });
      return true;
    }

    if (section === "permissions" && req.method === "GET") {
      requirePerm(adminUser, "admins.read");
      send(res, 200, { permissions: await store.listPermissions() });
      return true;
    }

    if (section === "roles") {
      if (req.method === "GET" && !id) {
        requirePerm(adminUser, "admins.read");
        send(res, 200, { roles: await store.listRoles() });
        return true;
      }
      if (req.method === "POST" && !id) {
        if (!isSuperAdmin(adminUser)) throw new AuthError("Only Super Admins can create or modify roles and permissions.", 403);
        const body = await readJsonBody(req);
        const roleId = String(body.id || body.name || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
        const name = String(body.name || "").trim();
        if (!roleId || !name) throw new AuthError("Role name and identifier are required.", 400);
        const saved = await store.upsertRole({
          id: roleId,
          name,
          description: String(body.description || ""),
          is_system: false,
          is_admin_role: Boolean(body.is_admin_role ?? true),
          permissions: Array.isArray(body.permissions) ? body.permissions.map(String) : [],
        });
        await audit("role.upsert", "role", saved.id, { permissions: saved.permissions });
        send(res, 200, { role: saved });
        return true;
      }
      if ((req.method === "PATCH" || req.method === "PUT") && id) {
        if (!isSuperAdmin(adminUser)) throw new AuthError("Only Super Admins can modify role permissions.", 403);
        const existing = await store.getRole(id);
        if (!existing) { send(res, 404, { error: "Role not found" }); return true; }
        const body = await readJsonBody(req);
        const saved = await store.upsertRole({
          id,
          name: typeof body.name === "string" ? body.name.trim() : existing.name,
          description: typeof body.description === "string" ? body.description : existing.description,
          is_system: existing.is_system,
          is_admin_role: typeof body.is_admin_role === "boolean" ? body.is_admin_role : existing.is_admin_role,
          permissions: Array.isArray(body.permissions) ? body.permissions.map(String) : existing.permissions,
        });
        await audit("role.update", "role", saved.id, { permissions: saved.permissions });
        send(res, 200, { role: saved });
        return true;
      }
      if (req.method === "DELETE" && id) {
        if (!isSuperAdmin(adminUser)) throw new AuthError("Only Super Admins can delete custom roles.", 403);
        const ok = await store.deleteRole(id);
        if (!ok) throw new AuthError("System roles cannot be deleted or role not found.", 400);
        await audit("role.delete", "role", id);
        send(res, 200, { deleted: id });
        return true;
      }
    }

    // ---------------------------------------------------------------- D. AI Provider Management
    if (section === "providers") {
      if (req.method === "GET" && !id) {
        requirePerm(adminUser, "providers.read");
        send(res, 200, {
          providers: await providers.listAdminProviders(),
          logs: await store.listProviderLogs(undefined, 80),
        });
        return true;
      }
      if (req.method === "POST" && !id) {
        requirePerm(adminUser, "providers.write");
        const body = await readJsonBody(req);
        const provId = String(body.id || body.name || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        const name = String(body.name || "").trim();
        if (!provId || !name) throw new AuthError("Provider ID and display name are required.", 400);
        const saved = await store.upsertProvider({
          id: provId,
          name,
          adapter_type: String(body.adapter_type || "http"),
          enabled: body.enabled !== false,
          priority: Number(body.priority ?? 100),
          fallback_provider_id: body.fallback_provider_id ? String(body.fallback_provider_id) : null,
          base_url: String(body.base_url || "").trim(),
          supported_endpoints: Array.isArray(body.supported_endpoints) ? body.supported_endpoints.map(String) : [],
          settings: body.settings && typeof body.settings === "object" ? (body.settings as Record<string, unknown>) : {},
          health_status: "untested",
          last_tested_at: null,
          last_error: null,
        });
        if (typeof body.api_key === "string" && body.api_key.trim()) {
          await providers.setCredential(saved.id, "api_key", body.api_key.trim(), adminUser.id);
        }
        if (typeof body.webhook_secret === "string" && body.webhook_secret.trim()) {
          await providers.setCredential(saved.id, "webhook_secret", body.webhook_secret.trim(), adminUser.id);
        }
        await audit("provider.upsert", "provider", saved.id, { enabled: saved.enabled, priority: saved.priority });
        send(res, 200, { provider: await store.getProvider(saved.id) });
        return true;
      }
      if ((req.method === "PATCH" || req.method === "PUT") && id && !action) {
        requirePerm(adminUser, "providers.write");
        const existing = await store.getProvider(id);
        if (!existing) { send(res, 404, { error: "Provider not found" }); return true; }
        const body = await readJsonBody(req);
        const saved = await store.upsertProvider({
          id,
          name: typeof body.name === "string" ? body.name : existing.name,
          adapter_type: typeof body.adapter_type === "string" ? body.adapter_type : existing.adapter_type,
          enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
          priority: body.priority !== undefined ? Number(body.priority) : existing.priority,
          fallback_provider_id: body.fallback_provider_id !== undefined ? (body.fallback_provider_id ? String(body.fallback_provider_id) : null) : existing.fallback_provider_id,
          base_url: typeof body.base_url === "string" ? body.base_url.trim() : existing.base_url,
          supported_endpoints: Array.isArray(body.supported_endpoints) ? body.supported_endpoints.map(String) : existing.supported_endpoints,
          settings: body.settings && typeof body.settings === "object" ? (body.settings as Record<string, unknown>) : existing.settings,
          health_status: existing.health_status,
          last_tested_at: existing.last_tested_at,
          last_error: existing.last_error,
        });
        if (typeof body.api_key === "string" && body.api_key.trim()) {
          await providers.setCredential(id, "api_key", body.api_key.trim(), adminUser.id);
        }
        if (typeof body.webhook_secret === "string" && body.webhook_secret.trim()) {
          await providers.setCredential(id, "webhook_secret", body.webhook_secret.trim(), adminUser.id);
        }
        await audit("provider.update", "provider", id, { enabled: saved.enabled, credentials_updated: Boolean(body.api_key) });
        send(res, 200, { provider: (await providers.listAdminProviders()).find((p) => p.id === id) });
        return true;
      }
      if (req.method === "POST" && id && action === "test") {
        requirePerm(adminUser, "providers.write");
        const result = await providers.testConnection(id);
        await audit("provider.test", "provider", id, result);
        send(res, 200, result);
        return true;
      }
      if (req.method === "GET" && id && action === "logs") {
        requirePerm(adminUser, "providers.read");
        send(res, 200, { logs: await store.listProviderLogs(id, 100) });
        return true;
      }
      if (req.method === "DELETE" && id && !action) {
        requirePerm(adminUser, "providers.write");
        const ok = await store.deleteProvider(id);
        await audit("provider.delete", "provider", id);
        send(res, ok ? 200 : 404, ok ? { deleted: id } : { error: "Provider not found" });
        return true;
      }
    }

    // ---------------------------------------------------------------- E. AI Model Management
    if (section === "models") {
      if (req.method === "GET" && !id) {
        requirePerm(adminUser, "models.read");
        send(res, 200, { models: await store.listModels() });
        return true;
      }
      if (req.method === "POST" && id === "sync") {
        requirePerm(adminUser, "models.write");
        const body = await readJsonBody(req);
        const providerId = String(body.provider_id || "fal");
        const resSync = await providers.syncModelsFromProvider(providerId);
        await audit("models.sync", "provider", providerId, { fetched: resSync.fetched });
        send(res, 200, resSync);
        return true;
      }
      if (req.method === "POST" && !id) {
        requirePerm(adminUser, "models.write");
        const body = await readJsonBody(req);
        const providerId = String(body.provider_id || "fal");
        const endpoint = String(body.endpoint || "").trim();
        const displayName = String(body.display_name || endpoint).trim();
        if (!endpoint) throw new AuthError("Model endpoint is required.", 400);
        const modelId = String(body.id || `${providerId}:${endpoint}`).slice(0, 128);
        const saved = await store.upsertModel({
          id: modelId,
          provider_id: providerId,
          endpoint,
          display_name: displayName,
          description: String(body.description || ""),
          category: String(body.category || "image"),
          capability: String(body.capability || "text-to-image"),
          source: "manual",
          enabled: body.enabled !== false,
          is_default: Boolean(body.is_default),
          fallback_model_id: body.fallback_model_id ? String(body.fallback_model_id) : null,
          thumbnail_url: body.thumbnail_url ? String(body.thumbnail_url) : null,
          internal_cost_usd: body.internal_cost_usd !== undefined && body.internal_cost_usd !== null ? Number(body.internal_cost_usd) : null,
          credit_price: Number(body.credit_price ?? 1),
          allowed_roles: Array.isArray(body.allowed_roles) ? body.allowed_roles.map(String) : [],
          allowed_plans: Array.isArray(body.allowed_plans) ? body.allowed_plans.map(String) : [],
          capabilities: body.capabilities && typeof body.capabilities === "object" ? (body.capabilities as Record<string, unknown>) : {},
          parameters: Array.isArray(body.parameters) ? (body.parameters as never[]) : [],
        });
        await audit("model.create", "model", saved.id, { endpoint, credit_price: saved.credit_price });
        send(res, 201, { model: saved });
        return true;
      }
      if ((req.method === "PATCH" || req.method === "PUT") && id) {
        requirePerm(adminUser, "models.write");
        const existing = await store.getModel(id);
        if (!existing) { send(res, 404, { error: "Model not found" }); return true; }
        const body = await readJsonBody(req);
        const saved = await store.upsertModel({
          ...existing,
          display_name: typeof body.display_name === "string" ? body.display_name : existing.display_name,
          description: typeof body.description === "string" ? body.description : existing.description,
          category: typeof body.category === "string" ? body.category : existing.category,
          capability: typeof body.capability === "string" ? body.capability : existing.capability,
          enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
          is_default: typeof body.is_default === "boolean" ? body.is_default : existing.is_default,
          fallback_model_id: body.fallback_model_id !== undefined ? (body.fallback_model_id ? String(body.fallback_model_id) : null) : existing.fallback_model_id,
          thumbnail_url: body.thumbnail_url !== undefined ? (body.thumbnail_url ? String(body.thumbnail_url) : null) : existing.thumbnail_url,
          internal_cost_usd: body.internal_cost_usd !== undefined ? (body.internal_cost_usd === null ? null : Number(body.internal_cost_usd)) : existing.internal_cost_usd,
          credit_price: body.credit_price !== undefined ? Number(body.credit_price) : existing.credit_price,
          allowed_roles: Array.isArray(body.allowed_roles) ? body.allowed_roles.map(String) : existing.allowed_roles,
          allowed_plans: Array.isArray(body.allowed_plans) ? body.allowed_plans.map(String) : existing.allowed_plans,
          capabilities: body.capabilities && typeof body.capabilities === "object" ? (body.capabilities as Record<string, unknown>) : existing.capabilities,
          parameters: Array.isArray(body.parameters) ? (body.parameters as never[]) : existing.parameters,
        });
        await audit("model.update", "model", saved.id, { enabled: saved.enabled, credit_price: saved.credit_price });
        send(res, 200, { model: saved });
        return true;
      }
      if (req.method === "DELETE" && id) {
        requirePerm(adminUser, "models.write");
        const ok = await store.deleteModel(id);
        await audit("model.delete", "model", id);
        send(res, ok ? 200 : 404, ok ? { deleted: id } : { error: "Model not found" });
        return true;
      }
    }

    // ---------------------------------------------------------------- F. Studio & Feature Management
    if (section === "studios") {
      if (req.method === "GET" && !id) {
        requirePerm(adminUser, "studios.read");
        send(res, 200, {
          studios: await store.listStudioApps(),
          flags: await store.listFeatureFlags(),
          models: await store.listModels(),
        });
        return true;
      }
      if (req.method === "POST" && id === "section") {
        requirePerm(adminUser, "studios.write");
        const body = await readJsonBody(req);
        const sec = String(body.section || "") as "image" | "video" | "audio" | "utility";
        if (!["image", "video", "audio", "utility"].includes(sec)) throw new AuthError("Invalid studio section.", 400);
        const enabled = Boolean(body.enabled);
        await store.setStudioSectionEnabled(sec, enabled, adminUser.id);
        await audit("studio.section_toggle", "studio_section", sec, { enabled });
        send(res, 200, { section: sec, enabled });
        return true;
      }
      if ((req.method === "PATCH" || req.method === "PUT") && id) {
        requirePerm(adminUser, "studios.write");
        const existing = await store.getStudioApp(id);
        if (!existing) { send(res, 404, { error: "Studio application not found" }); return true; }
        const body = await readJsonBody(req);
        const saved = await store.upsertStudioApp({
          ...existing,
          name: typeof body.name === "string" ? body.name : existing.name,
          summary: typeof body.summary === "string" ? body.summary : existing.summary,
          thumbnail_url: body.thumbnail_url !== undefined ? (body.thumbnail_url ? String(body.thumbnail_url) : null) : existing.thumbnail_url,
          enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
          studio_enabled: typeof body.studio_enabled === "boolean" ? body.studio_enabled : existing.studio_enabled,
          maintenance_mode: typeof body.maintenance_mode === "boolean" ? body.maintenance_mode : existing.maintenance_mode,
          credit_cost: body.credit_cost !== undefined ? Math.max(0, Math.trunc(Number(body.credit_cost))) : existing.credit_cost,
          allowed_roles: Array.isArray(body.allowed_roles) ? body.allowed_roles.map(String) : existing.allowed_roles,
          allowed_plans: Array.isArray(body.allowed_plans) ? body.allowed_plans.map(String) : existing.allowed_plans,
          presets_override: body.presets_override !== undefined ? (body.presets_override as Record<string, unknown>[] | null) : existing.presets_override,
          settings_override: body.settings_override !== undefined ? (body.settings_override as Record<string, unknown> | null) : existing.settings_override,
          published: typeof body.published === "boolean" ? body.published : existing.published,
          model_ids: Array.isArray(body.model_ids) ? body.model_ids.map(String) : existing.model_ids,
          primary_model_id: body.primary_model_id !== undefined ? (body.primary_model_id ? String(body.primary_model_id) : null) : existing.primary_model_id,
          updated_by: adminUser.id,
          updated_at: new Date().toISOString(),
        });
        await audit("studio.app_update", "studio_application", id, { enabled: saved.enabled, credit_cost: saved.credit_cost, published: saved.published });
        send(res, 200, { studio: saved });
        return true;
      }
    }

    // ---------------------------------------------------------------- G. Generation & Content Management
    if (section === "generations") {
      if (req.method === "GET" && !id) {
        requirePerm(adminUser, "generations.read");
        const resData = await store.listGenerations({
          userId: url.searchParams.get("user_id") || undefined,
          appId: url.searchParams.get("app_id") || undefined,
          providerId: url.searchParams.get("provider_id") || undefined,
          mediaType: url.searchParams.get("media_type") || undefined,
          status: url.searchParams.get("status") || undefined,
          search: url.searchParams.get("search") || undefined,
          limit: Number(url.searchParams.get("limit") || 60),
          offset: Number(url.searchParams.get("offset") || 0),
        });
        // Merge any disk history entries not yet synced
        const map = new Map(resData.generations.map((g) => [g.id, g]));
        if (!url.searchParams.get("offset")) {
          for (const h of history.list(url.searchParams.get("app_id") || undefined, 100)) {
            if (!map.has(h.id)) {
              map.set(h.id, {
                id: h.id,
                user_id: "usr_local_owner",
                project_id: h.project_id ?? null,
                app_id: h.app,
                provider_id: h.provider ?? null,
                provider_endpoint: h.provider_endpoint ?? null,
                provider_job_id: h.job ?? null,
                model_id: null,
                media_type: h.outputs?.[0]?.type === "video" ? "video" : h.outputs?.[0]?.type === "audio" ? "audio" : "image",
                status: h.status,
                prompt: typeof h.values?.prompt === "string" ? h.values.prompt : null,
                preset_id: h.preset,
                settings: h.values ?? {},
                inputs: h.inputs ?? [],
                outputs: h.outputs ?? [],
                error: h.error ?? null,
                credits_charged: 0,
                moderation_status: "clean",
                moderation_note: null,
                seconds: h.seconds,
                total_seconds: h.total,
                created_at: h.created,
                started_at: h.started,
                finished_at: h.finished,
              });
            }
          }
        }
        const merged = [...map.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        send(res, 200, { total: Math.max(resData.total, merged.length), generations: merged });
        return true;
      }

      if (req.method === "POST" && id && action === "retry") {
        requirePerm(adminUser, "generations.manage");
        const retried = await deps.retryRun(id, adminUser);
        await audit("generation.retry", "generation", id);
        send(res, 202, { entry: retried });
        return true;
      }

      if (req.method === "POST" && id && action === "cancel") {
        requirePerm(adminUser, "generations.manage");
        const canceled = await history.cancel(id);
        await audit("generation.cancel", "generation", id, { canceled });
        send(res, 200, { canceled });
        return true;
      }

      if (req.method === "POST" && id && action === "moderate") {
        requirePerm(adminUser, "generations.manage");
        const body = await readJsonBody(req);
        const mod = String(body.moderation_status || "flagged") as "clean" | "flagged" | "removed";
        const updated = await store.updateGenerationModeration(id, mod, typeof body.note === "string" ? body.note : null);
        await audit("generation.moderate", "generation", id, { moderation_status: mod });
        send(res, 200, { generation: updated });
        return true;
      }

      if (req.method === "DELETE" && id && !action) {
        requirePerm(adminUser, "generations.manage");
        const removedDisk = history.remove(id);
        const removedDb = await store.deleteGenerationRecord(id);
        await audit("generation.delete", "generation", id, { removedDisk, removedDb });
        send(res, 200, { deleted: id, removedDisk, removedDb });
        return true;
      }
    }

    // ---------------------------------------------------------------- H. Credits, Pricing & Subscriptions
    if (section === "credits" && id === "transactions" && req.method === "GET") {
      requirePerm(adminUser, "credits.read");
      send(res, 200, { transactions: await store.listAllTransactions({ userId: url.searchParams.get("user_id") || undefined, limit: 200 }) });
      return true;
    }

    if (section === "plans") {
      if (req.method === "GET" && !id) {
        requirePerm(adminUser, "credits.read");
        send(res, 200, { plans: await store.listPlans(false) });
        return true;
      }
      if ((req.method === "POST" || req.method === "PUT" || req.method === "PATCH") && (!id || id)) {
        requirePerm(adminUser, "subscriptions.manage");
        const body = await readJsonBody(req);
        const planId = id || String(body.id || `plan_${String(body.code || randomUUID().slice(0, 8)).toLowerCase()}`);
        const saved = await store.upsertPlan({
          id: planId,
          code: String(body.code || planId.replace(/^plan_/, "")).toLowerCase(),
          name: String(body.name || "Custom Plan"),
          description: String(body.description || ""),
          price_cents: Math.max(0, Math.trunc(Number(body.price_cents ?? 0))),
          billing_interval: (String(body.billing_interval || "month") as "month" | "year" | "one_time"),
          monthly_credits: Math.max(0, Math.trunc(Number(body.monthly_credits ?? 0))),
          trial_days: Math.max(0, Math.trunc(Number(body.trial_days ?? 0))),
          max_active_jobs: Math.max(1, Math.trunc(Number(body.max_active_jobs ?? 2))),
          max_daily_runs: body.max_daily_runs !== null && body.max_daily_runs !== undefined ? Number(body.max_daily_runs) : null,
          features: body.features && typeof body.features === "object" ? (body.features as Record<string, unknown>) : {},
          enabled: body.enabled !== false,
        });
        await audit("plan.upsert", "subscription_plan", saved.id, { price_cents: saved.price_cents, monthly_credits: saved.monthly_credits });
        send(res, 200, { plan: saved });
        return true;
      }
    }

    if (section === "subscriptions") {
      if (req.method === "GET") {
        requirePerm(adminUser, "credits.read");
        send(res, 200, { subscriptions: await store.listSubscriptions() });
        return true;
      }
      if (req.method === "POST") {
        requirePerm(adminUser, "subscriptions.manage");
        const body = await readJsonBody(req);
        const userId = String(body.user_id || "");
        const planId = String(body.plan_id || "");
        if (!userId || !planId) throw new AuthError("user_id and plan_id are required.", 400);
        const sub = await store.assignSubscription({
          userId,
          planId,
          status: (String(body.status || "active") as "active" | "trialing" | "past_due" | "canceled" | "paused"),
          trialDays: body.trial_days ? Number(body.trial_days) : undefined,
        });
        if (body.grant_plan_credits) {
          const plans = await store.listPlans(false);
          const p = plans.find((x) => x.id === planId);
          if (p && p.monthly_credits > 0) {
            await store.adjustCredits({
              userId,
              delta: p.monthly_credits,
              txType: "subscription",
              reason: `Subscription plan credits (${p.name})`,
              adminUserId: adminUser.id,
            });
          }
        }
        await audit("subscription.assign", "user", userId, { plan_id: planId, status: sub.status });
        send(res, 200, { subscription: sub });
        return true;
      }
    }

    if (section === "payments") {
      if (req.method === "GET") {
        requirePerm(adminUser, "credits.read");
        send(res, 200, { payments: await store.listPayments({ limit: 200 }) });
        return true;
      }
      if (req.method === "POST") {
        requirePerm(adminUser, "credits.write");
        const body = await readJsonBody(req);
        const userId = String(body.user_id || "");
        const amountCents = Math.max(0, Math.trunc(Number(body.amount_cents ?? 0)));
        const creditsGranted = Math.max(0, Math.trunc(Number(body.credits_granted ?? 0)));
        const payStatus = String(body.status || "confirmed") as "pending" | "confirmed" | "failed" | "refunded";
        if (!userId) throw new AuthError("user_id is required.", 400);
        const rec = await store.recordPayment({
          user_id: userId,
          subscription_id: body.subscription_id ? String(body.subscription_id) : null,
          amount_cents: amountCents,
          currency: String(body.currency || "USD").slice(0, 3).toUpperCase(),
          status: payStatus,
          provider_name: String(body.provider_name || "manual"),
          external_payment_id: body.external_payment_id ? String(body.external_payment_id) : null,
          credits_granted: creditsGranted,
          notes: body.notes ? String(body.notes) : null,
          recorded_by_admin_id: adminUser.id,
        });
        if (payStatus === "confirmed" && creditsGranted > 0) {
          await store.adjustCredits({
            userId,
            delta: creditsGranted,
            txType: "purchase",
            reason: `Recorded payment ${rec.id}`,
            adminUserId: adminUser.id,
            referenceId: rec.id,
          });
        }
        await audit("payment.record", "payment", rec.id, { user_id: userId, amount_cents: amountCents, status: payStatus, credits_granted: creditsGranted });
        send(res, 201, { payment: rec });
        return true;
      }
    }

    // ---------------------------------------------------------------- I. Notifications, Templates, Announcements, Emails
    if (section === "notifications") {
      if (req.method === "GET") {
        requirePerm(adminUser, "notifications.send");
        send(res, 200, { notifications: await store.listAllNotifications(150) });
        return true;
      }
      if (req.method === "POST") {
        requirePerm(adminUser, "notifications.send");
        const body = await readJsonBody(req);
        const title = String(body.title || "").trim();
        const msgBody = String(body.body || "").trim();
        const audience = String(body.audience || "user");
        const sendEmailFlag = Boolean(body.send_email);
        if (!title || !msgBody) throw new AuthError("Notification title and body are required.", 400);

        let targets: UserRecord[] = [];
        if (audience === "all") {
          const all = await store.listUsers({ status: "active", limit: 1000 });
          targets = all.users.filter((u) => Boolean(u.email));
        } else if (audience === "role" && body.role_id) {
          const byRole = await store.listUsers({ role: String(body.role_id), status: "active", limit: 1000 });
          targets = byRole.users;
        } else if (body.user_id) {
          const u = await store.getUserById(String(body.user_id));
          if (u) targets = [u];
        }

        let delivered = 0;
        for (const u of targets) {
          await store.createNotification({
            user_id: u.id,
            sender_admin_id: adminUser.id,
            title,
            body: msgBody,
            category: String(body.category || "announcement"),
            delivery_status: "delivered",
          });
          delivered++;
          if (sendEmailFlag && u.email) {
            await email.sendEmail({
              recipientUserId: u.id,
              recipientEmail: u.email,
              subject: title,
              body: msgBody,
              sentByAdminId: adminUser.id,
            });
          }
        }
        await audit("notifications.send", "notification", null, { audience, delivered, send_email: sendEmailFlag });
        send(res, 201, { delivered });
        return true;
      }
    }

    if (section === "templates") {
      if (req.method === "GET") {
        requirePerm(adminUser, "notifications.send");
        send(res, 200, { templates: await store.listNotificationTemplates() });
        return true;
      }
      if (req.method === "POST") {
        requirePerm(adminUser, "notifications.send");
        const body = await readJsonBody(req);
        const tplKey = String(body.template_key || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
        if (!tplKey) throw new AuthError("template_key is required.", 400);
        const tpl = await store.upsertNotificationTemplate({
          id: String(body.id || `tpl_${tplKey}`),
          template_key: tplKey,
          title_template: String(body.title_template || ""),
          body_template: String(body.body_template || ""),
          channel: (String(body.channel || "in_app") as "in_app" | "email" | "both"),
          created_by: adminUser.id,
        });
        await audit("template.upsert", "notification_template", tpl.id);
        send(res, 200, { template: tpl });
        return true;
      }
    }

    if (section === "announcements") {
      if (req.method === "GET") {
        requirePerm(adminUser, "notifications.send");
        send(res, 200, { announcements: await store.listAnnouncements(false) });
        return true;
      }
      if (req.method === "POST" || req.method === "PATCH") {
        requirePerm(adminUser, "notifications.send");
        const body = await readJsonBody(req);
        const annId = id || String(body.id || `ann_${randomUUID().replace(/-/g, "").slice(0, 12)}`);
        const saved = await store.upsertAnnouncement({
          id: annId,
          title: String(body.title || "").trim(),
          body: String(body.body || "").trim(),
          severity: (String(body.severity || "info") as "info" | "feature" | "warning" | "maintenance"),
          active: body.active !== false,
          starts_at: body.starts_at ? String(body.starts_at) : null,
          ends_at: body.ends_at ? String(body.ends_at) : null,
          created_by: adminUser.id,
        });
        await audit("announcement.upsert", "announcement", saved.id, { active: saved.active, severity: saved.severity });
        send(res, 200, { announcement: saved });
        return true;
      }
      if (req.method === "DELETE" && id) {
        requirePerm(adminUser, "notifications.send");
        const ok = await store.deleteAnnouncement(id);
        await audit("announcement.delete", "announcement", id);
        send(res, ok ? 200 : 404, ok ? { deleted: id } : { error: "Announcement not found" });
        return true;
      }
    }

    if (section === "email-logs" && req.method === "GET") {
      requirePerm(adminUser, "notifications.send");
      send(res, 200, { logs: await store.listEmailLogs(150) });
      return true;
    }

    // ---------------------------------------------------------------- J. Authentication & Session Management
    if (section === "auth") {
      if (id === "sessions" && !action && req.method === "GET") {
        requirePerm(adminUser, "auth.sessions.read");
        send(res, 200, { sessions: await store.listSessions({ limit: 200 }) });
        return true;
      }
      if (id === "sessions" && action && parts[5] === "revoke" && req.method === "POST") {
        requirePerm(adminUser, "auth.sessions.revoke");
        const ok = await store.revokeSession(action);
        await audit("session.revoke", "session", action);
        send(res, ok ? 200 : 404, ok ? { revoked: action } : { error: "Session not found" });
        return true;
      }
      if (id === "logins" && req.method === "GET") {
        requirePerm(adminUser, "auth.sessions.read");
        const successParam = url.searchParams.get("success");
        const logins = await store.listLoginHistory({
          search: url.searchParams.get("search") || undefined,
          success: successParam === "true" ? true : successParam === "false" ? false : undefined,
          limit: 200,
        });
        send(res, 200, { logins });
        return true;
      }
    }

    // ---------------------------------------------------------------- K. System Settings, Feature Flags & Audit Logs
    if (section === "settings") {
      if (req.method === "GET") {
        requirePerm(adminUser, "settings.read");
        send(res, 200, {
          settings: await store.listSettings(false),
          flags: await store.listFeatureFlags(),
        });
        return true;
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        requirePerm(adminUser, "settings.write");
        const body = await readJsonBody(req);
        const updates = (body.settings && typeof body.settings === "object" ? body.settings : body) as Record<string, unknown>;
        const publicKeys = new Set([
          "platform_name", "platform_tagline", "logo_url", "registration_enabled",
          "require_email_verification", "maintenance_mode", "maintenance_message",
          "allow_guest_preview", "credit_packages", "terms_url", "privacy_url",
        ]);
        for (const [k, v] of Object.entries(updates)) {
          if (k === "flags") continue;
          await store.setSetting(k, v, publicKeys.has(k), adminUser.id);
          if (["maintenance_mode", "registration_enabled", "require_email_verification"].includes(k)) {
            await store.upsertFeatureFlag({ flag_key: k, enabled: Boolean(v), description: k.replace(/_/g, " "), rules: {}, updated_by: adminUser.id });
          }
        }
        await audit("settings.update", "system_settings", null, { keys: Object.keys(updates) });
        send(res, 200, { settings: await store.listSettings(false), flags: await store.listFeatureFlags() });
        return true;
      }
    }

    if (section === "flags") {
      if (req.method === "GET") {
        requirePerm(adminUser, "settings.read");
        send(res, 200, { flags: await store.listFeatureFlags() });
        return true;
      }
      if (req.method === "PUT" || req.method === "POST") {
        requirePerm(adminUser, "settings.write");
        const body = await readJsonBody(req);
        const key = String(body.flag_key || "").trim();
        if (!key) throw new AuthError("flag_key is required.", 400);
        const flag = await store.upsertFeatureFlag({
          flag_key: key,
          enabled: Boolean(body.enabled),
          description: String(body.description || key.replace(/_/g, " ")),
          rules: body.rules && typeof body.rules === "object" ? (body.rules as Record<string, unknown>) : {},
          updated_by: adminUser.id,
        });
        if (["maintenance_mode", "registration_enabled", "require_email_verification"].includes(key)) {
          await store.setSetting(key, Boolean(body.enabled), true, adminUser.id);
        }
        await audit("flag.upsert", "feature_flag", key, { enabled: flag.enabled });
        send(res, 200, { flag });
        return true;
      }
    }

    if (section === "audit-logs" && req.method === "GET") {
      requirePerm(adminUser, "audit.read");
      send(res, 200, {
        logs: await store.listAuditLogs({
          adminUserId: url.searchParams.get("admin_user_id") || undefined,
          action: url.searchParams.get("action") || undefined,
          limit: Number(url.searchParams.get("limit") || 150),
        }),
      });
      return true;
    }

    send(res, 404, { error: "Admin endpoint not found" });
    return true;
  } catch (err) {
    if (err instanceof AuthError) {
      send(res, err.httpStatus, { error: err.message });
      return true;
    }
    throw err;
  }
}
