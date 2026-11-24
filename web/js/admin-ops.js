// Admin Control Centre Modules G-K + shared modal/table helpers.
import { api, el, icon, toast } from "./util.js";
import { t, ago } from "./i18n.js";

export function adminModal(title, buildBody) {
  const box = el("div", { class: "adm-modal-card", role: "dialog", "aria-modal": "true" });
  const shade = el("div", { class: "auth-shade" }, box);
  const close = () => {
    shade.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  shade.addEventListener("pointerdown", (e) => { if (e.target === shade) close(); });

  const body = buildBody(close);
  box.replaceChildren(
    el("div", { class: "mhead" },
      el("h3", { style: { margin: 0, fontSize: "17px" } }, title),
      el("button", { class: "icon-btn", type: "button", "aria-label": t("act.close"), onclick: close }, icon("x"))),
    body);
  document.body.append(shade);
  document.addEventListener("keydown", onKey, true);
  return close;
}

export function fmtMoney(cents, currency = "USD") {
  return `${currency} ${(Number(cents || 0) / 100).toFixed(2)}`;
}

export function statusChip(status) {
  const s = String(status || "");
  const cls = ["active", "succeeded", "confirmed", "healthy", "sent", "clean"].includes(s)
    ? "ok"
    : ["suspended", "failed", "deactivated", "removed", "unhealthy", "revoked"].includes(s)
      ? "bad"
      : ["pending", "queued", "running", "flagged", "trialing", "past_due"].includes(s)
        ? "warn"
        : "faint";
  return el("span", { class: `chip ${cls}` }, s || "—");
}

// ---------------------------------------------------------------- G. Generation & Content Management

export function renderGenerations(host, { canManage }) {
  const state = { search: "", status: "", mediaType: "", total: 0, generations: [] };

  async function load() {
    const qs = new URLSearchParams();
    if (state.search) qs.set("search", state.search);
    if (state.status) qs.set("status", state.status);
    if (state.mediaType) qs.set("media_type", state.mediaType);
    const d = await api(`/api/admin/generations?${qs.toString()}`);
    state.total = d.total ?? 0;
    state.generations = d.generations || [];
    draw();
  }

  function inspectGen(g) {
    adminModal(`${g.app_id} · ${g.id}`, (close) => {
      const noteIn = el("input", { type: "text", value: g.moderation_note || "", placeholder: "Moderation note" });
      return el("div", { style: { display: "grid", gap: "12px" } },
        el("dl", { class: "vals" },
          el("dt", {}, "User ID"), el("dd", {}, g.user_id),
          el("dt", {}, "Status"), el("dd", {}, g.status),
          el("dt", {}, "Provider"), el("dd", {}, `${g.provider_id || "—"} (${g.provider_endpoint || "—"})`),
          el("dt", {}, "Credits"), el("dd", {}, String(g.credits_charged ?? 0)),
          el("dt", {}, "Moderation"), el("dd", {}, g.moderation_status || "clean"),
          el("dt", {}, "Created"), el("dd", {}, g.created_at)),
        g.prompt ? el("div", {}, el("b", {}, "Prompt"), el("pre", { class: "code" }, g.prompt)) : null,
        g.error ? el("div", {}, el("b", { style: { color: "var(--bad)" } }, "Error"), el("pre", { class: "code" }, JSON.stringify(g.error, null, 2))) : null,
        g.outputs?.length ? el("div", {}, el("b", {}, "Outputs"), el("pre", { class: "code" }, JSON.stringify(g.outputs, null, 2))) : null,
        canManage ? el("div", { style: { display: "grid", gap: "8px", borderTop: "1px solid var(--line)", paddingTop: "10px" } },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Moderation Note"), noteIn),
          el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
            el("button", {
              class: "btn small", type: "button",
              onclick: async () => {
                await api(`/api/admin/generations/${g.id}/moderate`, {
                  method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ moderation_status: "clean", note: noteIn.value }),
                });
                toast("Marked clean"); close(); load();
              },
            }, "Mark Clean"),
            el("button", {
              class: "btn small ghost", type: "button",
              onclick: async () => {
                await api(`/api/admin/generations/${g.id}/moderate`, {
                  method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ moderation_status: "flagged", note: noteIn.value }),
                });
                toast("Flagged"); close(); load();
              },
            }, "Flag"),
            el("button", {
              class: "btn small ghost danger", type: "button",
              onclick: async () => {
                await api(`/api/admin/generations/${g.id}/moderate`, {
                  method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ moderation_status: "removed", note: noteIn.value }),
                });
                toast("Removed from visibility"); close(); load();
              },
            }, "Remove"))) : null);
    });
  }

  function draw() {
    const searchIn = el("input", {
      type: "search", value: state.search, placeholder: "Search prompt, user, app…",
      onkeydown: (e) => { if (e.key === "Enter") { state.search = searchIn.value.trim(); load(); } },
    });
    const statusSel = el("select", {
      class: "adm-select",
      onchange: () => { state.status = statusSel.value; load(); },
    }, ...["", "queued", "running", "succeeded", "failed", "canceled"].map((s) =>
      el("option", { value: s, selected: state.status === s }, s || "All statuses")));
    const mediaSel = el("select", {
      class: "adm-select",
      onchange: () => { state.mediaType = mediaSel.value; load(); },
    }, ...["", "image", "video", "audio"].map((m) =>
      el("option", { value: m, selected: state.mediaType === m }, m || "All media")));

    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "Generations & Content"), el("p", { class: "dim" }, `${state.total} total records`)),
        el("div", { class: "adm-toolbar" },
          el("div", { class: "search" }, icon("search"), searchIn),
          statusSel, mediaSel,
          el("button", { class: "btn small", type: "button", onclick: () => { state.search = searchIn.value.trim(); load(); } }, icon("refresh"), "Refresh"))),
      el("div", { class: "adm-table-wrap" },
        el("table", { class: "adm-table" },
          el("thead", {}, el("tr", {},
            el("th", {}, "ID / App"), el("th", {}, "User"), el("th", {}, "Media"), el("th", {}, "Status"),
            el("th", {}, "Moderation"), el("th", {}, "Credits"), el("th", {}, "Created"), el("th", {}, "Actions"))),
          el("tbody", {}, ...state.generations.map((g) => el("tr", {},
            el("td", {}, el("b", {}, g.app_id), el("div", { class: "dim", style: { fontSize: "11.5px" } }, g.prompt ? g.prompt.slice(0, 48) : g.id)),
            el("td", {}, el("code", {}, g.user_id.slice(0, 14))),
            el("td", {}, g.media_type),
            el("td", {}, statusChip(g.status)),
            el("td", {}, statusChip(g.moderation_status || "clean")),
            el("td", { class: "num" }, String(g.credits_charged ?? 0)),
            el("td", { class: "dim" }, ago(g.created_at)),
            el("td", {}, el("div", { class: "adm-acts" },
              el("button", { class: "btn small ghost", type: "button", onclick: () => inspectGen(g) }, "Inspect"),
              canManage && g.status === "failed" ? el("button", {
                class: "btn small", type: "button",
                onclick: async () => { await api(`/api/admin/generations/${g.id}/retry`, { method: "POST" }); toast("Retry queued"); load(); },
              }, "Retry") : null,
              canManage && ["queued", "running", "starting"].includes(g.status) ? el("button", {
                class: "btn small ghost", type: "button",
                onclick: async () => { await api(`/api/admin/generations/${g.id}/cancel`, { method: "POST" }); toast("Canceled"); load(); },
              }, "Cancel") : null,
              canManage ? el("button", {
                class: "btn small ghost danger", type: "button",
                onclick: async () => { await api(`/api/admin/generations/${g.id}`, { method: "DELETE" }); toast("Deleted"); load(); },
              }, icon("trash")) : null)))))));
  }

  load().catch((err) => toast(err.message, { error: true }));
}

