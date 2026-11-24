// Platform Service facade: picks MySQL or persistent DiskPlatformStore, syncs app & model catalog,
// and exposes unified settings/flags/access resolution without leaking infrastructure to non-admin clients.
import type { Entry } from "../history.ts";
import type { MySqlClient } from "../db/client.ts";
import { bindingForApp } from "../providers/app-mapping.ts";
import type { App } from "../registry.ts";
import { DiskPlatformStore } from "./disk-store.ts";
import { MySqlPlatformStore } from "./mysql-store.ts";
import type {
  FeatureFlagRecord,
  GenerationRecord,
  ProviderModelRecord,
  StudioAppConfigRecord,
  UserRecord,
} from "./platform-types.ts";
import type { PlatformStore } from "./store-interface.ts";

export class PlatformService {
  private readonly diskStore: DiskPlatformStore;
  private readonly mysqlStore: MySqlPlatformStore | null;
  private readonly mysql: MySqlClient | null;
  private activeStore: PlatformStore;
  private initialized = false;
  private catalogApps: readonly App[] = [];

  constructor(opts: { mysql?: MySqlClient | null; stateFilePath: string }) {
    this.mysql = opts.mysql ?? null;
    this.diskStore = new DiskPlatformStore(opts.stateFilePath);
    this.mysqlStore = this.mysql && this.mysql.configured ? new MySqlPlatformStore(this.mysql) : null;
    this.activeStore = this.diskStore;
  }

  get store(): PlatformStore {
    return this.activeStore;
  }

  get engine(): "mysql" | "local-fallback" {
    return this.activeStore.engine;
  }

  async init(apps: readonly App[]): Promise<void> {
    this.catalogApps = apps;
    await this.diskStore.init();
    if (this.mysql && this.mysql.configured && this.mysqlStore) {
      try {
        await this.mysqlStore.init();
        this.activeStore = this.mysqlStore;
      } catch (err) {
        console.warn(`[platform] MySQL unavailable (${(err as Error).message}); using local-fallback store`);
        this.activeStore = this.diskStore;
      }
    } else {
      this.activeStore = this.diskStore;
    }
    await this.syncCatalog(apps);
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized;
  }

  async syncCatalog(apps: readonly App[]): Promise<void> {
    this.catalogApps = apps;
    const store = this.store;
    const existingModels = await store.listModels();
    const existingApps = await store.listStudioApps();
    const modelMap = new Map(existingModels.map((m) => [m.id, m]));
    const appMap = new Map(existingApps.map((a) => [a.id, a]));

    // Seed manifest models that don't yet exist without clobbering admin edits
    for (const app of apps) {
      const binding = bindingForApp(app);
      let modelId: string | null = null;
      if (binding.supported && binding.provider && binding.endpoint) {
        modelId = `${binding.provider}:${binding.endpoint}`.slice(0, 128);
        if (!modelMap.has(modelId)) {
          const created = await store.upsertModel({
            id: modelId,
            provider_id: binding.provider,
            endpoint: binding.endpoint,
            display_name: binding.modelName || binding.endpoint,
            description: `${binding.capability} model`,
            category: app.section,
            capability: binding.capability,
            source: "manifest",
            enabled: true,
            is_default: false,
            fallback_model_id: null,
            thumbnail_url: null,
            internal_cost_usd: null,
            credit_price: app.section === "video" ? 5 : app.section === "audio" ? 2 : 1,
            allowed_roles: [],
            allowed_plans: [],
            capabilities: { capability: binding.capability },
            parameters: [],
          });
          modelMap.set(modelId, created);
        }
      }

      if (!appMap.has(app.id)) {
        const cfg: StudioAppConfigRecord = {
          id: app.id,
          section: app.section,
          name: app.name,
          summary: app.summary ?? "",
          thumbnail_url: null,
          enabled: true,
          studio_enabled: true,
          maintenance_mode: false,
          credit_cost: app.section === "video" ? 5 : app.section === "audio" ? 2 : 1,
          allowed_roles: [],
          allowed_plans: [],
          presets_override: null,
          settings_override: null,
          published: true,
          model_ids: modelId ? [modelId] : [],
          primary_model_id: modelId,
          updated_by: null,
          updated_at: new Date().toISOString(),
        };
        await store.upsertStudioApp(cfg);
        appMap.set(app.id, cfg);
      }
    }
  }

