// Top-level pages: Explore (#/), Apps (#/apps), Library (#/library), and VRAM map (#/vram).
import { el, icon, masonry, fmtSeconds } from "./util.js";
import { t } from "./i18n.js";
import { apps, byId, CATEGORIES, HERO, START_HERE, hosted, studioOf, tagline, fitOf } from "./catalog.js";
import { exampleItem, thumb, hoverPlay, optionTile } from "./media.js";
import { feedView, hooks } from "./feed.js";
import { flags, flagButton } from "./flags.js";
import { needTag } from "./models.js";

function exampleCard(app, allItems) {
  const item = exampleItem(app);
  if (!item) return null;
  const media = thumb(item, { play: "hover" });
  const open = () => hooks.open?.(allItems, item.key);
  const card = el("div", {
    class: "m-item",
    tabindex: "0",
    role: "button",
    "aria-label": app.name,
    onclick: open,
    onkeydown: (e) => { if (e.key === "Enter") open(); },
  },
  media,
  flagButton(app.id, { mini: true }),
  el("div", { class: "cap" },
    el("span", {}, app.name),
    el("span", { class: "tag dark" }, app.section)));
  hoverPlay(card, media._video);
  return card;
}

export function exploreView() {
  const cleanups = [];
  const page = el("div", { class: "page" });

  // Hero carousel
  const heroApps = HERO.map((id) => byId.get(id)).filter((a) => a?.example?.full);
  if (heroApps.length) {
    const row = el("div", { class: "hero-row" }, ...heroApps.map((app) => {
      const item = exampleItem(app);
      const media = thumb(item, { play: "hover" });
      const card = el("a", { class: "hero-card", href: `#/app/${app.id}` },
        media,
        el("div", { class: "txt" },
          el("span", { class: "tag" }, app.name),
          el("h3", { class: "display" }, tagline(app)),
          app.summary ? el("p", {}, app.summary) : null));
      hoverPlay(card, media._video);
      return card;
    }));
    const scrollBy = (dir) => row.scrollBy({ left: dir * Math.max(320, row.clientWidth * 0.7), behavior: "smooth" });
    const prev = el("button", { class: "hero-nav prev", type: "button", "aria-label": t("act.prev"), onclick: () => scrollBy(-1) }, icon("chevL"));
    const next = el("button", { class: "hero-nav next", type: "button", "aria-label": t("act.next"), onclick: () => scrollBy(1) }, icon("chevR"));
    page.append(el("div", { class: "hero-wrap" }, row, prev, next));
  }

  // Hosted demo "Start here" row
  if (hosted) {
    const startApps = START_HERE.map((id) => byId.get(id)).filter((a) => a?.example?.full);
    if (startApps.length) {
      page.append(
        el("div", { class: "sec-head" }, el("div", {}, el("h2", { class: "display" }, t("start.title")), el("p", {}, t("start.sub")))),
        el("div", { class: "start5" }, ...startApps.map((app) => {
          const item = exampleItem(app);
          const media = thumb(item, { play: "hover" });
          const card = el("button", {
            class: "start-card",
            type: "button",
            onclick: () => hooks.recreate?.(item),
          },
          media,
          el("span", { class: "nm" }, app.name),
          el("span", { class: "dim" }, item.seconds ? t("start.secs", { s: Math.round(item.seconds), gpu: (item.gpu || "GPU").split(",")[0] }) : tagline(app)));
          hoverPlay(card, media._video);
          return card;
        })),
      );
    }
  }

  // Promo + 6 studio tiles
  const imageCount = apps.filter((a) => a.section === "image" && studioOf(a) !== "video").length;
  const videoCount = apps.filter((a) => studioOf(a) === "video").length;
  const audioCount = apps.filter((a) => a.section === "audio").length;
  const tiles = [
    ["image", "#/image", "image", imageCount],
    ["video", "#/video", "video", videoCount],
    ["audio", "#/audio", "audio", audioCount],
    ["apps", "#/apps", "layers", apps.length],
    ["library", "#/library", "film", null],
    ["vram", "#/vram", "chip", null],
  ];
  page.append(el("section", { class: "promo" },
    el("div", { class: "promo-lead" },
      el("div", { style: { display: "grid", gap: "14px" } },
        el("h2", { class: "display" }, t("explore.lead.a"), " ", el("em", {}, t("explore.lead.b"))),
        el("p", {}, t("explore.lead.text"))),
      el("div", { class: "row" },
        el("a", { class: "btn lime", href: "#/image" }, icon("spark"), t("explore.start")),
        el("a", { class: "btn ghost", href: "#/apps" }, t("explore.browse")))),
    el("div", { class: "tiles6" }, ...tiles.map(([key, href, ic, n]) =>
      el("a", { class: "tile6", href },
        el("span", { class: "ic" }, icon(ic)),
        el("div", { class: "t" }, t(`tile.${key}.t`), n ? el("span", { class: "tag ghost" }, t("explore.apps", { n })) : null),
        el("p", {}, t(`tile.${key}.d`)))))));

  // Gallery showcase rows (apps with per-option lab examples: AI Influencer, Effects, Morph, Mixed Media)
  const galleryOrder = ["ai-influencer", "effects", "morph", "mixed-media"];
  const galleryApps = galleryOrder.map((id) => byId.get(id)).filter(Boolean);
  for (const app of galleryApps) {
    const input = app.inputs.find((i) => i.type === "select" && i.gallery);
    const shots = input && app.example?.options?.[input.id];
    if (!input || !shots) continue;
    const opts = (input.options || []).filter((o) => shots[String(o.value)]);
    if (!opts.length) continue;
    page.append(
      el("div", { class: "sec-head" },
        el("div", {}, el("h2", { class: "display" }, app.name), el("p", {}, t("explore.gallery.sub"))),
        el("a", { class: "pill-link", href: `#/app/${app.id}` }, t("apps.try"), icon("chevR"))),
      el("div", { class: "fx-wall" }, ...opts.slice(0, 12).map((opt) =>
        optionTile(opt, shots[String(opt.value)], {
          play: "hover",
          flagKey: flags.key(app.id, input.id, String(opt.value)),
          onPick: () => { location.hash = `#/app/${app.id}?${encodeURIComponent(input.id)}=${encodeURIComponent(String(opt.value))}`; },
        }))));
  }

  // Made with Freefield (masonry of all lab examples)
  const withExamples = apps.filter((a) => a.example?.full);
  const allItems = withExamples.map(exampleItem).filter(Boolean);
  page.append(el("div", { class: "sec-head" },
    el("div", {}, el("h2", { class: "display" }, t("explore.made")), el("p", {}, t("explore.made.sub"))),
    el("a", { class: "more", href: "#/apps" }, t("explore.seeall"), icon("chevR"))));

  if (allItems.length) {
    const grid = el("div", {});
    page.append(grid);
    const nodes = withExamples.map((a) => exampleCard(a, allItems)).filter(Boolean);
    cleanups.push(masonry(grid, nodes, { min: 240, gap: 12 }));
  } else {
    page.append(el("div", { class: "empty" }, t("explore.noex")));
  }

  // How it works
  page.append(
    el("div", { class: "sec-head" }, el("h2", { class: "display" }, t("explore.how"))),
    el("div", { class: "how" },
      ...[1, 2, 3].map((n) => el("div", {},
        el("div", { class: "n" }, `0${n}`),
        el("h3", {}, t(`how.${n}.t`)),
        el("p", {}, t(`how.${n}.d`))))));

  return { node: page, dispose: () => cleanups.forEach((fn) => fn?.()), active: "explore" };
}

