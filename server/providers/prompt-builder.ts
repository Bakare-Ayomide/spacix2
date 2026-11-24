// Compiles an app.json manifest and user form values into normalized prompts, settings, and media files
// using the exact template composition rules from runner.ts.
import type { App } from "../registry.ts";
import { applyInputs, isFileValue, resolveValues, type FileValue, type Settable, type Values } from "../runner.ts";
import type { CompiledGeneration } from "./types.ts";

const PROMPT_KEYS = [
  "4.text",
  "18:17.value",
  "398:376.value",
  "still:18:17.value",
  "6.text",
  "30:27.string_b",
  "prompt",
  "text",
  "positive",
];

const NEGATIVE_KEYS = ["7.text", "negative", "neg", "negative_prompt"];

function firstString(fields: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstNumber(fields: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function normalizeRefTokens(prompt: string): string {
  return prompt
    .replace(/<ref_image_0>/g, "the subject in the first reference image")
    .replace(/<ref_image_1>/g, "the element in the second reference image")
    .replace(/<ref_image_2>/g, "the element in the third reference image")
    .replace(/<ref_image_(\d+)>/g, (_, n: string) => `reference image ${Number(n) + 1}`)
    .trim();
}

function parseAspectRatio(values: Values): string | null {
  const raw = values.aspect ?? values.aspect_ratio ?? values.size;
  if (typeof raw !== "string") return null;
  const m = /(\d+)\s*:\s*(\d+)/.exec(raw);
  if (m) return `${m[1]}:${m[2]}`;
  if (/square/i.test(raw)) return "1:1";
  if (/portrait/i.test(raw)) return "3:4";
  if (/landscape/i.test(raw)) return "16:9";
  return null;
}

export function compileGeneration(app: App, rawValues: Values, presetId?: string): CompiledGeneration {
  const values = resolveValues(app, rawValues);
  const nodeFields: Record<string, unknown> = {};
  const files: Record<string, FileValue> = {};

  for (const [k, v] of Object.entries(values)) {
    if (isFileValue(v)) files[k] = v;
  }

  const collector: Settable = {
    setInput(node: string, field: string, value: unknown) {
      nodeFields[`${node}.${field}`] = value;
      return collector;
    },
  };

  applyInputs(app, values, collector, (_f, inputId) => inputId, presetId);

  let prompt = firstString(nodeFields, PROMPT_KEYS);
  if (!prompt) {
    // Fallback to any string field written onto a text/value node, or prompt-like raw values
    for (const [k, v] of Object.entries(nodeFields)) {
      if ((k.endsWith(".text") || k.endsWith(".value") || k.endsWith(".prompt")) && !k.includes("negative") && typeof v === "string" && v.trim()) {
        prompt = v.trim();
        break;
      }
    }
  }
  if (!prompt) {
    const valCandidates = ["prompt", "instruction", "scene", "style", "description", "line", "action_prompt", "details"];
    for (const k of valCandidates) {
      const v = values[k];
      if (typeof v === "string" && v.trim()) {
        prompt = v.trim();
        break;
      }
    }
  }
  prompt = normalizeRefTokens(prompt ?? app.name);

  let negativePrompt = firstString(nodeFields, NEGATIVE_KEYS) ?? "";
  if (!negativePrompt && typeof values.negative === "string") {
    negativePrompt = values.negative.trim();
  }

  const width = firstNumber(nodeFields, ["50.width", "still:18:6.width", "width"])
    ?? (typeof values.width === "number" ? values.width : null);
  const height = firstNumber(nodeFields, ["50.height", "still:18:6.height", "height"])
    ?? (typeof values.height === "number" ? values.height : null);

  const steps = firstNumber(nodeFields, ["7.steps", "18:7.steps", "3.steps", "steps"])
    ?? (typeof values.steps === "number" ? values.steps : null);
  const seed = firstNumber(nodeFields, ["7.seed", "18:7.seed", "3.seed", "seed"])
    ?? (typeof values.seed === "number" ? values.seed : null);

  const duration = typeof values.duration === "number"
    ? values.duration
    : typeof values.seconds === "number"
      ? values.seconds
      : null;

  const strength = typeof values.strength === "number" ? values.strength : null;
  const scale = typeof values.scale === "number"
    ? values.scale
    : firstNumber(nodeFields, ["ff_res.scale_by"]);

  return {
    appId: app.id,
    prompt,
    negativePrompt,
    aspectRatio: parseAspectRatio(values),
    width,
    height,
    duration,
    steps,
    seed,
    strength,
    scale,
    files,
    values,
    presetId: presetId ?? null,
    nodeFields,
  };
}
