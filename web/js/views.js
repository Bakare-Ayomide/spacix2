// Top-level studio pages: Explore, Apps store, and Library.
import { el, icon, masonry } from "./util.js";
import { t } from "./i18n.js";
import {
  apps, byId, CATEGORIES, START_HERE, HERO, hosted,
  tagline, estimate, iconOf, categoryOf,
} from "./catalog.js";
import { exampleItem, thumb, hoverPlay, optionTile } from "./media.js";
import { feedView } from "./feed.js";
import { openViewer } from "./viewer.js";
import { flags, flagButton } from "./flags.js";
import { needTag } from "./models.js";
import { loadExampleInto } from "./workspace.js";

function exampleItemsList() {
  return apps.map((a) => exampleItem(a)).filter(Boolean);
}

function gallerySpotlight() {
  const items = [];
  for (const app of apps) {
    const optMap = app.example?.options;
    if (!optMap) continue;
    for (const input of app.inputs) {
      if (!input.gallery || !input.options) continue;
      const shots = optMap[input.id];
      if (!shots) continue;
      for (const opt of input.options) {
        const shot = shots[String(opt.value)];
        if (!shot) continue;
        items.push({ app, input, opt, shot });
      }
    }
  }
  if (!items.length) return null;
  const pick = items.slice(0, 12);
  return el("section", {},
    el("div", { class: "sec-head" },
      el("div", {},
        el("h2", { class: "display" }, byId.get("effects")?.name ?? "Effects"),
        el("p", {}, t("explore.gallery.sub"))),
      el("a", { class: "more", href: "#/app/effects" }, t("explore.seeall"), icon("right"))),
    el("div", { class: "fx-wall" }, ...pick.map(({ app, input, opt, shot }) =>
      optionTile(opt, shot, {
        play: "hover",
        flagKey: flags.key(app.id, input.id, opt.value),
        onPick: () => { location.hash = `#/app/${app.id}?opt=${encodeURIComponent(`${input.id}:${opt.value}`)}`; },
      }))));
}

