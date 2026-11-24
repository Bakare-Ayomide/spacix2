// MySQL / MariaDB implementation of PlatformStore with parameterized queries and atomic transactions.
import { randomUUID } from "node:crypto";
import type { MySqlClient, QueryExecutor } from "../db/client.ts";
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
  ModelParameterSpec,
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

function toMysqlDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 23).replace("T", " ");
}

function toIso(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  const s = String(val);
  if (s.includes("T")) return s;
  const d = new Date(s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function toIsoOrNull(val: unknown): string | null {
  return val ? toIso(val) : null;
}

function parseJson<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") {
    try { return JSON.parse(val) as T; } catch { return fallback; }
  }
  return val as T;
}

export class MySqlPlatformStore implements PlatformStore {
  readonly engine = "mysql" as const;
  private readonly client: MySqlClient;

  constructor(client: MySqlClient) {
    this.client = client;
  }

  async init(): Promise<void> {
    await this.client.migrate();
    // Ensure baseline permissions, roles, flags, plans, providers, settings exist
    for (const p of DEFAULT_PERMISSIONS) {
      await this.client.execute(
        "INSERT IGNORE INTO permissions (id, module_name, description) VALUES (?, ?, ?)",
        [p.id, p.module_name, p.description],
      );
    }
    for (const r of defaultRoles()) {
      await this.client.execute(
        "INSERT IGNORE INTO roles (id, name, description, is_system, is_admin_role) VALUES (?, ?, ?, ?, ?)",
        [r.id, r.name, r.description, r.is_system ? 1 : 0, r.is_admin_role ? 1 : 0],
      );
      for (const permId of r.permissions) {
        await this.client.execute(
          "INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
          [r.id, permId],
        );
      }
    }
    for (const f of defaultFlags()) {
      await this.client.execute(
        "INSERT IGNORE INTO feature_flags (flag_key, enabled, description, rules_json) VALUES (?, ?, ?, ?)",
        [f.flag_key, f.enabled ? 1 : 0, f.description, JSON.stringify(f.rules ?? {})],
      );
    }
    for (const pl of defaultPlans()) {
      await this.client.execute(
        `INSERT IGNORE INTO subscription_plans
          (id, code, name, description, price_cents, billing_interval, monthly_credits, trial_days, max_active_jobs, max_daily_runs, features_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pl.id, pl.code, pl.name, pl.description, pl.price_cents, pl.billing_interval, pl.monthly_credits, pl.trial_days, pl.max_active_jobs, pl.max_daily_runs, JSON.stringify(pl.features), pl.enabled ? 1 : 0],
      );
    }
    for (const pr of defaultProviders()) {
      await this.client.execute(
        `INSERT IGNORE INTO providers
          (id, name, adapter_type, enabled, priority, base_url, supported_endpoints_json, settings_json, health_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pr.id, pr.name, pr.adapter_type, pr.enabled ? 1 : 0, pr.priority, pr.base_url, JSON.stringify(pr.supported_endpoints), JSON.stringify(pr.settings), pr.health_status],
      );
    }
    for (const [k, v] of Object.entries(DEFAULT_SYSTEM_SETTINGS)) {
      await this.client.execute(
        "INSERT IGNORE INTO system_settings (setting_key, setting_value_json, is_public) VALUES (?, ?, ?)",
        [k, JSON.stringify(v.value), v.is_public ? 1 : 0],
      );
    }
  }

  // ---------------------------------------------------------------- Roles & Permissions
  async listPermissions(): Promise<PermissionRecord[]> {
    const [rows] = await this.client.execute<PermissionRecord[]>(
      "SELECT id, module_name, description FROM permissions ORDER BY module_name, id",
    );
    return Array.isArray(rows) && rows.length ? rows : [...DEFAULT_PERMISSIONS];
  }

