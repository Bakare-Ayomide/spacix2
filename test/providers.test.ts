import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { loadRegistry } from "../server/registry.ts";
import { bindingForApp } from "../server/providers/app-mapping.ts";
import { extractFalOutputs, FalProvider } from "../server/providers/fal.ts";
import { ProviderRegistry } from "../server/providers/registry.ts";
import { compileGeneration } from "../server/providers/prompt-builder.ts";
import { InputError } from "../server/runner.ts";

const { apps } = loadRegistry();
const byId = (id: string) => apps.find((a) => a.id === id)!;

test("bindingForApp assigns cloud endpoints to supported apps and clearly marks unsupported ones", () => {
  const zImage = bindingForApp(byId("z-image"));
  assert.equal(zImage.supported, true);
  assert.equal(zImage.provider, "fal");
  assert.equal(zImage.endpoint, "fal-ai/flux/schnell");

  const music = bindingForApp(byId("music"));
  assert.equal(music.supported, true);
  assert.equal(music.endpoint, "fal-ai/minimax-music");

  for (const id of ["recast", "motion-transfer", "camera-copy", "mixed-media", "sdr-hdr"]) {
    const b = bindingForApp(byId(id));
    assert.equal(b.supported, false, `${id} should be explicitly unsupported`);
    assert.ok(b.unavailableReason && b.unavailableReason.length > 10);
  }
});

test("FalProvider reports honest configuration status and rejects unconfigured submissions", async () => {
  const unconfigured = new FalProvider({ apiKey: "" });
  const st = unconfigured.status();
  assert.equal(st.configured, false);
  assert.equal(st.available, false);
  assert.match(st.reason ?? "", /FAL_KEY/);

  const app = byId("z-image");
  const binding = bindingForApp(app);
  const compiled = compileGeneration(app, { prompt: "a cyan skyline" });
  await assert.rejects(() => unconfigured.submit(app, binding, compiled), InputError);
});

test("FalProvider uploads inputs, submits to fal queue with webhook, and resolves outputs", async () => {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, method, headers, body: typeof init?.body === "string" ? init.body : undefined });

    if (url.includes("/storage/upload/initiate")) {
      return new Response(JSON.stringify({
        upload_url: "https://fal.media/upload/signed-1",
        file_url: "https://v3.fal.media/files/uploaded-me.png",
      }), { status: 200 });
    }
    if (url === "https://fal.media/upload/signed-1") {
      return new Response("", { status: 200 });
    }
    if (url.startsWith("https://queue.fal.run/fal-ai/flux-kontext/pro?")) {
      return new Response(JSON.stringify({
        request_id: "req-999",
        queue_position: 2,
      }), { status: 200 });
    }
    if (url.includes("/requests/req-999/status")) {
      return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
    }
    if (url === "https://queue.fal.run/fal-ai/flux-kontext/pro/requests/req-999") {
      return new Response(JSON.stringify({
        images: [{ url: "https://v3.fal.media/files/output-1.png", content_type: "image/png" }],
      }), { status: 200 });
    }
    if (url === "https://v3.fal.media/files/output-1.png") {
      return new Response(pngBytes, { status: 200 });
    }
    return new Response("unexpected url", { status: 404 });
  }) as typeof fetch;

  const fal = new FalProvider({ apiKey: "fal-test-secret", fetch: fakeFetch, pollIntervalMs: 5 });
  const registry = new ProviderRegistry([fal]);
  const app = byId("edit");
  const binding = registry.appBinding(app);
  assert.equal(binding.available, true);

  const compiled = compileGeneration(app, {
    image: { bytes: pngBytes, name: "me.png", type: "image/png" },
    instruction: "add sunglasses",
  });

  const job = await fal.submit(app, binding, compiled, {
    webhookUrl: "https://studio.example.com/api/webhooks/fal",
  });
  assert.equal(job.id, "req-999");
  await job.wait(5000);
  assert.equal(job.status, "succeeded");
  assert.equal(job.outputs.length, 1);
  assert.deepEqual([...(await job.outputs[0].toBytes())], [...pngBytes]);

  const submitCall = calls.find((c) => c.url.includes("queue.fal.run/fal-ai/flux-kontext/pro?"));
  assert.ok(submitCall);
  assert.equal(submitCall.headers.authorization, "Key fal-test-secret");
  assert.ok(submitCall.url.includes("fal_webhook=https%3A%2F%2Fstudio.example.com%2Fapi%2Fwebhooks%2Ffal"));
  const sentPayload = JSON.parse(submitCall.body ?? "{}");
  assert.equal(sentPayload.image_url, "https://v3.fal.media/files/uploaded-me.png");
  assert.equal(sentPayload.prompt, "add sunglasses");
});

test("FalProvider enforces media URL allowlist and webhook HMAC verification", async () => {
  const outputs = extractFalOutputs({
    images: [
      { url: "https://v3.fal.media/files/ok.png", content_type: "image/png" },
      { url: "http://169.254.169.254/latest/meta-data", content_type: "image/png" },
      { url: "https://evil.example.com/payload.png", content_type: "image/png" },
    ],
  }, fetch);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].url, "https://v3.fal.media/files/ok.png");

  const fal = new FalProvider({ apiKey: "k", webhookSecret: "wh-secret" });
  const rawBody = Buffer.from(JSON.stringify({
    request_id: "req-1",
    status: "OK",
    payload: { images: [{ url: "https://v3.fal.media/files/out.png", content_type: "image/png" }] },
  }));
  const sig = createHmac("sha256", "wh-secret").update(rawBody).digest("hex");

  await assert.rejects(() => fal.parseWebhook({ headers: {}, rawBody }), /Missing webhook authentication/);
  await assert.rejects(() => fal.parseWebhook({
    headers: { "x-fal-webhook-signature": "sha256=deadbeef" },
    rawBody,
  }), /Invalid webhook signature/);

  const parsed = await fal.parseWebhook({
    headers: { "x-fal-webhook-signature": `sha256=${sig}` },
    rawBody,
  });
  assert.ok(parsed);
  assert.equal(parsed.externalJobId, "req-1");
  assert.equal(parsed.status, "succeeded");
  assert.equal(parsed.outputs.length, 1);
});
