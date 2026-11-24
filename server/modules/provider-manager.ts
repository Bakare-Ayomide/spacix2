// Centralized server-side AI Provider Manager: encrypted credential resolution, priority/fallback routing,
// live connection testing, model catalog syncing from external provider APIs, and sanitized diagnostics.
import type { App } from "../registry.ts";
import { FalProvider } from "../providers/fal.ts";
import { GenericHttpProvider } from "../providers/generic.ts";
import type { AppProviderBinding, CompiledGeneration, GenerationProvider, JobLike } from "../providers/types.ts";
import { InputError } from "../runner.ts";
import { decryptSecret, encryptSecret, maskSecretHint } from "../security/crypto.ts";
import type { PlatformService } from "./platform-service.ts";
import type { ProviderConfigRecord, ProviderModelRecord } from "./platform-types.ts";

export class ProviderManager {
  private readonly platform: PlatformService;

  constructor(platform: PlatformService) {
    this.platform = platform;
  }

  async resolveSecrets(providerId: string): Promise<Record<string, string>> {
    const creds = await this.platform.store.getProviderCredentials(providerId);
    const out: Record<string, string> = {};
    for (const c of creds) {
      try {
        const decrypted = decryptSecret(c.encrypted_value);
        if (decrypted !== null) out[c.credential_key] = decrypted;
      } catch {
        /* ignore undecryptable secret from rotated runtime key */
      }
    }
    if (providerId === "fal") {
      if (!out.api_key && process.env.FAL_KEY?.trim()) out.api_key = process.env.FAL_KEY.trim();
      if (!out.webhook_secret && process.env.FAL_WEBHOOK_SECRET?.trim()) out.webhook_secret = process.env.FAL_WEBHOOK_SECRET.trim();
    }
    return out;
  }

  async setCredential(providerId: string, credentialKey: string, plainValue: string, updatedBy: string | null): Promise<string> {
    const encrypted = encryptSecret(plainValue);
    const hint = maskSecretHint(plainValue);
    await this.platform.store.setProviderCredential(providerId, credentialKey, encrypted, hint, updatedBy);
    return hint;
  }

  async buildAdapter(providerCfg: ProviderConfigRecord): Promise<GenerationProvider> {
    const secrets = await this.resolveSecrets(providerCfg.id);
    if (providerCfg.adapter_type === "fal" || providerCfg.id === "fal") {
      return new FalProvider({
        apiKey: secrets.api_key ?? "",
        webhookSecret: secrets.webhook_secret ?? "",
        pollIntervalMs: Number(providerCfg.settings?.pollIntervalMs ?? 2000),
      });
    }
    return new GenericHttpProvider({
      id: providerCfg.id,
      name: providerCfg.name,
      adapterType: providerCfg.adapter_type,
      baseUrl: providerCfg.base_url,
      apiKey: secrets.api_key ?? "",
      authScheme: typeof providerCfg.settings?.authScheme === "string" ? providerCfg.settings.authScheme : "Bearer",
    });
  }

  async isProviderReady(providerId: string): Promise<{ ready: boolean; reason: string | null }> {
    const cfg = await this.platform.store.getProvider(providerId);
    if (!cfg) return { ready: false, reason: "Provider is not configured." };
    if (!cfg.enabled) return { ready: false, reason: `${cfg.name} is disabled by administrators.` };
    const adapter = await this.buildAdapter(cfg);
    const st = adapter.status();
    return { ready: st.available, reason: st.reason };
  }

  async listAdminProviders() {
    const all = await this.platform.store.listProviders();
    return Promise.all(all.map(async (p) => {
      const secrets = await this.resolveSecrets(p.id);
      const adapter = await this.buildAdapter(p);
      const st = adapter.status();
      const envFallback = p.id === "fal" && !p.credential_hints.api_key && Boolean(process.env.FAL_KEY?.trim());
      return {
        ...p,
        runtime_configured: st.configured,
        runtime_available: p.enabled && st.available,
        runtime_reason: !p.enabled ? "Disabled by administrator" : st.reason,
        has_api_key: Boolean(secrets.api_key),
        env_key_active: envFallback,
      };
    }));
  }

