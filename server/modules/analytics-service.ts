// Real database & runtime analytics calculator for the Admin Overview dashboard.
import type { MySqlClient } from "../db/client.ts";
import type { History } from "../history.ts";
import type { PlatformService } from "./platform-service.ts";
import type { ProviderManager } from "./provider-manager.ts";

export class AnalyticsService {
  private readonly platform: PlatformService;
  private readonly providers: ProviderManager;
  private readonly history: History;
  private readonly mysql: MySqlClient;

  constructor(opts: {
    platform: PlatformService;
    providers: ProviderManager;
    history: History;
    mysql: MySqlClient;
  }) {
    this.platform = opts.platform;
    this.providers = opts.providers;
    this.history = opts.history;
    this.mysql = opts.mysql;
  }

  async getOverview() {
    const store = this.platform.store;
    const { users } = await store.listUsers({ limit: 1000, offset: 0 });
    const realUsers = users.filter((u) => Boolean(u.email));
    const sessions = await store.listSessions({ activeOnly: true, limit: 500 });
    const now = Date.now();
    const dayAgo = now - 86_400_000;
    const weekAgo = now - 7 * 86_400_000;

    const onlineUserIds = new Set(
      sessions
        .filter((s) => now - new Date(s.last_seen_at).getTime() <= 15 * 60_000)
        .map((s) => s.user_id),
    );
    const activeUsers = realUsers.filter((u) => u.status === "active").length;
    const newRegistrations24h = realUsers.filter((u) => new Date(u.created_at).getTime() >= dayAgo).length;
    const newRegistrations7d = realUsers.filter((u) => new Date(u.created_at).getTime() >= weekAgo).length;

    const { generations } = await store.listGenerations({ limit: 2000, offset: 0 });
    const historyEntries = this.history.list(undefined, 500);
    const genMap = new Map(generations.map((g) => [g.id, g]));
    for (const h of historyEntries) {
      if (!genMap.has(h.id)) {
        genMap.set(h.id, {
          id: h.id,
          user_id: "usr_local_owner",
          project_id: h.project_id ?? null,
          app_id: h.app,
          provider_id: h.provider ?? null,
          provider_endpoint: h.provider_endpoint ?? null,
          provider_job_id: h.job ?? null,
          model_id: null,
          media_type: h.outputs?.[0]?.type === "video" ? "video" : h.outputs?.[0]?.type === "audio" ? "audio" : "image",
          status: h.status,
          prompt: typeof h.values?.prompt === "string" ? h.values.prompt : null,
          preset_id: h.preset,
          settings: h.values ?? {},
          inputs: h.inputs ?? [],
          outputs: h.outputs ?? [],
          error: h.error ?? null,
          credits_charged: 0,
          moderation_status: "clean",
          moderation_note: null,
          seconds: h.seconds,
          total_seconds: h.total,
          created_at: h.created,
          started_at: h.started,
          finished_at: h.finished,
        });
      }
    }
    const allGens = [...genMap.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const succeededGens = allGens.filter((g) => g.status === "succeeded").length;
    const failedGens = allGens.filter((g) => ["failed", "lost", "expired"].includes(g.status)).length;
    const activeGens = allGens.filter((g) => ["starting", "queued", "running"].includes(g.status)).length;
    const byMedia = {
      image: allGens.filter((g) => g.media_type === "image").length,
      video: allGens.filter((g) => g.media_type === "video").length,
      audio: allGens.filter((g) => g.media_type === "audio").length,
    };

    const providerLogs = await store.listProviderLogs(undefined, 500);
    const providerStats: Record<string, { requests: number; succeeded: number; failed: number; avgLatencyMs: number }> = {};
    for (const log of providerLogs) {
      const s = (providerStats[log.provider_id] ??= { requests: 0, succeeded: 0, failed: 0, avgLatencyMs: 0 });
      s.requests++;
      if (log.ok) s.succeeded++;
      else s.failed++;
      s.avgLatencyMs += log.duration_ms;
    }
    for (const s of Object.values(providerStats)) {
      s.avgLatencyMs = s.requests ? Math.round(s.avgLatencyMs / s.requests) : 0;
    }

    const txs = await store.listAllTransactions({ limit: 500 });
    const creditsConsumed = txs
      .filter((t) => t.delta < 0)
      .reduce((acc, t) => acc + Math.abs(t.delta), 0);
    const creditsGranted = txs
      .filter((t) => t.delta > 0)
      .reduce((acc, t) => acc + t.delta, 0);

    const payments = await store.listPayments({ limit: 500 });
    const confirmedRevenueCents = payments
      .filter((p) => p.status === "confirmed")
      .reduce((acc, p) => acc + p.amount_cents, 0);
    const subscriptions = await store.listSubscriptions();
    const activeSubscriptions = subscriptions.filter((s) => s.status === "active" || s.status === "trialing").length;

    const providerList = await this.providers.listAdminProviders();
    const dbStatus = await this.mysql.ping();
    const auditLogs = await store.listAuditLogs({ limit: 15 });

    return {
      users: {
        total: realUsers.length,
        active: activeUsers,
        suspended: realUsers.filter((u) => u.status === "suspended").length,
        new_24h: newRegistrations24h,
        new_7d: newRegistrations7d,
        online: onlineUserIds.size,
      },
      generations: {
        total: allGens.length,
        succeeded: succeededGens,
        failed: failedGens,
        active: activeGens,
        by_media: byMedia,
      },
      providers: {
        configured: providerList.filter((p) => p.runtime_configured).length,
        healthy: providerList.filter((p) => p.runtime_available).length,
        total: providerList.length,
        usage: providerStats,
      },
      credits: {
        consumed: creditsConsumed,
        granted: creditsGranted,
      },
      revenue: {
        confirmed_cents: confirmedRevenueCents,
        active_subscriptions: activeSubscriptions,
        recorded_payments: payments.length,
      },
      system_health: {
        store_engine: this.platform.engine,
        mysql: dbStatus,
        uptime_seconds: Math.round(process.uptime()),
      },
      recent: {
        registrations: realUsers.slice(0, 6).map((u) => ({
          id: u.id,
          email: u.email,
          display_name: u.display_name,
          created_at: u.created_at,
          roles: u.roles,
        })),
        generations: allGens.slice(0, 8).map((g) => ({
          id: g.id,
          app_id: g.app_id,
          user_id: g.user_id,
          media_type: g.media_type,
          status: g.status,
          credits_charged: g.credits_charged,
          created_at: g.created_at,
        })),
        admin_activity: auditLogs,
      },
    };
  }
}