// ---------------------------------------------------------------- H. Credits, Plans, Subscriptions, Payments

export function renderBilling(host, { canWriteCredits, canManageSubs }) {
  let tab = "transactions";
  const data = { transactions: [], plans: [], subscriptions: [], payments: [] };

  async function load() {
    const [txRes, planRes, subRes, payRes] = await Promise.all([
      api("/api/admin/credits/transactions").catch(() => ({ transactions: [] })),
      api("/api/admin/plans").catch(() => ({ plans: [] })),
      api("/api/admin/subscriptions").catch(() => ({ subscriptions: [] })),
      api("/api/admin/payments").catch(() => ({ payments: [] })),
    ]);
    data.transactions = txRes.transactions || [];
    data.plans = planRes.plans || [];
    data.subscriptions = subRes.subscriptions || [];
    data.payments = payRes.payments || [];
    draw();
  }

  function openPlanModal(existing = null) {
    adminModal(existing ? `Edit Plan: ${existing.name}` : "Create Subscription Plan", (close) => {
      const codeIn = el("input", { type: "text", value: existing?.code || "", placeholder: "pro_plus" });
      const nameIn = el("input", { type: "text", value: existing?.name || "", placeholder: "Studio Pro" });
      const descIn = el("input", { type: "text", value: existing?.description || "" });
      const priceIn = el("input", { type: "number", value: String(existing?.price_cents ?? 1900) });
      const intervalSel = el("select", { class: "adm-select" },
        ...["month", "year", "one_time"].map((i) => el("option", { value: i, selected: existing?.billing_interval === i }, i)));
      const credIn = el("input", { type: "number", value: String(existing?.monthly_credits ?? 500) });
      const jobsIn = el("input", { type: "number", value: String(existing?.max_active_jobs ?? 4) });
      const dailyIn = el("input", { type: "number", value: existing?.max_daily_runs != null ? String(existing.max_daily_runs) : "" });
      const enabledCb = el("input", { type: "checkbox", checked: existing ? existing.enabled : true });

      return el("div", { style: { display: "grid", gap: "10px" } },
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Code"), codeIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Name"), nameIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Description"), descIn),
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Price (cents)"), priceIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Interval"), intervalSel)),
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Monthly Credits"), credIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Max Active Jobs"), jobsIn)),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Max Daily Runs (blank = unlimited)"), dailyIn),
        el("label", { class: "togrow" }, el("span", {}, "Enabled"), el("span", { class: "switch" }, enabledCb, el("i"))),
        el("button", {
          class: "btn lime", type: "button",
          onclick: async () => {
            try {
              const url = existing ? `/api/admin/plans/${existing.id}` : "/api/admin/plans";
              await api(url, {
                method: existing ? "PATCH" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  code: codeIn.value.trim(),
                  name: nameIn.value.trim(),
                  description: descIn.value.trim(),
                  price_cents: Number(priceIn.value),
                  billing_interval: intervalSel.value,
                  monthly_credits: Number(credIn.value),
                  max_active_jobs: Number(jobsIn.value),
                  max_daily_runs: dailyIn.value.trim() === "" ? null : Number(dailyIn.value),
                  enabled: enabledCb.checked,
                }),
              });
              toast("Plan saved"); close(); load();
            } catch (err) { toast(err.message, { error: true }); }
          },
        }, "Save Plan"));
    });
  }

  function openAssignSubModal() {
    adminModal("Assign User Subscription", (close) => {
      const uidIn = el("input", { type: "text", placeholder: "User ID (usr_...)" });
      const planSel = el("select", { class: "adm-select" },
        ...data.plans.map((p) => el("option", { value: p.id }, `${p.name} (${p.monthly_credits} cr)`)));
      const statusSel = el("select", { class: "adm-select" },
        ...["active", "trialing", "paused", "canceled"].map((s) => el("option", { value: s }, s)));
      const grantCb = el("input", { type: "checkbox", checked: true });
      return el("div", { style: { display: "grid", gap: "10px" } },
        el("div", { class: "field" }, el("div", { class: "lbl" }, "User ID"), uidIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Plan"), planSel),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Status"), statusSel),
        el("label", { class: "togrow" }, el("span", {}, "Grant monthly plan credits now"), el("span", { class: "switch" }, grantCb, el("i"))),
        el("button", {
          class: "btn lime", type: "button",
          onclick: async () => {
            try {
              await api("/api/admin/subscriptions", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  user_id: uidIn.value.trim(),
                  plan_id: planSel.value,
                  status: statusSel.value,
                  grant_plan_credits: grantCb.checked,
                }),
              });
              toast("Subscription assigned"); close(); load();
            } catch (err) { toast(err.message, { error: true }); }
          },
        }, "Assign"));
    });
  }

  function openRecordPaymentModal() {
    adminModal("Record Payment Transaction", (close) => {
      const uidIn = el("input", { type: "text", placeholder: "User ID (usr_...)" });
      const amountIn = el("input", { type: "number", value: "1900" });
      const curIn = el("input", { type: "text", value: "USD" });
      const statusSel = el("select", { class: "adm-select" },
        ...["confirmed", "pending", "failed", "refunded"].map((s) => el("option", { value: s }, s)));
      const provIn = el("input", { type: "text", value: "manual", placeholder: "stripe / invoice / manual" });
      const extIn = el("input", { type: "text", placeholder: "External reference ID" });
      const credIn = el("input", { type: "number", value: "250" });
      const notesIn = el("input", { type: "text", placeholder: "Notes" });
      return el("div", { style: { display: "grid", gap: "10px" } },
        el("div", { class: "field" }, el("div", { class: "lbl" }, "User ID"), uidIn),
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Amount (cents)"), amountIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Currency"), curIn)),
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Status"), statusSel),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Credits Granted"), credIn)),
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Gateway"), provIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "External ID"), extIn)),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Notes"), notesIn),
        el("button", {
          class: "btn lime", type: "button",
          onclick: async () => {
            try {
              await api("/api/admin/payments", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  user_id: uidIn.value.trim(),
                  amount_cents: Number(amountIn.value),
                  currency: curIn.value.trim() || "USD",
                  status: statusSel.value,
                  provider_name: provIn.value.trim() || "manual",
                  external_payment_id: extIn.value.trim() || null,
                  credits_granted: Number(credIn.value),
                  notes: notesIn.value.trim() || null,
                }),
              });
              toast("Payment recorded"); close(); load();
            } catch (err) { toast(err.message, { error: true }); }
          },
        }, "Record Payment"));
    });
  }

  function draw() {
    const tabs = el("div", { class: "tabs" }, ...[
      ["transactions", "Credit Ledger"],
      ["plans", "Plans"],
      ["subscriptions", "Subscriptions"],
      ["payments", "Payments"],
    ].map(([id, label]) => el("button", { type: "button", "aria-selected": String(tab === id), onclick: () => { tab = id; draw(); } }, label)));

    let content = null;
    if (tab === "transactions") {
      content = el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "User"), el("th", {}, "Type"), el("th", {}, "Delta"), el("th", {}, "Balance After"), el("th", {}, "Reason"), el("th", {}, "Time"))),
        el("tbody", {}, ...data.transactions.map((tx) => el("tr", {},
          el("td", {}, el("code", {}, tx.user_id.slice(0, 14))),
          el("td", {}, statusChip(tx.tx_type)),
          el("td", { class: "num", style: { color: tx.delta >= 0 ? "var(--ok)" : "var(--bad)" } }, `${tx.delta >= 0 ? "+" : ""}${tx.delta}`),
          el("td", { class: "num" }, String(tx.balance_after)),
          el("td", {}, tx.reason),
          el("td", { class: "dim" }, ago(tx.created_at)))))));
    } else if (tab === "plans") {
      content = el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "Plan"), el("th", {}, "Price"), el("th", {}, "Credits"), el("th", {}, "Concurrency"), el("th", {}, "Enabled"), el("th", {}, "Actions"))),
        el("tbody", {}, ...data.plans.map((p) => el("tr", {},
          el("td", {}, el("b", {}, p.name), el("div", { class: "dim", style: { fontSize: "12px" } }, p.code)),
          el("td", { class: "num" }, `${fmtMoney(p.price_cents)} / ${p.billing_interval}`),
          el("td", { class: "num" }, String(p.monthly_credits)),
          el("td", { class: "num" }, `${p.max_active_jobs} active · ${p.max_daily_runs ?? "∞"}/day`),
          el("td", {}, statusChip(p.enabled ? "active" : "disabled")),
          el("td", {}, canManageSubs ? el("button", { class: "btn small ghost", type: "button", onclick: () => openPlanModal(p) }, "Edit") : null)))));
    } else if (tab === "subscriptions") {
      content = el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "User"), el("th", {}, "Plan"), el("th", {}, "Status"), el("th", {}, "Period End"))),
        el("tbody", {}, ...data.subscriptions.map((s) => el("tr", {},
          el("td", {}, el("code", {}, s.user_id)),
          el("td", {}, s.plan_id),
          el("td", {}, statusChip(s.status)),
          el("td", { class: "dim" }, s.current_period_end ? ago(s.current_period_end) : "—")))));
    } else {
      content = el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "User"), el("th", {}, "Amount"), el("th", {}, "Credits"), el("th", {}, "Gateway"), el("th", {}, "Status"), el("th", {}, "Time"))),
        el("tbody", {}, ...data.payments.map((p) => el("tr", {},
          el("td", {}, el("code", {}, p.user_id.slice(0, 14))),
          el("td", { class: "num" }, fmtMoney(p.amount_cents, p.currency)),
          el("td", { class: "num" }, String(p.credits_granted)),
          el("td", {}, p.provider_name),
          el("td", {}, statusChip(p.status)),
          el("td", { class: "dim" }, ago(p.created_at)))))));
    }

    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "Credits, Plans & Billing"), el("p", { class: "dim" }, "Audited credit ledger, plans, subscriptions, and payment records.")),
        el("div", { class: "adm-toolbar" },
          canManageSubs ? el("button", { class: "btn small", type: "button", onclick: () => openPlanModal(null) }, icon("plus"), "New Plan") : null,
          canManageSubs ? el("button", { class: "btn small", type: "button", onclick: openAssignSubModal }, "Assign Plan") : null,
          canWriteCredits ? el("button", { class: "btn small lime", type: "button", onclick: openRecordPaymentModal }, icon("dollar"), "Record Payment") : null)),
      tabs,
      content);
  }

  load().catch((err) => toast(err.message, { error: true }));
}