  async submitWithFallback(args: {
    app: App;
    binding: AppProviderBinding;
    compiled: CompiledGeneration;
    webhookBaseUrl?: string;
  }): Promise<{ job: JobLike; providerId: string; endpoint: string }> {
    const primary = args.binding.provider ? await this.platform.store.getProvider(args.binding.provider) : null;
    if (!primary || !args.binding.endpoint) {
      throw new InputError("No active AI provider is assigned to this application.");
    }

    const candidates: ProviderConfigRecord[] = [];
    if (primary.enabled) candidates.push(primary);
    if (primary.fallback_provider_id) {
      const fb = await this.platform.store.getProvider(primary.fallback_provider_id);
      if (fb && fb.enabled) candidates.push(fb);
    }
    if (!candidates.length) {
      throw new InputError("The assigned AI provider is currently disabled.");
    }

    let lastErr: Error | null = null;
    for (const cfg of candidates) {
      const adapter = await this.buildAdapter(cfg);
      const st = adapter.status();
      if (!st.available) {
        lastErr = new InputError(st.reason || `${cfg.name} is not configured.`);
        continue;
      }
      const t0 = Date.now();
      const binding: AppProviderBinding = {
        ...args.binding,
        provider: cfg.id,
      };
      try {
        const webhookUrl = args.webhookBaseUrl ? `${args.webhookBaseUrl}/api/webhooks/${cfg.id}` : undefined;
        const job = await adapter.submit(args.app, binding, args.compiled, { webhookUrl });
        await this.platform.store.appendProviderLog({
          provider_id: cfg.id,
          endpoint: args.binding.endpoint,
          method: "POST",
          status_code: 202,
          duration_ms: Date.now() - t0,
          ok: true,
          error_message: null,
        });
        return { job, providerId: cfg.id, endpoint: args.binding.endpoint };
      } catch (err) {
        lastErr = err as Error;
        await this.platform.store.appendProviderLog({
          provider_id: cfg.id,
          endpoint: args.binding.endpoint,
          method: "POST",
          status_code: 502,
          duration_ms: Date.now() - t0,
          ok: false,
          error_message: lastErr.message,
        });
      }
    }
    throw lastErr ?? new Error("All configured providers failed to accept the generation request.");
  }

