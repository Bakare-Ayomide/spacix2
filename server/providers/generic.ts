// Configurable HTTP / Runware-compatible external AI provider adapter.
// Supports Admin-configured external REST inference endpoints with encrypted API keys and SSRF checks.
import type { App } from "../registry.ts";
import { InputError } from "../runner.ts";
import type {
  AppProviderBinding,
  CompiledGeneration,
  GenerationProvider,
  JobEvent,
  JobLike,
  JobOutput,
  ProviderStatus,
} from "./types.ts";

function validateExternalHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InputError(`Invalid provider base URL: ${raw}`);
  }
  if (u.protocol !== "https:") {
    throw new InputError("External AI provider base URLs must use HTTPS.");
  }
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("169.254.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new InputError(`Blocked restricted host for external provider: ${host}`);
  }
  return u;
}

export class GenericHttpProvider implements GenerationProvider {
  readonly id: string;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly authScheme: string;
  private readonly doFetch: typeof fetch;
  private readonly adapterType: string;

  constructor(opts: {
    id: string;
    name: string;
    adapterType?: string;
    baseUrl: string;
    apiKey: string;
    authScheme?: string;
    fetch?: typeof fetch;
  }) {
    this.id = opts.id;
    this.name = opts.name;
    this.adapterType = opts.adapterType || "http";
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey.trim();
    this.authScheme = opts.authScheme || "Bearer";
    this.doFetch = opts.fetch ?? fetch;
  }

  status(): ProviderStatus {
    const configured = Boolean(this.baseUrl && this.apiKey);
    return {
      id: this.id,
      name: this.name,
      configured,
      available: configured,
      reason: configured ? null : `${this.name} requires both a Base URL and API Key in Provider Management.`,
      capabilities: ["text-to-image", "image-to-image", "text-to-video", "image-to-video", "text-to-audio"],
      webhookConfigured: false,
      endpointCount: 0,
      baseUrl: this.baseUrl,
    };
  }

  supports(binding: AppProviderBinding): boolean {
    return binding.supported && binding.provider === this.id && Boolean(binding.endpoint);
  }

  async submit(
    _app: App,
    binding: AppProviderBinding,
    compiled: CompiledGeneration,
    opts: { signal?: AbortSignal } = {},
  ): Promise<JobLike> {
    if (!this.baseUrl || !this.apiKey) {
      throw new InputError(`${this.name} is not configured with credentials.`);
    }
    const base = validateExternalHttpsUrl(this.baseUrl);
    const endpoint = (binding.endpoint || "").replace(/^\//, "");
    const targetUrl = new URL(`${base.toString().replace(/\/$/, "")}/${endpoint}`);
    if (targetUrl.hostname !== base.hostname) {
      throw new InputError("Endpoint path escaped configured provider host.");
    }

    const bodyPayload: Record<string, unknown> = {
      prompt: compiled.prompt,
      ...(compiled.negativePrompt ? { negative_prompt: compiled.negativePrompt } : {}),
      ...(compiled.aspectRatio ? { aspect_ratio: compiled.aspectRatio } : {}),
      ...(compiled.width ? { width: compiled.width } : {}),
      ...(compiled.height ? { height: compiled.height } : {}),
      ...(compiled.seed !== null ? { seed: compiled.seed } : {}),
      ...(compiled.steps !== null ? { steps: compiled.steps } : {}),
      ...(compiled.duration !== null ? { duration: compiled.duration } : {}),
      ...(this.adapterType === "runware" ? { model: endpoint, positivePrompt: compiled.prompt } : {}),
    };

    const res = await this.doFetch(targetUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${this.authScheme} ${this.apiKey}`,
      },
      body: JSON.stringify(bodyPayload),
      signal: opts.signal ?? AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`${this.name} rejected request (${res.status}): ${errText.slice(0, 240)}`);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const extId = String(data.request_id || data.id || data.taskUUID || `ext_${Date.now()}`);
    const imageUrl =
      typeof data.url === "string"
        ? data.url
        : Array.isArray(data.images) && typeof (data.images[0] as { url?: unknown })?.url === "string"
          ? String((data.images[0] as { url: string }).url)
          : Array.isArray(data.data) && typeof (data.data[0] as { imageURL?: unknown; url?: unknown })?.imageURL === "string"
            ? String((data.data[0] as { imageURL: string }).imageURL)
            : null;

    if (imageUrl) {
      const parsedOut = validateExternalHttpsUrl(imageUrl);
      const outputs: JobOutput[] = [
        {
          id: "output-0",
          name: "output-1.png",
          type: "image",
          nodeId: "out",
          contentType: "image/png",
          url: parsedOut.toString(),
          toBytes: async () => {
            const imgRes = await this.doFetch(parsedOut.toString(), { signal: AbortSignal.timeout(60_000) });
            if (!imgRes.ok) throw new Error(`Failed fetching generated media (${imgRes.status})`);
            return new Uint8Array(await imgRes.arrayBuffer());
          },
        },
      ];
      const now = new Date();
      return {
        id: extId,
        provider: this.id,
        endpoint,
        status: "succeeded",
        outputs,
        error: null,
        startedAt: now,
        completedAt: now,
        progress: null,
        queuePosition: null,
        async *events(): AsyncIterable<JobEvent> {
          yield { kind: "statusChange", status: "succeeded", queuePosition: null };
        },
        async wait() { return; },
        async cancel() { return; },
      };
    }

    throw new Error(`${this.name} returned an unsupported async job format (missing media URL).`);
  }

  async getJob(_externalId: string, _endpoint: string): Promise<JobLike> {
    throw new Error(`Resuming in-flight jobs is not supported on ${this.name} adapter.`);
  }
}
