// fal.ai cloud generation provider adapter (Queue API, Storage Upload API, Status Polling, Webhooks).
// Keeps FAL_KEY strictly on the server and enforces HTTPS allowlisted media URLs to prevent SSRF.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { App } from "../registry.ts";
import { InputError, type FileValue } from "../runner.ts";
import type {
  AppProviderBinding,
  Capability,
  CompiledGeneration,
  GenerationProvider,
  JobEvent,
  JobLike,
  JobOutput,
  ProviderStatus,
  WebhookUpdate,
} from "./types.ts";

const QUEUE_BASE = "https://queue.fal.run";
const UPLOAD_INITIATE_URL = "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";

const FAL_CAPABILITIES: Capability[] = [
  "text-to-image",
  "image-to-image",
  "inpaint",
  "upscale",
  "background-removal",
  "depth",
  "text-to-video",
  "image-to-video",
  "lip-sync",
  "video-upscale",
  "video-background-removal",
  "video-extend",
  "text-to-audio",
];

function isAllowedMediaUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return (
      host === "fal.media" ||
      host.endsWith(".fal.media") ||
      host === "fal.run" ||
      host.endsWith(".fal.run") ||
      host === "fal.ai" ||
      host.endsWith(".fal.ai")
    );
  } catch {
    return false;
  }
}

function isAllowedEndpoint(endpoint: string): boolean {
  return /^[a-z0-9-]+(?:\/[a-z0-9._-]+)+$/i.test(endpoint);
}

function imageSizeFromCompiled(compiled: CompiledGeneration): { width: number; height: number } | string | undefined {
  if (compiled.width && compiled.height) {
    return { width: compiled.width, height: compiled.height };
  }
  const ar = compiled.aspectRatio;
  if (!ar) return undefined;
  const map: Record<string, string> = {
    "1:1": "square_hd",
    "16:9": "landscape_16_9",
    "9:16": "portrait_16_9",
    "4:3": "landscape_4_3",
    "3:4": "portrait_4_3",
  };
  return map[ar] ?? undefined;
}

