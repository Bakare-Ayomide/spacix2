// Generation history: every run started from the web UI or API, persisted to disk and synced to MySQL when configured.
//   out/history/<id>/meta.json        run metadata: app, values, preset, provider, status, timings, outputs, error
//   out/history/<id>/input-<x>.<ext>  uploaded input assets
//   out/history/<id>/out-<n>.<ext>    downloaded media results
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { JobLike, WebhookUpdate } from "./providers/types.ts";
import { isFileInput, type App } from "./registry.ts";
import type { FileValue, Frame, Values } from "./runner.ts";

export type { JobLike };

export type Status = "starting" | "queued" | "running" | "succeeded" | "failed" | "canceled" | "expired" | "lost";
const TERMINAL = new Set<Status>(["succeeded", "failed", "canceled", "expired", "lost"]);
const MEDIA = new Set(["image", "video", "audio"]);

export type Entry = {
  id: string;
  app: string;
  status: Status;
  job: string | null;
  provider?: string | null;
  provider_endpoint?: string | null;
  project_id?: string | null;
  created: string;
  started: string | null;
  finished: string | null;
  /** execution time on the provider (started → finished), when reported */
  seconds: number | null;
  /** wall time from pressing Generate to the result, queueing included */
  total: number | null;
  values: Record<string, unknown>;
  preset: string | null;
  inputs: { id: string; type: string; file: string; name: string }[];
  outputs: { file: string; type: string; name: string; node: string; url?: string }[];
  error: { message: string; class_type?: string | null; node?: string | null } | null;
  /** visitor id when passcode isolation is active; never sent to the browser */
  owner?: string;
};

export type AppInfo = { outputs: string[]; nodes: number; classOf: (id: string) => string | null };

export type HistoryOptions = {
  onContact?: () => void;
  onUpdate?: (entry: Entry) => void | Promise<void>;
  appInfo?: (appId: string) => AppInfo | undefined;
  frames?: (jobId: string, signal: AbortSignal) => AsyncIterable<Frame>;
  recheck?: (jobId: string) => Promise<JobLike>;
};

type Live = {
  job?: JobLike;
  cancelRequested?: boolean;
  webhookResolved?: boolean;
  progress: { value: number; step: number | null; steps: number | null; node: string | null } | null;
  queue: number | null;
  preview: { bytes: Uint8Array; type: string; n: number } | null;
};

export class Meter {
  private done = 0;
  private total: number;
  private classOf: (id: string) => string | null;
  value = 0;
  step: number | null = null;
  steps: number | null = null;
  node: string | null = null;

  constructor(expectedNodes: number, classOf: (id: string) => string | null = () => null) {
    this.total = Math.max(1, expectedNodes);
    this.classOf = classOf;
  }

  feed(d: { value?: unknown; nodes_done?: unknown; nodes_total?: unknown; step?: unknown; steps?: unknown; current_node?: unknown }) {
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    const nodesTotal = n(d.nodes_total) ?? 0;
    if (nodesTotal > 0) {
      this.done = Math.max(this.done, n(d.nodes_done) ?? 0);
      this.total = Math.max(this.total, nodesTotal);
    }
    const step = n(d.step), steps = n(d.steps);
    const inNode = steps && steps > 0 && step !== null ? Math.min(1, Math.max(0, step / steps)) : 0;
    this.value = Math.max(this.value, Math.min(0.99, (this.done + inNode) / this.total));
    if (steps && steps > 1) { this.step = step; this.steps = steps; } else if (nodesTotal > 0) { this.step = null; this.steps = null; }
    const id = typeof d.current_node === "string" ? d.current_node : null;
    if (id) this.node = this.classOf(id) ?? this.node;
    return { value: this.value, step: this.step, steps: this.steps, node: this.node };
  }
}

const ID = /^\d{8}-\d{9}-[0-9a-f]{4}$/;
const EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/flac": ".flac", "audio/ogg": ".ogg", "audio/mp4": ".m4a",
};

