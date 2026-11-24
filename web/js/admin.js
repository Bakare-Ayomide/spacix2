// Independent RBAC-protected Admin Control Centre (#/admin).
// Covers Modules A-F (Overview, Users, Admins & Roles, Providers, Models, Studios & Flags) and orchestrates G-K.
import {
  api, el, icon, toast, session, setAuthToken,
} from "./util.js";
import { t, ago } from "./i18n.js";
import { refreshBootstrap } from "./account.js";
import {
  adminModal, fmtMoney, statusChip,
  renderGenerations, renderBilling, renderMessaging, renderSecurity, renderSettingsAudit,
} from "./admin-ops.js";

function hasPerm(perm) {
  const perms = session.user?.permissions || [];
  return perms.includes("*") || perms.includes(perm);
}

// ---------------------------------------------------------------- Module A: Overview

function renderOverview(host) {
  host.replaceChildren(el("div", { class: "empty" }, "Loading platform metrics…"));
  api("/api/admin/overview").then((d) => {
    const kpis = [
      ["Total Users", d.users.total, `${d.users.active} active · +${d.users.new_7d} (7d)`],
      ["Total Generations", d.generations.total, `${d.generations.succeeded} ok · ${d.generations.failed} failed`],
      ["Credits Consumed", d.credits.total_spent, `${d.credits.total_granted} granted · ${d.credits.net_balance} net`],
      ["Confirmed Revenue", fmtMoney(d.revenue.confirmed_cents), `${d.revenue.active_subscriptions} active subs`],
    ];
    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "Dashboard Overview"), el("p", { class: "dim" }, "Live database and runtime telemetry across SPACIX.")),
        el("button", { class: "btn small", type: "button", onclick: () => renderOverview(host) }, icon("refresh"), "Refresh")),
      el("div", { class: "adm-kpis" }, ...kpis.map(([lbl, val, sub]) => el("div", { class: "adm-kpi" },
        el("span", { class: "dim" }, lbl),
        el("b", { class: "num" }, String(val)),
        el("small", { class: "dim" }, sub)))),
      el("div", { class: "adm-2col" },
        el("div", { class: "card" },
          el("h3", {}, icon("activity"), "Media & Queue Breakdown"),
          el("dl", { class: "vals" },
            el("dt", {}, "Images Generated"), el("dd", { class: "num" }, String(d.generations.by_media?.image ?? 0)),
            el("dt", {}, "Videos Generated"), el("dd", { class: "num" }, String(d.generations.by_media?.video ?? 0)),
            el("dt", {}, "Audio Tracks"), el("dd", { class: "num" }, String(d.generations.by_media?.audio ?? 0)),
            el("dt", {}, "Active Queue Jobs"), el("dd", { class: "num" }, String(d.generations.active_queue ?? 0)),
            el("dt", {}, "Online Users (15m)"), el("dd", { class: "num" }, String(d.users.online_15m ?? 0)))),
        el("div", { class: "card" },
          el("h3", {}, icon("database"), "System & Providers Health"),
          el("dl", { class: "vals" },
            el("dt", {}, "Storage Engine"), el("dd", {}, d.system.database_engine === "mysql" ? "MySQL Connected" : "Local Disk Fallback"),
            el("dt", {}, "MySQL Configured"), el("dd", {}, d.system.mysql_configured ? "Yes" : "No"),
            el("dt", {}, "Healthy Providers"), el("dd", {}, `${d.providers.healthy} / ${d.providers.enabled} enabled`),
            el("dt", {}, "Suspended Users"), el("dd", {}, String(d.users.suspended ?? 0))))),
      el("div", { class: "adm-2col" },
        el("div", { class: "card" },
          el("h3", {}, "Recent Generations"),
          el("div", { class: "vtable" }, ...(d.recent_generations || []).slice(0, 8).map((g) => el("div", { class: "vrow", style: { cursor: "default" } },
            el("div", { class: "nm" }, el("b", {}, g.app_id), el("small", {}, g.prompt || g.id)),
            statusChip(g.status),
            el("small", { class: "dim" }, ago(g.created_at)))))),
        el("div", { class: "card" },
          el("h3", {}, "Recent Admin Activity"),
          el("div", { class: "vtable" }, ...(d.recent_audit_logs || []).slice(0, 8).map((a) => el("div", { class: "vrow", style: { cursor: "default" } },
            el("div", { class: "nm" }, el("b", {}, a.action), el("small", {}, `${a.target_type} ${a.target_id || ""}`)),
            el("span", { class: "dim" }, ago(a.created_at)),
            el("code", {}, String(a.admin_user_id || "").slice(0, 10)))))));
  }).catch((err) => {
    host.replaceChildren(el("div", { class: "empty" }, err.message));
  });
}

// ---------------------------------------------------------------- Module B: User Management