export function exploreView() {
  const cleanups = [];
  const exItems = exampleItemsList();
  const byAppEx = new Map(exItems.map((it) => [it.app, it]));

  const heroCards = HERO.map((id) => {
    const app = byId.get(id);
    const ex = app ? byAppEx.get(app.id) : null;
    if (!app || !ex) return null;
    const media = thumb(ex, { play: "hover" });
    const card = el("a", { class: "hero-card", href: `#/app/${app.id}` },
      media,
      el("div", { class: "txt" },
        el("span", { class: "tag" }, app.section.toUpperCase()),
        el("h3", { class: "display" }, app.name),
        el("p", {}, tagline(app))));
    hoverPlay(card, media._video);
    return card;
  }).filter(Boolean);

  const heroRow = el("div", { class: "hero-row" }, ...heroCards);
  const scrollHero = (dir) => heroRow.scrollBy({ left: dir * Math.max(320, heroRow.clientWidth * 0.72), behavior: "smooth" });

  const startSection = hosted ? el("section", {},
    el("div", { class: "sec-head" },
      el("div", {},
        el("h2", { class: "display" }, t("start.title")),
        el("p", {}, t("start.sub")))),
    el("div", { class: "start5" }, ...START_HERE.map((id) => {
      const app = byId.get(id);
      const ex = app ? byAppEx.get(id) : null;
      if (!app || !ex) return null;
      const media = thumb(ex, { play: "hover" });
      const est = estimate(app);
      const card = el("button", {
        class: "start-card", type: "button",
        onclick: () => loadExampleInto(app),
      },
      media,
      el("span", { class: "nm" }, app.name),
      el("span", { class: "dim" }, est ? t("start.secs", { s: est.seconds }) : tagline(app)));
      hoverPlay(card, media._video);
      return card;
    }).filter(Boolean))) : null;

  const tiles6Data = [
    ["#/image", "image", t("tile.image.t"), t("tile.image.d")],
    ["#/video", "video", t("tile.video.t"), t("tile.video.d")],
    ["#/audio", "audio", t("tile.audio.t"), t("tile.audio.d")],
    ["#/apps", "layers", t("tile.apps.t"), t("tile.apps.d")],
    ["#/library", "film", t("tile.library.t"), t("tile.library.d")],
    ["#/account", "user", t("tile.account.t"), t("tile.account.d")],
  ];

  const promo = el("section", { class: "promo" },
    el("div", { class: "promo-lead" },
      el("div", {},
        el("h2", { class: "display" }, t("explore.lead.a"), " ", el("em", {}, t("explore.lead.b"))),
        el("p", { style: { marginTop: "12px" } }, t("explore.lead.text"))),
      el("div", { class: "row" },
        el("a", { class: "btn lime", href: "#/image" }, icon("spark"), t("explore.start")),
        el("a", { class: "btn ghost", href: "#/apps" }, t("explore.browse"), " · ", t("explore.apps", { n: apps.length })))),
    el("div", { class: "tiles6" }, ...tiles6Data.map(([href, ic, title, desc]) =>
      el("a", { class: "tile6", href },
        el("div", { class: "ic" }, icon(ic)),
        el("div", { class: "t" }, title),
        el("p", {}, desc)))));

  const masonryHost = el("div");
  if (exItems.length) {
    const cards = exItems.slice(0, 36).map((item) => {
      const app = byId.get(item.app);
      const media = thumb(item, { play: "visible" });
      const node = el("div", {
        class: "m-item", tabindex: "0", role: "button",
        "aria-label": app?.name ?? item.app,
        onclick: () => openViewer(exItems, item.key),
        onkeydown: (e) => { if (e.key === "Enter") openViewer(exItems, item.key); },
      },
      media,
      flagButton(flags.key(item.app), { mini: true }),
      el("div", { class: "cap" },
        el("span", {}, app?.name ?? item.app),
        el("span", { class: "tag dark" }, item.type)));
      return node;
    });
    masonry(masonryHost, cards, { min: 240, gap: 12 });
    cleanups.push(() => masonryHost._ro?.disconnect());
  } else {
    masonryHost.append(el("div", { class: "empty" }, t("explore.noex")));
  }

  const madeSection = el("section", {},
    el("div", { class: "sec-head" },
      el("div", {},
        el("h2", { class: "display" }, t("explore.made")),
        el("p", {}, t("explore.made.sub"))),
      el("a", { class: "more", href: "#/apps" }, t("explore.seeall"), icon("right"))),
    masonryHost);

  const howSection = el("section", {},
    el("div", { class: "sec-head" }, el("h2", { class: "display" }, t("explore.how"))),
    el("div", { class: "how" },
      el("div", {}, el("div", { class: "n" }, "01"), el("h3", {}, t("how.1.t")), el("p", {}, t("how.1.d"))),
      el("div", {}, el("div", { class: "n" }, "02"), el("h3", {}, t("how.2.t")), el("p", {}, t("how.2.d"))),
      el("div", {}, el("div", { class: "n" }, "03"), el("h3", {}, t("how.3.t")), el("p", {}, t("how.3.d")))));

  const page = el("div", { class: "page" },
    startSection,
    heroCards.length ? el("section", { class: "hero-wrap" },
      heroRow,
      el("button", { class: "hero-nav prev", type: "button", "aria-label": t("act.prev"), onclick: () => scrollHero(-1) }, icon("left")),
      el("button", { class: "hero-nav next", type: "button", "aria-label": t("act.next"), onclick: () => scrollHero(1) }, icon("right"))) : null,
    promo,
    gallerySpotlight(),
    madeSection,
    howSection);

  return { node: page, active: "explore", dispose: () => cleanups.forEach((fn) => fn()) };
}

