-- Migration 001: Complete SPACIX Multi-User SaaS MySQL 8+ / MariaDB 10.6+ Schema
-- Compatible with cPanel MySQL / MariaDB deployments.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  visitor_key VARCHAR(128) NULL UNIQUE,
  email VARCHAR(255) NULL UNIQUE,
  password_hash VARCHAR(255) NULL,
  display_name VARCHAR(120) NOT NULL DEFAULT 'Studio User',
  status ENUM('active','suspended','deactivated') NOT NULL DEFAULT 'active',
  email_verified TINYINT(1) NOT NULL DEFAULT 0,
  email_verified_at DATETIME(3) NULL,
  is_admin TINYINT(1) NOT NULL DEFAULT 0,
  account_restrictions_json JSON NULL,
  last_login_at DATETIME(3) NULL,
  last_active_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_users_status (status),
  INDEX idx_users_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id VARCHAR(64) PRIMARY KEY,
  avatar_url VARCHAR(512) NULL,
  company VARCHAR(160) NULL,
  bio VARCHAR(500) NULL,
  locale VARCHAR(16) NOT NULL DEFAULT 'en',
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  preferences_json JSON NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS roles (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  description VARCHAR(255) NOT NULL DEFAULT '',
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  is_admin_role TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  id VARCHAR(80) PRIMARY KEY,
  module_name VARCHAR(64) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_perm_module (module_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id VARCHAR(64) NOT NULL,
  permission_id VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_perm FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id VARCHAR(64) NOT NULL,
  role_id VARCHAR(64) NOT NULL,
  assigned_by VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, role_id),
  INDEX idx_ur_role (role_id),
  CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ur_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_ur_assigner FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_usess_user (user_id, revoked_at),
  INDEX idx_usess_exp (expires_at),
  CONSTRAINT fk_usess_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id VARCHAR(64) PRIMARY KEY,
  admin_user_id VARCHAR(64) NOT NULL,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_asess_user (admin_user_id, revoked_at),
  INDEX idx_asess_exp (expires_at),
  CONSTRAINT fk_asess_user FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_history (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NULL,
  email VARCHAR(255) NOT NULL,
  success TINYINT(1) NOT NULL,
  failure_reason VARCHAR(160) NULL,
  is_admin_portal TINYINT(1) NOT NULL DEFAULT 0,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_lh_user_created (user_id, created_at),
  INDEX idx_lh_email_created (email, created_at),
  INDEX idx_lh_success_created (success, created_at),
  CONSTRAINT fk_lh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_verifications (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  verified_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_ev_user (user_id),
  CONSTRAINT fk_ev_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_resets (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_by_admin_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_pr_user (user_id),
  CONSTRAINT fk_pr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_pr_admin FOREIGN KEY (created_by_admin_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS providers (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  adapter_type VARCHAR(64) NOT NULL DEFAULT 'fal',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  priority INT NOT NULL DEFAULT 100,
  fallback_provider_id VARCHAR(64) NULL,
  base_url VARCHAR(512) NOT NULL DEFAULT '',
  supported_endpoints_json JSON NULL,
  settings_json JSON NULL,
  health_status VARCHAR(48) NOT NULL DEFAULT 'untested',
  last_tested_at DATETIME(3) NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_prov_enabled_prio (enabled, priority),
  CONSTRAINT fk_prov_fallback FOREIGN KEY (fallback_provider_id) REFERENCES providers(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_credentials (
  id VARCHAR(64) PRIMARY KEY,
  provider_id VARCHAR(64) NOT NULL,
  credential_key VARCHAR(80) NOT NULL,
  encrypted_value TEXT NOT NULL,
  key_hint VARCHAR(32) NOT NULL DEFAULT '',
  updated_by VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_prov_cred (provider_id, credential_key),
  CONSTRAINT fk_pcred_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  CONSTRAINT fk_pcred_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provider_models (
  id VARCHAR(128) PRIMARY KEY,
  provider_id VARCHAR(64) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  category VARCHAR(64) NOT NULL DEFAULT 'image',
  capability VARCHAR(64) NOT NULL DEFAULT 'text-to-image',
  source ENUM('provider_api','manual','manifest') NOT NULL DEFAULT 'manual',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  fallback_model_id VARCHAR(128) NULL,
  thumbnail_url VARCHAR(512) NULL,
  internal_cost_usd DECIMAL(10, 6) NULL,
  credit_price INT NOT NULL DEFAULT 1,
  allowed_roles_json JSON NULL,
  allowed_plans_json JSON NULL,
  capabilities_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_prov_endpoint (provider_id, endpoint),
  INDEX idx_pm_cat_enabled (category, enabled),
  CONSTRAINT fk_pm_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  CONSTRAINT fk_pm_fallback FOREIGN KEY (fallback_model_id) REFERENCES provider_models(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS model_parameters (
  id VARCHAR(64) PRIMARY KEY,
  model_id VARCHAR(128) NOT NULL,
  param_key VARCHAR(80) NOT NULL,
  param_type VARCHAR(32) NOT NULL DEFAULT 'string',
  label VARCHAR(120) NOT NULL,
  default_value_json JSON NULL,
  constraints_json JSON NULL,
  required TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_mp_key (model_id, param_key),
  CONSTRAINT fk_mp_model FOREIGN KEY (model_id) REFERENCES provider_models(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS studio_applications (
  id VARCHAR(80) PRIMARY KEY,
  section ENUM('image','video','audio','utility') NOT NULL DEFAULT 'image',
  name VARCHAR(160) NOT NULL,
  summary VARCHAR(500) NOT NULL DEFAULT '',
  thumbnail_url VARCHAR(512) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  studio_enabled TINYINT(1) NOT NULL DEFAULT 1,
  maintenance_mode TINYINT(1) NOT NULL DEFAULT 0,
  credit_cost INT NOT NULL DEFAULT 1,
  allowed_roles_json JSON NULL,
  allowed_plans_json JSON NULL,
  presets_override_json JSON NULL,
  settings_override_json JSON NULL,
  published TINYINT(1) NOT NULL DEFAULT 1,
  updated_by VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_sa_section_enabled (section, enabled, published),
  CONSTRAINT fk_sa_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS application_models (
  application_id VARCHAR(80) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  priority INT NOT NULL DEFAULT 100,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (application_id, model_id),
  CONSTRAINT fk_am_app FOREIGN KEY (application_id) REFERENCES studio_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_am_model FOREIGN KEY (model_id) REFERENCES provider_models(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feature_flags (
  flag_key VARCHAR(80) PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  description VARCHAR(255) NOT NULL DEFAULT '',
  rules_json JSON NULL,
  updated_by VARCHAR(64) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ff_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_projects (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_uproj_user (user_id),
  CONSTRAINT fk_uproj_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_generations (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64) NULL,
  app_id VARCHAR(80) NOT NULL,
  provider_id VARCHAR(64) NULL,
  model_id VARCHAR(128) NULL,
  media_type ENUM('image','video','audio') NOT NULL DEFAULT 'image',
  status ENUM('starting','queued','running','succeeded','failed','canceled','expired','lost') NOT NULL DEFAULT 'starting',
  prompt TEXT NULL,
  preset_id VARCHAR(80) NULL,
  settings_json JSON NOT NULL,
  error_json JSON NULL,
  credits_charged INT NOT NULL DEFAULT 0,
  moderation_status ENUM('clean','flagged','removed') NOT NULL DEFAULT 'clean',
  moderation_note VARCHAR(500) NULL,
  seconds DOUBLE NULL,
  total_seconds DOUBLE NULL,
  created_at DATETIME(3) NOT NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  INDEX idx_ug_user_created (user_id, created_at),
  INDEX idx_ug_app_created (app_id, created_at),
  INDEX idx_ug_status_created (status, created_at),
  INDEX idx_ug_mod (moderation_status),
  CONSTRAINT fk_ug_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ug_project FOREIGN KEY (project_id) REFERENCES user_projects(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS generation_jobs (
  id VARCHAR(64) PRIMARY KEY,
  generation_id VARCHAR(64) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  provider_endpoint VARCHAR(255) NOT NULL,
  external_job_id VARCHAR(160) NULL,
  status ENUM('queued','running','succeeded','failed','canceled','expired') NOT NULL DEFAULT 'queued',
  attempt_number INT NOT NULL DEFAULT 1,
  request_payload_json JSON NULL,
  response_summary_json JSON NULL,
  error_message TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_gj_gen (generation_id),
  INDEX idx_gj_ext (external_job_id),
  CONSTRAINT fk_gj_gen FOREIGN KEY (generation_id) REFERENCES user_generations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS generation_inputs (
  id VARCHAR(64) PRIMARY KEY,
  generation_id VARCHAR(64) NOT NULL,
  input_key VARCHAR(80) NOT NULL,
  media_type ENUM('image','video','audio') NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  storage_path VARCHAR(512) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_gi_gen (generation_id),
  CONSTRAINT fk_gi_gen FOREIGN KEY (generation_id) REFERENCES user_generations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS generation_outputs (
  id VARCHAR(64) PRIMARY KEY,
  generation_id VARCHAR(64) NOT NULL,
  media_type ENUM('image','video','audio') NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  storage_path VARCHAR(512) NOT NULL,
  remote_url VARCHAR(1024) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_go_gen (generation_id),
  CONSTRAINT fk_go_gen FOREIGN KEY (generation_id) REFERENCES user_generations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS media_assets (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NULL,
  generation_id VARCHAR(64) NOT NULL,
  role ENUM('input','output') NOT NULL,
  input_id VARCHAR(80) NULL,
  media_type ENUM('image','video','audio') NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  local_path VARCHAR(512) NULL,
  remote_url VARCHAR(1024) NULL,
  mime_type VARCHAR(120) NULL,
  byte_size BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_ma_generation (generation_id),
  INDEX idx_ma_user (user_id),
  CONSTRAINT fk_ma_generation FOREIGN KEY (generation_id) REFERENCES user_generations(id) ON DELETE CASCADE,
  CONSTRAINT fk_ma_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credit_wallets (
  user_id VARCHAR(64) PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 0,
  lifetime_granted BIGINT NOT NULL DEFAULT 0,
  lifetime_spent BIGINT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_cw_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credit_transactions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  generation_id VARCHAR(64) NULL,
  admin_user_id VARCHAR(64) NULL,
  tx_type ENUM('grant','deduct','refund','purchase','subscription','usage') NOT NULL DEFAULT 'usage',
  delta BIGINT NOT NULL,
  balance_after BIGINT NOT NULL DEFAULT 0,
  reason VARCHAR(200) NOT NULL,
  reference_id VARCHAR(128) NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_ct_user_created (user_id, created_at),
  CONSTRAINT fk_ct_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ct_gen FOREIGN KEY (generation_id) REFERENCES user_generations(id) ON DELETE SET NULL,
  CONSTRAINT fk_ct_admin FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subscription_plans (
  id VARCHAR(64) PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  price_cents INT NOT NULL DEFAULT 0,
  billing_interval ENUM('month','year','one_time') NOT NULL DEFAULT 'month',
  monthly_credits INT NOT NULL DEFAULT 0,
  trial_days INT NOT NULL DEFAULT 0,
  max_active_jobs INT NOT NULL DEFAULT 2,
  max_daily_runs INT NULL,
  features_json JSON NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  plan_id VARCHAR(64) NOT NULL,
  status ENUM('active','trialing','past_due','canceled','paused') NOT NULL DEFAULT 'active',
  trial_ends_at DATETIME(3) NULL,
  current_period_start DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  current_period_end DATETIME(3) NULL,
  cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_usub_user_status (user_id, status),
  CONSTRAINT fk_usub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_usub_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  subscription_id VARCHAR(64) NULL,
  amount_cents INT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  status ENUM('pending','confirmed','failed','refunded') NOT NULL DEFAULT 'pending',
  provider_name VARCHAR(64) NOT NULL DEFAULT 'manual',
  external_payment_id VARCHAR(160) NULL UNIQUE,
  credits_granted INT NOT NULL DEFAULT 0,
  notes VARCHAR(500) NULL,
  recorded_by_admin_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_pay_user_created (user_id, created_at),
  CONSTRAINT fk_pay_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_pay_sub FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id) ON DELETE SET NULL,
  CONSTRAINT fk_pay_admin FOREIGN KEY (recorded_by_admin_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notification_templates (
  id VARCHAR(64) PRIMARY KEY,
  template_key VARCHAR(80) NOT NULL UNIQUE,
  title_template VARCHAR(200) NOT NULL,
  body_template TEXT NOT NULL,
  channel ENUM('in_app','email','both') NOT NULL DEFAULT 'in_app',
  created_by VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_nt_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  sender_admin_id VARCHAR(64) NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  category VARCHAR(48) NOT NULL DEFAULT 'system',
  delivery_status ENUM('pending','delivered','failed') NOT NULL DEFAULT 'delivered',
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_notif_user_read (user_id, read_at, created_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notif_admin FOREIGN KEY (sender_admin_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS announcements (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  severity ENUM('info','feature','warning','maintenance') NOT NULL DEFAULT 'info',
  active TINYINT(1) NOT NULL DEFAULT 1,
  starts_at DATETIME(3) NULL,
  ends_at DATETIME(3) NULL,
  created_by VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_ann_active_window (active, starts_at, ends_at),
  CONSTRAINT fk_ann_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_logs (
  id VARCHAR(64) PRIMARY KEY,
  recipient_user_id VARCHAR(64) NULL,
  recipient_email VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  template_key VARCHAR(80) NULL,
  status ENUM('queued','sent','failed','unconfigured') NOT NULL DEFAULT 'unconfigured',
  error_message VARCHAR(500) NULL,
  sent_by_admin_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_el_created (created_at),
  CONSTRAINT fk_el_user FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_el_admin FOREIGN KEY (sent_by_admin_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key VARCHAR(80) PRIMARY KEY,
  setting_value_json JSON NOT NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 0,
  updated_by VARCHAR(64) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ss_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  admin_user_id VARCHAR(64) NULL,
  action VARCHAR(120) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(128) NULL,
  details_json JSON NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_aal_admin_created (admin_user_id, created_at),
  INDEX idx_aal_action_created (action, created_at),
  CONSTRAINT fk_aal_admin FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