function renderUsers(host) {
  const state = { search: "", status: "", role: "", sort: "newest", selected: new Set(), users: [], total: 0, roles: [], plans: [] };

  async function load() {
    const qs = new URLSearchParams();
    if (state.search) qs.set("search", state.search);
    if (state.status) qs.set("status", state.status);
    if (state.role) qs.set("role", state.role);
    if (state.sort) qs.set("sort", state.sort);
    const [uRes, rRes, pRes] = await Promise.all([
      api(`/api/admin/users?${qs.toString()}`),
      api("/api/admin/roles").catch(() => ({ roles: [] })),
      api("/api/admin/plans").catch(() => ({ plans: [] })),
    ]);
    state.users = uRes.users || [];
    state.total = uRes.total ?? 0;
    state.roles = rRes.roles || [];
    state.plans = pRes.plans || [];
    draw();
  }

  function openCreateUserModal() {
    adminModal("Create User Account", (close) => {
      const emailIn = el("input", { type: "email", placeholder: "user@example.com" });
      const nameIn = el("input", { type: "text", placeholder: "Display Name" });
      const passIn = el("input", { type: "password", placeholder: "Min 8 characters" });
      const roleSel = el("select", { class: "adm-select" },
        ...(state.roles.length ? state.roles : [{ id: "user", name: "User" }]).map((r) => el("option", { value: r.id }, r.name)));
      const credIn = el("input", { type: "number", value: "25" });
      const verifiedCb = el("input", { type: "checkbox", checked: true });

      return el("div", { style: { display: "grid", gap: "10px" } },
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Email"), emailIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Display Name"), nameIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Password"), passIn),
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Role"), roleSel),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Initial Credits"), credIn)),
        el("label", { class: "togrow" }, el("span", {}, "Email verified"), el("span", { class: "switch" }, verifiedCb, el("i"))),
        el("button", {
          class: "btn lime", type: "button",
          onclick: async () => {
            try {
              await api("/api/admin/users", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  email: emailIn.value.trim(),
                  display_name: nameIn.value.trim(),
                  password: passIn.value,
                  roles: [roleSel.value],
                  credits: Number(credIn.value),
                  email_verified: verifiedCb.checked,
                }),
              });
              toast("User created"); close(); load();
            } catch (err) { toast(err.message, { error: true }); }
          },
        }, "Create User"));
    });
  }

  async function openUserDetail(userId) {
    try {
      const detail = await api(`/api/admin/users/${userId}`);
      const u = detail.user;
      adminModal(`User: ${u.display_name || u.email || u.id}`, (close) => {
        const nameIn = el("input", { type: "text", value: u.display_name || "" });
        const statusSel = el("select", { class: "adm-select" },
          ...["active", "suspended", "deactivated"].map((s) => el("option", { value: s, selected: u.status === s }, s)));
        const roleBoxes = new Set(u.roles || ["user"]);
        const verifiedCb = el("input", { type: "checkbox", checked: Boolean(u.email_verified) });
        const deltaIn = el("input", { type: "number", value: "50" });
        const reasonIn = el("input", { type: "text", value: "Admin credit adjustment" });
        const newPassIn = el("input", { type: "password", placeholder: "New password (min 8 chars)" });
        const notifyTitle = el("input", { type: "text", placeholder: "Notification title" });
        const notifyBody = el("input", { type: "text", placeholder: "Message" });

        return el("div", { style: { display: "grid", gap: "14px", maxHeight: "75vh", overflowY: "auto" } },
          el("dl", { class: "vals" },
            el("dt", {}, "ID"), el("dd", {}, el("code", {}, u.id)),
            el("dt", {}, "Email"), el("dd", {}, u.email || "—"),
            el("dt", {}, "Credits"), el("dd", {}, String(u.credit_balance ?? 0)),
            el("dt", {}, "Generations"), el("dd", {}, String(detail.generations?.length ?? 0)),
            el("dt", {}, "Last Login"), el("dd", {}, u.last_login_at ? ago(u.last_login_at) : "Never")),
          el("div", { class: "adm-2col" },
            el("div", { class: "field" }, el("div", { class: "lbl" }, "Display Name"), nameIn),
            el("div", { class: "field" }, el("div", { class: "lbl" }, "Account Status"), statusSel)),
          el("label", { class: "togrow" }, el("span", {}, "Email Verified"), el("span", { class: "switch" }, verifiedCb, el("i"))),
          state.roles.length ? el("div", { class: "field" },
            el("div", { class: "lbl" }, "Roles"),
            el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, ...state.roles.map((r) => {
              const cb = el("input", {
                type: "checkbox", checked: roleBoxes.has(r.id),
                onchange: () => { if (cb.checked) roleBoxes.add(r.id); else roleBoxes.delete(r.id); },
              });
              return el("label", { style: { display: "inline-flex", gap: "5px", alignItems: "center", fontSize: "12.5px" } }, cb, r.name);
            }))) : null,
          el("button", {
            class: "btn lime small", type: "button",
            onclick: async () => {
              try {
                await api(`/api/admin/users/${u.id}`, {
                  method: "PATCH", headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    display_name: nameIn.value.trim(),
                    status: statusSel.value,
                    email_verified: verifiedCb.checked,
                    roles: [...roleBoxes],
                  }),
                });
                toast("User updated"); close(); load();
              } catch (err) { toast(err.message, { error: true }); }
            },
          }, "Save Account Changes"),

          hasPerm("credits.write") ? el("div", { class: "card" },
            el("h3", {}, "Credits Adjustment"),
            el("div", { class: "adm-2col" }, deltaIn, reasonIn),
            el("div", { style: { display: "flex", gap: "8px" } },
              el("button", {
                class: "btn small", type: "button",
                onclick: async () => {
                  await api(`/api/admin/users/${u.id}/credits`, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ delta: Math.abs(Number(deltaIn.value)), reason: reasonIn.value }),
                  });
                  toast("Credits granted"); close(); openUserDetail(u.id); load();
                },
              }, "+ Grant"),
              el("button", {
                class: "btn small ghost danger", type: "button",
                onclick: async () => {
                  await api(`/api/admin/users/${u.id}/credits`, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ delta: -Math.abs(Number(deltaIn.value)), reason: reasonIn.value }),
                  });
                  toast("Credits deducted"); close(); openUserDetail(u.id); load();
                },
              }, "− Deduct"))) : null,

          el("div", { class: "card" },
            el("h3", {}, "Password Reset & Direct Message"),
            el("div", { style: { display: "flex", gap: "8px" } },
              newPassIn,
              el("button", {
                class: "btn small", type: "button",
                onclick: async () => {
                  await api(`/api/admin/users/${u.id}/reset-password`, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ new_password: newPassIn.value }),
                  });
                  newPassIn.value = "";
                  toast("Password updated & sessions revoked");
                },
              }, "Set Password")),
            el("div", { class: "adm-2col" }, notifyTitle, notifyBody),
            el("button", {
              class: "btn small ghost", type: "button",
              onclick: async () => {
                await api(`/api/admin/users/${u.id}/notify`, {
                  method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ title: notifyTitle.value, body: notifyBody.value }),
                });
                notifyTitle.value = ""; notifyBody.value = "";
                toast("Notification sent");
              },
            }, "Send In-App Notice")),

          detail.logins?.length ? el("div", { class: "card" },
            el("h3", {}, "Recent Logins"),
            ...detail.logins.slice(0, 6).map((l) => el("div", { class: "mrow" },
              el("span", {}, l.success ? "Success" : (l.failure_reason || "Failed")),
              el("small", { class: "dim" }, `${l.ip_address || "—"} · ${ago(l.created_at)}`)))) : null);
      });
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  function draw() {
    const searchIn = el("input", {
      type: "search", value: state.search, placeholder: "Search email, name, ID…",
      onkeydown: (e) => { if (e.key === "Enter") { state.search = searchIn.value.trim(); load(); } },
    });
    const statusSel = el("select", {
      class: "adm-select", onchange: () => { state.status = statusSel.value; load(); },
    }, ...["", "active", "suspended", "deactivated"].map((s) => el("option", { value: s, selected: state.status === s }, s || "All statuses")));

    const bulkBar = state.selected.size > 0 && hasPerm("users.suspend") ? el("div", { class: "adm-bulk" },
      el("span", {}, `${state.selected.size} selected`),
      ...["suspend", "activate", "verify", "delete"].map((op) => el("button", {
        class: `btn small${op === "delete" ? " ghost danger" : ""}`, type: "button",
        onclick: async () => {
          await api("/api/admin/users/bulk", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ user_ids: [...state.selected], operation: op }),
          });
          state.selected.clear();
          toast(`Bulk ${op} completed`);
          load();
        },
      }, op))) : null;

    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "User Management"), el("p", { class: "dim" }, `${state.total} accounts`)),
        el("div", { class: "adm-toolbar" },
          el("div", { class: "search" }, icon("search"), searchIn),
          statusSel,
          hasPerm("users.write") ? el("button", { class: "btn small lime", type: "button", onclick: openCreateUserModal }, icon("plus"), "Create User") : null)),
      bulkBar,
      el("div", { class: "adm-table-wrap" },
        el("table", { class: "adm-table" },
          el("thead", {}, el("tr", {},
            el("th", {}, ""), el("th", {}, "User"), el("th", {}, "Roles"), el("th", {}, "Status"),
            el("th", {}, "Credits"), el("th", {}, "Verified"), el("th", {}, "Created"), el("th", {}, "Actions"))),
          el("tbody", {}, ...state.users.map((u) => {
            const cb = el("input", {
              type: "checkbox", checked: state.selected.has(u.id),
              onchange: () => { if (cb.checked) state.selected.add(u.id); else state.selected.delete(u.id); draw(); },
            });
            return el("tr", {},
              el("td", {}, cb),
              el("td", {}, el("b", {}, u.display_name || "—"), el("div", { class: "dim", style: { fontSize: "12px" } }, u.email || u.id)),
              el("td", {}, (u.roles || []).join(", ")),
              el("td", {}, statusChip(u.status)),
              el("td", { class: "num" }, String(u.credit_balance ?? 0)),
              el("td", {}, u.email_verified ? statusChip("verified") : statusChip("pending")),
              el("td", { class: "dim" }, ago(u.created_at)),
              el("td", {}, el("div", { class: "adm-acts" },
                el("button", { class: "btn small ghost", type: "button", onclick: () => openUserDetail(u.id) }, "Manage"),
                hasPerm("users.suspend") && u.id !== session.user?.id ? el("button", {
                  class: "btn small ghost danger", type: "button",
                  onclick: async () => {
                    await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
                    toast("User deleted"); load();
                  },
                }, icon("trash")) : null)));
          })))));
  }

  load().catch((err) => toast(err.message, { error: true }));
}

