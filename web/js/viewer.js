// Fullscreen lightbox modal for inspecting results and lab examples.
import { el, icon, fmtSeconds, toast } from "./util.js";
import { t, ago } from "./i18n.js";
import { byId, promptInput } from "./catalog.js";
import { fullMedia, thumb, exampleItem, downloadName } from "./media.js";
import { feed, hooks, deleteButton } from "./feed.js";
import { flagButton, flags } from "./flags.js";

export function openViewer(items, key) {
  if (!items?.length) return () => {};
  let list = [...items];
  let idx = Math.max(0, list.findIndex((it) => it.key === key));

  const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true" });
  const stage = el("div", { class: "stage" });
  const aside = el("aside");
  modal.append(stage, aside);

  const close = () => {
    modal.remove();
    document.removeEventListener("keydown", onKey, true);
    document.body.style.overflow = "";
  };
  const step = (delta) => {
    if (list.length <= 1) return;
    idx = (idx + delta + list.length) % list.length;
    draw();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  };

  function draw() {
    const item = list[idx];
    if (!item) { close(); return; }
    const app = byId.get(item.app);
    const exThumb = app ? exampleItem(app) : null;
    const pInput = app ? promptInput(app) : null;
    const promptVal = pInput ? String(item.values?.[pInput.id] ?? "").trim() : "";

    const stageKids = [
      fullMedia(item.type, item.full, { poster: item.poster, autoplay: true }),
      el("button", { class: "round close", type: "button", title: t("act.close"), "aria-label": t("act.close"), onclick: close }, icon("x")),
    ];
    if (list.length > 1) {
      stageKids.push(
        el("button", { class: "round navb prev", type: "button", title: t("act.prev"), "aria-label": t("act.prev"), onclick: () => step(-1) }, icon("left")),
        el("button", { class: "round navb next", type: "button", title: t("act.next"), "aria-label": t("act.next"), onclick: () => step(1) }, icon("right")),
      );
    }
    stage.replaceChildren(...stageKids);

    const stats = [];
    if (item.seconds) stats.push(el("span", {}, t("view.gpu", { s: fmtSeconds(item.seconds) })));
    if (item.total && item.total !== item.seconds) stats.push(el("span", {}, t("view.total", { s: fmtSeconds(item.total) })));
    if (item.seed !== null && item.seed !== undefined) stats.push(el("span", {}, t("view.seed", { n: item.seed })));
    if (item.peak) stats.push(el("span", {}, t("view.peak", { gb: item.peak })));

    const acts = [
      app ? el("button", {
        class: "btn lime", type: "button",
        onclick: () => { close(); hooks.recreate?.(item); },
      }, icon("redo"), t("act.recreate")) : null,
      el("a", {
        class: "btn", href: item.full, download: downloadName(item, item.full),
      }, icon("download"), t("act.download")),
      el("button", {
        class: "btn", type: "button",
        onclick: () => { close(); hooks.compare?.(item); },
      }, icon("compare"), t("act.compare")),
      item.type !== "audio" && hooks.useIn ? el("button", {
        class: "btn", type: "button",
        onclick: (e) => hooks.useIn(e.currentTarget, item, close),
      }, icon("send"), t("act.usein")) : null,
      item.kind === "history" ? deleteButton(async () => {
        await feed.remove(item.id);
        list = list.filter((x) => x.key !== item.key);
        if (!list.length) close();
        else { idx = Math.min(idx, list.length - 1); draw(); }
      }, "btn ghost danger", true) : null,
      item.kind === "example" ? flagButton(flags.key(item.app)) : null,
    ].filter(Boolean);

    const settingsEntries = Object.entries(item.values || {})
      .filter(([k, v]) => (!pInput || k !== pInput.id) && v !== "" && v !== null && v !== undefined);

    const asideKids = [
      el("a", {
        class: "approw", href: `#/app/${item.app}`,
        onclick: () => close(),
      },
      exThumb ? thumb(exThumb, { play: "none" }) : el("div", { class: "media", style: { display: "grid", placeItems: "center" } }, icon("spark")),
      el("div", {},
        el("b", {}, app?.name ?? item.app),
        el("small", {}, item.kind === "example" ? t("view.example") : ago(item.created)))),
    ];

    if (promptVal) {
      asideKids.push(
        el("div", { style: { display: "grid", gap: "8px" } },
          el("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
            el("small", { class: "dim" }, t("view.prompt")),
            el("button", {
              class: "btn small ghost", type: "button",
              onclick: async () => {
                try { await navigator.clipboard.writeText(promptVal); toast(t("toast.copied")); }
                catch { toast(t("toast.copied")); }
              },
            }, icon("copy"), t("act.copy"))),
          el("div", { class: "prompt" }, promptVal)),
      );
    }

    if (stats.length) asideKids.push(el("div", { class: "statline" }, ...stats));
    asideKids.push(el("div", { class: "acts" }, ...acts));

    if (item.inputs?.length) {
      asideKids.push(
        el("div", { style: { display: "grid", gap: "8px" } },
          el("small", { class: "dim" }, t("view.inputs")),
          el("div", { class: "ins-row" }, ...item.inputs.map((inp) => {
            const mediaNode = inp.play
              ? el("div", { class: "media" }, el("video", { src: `${inp.play}#t=0.1`, muted: true, preload: "metadata" }))
              : inp.thumb || inp.file
                ? el("div", { class: "media" }, el("img", { src: inp.thumb || inp.file, alt: inp.label || inp.id }))
                : el("div", { class: "media", style: { display: "grid", placeItems: "center" } }, icon("image"));
            return el("figure", {}, mediaNode, el("figcaption", { title: inp.label || inp.id }, inp.label || inp.id));
          }))),
      );
    }

    if (settingsEntries.length) {
      const labelMap = Object.fromEntries((app?.inputs || []).map((i) => [i.id, i.label]));
      asideKids.push(
        el("div", { style: { display: "grid", gap: "8px" } },
          el("small", { class: "dim" }, t("view.settings")),
          el("dl", { class: "vals" }, ...settingsEntries.flatMap(([k, v]) => [
            el("dt", {}, labelMap[k] || k),
            el("dd", {}, Array.isArray(v) ? v.join(", ") : String(v)),
          ]))),
      );
    }

    aside.replaceChildren(...asideKids);
  }

  draw();
  document.body.append(modal);
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey, true);
  return close;
}