export function appsView() {
  let selectedCat = "all";
  let query = "";

  const qParam = /\?cat=([\w-]+)/.exec(location.hash);
  if (qParam) selectedCat = qParam[1];

  const searchInput = el("input", {
    type: "search", placeholder: t("apps.search"), "aria-label": t("apps.search"),
    oninput: () => { query = searchInput.value.trim().toLowerCase(); drawGrid(); },
  });

  const catIds = ["all", ...CATEGORIES.map((c) => c.id)];
  const hasMore = apps.some((a) => categoryOf(a.id) === "more");
  if (hasMore) catIds.push("more");

  const pills = el("div", { class: "pills" });
  const body = el("div");

  function drawPills() {
    pills.replaceChildren(...catIds.map((id) =>
      el("button", {
        type: "button", "aria-pressed": String(selectedCat === id),
        onclick: () => { selectedCat = id; drawPills(); drawGrid(); },
      }, id === "all" ? t("apps.all") : t(`cat.${id}.t`))));
  }

  function appCard(app) {
    const ex = exampleItem(app);
    const media = ex
      ? thumb(ex, { play: "hover" })
      : el("div", { class: "media" }, el("span", { class: "placeholder" }, icon(iconOf(app))));
    const tag = needTag(app) || (app.status === "draft" ? el("span", { class: "tag ghost" }, t("tag.draft")) : null);
    if (tag) media.append(el("div", { class: "badges top" }, tag));
    const card = el("a", { class: "app-card", href: `#/app/${app.id}` },
      media,
      el("h3", {}, app.name),
      el("p", {}, app.summary || tagline(app)),
      el("span", { class: "btn" }, t("apps.try")));
    hoverPlay(card, media._video);
    return card;
  }

  function drawGrid() {
    const matches = (a) => {
      if (!query) return true;
      const hay = `${a.id} ${a.name} ${a.summary} ${a.availability?.modelName ?? ""} ${tagline(a)}`.toLowerCase();
      return hay.includes(query);
    };

    const groups = [];
    if (selectedCat === "all") {
      for (const c of CATEGORIES) {
        const list = c.apps.map((id) => byId.get(id)).filter((a) => a && matches(a));
        if (list.length) groups.push({ id: c.id, list });
      }
      const listed = new Set(CATEGORIES.flatMap((c) => c.apps));
      const rest = apps.filter((a) => !listed.has(a.id) && matches(a));
      if (rest.length) groups.push({ id: "more", list: rest });
    } else {
      const list = apps.filter((a) => categoryOf(a.id) === selectedCat && matches(a));
      if (list.length) groups.push({ id: selectedCat, list });
    }

    if (!groups.length) {
      body.replaceChildren(el("div", { class: "empty" }, t("apps.none", { q: searchInput.value.trim() })));
      return;
    }

    body.replaceChildren(...groups.map((g) => el("section", {},
      el("div", { class: "sec-head" },
        el("div", {},
          el("h2", { class: "display" }, t(`cat.${g.id}.t`)),
          t(`cat.${g.id}.d`) ? el("p", {}, t(`cat.${g.id}.d`)) : null),
        selectedCat === "all" ? null : el("button", {
          class: "more", type: "button",
          style: { border: 0, background: "none", cursor: "pointer" },
          onclick: () => { selectedCat = "all"; drawPills(); drawGrid(); },
        }, t("apps.seeall"))),
      el("div", { class: "app-row" }, ...g.list.map(appCard)))));
  }

  drawPills();
  drawGrid();

  const page = el("div", { class: "page" },
    el("div", { class: "apps-head" },
      el("h1", { class: "display" }, t("apps.title.a"), " ", el("em", {}, t("apps.title.b"))),
      el("p", {}, t("apps.sub")),
      el("div", { class: "apps-bar" },
        pills,
        el("div", { class: "search" }, icon("search"), searchInput))),
    body);

  return { node: page, active: "apps" };
}