// ---------------------------------------------------------------- Module C: Admins & RBAC Roles

function renderRoles(host) {
  const data = { admins: [], roles: [], permissions: [] };

  async function load() {
    const [aRes, rRes, pRes] = await Promise.all([
      api("/api/admin/admins").catch(() => ({ admins: [] })),
      api("/api/admin/roles").catch(() => ({ roles: [] })),
      api("/api/admin/permissions").catch(() => ({ permissions: [] })),
    ]);
    data.admins = aRes.admins || [];
    data.roles = rRes.roles || [];
    data.permissions = pRes.permissions || [];
    draw();
  }

  function openRoleModal(existing = null) {
    adminModal(existing ? `Edit Role: ${existing.name}` : "Create Custom Role", (close) => {
      const idIn = el("input", { type: "text", value: existing?.id || "", disabled: Boolean(existing), placeholder: "qa_reviewer" });
      const nameIn = el("input", { type: "text", value: existing?.name || "", placeholder: "QA Reviewer" });
      const descIn = el("input", { type: "text", value: existing?.description || "" });
      const isAdminCb = el("input", { type: "checkbox", checked: existing ? existing.is_admin_role : true });
      const picked = new Set(existing?.permissions || []);

      return el("div", { style: { display: "grid", gap: "10px", maxHeight: "75vh", overflowY: "auto" } },
        !existing ? el("div", { class: "field" }, el("div", { class: "lbl" }, "Role Key"), idIn) : null,
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Role Name"), nameIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Description"), descIn),
        el("label", { class: "togrow" }, el("span", {}, "Grants Admin Portal access"), el("span", { class: "switch" }, isAdminCb, el("i"))),
        el("div", { class: "field" },
          el("div", { class: "lbl" }, "Granular Permissions"),
          el("div", { class: "adm-perm-grid" }, ...data.permissions.map((p) => {
            const cb = el("input", {
              type: "checkbox", checked: picked.has(p.id),
              onchange: () => { if (cb.checked) picked.add(p.id); else picked.delete(p.id); },
            });
            return el("label", { class: "adm-perm-item" }, cb, el("span", {}, p.id));
          }))),
        el("button", {
          class: "btn lime", type: "button",
          onclick: async () => {
            try {
              const url = existing ? `/api/admin/roles/${existing.id}` : "/api/admin/roles";
              await api(url, {
                method: existing ? "PATCH" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  id: idIn.value.trim(),
                  name: nameIn.value.trim(),
                  description: descIn.value.trim(),
                  is_admin_role: isAdminCb.checked,
                  permissions: [...picked],
                }),
              });
              toast("Role saved"); close(); load();
            } catch (err) { toast(err.message, { error: true }); }
          },
        }, "Save Role"));
    });
  }

  function draw() {
    const isSuper = session.user?.roles?.includes("super_admin") || session.user?.permissions?.includes("*");
    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "Admins & RBAC Roles"), el("p", { class: "dim" }, "Manage administrator accounts and granular role permissions.")),
        isSuper ? el("button", { class: "btn small lime", type: "button", onclick: () => openRoleModal(null) }, icon("plus"), "New Role") : null),
      el("div", { class: "adm-2col" },
        el("div", { class: "card" },
          el("h3", {}, icon("shield"), "Administrator Accounts"),
          ...data.admins.map((a) => el("div", { class: "mrow" },
            el("div", { class: "two" }, el("b", {}, a.display_name), el("small", { class: "dim" }, `${a.email} · ${(a.roles || []).join(", ")}`)),
            statusChip(a.status)))),
        el("div", { class: "card" },
          el("h3", {}, icon("key"), "Roles & Permissions"),
          ...data.roles.map((r) => el("div", { class: "mrow" },
            el("div", { class: "two" },
              el("b", {}, r.name),
              el("small", { class: "dim" }, `${r.permissions.length} permissions · ${r.is_admin_role ? "Admin Role" : "User Role"}`)),
            el("div", { class: "adm-acts" },
              isSuper ? el("button", { class: "btn small ghost", type: "button", onclick: () => openRoleModal(r) }, "Edit") : null,
              isSuper && !r.is_system ? el("button", {
                class: "btn small ghost danger", type: "button",
                onclick: async () => { await api(`/api/admin/roles/${r.id}`, { method: "DELETE" }); toast("Role deleted"); load(); },
              }, icon("trash")) : null))))));
  }

  load().catch((err) => toast(err.message, { error: true }));
}

