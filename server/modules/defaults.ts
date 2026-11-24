// Seed RBAC roles, permissions, feature flags, plans, settings, and provider defaults.
import type {
  FeatureFlagRecord,
  PermissionRecord,
  ProviderConfigRecord,
  RoleRecord,
  SubscriptionPlanRecord,
} from "./platform-types.ts";

export const DEFAULT_PERMISSIONS: PermissionRecord[] = [
  { id: "overview.read", module_name: "overview", description: "View dashboard overview analytics and health metrics" },
  { id: "users.read", module_name: "users", description: "View user profiles, sessions, and activity" },
  { id: "users.write", module_name: "users", description: "Create, edit, verify, and manage users" },
  { id: "users.suspend", module_name: "users", description: "Suspend, deactivate, or delete user accounts" },
  { id: "admins.read", module_name: "admins", description: "View administrator accounts and roles" },
  { id: "admins.write", module_name: "admins", description: "Create, edit, and suspend administrator accounts" },
  { id: "roles.manage", module_name: "roles", description: "Create custom roles and edit granular role permissions" },
  { id: "providers.read", module_name: "providers", description: "View AI providers, endpoints, and connection status" },
  { id: "providers.write", module_name: "providers", description: "Configure AI providers, encrypted credentials, priorities, and fallbacks" },
  { id: "models.read", module_name: "models", description: "View AI models and parameters" },
  { id: "models.write", module_name: "models", description: "Sync, create, edit, enable/disable, and price AI models" },
  { id: "studios.read", module_name: "studios", description: "View studio applications and feature availability" },
  { id: "studios.write", module_name: "studios", description: "Manage studios, applications, presets, and maintenance mode" },
  { id: "generations.read", module_name: "generations", description: "View generation queue, prompts, outputs, and errors" },
  { id: "generations.manage", module_name: "generations", description: "Retry, cancel, moderate, and delete generations" },
  { id: "credits.read", module_name: "credits", description: "View credit wallets, transactions, and payment records" },
  { id: "credits.write", module_name: "credits", description: "Assign, deduct, refund credits and configure packages/pricing" },
  { id: "subscriptions.manage", module_name: "subscriptions", description: "Configure subscription plans and assign user subscriptions" },
  { id: "notifications.send", module_name: "notifications", description: "Send notifications, emails, templates, and announcements" },
  { id: "auth.sessions.read", module_name: "auth", description: "View login history, active sessions, and registrations" },
  { id: "auth.sessions.revoke", module_name: "auth", description: "Revoke sessions and configure authentication policies" },
  { id: "settings.read", module_name: "settings", description: "View system settings and platform configuration" },
  { id: "settings.write", module_name: "settings", description: "Edit platform branding, email, storage, and security settings" },
  { id: "audit.read", module_name: "audit", description: "View administrative audit logs" },
];

const ALL_PERM_IDS = DEFAULT_PERMISSIONS.map((p) => p.id);
const NOW = () => new Date().toISOString();

export function defaultRoles(): RoleRecord[] {
  const ts = NOW();
  return [
    {
      id: "super_admin",
      name: "Super Admin",
      description: "Complete platform control including role and permission management.",
      is_system: true,
      is_admin_role: true,
      permissions: [...ALL_PERM_IDS],
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "admin",
      name: "Admin",
      description: "General platform administration across users, studios, content, and settings.",
      is_system: true,
      is_admin_role: true,
      permissions: ALL_PERM_IDS.filter((p) => p !== "roles.manage"),
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "moderator",
      name: "Moderator",
      description: "User moderation, generation review, and announcement management.",
      is_system: true,
      is_admin_role: true,
      permissions: [
        "overview.read", "users.read", "users.suspend",
        "generations.read", "generations.manage", "notifications.send", "auth.sessions.read",
      ],
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "support",
      name: "Support",
      description: "User assistance, account verification, password recovery, and basic diagnostics.",
      is_system: true,
      is_admin_role: true,
      permissions: [
        "overview.read", "users.read", "users.write",
        "generations.read", "credits.read", "notifications.send", "auth.sessions.read", "auth.sessions.revoke",
      ],
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "finance_manager",
      name: "Finance Manager",
      description: "Credits, pricing, subscription plans, and payment record management.",
      is_system: true,
      is_admin_role: true,
      permissions: ["overview.read", "users.read", "credits.read", "credits.write", "subscriptions.manage", "generations.read"],
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "technical_manager",
      name: "Technical Manager",
      description: "AI provider connections, model catalog, and application infrastructure.",
      is_system: true,
      is_admin_role: true,
      permissions: [
        "overview.read", "providers.read", "providers.write", "models.read", "models.write",
        "studios.read", "studios.write", "generations.read", "generations.manage", "settings.read", "settings.write",
      ],
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "user",
      name: "Member",
      description: "Standard creative studio user account.",
      is_system: true,
      is_admin_role: false,
      permissions: [],
      created_at: ts,
      updated_at: ts,
    },
  ];
}

