// Access control, visitor isolation, rate limits, and cross-site request guards for SPACIX.
// Supports SPACIX_* env vars (with legacy fallback aliases for existing deployments).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";

export type GuardOptions = {
  passcode?: string;
  maxRunsPerDay?: number;
  maxActive?: number;
  stateFile?: string;
  now?: () => Date;
  sharedHistory?: boolean;
};

const COOKIE = "ff_key";
const VISITOR = "ff_vid";
const VISITOR_ID = /^[0-9a-f]{32}$/;
const MONTH = 60 * 60 * 24 * 30;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class Guard {
  readonly passcode?: string;
  readonly maxRunsPerDay?: number;
  readonly maxActive?: number;
  readonly sharedHistory: boolean;
  private readonly stateFile?: string;
  private readonly now: () => Date;
  private readonly cookieValue?: string;
  private state: { day: string; runs: number };

  constructor(opts: GuardOptions = {}) {
    this.passcode = opts.passcode || undefined;
    this.maxRunsPerDay = opts.maxRunsPerDay && opts.maxRunsPerDay > 0 ? opts.maxRunsPerDay : undefined;
    this.maxActive = opts.maxActive && opts.maxActive > 0 ? opts.maxActive : undefined;
    this.sharedHistory = Boolean(opts.sharedHistory);
    this.stateFile = opts.stateFile;
    this.now = opts.now ?? (() => new Date());
    this.cookieValue = this.passcode ? createHmac("sha256", this.passcode).update("spacix-visitor").digest("hex") : undefined;
    this.state = this.load();
  }

  static fromEnv(stateFile: string, env: NodeJS.ProcessEnv = process.env): Guard {
    const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    const passcode = env.SPACIX_PASSCODE ?? env.FREEFIELD_PASSCODE;
    const maxRunsPerDay = num(env.SPACIX_MAX_RUNS_PER_DAY ?? env.FREEFIELD_MAX_RUNS_PER_DAY);
    const maxActive = num(env.SPACIX_MAX_ACTIVE ?? env.FREEFIELD_MAX_ACTIVE);
    const sharedHistory = (env.SPACIX_SHARED_HISTORY ?? env.FREEFIELD_SHARED_HISTORY) === "1";
    return new Guard({ passcode, maxRunsPerDay, maxActive, stateFile, sharedHistory });
  }

  get hosted(): boolean {
    return Boolean(this.passcode || this.maxRunsPerDay || this.maxActive);
  }

  admits(cookieHeader: string | undefined): boolean {
    if (!this.cookieValue) return true;
    const got = parseCookies(cookieHeader)[COOKIE];
    return Boolean(got) && same(got, this.cookieValue);
  }

  login(key: string | null, secure = true): string | null {
    if (!this.passcode || !key || !same(key, this.passcode)) return null;
    return `${COOKIE}=${this.cookieValue}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=${MONTH}`;
  }

  visitor(cookieHeader: string | undefined, secure = true): { id?: string; setCookie?: string } {
    if (!this.passcode || this.sharedHistory) return {};
    const got = parseCookies(cookieHeader)[VISITOR];
    if (got && VISITOR_ID.test(got)) return { id: got };
    const id = randomBytes(16).toString("hex");
    return { id, setCookie: `${VISITOR}=${id}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=${MONTH}` };
  }

  refuse(active: number): string | null {
    this.roll();
    if (this.maxActive && active >= this.maxActive) {
      return `${active} run(s) are still going (limit ${this.maxActive} at a time); try again when one finishes`;
    }
    if (this.maxRunsPerDay && this.state.runs >= this.maxRunsPerDay) {
      return `The ${this.maxRunsPerDay} daily runs (UTC) limit has been reached; resets at 00:00 UTC`;
    }
    return null;
  }

  record(): void {
    this.roll();
    this.state.runs += 1;
    this.save();
  }

  status(active: number) {
    this.roll();
    return {
      runs_today: this.state.runs,
      max_runs_per_day: this.maxRunsPerDay ?? null,
      max_active: this.maxActive ?? null,
      runs_left: this.maxRunsPerDay ? Math.max(0, this.maxRunsPerDay - this.state.runs) : null,
      active,
    };
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private roll(): void {
    if (this.state.day !== this.today()) this.state = { day: this.today(), runs: 0 };
  }

  private load(): { day: string; runs: number } {
    try {
      if (this.stateFile && existsSync(this.stateFile)) {
        const s = JSON.parse(readFileSync(this.stateFile, "utf-8"));
        if (typeof s.day === "string" && Number.isInteger(s.runs)) return { day: s.day, runs: s.runs };
      }
    } catch { /* start fresh on damaged state file */ }
    return { day: this.today(), runs: 0 };
  }

  private save(): void {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state) + "\n");
    renameSync(tmp, this.stateFile);
  }
}