// ---------------------------------------------------------------- Module D: AI Provider Management

function renderProviders(host) {
  const data = { providers: [], logs: [] };
  const canWrite = hasPerm("providers.write");

  async function load() {
    const d = await api("/api/admin/providers");
    data.providers = d.providers || [];
    data.logs = d.logs || [];
    draw();
  }

  function openProviderModal(existing = null) {
    adminModal(existing ? `Configure Provider: ${existing.name}` : "Add AI Provider", (close) => {
      const idIn = el("input", { type: "text", value: existing?.id || "", disabled: Boolean(existing), placeholder: "runware" });
      const nameIn = el("input", { type: "text", value: existing?.name || "", placeholder: "Runware AI" });
      const adapterSel = el("select", { class: "adm-select" },
        ...["fal", "http", "runware", "openai", "replicate"].map((a) => el("option", { value: a, selected: existing?.adapter_type === a }, a)));
      const urlIn = el("input", { type: "text", value: existing?.base_url || "https://queue.fal.run", placeholder: "https://api.provider.com/v1" });
      const prioIn = el("input", { type: "number", value: String(existing?.priority ?? 100) });
      const fallbackIn = el("input", { type: "text", value: existing?.fallback_provider_id || "", placeholder: "Optional fallback provider ID" });
      const keyIn = el("input", { type: "password", placeholder: existing?.key_hint ? `Stored (${existing.key_hint}) — leave blank to keep` : "Paste API Key (stored AES-256-GCM encrypted)" });
      const whIn = el("input", { type: "password", placeholder: "Optional Webhook Secret" });
      const enabledCb = el("input", { type: "checkbox", checked: existing ? existing.enabled : true });

      return el("div", { style: { display: "grid", gap: "10px" } },
        !existing ? el("div", { class: "field" }, el("div", { class: "lbl" }, "Provider ID"), idIn) : null,
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Display Name"), nameIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Adapter Type"), adapterSel)),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Base URL"), urlIn),
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Priority (lower = first)"), prioIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Fallback Provider ID"), fallbackIn)),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "API Key (Encrypted at Rest)"), keyIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Webhook Signing Secret"), whIn),
        el("label", { class: "togrow" }, el("span", {}, "Provider Enabled"), el("span", { class: "switch" }, enabledCb, el("i"))),
        el("button", {
          class: "btn lime", type: "button",
          onclick: async () => {
            try {
              const url = existing ? `/api/admin/providers/${existing.id}` : "/api/admin/providers";
              await api(url, {
                method: existing ? "PATCH" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  id: idIn.value.trim(),
                  name: nameIn.value.trim(),
                  adapter_type: adapterSel.value,
                  base_url: urlIn.value.trim(),
                  priority: Number(prioIn.value),
                  fallback_provider_id: fallbackIn.value.trim() || null,
                  enabled: enabledCb.checked,
                  ...(keyIn.value.trim() ? { api_key: keyIn.value.trim() } : {}),
                  ...(whIn.value.trim() ? { webhook_secret: whIn.value.trim() } : {}),
                }),
              });
              toast("Provider saved"); close(); load();
            } catch (err) { toast(err.message, { error: true }); }
          },
        }, "Save Provider"));
    });
  }

  function draw() {
    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "AI Provider Connections"), el("p", { class: "dim" }, "Encrypted API credentials, failover priorities, and live connection checks.")),
        canWrite ? el("button", { class: "btn small lime", type: "button", onclick: () => openProviderModal(null) }, icon("plus"), "Add Provider") : null),
      el("div", { class: "how-grid" }, ...data.providers.map((p) => el("div", { class: "card" },
        el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" } },
          el("h3", {}, icon("chip"), p.name),
          statusChip(p.runtime_available ? "healthy" : p.health_status)),
        el("dl", { class: "vals" },
          el("dt", {}, "Adapter"), el("dd", {}, p.adapter_type),
          el("dt", {}, "Base URL"), el("dd", {}, p.base_url || "—"),
          el("dt", {}, "API Key"), el("dd", {}, p.key_hint ? `Stored (${p.key_hint})` : "Not stored"),
          el("dt", {}, "Priority / Fallback"), el("dd", {}, `${p.priority} · ${p.fallback_provider_id || "none"}`),
          el("dt", {}, "Enabled"), el("dd", {}, p.enabled ? "Yes" : "Disabled")),
        p.last_error ? el("p", { style: { color: "var(--bad)", fontSize: "12px" } }, p.last_error) : null,
        el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
          canWrite ? el("button", {
            class: "btn small", type: "button",
            onclick: async () => {
              const r = await api(`/api/admin/providers/${p.id}/test`, { method: "POST" });
              toast(`${p.name}: ${r.message} (${r.latency_ms}ms)`, { error: !r.ok });
              load();
            },
          }, "Test Connection") : null,
          canWrite ? el("button", { class: "btn small ghost", type: "button", onclick: () => openProviderModal(p) }, "Configure") : null)))),
      el("div", { class: "card", style: { marginTop: "16px" } },
        el("h3", {}, "Recent Provider Request Logs"),
        data.logs.length ? el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
          el("thead", {}, el("tr", {}, el("th", {}, "Provider"), el("th", {}, "Endpoint"), el("th", {}, "HTTP"), el("th", {}, "Latency"), el("th", {}, "Error"), el("th", {}, "Time"))),
          el("tbody", {}, ...data.logs.slice(0, 20).map((l) => el("tr", {},
            el("td", {}, l.provider_id),
            el("td", {}, el("code", {}, l.endpoint)),
            el("td", {}, String(l.status_code ?? "—")),
            el("td", { class: "num" }, l.latency_ms != null ? `${l.latency_ms}ms` : "—"),
            el("td", { class: "dim" }, l.error_message || "OK"),
            el("td", { class: "dim" }, ago(l.created_at)))))))
          : el("p", {}, "No provider logs recorded yet.")));
  }

  load().catch((err) => toast(err.message, { error: true }));
}

