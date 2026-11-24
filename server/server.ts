// HTTP API and static asset server for SPACIX centrally managed multi-user AI SaaS platform.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { loadRegistry, repoRoot, isFileInput, type App } from "./registry.ts";
import { InputError, resolveValues, type Values } from "./runner.ts";
import { History, type Entry } from "./history.ts";
import { Flags } from "./flags.ts";
import { DOOR_HTML, foreign, Guard, ownerDoor, plainHttpToIp } from "./guard.ts";
import { compileGeneration } from "./providers/prompt-builder.ts";
import { MySqlClient } from "./db/client.ts";
import { PlatformService, sanitizeUserForClient } from "./modules/platform-service.ts";
import { EmailService } from "./modules/email-service.ts";
import {
  AuthError,
  AuthService,
  buildSessionCookie,
  clearSessionCookie,
  clientIpFromReq,
  userAgentFromReq,
} from "./modules/auth-service.ts";
import { ProviderManager } from "./modules/provider-manager.ts";
import { AnalyticsService } from "./modules/analytics-service.ts";
import { handleAdminRoutes } from "./routes/admin-routes.ts";
import { hashPassword } from "./security/crypto.ts";

const root = repoRoot();
const { apps, problems } = loadRegistry(root);
for (const p of problems.filter((x) => x.severity === "error")) {
  console.error(`[registry] ${p.app}: ${p.message}`);
}
const byId = new Map(apps.map((a) => [a.id, a]));

const draftsAllowed = (process.env.SPACIX_DRAFTS ?? process.env.FREEFIELD_DRAFTS) === "1";
const outDir = process.env.SPACIX_OUT || process.env.FREEFIELD_OUT || join(root, "out");
const guard = Guard.fromEnv(join(outDir, "limits.json"));
const maxUploadMb = Number(process.env.SPACIX_MAX_UPLOAD_MB || process.env.FREEFIELD_MAX_UPLOAD_MB || (guard.hosted ? 100 : 0));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.SPACIX_HOST || process.env.FREEFIELD_HOST || "0.0.0.0";
const workspaceName = process.env.SPACIX_WORKSPACE_NAME?.trim() || "";
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || "";

const origins = {
  loopbackOnly: ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host),
  allowedHosts: (process.env.SPACIX_ALLOWED_HOSTS ?? process.env.FREEFIELD_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
};

const mysql = new MySqlClient();
const platform = new PlatformService({ mysql, stateFilePath: join(outDir, "platform-state.json") });
const emailService = new EmailService(platform);
const authService = new AuthService(platform, emailService);
const providerManager = new ProviderManager(platform);

const history = new History(join(outDir, "history"), {
  appInfo: (id) => {
    const app = byId.get(id);
    if (!app) return undefined;
    return {
      outputs: app.outputs.map((o) => o.node),
      nodes: Object.keys(app.graph ?? {}).length,
      classOf: (n) => app.graph?.[n]?.class_type ?? null,
    };
  },
  onUpdate: async (entry) => {
    if (platform.isReady()) {
      await platform.syncHistoryEntry(entry);
    }
  },
});

const analyticsService = new AnalyticsService({
  platform,
  providers: providerManager,
  history,
  mysql,
});

const flags = new Flags(join(root, "lab", "flags.json"), apps);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

const examplesFile = join(root, "web", "examples", "index.json");
function loadExamples(): Record<string, unknown> {
  try {
    return existsSync(examplesFile) ? (JSON.parse(readFileSync(examplesFile, "utf-8")).apps ?? {}) : {};
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string | string[]> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache = "no-cache") {
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
      "cache-control": cache,
    });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": cache });
  if (req.method === "HEAD") return res.end();
  return createReadStream(file).pipe(res);
}