  async listRoles(): Promise<RoleRecord[]> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT id, name, description, is_system, is_admin_role, created_at, updated_at FROM roles ORDER BY is_system DESC, name ASC",
    );
    const [rpRows] = await this.client.execute<{ role_id: string; permission_id: string }[]>(
      "SELECT role_id, permission_id FROM role_permissions",
    );
    const permsByRole = new Map<string, string[]>();
    for (const rp of Array.isArray(rpRows) ? rpRows : []) {
      const list = permsByRole.get(rp.role_id) ?? [];
      list.push(rp.permission_id);
      permsByRole.set(rp.role_id, list);
    }
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      description: String(r.description ?? ""),
      is_system: Boolean(r.is_system),
      is_admin_role: Boolean(r.is_admin_role),
      permissions: permsByRole.get(String(r.id)) ?? [],
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }));
  }

  async getRole(id: string): Promise<RoleRecord | null> {
    const roles = await this.listRoles();
    return roles.find((r) => r.id === id) ?? null;
  }

  async upsertRole(role: Omit<RoleRecord, "created_at" | "updated_at">): Promise<RoleRecord> {
    await this.client.withTransaction(async (tx) => {
      await tx.execute(
        `INSERT INTO roles (id, name, description, is_system, is_admin_role)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           description = VALUES(description),
           is_admin_role = VALUES(is_admin_role)`,
        [role.id, role.name, role.description, role.is_system ? 1 : 0, role.is_admin_role ? 1 : 0],
      );
      await tx.execute("DELETE FROM role_permissions WHERE role_id = ?", [role.id]);
      for (const perm of role.permissions) {
        await tx.execute(
          "INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
          [role.id, perm],
        );
      }
    });
    return (await this.getRole(role.id))!;
  }

  async deleteRole(id: string): Promise<boolean> {
    const role = await this.getRole(id);
    if (!role || role.is_system) return false;
    await this.client.execute("DELETE FROM roles WHERE id = ? AND is_system = 0", [id]);
    return true;
  }

  // ---------------------------------------------------------------- Users & Profiles
  private async hydrateUsers(userRows: Record<string, unknown>[]): Promise<UserRecord[]> {
    if (!userRows.length) return [];
    const ids = userRows.map((u) => String(u.id));
    const placeholders = ids.map(() => "?").join(",");

    const [profileRows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT user_id, avatar_url, company, bio, locale, timezone FROM user_profiles WHERE user_id IN (${placeholders})`,
      ids,
    );
    const profiles = new Map((Array.isArray(profileRows) ? profileRows : []).map((p) => [String(p.user_id), p]));

    const [roleRows] = await this.client.execute<{ user_id: string; role_id: string; is_admin_role: number }[]>(
      `SELECT ur.user_id, ur.role_id, r.is_admin_role
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id IN (${placeholders})`,
      ids,
    );
    const rolesByUser = new Map<string, string[]>();
    const adminByRole = new Set<string>();
    for (const rr of Array.isArray(roleRows) ? roleRows : []) {
      const list = rolesByUser.get(rr.user_id) ?? [];
      list.push(rr.role_id);
      rolesByUser.set(rr.user_id, list);
      if (rr.is_admin_role) adminByRole.add(rr.user_id);
    }

    const [permRows] = await this.client.execute<{ user_id: string; permission_id: string }[]>(
      `SELECT DISTINCT ur.user_id, rp.permission_id
       FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id IN (${placeholders})`,
      ids,
    );
    const permsByUser = new Map<string, string[]>();
    for (const pr of Array.isArray(permRows) ? permRows : []) {
      const list = permsByUser.get(pr.user_id) ?? [];
      list.push(pr.permission_id);
      permsByUser.set(pr.user_id, list);
    }

    const [walletRows] = await this.client.execute<{ user_id: string; balance: number }[]>(
      `SELECT user_id, balance FROM credit_wallets WHERE user_id IN (${placeholders})`,
      ids,
    );
    const wallets = new Map((Array.isArray(walletRows) ? walletRows : []).map((w) => [w.user_id, Number(w.balance)]));

    const [subRows] = await this.client.execute<{ user_id: string; plan_id: string }[]>(
      `SELECT user_id, plan_id FROM user_subscriptions WHERE user_id IN (${placeholders}) AND status IN ('active', 'trialing') ORDER BY created_at DESC`,
      ids,
    );
    const subs = new Map<string, string>();
    for (const s of Array.isArray(subRows) ? subRows : []) {
      if (!subs.has(s.user_id)) subs.set(s.user_id, s.plan_id);
    }

    return userRows.map((u) => {
      const id = String(u.id);
      const prof = profiles.get(id);
      const roles = rolesByUser.get(id) ?? [];
      return {
        id,
        visitor_key: u.visitor_key ? String(u.visitor_key) : null,
        email: u.email ? String(u.email) : null,
        password_hash: u.password_hash ? String(u.password_hash) : null,
        display_name: String(u.display_name ?? "Studio User"),
        status: (String(u.status || "active") as UserStatus),
        email_verified: Boolean(u.email_verified),
        email_verified_at: toIsoOrNull(u.email_verified_at),
        is_admin: Boolean(u.is_admin) || adminByRole.has(id),
        account_restrictions: parseJson<Record<string, unknown> | null>(u.account_restrictions_json, null),
        roles,
        permissions: permsByUser.get(id) ?? [],
        profile: {
          avatar_url: prof?.avatar_url ? String(prof.avatar_url) : null,
          company: prof?.company ? String(prof.company) : null,
          bio: prof?.bio ? String(prof.bio) : null,
          locale: String(prof?.locale || "en"),
          timezone: String(prof?.timezone || "UTC"),
        },
        credit_balance: wallets.get(id) ?? 0,
        subscription_plan_id: subs.get(id) ?? null,
        last_login_at: toIsoOrNull(u.last_login_at),
        last_active_at: toIsoOrNull(u.last_active_at),
        created_at: toIso(u.created_at),
        updated_at: toIso(u.updated_at),
      };
    });
  }

  async countUsers(): Promise<number> {
    const [rows] = await this.client.execute<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM users WHERE email IS NOT NULL",
    );
    return Number(rows?.[0]?.cnt ?? 0);
  }

  async countAdmins(): Promise<number> {
    const [rows] = await this.client.execute<{ cnt: number }[]>(
      `SELECT COUNT(DISTINCT u.id) AS cnt
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.is_admin = 1 OR r.is_admin_role = 1`,
    );
    return Number(rows?.[0]?.cnt ?? 0);
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
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.search) {
      where.push("(u.email LIKE ? OR u.display_name LIKE ? OR u.id LIKE ?)");
      const q = `%${filter.search}%`;
      params.push(q, q, q);
    }
    if (filter.status) {
      where.push("u.status = ?");
      params.push(filter.status);
    }
    if (filter.isAdmin !== undefined) {
      where.push("u.is_admin = ?");
      params.push(filter.isAdmin ? 1 : 0);
    }
    if (filter.role) {
      where.push("EXISTS (SELECT 1 FROM user_roles ur2 WHERE ur2.user_id = u.id AND ur2.role_id = ?)");
      params.push(filter.role);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [countRows] = await this.client.execute<{ cnt: number }[]>(
      `SELECT COUNT(*) AS cnt FROM users u ${whereSql}`,
      params,
    );
    const total = Number(countRows?.[0]?.cnt ?? 0);
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    const orderSql = filter.sort === "name" ? "u.display_name ASC" : filter.sort === "oldest" ? "u.created_at ASC" : "u.created_at DESC";
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT u.* FROM users u ${whereSql} ORDER BY ${orderSql} LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const users = await this.hydrateUsers(Array.isArray(rows) ? rows : []);
    return { users, total };
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM users WHERE id = ? LIMIT 1",
      [id],
    );
    const hydrated = await this.hydrateUsers(Array.isArray(rows) ? rows : []);
    return hydrated[0] ?? null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
      [email.trim()],
    );
    const hydrated = await this.hydrateUsers(Array.isArray(rows) ? rows : []);
    return hydrated[0] ?? null;
  }

  async ensureVisitorUser(visitorKey = "local-owner"): Promise<UserRecord> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM users WHERE visitor_key = ? LIMIT 1",
      [visitorKey],
    );
    if (Array.isArray(rows) && rows.length) {
      return (await this.hydrateUsers(rows))[0];
    }
    const id = visitorKey === "local-owner" ? "usr_local_owner" : `usr_vis_${visitorKey.slice(0, 24)}`;
    await this.client.execute(
      "INSERT IGNORE INTO users (id, visitor_key, display_name, status) VALUES (?, ?, ?, 'active')",
      [id, visitorKey, visitorKey === "local-owner" ? "Studio Workspace" : "Studio Guest"],
    );
    await this.client.execute("INSERT IGNORE INTO user_profiles (user_id) VALUES (?)", [id]);
    await this.client.execute("INSERT IGNORE INTO credit_wallets (user_id, balance) VALUES (?, 0)", [id]);
    await this.client.execute(
      "INSERT IGNORE INTO user_projects (id, user_id, name, description) VALUES (?, ?, ?, ?)",
      [`prj_${id}`, id, "Default Project", "Primary studio workspace"],
    );
    return (await this.getUserById(id))!;
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
    const id = input.id || `usr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const email = input.email.trim().toLowerCase();
    const roles = input.roles?.length ? input.roles : [input.isAdmin ? "admin" : "user"];
    const credits = Math.max(0, Math.trunc(input.initialCredits ?? 0));

    await this.client.withTransaction(async (tx) => {
      await tx.execute(
        `INSERT INTO users (id, email, password_hash, display_name, status, email_verified, email_verified_at, is_admin)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        [
          id,
          email,
          input.passwordHash,
          input.displayName.trim() || email.split("@")[0],
          input.emailVerified ? 1 : 0,
          input.emailVerified ? toMysqlDate(new Date().toISOString()) : null,
          input.isAdmin ? 1 : 0,
        ],
      );
      await tx.execute("INSERT IGNORE INTO user_profiles (user_id) VALUES (?)", [id]);
      for (const rId of roles) {
        await tx.execute("INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [id, rId]);
      }
      await tx.execute(
        "INSERT INTO credit_wallets (user_id, balance, lifetime_granted, lifetime_spent) VALUES (?, ?, ?, 0)",
        [id, credits, credits],
      );
      if (credits > 0) {
        await tx.execute(
          `INSERT INTO credit_transactions (id, user_id, tx_type, delta, balance_after, reason)
           VALUES (?, ?, 'grant', ?, ?, 'Initial account credits')`,
          [`ctx_${randomUUID().replace(/-/g, "").slice(0, 16)}`, id, credits, credits],
        );
      }
      await tx.execute(
        "INSERT IGNORE INTO user_projects (id, user_id, name, description) VALUES (?, ?, 'Default Project', 'Primary workspace')",
        [`prj_${id}`, id],
      );
      if (input.planId) {
        await tx.execute(
          `INSERT INTO user_subscriptions (id, user_id, plan_id, status) VALUES (?, ?, ?, 'active')`,
          [`sub_${randomUUID().replace(/-/g, "").slice(0, 16)}`, id, input.planId],
        );
      }
    });

    return (await this.getUserById(id))!;
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
    const existing = await this.getUserById(id);
    if (!existing) return null;

    await this.client.withTransaction(async (tx) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.displayName !== undefined) { sets.push("display_name = ?"); params.push(patch.displayName.trim()); }
      if (patch.email !== undefined) { sets.push("email = ?"); params.push(patch.email.trim().toLowerCase()); }
      if (patch.passwordHash !== undefined) { sets.push("password_hash = ?"); params.push(patch.passwordHash); }
      if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
      if (patch.emailVerified !== undefined) {
        sets.push("email_verified = ?");
        params.push(patch.emailVerified ? 1 : 0);
        if (patch.emailVerified) {
          sets.push("email_verified_at = COALESCE(email_verified_at, ?)");
          params.push(toMysqlDate(new Date().toISOString()));
        }
      }
      if (patch.isAdmin !== undefined) { sets.push("is_admin = ?"); params.push(patch.isAdmin ? 1 : 0); }
      if (patch.accountRestrictions !== undefined) {
        sets.push("account_restrictions_json = ?");
        params.push(patch.accountRestrictions ? JSON.stringify(patch.accountRestrictions) : null);
      }
      if (patch.lastLoginAt !== undefined) { sets.push("last_login_at = ?"); params.push(toMysqlDate(patch.lastLoginAt)); }
      if (patch.lastActiveAt !== undefined) { sets.push("last_active_at = ?"); params.push(toMysqlDate(patch.lastActiveAt)); }
      if (sets.length) {
        await tx.execute(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
      }

      if (patch.roles !== undefined) {
        await tx.execute("DELETE FROM user_roles WHERE user_id = ?", [id]);
        for (const rId of patch.roles) {
          await tx.execute("INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)", [id, rId]);
        }
      }

      if (patch.profile) {
        await tx.execute("INSERT IGNORE INTO user_profiles (user_id) VALUES (?)", [id]);
        const pSets: string[] = [];
        const pParams: unknown[] = [];
        if (patch.profile.avatar_url !== undefined) { pSets.push("avatar_url = ?"); pParams.push(patch.profile.avatar_url); }
        if (patch.profile.company !== undefined) { pSets.push("company = ?"); pParams.push(patch.profile.company); }
        if (patch.profile.bio !== undefined) { pSets.push("bio = ?"); pParams.push(patch.profile.bio); }
        if (patch.profile.locale !== undefined) { pSets.push("locale = ?"); pParams.push(patch.profile.locale); }
        if (patch.profile.timezone !== undefined) { pSets.push("timezone = ?"); pParams.push(patch.profile.timezone); }
        if (pSets.length) {
          await tx.execute(`UPDATE user_profiles SET ${pSets.join(", ")} WHERE user_id = ?`, [...pParams, id]);
        }
      }
    });

    return this.getUserById(id);
  }

  async deleteUser(id: string): Promise<boolean> {
    const existing = await this.getUserById(id);
    if (!existing) return false;
    await this.client.execute("DELETE FROM users WHERE id = ?", [id]);
    return true;
  }

  // ---------------------------------------------------------------- Sessions, Auth History & Tokens
  async createSession(input: {
    userId: string;
    tokenHash: string;
    isAdmin: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
    expiresAt: string;
  }): Promise<SessionRecord> {
    const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
    const now = new Date().toISOString();
    const table = input.isAdmin ? "admin_sessions" : "user_sessions";
    const userCol = input.isAdmin ? "admin_user_id" : "user_id";
    await this.client.execute(
      `INSERT INTO ${table} (id, ${userCol}, token_hash, ip_address, user_agent, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.userId, input.tokenHash, input.ipAddress ?? null, input.userAgent ?? null, toMysqlDate(input.expiresAt), toMysqlDate(now)],
    );
    return {
      id,
      user_id: input.userId,
      token_hash: input.tokenHash,
      is_admin: input.isAdmin,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
      expires_at: input.expiresAt,
      revoked_at: null,
      last_seen_at: now,
      created_at: now,
    };
  }

  async getSessionByTokenHash(tokenHash: string): Promise<{ session: SessionRecord; user: UserRecord } | null> {
    const [aRows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT id, admin_user_id AS user_id, token_hash, ip_address, user_agent, expires_at, revoked_at, last_seen_at, created_at FROM admin_sessions WHERE token_hash = ? LIMIT 1",
      [tokenHash],
    );
    let row = Array.isArray(aRows) && aRows.length ? aRows[0] : null;
    let isAdmin = true;
    if (!row) {
      isAdmin = false;
      const [uRows] = await this.client.execute<Record<string, unknown>[]>(
        "SELECT id, user_id, token_hash, ip_address, user_agent, expires_at, revoked_at, last_seen_at, created_at FROM user_sessions WHERE token_hash = ? LIMIT 1",
        [tokenHash],
      );
      row = Array.isArray(uRows) && uRows.length ? uRows[0] : null;
    }
    if (!row || row.revoked_at) return null;
    const expiresAt = toIso(row.expires_at);
    if (new Date(expiresAt).getTime() <= Date.now()) return null;
    const user = await this.getUserById(String(row.user_id));
    if (!user) return null;
    return {
      session: {
        id: String(row.id),
        user_id: String(row.user_id),
        token_hash: String(row.token_hash),
        is_admin: isAdmin,
        ip_address: row.ip_address ? String(row.ip_address) : null,
        user_agent: row.user_agent ? String(row.user_agent) : null,
        expires_at: expiresAt,
        revoked_at: null,
        last_seen_at: toIso(row.last_seen_at),
        created_at: toIso(row.created_at),
      },
      user,
    };
  }

  async touchSession(sessionId: string): Promise<void> {
    const ts = toMysqlDate(new Date().toISOString());
    await this.client.execute("UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?", [ts, sessionId]);
    await this.client.execute("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?", [ts, sessionId]);
  }

  async listSessions(filter: { userId?: string; activeOnly?: boolean; limit?: number } = {}): Promise<(SessionRecord & { user_email?: string | null; display_name?: string })[]> {
    const limit = Math.min(300, Math.max(1, filter.limit ?? 100));
    const activeClause = filter.activeOnly ? "AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP(3)" : "";
    const userClause = filter.userId ? "AND u.id = ?" : "";
    const params = filter.userId ? [filter.userId, filter.userId] : [];
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM (
         SELECT s.id, s.admin_user_id AS user_id, s.token_hash, 1 AS is_admin, s.ip_address, s.user_agent, s.expires_at, s.revoked_at, s.last_seen_at, s.created_at, u.email AS user_email, u.display_name
         FROM admin_sessions s JOIN users u ON u.id = s.admin_user_id
         WHERE 1=1 ${activeClause} ${userClause}
         UNION ALL
         SELECT s.id, s.user_id, s.token_hash, 0 AS is_admin, s.ip_address, s.user_agent, s.expires_at, s.revoked_at, s.last_seen_at, s.created_at, u.email AS user_email, u.display_name
         FROM user_sessions s JOIN users u ON u.id = s.user_id
         WHERE 1=1 ${activeClause} ${userClause}
       ) t ORDER BY last_seen_at DESC LIMIT ${limit}`,
      params,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      user_id: String(r.user_id),
      token_hash: String(r.token_hash),
      is_admin: Boolean(r.is_admin),
      ip_address: r.ip_address ? String(r.ip_address) : null,
      user_agent: r.user_agent ? String(r.user_agent) : null,
      expires_at: toIso(r.expires_at),
      revoked_at: toIsoOrNull(r.revoked_at),
      last_seen_at: toIso(r.last_seen_at),
      created_at: toIso(r.created_at),
      user_email: r.user_email ? String(r.user_email) : null,
      display_name: r.display_name ? String(r.display_name) : undefined,
    }));
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const ts = toMysqlDate(new Date().toISOString());
    const [r1] = await this.client.execute<{ affectedRows?: number }>(
      "UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      [ts, sessionId],
    );
    const [r2] = await this.client.execute<{ affectedRows?: number }>(
      "UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      [ts, sessionId],
    );
    return Boolean((r1?.affectedRows ?? 0) + (r2?.affectedRows ?? 0));
  }

  async revokeUserSessions(userId: string): Promise<number> {
    const ts = toMysqlDate(new Date().toISOString());
    const [r1] = await this.client.execute<{ affectedRows?: number }>(
      "UPDATE admin_sessions SET revoked_at = ? WHERE admin_user_id = ? AND revoked_at IS NULL",
      [ts, userId],
    );
    const [r2] = await this.client.execute<{ affectedRows?: number }>(
      "UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      [ts, userId],
    );
    return (r1?.affectedRows ?? 0) + (r2?.affectedRows ?? 0);
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
    await this.client.execute(
      `INSERT INTO login_history (id, user_id, email, success, failure_reason, is_admin_portal, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `lh_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        input.userId,
        input.email,
        input.success ? 1 : 0,
        input.failureReason ?? null,
        input.isAdminPortal ? 1 : 0,
        input.ipAddress ?? null,
        input.userAgent ?? null,
      ],
    );
  }

  async listLoginHistory(filter: { userId?: string; success?: boolean; search?: string; limit?: number } = {}): Promise<LoginHistoryRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.userId) { where.push("user_id = ?"); params.push(filter.userId); }
    if (filter.success !== undefined) { where.push("success = ?"); params.push(filter.success ? 1 : 0); }
    if (filter.search) { where.push("email LIKE ?"); params.push(`%${filter.search}%`); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(300, Math.max(1, filter.limit ?? 100));
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM login_history ${whereSql} ORDER BY created_at DESC LIMIT ${limit}`,
      params,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      user_id: r.user_id ? String(r.user_id) : null,
      email: String(r.email),
      success: Boolean(r.success),
      failure_reason: r.failure_reason ? String(r.failure_reason) : null,
      is_admin_portal: Boolean(r.is_admin_portal),
      ip_address: r.ip_address ? String(r.ip_address) : null,
      user_agent: r.user_agent ? String(r.user_agent) : null,
      created_at: toIso(r.created_at),
    }));
  }

  async createEmailVerification(userId: string, tokenHash: string, expiresAt: string): Promise<TokenRecord> {
    const id = `ev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await this.client.execute(
      "INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
      [id, userId, tokenHash, toMysqlDate(expiresAt)],
    );
    return { id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, consumed_at: null, created_by_admin_id: null, created_at: new Date().toISOString() };
  }

  async consumeEmailVerification(tokenHash: string): Promise<UserRecord | null> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT id, user_id, expires_at, verified_at FROM email_verifications WHERE token_hash = ? LIMIT 1",
      [tokenHash],
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || row.verified_at || new Date(toIso(row.expires_at)).getTime() <= Date.now()) return null;
    const ts = toMysqlDate(new Date().toISOString());
    await this.client.execute("UPDATE email_verifications SET verified_at = ? WHERE id = ?", [ts, row.id]);
    return this.updateUser(String(row.user_id), { emailVerified: true });
  }

  async createPasswordReset(userId: string, tokenHash: string, expiresAt: string, adminUserId: string | null = null): Promise<TokenRecord> {
    const id = `pr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await this.client.execute(
      "INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_by_admin_id) VALUES (?, ?, ?, ?, ?)",
      [id, userId, tokenHash, toMysqlDate(expiresAt), adminUserId],
    );
    return { id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, consumed_at: null, created_by_admin_id: adminUserId, created_at: new Date().toISOString() };
  }

  async consumePasswordReset(tokenHash: string, newPasswordHash: string): Promise<UserRecord | null> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ? LIMIT 1",
      [tokenHash],
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || row.used_at || new Date(toIso(row.expires_at)).getTime() <= Date.now()) return null;
    const ts = toMysqlDate(new Date().toISOString());
    await this.client.execute("UPDATE password_resets SET used_at = ? WHERE id = ?", [ts, row.id]);
    const user = await this.updateUser(String(row.user_id), { passwordHash: newPasswordHash });
    if (user) await this.revokeUserSessions(user.id);
    return user;
  }

  // ---------------------------------------------------------------- Providers & Credentials & Logs
  async listProviders(): Promise<ProviderConfigRecord[]> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM providers ORDER BY priority ASC, name ASC",
    );
    const [credRows] = await this.client.execute<{ provider_id: string; credential_key: string; key_hint: string }[]>(
      "SELECT provider_id, credential_key, key_hint FROM provider_credentials",
    );
    const hintsByProv = new Map<string, Record<string, string>>();
    for (const c of Array.isArray(credRows) ? credRows : []) {
      const m = hintsByProv.get(c.provider_id) ?? {};
      m[c.credential_key] = c.key_hint;
      hintsByProv.set(c.provider_id, m);
    }
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      adapter_type: String(r.adapter_type),
      enabled: Boolean(r.enabled),
      priority: Number(r.priority ?? 100),
      fallback_provider_id: r.fallback_provider_id ? String(r.fallback_provider_id) : null,
      base_url: String(r.base_url ?? ""),
      supported_endpoints: parseJson<string[]>(r.supported_endpoints_json, []),
      settings: parseJson<Record<string, unknown>>(r.settings_json, {}),
      health_status: String(r.health_status ?? "untested"),
      last_tested_at: toIsoOrNull(r.last_tested_at),
      last_error: r.last_error ? String(r.last_error) : null,
      credential_hints: hintsByProv.get(String(r.id)) ?? {},
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }));
  }

  async getProvider(id: string): Promise<ProviderConfigRecord | null> {
    const all = await this.listProviders();
    return all.find((p) => p.id === id) ?? null;
  }

  async upsertProvider(input: Omit<ProviderConfigRecord, "created_at" | "updated_at" | "credential_hints">): Promise<ProviderConfigRecord> {
    await this.client.execute(
      `INSERT INTO providers
        (id, name, adapter_type, enabled, priority, fallback_provider_id, base_url, supported_endpoints_json, settings_json, health_status, last_tested_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         adapter_type = VALUES(adapter_type),
         enabled = VALUES(enabled),
         priority = VALUES(priority),
         fallback_provider_id = VALUES(fallback_provider_id),
         base_url = VALUES(base_url),
         supported_endpoints_json = VALUES(supported_endpoints_json),
         settings_json = VALUES(settings_json),
         health_status = VALUES(health_status),
         last_tested_at = VALUES(last_tested_at),
         last_error = VALUES(last_error)`,
      [
        input.id,
        input.name,
        input.adapter_type,
        input.enabled ? 1 : 0,
        input.priority,
        input.fallback_provider_id ?? null,
        input.base_url,
        JSON.stringify(input.supported_endpoints ?? []),
        JSON.stringify(input.settings ?? {}),
        input.health_status,
        toMysqlDate(input.last_tested_at),
        input.last_error ?? null,
      ],
    );
    return (await this.getProvider(input.id))!;
  }

  async updateProviderHealth(id: string, status: string, lastError: string | null): Promise<void> {
    await this.client.execute(
      "UPDATE providers SET health_status = ?, last_tested_at = ?, last_error = ? WHERE id = ?",
      [status, toMysqlDate(new Date().toISOString()), lastError, id],
    );
  }

  async deleteProvider(id: string): Promise<boolean> {
    const [res] = await this.client.execute<{ affectedRows?: number }>("DELETE FROM providers WHERE id = ?", [id]);
    return Boolean(res?.affectedRows);
  }

  async setProviderCredential(providerId: string, key: string, encryptedValue: string, keyHint: string, updatedBy: string | null): Promise<void> {
    const id = `pc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await this.client.execute(
      `INSERT INTO provider_credentials (id, provider_id, credential_key, encrypted_value, key_hint, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         encrypted_value = VALUES(encrypted_value),
         key_hint = VALUES(key_hint),
         updated_by = VALUES(updated_by)`,
      [id, providerId, key, encryptedValue, keyHint, updatedBy],
    );
  }

  async getProviderCredentials(providerId: string): Promise<ProviderCredentialRecord[]> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM provider_credentials WHERE provider_id = ?",
      [providerId],
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      provider_id: String(r.provider_id),
      credential_key: String(r.credential_key),
      encrypted_value: String(r.encrypted_value),
      key_hint: String(r.key_hint ?? ""),
      updated_by: r.updated_by ? String(r.updated_by) : null,
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }));
  }

  async appendProviderLog(log: Omit<ProviderLogRecord, "id" | "created_at">): Promise<void> {
    await this.client.execute(
      `INSERT INTO provider_logs (id, provider_id, endpoint, method, status_code, duration_ms, ok, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `pl_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        log.provider_id,
        log.endpoint,
        log.method,
        log.status_code ?? null,
        log.duration_ms,
        log.ok ? 1 : 0,
        log.error_message ? log.error_message.slice(0, 500) : null,
      ],
    );
  }

  async listProviderLogs(providerId?: string, limit = 100): Promise<ProviderLogRecord[]> {
    const max = Math.min(300, Math.max(1, limit));
    const where = providerId ? "WHERE provider_id = ?" : "";
    const params = providerId ? [providerId] : [];
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM provider_logs ${where} ORDER BY created_at DESC LIMIT ${max}`,
      params,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      provider_id: String(r.provider_id),
      endpoint: String(r.endpoint),
      method: String(r.method),
      status_code: r.status_code !== null && r.status_code !== undefined ? Number(r.status_code) : null,
      duration_ms: Number(r.duration_ms ?? 0),
      ok: Boolean(r.ok),
      error_message: r.error_message ? String(r.error_message) : null,
      created_at: toIso(r.created_at),
    }));
  }

  // ---------------------------------------------------------------- Models
  async listModels(filter: { providerId?: string; category?: string; enabledOnly?: boolean } = {}): Promise<ProviderModelRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.providerId) { where.push("provider_id = ?"); params.push(filter.providerId); }
    if (filter.category) { where.push("category = ?"); params.push(filter.category); }
    if (filter.enabledOnly) { where.push("enabled = 1"); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM provider_models ${whereSql} ORDER BY is_default DESC, display_name ASC`,
      params,
    );
    const [pRows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM model_parameters ORDER BY sort_order ASC",
    );
    const paramsByModel = new Map<string, ModelParameterSpec[]>();
    for (const pr of Array.isArray(pRows) ? pRows : []) {
      const mId = String(pr.model_id);
      const list = paramsByModel.get(mId) ?? [];
      list.push({
        id: String(pr.id),
        model_id: mId,
        param_key: String(pr.param_key),
        param_type: String(pr.param_type),
        label: String(pr.label),
        default_value: parseJson(pr.default_value_json, null),
        constraints: parseJson(pr.constraints_json, {}),
        required: Boolean(pr.required),
        sort_order: Number(pr.sort_order ?? 0),
      });
      paramsByModel.set(mId, list);
    }
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      provider_id: String(r.provider_id),
      endpoint: String(r.endpoint),
      display_name: String(r.display_name),
      description: String(r.description ?? ""),
      category: String(r.category ?? "image"),
      capability: String(r.capability ?? "text-to-image"),
      source: (String(r.source || "manual") as ProviderModelRecord["source"]),
      enabled: Boolean(r.enabled),
      is_default: Boolean(r.is_default),
      fallback_model_id: r.fallback_model_id ? String(r.fallback_model_id) : null,
      thumbnail_url: r.thumbnail_url ? String(r.thumbnail_url) : null,
      internal_cost_usd: r.internal_cost_usd !== null && r.internal_cost_usd !== undefined ? Number(r.internal_cost_usd) : null,
      credit_price: Number(r.credit_price ?? 1),
      allowed_roles: parseJson<string[]>(r.allowed_roles_json, []),
      allowed_plans: parseJson<string[]>(r.allowed_plans_json, []),
      capabilities: parseJson<Record<string, unknown>>(r.capabilities_json, {}),
      parameters: paramsByModel.get(String(r.id)) ?? [],
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }));
  }

  async getModel(id: string): Promise<ProviderModelRecord | null> {
    const all = await this.listModels();
    return all.find((m) => m.id === id) ?? null;
  }

  async upsertModel(model: Omit<ProviderModelRecord, "created_at" | "updated_at">): Promise<ProviderModelRecord> {
    await this.client.withTransaction(async (tx) => {
      await tx.execute(
        `INSERT INTO provider_models
          (id, provider_id, endpoint, display_name, description, category, capability, source, enabled, is_default, fallback_model_id, thumbnail_url, internal_cost_usd, credit_price, allowed_roles_json, allowed_plans_json, capabilities_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           display_name = VALUES(display_name),
           description = VALUES(description),
           category = VALUES(category),
           capability = VALUES(capability),
           enabled = VALUES(enabled),
           is_default = VALUES(is_default),
           fallback_model_id = VALUES(fallback_model_id),
           thumbnail_url = VALUES(thumbnail_url),
           internal_cost_usd = VALUES(internal_cost_usd),
           credit_price = VALUES(credit_price),
           allowed_roles_json = VALUES(allowed_roles_json),
           allowed_plans_json = VALUES(allowed_plans_json),
           capabilities_json = VALUES(capabilities_json)`,
        [
          model.id, model.provider_id, model.endpoint, model.display_name, model.description ?? "",
          model.category, model.capability, model.source, model.enabled ? 1 : 0, model.is_default ? 1 : 0,
          model.fallback_model_id ?? null, model.thumbnail_url ?? null, model.internal_cost_usd ?? null,
          model.credit_price ?? 1, JSON.stringify(model.allowed_roles ?? []), JSON.stringify(model.allowed_plans ?? []),
          JSON.stringify(model.capabilities ?? {}),
        ],
      );
      if (Array.isArray(model.parameters)) {
        await tx.execute("DELETE FROM model_parameters WHERE model_id = ?", [model.id]);
        for (const p of model.parameters) {
          await tx.execute(
            `INSERT INTO model_parameters (id, model_id, param_key, param_type, label, default_value_json, constraints_json, required, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [p.id || `mp_${randomUUID().replace(/-/g, "").slice(0, 12)}`, model.id, p.param_key, p.param_type, p.label, JSON.stringify(p.default_value ?? null), JSON.stringify(p.constraints ?? {}), p.required ? 1 : 0, p.sort_order ?? 0],
          );
        }
      }
    });
    return (await this.getModel(model.id))!;
  }

  async deleteModel(id: string): Promise<boolean> {
    const [res] = await this.client.execute<{ affectedRows?: number }>("DELETE FROM provider_models WHERE id = ?", [id]);
    return Boolean(res?.affectedRows);
  }

  // ---------------------------------------------------------------- Studio Apps & Flags
  async listStudioApps(): Promise<StudioAppConfigRecord[]> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM studio_applications ORDER BY section ASC, name ASC",
    );
    const [amRows] = await this.client.execute<{ application_id: string; model_id: string; is_primary: number; priority: number }[]>(
      "SELECT application_id, model_id, is_primary, priority FROM application_models WHERE enabled = 1 ORDER BY is_primary DESC, priority ASC",
    );
    const modelsByApp = new Map<string, string[]>();
    const primaryByApp = new Map<string, string>();
    for (const am of Array.isArray(amRows) ? amRows : []) {
      const list = modelsByApp.get(am.application_id) ?? [];
      list.push(am.model_id);
      modelsByApp.set(am.application_id, list);
      if (am.is_primary && !primaryByApp.has(am.application_id)) primaryByApp.set(am.application_id, am.model_id);
    }
    return (Array.isArray(rows) ? rows : []).map((r) => {
      const id = String(r.id);
      return {
        id,
        section: String(r.section) as StudioAppConfigRecord["section"],
        name: String(r.name),
        summary: String(r.summary ?? ""),
        thumbnail_url: r.thumbnail_url ? String(r.thumbnail_url) : null,
        enabled: Boolean(r.enabled),
        studio_enabled: Boolean(r.studio_enabled),
        maintenance_mode: Boolean(r.maintenance_mode),
        credit_cost: Number(r.credit_cost ?? 1),
        allowed_roles: parseJson<string[]>(r.allowed_roles_json, []),
        allowed_plans: parseJson<string[]>(r.allowed_plans_json, []),
        presets_override: parseJson<Record<string, unknown>[] | null>(r.presets_override_json, null),
        settings_override: parseJson<Record<string, unknown> | null>(r.settings_override_json, null),
        published: Boolean(r.published),
        model_ids: modelsByApp.get(id) ?? [],
        primary_model_id: primaryByApp.get(id) ?? null,
        updated_by: r.updated_by ? String(r.updated_by) : null,
        updated_at: toIso(r.updated_at),
      };
    });
  }

  async getStudioApp(id: string): Promise<StudioAppConfigRecord | null> {
    const all = await this.listStudioApps();
    return all.find((a) => a.id === id) ?? null;
  }

  async upsertStudioApp(cfg: StudioAppConfigRecord): Promise<StudioAppConfigRecord> {
    await this.client.withTransaction(async (tx) => {
      await tx.execute(
        `INSERT INTO studio_applications
          (id, section, name, summary, thumbnail_url, enabled, studio_enabled, maintenance_mode, credit_cost, allowed_roles_json, allowed_plans_json, presets_override_json, settings_override_json, published, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           section = VALUES(section),
           name = VALUES(name),
           summary = VALUES(summary),
           thumbnail_url = VALUES(thumbnail_url),
           enabled = VALUES(enabled),
           studio_enabled = VALUES(studio_enabled),
           maintenance_mode = VALUES(maintenance_mode),
           credit_cost = VALUES(credit_cost),
           allowed_roles_json = VALUES(allowed_roles_json),
           allowed_plans_json = VALUES(allowed_plans_json),
           presets_override_json = VALUES(presets_override_json),
           settings_override_json = VALUES(settings_override_json),
           published = VALUES(published),
           updated_by = VALUES(updated_by)`,
        [
          cfg.id, cfg.section, cfg.name, cfg.summary ?? "", cfg.thumbnail_url ?? null,
          cfg.enabled ? 1 : 0, cfg.studio_enabled ? 1 : 0, cfg.maintenance_mode ? 1 : 0,
          cfg.credit_cost ?? 1, JSON.stringify(cfg.allowed_roles ?? []), JSON.stringify(cfg.allowed_plans ?? []),
          cfg.presets_override ? JSON.stringify(cfg.presets_override) : null,
          cfg.settings_override ? JSON.stringify(cfg.settings_override) : null,
          cfg.published ? 1 : 0, cfg.updated_by ?? null,
        ],
      );
      if (Array.isArray(cfg.model_ids)) {
        await tx.execute("DELETE FROM application_models WHERE application_id = ?", [cfg.id]);
        for (let i = 0; i < cfg.model_ids.length; i++) {
          const mId = cfg.model_ids[i];
          const isPrimary = cfg.primary_model_id ? cfg.primary_model_id === mId : i === 0;
          await tx.execute(
            "INSERT IGNORE INTO application_models (application_id, model_id, is_primary, priority, enabled) VALUES (?, ?, ?, ?, 1)",
            [cfg.id, mId, isPrimary ? 1 : 0, i * 10],
          );
        }
      }
    });
    return (await this.getStudioApp(cfg.id))!;
  }

  async setStudioSectionEnabled(section: "image" | "video" | "audio" | "utility", enabled: boolean, updatedBy: string | null): Promise<void> {
    await this.client.execute(
      "UPDATE studio_applications SET studio_enabled = ?, updated_by = ? WHERE section = ?",
      [enabled ? 1 : 0, updatedBy, section],
    );
  }

  async listFeatureFlags(): Promise<FeatureFlagRecord[]> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM feature_flags ORDER BY flag_key ASC",
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      flag_key: String(r.flag_key),
      enabled: Boolean(r.enabled),
      description: String(r.description ?? ""),
      rules: parseJson<Record<string, unknown>>(r.rules_json, {}),
      updated_by: r.updated_by ? String(r.updated_by) : null,
      updated_at: toIso(r.updated_at),
    }));
  }

  async upsertFeatureFlag(flag: Omit<FeatureFlagRecord, "updated_at">): Promise<FeatureFlagRecord> {
    await this.client.execute(
      `INSERT INTO feature_flags (flag_key, enabled, description, rules_json, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         enabled = VALUES(enabled),
         description = VALUES(description),
         rules_json = VALUES(rules_json),
         updated_by = VALUES(updated_by)`,
      [flag.flag_key, flag.enabled ? 1 : 0, flag.description ?? "", JSON.stringify(flag.rules ?? {}), flag.updated_by ?? null],
    );
    const list = await this.listFeatureFlags();
    return list.find((f) => f.flag_key === flag.flag_key)!;
  }

  // ---------------------------------------------------------------- Projects & Generations
  async listProjects(userId: string): Promise<ProjectRecord[]> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT id, user_id, name, description, created_at, updated_at FROM user_projects WHERE user_id = ? ORDER BY created_at DESC",
      [userId],
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      user_id: String(r.user_id),
      name: String(r.name),
      description: String(r.description ?? ""),
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }));
  }

  async createProject(userId: string, name: string, description = ""): Promise<ProjectRecord> {
    const id = `prj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    await this.client.execute(
      "INSERT INTO user_projects (id, user_id, name, description) VALUES (?, ?, ?, ?)",
      [id, userId, name.trim().slice(0, 120), description.trim().slice(0, 500)],
    );
    return { id, user_id: userId, name: name.trim().slice(0, 120), description: description.trim().slice(0, 500), created_at: now, updated_at: now };
  }

  async syncGeneration(gen: GenerationRecord): Promise<void> {
    await this.client.execute(
      `INSERT INTO user_generations
        (id, user_id, project_id, app_id, provider_id, model_id, media_type, status, prompt, preset_id, settings_json, error_json, credits_charged, moderation_status, moderation_note, seconds, total_seconds, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         provider_id = VALUES(provider_id),
         model_id = VALUES(model_id),
         status = VALUES(status),
         error_json = VALUES(error_json),
         seconds = VALUES(seconds),
         total_seconds = VALUES(total_seconds),
         started_at = VALUES(started_at),
         finished_at = VALUES(finished_at)`,
      [
        gen.id, gen.user_id, gen.project_id ?? null, gen.app_id, gen.provider_id ?? null, gen.model_id ?? null,
        gen.media_type, gen.status, gen.prompt ?? null, gen.preset_id ?? null,
        JSON.stringify(gen.settings ?? {}), gen.error ? JSON.stringify(gen.error) : null,
        gen.credits_charged ?? 0, gen.moderation_status ?? "clean", gen.moderation_note ?? null,
        gen.seconds ?? null, gen.total_seconds ?? null,
        toMysqlDate(gen.created_at) ?? toMysqlDate(new Date().toISOString()),
        toMysqlDate(gen.started_at), toMysqlDate(gen.finished_at),
      ],
    );

    if (gen.provider_id && gen.provider_endpoint) {
      const jobStatus = ["queued", "running", "succeeded", "failed", "canceled", "expired"].includes(gen.status) ? gen.status : "queued";
      await this.client.execute(
        `INSERT INTO generation_jobs (id, generation_id, provider_id, provider_endpoint, external_job_id, status, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           external_job_id = VALUES(external_job_id),
           status = VALUES(status),
           error_message = VALUES(error_message)`,
        [`gj_${gen.id}`, gen.id, gen.provider_id, gen.provider_endpoint, gen.provider_job_id ?? null, jobStatus, gen.error?.message ?? null],
      );
    }

    for (const inp of gen.inputs ?? []) {
      const mType = inp.type === "video" || inp.type === "audio" ? inp.type : "image";
      await this.client.execute(
        "INSERT IGNORE INTO generation_inputs (id, generation_id, input_key, media_type, file_name, storage_path) VALUES (?, ?, ?, ?, ?, ?)",
        [`${gen.id}_in_${inp.id}`, gen.id, inp.id, mType, inp.name, inp.file],
      );
      await this.client.execute(
        "INSERT IGNORE INTO media_assets (id, user_id, generation_id, role, input_id, media_type, file_name, local_path) VALUES (?, ?, ?, 'input', ?, ?, ?, ?)",
        [`${gen.id}_in_${inp.id}`, gen.user_id, gen.id, inp.id, mType, inp.name, inp.file],
      );
    }

    for (let i = 0; i < (gen.outputs ?? []).length; i++) {
      const out = gen.outputs[i];
      const mType = out.type === "video" || out.type === "audio" ? out.type : "image";
      await this.client.execute(
        `INSERT INTO generation_outputs (id, generation_id, media_type, file_name, storage_path, remote_url)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE remote_url = COALESCE(VALUES(remote_url), remote_url)`,
        [`${gen.id}_out_${i}`, gen.id, mType, out.name, out.file, out.url ?? null],
      );
      await this.client.execute(
        `INSERT INTO media_assets (id, user_id, generation_id, role, input_id, media_type, file_name, local_path, remote_url)
         VALUES (?, ?, ?, 'output', NULL, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE remote_url = COALESCE(VALUES(remote_url), remote_url)`,
        [`${gen.id}_out_${i}`, gen.user_id, gen.id, mType, out.name, out.file, out.url ?? null],
      );
    }
  }

  private async hydrateGenerations(rows: Record<string, unknown>[]): Promise<GenerationRecord[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => String(r.id));
    const placeholders = ids.map(() => "?").join(",");
    const [inRows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT generation_id, input_key, media_type, file_name, storage_path FROM generation_inputs WHERE generation_id IN (${placeholders})`,
      ids,
    );
    const [outRows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT generation_id, media_type, file_name, storage_path, remote_url FROM generation_outputs WHERE generation_id IN (${placeholders})`,
      ids,
    );
    const [jobRows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT generation_id, provider_endpoint, external_job_id FROM generation_jobs WHERE generation_id IN (${placeholders})`,
      ids,
    );
    const insMap = new Map<string, GenerationRecord["inputs"]>();
    for (const r of Array.isArray(inRows) ? inRows : []) {
      const gid = String(r.generation_id);
      const list = insMap.get(gid) ?? [];
      list.push({ id: String(r.input_key), type: String(r.media_type), file: String(r.storage_path), name: String(r.file_name) });
      insMap.set(gid, list);
    }
    const outsMap = new Map<string, GenerationRecord["outputs"]>();
    for (const r of Array.isArray(outRows) ? outRows : []) {
      const gid = String(r.generation_id);
      const list = outsMap.get(gid) ?? [];
      list.push({ file: String(r.storage_path), type: String(r.media_type), name: String(r.file_name), node: "out", ...(r.remote_url ? { url: String(r.remote_url) } : {}) });
      outsMap.set(gid, list);
    }
    const jobsMap = new Map((Array.isArray(jobRows) ? jobRows : []).map((j) => [String(j.generation_id), j]));

    return rows.map((r) => {
      const id = String(r.id);
      const j = jobsMap.get(id);
      return {
        id,
        user_id: String(r.user_id),
        project_id: r.project_id ? String(r.project_id) : null,
        app_id: String(r.app_id),
        provider_id: r.provider_id ? String(r.provider_id) : null,
        provider_endpoint: j?.provider_endpoint ? String(j.provider_endpoint) : null,
        provider_job_id: j?.external_job_id ? String(j.external_job_id) : null,
        model_id: r.model_id ? String(r.model_id) : null,
        media_type: String(r.media_type || "image") as GenerationRecord["media_type"],
        status: String(r.status),
        prompt: r.prompt ? String(r.prompt) : null,
        preset_id: r.preset_id ? String(r.preset_id) : null,
        settings: parseJson<Record<string, unknown>>(r.settings_json, {}),
        inputs: insMap.get(id) ?? [],
        outputs: outsMap.get(id) ?? [],
        error: parseJson<GenerationRecord["error"]>(r.error_json, null),
        credits_charged: Number(r.credits_charged ?? 0),
        moderation_status: String(r.moderation_status || "clean") as GenerationRecord["moderation_status"],
        moderation_note: r.moderation_note ? String(r.moderation_note) : null,
        seconds: r.seconds !== null && r.seconds !== undefined ? Number(r.seconds) : null,
        total_seconds: r.total_seconds !== null && r.total_seconds !== undefined ? Number(r.total_seconds) : null,
        created_at: toIso(r.created_at),
        started_at: toIsoOrNull(r.started_at),
        finished_at: toIsoOrNull(r.finished_at),
      };
    });
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
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.userId) { where.push("user_id = ?"); params.push(filter.userId); }
    if (filter.appId) { where.push("app_id = ?"); params.push(filter.appId); }
    if (filter.providerId) { where.push("provider_id = ?"); params.push(filter.providerId); }
    if (filter.mediaType) { where.push("media_type = ?"); params.push(filter.mediaType); }
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    if (filter.dateFrom) { where.push("created_at >= ?"); params.push(toMysqlDate(filter.dateFrom)); }
    if (filter.dateTo) { where.push("created_at <= ?"); params.push(toMysqlDate(filter.dateTo)); }
    if (filter.search) {
      where.push("(id LIKE ? OR app_id LIKE ? OR prompt LIKE ?)");
      const q = `%${filter.search}%`;
      params.push(q, q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [cntRows] = await this.client.execute<{ cnt: number }[]>(
      `SELECT COUNT(*) AS cnt FROM user_generations ${whereSql}`,
      params,
    );
    const total = Number(cntRows?.[0]?.cnt ?? 0);
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM user_generations ${whereSql} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { generations: await this.hydrateGenerations(Array.isArray(rows) ? rows : []), total };
  }

  async getGeneration(id: string): Promise<GenerationRecord | null> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM user_generations WHERE id = ? LIMIT 1",
      [id],
    );
    const list = await this.hydrateGenerations(Array.isArray(rows) ? rows : []);
    return list[0] ?? null;
  }

  async updateGenerationModeration(id: string, moderationStatus: "clean" | "flagged" | "removed", note: string | null = null): Promise<GenerationRecord | null> {
    await this.client.execute(
      "UPDATE user_generations SET moderation_status = ?, moderation_note = ? WHERE id = ?",
      [moderationStatus, note, id],
    );
    return this.getGeneration(id);
  }

  async deleteGenerationRecord(id: string): Promise<boolean> {
    const [res] = await this.client.execute<{ affectedRows?: number }>("DELETE FROM user_generations WHERE id = ?", [id]);
    return Boolean(res?.affectedRows);
  }

  // ---------------------------------------------------------------- Credits, Subscriptions & Payments
  async getCreditSummary(userId: string) {
    const [wRows] = await this.client.execute<{ balance: number; lifetime_granted: number; lifetime_spent: number }[]>(
      "SELECT balance, lifetime_granted, lifetime_spent FROM credit_wallets WHERE user_id = ? LIMIT 1",
      [userId],
    );
    const w = wRows?.[0] ?? { balance: 0, lifetime_granted: 0, lifetime_spent: 0 };
    const transactions = await this.listAllTransactions({ userId, limit: 50 });
    return {
      balance: Number(w.balance ?? 0),
      lifetime_granted: Number(w.lifetime_granted ?? 0),
      lifetime_spent: Number(w.lifetime_spent ?? 0),
      transactions,
    };
  }

  async listAllTransactions(filter: { userId?: string; limit?: number } = {}): Promise<CreditTransactionRecord[]> {
    const limit = Math.min(300, Math.max(1, filter.limit ?? 100));
    const where = filter.userId ? "WHERE user_id = ?" : "";
    const params = filter.userId ? [filter.userId] : [];
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM credit_transactions ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      params,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      user_id: String(r.user_id),
      generation_id: r.generation_id ? String(r.generation_id) : null,
      admin_user_id: r.admin_user_id ? String(r.admin_user_id) : null,
      tx_type: String(r.tx_type) as CreditTransactionRecord["tx_type"],
      delta: Number(r.delta),
      balance_after: Number(r.balance_after),
      reason: String(r.reason),
      reference_id: r.reference_id ? String(r.reference_id) : null,
      created_at: toIso(r.created_at),
    }));
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
    const txId = `ctx_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const delta = Math.trunc(input.delta);
    return this.client.withTransaction(async (q: QueryExecutor) => {
      await q.execute("INSERT IGNORE INTO credit_wallets (user_id, balance) VALUES (?, 0)", [input.userId]);
      const [rows] = await q.execute<{ balance: number; lifetime_granted: number; lifetime_spent: number }[]>(
        "SELECT balance, lifetime_granted, lifetime_spent FROM credit_wallets WHERE user_id = ? FOR UPDATE",
        [input.userId],
      );
      const cur = rows?.[0] ?? { balance: 0, lifetime_granted: 0, lifetime_spent: 0 };
      const next = Number(cur.balance) + delta;
      if (next < 0) throw new Error("Insufficient credit balance");
      const granted = Number(cur.lifetime_granted) + (delta > 0 ? delta : 0);
      const spent = Number(cur.lifetime_spent) + (delta < 0 ? Math.abs(delta) : 0);
      await q.execute(
        "UPDATE credit_wallets SET balance = ?, lifetime_granted = ?, lifetime_spent = ? WHERE user_id = ?",
        [next, granted, spent, input.userId],
      );
      await q.execute(
        `INSERT INTO credit_transactions (id, user_id, generation_id, admin_user_id, tx_type, delta, balance_after, reason, reference_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [txId, input.userId, input.generationId ?? null, input.adminUserId ?? null, input.txType, delta, next, input.reason, input.referenceId ?? null],
      );
      return {
        balance: next,
        transaction: {
          id: txId,
          user_id: input.userId,
          generation_id: input.generationId ?? null,
          admin_user_id: input.adminUserId ?? null,
          tx_type: input.txType,
          delta,
          balance_after: next,
          reason: input.reason,
          reference_id: input.referenceId ?? null,
          created_at: new Date().toISOString(),
        },
      };
    });
  }

  async listPlans(enabledOnly = false): Promise<SubscriptionPlanRecord[]> {
    const where = enabledOnly ? "WHERE enabled = 1" : "";
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM subscription_plans ${where} ORDER BY price_cents ASC`,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      code: String(r.code),
      name: String(r.name),
      description: String(r.description ?? ""),
      price_cents: Number(r.price_cents ?? 0),
      billing_interval: String(r.billing_interval || "month") as SubscriptionPlanRecord["billing_interval"],
      monthly_credits: Number(r.monthly_credits ?? 0),
      trial_days: Number(r.trial_days ?? 0),
      max_active_jobs: Number(r.max_active_jobs ?? 2),
      max_daily_runs: r.max_daily_runs !== null && r.max_daily_runs !== undefined ? Number(r.max_daily_runs) : null,
      features: parseJson<Record<string, unknown>>(r.features_json, {}),
      enabled: Boolean(r.enabled),
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }));
  }

  async upsertPlan(plan: Omit<SubscriptionPlanRecord, "created_at" | "updated_at">): Promise<SubscriptionPlanRecord> {
    await this.client.execute(
      `INSERT INTO subscription_plans
        (id, code, name, description, price_cents, billing_interval, monthly_credits, trial_days, max_active_jobs, max_daily_runs, features_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         code = VALUES(code),
         name = VALUES(name),
         description = VALUES(description),
         price_cents = VALUES(price_cents),
         billing_interval = VALUES(billing_interval),
         monthly_credits = VALUES(monthly_credits),
         trial_days = VALUES(trial_days),
         max_active_jobs = VALUES(max_active_jobs),
         max_daily_runs = VALUES(max_daily_runs),
         features_json = VALUES(features_json),
         enabled = VALUES(enabled)`,
      [
        plan.id, plan.code, plan.name, plan.description ?? "", plan.price_cents, plan.billing_interval,
        plan.monthly_credits, plan.trial_days, plan.max_active_jobs, plan.max_daily_runs,
        JSON.stringify(plan.features ?? {}), plan.enabled ? 1 : 0,
      ],
    );
    const list = await this.listPlans();
    return list.find((p) => p.id === plan.id)!;
  }

  async getUserSubscription(userId: string): Promise<UserSubscriptionRecord | null> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM user_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
      [userId],
    );
    const r = Array.isArray(rows) ? rows[0] : null;
    if (!r) return null;
    return {
      id: String(r.id),
      user_id: String(r.user_id),
      plan_id: String(r.plan_id),
      status: String(r.status) as UserSubscriptionRecord["status"],
      trial_ends_at: toIsoOrNull(r.trial_ends_at),
      current_period_start: toIso(r.current_period_start),
      current_period_end: toIsoOrNull(r.current_period_end),
      cancel_at_period_end: Boolean(r.cancel_at_period_end),
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    };
  }

  async listSubscriptions(): Promise<(UserSubscriptionRecord & { user_email?: string | null; plan_name?: string })[]> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT s.*, u.email AS user_email, p.name AS plan_name
       FROM user_subscriptions s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       ORDER BY s.created_at DESC LIMIT 200`,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      user_id: String(r.user_id),
      plan_id: String(r.plan_id),
      status: String(r.status) as UserSubscriptionRecord["status"],
      trial_ends_at: toIsoOrNull(r.trial_ends_at),
      current_period_start: toIso(r.current_period_start),
      current_period_end: toIsoOrNull(r.current_period_end),
      cancel_at_period_end: Boolean(r.cancel_at_period_end),
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
      user_email: r.user_email ? String(r.user_email) : null,
      plan_name: r.plan_name ? String(r.plan_name) : undefined,
    }));
  }

  async assignSubscription(input: { userId: string; planId: string; status: UserSubscriptionRecord["status"]; trialDays?: number }): Promise<UserSubscriptionRecord> {
    const id = `sub_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 86400_000).toISOString();
    const trialEnds = input.trialDays ? new Date(now.getTime() + input.trialDays * 86400_000).toISOString() : null;
    await this.client.withTransaction(async (tx) => {
      await tx.execute("UPDATE user_subscriptions SET status = 'canceled' WHERE user_id = ? AND status IN ('active','trialing')", [input.userId]);
      await tx.execute(
        `INSERT INTO user_subscriptions (id, user_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, input.userId, input.planId, input.status, toMysqlDate(trialEnds), toMysqlDate(now.toISOString()), toMysqlDate(periodEnd)],
      );
    });
    return (await this.getUserSubscription(input.userId))!;
  }

  async listPayments(filter: { userId?: string; limit?: number } = {}): Promise<PaymentRecord[]> {
    const limit = Math.min(300, Math.max(1, filter.limit ?? 100));
    const where = filter.userId ? "WHERE user_id = ?" : "";
    const params = filter.userId ? [filter.userId] : [];
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM payments ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      params,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      user_id: String(r.user_id),
      subscription_id: r.subscription_id ? String(r.subscription_id) : null,
      amount_cents: Number(r.amount_cents),
      currency: String(r.currency || "USD"),
      status: String(r.status) as PaymentRecord["status"],
      provider_name: String(r.provider_name || "manual"),
      external_payment_id: r.external_payment_id ? String(r.external_payment_id) : null,
      credits_granted: Number(r.credits_granted ?? 0),
      notes: r.notes ? String(r.notes) : null,
      recorded_by_admin_id: r.recorded_by_admin_id ? String(r.recorded_by_admin_id) : null,
      created_at: toIso(r.created_at),
    }));
  }

  async recordPayment(input: Omit<PaymentRecord, "id" | "created_at">): Promise<PaymentRecord> {
    const id = `pay_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    await this.client.execute(
      `INSERT INTO payments (id, user_id, subscription_id, amount_cents, currency, status, provider_name, external_payment_id, credits_granted, notes, recorded_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.user_id, input.subscription_id ?? null, input.amount_cents, input.currency, input.status, input.provider_name, input.external_payment_id ?? null, input.credits_granted, input.notes ?? null, input.recorded_by_admin_id ?? null],
    );
    return { ...input, id, created_at: now };
  }

  // ---------------------------------------------------------------- Notifications, Templates, Announcements, Emails
  async listUserNotifications(userId: string, limit = 50): Promise<NotificationRecord[]> {
    const max = Math.min(200, Math.max(1, limit));
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${max}`,
      [userId],
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      user_id: String(r.user_id),
      sender_admin_id: r.sender_admin_id ? String(r.sender_admin_id) : null,
      title: String(r.title),
      body: String(r.body),
      category: String(r.category || "system"),
      delivery_status: String(r.delivery_status || "delivered") as NotificationRecord["delivery_status"],
      read_at: toIsoOrNull(r.read_at),
      created_at: toIso(r.created_at),
    }));
  }

  async listAllNotifications(limit = 100): Promise<NotificationRecord[]> {
    const max = Math.min(300, Math.max(1, limit));
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM notifications ORDER BY created_at DESC LIMIT ${max}`,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      user_id: String(r.user_id),
      sender_admin_id: r.sender_admin_id ? String(r.sender_admin_id) : null,
      title: String(r.title),
      body: String(r.body),
      category: String(r.category || "system"),
      delivery_status: String(r.delivery_status || "delivered") as NotificationRecord["delivery_status"],
      read_at: toIsoOrNull(r.read_at),
      created_at: toIso(r.created_at),
    }));
  }

  async createNotification(input: Omit<NotificationRecord, "id" | "read_at" | "created_at">): Promise<NotificationRecord> {
    const id = `ntf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    await this.client.execute(
      `INSERT INTO notifications (id, user_id, sender_admin_id, title, body, category, delivery_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.user_id, input.sender_admin_id ?? null, input.title, input.body, input.category, input.delivery_status],
    );
    return { ...input, id, read_at: null, created_at: now };
  }

  async markNotificationRead(userId: string, id?: string): Promise<void> {
    const ts = toMysqlDate(new Date().toISOString());
    if (id) {
      await this.client.execute("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?", [ts, id, userId]);
    } else {
      await this.client.execute("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE user_id = ?", [ts, userId]);
    }
  }

  async listNotificationTemplates(): Promise<NotificationTemplateRecord[]> {
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      "SELECT * FROM notification_templates ORDER BY template_key ASC",
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      template_key: String(r.template_key),
      title_template: String(r.title_template),
      body_template: String(r.body_template),
      channel: String(r.channel || "in_app") as NotificationTemplateRecord["channel"],
      created_by: r.created_by ? String(r.created_by) : null,
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }));
  }

  async upsertNotificationTemplate(tpl: Omit<NotificationTemplateRecord, "created_at" | "updated_at">): Promise<NotificationTemplateRecord> {
    await this.client.execute(
      `INSERT INTO notification_templates (id, template_key, title_template, body_template, channel, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title_template = VALUES(title_template),
         body_template = VALUES(body_template),
         channel = VALUES(channel)`,
      [tpl.id, tpl.template_key, tpl.title_template, tpl.body_template, tpl.channel, tpl.created_by ?? null],
    );
    const list = await this.listNotificationTemplates();
    return list.find((x) => x.id === tpl.id || x.template_key === tpl.template_key)!;
  }

  async listAnnouncements(activeOnly = false): Promise<AnnouncementRecord[]> {
    const where = activeOnly
      ? "WHERE active = 1 AND (starts_at IS NULL OR starts_at <= CURRENT_TIMESTAMP(3)) AND (ends_at IS NULL OR ends_at >= CURRENT_TIMESTAMP(3))"
      : "";
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM announcements ${where} ORDER BY created_at DESC`,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      body: String(r.body),
      severity: String(r.severity || "info") as AnnouncementRecord["severity"],
      active: Boolean(r.active),
      starts_at: toIsoOrNull(r.starts_at),
      ends_at: toIsoOrNull(r.ends_at),
      created_by: r.created_by ? String(r.created_by) : null,
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }));
  }

  async upsertAnnouncement(ann: Omit<AnnouncementRecord, "created_at" | "updated_at">): Promise<AnnouncementRecord> {
    await this.client.execute(
      `INSERT INTO announcements (id, title, body, severity, active, starts_at, ends_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         body = VALUES(body),
         severity = VALUES(severity),
         active = VALUES(active),
         starts_at = VALUES(starts_at),
         ends_at = VALUES(ends_at)`,
      [ann.id, ann.title, ann.body, ann.severity, ann.active ? 1 : 0, toMysqlDate(ann.starts_at), toMysqlDate(ann.ends_at), ann.created_by ?? null],
    );
    const list = await this.listAnnouncements(false);
    return list.find((x) => x.id === ann.id)!;
  }

  async deleteAnnouncement(id: string): Promise<boolean> {
    const [res] = await this.client.execute<{ affectedRows?: number }>("DELETE FROM announcements WHERE id = ?", [id]);
    return Boolean(res?.affectedRows);
  }

  async recordEmailLog(log: Omit<EmailLogRecord, "id" | "created_at">): Promise<EmailLogRecord> {
    const id = `eml_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    await this.client.execute(
      `INSERT INTO email_logs (id, recipient_user_id, recipient_email, subject, template_key, status, error_message, sent_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, log.recipient_user_id ?? null, log.recipient_email, log.subject, log.template_key ?? null, log.status, log.error_message ?? null, log.sent_by_admin_id ?? null],
    );
    return { ...log, id, created_at: now };
  }

  async listEmailLogs(limit = 100): Promise<EmailLogRecord[]> {
    const max = Math.min(300, Math.max(1, limit));
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM email_logs ORDER BY created_at DESC LIMIT ${max}`,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      recipient_user_id: r.recipient_user_id ? String(r.recipient_user_id) : null,
      recipient_email: String(r.recipient_email),
      subject: String(r.subject),
      template_key: r.template_key ? String(r.template_key) : null,
      status: String(r.status) as EmailLogRecord["status"],
      error_message: r.error_message ? String(r.error_message) : null,
      sent_by_admin_id: r.sent_by_admin_id ? String(r.sent_by_admin_id) : null,
      created_at: toIso(r.created_at),
    }));
  }

  // ---------------------------------------------------------------- Settings & Audit Logs
  async listSettings(publicOnly = false): Promise<SystemSettingRecord[]> {
    const where = publicOnly ? "WHERE is_public = 1" : "";
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT * FROM system_settings ${where} ORDER BY setting_key ASC`,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      setting_key: String(r.setting_key),
      setting_value: parseJson(r.setting_value_json, null),
      is_public: Boolean(r.is_public),
      updated_by: r.updated_by ? String(r.updated_by) : null,
      updated_at: toIso(r.updated_at),
    }));
  }

  async setSetting(key: string, value: unknown, isPublic: boolean, updatedBy: string | null): Promise<SystemSettingRecord> {
    await this.client.execute(
      `INSERT INTO system_settings (setting_key, setting_value_json, is_public, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         setting_value_json = VALUES(setting_value_json),
         is_public = VALUES(is_public),
         updated_by = VALUES(updated_by)`,
      [key, JSON.stringify(value), isPublic ? 1 : 0, updatedBy],
    );
    const list = await this.listSettings(false);
    return list.find((s) => s.setting_key === key)!;
  }

  async recordAuditLog(entry: Omit<AuditLogRecord, "id" | "created_at">): Promise<AuditLogRecord> {
    const id = `aud_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    await this.client.execute(
      `INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, details_json, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, entry.admin_user_id ?? null, entry.action, entry.target_type, entry.target_id ?? null, entry.details ? JSON.stringify(entry.details) : null, entry.ip_address ?? null, entry.user_agent ?? null],
    );
    return { ...entry, id, created_at: now };
  }

  async listAuditLogs(filter: { adminUserId?: string; action?: string; limit?: number } = {}): Promise<AuditLogRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.adminUserId) { where.push("a.admin_user_id = ?"); params.push(filter.adminUserId); }
    if (filter.action) { where.push("a.action LIKE ?"); params.push(`%${filter.action}%`); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const max = Math.min(300, Math.max(1, filter.limit ?? 100));
    const [rows] = await this.client.execute<Record<string, unknown>[]>(
      `SELECT a.*, u.email AS admin_email
       FROM admin_audit_logs a LEFT JOIN users u ON u.id = a.admin_user_id
       ${whereSql} ORDER BY a.created_at DESC LIMIT ${max}`,
      params,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id),
      admin_user_id: r.admin_user_id ? String(r.admin_user_id) : null,
      admin_email: r.admin_email ? String(r.admin_email) : null,
      action: String(r.action),
      target_type: String(r.target_type),
      target_id: r.target_id ? String(r.target_id) : null,
      details: parseJson<Record<string, unknown> | null>(r.details_json, null),
      ip_address: r.ip_address ? String(r.ip_address) : null,
      user_agent: r.user_agent ? String(r.user_agent) : null,
      created_at: toIso(r.created_at),
    }));
  }
}