// ---------------------------------------------------------------- Module E: AI Model Management

function renderModels(host) {
  const data = { models: [], roles: [], plans: [], search: "" };
  const canWrite = hasPerm("models.write");

  async function load() {
    const [mRes, rRes, pRes] = await Promise.all([
      api("/api/admin/models"),
      api("/api/admin/roles").catch(() => ({ roles: [] })),
      api("/api/admin/plans").catch(() => ({ plans: [] })),
    ]);
    data.models = mRes.models || [];
    data.roles = rRes.roles || [];
    data.plans = pRes.plans || [];
    draw();
  }

  function openModelModal(existing = null) {
    adminModal(existing ? `Edit Model: ${existing.display_name}` : "Add Cloud AI Model", (close) => {
      const provIn = el("input", { type: "text", value: existing?.provider_id || "fal" });
      const epIn = el("input", { type: "text", value: existing?.endpoint || "", disabled: Boolean(existing), placeholder: "fal-ai/flux/schnell" });
      const nameIn = el("input", { type: "text", value: existing?.display_name || "" });
      const catSel = el("select", { class: "adm-select" }, ...["image", "video", "audio", "utility"].map((c) => el("option", { value: c, selected: existing?.category === c }, c)));
      const capIn = el("input", { type: "text", value: existing?.capability || "text-to-image" });
      const credIn = el("input", { type: "number", value: String(existing?.credit_price ?? 1) });
      const costIn = el("input", { type: "number", step: "0.0001", value: existing?.internal_cost_usd != null ? String(existing.internal_cost_usd) : "" });
      const enabledCb = el("input", { type: "checkbox", checked: existing ? existing.enabled : true });
      const defaultCb = el("input", { type: "checkbox", checked: Boolean(existing?.is_default) });

      return el("div", { style: { display: "grid", gap: "10px" } },
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Provider ID"), provIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Category"), catSel)),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Model Endpoint"), epIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Display Name"), nameIn),
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Capability"), capIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Credit Price"), credIn)),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Internal Cost (USD)"), costIn),
        el("label", { class: "togrow" }, el("span", {}, "Model Enabled"), el("span", { class: "switch" }, enabledCb, el("i"))),
        el("label", { class: "togrow" }, el("span", {}, "Default for Category"), el("span", { class: "switch" }, defaultCb, el("i"))),
        el("button", {
          class: "btn lime", type: "button",
          onclick: async () => {
            try {
              const url = existing ? `/api/admin/models/${encodeURIComponent(existing.id)}` : "/api/admin/models";
              await api(url, {
                method: existing ? "PATCH" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  provider_id: provIn.value.trim(),
                  endpoint: epIn.value.trim(),
                  display_name: nameIn.value.trim(),
                  category: catSel.value,
                  capability: capIn.value.trim(),
                  credit_price: Number(credIn.value),
                  internal_cost_usd: costIn.value.trim() === "" ? null : Number(costIn.value),
                  enabled: enabledCb.checked,
                  is_default: defaultCb.checked,
                }),
              });
              toast("Model saved"); close(); load();
            } catch (err) { toast(err.message, { error: true }); }
          },
        }, "Save Model"));
    });
  }

  function draw() {
    const searchIn = el("input", {
      type: "search", value: data.search, placeholder: "Filter models…",
      oninput: () => { data.search = searchIn.value.trim().toLowerCase(); draw(); },
    });
    const list = data.models.filter((m) => !data.search || `${m.display_name} ${m.endpoint} ${m.category} ${m.provider_id}`.toLowerCase().includes(data.search));

    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "AI Model Catalog"), el("p", { class: "dim" }, `${data.models.length} registered models`)),
        el("div", { class: "adm-toolbar" },
          el("div", { class: "search" }, icon("search"), searchIn),
          canWrite ? el("button", {
            class: "btn small", type: "button",
            onclick: async () => {
              try {
                const r = await api("/api/admin/models/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider_id: "fal" }) });
                toast(`Synced ${r.fetched} models from provider API`);
                load();
              } catch (err) { toast(err.message, { error: true }); }
            },
          }, icon("refresh"), "Sync Provider Models") : null,
          canWrite ? el("button", { class: "btn small lime", type: "button", onclick: () => openModelModal(null) }, icon("plus"), "Add Model") : null)),
      el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "Model"), el("th", {}, "Provider"), el("th", {}, "Category"), el("th", {}, "Price (cr)"), el("th", {}, "Status"), el("th", {}, "Actions"))),
        el("tbody", {}, ...list.map((m) => el("tr", {},
          el("td", {}, el("b", {}, m.display_name), el("div", { class: "dim", style: { fontSize: "12px" } }, m.endpoint)),
          el("td", {}, m.provider_id),
          el("td", {}, `${m.category} · ${m.capability}`),
          el("td", { class: "num" }, String(m.credit_price)),
          el("td", {}, statusChip(m.enabled ? "active" : "disabled")),
          el("td", {}, canWrite ? el("div", { class: "adm-acts" },
            el("button", {
              class: "btn small ghost", type: "button",
              onclick: async () => {
                await api(`/api/admin/models/${encodeURIComponent(m.id)}`, {
                  method: "PATCH", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ enabled: !m.enabled }),
                });
                load();
              },
            }, m.enabled ? "Disable" : "Enable"),
            el("button", { class: "btn small ghost", type: "button", onclick: () => openModelModal(m) }, "Edit")) : null))))));
  }

  load().catch((err) => toast(err.message, { error: true }));
}