export function libraryView() {
  let tab = "mine";
  let filterApp = "";
  let stopFeed = null;
  let offFlags = null;
  const host = el("div");
  const tabsEl = el("div", { class: "tabs" });
  const appSelect = el("select", {
    "aria-label": t("lib.allapps"),
    style: {
      height: "36px", padding: "0 12px", borderRadius: "10px",
      background: "var(--panel)", border: "1px solid var(--line-2)", color: "var(--ink)", font: "inherit",
    },
    onchange: () => { filterApp = appSelect.value; drawBody(); },
  }, el("option", { value: "" }, t("lib.allapps")), ...apps.map((a) => el("option", { value: a.id }, a.name)));

  function drawTabs() {
    const items = [
      ["mine", t("lib.mine")],
      ["lab", t("lib.lab")],
    ];
    if (!hosted && flags.count() > 0) items.push(["flagged", t("lib.flagged", { n: flags.count() })]);
    else if (tab === "flagged") tab = "mine";
    tabsEl.replaceChildren(...items.map(([id, label]) =>
      el("button", {
        type: "button", "aria-selected": String(tab === id),
        onclick: () => { tab = id; drawTabs(); drawBody(); },
      }, label)));
  }

  function drawBody() {
    stopFeed?.();
    stopFeed = null;
    host._ro?.disconnect();
    appSelect.hidden = tab === "flagged";

    if (tab === "mine") {
      stopFeed = feedView(host, {
        app: filterApp || null,
        empty: () => el("div", { class: "empty" }, t("lib.empty")),
      });
      return;
    }

    if (tab === "lab") {
      const items = exampleItemsList().filter((it) => !filterApp || it.app === filterApp);
      if (!items.length) {
        host.replaceChildren(el("div", { class: "empty" }, t("explore.noex")));
        return;
      }
      const cards = items.map((item) => {
        const app = byId.get(item.app);
        const media = thumb(item, { play: "visible" });
        return el("div", {
          class: "m-item", tabindex: "0", role: "button",
          onclick: () => openViewer(items, item.key),
          onkeydown: (e) => { if (e.key === "Enter") openViewer(items, item.key); },
        },
        media,
        flagButton(flags.key(item.app), { mini: true }),
        el("div", { class: "cap" },
          el("span", {}, app?.name ?? item.app),
          el("span", { class: "tag dark" }, item.type)));
      });
      masonry(host, cards, { min: 250, gap: 12 });
      return;
    }

    const keys = flags.keys();
    if (!keys.length) {
      host.replaceChildren(el("div", { class: "empty" }, t("lib.noflag")));
      return;
    }
    host.replaceChildren(el("div", { class: "vtable", style: { marginTop: "14px" } }, ...keys.map((key) => {
      const [appId, inputId, val] = key.split("/");
      const app = byId.get(appId);
      return el("div", { class: "vrow", style: { gridTemplateColumns: "1fr auto" } },
        el("a", { href: `#/app/${appId}`, class: "nm" },
          el("b", {}, app?.name ?? appId),
          el("small", {}, inputId ? `${inputId}: ${val}` : t("view.example"))),
        flagButton(key));
    })));
  }

  offFlags = flags.on(() => {
    drawTabs();
    if (tab === "flagged") drawBody();
  });
  drawTabs();
  drawBody();

  const page = el("div", { class: "page" },
    el("div", { class: "sec-head", style: { marginTop: "8px" } },
      el("div", {},
        el("h1", { class: "display", style: { margin: 0, fontSize: "clamp(28px, 3.6vw, 44px)" } }, t("lib.title")),
        el("p", {}, t("lib.sub")))),
    el("div", { style: { display: "flex", gap: "10px", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", marginBottom: "16px" } },
      tabsEl, appSelect),
    host);

  return {
    node: page,
    active: "library",
    dispose: () => { stopFeed?.(); offFlags?.(); host._ro?.disconnect(); },
  };
}
