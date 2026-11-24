// Boot and routing. Each route builds a view ({ node, dispose, active }) into <main>.
//   #/                 Explore         #/apps      the app store       #/app/<id>  an app's workspace
//   #/image #/video #/audio            the studios (open the last app used there)
//   #/library          history & examples                               #/account    user profile, credits & projects
//   #/admin            RBAC-protected Admin Control Centre (admin accounts & first-run bootstrap)
import { el, closePopover, toast, session } from "./util.js";
import { t } from "./i18n.js";
import { loadCatalog, byId, lastAppFor, studioOf, FEATURED } from "./catalog.js";
import { topbar } from "./nav.js";
import { exploreView, appsView, libraryView } from "./views.js";
import { workspaceView, recreate, useIn } from "./workspace.js";
import { accountView, announcementStrip, refreshBootstrap } from "./account.js";
import { adminView } from "./admin.js";
import { hooks } from "./feed.js";
import { openViewer } from "./viewer.js";
import { openCompare } from "./compare.js";
import { flags } from "./flags.js";

const main = el("main", { id: "main", class: "view" });
let bar = null;
let current = null;

function route() {
  const hash = location.hash || "#/";
  const m = /^#\/app\/([\w-]+)/.exec(hash);
  if (m) {
    const view = workspaceView(m[1]);
    const app = view.app;
    const featured = app && FEATURED.some((f) => f.id === app.id);
    return { ...view, active: app ? (featured ? app.id : studioOf(app)) : "apps" };
  }
  const studio = /^#\/(image|video|audio)$/.exec(hash);
  if (studio) {
    location.replace(`#/app/${lastAppFor(studio[1])}`);
    return null;
  }
  if (hash.startsWith("#/apps")) return appsView();
  if (hash.startsWith("#/library")) return libraryView();
  if (hash.startsWith("#/account")) return accountView();
  if (hash.startsWith("#/admin")) return adminView();
  return exploreView();
}

function render({ keepScroll = false } = {}) {
  closePopover();
  const view = route();
  if (!view) return;   // redirected
  current?.dispose?.();
  current = view;
  main.replaceChildren(view.node);
  bar?.update(view.active);
  if (!keepScroll) window.scrollTo(0, 0);
  const app = view.app;
  const brand = session.bootstrap?.platform_name || "SPACIX";
  document.title = app ? `${app.name} · ${brand}` : view.active === "admin" ? `Admin · ${brand}` : brand;
}

const strip = announcementStrip();
function buildBar() {
  const next = topbar({ onLang: () => { buildBar(); render({ keepScroll: true }); } });
  if (bar) {
    bar.dispose?.();
    bar.node.replaceWith(next.node);
  } else {
    document.body.prepend(next.node);
  }
  bar = next;
  bar.node.after(strip);
}

hooks.open = (items, key) => openViewer(items, key);
hooks.recreate = (item) => recreate(item);
hooks.retry = (item) => recreate(item, { run: true });
hooks.compare = (item) => openCompare(item);
hooks.useIn = (anchor, item, done) => useIn(anchor, item, done);
hooks.rerender = () => render({ keepScroll: true });

async function boot() {
  document.body.append(main);
  try {
    await refreshBootstrap();
    await loadCatalog();
    await flags.load();
  } catch (err) {
    main.replaceChildren(el("div", { class: "page" }, el("div", { class: "empty" }, `${err.message}. ${t("boot.error")}`)));
    return;
  }
  buildBar();
  window.addEventListener("hashchange", () => render());
  render();
}

window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.name === "AbortError") return;
  toast(String(e.reason?.message || e.reason), { error: true });
});
boot();
export { byId, t };