  async getSettingsMap(publicOnly = false): Promise<Record<string, unknown>> {
    const list = await this.store.listSettings(publicOnly);
    const out: Record<string, unknown> = {};
    for (const s of list) out[s.setting_key] = s.setting_value;
    return out;
  }

  async getFlagsMap(): Promise<Record<string, FeatureFlagRecord>> {
    const list = await this.store.listFeatureFlags();
    const out: Record<string, FeatureFlagRecord> = {};
    for (const f of list) out[f.flag_key] = f;
    return out;
  }

  async isFlagEnabled(key: string, fallback = false): Promise<boolean> {
    const flags = await this.getFlagsMap();
    return flags[key] ? flags[key].enabled : fallback;
  }

  async getPublicBootstrap(user: UserRecord | null) {
    const settings = await this.getSettingsMap(true);
    const flags = await this.getFlagsMap();
    const announcements = await this.store.listAnnouncements(true);
    const adminCount = await this.store.countAdmins();
    const plans = await this.store.listPlans(true);

    return {
      platform_name: String(settings.platform_name || "SPACIX"),
      platform_tagline: String(settings.platform_tagline || "Cloud AI Creative Studio"),
      logo_url: String(settings.logo_url || "https://spacix.ticketplaster.com/brand/logo.png"),
      registration_enabled: Boolean(flags.registration_enabled?.enabled ?? settings.registration_enabled ?? true),
      require_email_verification: Boolean(flags.require_email_verification?.enabled ?? settings.require_email_verification ?? false),
      guest_browsing_enabled: Boolean(flags.guest_browsing_enabled?.enabled ?? settings.allow_guest_preview ?? true),
      credit_billing_enabled: Boolean(flags.credit_billing_enabled?.enabled ?? true),
      maintenance_mode: Boolean(flags.maintenance_mode?.enabled ?? settings.maintenance_mode ?? false),
      maintenance_message: String(settings.maintenance_message || "Scheduled maintenance in progress."),
      terms_url: String(settings.terms_url || ""),
      privacy_url: String(settings.privacy_url || ""),
      credit_packages: Array.isArray(settings.credit_packages) ? settings.credit_packages : [],
      needs_admin_bootstrap: adminCount === 0,
      announcements,
      plans,
      user: user ? sanitizeUserForClient(user) : null,
    };
  }