// ---------------------------------------------------------------- Module F: Studios, Apps & Feature Flags

function renderStudios(host) {
  const data = { studios: [], flags: [], models: [], search: "" };
  const canWrite = hasPerm("studios.write");

  async function load() {
    const d = await api("/api/admin/studios");
    data.studios = d.studios || [];
    data.flags = d.flags || [];
    data.models = d.models || [];
    draw();
  }

  function openAppModal(appCfg) {
    adminModal(`Configure Studio App: ${appCfg.name}`, (close) => {
      const nameIn = el("input", { type: "text", value: appCfg.name });
      const sumIn = el("textarea", { value: appCfg.summary || "" });
      const credIn = el("input", { type: "number", value: String(appCfg.credit_cost ?? 1) });
      const enabledCb = el("input", { type: "checkbox", checked: appCfg.enabled });
      const pubCb = el("input", { type: "checkbox", checked: appCfg.published });
      const maintCb = el("input", { type: "checkbox", checked: appCfg.maintenance_mode });
      const primSel = el("select", { class: "adm-select" },
        el("option", { value: "" }, "Default manifest model"),
        ...data.models.map((m) => el("option", { value: m.id, selected: appCfg.primary_model_id === m.id }, `${m.display_name} (${m.endpoint})`)));

      return el("div", { style: { display: "grid", gap: "10px" } },
        el("div", { class: "field" }, el("div", { class: "lbl" }, "App Name"), nameIn),
        el("div", { class: "field" }, el("div", { class: "lbl" }, "Summary"), sumIn),
        el("div", { class: "adm-2col" },
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Credit Cost per Run"), credIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, "Primary Model"), primSel)),
        el("label", { class: "togrow" }, el("span", {}, "Enabled"), el("span", { class: "switch" }, enabledCb, el("i"))),
        el("label", { class: "togrow" }, el("span", {}, "Published in Catalog"), el("span", { class: "switch" }, pubCb, el("i"))),
        el("label", { class: "togrow" }, el("span", {}, "App Maintenance Mode"), el("span", { class: "switch" }, maintCb, el("i"))),
        el("button", {
          class: "btn lime", type: "button",
          onclick: async () => {
            try {
              const mids = new Set(appCfg.model_ids || []);
              if (primSel.value) mids.add(primSel.value);
              await api(`/api/admin/studios/${appCfg.id}`, {
                method: "PATCH", headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  name: nameIn.value.trim(),
                  summary: sumIn.value.trim(),
                  credit_cost: Number(credIn.value),
                  enabled: enabledCb.checked,
                  published: pubCb.checked,
                  maintenance_mode: maintCb.checked,
                  primary_model_id: primSel.value || null,
                  model_ids: [...mids],
                }),
              });
              toast("Studio app updated"); close(); load();
            } catch (err) { toast(err.message, { error: true }); }
          },
        }, "Save App Settings"));
    });
  }

  function draw() {
    const searchIn = el("input", {
      type: "search", value: data.search, placeholder: "Search studio apps…",
      oninput: () => { data.search = searchIn.value.trim().toLowerCase(); draw(); },
    });
    const filtered = data.studios.filter((s) => !data.search || `${s.id} ${s.name} ${s.section}`.toLowerCase().includes(data.search));
    const sections = ["image", "video", "audio", "utility"];

    host.replaceChildren(
      el("div", { class: "adm-head" },
        el("div", {}, el("h1", { class: "display" }, "Studios, Apps & Feature Flags"), el("p", { class: "dim" }, "Control platform toggles, studio sections, pricing, and model bindings.")),
        el("div", { class: "search" }, icon("search"), searchIn)),
      el("div", { class: "adm-2col", style: { marginBottom: "16px" } },
        el("div", { class: "card" },
          el("h3", {}, "Studio Sections"),
          ...sections.map((sec) => {
            const secApps = data.studios.filter((s) => s.section === sec);
            const allOn = secApps.length > 0 && secApps.some((s) => s.studio_enabled);
            return el("div", { class: "mrow" },
              el("div", { class: "two" }, el("b", { style: { textTransform: "capitalize" } }, `${sec} Studio`), el("small", { class: "dim" }, `${secApps.length} tools`)),
              canWrite ? el("button", {
                class: `btn small${allOn ? " lime" : " ghost"}`, type: "button",
                onclick: async () => {
                  await api("/api/admin/studios/section", {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ section: sec, enabled: !allOn }),
                  });
                  toast(`${sec} studio ${!allOn ? "enabled" : "disabled"}`);
                  load();
                },
              }, allOn ? "Enabled" : "Disabled") : statusChip(allOn ? "active" : "disabled"));
          })),
        el("div", { class: "card" },
          el("h3", {}, "Platform Feature Flags"),
          ...data.flags.map((f) => el("div", { class: "mrow" },
            el("div", { class: "two" }, el("b", {}, f.flag_key), el("small", { class: "dim" }, f.description)),
            el("label", { class: "switch" },
              el("input", {
                type: "checkbox", checked: f.enabled, disabled: !hasPerm("settings.write"),
                onchange: async (e) => {
                  await api("/api/admin/flags", {
                    method: "PUT", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ flag_key: f.flag_key, enabled: e.target.checked }),
                  });
                  toast(`Flag ${f.flag_key} updated`);
                  load();
                },
              }),
              el("i")))))),
      el("div", { class: "adm-table-wrap" }, el("table", { class: "adm-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "App"), el("th", {}, "Section"), el("th", {}, "Credits"), el("th", {}, "State"), el("th", {}, "Model"), el("th", {}, "Actions"))),
        el("tbody", {}, ...filtered.map((s) => el("tr", {},
          el("td", {}, el("b", {}, s.name), el("div", { class: "dim", style: { fontSize: "12px" } }, s.id)),
          el("td", {}, s.section),
          el("td", { class: "num" }, String(s.credit_cost)),
          el("td", {}, s.maintenance_mode ? statusChip("maintenance") : statusChip(s.enabled && s.published ? "active" : "disabled")),
          el("td", {}, el("code", { style: { fontSize: "11.5px" } }, s.primary_model_id || "—")),
          el("td", {}, canWrite ? el("button", { class: "btn small ghost", type: "button", onclick: () => openAppModal(s) }, "Edit") : null))))));
  }

  load().catch((err) => toast(err.message, { error: true }));
}

