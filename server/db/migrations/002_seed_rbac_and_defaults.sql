-- Migration 002: Seed RBAC roles, granular permissions, default feature flags, plans, and platform settings.

INSERT IGNORE INTO roles (id, name, description, is_system, is_admin_role) VALUES
  ('super_admin', 'Super Admin', 'Complete platform control including role and permission management.', 1, 1),
  ('admin', 'Admin', 'General platform administration across users, studios, content, and settings.', 1, 1),
  ('moderator', 'Moderator', 'User moderation, generation review, and announcement management.', 1, 1),
  ('support', 'Support', 'User assistance, account verification, password recovery, and basic diagnostics.', 1, 1),
  ('finance_manager', 'Finance Manager', 'Credits, pricing, subscription plans, and payment record management.', 1, 1),
  ('technical_manager', 'Technical Manager', 'AI provider connections, model catalog, and application infrastructure.', 1, 1),
  ('user', 'Member', 'Standard creative studio user account.', 1, 0);

INSERT IGNORE INTO permissions (id, module_name, description) VALUES
  ('overview.read', 'overview', 'View dashboard overview analytics and health metrics'),
  ('users.read', 'users', 'View user profiles, sessions, and activity'),
  ('users.write', 'users', 'Create, edit, verify, and manage users'),
  ('users.suspend', 'users', 'Suspend, deactivate, or delete user accounts'),
  ('admins.read', 'admins', 'View administrator accounts and roles'),
  ('admins.write', 'admins', 'Create, edit, and suspend administrator accounts'),
  ('roles.manage', 'roles', 'Create custom roles and edit granular role permissions'),
  ('providers.read', 'providers', 'View AI providers, endpoints, and connection status'),
  ('providers.write', 'providers', 'Configure AI providers, encrypted credentials, priorities, and fallbacks'),
  ('models.read', 'models', 'View AI models and parameters'),
  ('models.write', 'models', 'Sync, create, edit, enable/disable, and price AI models'),
  ('studios.read', 'studios', 'View studio applications and feature availability'),
  ('studios.write', 'studios', 'Manage studios, applications, presets, and maintenance mode'),
  ('generations.read', 'generations', 'View generation queue, prompts, outputs, and errors'),
  ('generations.manage', 'generations', 'Retry, cancel, moderate, and delete generations'),
  ('credits.read', 'credits', 'View credit wallets, transactions, and payment records'),
  ('credits.write', 'credits', 'Assign, deduct, refund credits and configure packages/pricing'),
  ('subscriptions.manage', 'subscriptions', 'Configure subscription plans and assign user subscriptions'),
  ('notifications.send', 'notifications', 'Send notifications, emails, templates, and announcements'),
  ('auth.sessions.read', 'auth', 'View login history, active sessions, and registrations'),
  ('auth.sessions.revoke', 'auth', 'Revoke sessions and configure authentication policies'),
  ('settings.read', 'settings', 'View system settings and platform configuration'),
  ('settings.write', 'settings', 'Edit platform branding, email, storage, and security settings'),
  ('audit.read', 'audit', 'View administrative audit logs');

-- Super Admin gets all permissions
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'super_admin', id FROM permissions;

-- Admin gets all operational permissions except roles.manage
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'admin', id FROM permissions WHERE id <> 'roles.manage';

-- Moderator
INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('moderator', 'overview.read'),
  ('moderator', 'users.read'),
  ('moderator', 'users.suspend'),
  ('moderator', 'generations.read'),
  ('moderator', 'generations.manage'),
  ('moderator', 'notifications.send'),
  ('moderator', 'auth.sessions.read');

-- Support
INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('support', 'overview.read'),
  ('support', 'users.read'),
  ('support', 'users.write'),
  ('support', 'generations.read'),
  ('support', 'credits.read'),
  ('support', 'notifications.send'),
  ('support', 'auth.sessions.read'),
  ('support', 'auth.sessions.revoke');

