// Command line for validating manifests, creating Super Admin accounts, and running SPACIX cloud generation jobs.
//   npm run validate                          check every app.json and its bindings
//   npm run apps                              list apps with status and provider endpoint
//   npm run seed:admin                        create initial Super Admin from SPACIX_ADMIN_* or flags
//   npm run app -- <id> [--set k=v] [--file k=path] [--preset id] [--out dir] [--draft]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadRegistry, repoRoot } from "./registry.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { compileGeneration } from "./providers/prompt-builder.ts";
import { MySqlClient } from "./db/client.ts";
import { PlatformService } from "./modules/platform-service.ts";
import { hashPassword } from "./security/crypto.ts";
import type { Values } from "./runner.ts";

const [cmd, ...rest] = process.argv.slice(2);
const root = repoRoot();
const { apps, problems } = loadRegistry(root);
const providers = new ProviderRegistry();

function printProblems(): number {
  let errors = 0;
  for (const p of problems) {
    if (p.severity === "error") errors++;
    console.log(`${p.severity === "error" ? "✗" : "!"} ${p.app}: ${p.message}`);
  }
  return errors;
}

if (cmd === "validate") {
  const errors = printProblems();
  const ready = apps.filter((a) => a.status === "ready").length;
  console.log(`${apps.length} apps (${ready} ready, ${apps.length - ready} draft) · ${errors} errors · ${problems.length - errors} warnings`);
  process.exit(errors ? 1 : 0);
} else if (cmd === "apps") {
  for (const a of apps) {
    const b = providers.appBinding(a);
    const ep = b.supported ? `${b.provider}:${b.endpoint}` : "unsupported";
    console.log(`${a.status.padEnd(5)}  ${a.section.padEnd(7)}  ${ep.padEnd(44)}  ${a.id}`);
  }
} else if (cmd === "create-admin") {
  let email = process.env.SPACIX_ADMIN_EMAIL || "";
  let password = process.env.SPACIX_ADMIN_PASSWORD || "";
  let name = process.env.SPACIX_ADMIN_NAME || "Platform Super Admin";
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const val = rest[i + 1] ?? "";
    if (flag === "--email") { email = val; i++; }
    else if (flag === "--password") { password = val; i++; }
    else if (flag === "--name") { name = val; i++; }
  }
  if (!email || !password || password.length < 8) {
    console.error("Usage: SPACIX_ADMIN_EMAIL=... SPACIX_ADMIN_PASSWORD=... npm run seed:admin (password >= 8 chars)");
    process.exit(2);
  }
  const outDir = process.env.SPACIX_OUT || process.env.FREEFIELD_OUT || join(root, "out");
  const mysql = new MySqlClient();
  const platform = new PlatformService({ mysql, stateFilePath: join(outDir, "platform-state.json") });
  await platform.init(apps);
  const existing = await platform.store.getUserByEmail(email);
  if (existing) {
    const updated = await platform.store.updateUser(existing.id, {
      passwordHash: hashPassword(password),
      displayName: name,
      isAdmin: true,
      emailVerified: true,
      status: "active",
      roles: ["super_admin"],
    });
    console.log(`[seed:admin] Updated existing user ${updated?.email} as super_admin (${platform.engine})`);
  } else {
    const created = await platform.store.createUser({
      email,
      passwordHash: hashPassword(password),
      displayName: name,
      isAdmin: true,
      emailVerified: true,
      roles: ["super_admin"],
      initialCredits: 1000,
      planId: "plan_studio",
    });
    console.log(`[seed:admin] Created Super Admin ${created.email} (${created.id}) on ${platform.engine}`);
  }
  await mysql.close();
  process.exit(0);
} else if (cmd === "app") {
  const id = rest[0];
  const app = apps.find((a) => a.id === id);
  if (!app) {
    console.error(`unknown app "${id}". Try: npm run apps`);
    process.exit(2);
  }
  const values: Values = {};
  let preset: string | undefined;
  let out = "out";
  let allowDrafts = process.env.SPACIX_DRAFTS === "1" || process.env.FREEFIELD_DRAFTS === "1";
  for (let i = 1; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--draft") {
      allowDrafts = true;
      continue;
    }
    const arg = rest[++i] ?? "";
    if (flag === "--set") {
      const [k, ...v] = arg.split("=");
      values[k] = v.join("=");
    } else if (flag === "--file") {
      const [k, ...v] = arg.split("=");
      const path = v.join("=");
      values[k] = { bytes: new Uint8Array(readFileSync(path)), name: basename(path) };
    } else if (flag === "--preset") preset = arg;
    else if (flag === "--out") out = arg;
  }
  if (app.status !== "ready" && !allowDrafts) {
    console.error(`${app.id} is a draft; pass --draft to run it`);
    process.exit(1);
  }
  const binding = providers.appBinding(app);
  if (!binding.supported || !binding.provider) {
    console.error(binding.unavailableReason || `${app.id} is unsupported`);
    process.exit(1);
  }
  const provider = providers.get(binding.provider);
  if (!provider) {
    console.error(`provider ${binding.provider} is not registered`);
    process.exit(1);
  }
  const compiled = compileGeneration(app, values, preset);
  const t0 = Date.now();
  let job;
  try {
    job = await provider.submit(app, binding, compiled);
  } catch (e) {
    console.error(`could not submit ${app.id}: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`submitted ${app.id} → job ${job.id} (${binding.endpoint})`);
  try {
    await job.wait();
  } catch (e) {
    console.error(`job ${job.id} ended ${job.status}:`, (e as Error).message);
    process.exit(1);
  }
  if (job.status !== "succeeded") {
    console.error(`job ${job.id} ended ${job.status}: ${job.error?.message || "unknown error"}`);
    process.exit(1);
  }
  console.log(`status ${job.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  mkdirSync(out, { recursive: true });
  for (const output of job.outputs) {
    const path = join(out, `${app.id}-${output.name}`);
    writeFileSync(path, await output.toBytes());
    console.log(`saved ${path}`);
  }
} else {
  console.log("usage: cli.ts validate | apps | create-admin | app <id> [--set k=v] [--file k=path] [--preset id] [--out dir] [--draft]");
  process.exit(cmd ? 2 : 0);
}