export function appsView() {
  let activeCat = "all";
  let query = "";

  const page = el("div", { class: "page" });
  const searchInput = el("input", { type: "search", placeholder: t("apps.search"), "aria-label": t("apps.search") });
  const pills = el("div", { class: "pills" });
  const body = el("div", {});

  const cats = [{ id: "all" }, ...CATEGORIES];
  const listedIds = new Set(CATEGORIES.flatMap((c) => c.apps));
  const extraApps = apps.filter((a) => !listedIds.has(a.id));
  if (extraApps.length) cats.push({ id: "more", apps: extraApps.map((a) => a.id) });

  function appCard(app) {
    const item = exampleItem(app);
    const media = item ? thumb(item, { play: "hover" }) : el("div", { class: "media" }, el("span", { class: "placeholder" }, icon(app.section === "video" ? "video" : app.section === "audio" ? "audio" : "image")));
    const badges = [];
    if (app.status === "draft") badges.push(el("span", { class: "tag dark" }, t("tag.draft")));
    const need = needTag(app);
    if (need) badges.push(need);
    if (badges.length) media.append(el("div", { class: "badges top" }, ...badges));
    const card = el("a", { class: "app-card", href: `#/app/${app.id}` },
      media,
      el("h3", {}, app.name),
      el("p", {}, tagline(app)),
      el("span", { class: "btn" }, t("apps.try")));
    hoverPlay(card, media._video);
    return card;
  }

  function drawPills() {
    pills.replaceChildren(...cats.map((c) => el("button", {
      type: "button",
      "aria-pressed": String(activeCat === c.id),
      onclick: () => { activeCat = c.id; drawPills(); drawBody(); },
    }, c.id === "all" ? t("apps.all") : t(`cat.${c.id}.t`))));
  }

  function drawBody() {
    const q = query.trim().toLowerCase();
    const matches = (a) => !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
      || (a.summary || "").toLowerCase().includes(q) || tagline(a).toLowerCase().includes(q)
      || (a.higgsfield_feature || "").toLowerCase().includes(q);

    if (q) {
      const hits = apps.filter(matches);
      if (!hits.length) {
        body.replaceChildren(el("div", { class: "empty" }, t("apps.none", { q: query.trim() })));
        return;
      }
      body.replaceChildren(el("div", { class: "app-row", style: { marginTop: "20px" } }, ...hits.map(appCard)));
      return;
    }

    const sections = [];
    for (const c of cats) {
      if (c.id === "all") continue;
      if (activeCat !== "all" && activeCat !== c.id) continue;
      const groupApps = (c.apps || []).map((id) => byId.get(id)).filter(Boolean);
      if (!groupApps.length) continue;
      sections.push(
        el("div", { class: "sec-head" },
          el("div", {}, el("h2", { class: "display" }, t(`cat.${c.id}.t`)), t(`cat.${c.id}.d`) ? el("p", {}, t(`cat.${c.id}.d`)) : null),
          activeCat === "all" ? el("button", {
            class: "more",
            type: "button",
            style: { border: 0, background: "none", cursor: "pointer" },
            onclick: () => { activeCat = c.id; drawPills(); drawBody(); window.scrollTo(0, 0); },
          }, t("apps.seeall"), icon("chevR")) : null),
        el("div", { class: "app-row" }, ...groupApps.map(appCard)));
    }
    body.replaceChildren(...sections);
  }

  searchInput.addEventListener("input", () => { query = searchInput.value; drawBody(); });
  drawPills();
  drawBody();

  page.append(
    el("div", { class: "apps-head" },
      el("h1", { class: "display" }, t("apps.title.a"), " ", el("em", {}, t("apps.title.b"))),
      el("p", {}, t("apps.sub")),
      el("div", { class: "apps-bar" },
        pills,
        el("label", { class: "search" }, icon("search"), searchInput))),
    body);

  return { node: page, active: "apps" };
}

