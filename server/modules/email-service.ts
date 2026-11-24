// Real email delivery service (SMTP over Node net/tls or configured HTTPS webhook) with authentic email_logs persistence.
import net from "node:net";
import tls from "node:tls";
import type { PlatformService } from "./platform-service.ts";

export type EmailConfig = {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password?: string;
  from: string;
  secure: boolean;
  webhookUrl?: string;
};

async function sendSmtpDirect(cfg: EmailConfig, to: string, subject: string, body: string): Promise<void> {
  const port = Number(cfg.port || 587);
  const useTls = Boolean(cfg.secure || port === 465);

  const socket: net.Socket | tls.TLSSocket = await new Promise((resolve, reject) => {
    const s = useTls
      ? tls.connect({ host: cfg.host, port, timeout: 10_000 }, () => resolve(s))
      : net.connect({ host: cfg.host, port, timeout: 10_000 }, () => resolve(s));
    s.on("error", reject);
    s.on("timeout", () => { s.destroy(); reject(new Error("SMTP connection timed out")); });
  });

  const readReply = () =>
    new Promise<{ code: number; text: string }>((resolve, reject) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        const lines = buf.split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1];
        if (last && /^\d{3} /.test(last)) {
          cleanup();
          resolve({ code: Number(last.slice(0, 3)), text: buf.trim() });
        }
      };
      const onErr = (e: Error) => { cleanup(); reject(e); };
      const cleanup = () => { socket.off("data", onData); socket.off("error", onErr); };
      socket.on("data", onData);
      socket.on("error", onErr);
    });

  const cmd = async (line: string, expectPrefix: number) => {
    socket.write(`${line}\r\n`);
    const rep = await readReply();
    if (Math.floor(rep.code / 100) !== expectPrefix) {
      throw new Error(`SMTP error on "${line.split(" ")[0]}": ${rep.text}`);
    }
    return rep;
  };

  try {
    const greet = await readReply();
    if (greet.code !== 220) throw new Error(`Unexpected SMTP greeting: ${greet.text}`);
    await cmd(`EHLO spacix.local`, 2);

    if (cfg.user && cfg.password) {
      const token = Buffer.from(`\0${cfg.user}\0${cfg.password}`).toString("base64");
      await cmd(`AUTH PLAIN ${token}`, 2);
    }

    const fromAddr = cfg.from || cfg.user;
    await cmd(`MAIL FROM:<${fromAddr}>`, 2);
    await cmd(`RCPT TO:<${to}>`, 2);
    await cmd("DATA", 3);
    const msg = [
      `From: ${fromAddr}`,
      `To: ${to}`,
      `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body.replace(/\r?\n\./g, "\r\n.."),
      ".",
    ].join("\r\n");
    await cmd(msg, 2);
    await cmd("QUIT", 2).catch(() => {});
  } finally {
    socket.end();
  }
}

export class EmailService {
  private readonly platform: PlatformService;

  constructor(platform: PlatformService) {
    this.platform = platform;
  }

  async resolveConfig(): Promise<EmailConfig> {
    const settings = await this.platform.getSettingsMap(false);
    const dbCfg = (settings.email_config ?? {}) as Record<string, unknown>;
    const host = String(dbCfg.host || process.env.SMTP_HOST || "").trim();
    const user = String(dbCfg.user || process.env.SMTP_USER || "").trim();
    const password = String(dbCfg.password || process.env.SMTP_PASSWORD || "").trim();
    const from = String(dbCfg.from || process.env.SMTP_FROM || user || "").trim();
    const port = Number(dbCfg.port || process.env.SMTP_PORT || 587);
    const secure = Boolean(dbCfg.secure ?? (process.env.SMTP_SECURE === "true"));
    const webhookUrl = String(dbCfg.webhookUrl || process.env.EMAIL_WEBHOOK_URL || "").trim() || undefined;
    const enabled = Boolean((dbCfg.enabled ?? Boolean(host || webhookUrl)) && (host || webhookUrl));
    return { enabled, host, port, user, password, from, secure, webhookUrl };
  }

  async sendEmail(input: {
    recipientUserId?: string | null;
    recipientEmail: string;
    subject: string;
    body: string;
    templateKey?: string | null;
    sentByAdminId?: string | null;
  }) {
    const cfg = await this.resolveConfig();
    if (!cfg.enabled) {
      return this.platform.store.recordEmailLog({
        recipient_user_id: input.recipientUserId ?? null,
        recipient_email: input.recipientEmail,
        subject: input.subject,
        template_key: input.templateKey ?? null,
        status: "unconfigured",
        error_message: "Email delivery is not configured (set SMTP or webhook settings in Admin > Settings).",
        sent_by_admin_id: input.sentByAdminId ?? null,
      });
    }

    try {
      if (cfg.webhookUrl) {
        const res = await fetch(cfg.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: input.recipientEmail, from: cfg.from, subject: input.subject, text: input.body }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Email webhook returned HTTP ${res.status}`);
      } else {
        await sendSmtpDirect(cfg, input.recipientEmail, input.subject, input.body);
      }

      return this.platform.store.recordEmailLog({
        recipient_user_id: input.recipientUserId ?? null,
        recipient_email: input.recipientEmail,
        subject: input.subject,
        template_key: input.templateKey ?? null,
        status: "sent",
        error_message: null,
        sent_by_admin_id: input.sentByAdminId ?? null,
      });
    } catch (err) {
      return this.platform.store.recordEmailLog({
        recipient_user_id: input.recipientUserId ?? null,
        recipient_email: input.recipientEmail,
        subject: input.subject,
        template_key: input.templateKey ?? null,
        status: "failed",
        error_message: (err as Error).message.slice(0, 480),
        sent_by_admin_id: input.sentByAdminId ?? null,
      });
    }
  }
}