function normalizeUrlList(outputs: JobOutput[], doFetch: typeof fetch): JobOutput[] {
  return outputs.map((o) => ({
    ...o,
    toBytes: async () => {
      if (!o.url || !isAllowedMediaUrl(o.url)) {
        throw new Error(`Refused untrusted media URL for ${o.name}`);
      }
      const res = await doFetch(o.url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`Failed downloading output ${o.name}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  }));
}

export function extractFalOutputs(payload: Record<string, unknown>, doFetch: typeof fetch): JobOutput[] {
  const raw: JobOutput[] = [];
  const pushFile = (obj: unknown, fallbackType: "image" | "video" | "audio", idx: number) => {
    if (!obj || typeof obj !== "object") return;
    const rec = obj as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url : null;
    if (!url || !isAllowedMediaUrl(url)) return;
    const contentType = typeof rec.content_type === "string"
      ? rec.content_type
      : fallbackType === "video"
        ? "video/mp4"
        : fallbackType === "audio"
          ? "audio/mpeg"
          : "image/png";
    const ext = contentType.includes("jpeg") ? ".jpg"
      : contentType.includes("webp") ? ".webp"
      : contentType.includes("mp4") ? ".mp4"
      : contentType.includes("wav") ? ".wav"
      : contentType.includes("mpeg") || contentType.includes("mp3") ? ".mp3"
      : fallbackType === "video" ? ".mp4"
      : fallbackType === "audio" ? ".mp3"
      : ".png";
    const fileName = typeof rec.file_name === "string" && rec.file_name
      ? rec.file_name
      : `${fallbackType}-${idx + 1}${ext}`;
    raw.push({
      id: `${fallbackType}-${idx}`,
      name: fileName,
      type: fallbackType,
      nodeId: "out",
      contentType,
      url,
      toBytes: async () => new Uint8Array(),
    });
  };

  if (Array.isArray(payload.images)) {
    payload.images.forEach((img, idx) => pushFile(img, "image", idx));
  }
  if (payload.image) pushFile(payload.image, "image", raw.length);
  if (payload.video) pushFile(payload.video, "video", raw.length);
  if (Array.isArray(payload.videos)) {
    payload.videos.forEach((vid, idx) => pushFile(vid, "video", idx));
  }
  if (payload.audio_file) pushFile(payload.audio_file, "audio", raw.length);
  if (payload.audio) pushFile(payload.audio, "audio", raw.length);

  return normalizeUrlList(raw, doFetch);
}

export type FalProviderOptions = {
  apiKey?: string;
  webhookSecret?: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
};

export class FalProvider implements GenerationProvider {
  readonly id = "fal";
  readonly name = "fal.ai";
  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly doFetch: typeof fetch;
  private readonly pollIntervalMs: number;

  constructor(opts: FalProviderOptions = {}) {
    this.apiKey = (opts.apiKey ?? process.env.FAL_KEY ?? "").trim();
    this.webhookSecret = (opts.webhookSecret ?? process.env.FAL_WEBHOOK_SECRET ?? "").trim();
    this.doFetch = opts.fetch ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
  }

  status(): ProviderStatus {
    const configured = Boolean(this.apiKey);
    return {
      id: this.id,
      name: this.name,
      configured,
      available: configured,
      reason: configured ? null : "FAL_KEY environment variable is not set on the server.",
      capabilities: FAL_CAPABILITIES,
      webhookConfigured: Boolean(this.webhookSecret || process.env.PUBLIC_BASE_URL),
      endpointCount: 14,
      baseUrl: QUEUE_BASE,
    };
  }

  supports(binding: AppProviderBinding): boolean {
    return binding.supported && binding.provider === this.id && Boolean(binding.endpoint);
  }

  private authHeaders(): Record<string, string> {
    if (!this.apiKey) {
      throw new InputError("AI provider fal.ai is not configured: set FAL_KEY on the server.");
    }
    return { Authorization: `Key ${this.apiKey}` };
  }

  private async uploadFile(file: FileValue): Promise<string> {
    const contentType = file.type || "application/octet-stream";
    const initRes = await this.doFetch(UPLOAD_INITIATE_URL, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file_name: file.name || "input.bin",
        content_type: contentType,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!initRes.ok) {
      const msg = await initRes.text().catch(() => "");
      throw new Error(`fal.ai storage initiate failed (${initRes.status}): ${msg.slice(0, 200)}`);
    }
    const { upload_url, file_url } = (await initRes.json()) as { upload_url?: string; file_url?: string };
    if (!upload_url || !file_url) {
      throw new Error("fal.ai storage initiate returned an incomplete response.");
    }
    const putRes = await this.doFetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: Buffer.from(file.bytes),
      signal: AbortSignal.timeout(120_000),
    });
    if (!putRes.ok) {
      throw new Error(`fal.ai storage upload failed (${putRes.status})`);
    }
    return file_url;
  }

  private async buildPayload(
    app: App,
    binding: AppProviderBinding,
    compiled: CompiledGeneration,
  ): Promise<Record<string, unknown>> {
    const uploaded: Record<string, string> = {};
    for (const [id, file] of Object.entries(compiled.files)) {
      uploaded[id] = await this.uploadFile(file);
    }

    const imageUrls = app.inputs
      .filter((i) => i.type === "image" && !i.paint && uploaded[i.id])
      .map((i) => uploaded[i.id]);
    const maskInput = app.inputs.find((i) => i.paint && uploaded[i.id]);
    const maskUrl = maskInput ? uploaded[maskInput.id] : undefined;
    const videoInput = app.inputs.find((i) => i.type === "video" && uploaded[i.id]);
    const videoUrl = videoInput ? uploaded[videoInput.id] : undefined;
    const audioInput = app.inputs.find((i) => i.type === "audio" && uploaded[i.id]);
    const audioUrl = audioInput ? uploaded[audioInput.id] : undefined;

    const payload: Record<string, unknown> = {};
    if (compiled.seed !== null) payload.seed = compiled.seed;

    switch (binding.capability) {
      case "text-to-image": {
        payload.prompt = compiled.prompt;
        const size = imageSizeFromCompiled(compiled);
        if (size) payload.image_size = size;
        if (compiled.steps !== null) payload.num_inference_steps = Math.min(50, Math.max(1, compiled.steps));
        break;
      }
      case "image-to-image": {
        payload.prompt = compiled.prompt;
        if (imageUrls[0]) payload.image_url = imageUrls[0];
        if (imageUrls.length > 1) payload.image_urls = imageUrls;
        if (compiled.aspectRatio) payload.aspect_ratio = compiled.aspectRatio;
        break;
      }
      case "inpaint": {
        payload.prompt = compiled.prompt;
        if (imageUrls[0]) payload.image_url = imageUrls[0];
        if (maskUrl) payload.mask_url = maskUrl;
        if (compiled.steps !== null) payload.num_inference_steps = Math.min(50, Math.max(1, compiled.steps));
        break;
      }
      case "upscale": {
        if (imageUrls[0]) payload.image_url = imageUrls[0];
        if (compiled.scale !== null) payload.upscale_factor = compiled.scale;
        break;
      }
      case "background-removal": {
        if (imageUrls[0]) payload.image_url = imageUrls[0];
        break;
      }
      case "depth": {
        if (imageUrls[0]) payload.image_url = imageUrls[0];
        break;
      }
      case "text-to-video": {
        payload.prompt = compiled.prompt;
        if (compiled.negativePrompt) payload.negative_prompt = compiled.negativePrompt;
        if (compiled.aspectRatio) payload.aspect_ratio = compiled.aspectRatio;
        if (compiled.duration !== null) payload.duration = compiled.duration;
        break;
      }
      case "image-to-video": {
        payload.prompt = compiled.prompt;
        if (compiled.negativePrompt) payload.negative_prompt = compiled.negativePrompt;
        if (imageUrls[0]) payload.image_url = imageUrls[0];
        if (imageUrls[1]) payload.end_image_url = imageUrls[1];
        if (compiled.aspectRatio) payload.aspect_ratio = compiled.aspectRatio;
        if (compiled.duration !== null) payload.duration = compiled.duration;
        break;
      }
      case "lip-sync": {
        if (videoUrl) payload.video_url = videoUrl;
        else if (imageUrls[0]) payload.image_url = imageUrls[0];
        if (audioUrl) payload.audio_url = audioUrl;
        break;
      }
      case "video-upscale":
      case "video-background-removal": {
        if (videoUrl) payload.video_url = videoUrl;
        break;
      }
      case "video-extend": {
        payload.prompt = compiled.prompt;
        if (videoUrl) payload.video_url = videoUrl;
        break;
      }
      case "text-to-audio": {
        if (app.id === "music") {
          payload.prompt = String(compiled.values.style || compiled.prompt);
          if (compiled.values.lyrics) payload.lyrics_prompt = String(compiled.values.lyrics);
        } else {
          payload.prompt = compiled.prompt;
          if (compiled.duration !== null) payload.seconds_total = compiled.duration;
        }
        break;
      }
      default:
        throw new InputError(binding.unavailableReason || "Unsupported generation capability.");
    }

    return payload;
  }

  async submit(
    app: App,
    binding: AppProviderBinding,
    compiled: CompiledGeneration,
    opts: { webhookUrl?: string; signal?: AbortSignal } = {},
  ): Promise<JobLike> {
    if (!this.supports(binding) || !binding.endpoint) {
      throw new InputError(binding.unavailableReason || `${app.id} is not supported on ${this.name}`);
    }
    if (!this.apiKey) {
      throw new InputError("AI provider fal.ai is not configured: set FAL_KEY on the server.");
    }
    if (!isAllowedEndpoint(binding.endpoint)) {
      throw new InputError(`Invalid provider endpoint: ${binding.endpoint}`);
    }

    const payload = await this.buildPayload(app, binding, compiled);
    const submitUrl = new URL(`${QUEUE_BASE}/${binding.endpoint}`);
    if (opts.webhookUrl) {
      submitUrl.searchParams.set("fal_webhook", opts.webhookUrl);
    }

    const res = await this.doFetch(submitUrl.toString(), {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: opts.signal ?? AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`fal.ai rejected submission (${res.status}): ${errBody.slice(0, 300)}`);
    }

    const queued = (await res.json()) as {
      request_id: string;
      status_url?: string;
      response_url?: string;
      cancel_url?: string;
      queue_position?: number;
    };

    const ep = binding.endpoint;
    const statusUrl = queued.status_url || `${QUEUE_BASE}/${ep}/requests/${queued.request_id}/status`;
    const responseUrl = queued.response_url || `${QUEUE_BASE}/${ep}/requests/${queued.request_id}`;
    const cancelUrl = queued.cancel_url || `${QUEUE_BASE}/${ep}/requests/${queued.request_id}/cancel`;

    return this.createJobHandle({
      id: queued.request_id,
      endpoint: ep,
      statusUrl,
      responseUrl,
      cancelUrl,
      initialQueuePosition: queued.queue_position ?? null,
    });
  }

  async getJob(externalId: string, endpoint: string): Promise<JobLike> {
    if (!this.apiKey) {
      throw new InputError("AI provider fal.ai is not configured: set FAL_KEY on the server.");
    }
    if (!isAllowedEndpoint(endpoint) || !/^[a-zA-Z0-9_-]+$/.test(externalId)) {
      throw new InputError("Invalid external job reference");
    }
    const base = `${QUEUE_BASE}/${endpoint}/requests/${externalId}`;
    return this.createJobHandle({
      id: externalId,
      endpoint,
      statusUrl: `${base}/status`,
      responseUrl: base,
      cancelUrl: `${base}/cancel`,
      initialQueuePosition: null,
    });
  }

  async parseWebhook(args: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
  }): Promise<WebhookUpdate | null> {
    if (this.webhookSecret) {
      const one = (k: string) => {
        const v = args.headers[k];
        return Array.isArray(v) ? v[0] : v;
      };
      const providedSecret = one("x-fal-webhook-secret") || one("x-webhook-secret") || "";
      const sigHeader = one("x-fal-webhook-signature") || "";
      const ts = one("x-fal-webhook-timestamp") || "";
      if (ts) {
        const age = Math.abs(Date.now() / 1000 - Number(ts));
        if (!Number.isFinite(age) || age > 300) {
          throw new InputError("Webhook timestamp expired or invalid");
        }
      }
      if (sigHeader) {
        const expected = createHmac("sha256", this.webhookSecret).update(args.rawBody).digest("hex");
        const a = Buffer.from(sigHeader.replace(/^sha256=/, ""));
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          throw new InputError("Invalid webhook signature");
        }
      } else if (providedSecret) {
        const a = Buffer.from(providedSecret);
        const b = Buffer.from(this.webhookSecret);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          throw new InputError("Invalid webhook secret");
        }
      } else {
        throw new InputError("Missing webhook authentication");
      }
    }

    const body = JSON.parse(args.rawBody.toString("utf-8")) as {
      request_id?: string;
      status?: string;
      payload?: Record<string, unknown>;
      error?: string;
    };
    if (!body?.request_id) return null;

    if (body.status === "OK" || body.status === "COMPLETED") {
      const outputs = extractFalOutputs(body.payload ?? {}, this.doFetch);
      return {
        externalJobId: body.request_id,
        status: "succeeded",
        outputs,
      };
    }

    return {
      externalJobId: body.request_id,
      status: "failed",
      outputs: [],
      errorMessage: body.error || `fal.ai job ended with status ${body.status ?? "unknown"}`,
    };
  }

  private createJobHandle(cfg: {
    id: string;
    endpoint: string;
    statusUrl: string;
    responseUrl: string;
    cancelUrl: string;
    initialQueuePosition: number | null;
  }): JobLike {
    const self = this;
    let status = "queued";
    let queuePosition: number | null = cfg.initialQueuePosition;
    let startedAt: Date | null = null;
    let completedAt: Date | null = null;
    let outputs: JobOutput[] = [];
    let error: { message?: string } | null = null;
    let canceled = false;

    const listeners = new Set<(ev: JobEvent) => void>();
    const push = (ev: JobEvent) => {
      for (const fn of listeners) fn(ev);
    };

    const pollOnce = async (): Promise<boolean> => {
      const res = await self.doFetch(`${cfg.statusUrl}?logs=1`, {
        headers: self.authHeaders(),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const err = Object.assign(new Error(`fal.ai status HTTP ${res.status}`), { httpStatus: res.status });
        throw err;
      }
      const data = (await res.json()) as {
        status?: string;
        queue_position?: number | null;
        error?: string;
      };
      const rawStatus = (data.status || "").toUpperCase();
      if (rawStatus === "IN_QUEUE") {
        status = "queued";
        queuePosition = typeof data.queue_position === "number" ? data.queue_position : queuePosition;
        push({ kind: "statusChange", status: "queued", queuePosition });
        return false;
      }
      if (rawStatus === "IN_PROGRESS") {
        if (!startedAt) startedAt = new Date();
        status = "running";
        queuePosition = null;
        push({ kind: "statusChange", status: "running", queuePosition: null });
        return false;
      }
      if (rawStatus === "COMPLETED") {
        const outRes = await self.doFetch(cfg.responseUrl, {
          headers: self.authHeaders(),
          signal: AbortSignal.timeout(30_000),
        });
        if (!outRes.ok) {
          throw Object.assign(new Error(`fal.ai result fetch failed (${outRes.status})`), { httpStatus: outRes.status });
        }
        const resultPayload = (await outRes.json()) as Record<string, unknown>;
        outputs = extractFalOutputs(resultPayload, self.doFetch);
        status = "succeeded";
        completedAt = new Date();
        if (!startedAt) startedAt = completedAt;
        push({ kind: "statusChange", status: "succeeded", queuePosition: null });
        return true;
      }
      if (rawStatus === "FAILED" || rawStatus === "ERROR") {
        status = "failed";
        error = { message: data.error || "fal.ai generation failed" };
        completedAt = new Date();
        push({ kind: "statusChange", status: "failed", queuePosition: null });
        return true;
      }
      if (rawStatus === "CANCELED" || rawStatus === "CANCELLED") {
        status = "canceled";
        completedAt = new Date();
        push({ kind: "statusChange", status: "canceled", queuePosition: null });
        return true;
      }
      return false;
    };

    return {
      id: cfg.id,
      provider: self.id,
      endpoint: cfg.endpoint,
      get status() { return status; },
      get outputs() { return outputs; },
      get error() { return error; },
      get startedAt() { return startedAt; },
      get completedAt() { return completedAt; },
      get progress() { return null; },
      get queuePosition() { return queuePosition; },
      async *events(signal?: AbortSignal) {
        const q: JobEvent[] = [];
        let wake: (() => void) | null = null;
        const onEv = (ev: JobEvent) => { q.push(ev); wake?.(); wake = null; };
        listeners.add(onEv);
        const onAbort = () => { wake?.(); wake = null; };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          while (!signal?.aborted) {
            while (q.length) yield q.shift()!;
            if (["succeeded", "failed", "canceled"].includes(status)) break;
            await new Promise<void>((r) => { wake = r; });
          }
        } finally {
          listeners.delete(onEv);
          signal?.removeEventListener("abort", onAbort);
        }
      },
      async wait(timeoutMs = 30 * 60 * 1000, signal?: AbortSignal) {
        const deadline = Date.now() + timeoutMs;
        while (!canceled && !signal?.aborted) {
          if (await pollOnce()) return;
          if (Date.now() >= deadline) throw new Error(`job ${cfg.id} not terminal after ${timeoutMs}ms (status=${status})`);
          await new Promise<void>((r) => setTimeout(r, self.pollIntervalMs));
        }
      },
      async cancel() {
        canceled = true;
        status = "canceled";
        completedAt = new Date();
        await self.doFetch(cfg.cancelUrl, {
          method: "PUT",
          headers: self.authHeaders(),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
      },
    };
  }
}