function newId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const day = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const time = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}${p(now.getUTCMilliseconds(), 3)}`;
  return `${day}-${time}-${randomBytes(2).toString("hex")}`;
}

function safeExt(name: string | undefined, type: string | undefined): string {
  const fromName = extname(name ?? "").toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  return EXT[(type ?? "").split(";")[0].trim()] ?? ".bin";
}

const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv", ".gif"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus"]);

function mediaKind(ext: string, sdkType: string): "image" | "video" | "audio" {
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return sdkType === "video" || sdkType === "audio" ? sdkType : "image";
}

function normStatus(s: string): Status {
  if (s === "canceling") return "running";
  return (["queued", "running", "succeeded", "failed", "canceled", "expired"] as string[]).includes(s) ? (s as Status) : "running";
}

export function isTransient(e: unknown): boolean {
  const err = e as { message?: string; httpStatus?: number; name?: string; cause?: { code?: string } };
  if (typeof err?.httpStatus === "number") return err.httpStatus >= 500 || err.httpStatus === 429;
  if (/not terminal after/.test(err?.message ?? "")) return false;
  return /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timed? ?out|aborted/i.test(`${err?.message ?? ""} ${err?.cause?.code ?? ""}`);
}

const owns = (e: Entry, owner: string | undefined) => owner === undefined || e.owner === owner;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitPatiently(
  job: { wait(timeoutMs?: number): Promise<unknown> },
  timeoutMs: number,
  patience = 10 * 60 * 1000,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let firstFailure: number | null = null;
  let failures = 0;
  for (;;) {
    try {
      await job.wait(Math.max(1000, deadline - Date.now()));
      return;
    } catch (e) {
      if (!isTransient(e) || Date.now() >= deadline) throw e;
      firstFailure ??= Date.now();
      if (Date.now() - firstFailure > patience) throw e;
      failures++;
      const pause = Math.min(15_000, 2_000 * failures);
      log(`poll failed (${(e as Error).message}); trying again in ${pause / 1000}s`);
      await sleep(pause);
    }
  }
}

export function pickOutputs<T extends { type: string; nodeId: string }>(outputs: readonly T[], wanted: readonly string[]): T[] {
  const media = outputs.filter((o) => MEDIA.has(o.type));
  const declared = wanted.flatMap((node) => media.filter((o) => o.nodeId === node));
  return declared.length ? declared : media;
}

const secondsBetween = (a: string | Date | null | undefined, b: string | Date | null | undefined) =>
  a && b ? Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 100) / 10) : null;

export class History {
  private live = new Map<string, Live>();
  private removed = new Set<string>();

  readonly dir: string;
  private onContact: () => void;
  private onUpdate?: (entry: Entry) => void | Promise<void>;
  private appInfo: (appId: string) => AppInfo | undefined;
  private frames?: (jobId: string, signal: AbortSignal) => AsyncIterable<Frame>;
  private recheck?: (jobId: string) => Promise<JobLike>;

  constructor(dir: string, opts: HistoryOptions = {}) {
    this.dir = dir;
    this.onContact = opts.onContact ?? (() => {});
    this.onUpdate = opts.onUpdate;
    this.appInfo = opts.appInfo ?? (() => undefined);
    this.frames = opts.frames;
    this.recheck = opts.recheck;
    mkdirSync(dir, { recursive: true });
  }

  start(
    app: App,
    values: Values,
    preset?: string,
    owner?: string,
    extra: { provider?: string | null; provider_endpoint?: string | null; project_id?: string | null } = {},
  ): Entry {
    const id = newId();
    const folder = join(this.dir, id);
    mkdirSync(folder);
    const inputs: Entry["inputs"] = [];
    const shown: Record<string, unknown> = {};
    for (const input of app.inputs) {
      const v = values[input.id];
      if (v === undefined) continue;
      if (isFileInput(input)) {
        const f = v as FileValue;
        const file = `input-${input.id}${safeExt(f.name, f.type)}`;
        writeFileSync(join(folder, file), f.bytes);
        inputs.push({ id: input.id, type: input.type, file, name: f.name || file });
      } else {
        shown[input.id] = v;
      }
    }
    const entry: Entry = {
      id,
      app: app.id,
      status: "starting",
      job: null,
      provider: extra.provider ?? null,
      provider_endpoint: extra.provider_endpoint ?? null,
      project_id: extra.project_id ?? null,
      created: new Date().toISOString(),
      started: null,
      finished: null,
      seconds: null,
      total: null,
      values: shown,
      preset: preset ?? null,
      inputs,
      outputs: [],
      error: null,
      ...(owner ? { owner } : {}),
    };
    this.save(entry);
    this.live.set(id, { progress: null, queue: null, preview: null });
    return entry;
  }

  fail(entry: Entry, message: string, status: Status = "failed"): void {
    entry.status = status;
    entry.finished = new Date().toISOString();
    entry.total = secondsBetween(entry.created, entry.finished);
    entry.error = { message };
    this.save(entry);
    this.live.delete(entry.id);
  }

  private async secondLook(job: JobLike, tries = 3, pauseMs = 1500): Promise<JobLike> {
    if (normStatus(job.status) !== "expired" || !this.recheck) return job;
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, pauseMs));
      try {
        const again = await this.recheck(job.id);
        if (normStatus(again.status) !== "expired") return again;
      } catch { /* keep the first answer */ }
    }
    return job;
  }

  async follow(entry: Entry, job: JobLike): Promise<Entry> {
    if (this.removed.has(entry.id)) {
      await job.cancel().catch(() => {});
      return entry;
    }
    const live = this.live.get(entry.id) ?? { progress: null, queue: null, preview: null };
    this.live.set(entry.id, live);
    live.job = job;
    entry.job = job.id;
    if (job.provider) entry.provider = job.provider;
    if (job.endpoint) entry.provider_endpoint = job.endpoint;
    entry.status = normStatus(job.status);
    this.save(entry);
    if (live.cancelRequested) await job.cancel().catch(() => {});

    const setStatus = (s: Status) => {
      if (TERMINAL.has(s) || s === entry.status || live.webhookResolved) return;
      entry.status = s;
      if (s === "running") entry.started ??= new Date().toISOString();
      this.save(entry);
    };
    const info = this.appInfo(entry.app);
    const meter = new Meter(info?.nodes ?? 0, info?.classOf);
    const stop = new AbortController();

    const stream = (async () => {
      try {
        if (this.frames) {
          for await (const f of this.frames(job.id, stop.signal)) {
            this.onContact();
            if (f.event === "progress") {
              live.progress = meter.feed(f.data);
              setStatus("running");
            } else if (f.event === "preview" && typeof f.data.data_base64 === "string") {
              live.preview = { bytes: Buffer.from(f.data.data_base64, "base64"), type: String(f.data.content_type || "image/jpeg"), n: (live.preview?.n ?? 0) + 1 };
            } else if (f.event === "status") {
              live.queue = typeof f.data.queue_position === "number" ? f.data.queue_position : null;
              setStatus(normStatus(String(f.data.status ?? "")));
            }
          }
        } else {
          for await (const ev of job.events(stop.signal)) {
            this.onContact();
            if (ev.kind === "progress") {
              live.progress = meter.feed({ nodes_done: ev.nodesDone, nodes_total: ev.nodesTotal, step: ev.step, steps: ev.steps, current_node: ev.currentNode });
              if (ev.currentNodeClass) live.progress.node = ev.currentNodeClass;
              setStatus("running");
            } else if (ev.kind === "preview") {
              live.preview = { bytes: ev.data, type: ev.contentType || "image/jpeg", n: (live.preview?.n ?? 0) + 1 };
            } else if (ev.kind === "statusChange") {
              live.queue = ev.queuePosition;
              setStatus(normStatus(ev.status));
            }
          }
        }
      } catch {
        /* polling or webhook completes the run */
      }
    })();

    const tick = setInterval(() => {
      if (live.webhookResolved) { stop.abort(); return; }
      setStatus(normStatus(job.status));
      if (job.queuePosition !== undefined) live.queue = job.queuePosition ?? live.queue;
      const p = job.progress;
      if (p && (p.step !== null || (p.value > 0 && p.value > meter.value))) {
        live.progress = meter.feed({ nodes_done: p.value * (info?.nodes ?? 0), nodes_total: info?.nodes ?? 0, step: p.step, steps: p.steps });
        if (p.currentNodeClass) live.progress.node = p.currentNodeClass;
      }
    }, 1000);

    let waitError: unknown = null;
    try {
      await waitPatiently(job, 6 * 3600 * 1000, 10 * 60 * 1000, (msg) => console.warn(`[history] ${entry.id}: ${msg}`));
      this.onContact();
    } catch (e) {
      if (!live.webhookResolved) waitError = e;
    } finally {
      clearInterval(tick);
      stop.abort();
      await stream;
    }

    if (live.webhookResolved) {
      this.live.delete(entry.id);
      return this.read(entry.id) ?? entry;
    }

    if (!waitError) job = await this.secondLook(job);
    entry.started = job.startedAt?.toISOString() ?? entry.started;
    entry.finished = (job.completedAt ?? new Date()).toISOString();
    entry.seconds = secondsBetween(job.startedAt, job.completedAt) ?? (entry.started ? secondsBetween(entry.started, entry.finished) : null);
    entry.total = secondsBetween(entry.created, entry.finished);
    if (this.removed.has(entry.id)) {
      this.live.delete(entry.id);
      return entry;
    }
    if (waitError) {
      entry.status = "lost";
      entry.error = { message: `lost track of the job: ${(waitError as Error).message}` };
    } else {
      entry.status = normStatus(job.status);
      if (entry.status === "succeeded") {
        const folder = join(this.dir, entry.id);
        let n = 0;
        for (const out of pickOutputs(job.outputs, info?.outputs ?? [])) {
          try {
            const bytes = await out.toBytes();
            const ext = safeExt(out.name, out.contentType);
            const file = `out-${String(++n).padStart(2, "0")}${ext}`;
            writeFileSync(join(folder, file), bytes);
            entry.outputs.push({
              file,
              type: mediaKind(ext, out.type),
              name: out.name,
              node: out.nodeId,
              ...(out.url ? { url: out.url } : {}),
            });
          } catch (e) {
            entry.error = { message: `could not download ${out.name}: ${(e as Error).message}` };
          }
        }
        if (!entry.outputs.length && !entry.error) entry.error = { message: "the job finished without an image, video or audio output" };
      } else {
        const err = job.error;
        entry.error = {
          message: (err?.message || entry.status).trim(),
          class_type: err?.class_type ?? null,
          node: err?.node_id ?? null,
        };
      }
    }
    this.save(entry);
    this.live.delete(entry.id);
    return entry;
  }

  async applyWebhookUpdate(update: WebhookUpdate): Promise<Entry | null> {
    const entry = this.entries().find((e) => e.job === update.externalJobId);
    if (!entry) return null;
    if (TERMINAL.has(entry.status)) return entry;

    const live = this.live.get(entry.id);
    if (live) live.webhookResolved = true;

    entry.finished = new Date().toISOString();
    entry.started ??= entry.finished;
    entry.seconds = secondsBetween(entry.started, entry.finished);
    entry.total = secondsBetween(entry.created, entry.finished);

    if (update.status === "succeeded") {
      const folder = join(this.dir, entry.id);
      if (!existsSync(folder)) return null;
      let n = entry.outputs.length;
      for (const out of update.outputs) {
        try {
          const bytes = await out.toBytes();
          const ext = safeExt(out.name, out.contentType);
          const file = `out-${String(++n).padStart(2, "0")}${ext}`;
          writeFileSync(join(folder, file), bytes);
          entry.outputs.push({
            file,
            type: mediaKind(ext, out.type),
            name: out.name,
            node: out.nodeId,
            ...(out.url ? { url: out.url } : {}),
          });
        } catch (e) {
          entry.error = { message: `could not download ${out.name}: ${(e as Error).message}` };
        }
      }
      entry.status = entry.outputs.length ? "succeeded" : "failed";
      if (!entry.outputs.length && !entry.error) {
        entry.error = { message: "the job finished without an image, video or audio output" };
      }
    } else {
      entry.status = "failed";
      entry.error = { message: update.errorMessage || "generation failed" };
    }

    this.save(entry);
    this.live.delete(entry.id);
    return entry;
  }

  resume(getJob: (id: string, entry: Entry) => Promise<JobLike>, maxAgeMs = 60 * 60 * 1000): void {
    for (const entry of this.entries()) {
      if (TERMINAL.has(entry.status)) continue;
      if (!entry.job) {
        this.fail(entry, "the server stopped before this run reached the provider", "lost");
        continue;
      }
      if (Date.now() - new Date(entry.started ?? entry.created).getTime() > maxAgeMs) {
        this.fail(entry, "the server stopped while this run was going, too long ago to pick it up again", "lost");
        continue;
      }
      this.live.set(entry.id, { progress: null, queue: null, preview: null });
      getJob(entry.job, entry)
        .then((job) => this.follow(entry, job))
        .catch((e) => this.fail(entry, `could not pick this run up again: ${(e as Error).message}`, "lost"));
    }
  }

  async cancel(id: string, owner?: string): Promise<boolean> {
    const entry = this.read(id, owner);
    if (!entry || TERMINAL.has(entry.status)) return false;
    const live = this.live.get(id);
    if (!live) return false;
    live.cancelRequested = true;
    if (live.job) await live.job.cancel().catch(() => {});
    return true;
  }

  remove(id: string, owner?: string): boolean {
    if (!ID.test(id) || !existsSync(join(this.dir, id))) return false;
    if (owner !== undefined && !this.read(id, owner)) return false;
    const live = this.live.get(id);
    if (live?.job) live.job.cancel().catch(() => {});
    this.removed.add(id);
    this.live.delete(id);
    rmSync(join(this.dir, id), { recursive: true, force: true });
    return true;
  }

  file(id: string, name: string, owner?: string): string | null {
    if (!ID.test(id) || !/^(input|out)-[a-z0-9_-]+\.[a-z0-9]{1,5}$/.test(name)) return null;
    if (owner !== undefined && !this.read(id, owner)) return null;
    const path = join(this.dir, id, name);
    return existsSync(path) ? path : null;
  }

  preview(id: string, owner?: string): { bytes: Uint8Array; type: string } | null {
    if (owner !== undefined && !this.read(id, owner)) return null;
    return this.live.get(id)?.preview ?? null;
  }

  list(app?: string, limit = 300, owner?: string) {
    return this.entries().filter((e) => (!app || e.app === app) && owns(e, owner)).slice(0, limit).map((e) => this.view(e));
  }

  get(id: string, owner?: string) {
    const e = this.read(id, owner);
    return e ? this.view(e) : null;
  }

  view(e: Entry) {
    const base = `/api/history/${e.id}`;
    const live = this.live.get(e.id);
    const { owner: _owner, ...shown } = e;
    return {
      ...shown,
      inputs: e.inputs.map((i) => ({ ...i, url: `${base}/files/${i.file}` })),
      outputs: e.outputs.map((o) => ({ ...o, url: `${base}/files/${o.file}`, ...(o.url ? { remote_url: o.url } : {}) })),
      progress: live?.progress ?? null,
      queue: live?.queue ?? null,
      preview: live?.preview ? `${base}/preview?n=${live.preview.n}` : null,
    };
  }

  private entries(): Entry[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((d) => ID.test(d))
      .sort()
      .reverse()
      .map((d) => this.read(d))
      .filter((e): e is Entry => e !== null);
  }

  private read(id: string, owner?: string): Entry | null {
    if (!ID.test(id)) return null;
    try {
      const entry = JSON.parse(readFileSync(join(this.dir, id, "meta.json"), "utf-8")) as Entry;
      if (!owns(entry, owner)) return null;
      for (const o of entry.outputs ?? []) o.type = mediaKind(extname(o.file).toLowerCase(), o.type);
      if (entry.outputs?.length > 1) {
        entry.outputs = pickOutputs(entry.outputs.map((o) => ({ ...o, nodeId: o.node })), this.appInfo(entry.app)?.outputs ?? [])
          .map(({ nodeId: _, ...o }) => o);
      }
      return entry;
    } catch {
      return null;
    }
  }

  private save(entry: Entry): void {
    const folder = join(this.dir, entry.id);
    if (!existsSync(folder)) return;
    const tmp = join(folder, "meta.json.tmp");
    writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n");
    renameSync(tmp, join(folder, "meta.json"));
    if (this.onUpdate) {
      Promise.resolve(this.onUpdate(entry)).catch((err) => {
        console.warn(`[history] sync failed for ${entry.id}: ${(err as Error).message}`);
      });
    }
  }
}