// ---------------------------------------------------------------- Admin Control Centre Shell (#/admin)

export function adminView() {
  const root = el("div", { class: "adm-wrap" });
  let activeModule = "overview";
  let sidebarOpen = false;

  const MODULES = [
    ["overview", "Overview", "activity", "overview.read"],
    ["users", "Users", "users", "users.read"],
    ["roles", "Admins & Roles", "shield", "admins.read"],
    ["providers", "AI Providers", "chip", "providers.read"],
    ["models", "AI Models", "layers", "models.read"],
    ["studios", "Studios & Apps", "sliders", "studios.read"],
    ["generations", "Generations", "film", "generations.read"],
    ["billing", "Billing & Plans", "wallet", "credits.read"],
    ["messaging", "Messaging & Alerts", "bell", "notifications.send"],
    ["security", "Security & Logins", "lock", "auth.sessions.read"],
    ["settings", "Settings & Audit", "settings", "settings.read"],
  ];

  function drawBootstrapOrLogin() {
    const needsBootstrap = Boolean(session.bootstrap?.needs_admin_bootstrap);
    const emailIn = el("input", { type: "email", required: true, placeholder: "admin@spacix.io" });
    const nameIn = el("input", { type: "text", value: "Platform Super Admin" });
    const passIn = el("input", { type: "password", required: true, placeholder: "Min 8 characters" });
    const errEl = el("p", { class: "auth-err", hidden: true });

    const form = el("form", {
      class: "card", style: { maxWidth: "460px", margin: "48px auto", padding: "24px" },
      onsubmit: async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        try {
          const url = needsBootstrap ? "/api/auth/bootstrap-admin" : "/api/auth/login";
          const res = await api(url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email: emailIn.value.trim(),
              password: passIn.value,
              ...(needsBootstrap ? { display_name: nameIn.value.trim() } : { admin_portal: true }),
            }),
          });
          if (res.token) setAuthToken(res.token);
          await refreshBootstrap();
          draw();
        } catch (err) {
          errEl.textContent = err.message;
          errEl.hidden = false;
        }
      },
    },
    el("h1", { class: "display", style: { margin: 0, fontSize: "24px" } },
      needsBootstrap ? "Initialize Super Admin" : "Admin Control Centre Sign In"),
    el("p", { class: "dim" },
      needsBootstrap
        ? "No administrator account exists yet. Create the first Super Admin account to unlock platform controls."
        : "Sign in with an administrator account to access SPACIX operations."),
    needsBootstrap ? el("div", { class: "field" }, el("div", { class: "lbl" }, "Admin Name"), nameIn) : null,
    el("div", { class: "field" }, el("div", { class: "lbl" }, "Admin Email"), emailIn),
    el("div", { class: "field" }, el("div", { class: "lbl" }, "Password"), passIn),
    errEl,
    el("button", { class: "btn lime", type: "submit", style: { height: "42px" } },
      needsBootstrap ? "Create Super Admin" : "Sign In to Admin Portal"));

    root.replaceChildren(el("div", { class: "page" }, form));
  }

  function draw() {
    const user = session.user;
    if (!user || !user.is_admin) {
      drawBootstrapOrLogin();
      return;
    }

    const visibleModules = MODULES.filter(([, , , perm]) => hasPerm(perm));
    if (!visibleModules.some(([id]) => id === activeModule) && visibleModules[0]) {
      activeModule = visibleModules[0][0];
    }

    const contentHost = el("div", { class: "adm-content" });
    const navItems = visibleModules.map(([id, label, ic]) => el("button", {
      type: "button", class: `adm-nav-btn${activeModule === id ? " active" : ""}`,
      onclick: () => { activeModule = id; sidebarOpen = false; draw(); },
    }, icon(ic), el("span", {}, label)));

    const sidebar = el("aside", { class: `adm-side${sidebarOpen ? " open" : ""}` },
      el("div", { class: "adm-side-top" },
        el("b", {}, "Admin Control Centre"),
        el("small", { class: "dim" }, `${user.display_name} · ${(user.roles || []).join(", ")}`)),
      el("nav", { class: "adm-nav" }, ...navItems),
      el("a", { class: "btn small ghost", href: "#/" }, icon("left"), "Back to Studio"));

    const mobToggle = el("button", {
      class: "btn small ghost adm-mob-toggle", type: "button",
      onclick: () => { sidebarOpen = !sidebarOpen; sidebar.classList.toggle("open", sidebarOpen); },
    }, icon("menu"), "Admin Sections");

    root.replaceChildren(sidebar, el("div", { class: "adm-main" }, mobToggle, contentHost));

    if (activeModule === "overview") renderOverview(contentHost);
    else if (activeModule === "users") renderUsers(contentHost);
    else if (activeModule === "roles") renderRoles(contentHost);
    else if (activeModule === "providers") renderProviders(contentHost);
    else if (activeModule === "models") renderModels(contentHost);
    else if (activeModule === "studios") renderStudios(contentHost);
    else if (activeModule === "generations") renderGenerations(contentHost, { canManage: hasPerm("generations.manage") });
    else if (activeModule === "billing") renderBilling(contentHost, { canWriteCredits: hasPerm("credits.write"), canManageSubs: hasPerm("subscriptions.manage") });
    else if (activeModule === "messaging") renderMessaging(contentHost);
    else if (activeModule === "security") renderSecurity(contentHost, { canRevoke: hasPerm("auth.sessions.revoke") });
    else if (activeModule === "settings") renderSettingsAudit(contentHost, { canWriteSettings: hasPerm("settings.write"), canReadAudit: hasPerm("audit.read") });
  }

  const off = () => draw();
  session.listeners.add(off);
  draw();

  return {
    node: root,
    active: "admin",
    dispose: () => { session.listeners.delete(off); },
  };
}
