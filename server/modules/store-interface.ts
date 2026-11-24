// Unified PlatformStore interface implemented by MySQL and the local disk fallback.
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

export interface PlatformStore {
  readonly engine: "mysql" | "local-fallback";
  init(): Promise<void>;

  // Roles & Permissions
  listPermissions(): Promise<PermissionRecord[]>;
  listRoles(): Promise<RoleRecord[]>;
  getRole(id: string): Promise<RoleRecord | null>;
  upsertRole(role: Omit<RoleRecord, "created_at" | "updated_at">): Promise<RoleRecord>;
  deleteRole(id: string): Promise<boolean>;

  // Users & Profiles
  countUsers(): Promise<number>;
  countAdmins(): Promise<number>;
  listUsers(filter?: {
    search?: string;
    role?: string;
    status?: UserStatus;
    isAdmin?: boolean;
    limit?: number;
    offset?: number;
    sort?: string;
  }): Promise<{ users: UserRecord[]; total: number }>;
  getUserById(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  ensureVisitorUser(visitorKey?: string): Promise<UserRecord>;
  createUser(input: {
    id?: string;
    email: string;
    passwordHash: string;
    displayName: string;
    isAdmin?: boolean;
    emailVerified?: boolean;
    roles?: string[];
    initialCredits?: number;
    planId?: string | null;
  }): Promise<UserRecord>;
  updateUser(id: string, patch: {
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
  }): Promise<UserRecord | null>;
  deleteUser(id: string): Promise<boolean>;

  // Sessions & Auth History & Tokens
  createSession(input: { userId: string; tokenHash: string; isAdmin: boolean; ipAddress?: string | null; userAgent?: string | null; expiresAt: string }): Promise<SessionRecord>;
  getSessionByTokenHash(tokenHash: string): Promise<{ session: SessionRecord; user: UserRecord } | null>;
  touchSession(sessionId: string): Promise<void>;
  listSessions(filter?: { userId?: string; activeOnly?: boolean; limit?: number }): Promise<(SessionRecord & { user_email?: string | null; display_name?: string })[]>;
  revokeSession(sessionId: string): Promise<boolean>;
  revokeUserSessions(userId: string): Promise<number>;

  recordLoginAttempt(input: { userId: string | null; email: string; success: boolean; failureReason?: string | null; isAdminPortal?: boolean; ipAddress?: string | null; userAgent?: string | null }): Promise<void>;
  listLoginHistory(filter?: { userId?: string; success?: boolean; search?: string; limit?: number }): Promise<LoginHistoryRecord[]>;

  createEmailVerification(userId: string, tokenHash: string, expiresAt: string): Promise<TokenRecord>;
  consumeEmailVerification(tokenHash: string): Promise<UserRecord | null>;
  createPasswordReset(userId: string, tokenHash: string, expiresAt: string, adminUserId?: string | null): Promise<TokenRecord>;
  consumePasswordReset(tokenHash: string, newPasswordHash: string): Promise<UserRecord | null>;

  // Providers & Encrypted Credentials & Logs
  listProviders(): Promise<ProviderConfigRecord[]>;
  getProvider(id: string): Promise<ProviderConfigRecord | null>;
  upsertProvider(input: Omit<ProviderConfigRecord, "created_at" | "updated_at" | "credential_hints">): Promise<ProviderConfigRecord>;
  updateProviderHealth(id: string, status: string, lastError: string | null): Promise<void>;
  deleteProvider(id: string): Promise<boolean>;
  setProviderCredential(providerId: string, key: string, encryptedValue: string, keyHint: string, updatedBy: string | null): Promise<void>;
  getProviderCredentials(providerId: string): Promise<ProviderCredentialRecord[]>;
  appendProviderLog(log: Omit<ProviderLogRecord, "id" | "created_at">): Promise<void>;
  listProviderLogs(providerId?: string, limit?: number): Promise<ProviderLogRecord[]>;

  // Models & Parameters
  listModels(filter?: { providerId?: string; category?: string; enabledOnly?: boolean }): Promise<ProviderModelRecord[]>;
  getModel(id: string): Promise<ProviderModelRecord | null>;
  upsertModel(model: Omit<ProviderModelRecord, "created_at" | "updated_at">): Promise<ProviderModelRecord>;
  deleteModel(id: string): Promise<boolean>;

  // Studio Applications & Feature Flags
  listStudioApps(): Promise<StudioAppConfigRecord[]>;
  getStudioApp(id: string): Promise<StudioAppConfigRecord | null>;
  upsertStudioApp(cfg: StudioAppConfigRecord): Promise<StudioAppConfigRecord>;
  setStudioSectionEnabled(section: "image" | "video" | "audio" | "utility", enabled: boolean, updatedBy: string | null): Promise<void>;
  listFeatureFlags(): Promise<FeatureFlagRecord[]>;
  upsertFeatureFlag(flag: Omit<FeatureFlagRecord, "updated_at">): Promise<FeatureFlagRecord>;

  // Projects & Generations
  listProjects(userId: string): Promise<ProjectRecord[]>;
  createProject(userId: string, name: string, description?: string): Promise<ProjectRecord>;
  syncGeneration(gen: GenerationRecord): Promise<void>;
  listGenerations(filter?: { userId?: string; appId?: string; providerId?: string; mediaType?: string; status?: string; search?: string; dateFrom?: string; dateTo?: string; limit?: number; offset?: number }): Promise<{ generations: GenerationRecord[]; total: number }>;
  getGeneration(id: string): Promise<GenerationRecord | null>;
  updateGenerationModeration(id: string, moderationStatus: "clean" | "flagged" | "removed", note?: string | null): Promise<GenerationRecord | null>;
  deleteGenerationRecord(id: string): Promise<boolean>;

  // Credits, Subscriptions & Payments
  getCreditSummary(userId: string): Promise<{ balance: number; lifetime_granted: number; lifetime_spent: number; transactions: CreditTransactionRecord[] }>;
  listAllTransactions(filter?: { userId?: string; limit?: number }): Promise<CreditTransactionRecord[]>;
  adjustCredits(input: {
    userId: string;
    delta: number;
    txType: CreditTransactionRecord["tx_type"];
    reason: string;
    generationId?: string | null;
    adminUserId?: string | null;
    referenceId?: string | null;
  }): Promise<{ balance: number; transaction: CreditTransactionRecord }>;

  listPlans(enabledOnly?: boolean): Promise<SubscriptionPlanRecord[]>;
  upsertPlan(plan: Omit<SubscriptionPlanRecord, "created_at" | "updated_at">): Promise<SubscriptionPlanRecord>;
  getUserSubscription(userId: string): Promise<UserSubscriptionRecord | null>;
  listSubscriptions(): Promise<(UserSubscriptionRecord & { user_email?: string | null; plan_name?: string })[]>;
  assignSubscription(input: { userId: string; planId: string; status: UserSubscriptionRecord["status"]; trialDays?: number }): Promise<UserSubscriptionRecord>;
  listPayments(filter?: { userId?: string; limit?: number }): Promise<PaymentRecord[]>;
  recordPayment(input: Omit<PaymentRecord, "id" | "created_at">): Promise<PaymentRecord>;

  // Notifications, Templates, Announcements, Email Logs
  listUserNotifications(userId: string, limit?: number): Promise<NotificationRecord[]>;
  listAllNotifications(limit?: number): Promise<NotificationRecord[]>;
  createNotification(input: Omit<NotificationRecord, "id" | "read_at" | "created_at">): Promise<NotificationRecord>;
  markNotificationRead(userId: string, id?: string): Promise<void>;

  listNotificationTemplates(): Promise<NotificationTemplateRecord[]>;
  upsertNotificationTemplate(tpl: Omit<NotificationTemplateRecord, "created_at" | "updated_at">): Promise<NotificationTemplateRecord>;

  listAnnouncements(activeOnly?: boolean): Promise<AnnouncementRecord[]>;
  upsertAnnouncement(ann: Omit<AnnouncementRecord, "created_at" | "updated_at">): Promise<AnnouncementRecord>;
  deleteAnnouncement(id: string): Promise<boolean>;

  recordEmailLog(log: Omit<EmailLogRecord, "id" | "created_at">): Promise<EmailLogRecord>;
  listEmailLogs(limit?: number): Promise<EmailLogRecord[]>;

  // System Settings & Audit Logs
  listSettings(publicOnly?: boolean): Promise<SystemSettingRecord[]>;
  setSetting(key: string, value: unknown, isPublic: boolean, updatedBy: string | null): Promise<SystemSettingRecord>;
  recordAuditLog(entry: Omit<AuditLogRecord, "id" | "created_at">): Promise<AuditLogRecord>;
  listAuditLogs(filter?: { adminUserId?: string; action?: string; limit?: number }): Promise<AuditLogRecord[]>;
}