-- Finance Manager
INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('finance_manager', 'overview.read'),
  ('finance_manager', 'users.read'),
  ('finance_manager', 'credits.read'),
  ('finance_manager', 'credits.write'),
  ('finance_manager', 'subscriptions.manage'),
  ('finance_manager', 'generations.read');

-- Technical Manager
INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('technical_manager', 'overview.read'),
  ('technical_manager', 'providers.read'),
  ('technical_manager', 'providers.write'),
  ('technical_manager', 'models.read'),
  ('technical_manager', 'models.write'),
  ('technical_manager', 'studios.read'),
  ('technical_manager', 'studios.write'),
  ('technical_manager', 'generations.read'),
  ('technical_manager', 'generations.manage'),
  ('technical_manager', 'settings.read'),
  ('technical_manager', 'settings.write');

-- Default feature flags
INSERT IGNORE INTO feature_flags (flag_key, enabled, description) VALUES
  ('maintenance_mode', 0, 'Temporarily restrict studio generations to administrators during maintenance'),
  ('registration_enabled', 1, 'Allow new user registrations on the platform'),
  ('require_email_verification', 0, 'Require email verification before running generations'),
  ('guest_browsing_enabled', 1, 'Allow unauthenticated visitors to explore studio examples before signing in'),
  ('credit_billing_enabled', 1, 'Enforce per-generation credit wallet deductions');

-- Default subscription plans
INSERT IGNORE INTO subscription_plans (id, code, name, description, price_cents, billing_interval, monthly_credits, trial_days, max_active_jobs, max_daily_runs, enabled) VALUES
  ('plan_free', 'free', 'Starter', 'For exploring SPACIX creative studios with monthly starter credits.', 0, 'month', 25, 0, 2, 20, 1),
  ('plan_pro', 'pro', 'Creator Pro', 'For regular creators generating images, video, and audio at higher concurrency.', 2900, 'month', 500, 7, 5, 250, 1),
  ('plan_studio', 'studio', 'Studio Team', 'For production teams needing priority queue access and high monthly volume.', 9900, 'month', 2500, 7, 12, 1000, 1);

-- Default system settings
INSERT IGNORE INTO system_settings (setting_key, setting_value_json, is_public) VALUES
  ('platform_name', '"SPACIX"', 1),
  ('platform_tagline', '"Cloud AI Creative Studio"', 1),
  ('logo_url', '"https://spacix.ticketplaster.com/brand/logo.png"', 1),
  ('registration_enabled', 'true', 1),
  ('require_email_verification', 'false', 1),
  ('maintenance_mode', 'false', 1),
  ('maintenance_message', '"SPACIX is undergoing scheduled maintenance. Please check back shortly."', 1),
  ('default_signup_credits', '25', 0),
  ('default_generation_cost', '1', 0),
  ('allow_guest_preview', 'true', 1),
  ('terms_url', '""', 1),
  ('privacy_url', '""', 1),
  ('email_config', '{"enabled":false,"host":"","port":587,"user":"","from":"","secure":false}', 0),
  ('storage_config', '{"driver":"local","maxUploadMb":100}', 0);

-- Default fal.ai provider record
INSERT IGNORE INTO providers (id, name, adapter_type, enabled, priority, base_url, supported_endpoints_json) VALUES
  ('fal', 'fal.ai', 'fal', 1, 10, 'https://queue.fal.run', '["fal-ai/flux/schnell","fal-ai/flux-kontext/pro","fal-ai/flux-general/inpainting","fal-ai/clarity-upscaler","fal-ai/birefnet","fal-ai/imageutils/depth","fal-ai/kling-video/v1.6/standard/text-to-video","fal-ai/kling-video/v1.6/standard/image-to-video","fal-ai/sync-lipsync","fal-ai/video-upscaler","fal-ai/birefnet/video","fal-ai/minimax-music","fal-ai/mmaudio-v2"]');