async function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).byteLength;
    if (limitBytes && size > limitBytes) {
      throw new InputError(`Request body exceeds ${Math.round(limitBytes / 2 ** 20)} MB limit`);
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const body = await readRawBody(req, maxUploadMb ? maxUploadMb * 2 ** 20 : 128 * 2 ** 20);
  return new Request(`http://local${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: body.byteLength ? new Uint8Array(body) : undefined,
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req, 2 * 2 ** 20);
  if (!raw.byteLength) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new InputError("Invalid JSON request body.");
  }
}

async function readValues(app: App, request: Request): Promise<{ values: Values; preset?: string; projectId?: string; modelId?: string }> {
  const form = await request.formData();
  const values: Values = {};
  for (const input of app.inputs) {
    const v = form.get(input.id);
    if (v === null) continue;
    if (isFileInput(input)) {
      if (typeof v === "string") throw new InputError(`${input.id}: expected a file upload`);
      values[input.id] = { bytes: new Uint8Array(await v.arrayBuffer()), name: v.name, type: v.type };
    } else {
      values[input.id] = v;
    }
  }
  const preset = form.get("preset");
  const projectId = form.get("project_id");
  const modelId = form.get("model_id");
  return {
    values,
    preset: typeof preset === "string" && preset ? preset : undefined,
    projectId: typeof projectId === "string" && projectId ? projectId : undefined,
    modelId: typeof modelId === "string" && modelId ? modelId : undefined,
  };
}

const DONE = ["succeeded", "failed", "canceled", "expired", "lost"];
let admitting = 0;
const activeRuns = () => history.list(undefined, 200).filter((e) => !DONE.includes(e.status)).length + admitting;

async function startManagedRun(args: {
  app: App;
  values: Values;
  preset?: string;
  ownerId?: string;
  authenticatedUserId: string | null;
  projectId?: string | null;
  modelIdOverride?: string | null;
}) {
  const { app, values, preset, ownerId, authenticatedUserId, projectId, modelIdOverride } = args;
  const userRecord = authenticatedUserId ? await platform.store.getUserById(authenticatedUserId) : null;

  if (app.status !== "ready" && !draftsAllowed && !userRecord?.is_admin) {
    throw new InputError(`${app.name} is currently unavailable.`);
  }

  const exec = await platform.resolveAppExecution(app, userRecord, modelIdOverride);
  if (!exec.allowed || !exec.providerId || !exec.endpoint) {
    throw new InputError(exec.reason || `${app.name} is temporarily unavailable.`);
  }

  const provHealth = await providerManager.isProviderReady(exec.providerId);
  if (!provHealth.ready) {
    throw Object.assign(new Error("AI generation service is temporarily unavailable. Please try again later."), { httpStatus: 503 });
  }

  const billingEnabled = await platform.isFlagEnabled("credit_billing_enabled", true);
  const requireVerify = await platform.isFlagEnabled("require_email_verification", false);

  if (authenticatedUserId && userRecord) {
    if (requireVerify && !userRecord.email_verified && !userRecord.is_admin) {
      throw Object.assign(new AuthError("Please verify your email address before generating.", 403), { httpStatus: 403 });
    }
    if (userRecord.subscription_plan_id) {
      const plans = await platform.store.listPlans(false);
      const plan = plans.find((p) => p.id === userRecord.subscription_plan_id);
      if (plan) {
        const userActive = history.list(undefined, 200, ownerId).filter((e) => !DONE.includes(e.status)).length;
        if (userActive >= plan.max_active_jobs) {
          throw Object.assign(new Error(`Plan limit reached (${plan.max_active_jobs} concurrent generations allowed).`), { httpStatus: 429 });
        }
        if (plan.max_daily_runs !== null) {
          const dayAgo = Date.now() - 86_400_000;
          const dailyCount = history.list(undefined, 500, ownerId).filter((e) => new Date(e.created).getTime() >= dayAgo).length;
          if (dailyCount >= plan.max_daily_runs) {
            throw Object.assign(new Error(`Daily plan limit reached (${plan.max_daily_runs} generations/day).`), { httpStatus: 429 });
          }
        }
      }
    }
  } else if (billingEnabled && exec.creditCost > 0) {
    throw new AuthError("Please sign in or create an account to generate.", 401);
  }

  const compiled = compileGeneration(app, values, preset);
  const entry = history.start(app, values, preset, ownerId, {
    provider: exec.providerId,
    provider_endpoint: exec.endpoint,
    project_id: projectId ?? null,
  });

  let debitedCredits = 0;
  if (billingEnabled && exec.creditCost > 0 && authenticatedUserId) {
    try {
      await platform.store.adjustCredits({
        userId: authenticatedUserId,
        delta: -exec.creditCost,
        txType: "usage",
        reason: `Generation: ${app.name}`,
        generationId: entry.id,
        referenceId: `gen_debit_${entry.id}`,
      });
      debitedCredits = exec.creditCost;
    } catch (err) {
      history.remove(entry.id);
      throw Object.assign(new Error((err as Error).message || "Insufficient credit balance."), { httpStatus: 402 });
    }
  }

  await platform.syncHistoryEntry(entry, {
    userId: authenticatedUserId ?? undefined,
    modelId: exec.modelId,
    creditsCharged: debitedCredits,
  }).catch(() => {});

  void (async () => {
    try {
      const submitted = await providerManager.submitWithFallback({
        app,
        binding: {
          supported: true,
          provider: exec.providerId,
          endpoint: exec.endpoint,
          modelName: exec.modelName,
          capability: exec.capability as never,
          unavailableReason: null,
        },
        compiled,
        webhookBaseUrl: publicBaseUrl || undefined,
      });
      const finished = await history.follow(entry, submitted.job);
      if (finished.status !== "succeeded" && debitedCredits > 0 && authenticatedUserId) {
        await platform.store.adjustCredits({
          userId: authenticatedUserId,
          delta: debitedCredits,
          txType: "refund",
          reason: `Automatic refund for failed run (${app.name})`,
          generationId: entry.id,
          referenceId: `gen_refund_${entry.id}`,
        }).catch(() => {});
      }
      await platform.syncHistoryEntry(finished, {
        userId: authenticatedUserId ?? undefined,
        modelId: exec.modelId,
        creditsCharged: finished.status === "succeeded" ? debitedCredits : 0,
      }).catch(() => {});
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      console.error(`[${app.id}] ${message}`);
      history.fail(entry, message);
      if (debitedCredits > 0 && authenticatedUserId) {
        await platform.store.adjustCredits({
          userId: authenticatedUserId,
          delta: debitedCredits,
          txType: "refund",
          reason: `Automatic refund for failed submission (${app.name})`,
          generationId: entry.id,
          referenceId: `gen_refund_${entry.id}`,
        }).catch(() => {});
      }
    }
  })();

  return history.view(entry);
}

const readyPromise = (async () => {
  await platform.init(apps);
  // Optionally auto-seed initial admin from environment when zero admins exist
  if ((await platform.store.countAdmins()) === 0 && process.env.SPACIX_ADMIN_EMAIL && process.env.SPACIX_ADMIN_PASSWORD) {
    try {
      const created = await platform.store.createUser({
        email: process.env.SPACIX_ADMIN_EMAIL.trim().toLowerCase(),
        passwordHash: hashPassword(process.env.SPACIX_ADMIN_PASSWORD),
        displayName: process.env.SPACIX_ADMIN_NAME || "Platform Super Admin",
        isAdmin: true,
        emailVerified: true,
        roles: ["super_admin"],
        initialCredits: 1000,
        planId: "plan_studio",
      });
      console.log(`[auth] Provisioned Super Admin ${created.email} from environment`);
    } catch (err) {
      console.warn(`[auth] Failed provisioning admin from env: ${(err as Error).message}`);
    }
  }
  console.log(`[platform] store initialized (${platform.engine}) with ${apps.length} studio apps`);
})();

const server = createServer(async (req, res) => {
  try {
    await readyPromise;

    const url = new URL(req.url ?? "/", "http://local");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const isSecureCookie = !plainHttpToIp(req);

    // Webhooks use cryptographic signature verification
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "webhooks" && parts[2] === "fal") {
      const rawBody = await readRawBody(req, 5 * 2 ** 20);
      const fal = await providerManager.getFalProvider();
      const update = await fal.parseWebhook({ headers: req.headers, rawBody });
      if (update) {
        const updated = await history.applyWebhookUpdate(update);
        if (updated) await platform.syncHistoryEntry(updated).catch(() => {});
      }
      return send(res, 200, { ok: true });
    }

    const refusedOrigin = foreign(req, origins);
    if (refusedOrigin) return send(res, 403, { error: refusedOrigin });

    if (guard.passcode) {
      const key = url.searchParams.get("key");
      const cookie = key !== null ? guard.login(key, isSecureCookie) : null;
      if (cookie) {
        url.searchParams.delete("key");
        res.writeHead(303, { "set-cookie": cookie, location: url.pathname + url.search, "cache-control": "no-store" });
        return res.end();
      }
      if (!guard.admits(req.headers.cookie)) {
        if (parts[0] === "api") return send(res, 401, { error: "Workspace passcode required" });
        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(workspaceName ? ownerDoor(workspaceName, String(req.headers["accept-language"] ?? "")) : DOOR_HTML);
      }
    }

    const visitor = guard.visitor(req.headers.cookie, isSecureCookie);
    if (visitor.setCookie) res.setHeader("set-cookie", visitor.setCookie);

    const authSession = await authService.resolveRequestUser(req);
    const sessionUser = authSession?.user ?? null;
    const ownerScope = sessionUser ? sessionUser.id : visitor.id;

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
      return send(res, 200, {
        ok: true,
        apps: apps.length,
        engine: platform.engine,
      });
    }

    if (parts[0] === "api") {
      const [, area, id, sub, arg] = parts;

      // ---------------------------------------------------------------- Public Bootstrap & Announcements
      if (area === "bootstrap" && req.method === "GET") {
        return send(res, 200, await platform.getPublicBootstrap(sessionUser));
      }

      if (area === "announcements" && id === "active" && req.method === "GET") {
        return send(res, 200, { announcements: await platform.store.listAnnouncements(true) });
      }

      if (area === "plans" && req.method === "GET") {
        return send(res, 200, { plans: await platform.store.listPlans(true) });
      }

      // ---------------------------------------------------------------- Authentication Routes
      if (area === "auth") {
        if (id === "me" && req.method === "GET") {
          return send(res, 200, {
            user: sessionUser ? sanitizeUserForClient(sessionUser) : null,
            needs_admin_bootstrap: (await platform.store.countAdmins()) === 0,
          });
        }

        if (id === "register" && req.method === "POST") {
          const body = await readJsonBody(req);
          const result = await authService.register({
            email: String(body.email || ""),
            password: String(body.password || ""),
            displayName: String(body.display_name || ""),
            ipAddress: clientIpFromReq(req),
            userAgent: userAgentFromReq(req),
          });
          return send(
            res,
            201,
            {
              user: sanitizeUserForClient(result.user),
              token: result.token,
              verification_required: !result.user.email_verified,
            },
            { "set-cookie": buildSessionCookie(result.token, result.ttlSeconds, isSecureCookie) },
          );
        }

        if (id === "login" && req.method === "POST") {
          const body = await readJsonBody(req);
          const result = await authService.login({
            email: String(body.email || ""),
            password: String(body.password || ""),
            adminPortal: Boolean(body.admin_portal),
            ipAddress: clientIpFromReq(req),
            userAgent: userAgentFromReq(req),
          });
          return send(
            res,
            200,
            { user: sanitizeUserForClient(result.user), token: result.token },
            { "set-cookie": buildSessionCookie(result.token, result.ttlSeconds, isSecureCookie) },
          );
        }

        if (id === "bootstrap-admin" && req.method === "POST") {
          const body = await readJsonBody(req);
          const result = await authService.bootstrapSuperAdmin({
            email: String(body.email || ""),
            password: String(body.password || ""),
            displayName: String(body.display_name || "Platform Super Admin"),
            ipAddress: clientIpFromReq(req),
            userAgent: userAgentFromReq(req),
          });
          return send(
            res,
            201,
            { user: sanitizeUserForClient(result.user), token: result.token },
            { "set-cookie": buildSessionCookie(result.token, result.ttlSeconds, isSecureCookie) },
          );
        }

        if (id === "logout" && req.method === "POST") {
          await authService.logout(req);
          return send(res, 200, { ok: true }, { "set-cookie": clearSessionCookie(isSecureCookie) });
        }

        if (id === "verify-email" && req.method === "POST") {
          const body = await readJsonBody(req);
          const verified = await authService.verifyEmail(String(body.token || ""));
          return send(res, 200, { user: sanitizeUserForClient(verified) });
        }

        if (id === "request-reset" && req.method === "POST") {
          const body = await readJsonBody(req);
          await authService.requestPasswordReset(String(body.email || ""));
          return send(res, 200, { ok: true, message: "If an account exists for that email, a reset link has been dispatched." });
        }

        if (id === "reset-password" && req.method === "POST") {
          const body = await readJsonBody(req);
          const user = await authService.resetPassword(String(body.token || ""), String(body.password || ""));
          return send(res, 200, { ok: true, user: sanitizeUserForClient(user) });
        }
      }

      // ---------------------------------------------------------------- Authenticated User Account Routes
      if (area === "account") {
        if (!sessionUser) return send(res, 401, { error: "Sign in required." });
        if (id === "profile" && (req.method === "PATCH" || req.method === "PUT")) {
          const body = await readJsonBody(req);
          const updated = await platform.store.updateUser(sessionUser.id, {
            displayName: typeof body.display_name === "string" ? body.display_name.slice(0, 120) : undefined,
            profile: {
              ...(typeof body.company === "string" ? { company: body.company.slice(0, 160) } : {}),
              ...(typeof body.bio === "string" ? { bio: body.bio.slice(0, 500) } : {}),
              ...(typeof body.locale === "string" ? { locale: body.locale.slice(0, 16) } : {}),
              ...(typeof body.timezone === "string" ? { timezone: body.timezone.slice(0, 64) } : {}),
            },
          });
          return send(res, 200, { user: updated ? sanitizeUserForClient(updated) : null });
        }
        if (id === "password" && req.method === "POST") {
          const body = await readJsonBody(req);
          const updated = await authService.login({
            email: sessionUser.email || "",
            password: String(body.current_password || ""),
            ipAddress: clientIpFromReq(req),
            userAgent: userAgentFromReq(req),
          });
          if (updated) {
            const newPass = String(body.new_password || "");
            if (newPass.length < 8) throw new AuthError("New password must be at least 8 characters.", 400);
            await platform.store.updateUser(sessionUser.id, { passwordHash: hashPassword(newPass) });
          }
          return send(res, 200, { ok: true });
        }
      }

      if (area === "notifications") {
        if (!sessionUser) return send(res, 200, { notifications: [], unread: 0 });
        if (req.method === "GET" && !id) {
          const list = await platform.store.listUserNotifications(sessionUser.id, 50);
          return send(res, 200, { notifications: list, unread: list.filter((n) => !n.read_at).length });
        }
        if (req.method === "POST" && id === "read") {
          const body = await readJsonBody(req);
          await platform.store.markNotificationRead(sessionUser.id, body.id ? String(body.id) : undefined);
          return send(res, 200, { ok: true });
        }
      }

      if (area === "projects") {
        if (!sessionUser) return send(res, 200, { projects: [] });
        if (req.method === "GET") {
          return send(res, 200, { projects: await platform.store.listProjects(sessionUser.id) });
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          if (typeof body.name !== "string" || !body.name.trim()) throw new InputError("Project name is required.");
          const created = await platform.store.createProject(sessionUser.id, body.name, typeof body.description === "string" ? body.description : "");
          return send(res, 201, created);
        }
      }

      if (area === "credits" && req.method === "GET") {
        if (!sessionUser) return send(res, 200, { balance: 0, lifetime_granted: 0, lifetime_spent: 0, transactions: [] });
        return send(res, 200, await platform.store.getCreditSummary(sessionUser.id));
      }

      // ---------------------------------------------------------------- Admin Control Centre Routes (/api/admin/*)
      if (area === "admin") {
        if (!sessionUser || !sessionUser.is_admin) {
          return send(res, sessionUser ? 403 : 401, {
            error: sessionUser ? "Administrator access required." : "Sign in with an administrator account.",
          });
        }
        const handled = await handleAdminRoutes(req, res, url, parts, sessionUser, {
          platform,
          auth: authService,
          providers: providerManager,
          email: emailService,
          analytics: analyticsService,
          history,
          apps,
          readJsonBody,
          send,
          retryRun: async (genId, admin) => {
            const gen = await platform.store.getGeneration(genId);
            const histEntry = history.get(genId);
            const appId = gen?.app_id ?? histEntry?.app;
            const app = appId ? byId.get(appId) : undefined;
            if (!app) throw new InputError("Original application for this generation was not found.");
            const vals = (gen?.settings ?? histEntry?.values ?? {}) as Values;
            return startManagedRun({
              app,
              values: vals,
              preset: gen?.preset_id ?? histEntry?.preset ?? undefined,
              ownerId: gen?.user_id ?? admin.id,
              authenticatedUserId: gen?.user_id ?? admin.id,
            });
          },
        });
        if (handled) return;
      }

      // ---------------------------------------------------------------- Studio Apps Catalog (Sanitized for Regular Users)
      if (req.method === "GET" && area === "apps" && parts.length === 2) {
        const order = { image: 0, video: 1, audio: 2, utility: 3 } as Record<string, number>;
        const sorted = [...apps].sort(
          (a, b) => order[a.section] - order[b.section] || Number(b.status === "ready") - Number(a.status === "ready") || a.name.localeCompare(b.name),
        );
        const examples = loadExamples();
        const studioApps = await platform.store.listStudioApps();
        const studioMap = new Map(studioApps.map((s) => [s.id, s]));
        const allModels = await platform.store.listModels();
        const modelMap = new Map(allModels.map((m) => [m.id, m]));
        const providersList = await providerManager.listAdminProviders();
        const provReadyMap = new Map(providersList.map((p) => [p.id, p.runtime_available]));

        const visibleApps = [];
        for (const a of sorted) {
          const studioCfg = studioMap.get(a.id);
          if (studioCfg && !studioCfg.published && !sessionUser?.is_admin) continue;

          const exec = await platform.resolveAppExecution(a, sessionUser);
          const providerReady = exec.providerId ? Boolean(provReadyMap.get(exec.providerId)) : false;
          const runnable = exec.allowed && providerReady && (a.status === "ready" || draftsAllowed || Boolean(sessionUser?.is_admin));

          const assignedModels = (studioCfg?.model_ids ?? [])
            .map((mid) => modelMap.get(mid))
            .filter((m): m is NonNullable<typeof m> => Boolean(m && m.enabled))
            .map((m) => ({ id: m.id, name: m.display_name, credit_price: m.credit_price, category: m.category }));

          visibleApps.push({
            id: a.id,
            name: studioCfg?.name || a.name,
            section: a.section,
            summary: studioCfg?.summary ?? a.summary ?? "",
            thumbnail_url: studioCfg?.thumbnail_url ?? null,
            status: a.status,
            pack: a.pack,
            credit_cost: exec.creditCost,
            runnable,
            // Sanitized availability only — no API keys, server endpoints, or infra paths exposed
            availability: {
              supported: Boolean(exec.providerId && exec.endpoint),
              available: runnable,
              capability: exec.capability,
              modelName: exec.modelName,
              reason: !exec.allowed
                ? exec.reason
                : !providerReady
                  ? "Service is temporarily unavailable."
                  : null,
            },
            available_models: assignedModels,
            modes: a.modes ?? null,
            mode_label: a.mode_label ?? null,
            inputs: a.inputs.map(({ bind: _bind, options, ...rest }) => ({
              ...rest,
              ...(options ? { options: options.map(({ sets: _sets, ...o }) => o) } : {}),
            })),
            presets: studioCfg?.presets_override ?? (a.presets ?? []).map((p) => ({ id: p.id, label: p.label })),
            outputs: a.outputs.map((o) => ({ type: o.type, label: o.label ?? null })),
            models: a.models.map((m) => ({
              name: m.file.split("/").pop(),
              license: m.license ?? null,
              optional: Boolean(m.optional),
              phase: m.phase,
            })),
            credits: a.credits ?? [],
            notes: a.notes ?? null,
            example: examples[a.id] ?? null,
          });
        }
        return send(res, 200, {
          apps: visibleApps,
          drafts: draftsAllowed,
          hosted: guard.hosted,
        });
      }

      // ---------------------------------------------------------------- Run Generation
      if (req.method === "POST" && area === "apps" && sub === "run") {
        const app = byId.get(id);
        if (!app) return send(res, 404, { error: "Unknown app" });
        const refused = guard.refuse(activeRuns());
        if (refused) return send(res, 429, { error: refused });

        admitting++;
        let view;
        try {
          const parsed = await readValues(app, await toRequest(req));
          const resolved = resolveValues(app, parsed.values);
          const proj = parsed.projectId ?? url.searchParams.get("project_id");
          view = await startManagedRun({
            app,
            values: resolved,
            preset: parsed.preset,
            ownerId: ownerScope,
            authenticatedUserId: sessionUser?.id ?? null,
            projectId: proj,
            modelIdOverride: parsed.modelId,
          });
        } finally {
          admitting--;
        }
        guard.record();
        return send(res, 202, view);
      }

      // ---------------------------------------------------------------- History Feed & Media
      if (area === "history") {
        const effectiveOwner = sessionUser?.is_admin && url.searchParams.get("scope") === "all" ? undefined : ownerScope;
        if (req.method === "GET" && !id) {
          const appFilter = url.searchParams.get("app") || undefined;
          let entries = history.list(appFilter, 300, effectiveOwner);
          // Backfill local-owner legacy entries if authenticated admin asks for personal feed and has none yet
          if (!entries.length && sessionUser?.is_admin) {
            entries = history.list(appFilter, 300);
          }
          return send(res, 200, { entries });
        }
        if (req.method === "GET" && id && !sub) {
          const e = history.get(id, sessionUser?.is_admin ? undefined : ownerScope);
          return e ? send(res, 200, e) : send(res, 404, { error: "Unknown run" });
        }
        if ((req.method === "GET" || req.method === "HEAD") && sub === "files" && arg) {
          const file = history.file(id, arg, sessionUser?.is_admin ? undefined : ownerScope);
          return file ? sendFile(req, res, file, "private, max-age=31536000, immutable") : send(res, 404, { error: "Not found" });
        }
        if (req.method === "GET" && sub === "preview") {
          const p = history.preview(id, sessionUser?.is_admin ? undefined : ownerScope);
          if (!p) return send(res, 404, { error: "No preview" });
          res.writeHead(200, { "content-type": p.type, "content-length": p.bytes.byteLength, "cache-control": "no-store" });
          return res.end(p.bytes);
        }
        if (req.method === "POST" && sub === "cancel") {
          return send(res, 200, { canceled: await history.cancel(id, sessionUser?.is_admin ? undefined : ownerScope) });
        }
        if (req.method === "DELETE" && id && !sub) {
          const ok = history.remove(id, sessionUser?.is_admin ? undefined : ownerScope);
          if (ok) await platform.store.deleteGenerationRecord(id).catch(() => {});
          return send(res, ok ? 200 : 404, { removed: id });
        }
      }

      if (area === "flags" && parts.length === 2) {
        if (req.method === "GET") return send(res, 200, { mediocre: flags.list() });
        if (req.method === "POST") {
          if (guard.hosted && !sessionUser?.is_admin) return send(res, 403, { error: "Lab marks are read-only in hosted mode" });
          const body = await readJsonBody(req);
          if (typeof body.key !== "string" || typeof body.mediocre !== "boolean") {
            throw new InputError("Expected JSON { key, mediocre, note? }");
          }
          try {
            return send(res, 200, { mediocre: flags.set(body.key, body.mediocre, typeof body.note === "string" ? body.note : undefined) });
          } catch (e) {
            throw new InputError((e as Error).message);
          }
        }
      }

      return send(res, 404, { error: "Not found" });
    }

    // Static apps/ manifests
    if (parts[0] === "apps" && (req.method === "GET" || req.method === "HEAD")) {
      const appsRoot = resolve(root, "apps");
      const relApp = normalize(parts.slice(1).join("/")).replace(/^(\.\.[/\\])+/, "");
      const appFile = resolve(appsRoot, relApp);
      if (appFile.startsWith(appsRoot + "/") && existsSync(appFile) && statSync(appFile).isFile()) {
        return sendFile(req, res, appFile);
      }
      return send(res, 404, { error: "Not found" });
    }

    // Static web/
    const webRoot = resolve(root, "web");
    const rel = normalize(url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1))).replace(/^(\.\.[/\\])+/, "");
    const file = resolve(webRoot, rel);
    if ((file === webRoot || file.startsWith(webRoot + "/")) && existsSync(file) && statSync(file).isFile()) {
      return sendFile(req, res, file);
    }
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    const errObj = e as Error & { httpStatus?: number };
    const status = e instanceof InputError ? 400 : e instanceof AuthError ? e.httpStatus : (errObj.httpStatus ?? 500);
    if (status === 500) console.error(e);
    return send(res, status, { error: errObj.message });
  }
});

readyPromise.then(() => {
  history.resume(async (jobId, entry: Entry) => {
    if (!entry.provider || !entry.provider_endpoint) {
      throw new Error("Missing provider metadata for resuming run");
    }
    return providerManager.getJobForResume(entry.provider, jobId, entry.provider_endpoint);
  });
});

server.listen(port, host, () => {
  console.log(
    `spacix on http://${host}:${port} (${apps.length} apps)` +
      (guard.passcode ? " · passcode required" : "") +
      (guard.maxRunsPerDay ? ` · ${guard.maxRunsPerDay} runs/day` : ""),
  );
});