export function foreign(
  req: { method?: string; headers: Record<string, string | string[] | undefined> },
  opts: { loopbackOnly: boolean; allowedHosts?: string[] },
): string | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const host = one(req.headers.host).toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  if (opts.loopbackOnly && !LOOPBACK.has(hostname) && !(opts.allowedHosts ?? []).includes(hostname)) {
    return `this server only answers to localhost (Host: ${host || "none"}); add the name to SPACIX_ALLOWED_HOSTS to allow it`;
  }
  if (["GET", "HEAD", "OPTIONS"].includes((req.method ?? "GET").toUpperCase())) return null;
  const site = one(req.headers["sec-fetch-site"]).toLowerCase();
  if (site === "cross-site") return "requests from other sites are refused";
  if (site === "same-origin") return null;
  const origin = one(req.headers.origin);
  if (origin) {
    let originHost: string;
    try { originHost = new URL(origin).host.toLowerCase(); } catch { return "requests from other sites are refused"; }
    const fwdHost = one(req.headers["x-forwarded-host"]).split(",")[0].trim().toLowerCase();
    if (originHost !== host && (!fwdHost || originHost !== fwdHost)) return "requests from other sites are refused";
  }
  return null;
}

export function plainHttpToIp(req: { headers: Record<string, string | string[] | undefined>; socket?: object }): boolean {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted || /https/i.test(one(req.headers["x-forwarded-proto"]))) return false;
  const host = one(req.headers.host).toLowerCase();
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return isIP(name) !== 0 && !LOOPBACK.has(name);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const DOOR_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SPACIX</title>
<link rel="icon" href="https://spacix.ticketplaster.com/brand/logo.png">
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090a;color:#f4f4f2;font:15px/1.5 system-ui,sans-serif}
form{display:grid;gap:12px;width:min(320px,calc(100vw - 32px))}.door-brand{display:flex;align-items:center;gap:10px}.door-logo{display:block;height:clamp(26px,5vw,36px);width:auto;max-width:160px;object-fit:contain}h1{margin:0;font-size:22px}p{margin:0;color:#9b9ba3}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #2e2e33;background:#151517;color:inherit}
button{background:#38bdf8;color:#06131f;border:0;font-weight:600;cursor:pointer}button:hover{background:#7dd3fc}</style></head>
<body><form method="get" action="/"><div class="door-brand"><img class="door-logo" src="https://spacix.ticketplaster.com/brand/logo.png" alt="SPACIX"><h1>SPACIX</h1></div><p>This workspace is private. Enter the passcode you were given.</p>
<input name="key" type="password" autocomplete="current-password" aria-label="Passcode" required autofocus><button>Open</button></form></body></html>`;

export function ownerDoor(workspaceName: string, acceptLanguage = ""): string {
  if (!workspaceName) return DOOR_HTML;
  const es = /^es\b/i.test(acceptLanguage.trim());
  const text = es
    ? `Este espacio de SPACIX (${workspaceName}) es privado. Escribe la clave de acceso configurada en el servidor.`
    : `This SPACIX workspace (${workspaceName}) is private. Enter the passcode configured on the server.`;
  return DOOR_HTML
    .replace("This workspace is private. Enter the passcode you were given.", text)
    .replace('<html lang="en">', `<html lang="${es ? "es" : "en"}">`)
    .replace(">Open</button>", es ? ">Abrir</button>" : ">Open</button>");
}
