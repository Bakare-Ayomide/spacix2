// Regular user account, authentication modal, active announcement strip, wallet/plans, projects, and notifications.
// Strictly excludes all backend, database, provider, and infrastructure configuration.
import {
  api, el, icon, toast, popover, closePopover,
  session, setBootstrap, setSessionUser, setAuthToken,
} from "./util.js";
import { t, ago } from "./i18n.js";
import { loadCatalog } from "./catalog.js";
import { feed } from "./feed.js";

const dismissedAnnouncements = new Set();

export async function refreshBootstrap() {
  const data = await api("/api/bootstrap");
  setBootstrap(data);
  if (data?.user) {
    refreshNotifications().catch(() => {});
  } else {
    session.unreadNotifications = 0;
  }
  return data;
}

export async function refreshNotifications() {
  if (!session.user) {
    session.unreadNotifications = 0;
    return { notifications: [], unread: 0 };
  }
  const d = await api("/api/notifications");
  session.unreadNotifications = Number(d?.unread ?? 0);
  for (const fn of session.listeners) {
    try { fn(session); } catch { /* ignore */ }
  }
  return d;
}

async function onAuthSuccess(authRes) {
  if (authRes?.token) setAuthToken(authRes.token);
  await refreshBootstrap();
  await loadCatalog().catch(() => {});
  feed.loaded.clear();
  feed.entries.clear();
  feed.emit();
}

export async function logoutUser() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  setAuthToken(null);
  setSessionUser(null);
  session.unreadNotifications = 0;
  await refreshBootstrap().catch(() => {});
  await loadCatalog().catch(() => {});
  feed.loaded.clear();
  feed.entries.clear();
  feed.emit();
  toast(t("auth.signed_out"));
}

// ------------------------------------------------------------------ Announcement Banner

export function announcementStrip() {
  const node = el("div", { class: "mstrip", hidden: true, role: "status", "aria-live": "polite" });
  const draw = () => {
    const b = session.bootstrap;
    if (b?.maintenance_mode) {
      node.hidden = false;
      node.className = "mstrip bad";
      node.replaceChildren(el("div", { class: "in" },
        icon("alert"),
        el("b", { class: "msg" }, b.maintenance_message || t("ws.maintenance"))));
      return;
    }
    const list = (b?.announcements || []).filter((a) => a.active && !dismissedAnnouncements.has(a.id));
    if (!list.length) {
      node.hidden = true;
      return;
    }
    const top = list[0];
    const cls = top.severity === "warning" || top.severity === "maintenance" ? "warn" : "";
    node.hidden = false;
    node.className = `mstrip${cls ? ` ${cls}` : ""}`;
    node.replaceChildren(el("div", { class: "in" },
      icon(top.severity === "warning" || top.severity === "maintenance" ? "alert" : "info"),
      el("span", { class: "msg" }, el("b", {}, top.title), top.body ? ` — ${top.body}` : ""),
      el("button", {
        class: "icon-btn", type: "button", "aria-label": t("act.close"),
        onclick: () => { dismissedAnnouncements.add(top.id); draw(); },
      }, icon("x"))));
  };
  session.listeners.add(draw);
  draw();
  return node;
}

// ------------------------------------------------------------------ Auth Modal (Sign in / Register / Reset)

let openAuthCloser = null;

