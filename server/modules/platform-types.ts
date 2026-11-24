// Domain types for SPACIX multi-user SaaS platform, RBAC, providers, models, studios, billing, and audit logs.

export type UserStatus = "active" | "suspended" | "deactivated";

export type RoleRecord = {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
  is_admin_role: boolean;
  permissions: string[];
  created_at: string;
  updated_at: string;
};

export type PermissionRecord = {
  id: string;
  module_name: string;
  description: string;
};

export type UserRecord = {
  id: string;
  visitor_key: string | null;
  email: string | null;
  password_hash: string | null;
  display_name: string;
  status: UserStatus;
  email_verified: boolean;
  email_verified_at: string | null;
  is_admin: boolean;
  account_restrictions: Record<string, unknown> | null;
  roles: string[];
  permissions: string[];
  profile: {
    avatar_url: string | null;
    company: string | null;
    bio: string | null;
    locale: string;
    timezone: string;
  };
  credit_balance: number;
  subscription_plan_id: string | null;
  last_login_at: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionRecord = {
  id: string;
  user_id: string;
  token_hash: string;
  is_admin: boolean;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string;
  created_at: string;
};

export type LoginHistoryRecord = {
  id: string;
  user_id: string | null;
  email: string;
  success: boolean;
  failure_reason: string | null;
  is_admin_portal: boolean;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

export type TokenRecord = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_by_admin_id: string | null;
  created_at: string;
};

export type ProviderConfigRecord = {
  id: string;
  name: string;
  adapter_type: "fal" | "runware" | "http" | string;
  enabled: boolean;
  priority: number;
  fallback_provider_id: string | null;
  base_url: string;
  supported_endpoints: string[];
  settings: Record<string, unknown>;
  health_status: string;
  last_tested_at: string | null;
  last_error: string | null;
  credential_hints: Record<string, string>;
  created_at: string;
  updated_at: string;
};

export type ProviderCredentialRecord = {
  id: string;
  provider_id: string;
  credential_key: string;
  encrypted_value: string;
  key_hint: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ProviderLogRecord = {
  id: string;
  provider_id: string;
  endpoint: string;
  method: string;
  status_code: number | null;
  duration_ms: number;
  ok: boolean;
  error_message: string | null;
  created_at: string;
};

export type ModelParameterSpec = {
  id: string;
  model_id: string;
  param_key: string;
  param_type: string;
  label: string;
  default_value: unknown;
  constraints: Record<string, unknown>;
  required: boolean;
  sort_order: number;
};

export type ProviderModelRecord = {
  id: string;
  provider_id: string;
  endpoint: string;
  display_name: string;
  description: string;
  category: string;
  capability: string;
  source: "provider_api" | "manual" | "manifest";
  enabled: boolean;
  is_default: boolean;
  fallback_model_id: string | null;
  thumbnail_url: string | null;
  internal_cost_usd: number | null;
  credit_price: number;
  allowed_roles: string[];
  allowed_plans: string[];
  capabilities: Record<string, unknown>;
  parameters: ModelParameterSpec[];
  created_at: string;
  updated_at: string;
};

export type StudioAppConfigRecord = {
  id: string;
  section: "image" | "video" | "audio" | "utility";
  name: string;
  summary: string;
  thumbnail_url: string | null;
  enabled: boolean;
  studio_enabled: boolean;
  maintenance_mode: boolean;
  credit_cost: number;
  allowed_roles: string[];
  allowed_plans: string[];
  presets_override: Record<string, unknown>[] | null;
  settings_override: Record<string, unknown> | null;
  published: boolean;
  model_ids: string[];
  primary_model_id: string | null;
  updated_by: string | null;
  updated_at: string;
};

export type FeatureFlagRecord = {
  flag_key: string;
  enabled: boolean;
  description: string;
  rules: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string;
};

export type ProjectRecord = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
};

export type CreditTransactionRecord = {
  id: string;
  user_id: string;
  generation_id: string | null;
  admin_user_id: string | null;
  tx_type: "grant" | "deduct" | "refund" | "purchase" | "subscription" | "usage";
  delta: number;
  balance_after: number;
  reason: string;
  reference_id: string | null;
  created_at: string;
};

export type SubscriptionPlanRecord = {
  id: string;
  code: string;
  name: string;
  description: string;
  price_cents: number;
  billing_interval: "month" | "year" | "one_time";
  monthly_credits: number;
  trial_days: number;
  max_active_jobs: number;
  max_daily_runs: number | null;
  features: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type UserSubscriptionRecord = {
  id: string;
  user_id: string;
  plan_id: string;
  status: "active" | "trialing" | "past_due" | "canceled" | "paused";
  trial_ends_at: string | null;
  current_period_start: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
  updated_at: string;
};

export type PaymentRecord = {
  id: string;
  user_id: string;
  subscription_id: string | null;
  amount_cents: number;
  currency: string;
  status: "pending" | "confirmed" | "failed" | "refunded";
  provider_name: string;
  external_payment_id: string | null;
  credits_granted: number;
  notes: string | null;
  recorded_by_admin_id: string | null;
  created_at: string;
};

export type NotificationRecord = {
  id: string;
  user_id: string;
  sender_admin_id: string | null;
  title: string;
  body: string;
  category: string;
  delivery_status: "pending" | "delivered" | "failed";
  read_at: string | null;
  created_at: string;
};

export type NotificationTemplateRecord = {
  id: string;
  template_key: string;
  title_template: string;
  body_template: string;
  channel: "in_app" | "email" | "both";
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AnnouncementRecord = {
  id: string;
  title: string;
  body: string;
  severity: "info" | "feature" | "warning" | "maintenance";
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type EmailLogRecord = {
  id: string;
  recipient_user_id: string | null;
  recipient_email: string;
  subject: string;
  template_key: string | null;
  status: "queued" | "sent" | "failed" | "unconfigured";
  error_message: string | null;
  sent_by_admin_id: string | null;
  created_at: string;
};

export type SystemSettingRecord = {
  setting_key: string;
  setting_value: unknown;
  is_public: boolean;
  updated_by: string | null;
  updated_at: string;
};

export type AuditLogRecord = {
  id: string;
  admin_user_id: string | null;
  admin_email?: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

export type GenerationRecord = {
  id: string;
  user_id: string;
  project_id: string | null;
  app_id: string;
  provider_id: string | null;
  provider_endpoint?: string | null;
  provider_job_id?: string | null;
  model_id: string | null;
  media_type: "image" | "video" | "audio";
  status: string;
  prompt: string | null;
  preset_id: string | null;
  settings: Record<string, unknown>;
  inputs: { id: string; type: string; file: string; name: string }[];
  outputs: { file: string; type: string; name: string; node: string; url?: string }[];
  error: { message: string; class_type?: string | null; node?: string | null } | null;
  credits_charged: number;
  moderation_status: "clean" | "flagged" | "removed";
  moderation_note: string | null;
  seconds: number | null;
  total_seconds: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};