export function libraryView() {
  let tab = "mine";
  let labFilter = "all";
  let disposeInner = null;

  const page = el("div", { class: "page" });
  const tabsBar = el("div", { class: "tabs" });
  const content = el("div", { style: { marginTop: "20px" } });

  function drawTabs() {
    tabsBar.replaceChildren(
      ...[["mine", t("lib.mine")], ["lab", t("lib.lab")]].map(([id, label]) =>
        el("button", { type: "button", "aria-selected": String(tab === id), onclick: () => { tab = id; drawTabs(); drawContent(); } }, label)));
  }

  function drawContent() {
    disposeInner?.();
    disposeInner = null;
    if (tab === "mine") {
      const host = el("div", {});
      content.replaceChildren(host);
      disposeInner = feedView(host, {
        empty: () => el("div", { class: "empty" }, t("lib.empty")),
      });
      return;
    }

    const wrap = el("div", { style: { display: "grid", gap: "14px" } });
    const bar = el("div", { class: "pills" });
    const grid = el("div", {});
    let disposeGrid = null;

    const renderLab = () => {
      disposeGrid?.();
      const flagCount = flags.count();
      bar.replaceChildren(
        el("button", { type: "button", "aria-pressed": String(labFilter === "all"), onclick: () => { labFilter = "all"; renderLab(); } }, t("lib.allex")),
        !hosted ? el("button", { type: "button", "aria-pressed": String(labFilter === "flagged"), onclick: () => { labFilter = "flagged"; renderLab(); } }, t("lib.flagged", { n: flagCount })) : null,
      );
      const listApps = apps.filter((a) => a.example?.full && (labFilter === "all" || flags.is(a.id)));
      const allItems = listApps.map(exampleItem).filter(Boolean);
      if (!allItems.length) {
        grid.replaceChildren(el("div", { class: "empty" }, labFilter === "flagged" ? t("lib.noflag") : t("explore.noex")));
        return;
      }
      const nodes = listApps.map((a) => exampleCard(a, allItems)).filter(Boolean);
      disposeGrid = masonry(grid, nodes, { min: 240, gap: 12 });
    };

    const offFlags = flags.on(renderLab);
    renderLab();
    wrap.append(bar, grid);
    content.replaceChildren(wrap);
    disposeInner = () => { offFlags(); disposeGrid?.(); };
  }

  drawTabs();
  drawContent();
  page.append(
    el("div", { class: "apps-head" },
      el("h1", { class: "display" }, t("lib.title")),
      el("p", {}, t("lib.sub")),
      tabsBar),
    content);

  return { node: page, dispose: () => disposeInner?.(), active: "library" };
}

