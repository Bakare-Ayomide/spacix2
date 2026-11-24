// Provider-independent interfaces for cloud AI generation adapters.
import type { App } from "../registry.ts";
import type { FileValue, Values } from "../runner.ts";

export type Capability =
  | "text-to-image"
  | "image-to-image"
  | "inpaint"
  | "upscale"
  | "background-removal"
  | "depth"
  | "text-to-video"
  | "image-to-video"
  | "lip-sync"
  | "video-upscale"
  | "video-background-removal"
  | "video-extend"
  | "text-to-audio"
  | "unsupported";

export type AppProviderBinding = {
  supported: boolean;
  provider: string | null;
  endpoint: string | null;
  modelName: string | null;
  capability: Capability;
  unavailableReason: string | null;
};

export type ProviderStatus = {
  id: string;
  name: string;
  configured: boolean;
  available: boolean;
  reason: string | null;
  capabilities: Capability[];
  webhookConfigured: boolean;
  endpointCount: number;
  baseUrl?: string;
};

export type CompiledGeneration = {
  appId: string;
  prompt: string;
  negativePrompt: string;
  aspectRatio: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  steps: number | null;
  seed: number | null;
  strength: number | null;
  scale: number | null;
  files: Record<string, FileValue>;
  values: Values;
  presetId: string | null;
  nodeFields: Record<string, unknown>;
};

export type JobEvent =
  | { kind: "statusChange"; status: string; queuePosition: number | null }
  | { kind: "progress"; value: number; nodesDone: number; nodesTotal: number; step: number | null; steps: number | null; currentNode: string | null; currentNodeClass: string | null }
  | { kind: "preview"; data: Uint8Array; contentType?: string };

export type JobOutput = {
  id?: string;
  name: string;
  type: string;
  nodeId: string;
  contentType: string;
  url?: string;
  toBytes(): Promise<Uint8Array>;
};

export type JobLike = {
  readonly id: string;
  readonly status: string;
  readonly outputs: readonly JobOutput[];
  readonly error: { message?: string; class_type?: string | null; node_id?: string | null } | null | undefined;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly progress?: { value: number; step: number | null; steps: number | null; currentNodeClass: string | null } | null;
  readonly queuePosition?: number | null;
  readonly provider?: string;
  readonly endpoint?: string;
  events(signal?: AbortSignal): AsyncIterable<JobEvent>;
  wait(timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
  cancel(signal?: AbortSignal): Promise<unknown>;
};

export type WebhookUpdate = {
  externalJobId: string;
  status: "succeeded" | "failed";
  outputs: JobOutput[];
  errorMessage?: string;
};

export interface GenerationProvider {
  readonly id: string;
  readonly name: string;
  status(): ProviderStatus;
  supports(binding: AppProviderBinding): boolean;
  submit(
    app: App,
    binding: AppProviderBinding,
    compiled: CompiledGeneration,
    opts?: { webhookUrl?: string; signal?: AbortSignal },
  ): Promise<JobLike>;
  getJob(externalId: string, endpoint: string): Promise<JobLike>;
  parseWebhook?(args: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
  }): Promise<WebhookUpdate | null>;
}