// ---------------------------------------------------------------- I. Messaging, Templates, Announcements & Email Logs

export function renderMessaging(host) {
  let tab = "send";
  const data = { notifications: [], templates: [], announcements: [], emailLogs: [] };

  async function load() {
    const [nRes, tRes, aRes, eRes] = await Promise.all([
      api("/api/admin/notifications").catch(() => ({ notifications: [] })),
      api("/api/admin/templates").catch(() => ({ templates: [] })),
      api("/api/admin/announcements").catch(() => ({ announcements: [] })),
      api("/api/admin/email-logs").catch(() => ({ logs: [] })),
    ]);
    data.notifications = nRes.notifications || [];
    data.templates = tRes.templates || [];
    data.announcements = aRes.announcements || [];
    data.emailLogs = eRes.logs || [];
    draw();
  }

  function openAnnouncementModal(existing = null) {
    adminModal(existing ? "Edit Announcement" : "New Announcement", (close) => {
      const titleIn = el("input", { type: "text", value: existing?.title || "", placeholder: "Scheduled Upgrade" });
      const bodyIn = el("textarea", { value: existing?.body || "", placeholder: "Details shown to users in top banner" });
      const sevSel = el("select", { class: "adm-select" },
        ...["info", "feature", "warning", "maintenance"].map((s) => el("option", { value: s, selected: existing?.severity === s }, s)));
      const activeCb = el("input", { type: "checkbox", checked: existing ? existing.active : true });

      return el("div", { style: { display: "grid", gap: "10px" } },
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Title"), titleIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Message"), bodyIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Severity"), sevSel),
        el("label", { class: "togrow" }, el("span", {}, "Active"), el("span", { class: "switch" }, activeCb, el("i"))),
        el("button", {
          class: "btn lime", type: "button",
          onclick: async () => {
            try {
              const url = existing ? `/api/admin/announcements/${existing.id}` : "/api/admin/announcements";
              await api(url, {
                method: existing ? "PATCH" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  title: titleIn.value.trim(),
                  body: bodyIn.value.trim(),
                  severity: sevSel.value,
                  active: activeCb.checked,
                }),
              });
              toast("Announcement saved"); close(); load();
            } catch (err) { toast(err.message, { error: true }); }
          },
        }, "Save Announcement"));
    });
  }

  function draw() {
    const tabs = el("div", { class: "tabs" }, ...[
      ["send", "Send Notification"],
      ["announcements", `Announcements (${data.announcements.length})`],
      ["templates", "Templates"],
      ["emails", "Email Logs"],
    ].map(([id, label]) => el("button", { type: "button", "aria-selected": String(tab === id), onclick: () => { tab = id; draw(); } }, label)));

    let content = null;
    if (tab === "send") {
      const audSel = el("select", { class: "adm-select" },
        el("option", { value: "all" }, "All Active Users"),
        el("option", { value: "role" }, "Specific Role"),
        el("option", { value: "user" }, "Single User ID"));
      const targetIn = el("input", { type: "text", placeholder: "Role ID (e.g. user) or User ID (usr_...)" });
      const titleIn = el("input", { type: "text", placeholder: "Notification title" });
      const bodyIn = el("textarea", { placeholder: "Message content" });
      const emailCb = el("input", { type: "checkbox" });

      content = el("div", { class: "adm-2col" },
        el("div", { class: "card" },
          el("h3", {}, icon("mail"), "Dispatch Message"),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Audience"), audSel),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Target (for Role / Single User)"), targetIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Title"), titleIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Body"), bodyIn),
          el("label", { class: "togrow" }, el("span", {}, "Also send email notification"), el("span", { class: "switch" }, emailCb, el("i"))),
          el("button", {
            class: "btn lime", type: "button",
            onclick: async () => {
              try {
                const payload = {
                  audience: audSel.value,
                  title: titleIn.value.trim(),
                  body: bodyIn.value.trim(),
                  send_email: emailCb.checked,
                  ...(audSel.value === "role" ? { role_id: targetIn.value.trim() } : {}),
                  ...(audSel.value === "user" ? { user_id: targetIn.value.trim() } : {}),
                };
                const res = await api("/api/admin/notifications", {
                  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
                });
                toast(`Delivered to ${res.delivered} user(s)`);
                titleIn.value = ""; bodyIn.value = "";
                load();
              } catch (err) { toast(err.message, { error: true }); }
            },
          }, icon("send"), "Send Notification")),
        el("div", { class: "card" },
          el("h3", {}, "Recent Dispatched Notifications"),
          el("div", { class: "vtable" }, ...data.notifications.slice(0, 12).map((n) => el("div", { class: "vrow", style: { cursor: "default" } },
            el("div", { class: "nm" }, el("b", {}, n.title), el("small", {}, n.body)),
            el("code", {}, n.user_id.slice(0, 12)),
            el("small", { class: "dim" }, ago(n.created_at)))))));
    } else if (tab === "announcements") {
      content = el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "Title"), el("th", {}, "Severity"), el("th", {}, "Status"), el("th", {}, "Actions"))),
        el("tbody", {}, ...data.announcements.map((a) => el("tr", {},
          el("td", {}, el("b", {}, a.title), el("div", { class: "dim", style: { fontSize: "12px" } }, a.body)),
          el("td", {}, statusChip(a.severity)),
          el("td", {}, statusChip(a.active ? "active" : "inactive")),
          el("td", {}, el("div", { class: "adm-acts" },
            el("button", { class: "btn small ghost", type: "button", onclick: () => openAnnouncementModal(a) }, "Edit"),
            el("button", {
              class: "btn small ghost danger", type: "button",
              onclick: async () => { await api(`/api/admin/announcements/${a.id}`, { method: "DELETE" }); toast("Deleted"); load(); },
            }, icon("trash")))))))));
    } else if (tab === "templates") {
      const keyIn = el("input", { type: "text", placeholder: "welcome_credit" });
      const tplTitle = el("input", { type: "text", placeholder: "Title template" });
      const tplBody = el("textarea", { placeholder: "Body template" });
      const chanSel = el("select", { class: "adm-select" }, ...["in_app", "email", "both"].map((c) => el("option", { value: c }, c)));
      content = el("div", { class: "adm-2col" },
        el("div", { class: "card" },
          el("h3", {}, "Save Notification Template"),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Template Key"), keyIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Channel"), chanSel),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Title"), tplTitle),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Body"), tplBody),
          el("button", {
            class: "btn lime", type: "button",
            onclick: async () => {
              await api("/api/admin/templates", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ template_key: keyIn.value.trim(), title_template: tplTitle.value, body_template: tplBody.value, channel: chanSel.value }),
              });
              toast("Template saved"); load();
            },
          }, "Save Template")),
        el("div", { class: "card" },
          el("h3", {}, "Existing Templates"),
          ...data.templates.map((tp) => el("div", { class: "mrow" },
            el("div", { class: "two" }, el("b", {}, tp.template_key), el("small", { class: "dim" }, tp.title_template)),
            el("span", { class: "chip" }, tp.channel)))));
    } else {
      content = el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "Recipient"), el("th", {}, "Subject"), el("th", {}, "Transport"), el("th", {}, "Status"), el("th", {}, "Sent"))),
        el("tbody", {}, ...data.emailLogs.map((l) => el("tr", {},
          el("td", {}, l.recipient_email),
          el("td", {}, l.subject),
          el("td", {}, l.transport),
          el("td", {}, statusChip(l.status)),
          el("td", { class: "dim" }, ago(l.created_at)))))));
    }

    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "Notifications & Announcements"), el("p", { class: "dim" }, "User messaging, announcements banner, templates, and email delivery history.")),
        el("div", { class: "adm-toolbar" },
          el("button", { class: "btn small lime", type: "button", onclick: () => openAnnouncementModal(null) }, icon("plus"), "New Announcement"))),
      tabs,
      content);
  }

  load().catch((err) => toast(err.message, { error: true }));
}