export function openAuthModal(initialMode = "login", { onSuccess } = {}) {
  openAuthCloser?.();
  let mode = initialMode;
  const b = session.bootstrap || {};
  const canRegister = b.registration_enabled !== false;
  if (mode === "register" && !canRegister) mode = "login";

  const box = el("div", { class: "auth-card", role: "dialog", "aria-modal": "true", "aria-label": t("auth.title") });
  const shade = el("div", { class: "auth-shade" }, box);
  const prevFocus = document.activeElement;

  const close = () => {
    shade.remove();
    document.removeEventListener("keydown", onKey, true);
    document.body.style.overflow = "";
    if (openAuthCloser === close) openAuthCloser = null;
    prevFocus?.focus?.({ preventScroll: true });
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  shade.addEventListener("pointerdown", (e) => { if (e.target === shade) close(); });

  function draw() {
    const emailIn = el("input", { type: "email", required: true, placeholder: "you@example.com", autocomplete: "email" });
    const nameIn = el("input", { type: "text", placeholder: t("auth.name.ph"), autocomplete: "name" });
    const passIn = el("input", { type: "password", required: true, placeholder: "••••••••", autocomplete: mode === "login" ? "current-password" : "new-password" });
    const tokenIn = el("input", { type: "text", placeholder: t("auth.reset.token.ph") });
    const errEl = el("p", { class: "auth-err", hidden: true });
    let busy = false;

    const showErr = (msg) => { errEl.textContent = msg; errEl.hidden = !msg; };

    const form = el("form", {
      class: "auth-form",
      onsubmit: async (e) => {
        e.preventDefault();
        if (busy) return;
        showErr("");
        busy = true;
        try {
          if (mode === "login") {
            const res = await api("/api/auth/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email: emailIn.value.trim(), password: passIn.value }),
            });
            await onAuthSuccess(res);
            toast(t("auth.welcome", { name: res.user?.display_name || "" }));
            close();
            onSuccess?.(res.user);
          } else if (mode === "register") {
            const res = await api("/api/auth/register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                email: emailIn.value.trim(),
                password: passIn.value,
                display_name: nameIn.value.trim(),
              }),
            });
            await onAuthSuccess(res);
            toast(res.verification_required ? t("auth.created.verify") : t("auth.created"));
            close();
            onSuccess?.(res.user);
          } else if (mode === "forgot") {
            await api("/api/auth/request-reset", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email: emailIn.value.trim() }),
            });
            toast(t("auth.reset.sent"));
            mode = "reset";
            draw();
          } else if (mode === "reset") {
            await api("/api/auth/reset-password", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token: tokenIn.value.trim(), password: passIn.value }),
            });
            toast(t("auth.reset.done"));
            mode = "login";
            draw();
          }
        } catch (err) {
          showErr(err.message);
        } finally {
          busy = false;
        }
      },
    });

    const tabs = el("div", { class: "tabs", style: { width: "100%" } },
      el("button", { type: "button", "aria-selected": String(mode === "login"), onclick: () => { mode = "login"; draw(); } }, t("auth.signin")),
      canRegister ? el("button", { type: "button", "aria-selected": String(mode === "register"), onclick: () => { mode = "register"; draw(); } }, t("auth.register")) : null,
      el("button", { type: "button", "aria-selected": String(mode === "forgot" || mode === "reset"), onclick: () => { mode = "forgot"; draw(); } }, t("auth.forgot")));

    form.append(
      mode !== "reset" ? el("label", { class: "auth-lbl" }, t("auth.email"), emailIn) : null,
      mode === "register" ? el("label", { class: "auth-lbl" }, t("auth.name"), nameIn) : null,
      mode === "reset" ? el("label", { class: "auth-lbl" }, t("auth.reset.token"), tokenIn) : null,
      mode !== "forgot" ? el("label", { class: "auth-lbl" }, mode === "reset" ? t("auth.password.new") : t("auth.password"), passIn) : null,
      errEl,
      el("button", { class: "btn lime", type: "submit", style: { width: "100%", height: "40px" } },
        mode === "login" ? t("auth.signin") : mode === "register" ? t("auth.register") : mode === "forgot" ? t("auth.reset.send") : t("auth.reset.submit")),
      mode === "forgot" ? el("button", {
        class: "link-btn", type: "button", style: { justifySelf: "start", fontSize: "12.5px" },
        onclick: () => { mode = "reset"; draw(); },
      }, t("auth.reset.havetoken")) : null);

    box.replaceChildren(
      el("div", { class: "mhead" },
        el("h2", { class: "display", style: { fontSize: "22px" } }, b.platform_name || "SPACIX"),
        el("button", { class: "icon-btn", type: "button", "aria-label": t("act.close"), onclick: close }, icon("x"))),
      tabs,
      form);
  }

  draw();
  document.body.append(shade);
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey, true);
  openAuthCloser = close;
  box.querySelector("input")?.focus?.({ preventScroll: true });
  return close;
}

// ------------------------------------------------------------------ Notifications Popover