  async testConnection(providerId: string): Promise<{ ok: boolean; status: string; message: string; latencyMs: number }> {
    const cfg = await this.platform.store.getProvider(providerId);
    if (!cfg) throw new InputError(`Unknown provider: ${providerId}`);
    const secrets = await this.resolveSecrets(providerId);
    const t0 = Date.now();

    if (!secrets.api_key) {
      await this.platform.store.updateProviderHealth(providerId, "unconfigured", "API key not configured");
      await this.platform.store.appendProviderLog({
        provider_id: providerId,
        endpoint: "/health-check",
        method: "GET",
        status_code: null,
        duration_ms: Date.now() - t0,
        ok: false,
        error_message: "API key not configured",
      });
      return { ok: false, status: "unconfigured", message: "No API key configured for this provider.", latencyMs: Date.now() - t0 };
    }

    try {
      const testUrl = cfg.adapter_type === "fal" || cfg.id === "fal"
        ? "https://api.fal.ai/v1/models?limit=1"
        : cfg.base_url;
      const headers: Record<string, string> = cfg.adapter_type === "fal" || cfg.id === "fal"
        ? { Authorization: `Key ${secrets.api_key}` }
        : { Authorization: `${String(cfg.settings?.authScheme || "Bearer")} ${secrets.api_key}` };

      const res = await fetch(testUrl, { method: "GET", headers, signal: AbortSignal.timeout(12_000) });
      const latencyMs = Date.now() - t0;
      const ok = res.ok || res.status === 404; // 401/403 means bad credentials; 200-299 means reachable & valid
      const status = res.status === 401 || res.status === 403 ? "auth_error" : res.ok ? "healthy" : `http_${res.status}`;
      const message = res.ok
        ? `Connected to ${cfg.name} (${res.status}) in ${latencyMs} ms`
        : `${cfg.name} responded with HTTP ${res.status}`;

      await this.platform.store.updateProviderHealth(providerId, status, ok ? null : message);
      await this.platform.store.appendProviderLog({
        provider_id: providerId,
        endpoint: testUrl,
        method: "GET",
        status_code: res.status,
        duration_ms: latencyMs,
        ok: res.ok,
        error_message: res.ok ? null : message,
      });
      return { ok: res.ok, status, message, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const msg = (err as Error).message;
      await this.platform.store.updateProviderHealth(providerId, "unreachable", msg);
      await this.platform.store.appendProviderLog({
        provider_id: providerId,
        endpoint: cfg.base_url || "/",
        method: "GET",
        status_code: null,
        duration_ms: latencyMs,
        ok: false,
        error_message: msg,
      });
      return { ok: false, status: "unreachable", message: msg, latencyMs };
    }
  }

  async syncModelsFromProvider(providerId: string): Promise<{ fetched: number; synced: ProviderModelRecord[]; source: string }> {
    const cfg = await this.platform.store.getProvider(providerId);
    if (!cfg) throw new InputError(`Unknown provider: ${providerId}`);
    const secrets = await this.resolveSecrets(providerId);
    const t0 = Date.now();

    if (cfg.adapter_type === "fal" || cfg.id === "fal") {
      if (!secrets.api_key) {
        throw new InputError("Configure a valid fal.ai API key before fetching live models from fal.ai.");
      }
      const res = await fetch("https://api.fal.ai/v1/models?limit=40", {
        headers: { Authorization: `Key ${secrets.api_key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        await this.platform.store.appendProviderLog({
          provider_id: providerId,
          endpoint: "https://api.fal.ai/v1/models",
          method: "GET",
          status_code: res.status,
          duration_ms: Date.now() - t0,
          ok: false,
          error_message: `HTTP ${res.status}: ${text.slice(0, 180)}`,
        });
        throw new Error(`fal.ai model API returned HTTP ${res.status}`);
      }
      const data = (await res.json()) as { models?: Array<{ endpoint_id?: string; metadata?: { display_name?: string; description?: string; category?: string; thumbnail_url?: string } }> };
      const remoteList = Array.isArray(data.models) ? data.models : [];
      const synced: ProviderModelRecord[] = [];
      for (const item of remoteList) {
        if (!item.endpoint_id) continue;
        const mId = `${providerId}:${item.endpoint_id}`.slice(0, 128);
        const existing = await this.platform.store.getModel(mId);
        const cat = String(item.metadata?.category || existing?.category || "image").toLowerCase();
        const category = cat.includes("video") ? "video" : cat.includes("audio") ? "audio" : "image";
        const capability = category === "video" ? "image-to-video" : category === "audio" ? "text-to-audio" : "text-to-image";
        const saved = await this.platform.store.upsertModel({
          id: mId,
          provider_id: providerId,
          endpoint: item.endpoint_id,
          display_name: item.metadata?.display_name || existing?.display_name || item.endpoint_id,
          description: item.metadata?.description || existing?.description || "",
          category,
          capability: existing?.capability || capability,
          source: "provider_api",
          enabled: existing ? existing.enabled : true,
          is_default: existing ? existing.is_default : false,
          fallback_model_id: existing?.fallback_model_id ?? null,
          thumbnail_url: item.metadata?.thumbnail_url || existing?.thumbnail_url || null,
          internal_cost_usd: existing?.internal_cost_usd ?? null,
          credit_price: existing?.credit_price ?? (category === "video" ? 5 : category === "audio" ? 2 : 1),
          allowed_roles: existing?.allowed_roles ?? [],
          allowed_plans: existing?.allowed_plans ?? [],
          capabilities: existing?.capabilities ?? { category },
          parameters: existing?.parameters ?? [],
        });
        synced.push(saved);
      }
      await this.platform.store.appendProviderLog({
        provider_id: providerId,
        endpoint: "https://api.fal.ai/v1/models",
        method: "GET",
        status_code: res.status,
        duration_ms: Date.now() - t0,
        ok: true,
        error_message: null,
      });
      return { fetched: synced.length, synced, source: "provider_api" };
    }

    throw new InputError(`Automatic model discovery is not supported by adapter "${cfg.adapter_type}". Add models manually.`);
  }

  async getFalProvider(): Promise<FalProvider> {
    const cfg = await this.platform.store.getProvider("fal");
    const secrets = await this.resolveSecrets("fal");
    return new FalProvider({
      apiKey: secrets.api_key ?? "",
      webhookSecret: secrets.webhook_secret ?? "",
      pollIntervalMs: Number(cfg?.settings?.pollIntervalMs ?? 2000),
    });
  }

  async getJobForResume(providerId: string, jobId: string, endpoint: string): Promise<JobLike> {
    const cfg = await this.platform.store.getProvider(providerId);
    if (!cfg) throw new Error(`Provider ${providerId} not registered`);
    const adapter = await this.buildAdapter(cfg);
    return adapter.getJob(jobId, endpoint);
  }
}