// ---------------------------------------------------------------- J. Authentication & Session Security

export function renderSecurity(host, { canRevoke }) {
  let tab = "sessions";
  const data = { sessions: [], logins: [] };

  async function load() {
    const [sRes, lRes] = await Promise.all([
      api("/api/admin/auth/sessions").catch(() => ({ sessions: [] })),
      api("/api/admin/auth/logins").catch(() => ({ logins: [] })),
    ]);
    data.sessions = sRes.sessions || [];
    data.logins = lRes.logins || [];
    draw();
  }

  function draw() {
    const tabs = el("div", { class: "tabs" }, ...[
      ["sessions", `Active Sessions (${data.sessions.filter((s) => !s.revoked_at).length})`],
      ["logins", `Login History (${data.logins.length})`],
    ].map(([id, label]) => el("button", { type: "button", "aria-selected": String(tab === id), onclick: () => { tab = id; draw(); } }, label)));

    const content = tab === "sessions"
      ? el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "Session"), el("th", {}, "User"), el("th", {}, "IP"), el("th", {}, "Last Seen"), el("th", {}, "Status"), el("th", {}, "Actions"))),
        el("tbody", {}, ...data.sessions.map((s) => el("tr", {},
          el("td", {}, el("code", {}, s.id.slice(0, 12))),
          el("td", {}, el("code", {}, s.user_id.slice(0, 14))),
          el("td", {}, s.ip_address || "—"),
          el("td", { class: "dim" }, ago(s.last_seen_at)),
          el("td", {}, statusChip(s.revoked_at ? "revoked" : "active")),
          el("td", {}, canRevoke && !s.revoked_at ? el("button", {
            class: "btn small ghost danger", type: "button",
            onclick: async () => { await api(`/api/admin/auth/sessions/${s.id}/revoke`, { method: "POST" }); toast("Session revoked"); load(); },
          }, "Revoke") : null)))))
      : el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "Email"), el("th", {}, "Result"), el("th", {}, "Reason"), el("th", {}, "IP"), el("th", {}, "Time"))),
        el("tbody", {}, ...data.logins.map((l) => el("tr", {},
          el("td", {}, l.email),
          el("td", {}, statusChip(l.success ? "active" : "failed")),
          el("td", { class: "dim" }, l.failure_reason || "Authenticated"),
          el("td", {}, l.ip_address || "—"),
          el("td", { class: "dim" }, ago(l.created_at))))));

    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "Sessions & Login Security"), el("p", { class: "dim" }, "Live active sessions, forced revocation, and authentication audit log.")),
        el("button", { class: "btn small", type: "button", onclick: load }, icon("refresh"), "Refresh")),
      tabs,
      content);
  }

  load().catch((err) => toast(err.message, { error: true }));
}

