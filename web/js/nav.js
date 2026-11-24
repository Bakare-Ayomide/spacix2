// Top navigation bar: studios (hover menus via menu.js), featured apps, notifications, language switcher,
// and user account / credits menu (with Admin Control Centre shortcut shown ONLY to signed-in admins).
import { el, icon, logoMark, popover, closePopover, session } from "./util.js";
import { t, lang, LANGS, setLang } from "./i18n.js";
import { byId, FEATURED } from "./catalog.js";
import { attachMenus } from "./menu.js";
import { openAuthModal, openNotificationsPopover, logoutUser } from "./account.js";

/** Build the bar once; update() marks the current page. */
export function topbar({ onLang }) {
  const items = [
    ["explore", "#/", "compass"], ["image", "#/image", "image"], ["video", "#/video", "video"], ["audio", "#/audio", "audio"],
    ["apps", "#/apps", "layers"], ["library", "#/library", "film"],
  ];
  const links = new Map();
  const nav = el("nav", { class: "nav-main", "aria-label": "SPACIX" });
  for (const [key, hash] of items) {
    const a = el("a", { href: hash }, t(`nav.${key}`));
    links.set(key, a);
    nav.append(a);
  }
  nav.append(el("span", { class: "sep opt-hide" }));
  for (const f of FEATURED) {
    const app = byId.get(f.id);
    if (!app) continue;
    const a = el("a", { href: `#/app/${app.id}`, class: "opt-hide" }, app.name,
      f.tag ? el("span", { class: `tag${f.tag === "new" ? "" : " violet"}` }, t(`tag.${f.tag}`)) : null);
    links.set(app.id, a);
    nav.append(a);
  }

  const bellDot = el("span", { class: "bell-dot", hidden: true });
  const bellBtn = el("button", {
    class: "icon-btn bell-btn", type: "button", title: t("acc.notifications"), "aria-label": t("acc.notifications"),
    onclick: () => openNotificationsPopover(bellBtn),
  }, icon("bell"), bellDot);

  const langBtn = el("button", { class: "icon-btn", type: "button", title: t("nav.lang"), "aria-label": t("nav.lang") }, icon("globe"));
  langBtn.onclick = () => popover(langBtn, el("div", {}, ...LANGS.map(([code, name]) => el("button", {
    class: "opt", type: "button", "aria-selected": String(code === lang),
    onclick: () => { closePopover(); setLang(code); onLang(); },
  }, name, el("span", { class: "chk" }, icon("check"))))), { align: "end" });

  const accountBtn = el("button", { class: "gpu account-pill", type: "button", "aria-haspopup": "dialog" });

  const syncAccountUi = () => {
    const u = session.user;
    bellDot.hidden = !(u && session.unreadNotifications > 0);
    bellBtn.hidden = !u;
    if (!u) {
      accountBtn.className = "btn small ghost";
      accountBtn.replaceChildren(icon("user"), el("span", {}, t("auth.signin")));
      accountBtn.onclick = () => openAuthModal("login");
      return;
    }
    accountBtn.className = "gpu warm account-pill";
    accountBtn.replaceChildren(
      el("span", { class: "dot" }),
      el("span", { class: "lbl-long" }, u.display_name || "Account"),
      el("span", { class: "cred-badge" }, `${u.credit_balance ?? 0} ${t("acc.cr")}`),
    );
    accountBtn.onclick = () => popover(accountBtn, el("div", { style: { minWidth: "220px" } },
      el("h4", {}, u.email || u.display_name),
      el("a", { class: "opt", href: "#/account", onclick: closePopover }, icon("user"), t("acc.tab.profile")),
      el("a", { class: "opt", href: "#/account?tab=credits", onclick: closePopover }, icon("wallet"), t("acc.tab.credits")),
      el("a", { class: "opt", href: "#/account?tab=projects", onclick: closePopover }, icon("layers"), t("acc.tab.projects")),
      el("a", { class: "opt", href: "#/account?tab=notifications", onclick: closePopover }, icon("bell"), t("acc.tab.notifications")),
      u.is_admin ? el("a", { class: "opt", href: "#/admin", onclick: closePopover }, icon("shield"), t("nav.admin")) : null,
      el("button", {
        class: "opt", type: "button",
        onclick: () => { closePopover(); logoutUser(); },
      }, icon("lock"), t("auth.signout"))), { align: "end" });
  };
  syncAccountUi();
  const offSession = () => syncAccountUi();
  session.listeners.add(offSession);

  // phones: the same links in a menu
  const menuBtn = el("button", { class: "icon-btn menu-btn", type: "button", "aria-label": t("nav.menu") }, icon("menu"));
  menuBtn.onclick = () => {
    const rows = [
      ...items.map(([key, hash, ic]) => [t(`nav.${key}`), hash, ic]),
      ...FEATURED.filter((f) => byId.has(f.id)).map((f) => [byId.get(f.id).name, `#/app/${f.id}`, "spark"]),
      [t("acc.title"), "#/account", "user"],
    ];
    if (session.user?.is_admin) rows.push([t("nav.admin"), "#/admin", "shield"]);
    popover(menuBtn, el("div", {}, ...rows.map(([label, hash, ic]) => el("a", { class: "opt", href: hash, onclick: closePopover }, icon(ic), label))));
  };

  const brandName = session.bootstrap?.platform_name || "SPACIX";
  const bar = el("header", { class: "topbar" },
    menuBtn,
    el("a", { class: "logo", href: "#/", "aria-label": brandName }, logoMark(), el("span", { class: "word" }, brandName)),
    nav,
    el("div", { class: "nav-right" }, bellBtn, langBtn, accountBtn, el("a", { class: "btn lime small cta", href: "#/image" }, icon("spark"), t("nav.create"))));
  attachMenus(bar, links);

  return {
    node: bar,
    update(active) {
      for (const [key, a] of links) {
        if (key === active) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      }
    },
    dispose() {
      session.listeners.delete(offSession);
    },
  };
}
