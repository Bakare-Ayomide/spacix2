// Parameterized MySQL repositories synchronized with the full 36-table SPACIX SaaS schema.
import { randomUUID } from "node:crypto";
import type { Entry } from "../history.ts";
import type { MySqlClient, QueryExecutor } from "./client.ts";

export type UserRecord = {
  id: string;
  visitor_key: string | null;
  email: string | null;
  display_name: string;
};

export type ProjectRecord = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  created_at: string;
};

export type CreditSummary = {
  user_id: string;
  balance: number;
  transactions: {
    id: string;
    generation_id: string | null;
    delta: number;
    reason: string;
    reference_id: string | null;
    created_at: string;
  }[];
};

function toMysqlDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 23).replace("T", " ");
}

export class DatabaseStore {
  private readonly client: MySqlClient | null;
  private readonly exec: QueryExecutor;

  constructor(client: MySqlClient | QueryExecutor | null) {
    if (client && "execute" in client) {
      this.exec = client;
      this.client = "withTransaction" in client ? (client as MySqlClient) : null;
    } else {
      this.client = null;
      this.exec = {
        async execute() {
          throw new Error("MySQL database is not configured.");
        },
      };
    }
  }

  get configured(): boolean {
    return this.client ? this.client.configured : true;
  }

  async ensureUser(visitorKey?: string): Promise<UserRecord> {
    const key = visitorKey || "local-owner";
    const [rows] = await this.exec.execute<UserRecord[]>(
      "SELECT id, visitor_key, email, display_name FROM users WHERE visitor_key = ? LIMIT 1",
      [key],
    );
    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0];
    }
    const id = visitorKey ? `usr_${visitorKey.slice(0, 24)}` : "usr_local_owner";
    const name = visitorKey ? "Studio Guest" : "Studio Owner";
    await this.exec.execute(
      "INSERT IGNORE INTO users (id, visitor_key, display_name) VALUES (?, ?, ?)",
      [id, key, name],
    );
    await this.exec.execute("INSERT IGNORE INTO user_profiles (user_id) VALUES (?)", [id]);
    await this.exec.execute("INSERT IGNORE INTO credit_wallets (user_id, balance) VALUES (?, ?)", [id, 0]);
    await this.exec.execute(
      "INSERT IGNORE INTO user_projects (id, user_id, name, description) VALUES (?, ?, ?, ?)",
      [`prj_${id}`, id, "Default Project", "Primary workspace project"],
    );
    return { id, visitor_key: key, email: null, display_name: name };
  }

  async listProjects(userId: string): Promise<ProjectRecord[]> {
    const [rows] = await this.exec.execute<ProjectRecord[]>(
      "SELECT id, user_id, name, description, created_at FROM user_projects WHERE user_id = ? ORDER BY created_at DESC",
      [userId],
    );
    return Array.isArray(rows) ? rows : [];
  }

  async createProject(userId: string, name: string, description = ""): Promise<ProjectRecord> {
    const id = `prj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const cleanName = name.trim().slice(0, 120);
    const cleanDesc = description.trim().slice(0, 500);
    await this.exec.execute(
      "INSERT INTO user_projects (id, user_id, name, description) VALUES (?, ?, ?, ?)",
      [id, userId, cleanName, cleanDesc],
    );
    return { id, user_id: userId, name: cleanName, description: cleanDesc, created_at: new Date().toISOString() };
  }

  async syncGeneration(
    entry: Entry,
    meta: { prompt?: string; projectId?: string | null; owner?: string; mediaType?: "image" | "video" | "audio" } = {},
  ): Promise<void> {
    const isDirectUserId = meta.owner?.startsWith("usr_");
    let userId = meta.owner ?? entry.owner ?? "usr_local_owner";
    if (!isDirectUserId) {
      const user = await this.ensureUser(meta.owner ?? entry.owner);
      userId = user.id;
    }

    const promptText = typeof meta.prompt === "string"
      ? meta.prompt
      : typeof entry.values?.prompt === "string"
        ? entry.values.prompt
        : typeof entry.values?.instruction === "string"
          ? entry.values.instruction
          : null;
    const mediaType = meta.mediaType ?? (entry.outputs?.[0]?.type === "video" || entry.outputs?.[0]?.type === "audio" ? entry.outputs[0].type : "image");

    await this.exec.execute(
      `INSERT INTO user_generations
        (id, user_id, project_id, app_id, provider_id, media_type, status, prompt, preset_id,
         settings_json, error_json, seconds, total_seconds, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         provider_id = VALUES(provider_id),
         status = VALUES(status),
         error_json = VALUES(error_json),
         seconds = VALUES(seconds),
         total_seconds = VALUES(total_seconds),
         started_at = VALUES(started_at),
         finished_at = VALUES(finished_at)`,
      [
        entry.id,
        userId,
        meta.projectId ?? entry.project_id ?? null,
        entry.app,
        entry.provider ?? null,
        mediaType,
        entry.status,
        promptText,
        entry.preset,
        JSON.stringify(entry.values ?? {}),
        entry.error ? JSON.stringify(entry.error) : null,
        entry.seconds,
        entry.total,
        toMysqlDate(entry.created) ?? toMysqlDate(new Date().toISOString()),
        toMysqlDate(entry.started),
        toMysqlDate(entry.finished),
      ],
    );

    if (entry.provider && entry.provider_endpoint) {
      const jobStatus = ["queued", "running", "succeeded", "failed", "canceled", "expired"].includes(entry.status) ? entry.status : "queued";
      await this.exec.execute(
        `INSERT INTO generation_jobs (id, generation_id, provider_id, provider_endpoint, external_job_id, status, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE external_job_id = VALUES(external_job_id), status = VALUES(status), error_message = VALUES(error_message)`,
        [`gj_${entry.id}`, entry.id, entry.provider, entry.provider_endpoint, entry.job, jobStatus, entry.error?.message ?? null],
      );
    }

    for (const inp of entry.inputs ?? []) {
      const assetId = `${entry.id}_in_${inp.id}`;
      const mType = inp.type === "video" || inp.type === "audio" ? inp.type : "image";
      await this.exec.execute(
        "INSERT IGNORE INTO generation_inputs (id, generation_id, input_key, media_type, file_name, storage_path) VALUES (?, ?, ?, ?, ?, ?)",
        [assetId, entry.id, inp.id, mType, inp.name, inp.file],
      );
      await this.exec.execute(
        "INSERT IGNORE INTO media_assets (id, user_id, generation_id, role, input_id, media_type, file_name, local_path) VALUES (?, ?, ?, 'input', ?, ?, ?, ?)",
        [assetId, userId, entry.id, inp.id, mType, inp.name, inp.file],
      );
    }

    for (let idx = 0; idx < (entry.outputs ?? []).length; idx++) {
      const out = entry.outputs[idx];
      const assetId = `${entry.id}_out_${idx}`;
      const mType = out.type === "video" || out.type === "audio" ? out.type : "image";
      const remoteUrl = out.url ?? null;
      await this.exec.execute(
        `INSERT INTO generation_outputs (id, generation_id, media_type, file_name, storage_path, remote_url)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE remote_url = COALESCE(VALUES(remote_url), remote_url)`,
        [assetId, entry.id, mType, out.name, out.file, remoteUrl],
      );
      await this.exec.execute(
        `INSERT INTO media_assets (id, user_id, generation_id, role, input_id, media_type, file_name, local_path, remote_url)
         VALUES (?, ?, ?, 'output', NULL, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE remote_url = COALESCE(VALUES(remote_url), remote_url)`,
        [assetId, userId, entry.id, mType, out.name, out.file, remoteUrl],
      );
    }
  }

  async getCredits(userId: string): Promise<CreditSummary> {
    const [balRows] = await this.exec.execute<{ balance: number }[]>(
      "SELECT balance FROM credit_wallets WHERE user_id = ? LIMIT 1",
      [userId],
    );
    const balance = Array.isArray(balRows) && balRows.length ? Number(balRows[0].balance) : 0;
    const [txRows] = await this.exec.execute<CreditSummary["transactions"]>(
      "SELECT id, generation_id, delta, reason, reference_id, created_at FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
      [userId],
    );
    return {
      user_id: userId,
      balance,
      transactions: Array.isArray(txRows) ? txRows : [],
    };
  }

  async recordCreditTransaction(args: {
    userId: string;
    delta: number;
    reason: string;
    generationId?: string | null;
    referenceId?: string | null;
  }): Promise<{ balance: number }> {
    const txId = `ctx_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const run = async (q: QueryExecutor) => {
      await q.execute("INSERT IGNORE INTO credit_wallets (user_id, balance) VALUES (?, 0)", [args.userId]);
      const [rows] = await q.execute<{ balance: number; lifetime_granted: number; lifetime_spent: number }[]>(
        "SELECT balance, lifetime_granted, lifetime_spent FROM credit_wallets WHERE user_id = ? FOR UPDATE",
        [args.userId],
      );
      const cur = Array.isArray(rows) && rows.length ? rows[0] : { balance: 0, lifetime_granted: 0, lifetime_spent: 0 };
      const delta = Math.trunc(args.delta);
      const next = Number(cur.balance) + delta;
      if (next < 0) throw new Error("Insufficient credit balance");
      await q.execute(
        "UPDATE credit_wallets SET balance = ?, lifetime_granted = ?, lifetime_spent = ? WHERE user_id = ?",
        [
          next,
          Number(cur.lifetime_granted ?? 0) + (delta > 0 ? delta : 0),
          Number(cur.lifetime_spent ?? 0) + (delta < 0 ? Math.abs(delta) : 0),
          args.userId,
        ],
      );
      await q.execute(
        "INSERT INTO credit_transactions (id, user_id, generation_id, tx_type, delta, balance_after, reason, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [txId, args.userId, args.generationId ?? null, delta >= 0 ? "grant" : "usage", delta, next, args.reason, args.referenceId ?? null],
      );
      return { balance: next };
    };

    if (this.client) return this.client.withTransaction(run);
    return run(this.exec);
  }
}