// ---------------------------------------------------------------- K. System Settings & Immutable Audit Logs

export function renderSettingsAudit(host, { canWriteSettings, canReadAudit }) {
  let tab = "settings";
  const data = { settings: [], flags: [], auditLogs: [] };

  async function load() {
    const [sRes, aRes] = await Promise.all([
      api("/api/admin/settings").catch(() => ({ settings: [], flags: [] })),
      canReadAudit ? api("/api/admin/audit-logs").catch(() => ({ logs: [] })) : Promise.resolve({ logs: [] }),
    ]);
    data.settings = sRes.settings || [];
    data.flags = sRes.flags || [];
    data.auditLogs = aRes.logs || [];
    draw();
  }

  function settingVal(key, fallback = "") {
    const found = data.settings.find((s) => s.setting_key === key);
    return found ? found.setting_value : fallback;
  }

  function draw() {
    const tabs = el("div", { class: "tabs" },
      el("button", { type: "button", "aria-selected": String(tab === "settings"), onclick: () => { tab = "settings"; draw(); } }, "Platform Settings"),
      canReadAudit ? el("button", { type: "button", "aria-selected": String(tab === "audit"), onclick: () => { tab = "audit"; draw(); } }, `Audit Logs (${data.auditLogs.length})`) : null);

    let content = null;
    if (tab === "settings") {
      const nameIn = el("input", { type: "text", value: String(settingVal("platform_name", "SPACIX")) });
      const tagIn = el("input", { type: "text", value: String(settingVal("platform_tagline", "Cloud AI Creative Studio")) });
      const logoIn = el("input", { type: "text", value: String(settingVal("logo_url", "https://spacix.ticketplaster.com/brand/logo.png")) });
      const maintMsgIn = el("input", { type: "text", value: String(settingVal("maintenance_message", "Scheduled maintenance in progress.")) });
      const signupCreditsIn = el("input", { type: "number", value: String(settingVal("default_signup_credits", 25)) });
      const defaultCostIn = el("input", { type: "number", value: String(settingVal("default_generation_cost", 1)) });
      const emailFromIn = el("input", { type: "text", value: String(settingVal("email_from_address", "noreply@spacix.local")) });
      const emailWebhookIn = el("input", { type: "text", value: String(settingVal("email_webhook_url", "")) });
      const termsIn = el("input", { type: "text", value: String(settingVal("terms_url", "")) });
      const privacyIn = el("input", { type: "text", value: String(settingVal("privacy_url", "")) });
      const maxFailedIn = el("input", { type: "number", value: String(settingVal("max_failed_login_attempts", 8)) });
      const ttlHoursIn = el("input", { type: "number", value: String(settingVal("session_ttl_hours", 168)) });

      content = el("div", { class: "adm-2col" },
        el("div", { class: "card" },
          el("h3", {}, icon("settings"), "Branding & Policies"),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Platform Name"), nameIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Tagline"), tagIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Logo URL"), logoIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Maintenance Notice"), maintMsgIn),
          el("div", { class: "adm-2col" },
            el("div", { class: "field" }, el("div", { class: "lbl" }, "Signup Credits"), signupCreditsIn),
            el("div", { class: "field" }, el("div", { class: "lbl" }, "Default Gen Cost"), defaultCostIn)),
          el("div", { class: "adm-2col" },
            el("div", { class: "field" }, el("div", { class: "lbl" }, "Terms URL"), termsIn),
            el("div", { class: "field" }, el("div", { class: "lbl" }, "Privacy URL"), privacyIn))),
        el("div", { class: "card" },
          el("h3", {}, icon("mail"), "Email & Auth Security"),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Email From Address"), emailFromIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Email Relay Webhook URL"), emailWebhookIn),
          el("div", { class: "adm-2col" },
            el("div", { class: "field" }, el("div", { class: "lbl" }, "Max Failed Logins"), maxFailedIn),
            el("div", { class: "field" }, el("div", { class: "lbl" }, "Session TTL (hours)"), ttlHoursIn)),
          canWriteSettings ? el("button", {
            class: "btn lime", type: "button",
            onclick: async () => {
              try {
                await api("/api/admin/settings", {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    settings: {
                      platform_name: nameIn.value.trim(),
                      platform_tagline: tagIn.value.trim(),
                      logo_url: logoIn.value.trim(),
                      maintenance_message: maintMsgIn.value.trim(),
                      default_signup_credits: Number(signupCreditsIn.value),
                      default_generation_cost: Number(defaultCostIn.value),
                      email_from_address: emailFromIn.value.trim(),
                      email_webhook_url: emailWebhookIn.value.trim(),
                      terms_url: termsIn.value.trim(),
                      privacy_url: privacyIn.value.trim(),
                      max_failed_login_attempts: Number(maxFailedIn.value),
                      session_ttl_hours: Number(ttlHoursIn.value),
                    },
                  }),
                });
                toast("Settings saved"); load();
              } catch (err) { toast(err.message, { error: true }); }
            },
          }, icon("check"), "Save System Settings") : null));
    } else {
      content = el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "Action"), el("th", {}, "Admin"), el("th", {}, "Target"), el("th", {}, "Details"), el("th", {}, "IP"), el("th", {}, "Time"))),
        el("tbody", {}, ...data.auditLogs.map((l) => el("tr", {},
          el("td", {}, el("b", {}, l.action)),
          el("td", {}, el("code", {}, String(l.admin_user_id || "").slice(0, 14))),
          el("td", {}, `${l.target_type}${l.target_id ? `: ${l.target_id}` : ""}`),
          el("td", {}, l.details ? el("code", { style: { fontSize: "11px" } }, JSON.stringify(l.details).slice(0, 80)) : "—"),
          el("td", {}, l.ip_address || "—"),
          el("td", { class: "dim" }, ago(l.created_at)))))));
    }

    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "System Settings & Audit Logs"), el("p", { class: "dim" }, "Global platform configuration, policies, email dispatch, and immutable audit trail."))),
      tabs,
      content);
  }

  load().catch((err) => toast(err.message, { error: true }));
}
