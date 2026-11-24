// Provider-independent parameter resolution, template composition, and SSE parsing.
// Turns form values + app.json manifests into validated values and compiled parameters
// without requiring ComfyUI or any local runtime.
import type { App, Input } from "./registry.ts";
import { isFileInput } from "./registry.ts";

export type FileValue = { bytes: Uint8Array; name: string; type?: string };
export type Values = Record<string, unknown>;

/** Collector target passed to applyInputs() to capture bound fields from app.json. */
export type Settable = { setInput(node: string, field: string, value: unknown): unknown };

export class InputError extends Error {}

export function isFileValue(v: unknown): v is FileValue {
  return typeof v === "object" && v !== null && (v as FileValue).bytes instanceof Uint8Array;
}

function coerce(input: Input, raw: unknown): unknown {
  switch (input.type) {
    case "number":
    case "slider":
    case "seed": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new InputError(`${input.id}: expected a number`);
      if (input.min !== undefined && n < input.min) throw new InputError(`${input.id}: must be ≥ ${input.min}`);
      if (input.max !== undefined && n > input.max) throw new InputError(`${input.id}: must be ≤ ${input.max}`);
      return input.type === "seed" ? Math.trunc(n) : n;
    }
    case "toggle":
      return raw === true || raw === "true" || raw === "1" || raw === "on";
    case "select": {
      if (input.multiple) return picks(input, raw);
      const opts = input.options ?? [];
      const hit = opts.find((o) => o.value === raw || String(o.value) === String(raw));
      if (!hit) throw new InputError(`${input.id}: "${String(raw)}" is not one of the options`);
      return hit.value;
    }
    default:
      return raw;
  }
}

/** A multiple select's value: the picked option values in the order picked, no repeats. The form sends a JSON list. */
function picks(input: Input, raw: unknown): string[] {
  let list: unknown[];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try { list = JSON.parse(raw); } catch { throw new InputError(`${input.id}: expected a list`); }
    if (!Array.isArray(list)) throw new InputError(`${input.id}: expected a list`);
  } else list = raw === "" || raw === null || raw === undefined ? [] : [raw];
  const out: string[] = [];
  for (const r of list) {
    const hit = (input.options ?? []).find((o) => String(o.value) === String(r));
    if (!hit) throw new InputError(`${input.id}: "${String(r)}" is not one of the options`);
    const v = String(hit.value);
    if (v && !out.includes(v)) out.push(v);
  }
  const max = input.multiple?.max;
  if (max && out.length > max) throw new InputError(`${input.id}: at most ${max}`);
  return out;
}

/** The picks of a multiple select as the one string templates and binds get. */
export function joinPicks(input: Input, list: unknown): string {
  const items = Array.isArray(list) ? list.map(String).filter(Boolean) : [];
  if (!items.length) return "";
  const m = input.multiple ?? {};
  return `${m.prefix ?? ""}${items.join(m.join ?? ", ")}${m.suffix ?? ""}`;
}

/** Values as templates receive them: multiple selects joined. */
export function textValues(app: App, values: Values): Values {
  const out: Values = { ...values };
  for (const input of app.inputs) {
    if (input.multiple && values[input.id] !== undefined) out[input.id] = joinPicks(input, values[input.id]);
  }
  return out;
}

/** Fill defaults, coerce types, check required fields. File inputs pass through as FileValue. */
export function resolveValues(app: App, values: Values): Values {
  const out: Values = {};
  for (const input of app.inputs) {
    let v = values[input.id];
    const emptyIsOption = input.type === "select" && (Boolean(input.multiple) || (input.options ?? []).some((o) => o.value === ""));
    if (v === undefined || (v === "" && !emptyIsOption)) v = input.default;
    if (input.type === "seed" && (v === undefined || v === -1 || v === "-1")) {
      v = Math.floor(Math.random() * 2 ** 48);
    }
    if (v === undefined) {
      if (input.required || isFileInput(input)) throw new InputError(`${input.id}: required`);
      continue;
    }
    if (isFileInput(input)) {
      if (!isFileValue(v)) throw new InputError(`${input.id}: expected a file`);
      const maxMb = input.limits?.max_mb;
      if (maxMb && v.bytes.byteLength > maxMb * 1e6) throw new InputError(`${input.id}: file is over ${maxMb} MB`);
      out[input.id] = v;
    } else {
      out[input.id] = coerce(input, v);
    }
  }
  return out;
}

export function renderTemplate(template: string, values: Values): string {
  return template
    .replace(/\{([a-z][a-z0-9_]*)\}/g, (_, k: string) => (values[k] === undefined ? "" : String(values[k])))
    .replace(/\s+,/g, ",")
    .replace(/,\s*,+/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/,$/, "");
}

/** A value in an option's or preset's `sets`: a string with {placeholders} is filled like a bind template. */
export function setValue(value: unknown, values: Values): unknown {
  return typeof value === "string" && /\{[a-z][a-z0-9_]*\}/.test(value) ? renderTemplate(value, values) : value;
}

/**
 * Apply resolved values and an optional preset onto a target Settable collector.
 * Preserves 100% compatibility with app.json bindings, templates, options.sets, and presets.
 */
export function applyInputs(
  app: App,
  values: Values,
  target: Settable,
  asset: (f: FileValue, inputId: string) => unknown,
  presetId?: string,
): void {
  values = textValues(app, values);
  for (const input of app.inputs) {
    const v = values[input.id];
    if (v === undefined) continue;
    for (const b of input.bind ?? []) {
      if (b.template) target.setInput(b.node, b.field, renderTemplate(b.template, values));
      else target.setInput(b.node, b.field, isFileValue(v) ? asset(v, input.id) : v);
    }
    const chosen = input.type === "select" ? input.options?.find((o) => o.value === v) : undefined;
    for (const s of chosen?.sets ?? []) target.setInput(s.node, s.field, setValue(s.value, values));
  }
  if (presetId) {
    const preset = (app.presets ?? []).find((p) => p.id === presetId);
    if (!preset) throw new InputError(`preset "${presetId}" does not exist in ${app.id}`);
    for (const s of preset.sets) target.setInput(s.node, s.field, setValue(s.value, values));
  }
}

export type Frame = { event: string; data: Record<string, unknown> };

/** Server-sent events reader. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "", event = "message", data: string[] = [];
  const flush = (): Frame | null => {
    const out = data.length ? { event, data: safeJson(data.join("\n")) } : null;
    event = "message"; data = [];
    return out;
  };
  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? "\n\n" : decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") { const f = flush(); if (f) yield f; }
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (done) return;
  }
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { text };
  }
}