  async resolveAppExecution(app: App, user: UserRecord | null, modelIdOverride?: string | null): Promise<{
    allowed: boolean;
    reason: string | null;
    providerId: string | null;
    endpoint: string | null;
    capability: string;
    modelId: string | null;
    modelName: string | null;
    creditCost: number;
    studioCfg: StudioAppConfigRecord | null;
    model: ProviderModelRecord | null;
  }> {
    const flags = await this.getFlagsMap();
    const settings = await this.getSettingsMap(false);
    const studioCfg = await this.store.getStudioApp(app.id);
    const binding = bindingForApp(app);

    const isAdmin = Boolean(user?.is_admin);
    const maintenanceOn = Boolean(flags.maintenance_mode?.enabled ?? settings.maintenance_mode) || Boolean(studioCfg?.maintenance_mode);
    if (maintenanceOn && !isAdmin) {
      return {
        allowed: false,
        reason: String(settings.maintenance_message || "This studio is temporarily under maintenance."),
        providerId: null,
        endpoint: null,
        capability: binding.capability,
        modelId: null,
        modelName: null,
        creditCost: 0,
        studioCfg,
        model: null,
      };
    }

    if (studioCfg && (!studioCfg.published || !studioCfg.enabled || !studioCfg.studio_enabled)) {
      return {
        allowed: false,
        reason: !studioCfg.studio_enabled
          ? `The ${app.section} studio is currently disabled by administrators.`
          : "This creative tool is currently disabled.",
        providerId: null,
        endpoint: null,
        capability: binding.capability,
        modelId: null,
        modelName: null,
        creditCost: studioCfg.credit_cost,
        studioCfg,
        model: null,
      };
    }

    // Role & plan gating
    if (studioCfg?.allowed_roles?.length) {
      const userRoles = new Set(user?.roles ?? []);
      if (!isAdmin && !studioCfg.allowed_roles.some((r) => userRoles.has(r))) {
        return {
          allowed: false,
          reason: "Your account role does not have access to this application.",
          providerId: null,
          endpoint: null,
          capability: binding.capability,
          modelId: null,
          modelName: null,
          creditCost: studioCfg.credit_cost,
          studioCfg,
          model: null,
        };
      }
    }
    if (studioCfg?.allowed_plans?.length) {
      const planId = user?.subscription_plan_id;
      if (!isAdmin && (!planId || !studioCfg.allowed_plans.includes(planId))) {
        return {
          allowed: false,
          reason: "Upgrade your subscription plan to access this application.",
          providerId: null,
          endpoint: null,
          capability: binding.capability,
          modelId: null,
          modelName: null,
          creditCost: studioCfg.credit_cost,
          studioCfg,
          model: null,
        };
      }
    }

    // Pick configured model (override -> studio primary -> studio list -> fallback manifest binding)
    const models = await this.store.listModels();
    const modelMap = new Map(models.map((m) => [m.id, m]));
    let picked: ProviderModelRecord | null = null;
    if (modelIdOverride && studioCfg?.model_ids?.includes(modelIdOverride)) {
      picked = modelMap.get(modelIdOverride) ?? null;
    }
    if (!picked && studioCfg?.primary_model_id) {
      picked = modelMap.get(studioCfg.primary_model_id) ?? null;
    }
    if (!picked && studioCfg?.model_ids?.length) {
      for (const mid of studioCfg.model_ids) {
        const candidate = modelMap.get(mid);
        if (candidate?.enabled) { picked = candidate; break; }
      }
    }

    const providerId = picked?.provider_id ?? binding.provider;
    const endpoint = picked?.endpoint ?? binding.endpoint;
    const capability = picked?.capability ?? binding.capability;
    const modelName = picked?.display_name ?? binding.modelName;
    const creditCost = studioCfg?.credit_cost ?? picked?.credit_price ?? Number(settings.default_generation_cost ?? 1);

    if (picked && !picked.enabled) {
      return {
        allowed: false,
        reason: "The assigned AI model for this application is currently disabled.",
        providerId,
        endpoint,
        capability,
        modelId: picked.id,
        modelName,
        creditCost,
        studioCfg,
        model: picked,
      };
    }

    return {
      allowed: Boolean(binding.supported || picked),
      reason: binding.supported || picked ? null : (binding.unavailableReason || "Cloud generation is unavailable for this app."),
      providerId,
      endpoint,
      capability,
      modelId: picked?.id ?? null,
      modelName,
      creditCost: Math.max(0, Math.trunc(creditCost)),
      studioCfg,
      model: picked,
    };
  }

  async syncHistoryEntry(entry: Entry, meta: { userId?: string; modelId?: string | null; creditsCharged?: number } = {}): Promise<void> {
    const app = this.catalogApps.find((a) => a.id === entry.app);
    let userId = meta.userId || (entry.owner?.startsWith("usr_") ? entry.owner : null);
    if (!userId) {
      const vis = await this.store.ensureVisitorUser(entry.owner || "local-owner");
      userId = vis.id;
    }
    const mediaType: "image" | "video" | "audio" =
      entry.outputs?.[0]?.type === "video" || app?.section === "video"
        ? "video"
        : entry.outputs?.[0]?.type === "audio" || app?.section === "audio"
          ? "audio"
          : "image";

    const promptText =
      typeof entry.values?.prompt === "string"
        ? entry.values.prompt
        : typeof entry.values?.instruction === "string"
          ? entry.values.instruction
          : null;

    const record: GenerationRecord = {
      id: entry.id,
      user_id: userId,
      project_id: entry.project_id ?? null,
      app_id: entry.app,
      provider_id: entry.provider ?? null,
      provider_endpoint: entry.provider_endpoint ?? null,
      provider_job_id: entry.job ?? null,
      model_id: meta.modelId ?? null,
      media_type: mediaType,
      status: entry.status,
      prompt: promptText,
      preset_id: entry.preset,
      settings: entry.values ?? {},
      inputs: entry.inputs ?? [],
      outputs: entry.outputs ?? [],
      error: entry.error ?? null,
      credits_charged: meta.creditsCharged ?? 0,
      moderation_status: "clean",
      moderation_note: null,
      seconds: entry.seconds,
      total_seconds: entry.total,
      created_at: entry.created,
      started_at: entry.started,
      finished_at: entry.finished,
    };
    await this.store.syncGeneration(record);
  }
}

export function sanitizeUserForClient(u: UserRecord) {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    status: u.status,
    email_verified: u.email_verified,
    is_admin: u.is_admin,
    roles: u.roles,
    permissions: u.is_admin ? u.permissions : [],
    profile: u.profile,
    credit_balance: u.credit_balance,
    subscription_plan_id: u.subscription_plan_id,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
  };
}