export async function openNotificationsPopover(anchor) {
  if (!session.user) {
    openAuthModal("login");
    return;
  }
  const wrap = el("div", { class: "pad", style: { width: "330px" } }, el("p", { class: "help" }, t("acc.loading")));
  popover(anchor, wrap, { align: "end" });
  try {
    const d = await refreshNotifications();
    const list = d?.notifications || [];
    if (!wrap.isConnected) return;
    wrap.replaceChildren(
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("h4", { style: { margin: 0 } }, t("acc.notifications")),
        d.unread > 0 ? el("button", {
          class: "mini-link", type: "button",
          onclick: async () => {
            await api("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
            await refreshNotifications();
            closePopover();
          },
        }, t("acc.mark_all_read")) : null),
      list.length
        ? el("div", { style: { display: "grid", gap: "6px", maxHeight: "280px", overflowY: "auto" } },
          ...list.slice(0, 10).map((n) => el("div", {
            class: `notif-item${n.read_at ? "" : " unread"}`,
            onclick: async () => {
              if (!n.read_at) {
                await api("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: n.id }) }).catch(() => {});
                refreshNotifications().catch(() => {});
              }
            },
          },
          el("b", {}, n.title),
          el("small", { class: "dim" }, n.body),
          el("small", { class: "faint" }, ago(n.created_at)))))
        : el("p", { class: "help" }, t("acc.notif_empty")),
      el("a", { class: "btn small", href: "#/account?tab=notifications", onclick: closePopover }, t("acc.open_account")));
  } catch (err) {
    if (wrap.isConnected) wrap.replaceChildren(el("p", { class: "help" }, err.message));
  }
}

// ------------------------------------------------------------------ Account View (#/account)

export function accountView() {
  const tabMatch = /\?tab=([\w-]+)/.exec(location.hash);
  let activeTab = tabMatch ? tabMatch[1] : "profile";
  const root = el("div", { class: "page" });

  let data = { credits: null, plans: session.bootstrap?.plans || [], projects: [], notifications: [] };

  async function loadTabData() {
    if (!session.user) {
      draw();
      return;
    }
    const [credits, plansRes, projectsRes, notifRes] = await Promise.all([
      api("/api/credits").catch(() => null),
      api("/api/plans").catch(() => ({ plans: [] })),
      api("/api/projects").catch(() => ({ projects: [] })),
      refreshNotifications().catch(() => ({ notifications: [] })),
    ]);
    data = {
      credits,
      plans: plansRes?.plans || [],
      projects: projectsRes?.projects || [],
      notifications: notifRes?.notifications || [],
    };
    draw();
  }

  function draw() {
    const user = session.user;
    if (!user) {
      root.replaceChildren(
        el("div", { class: "sec-head", style: { marginTop: "8px" } },
          el("div", {},
            el("h1", { class: "display", style: { margin: 0, fontSize: "clamp(28px, 3.6vw, 44px)" } }, t("acc.title")),
            el("p", {}, t("acc.guest_sub")))),
        el("div", { class: "card", style: { maxWidth: "460px" } },
          el("h3", {}, icon("user"), t("auth.signin_prompt")),
          el("p", {}, t("acc.guest_card")),
          el("div", { class: "row", style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
            el("button", { class: "btn lime", type: "button", onclick: () => openAuthModal("login", { onSuccess: () => loadTabData() }) }, t("auth.signin")),
            session.bootstrap?.registration_enabled !== false
              ? el("button", { class: "btn ghost", type: "button", onclick: () => openAuthModal("register", { onSuccess: () => loadTabData() }) }, t("auth.register"))
              : null)));
      return;
    }

    const tabs = el("div", { class: "tabs", style: { marginBottom: "18px" } }, ...[
      ["profile", t("acc.tab.profile")],
      ["credits", t("acc.tab.credits")],
      ["projects", t("acc.tab.projects")],
      ["notifications", t("acc.tab.notifications")],
    ].map(([id, label]) => el("button", {
      type: "button", "aria-selected": String(activeTab === id),
      onclick: () => { activeTab = id; draw(); },
    }, label)));

    let panel = null;

    if (activeTab === "profile") {
      const nameIn = el("input", { type: "text", value: user.display_name || "" });
      const compIn = el("input", { type: "text", value: user.profile?.company || "", placeholder: t("acc.company.ph") });
      const bioIn = el("textarea", { value: user.profile?.bio || "", placeholder: t("acc.bio.ph"), style: { minHeight: "74px" } });
      const curPass = el("input", { type: "password", placeholder: "••••••••" });
      const newPass = el("input", { type: "password", placeholder: "••••••••" });
      const verifyIn = el("input", { type: "text", placeholder: t("acc.verify.ph") });

      panel = el("div", { class: "how-grid" },
        el("div", { class: "card" },
          el("h3", {}, icon("user"), t("acc.profile.info")),
          el("dl", { class: "vals" },
            el("dt", {}, t("auth.email")), el("dd", {}, user.email || "—"),
            el("dt", {}, t("acc.status")), el("dd", {}, user.email_verified ? t("acc.verified") : t("acc.unverified")),
            el("dt", {}, t("acc.plan")), el("dd", {}, data.plans.find((p) => p.id === user.subscription_plan_id)?.name || user.subscription_plan_id || "Free")),
          !user.email_verified ? el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
            verifyIn,
            el("button", {
              class: "btn small", type: "button",
              onclick: async () => {
                try {
                  const res = await api("/api/auth/verify-email", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ token: verifyIn.value.trim() }),
                  });
                  setSessionUser(res.user);
                  toast(t("acc.verified"));
                  draw();
                } catch (err) { toast(err.message, { error: true }); }
              },
            }, t("acc.verify.btn"))) : null,
          el("div", { class: "field" }, el("div", { class: "lbl" }, t("auth.name")), nameIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, t("acc.company")), compIn),
          el("div", { class: "field" }, el("div", { class: "lbl" }, t("acc.bio")), bioIn),
          el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
            el("button", {
              class: "btn lime small", type: "button",
              onclick: async () => {
                try {
                  const res = await api("/api/account/profile", {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ display_name: nameIn.value.trim(), company: compIn.value.trim(), bio: bioIn.value.trim() }),
                  });
                  setSessionUser(res.user);
                  toast(t("acc.saved"));
                } catch (err) { toast(err.message, { error: true }); }
              },
            }, icon("check"), t("acc.save")),
            user.is_admin ? el("a", { class: "btn small ghost", href: "#/admin" }, icon("shield"), t("nav.admin")) : null,
            el("button", { class: "btn small ghost", type: "button", onclick: () => logoutUser().then(draw) }, t("auth.signout")))),

        el("div", { class: "card" },
          el("h3", {}, icon("lock"), t("acc.password.title")),
          el("div", { class: "field" }, el("div", { class: "lbl" }, t("acc.password.current")), curPass),
          el("div", { class: "field" }, el("div", { class: "lbl" }, t("auth.password.new")), newPass),
          el("button", {
            class: "btn small", type: "button",
            onclick: async () => {
              try {
                await api("/api/account/password", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ current_password: curPass.value, new_password: newPass.value }),
                });
                curPass.value = "";
                newPass.value = "";
                toast(t("acc.password.updated"));
              } catch (err) { toast(err.message, { error: true }); }
            },
          }, t("acc.password.update"))));
    } else if (activeTab === "credits") {
      const summary = data.credits || { balance: user.credit_balance ?? 0, lifetime_granted: 0, lifetime_spent: 0, transactions: [] };
      const txs = summary.transactions || [];
      panel = el("div", { style: { display: "grid", gap: "18px" } },
        el("div", { class: "how-grid" },
          el("div", { class: "card" },
            el("h3", {}, icon("wallet"), t("acc.credits.balance")),
            el("div", { class: "display", style: { fontSize: "38px", color: "var(--accent)" } }, String(summary.balance ?? 0)),
            el("dl", { class: "vals" },
              el("dt", {}, t("acc.credits.granted")), el("dd", {}, String(summary.lifetime_granted ?? 0)),
              el("dt", {}, t("acc.credits.spent")), el("dd", {}, String(summary.lifetime_spent ?? 0)))),
          el("div", { class: "card" },
            el("h3", {}, icon("layers"), t("acc.plans.title")),
            ...data.plans.map((pl) => el("div", { class: "mrow" },
              el("div", { class: "two" },
                el("b", {}, pl.name),
                el("small", { class: "dim" }, `${pl.monthly_credits} credits / ${pl.billing_interval}`)),
              el("span", { class: `chip ${user.subscription_plan_id === pl.id ? "ok" : "faint"}` },
                user.subscription_plan_id === pl.id ? t("acc.plan.current") : `$${(pl.price_cents / 100).toFixed(2)}`))))),
        el("div", { class: "card" },
          el("h3", {}, t("acc.credits.history")),
          txs.length
            ? el("div", { class: "vtable" }, ...txs.map((tx) => el("div", { class: "vrow", style: { cursor: "default" } },
              el("div", { class: "nm" }, el("b", {}, tx.reason), el("small", {}, ago(tx.created_at))),
              el("span", { class: "dim" }, tx.tx_type),
              el("b", { style: { color: tx.delta >= 0 ? "var(--ok)" : "var(--ink)" } }, `${tx.delta >= 0 ? "+" : ""}${tx.delta}`))))
            : el("p", {}, t("acc.credits.empty"))));
    } else if (activeTab === "projects") {
      const pName = el("input", { type: "text", placeholder: t("acc.proj.ph") });
      const pDesc = el("input", { type: "text", placeholder: t("acc.proj.desc_ph") });
      panel = el("div", { class: "card" },
        el("h3", {}, icon("layers"), t("acc.tab.projects")),
        el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
          el("div", { class: "field", style: { flex: "1 1 200px" } }, pName),
          el("div", { class: "field", style: { flex: "2 1 260px" } }, pDesc),
          el("button", {
            class: "btn lime", type: "button",
            onclick: async () => {
              const name = pName.value.trim();
              if (!name) return;
              try {
                await api("/api/projects", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name, description: pDesc.value.trim() }),
                });
                pName.value = "";
                pDesc.value = "";
                await loadTabData();
              } catch (err) { toast(err.message, { error: true }); }
            },
          }, icon("plus"), t("acc.proj.create"))),
        data.projects.length
          ? el("div", { class: "vtable" }, ...data.projects.map((pr) => el("div", { class: "vrow", style: { cursor: "default" } },
            el("div", { class: "nm" }, el("b", {}, pr.name), el("small", {}, pr.description || "—")),
            el("span", { class: "dim" }, ago(pr.created_at)),
            el("span", { class: "chip" }, pr.id.slice(0, 12)))))
          : el("p", {}, t("acc.proj.empty")));
    } else {
      panel = el("div", { class: "card" },
        el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" } },
          el("h3", {}, icon("bell"), t("acc.notifications")),
          data.notifications.some((n) => !n.read_at) ? el("button", {
            class: "btn small ghost", type: "button",
            onclick: async () => {
              await api("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
              await loadTabData();
            },
          }, t("acc.mark_all_read")) : null),
        data.notifications.length
          ? el("div", { class: "vtable" }, ...data.notifications.map((n) => el("div", {
            class: "vrow",
            style: { borderColor: n.read_at ? "var(--line)" : "var(--accent)" },
            onclick: async () => {
              if (!n.read_at) {
                await api("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: n.id }) });
                loadTabData();
              }
            },
          },
          el("div", { class: "nm" }, el("b", {}, n.title), el("small", {}, n.body)),
          el("span", { class: "dim" }, ago(n.created_at)),
          el("span", { class: `chip ${n.read_at ? "faint" : "ok"}` }, n.read_at ? t("acc.read") : t("acc.unread")))))
          : el("p", {}, t("acc.notif_empty")));
    }

    root.replaceChildren(
      el("div", { class: "sec-head", style: { marginTop: "8px" } },
        el("div", {},
          el("h1", { class: "display", style: { margin: 0, fontSize: "clamp(28px, 3.6vw, 44px)" } }, user.display_name || t("acc.title")),
          el("p", {}, `${user.email || ""} · ${user.credit_balance ?? 0} credits`))),
      tabs,
      panel);
  }

  const off = session.listeners.add(() => draw());
  draw();
  loadTabData();

  return {
    node: root,
    active: "account",
    dispose: () => { session.listeners.delete(off); },
  };
}
