// Full-screen lightbox viewer for history results and lab examples.
import { el, icon, fmtSeconds, toast } from "./util.js";
import { t, ago } from "./i18n.js";
import { byId, promptInput } from "./catalog.js";
import { fullMedia, thumb, downloadName } from "./media.js";
import { feed, hooks, deleteButton } from "./feed.js";
import { flagButton } from "./flags.js";

function formatVal(input, v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (Array.isArray(v)) {
    const labels = v.map((x) => input?.options?.find((o) => String(o.value) === String(x))?.label ?? String(x));
    return labels.join(", ");
  }
  if (input?.options?.length) {
    const hit = input.options.find((o) => o.value === v || String(o.value) === String(v));
    if (hit) return hit.label;
  }
  return String(v);
}

export function openViewer(items, key) {
  const list = Array.isArray(items) && items.length ? items : [];
  if (!list.length) return () => {};
  let idx = Math.max(0, list.findIndex((it) => it.key === key || it.id === key));
  let outIdx = 0;

  const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true" });
  const close = () => {
    modal.remove();
    document.removeEventListener("keydown", onKey, true);
    document.body.style.overflow = "";
  };
  const step = (delta) => {
    if (list.length < 2) return;
    idx = (idx + delta + list.length) % list.length;
    outIdx = 0;
    draw();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  };

  function draw() {
    const item = list[idx];
    if (!item) return close();
    const app = byId.get(item.app);
    const outs = item.outputs?.length ? item.outputs : [{ type: item.type, url: item.full, poster: item.poster }];
    const activeOut = outs[outIdx] || outs[0];
    const media = fullMedia(activeOut.type || item.type, activeOut.url || item.full, { poster: activeOut.poster || item.poster, autoplay: true });

    const stage = el("div", {
      class: "stage",
      onclick: (e) => { if (e.target === stage) close(); },
    },
    media,
    el("button", { class: "round close", type: "button", title: t("act.close"), "aria-label": t("act.close"), onclick: close }, icon("x")),
    list.length > 1 ? el("button", { class: "round navb prev", type: "button", title: t("act.prev"), "aria-label": t("act.prev"), onclick: () => step(-1) }, icon("chevL")) : null,
    list.length > 1 ? el("button", { class: "round navb next", type: "button", title: t("act.next"), "aria-label": t("act.next"), onclick: () => step(1) }, icon("chevR")) : null);

    // Header row
    const appThumb = app?.example ? thumb({ kind: "example", type: app.example.type, card: app.example.poster || app.example.card, full: app.example.full }, { play: "none" })
      : el("div", { class: "media" }, icon(item.type === "video" ? "video" : item.type === "audio" ? "audio" : "image"));
    const subBits = [];
    if (item.kind === "example") subBits.push(t("view.example"));
    else if (item.created) subBits.push(ago(item.created));
    if (item.gpu) subBits.push(item.gpu.split(",")[0]);

    const appRow = el("a", { class: "approw", href: `#/app/${item.app}`, onclick: close },
      appThumb,
      el("div", {}, el("b", {}, app?.name ?? item.app), el("small", {}, subBits.join(" · "))));

    // Stats chips
    const stats = [];
    if (item.seconds) stats.push(t("view.gpu", { s: fmtSeconds(item.seconds) }));
    if (item.total && item.total !== item.seconds) stats.push(t("view.total", { s: fmtSeconds(item.total) }));
    if (item.seed !== null && item.seed !== undefined && item.seed !== -1) stats.push(t("view.seed", { n: item.seed }));
    if (item.peak) stats.push(t("view.peak", { gb: Number(item.peak).toFixed(1) }));
    const statline = stats.length ? el("div", { class: "statline" }, ...stats.map((s) => el("span", {}, s))) : null;

    // Multi-output switcher
    const outTabs = outs.length > 1 ? el("div", { class: "tabs" }, ...outs.map((o, i) =>
      el("button", { type: "button", "aria-selected": String(i === outIdx), onclick: () => { outIdx = i; draw(); } }, `#${i + 1}`))) : null;

    // Prompt
    const pIn = app ? promptInput(app) : null;
    const promptText = pIn ? String(item.values?.[pIn.id] ?? "").trim() : "";
    const promptBox = promptText ? el("div", { style: { display: "grid", gap: "6px" } },
      el("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
        el("small", { class: "dim" }, pIn?.label || t("view.prompt")),
        el("button", { class: "btn small ghost", type: "button", onclick: () => {
          navigator.clipboard?.writeText(promptText).then(() => toast(t("toast.copied"))).catch(() => {});
        } }, icon("copy"), t("act.copy"))),
      el("div", { class: "prompt" }, promptText)) : null;

    // Action buttons
    const currentItem = { ...item, type: activeOut.type || item.type, full: activeOut.url || item.full };
    const acts = el("div", { class: "acts" },
      app ? el("button", { class: "btn lime", type: "button", onclick: () => { close(); hooks.recreate?.(item); } }, icon("redo"), t("act.recreate")) : null,
      el("a", { class: "btn ghost", href: currentItem.full, download: downloadName(currentItem, currentItem.full) }, icon("download"), t("act.download")),
      el("button", { class: "btn ghost", type: "button", onclick: () => { close(); hooks.compare?.(currentItem); } }, icon("compare"), t("act.compare")),
      currentItem.type !== "audio" && hooks.useIn ? el("button", { class: "btn ghost", type: "button", onclick: (ev) => {
        hooks.useIn(ev.currentTarget, currentItem, () => close());
      } }, icon("send"), t("act.usein")) : null,
      item.kind === "example" ? flagButton(item.app) : null,
      item.kind === "history" ? deleteButton(async () => {
        await feed.remove(item.id);
        list.splice(idx, 1);
        if (!list.length) close();
        else { idx = Math.min(idx, list.length - 1); draw(); }
      }, "btn ghost danger", true) : null);

    // Input thumbnails
    const inputsBlock = item.inputs?.length ? el("div", { style: { display: "grid", gap: "8px" } },
      el("small", { class: "dim" }, t("view.inputs")),
      el("div", { class: "ins-row" }, ...item.inputs.map((inp) => {
        const mediaNode = inp.thumb
          ? el("div", { class: "media" }, el("img", { src: inp.thumb, alt: inp.label }))
          : inp.type === "video" && inp.file
            ? el("div", { class: "media" }, el("video", { src: `${inp.file}#t=0.1`, muted: true, preload: "metadata" }))
            : el("div", { class: "media audio wave" }, icon(inp.type === "audio" ? "audio" : "image"));
        return el("figure", {}, mediaNode, el("figcaption", { title: inp.label }, inp.label));
      }))) : null;

    // Settings dl
    const settingRows = [];
    for (const [k, v] of Object.entries(item.values || {})) {
      if (pIn && k === pIn.id) continue;
      const inputDef = app?.inputs?.find((i) => i.id === k);
      const formatted = formatVal(inputDef, v);
      if (formatted === null) continue;
      settingRows.push([inputDef?.label || k, formatted]);
    }
    if (item.preset) {
      const pLabel = app?.presets?.find((p) => p.id === item.preset)?.label || item.preset;
      settingRows.unshift([t("ws.preset"), pLabel]);
    }
    const settingsBlock = settingRows.length ? el("div", { style: { display: "grid", gap: "8px" } },
      el("small", { class: "dim" }, t("view.settings")),
      el("dl", { class: "vals" }, ...settingRows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]))) : null;

    const aside = el("aside", {}, appRow, statline, outTabs, promptBox, acts, inputsBlock, settingsBlock);
    modal.replaceChildren(stage, aside);
  }

  draw();
  document.body.append(modal);
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey, true);
  return close;
}