export function defaultFlags(): FeatureFlagRecord[] {
  const ts = NOW();
  return [
    { flag_key: "maintenance_mode", enabled: false, description: "Temporarily restrict studio generations to administrators during maintenance", rules: {}, updated_by: null, updated_at: ts },
    { flag_key: "registration_enabled", enabled: true, description: "Allow new user registrations on the platform", rules: {}, updated_by: null, updated_at: ts },
    { flag_key: "require_email_verification", enabled: false, description: "Require email verification before running generations", rules: {}, updated_by: null, updated_at: ts },
    { flag_key: "guest_browsing_enabled", enabled: true, description: "Allow unauthenticated visitors to explore studio examples before signing in", rules: {}, updated_by: null, updated_at: ts },
    { flag_key: "credit_billing_enabled", enabled: true, description: "Enforce per-generation credit wallet deductions", rules: {}, updated_by: null, updated_at: ts },
  ];
}

export function defaultPlans(): SubscriptionPlanRecord[] {
  const ts = NOW();
  return [
    {
      id: "plan_free",
      code: "free",
      name: "Starter",
      description: "For exploring SPACIX creative studios with monthly starter credits.",
      price_cents: 0,
      billing_interval: "month",
      monthly_credits: 25,
      trial_days: 0,
      max_active_jobs: 2,
      max_daily_runs: 20,
      features: { image: true, video: true, audio: true, priority_queue: false },
      enabled: true,
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "plan_pro",
      code: "pro",
      name: "Creator Pro",
      description: "For regular creators generating images, video, and audio at higher concurrency.",
      price_cents: 2900,
      billing_interval: "month",
      monthly_credits: 500,
      trial_days: 7,
      max_active_jobs: 5,
      max_daily_runs: 250,
      features: { image: true, video: true, audio: true, priority_queue: true },
      enabled: true,
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "plan_studio",
      code: "studio",
      name: "Studio Team",
      description: "For production teams needing priority queue access and high monthly volume.",
      price_cents: 9900,
      billing_interval: "month",
      monthly_credits: 2500,
      trial_days: 7,
      max_active_jobs: 12,
      max_daily_runs: 1000,
      features: { image: true, video: true, audio: true, priority_queue: true, commercial_rights: true },
      enabled: true,
      created_at: ts,
      updated_at: ts,
    },
  ];
}

export const DEFAULT_SYSTEM_SETTINGS: Record<string, { value: unknown; is_public: boolean }> = {
  platform_name: { value: "SPACIX", is_public: true },
  platform_tagline: { value: "Cloud AI Creative Studio", is_public: true },
  logo_url: { value: "https://spacix.ticketplaster.com/brand/logo.png", is_public: true },
  registration_enabled: { value: true, is_public: true },
  require_email_verification: { value: false, is_public: true },
  maintenance_mode: { value: false, is_public: true },
  maintenance_message: { value: "SPACIX is undergoing scheduled maintenance. Please check back shortly.", is_public: true },
  default_signup_credits: { value: 25, is_public: false },
  default_generation_cost: { value: 1, is_public: false },
  allow_guest_preview: { value: true, is_public: true },
  credit_packages: {
    value: [
      { id: "pkg_100", name: "100 Credits", credits: 100, price_cents: 900 },
      { id: "pkg_500", name: "500 Credits", credits: 500, price_cents: 3900 },
      { id: "pkg_2000", name: "2,000 Credits", credits: 2000, price_cents: 12900 },
    ],
    is_public: true,
  },
  terms_url: { value: "", is_public: true },
  privacy_url: { value: "", is_public: true },
  email_config: { value: { enabled: false, host: "", port: 587, user: "", from: "", secure: false }, is_public: false },
  storage_config: { value: { driver: "local", maxUploadMb: 100 }, is_public: false },
  security_config: { value: { sessionTtlHours: 168, maxFailedLogins: 10, requireStrongPasswords: true }, is_public: false },
};

export function defaultProviders(): ProviderConfigRecord[] {
  const ts = NOW();
  return [
    {
      id: "fal",
      name: "fal.ai",
      adapter_type: "fal",
      enabled: true,
      priority: 10,
      fallback_provider_id: null,
      base_url: "https://queue.fal.run",
      supported_endpoints: [
        "fal-ai/flux/schnell",
        "fal-ai/flux-kontext/pro",
        "fal-ai/flux-general/inpainting",
        "fal-ai/clarity-upscaler",
        "fal-ai/birefnet",
        "fal-ai/imageutils/depth",
        "fal-ai/kling-video/v1.6/standard/text-to-video",
        "fal-ai/kling-video/v1.6/standard/image-to-video",
        "fal-ai/sync-lipsync",
        "fal-ai/video-upscaler",
        "fal-ai/birefnet/video",
        "fal-ai/minimax-music",
        "fal-ai/mmaudio-v2",
      ],
      settings: { timeoutMs: 120_000, pollIntervalMs: 2000 },
      health_status: "untested",
      last_tested_at: null,
      last_error: null,
      credential_hints: {},
      created_at: ts,
      updated_at: ts,
    },
  ];
}