export function vramView(gpuData) {
  const page = el("div", { class: "page" });
  const rows = apps.filter((a) => a.vram).sort((a, b) => (a.vram.largest_phase_gb ?? 0) - (b.vram.largest_phase_gb ?? 0));
  const maxGb = Math.max(48, ...rows.map((a) => Math.max(a.vram.whole_gb || 0, a.vram.measured_gb || 0)));
  const pct = (gb) => `${Math.min(100, (gb / maxGb) * 100)}%`;

  const liveLine = gpuData?.device?.vram_total_gb
    ? el("div", { class: "statline" }, el("span", {},
      t("vram.live", { name: gpuData.device.name || "GPU", used: gpuData.device.vram_used_gb, total: gpuData.device.vram_total_gb })))
    : null;

  const legend = el("div", { class: "legend", style: { marginTop: "20px", marginBottom: "14px" } },
    el("span", {}, el("i", { style: { background: "rgba(255,255,255,.18)" } }), t("vram.whole")),
    el("span", {}, el("i", { style: { background: "var(--accent)" } }), t("vram.phase")),
    el("span", {}, el("i", { style: { background: "var(--pink)", width: "4px" } }), t("vram.measured")));

  const ticks = [0, 12, 24, 48, 80].filter((x) => x <= maxGb);
  const scale = el("div", { class: "vscale" }, ...ticks.map((gb) =>
    el("span", { style: { left: pct(gb) } }, `${gb} ${t("unit.gb")}`)));

  const table = el("div", { class: "vtable" }, ...rows.map((app) => {
    const v = app.vram;
    const fit = fitOf(app);
    return el("a", { class: "vrow", href: `#/app/${app.id}` },
      el("div", { class: "nm" }, el("b", {}, app.name), el("small", {}, `${app.pack} · ${v.largest_phase_gb} / ${v.whole_gb} ${t("unit.gb")}`)),
      el("div", {},
        el("div", { class: "vbar", title: `${v.largest_phase_gb} GB phase · ${v.whole_gb} GB whole${v.measured_gb ? ` · ${v.measured_gb} GB peak` : ""}` },
          el("i", { class: "whole", style: { width: pct(v.whole_gb || 0) } }),
          el("i", { style: { width: pct(v.largest_phase_gb || 0) } }),
          v.measured_gb ? el("b", { style: { left: pct(v.measured_gb) } }) : null,
          el("u", { style: { left: pct(24) } }))),
      el("div", { style: { textAlign: "right" } },
        fit ? el("span", { class: `fit ${fit[1]}` }, t(fit[0])) : null));
  }));

  page.append(
    el("div", { class: "apps-head" },
      el("h1", { class: "display" }, t("vram.title")),
      el("p", {}, t("vram.sub")),
      liveLine),
    legend,
    el("div", { class: "vrow", style: { background: "transparent", border: 0, cursor: "default", padding: "0 12px" } }, el("div"), scale, el("div")),
    table);

  return { node: page, active: "vram" };
}
