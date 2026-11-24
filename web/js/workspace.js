// App workspace (#/app/<id>): builds each app's form from app.json (floating composer or sidebar),
// shows its History feed, Library lab example, and How it works tab, and handles Recreate / Use in...
import { el, icon, logoMark, popover, closePopover, toast, fmtShort, fmtSeconds, clamp, isMedia, masonry, store, extOf } from "./util.js";
import { t } from "./i18n.js";
import { apps, byId, VIDEO_TABS, videoTabOf, layoutOf, familyOf, rememberApp, tagline, iconOf, promptInput, estimate, fitOf } from "./catalog.js";
import { exampleItem, thumb, fullMedia, hoverPlay, optionTile, downloadName } from "./media.js";
import { feed, feedView, hooks } from "./feed.js";
import { openPainter, maskPreview } from "./paint.js";
import { flagButton, flags } from "./flags.js";
import { needNode } from "./models.js";

// Pending state stashed by recreate() or useIn() when navigating across apps
let pendingLoad = null;
let activeController = null;

async function urlToFile(url, fallbackName = "input.bin") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  const blob = await res.blob();
  const ext = extOf(url);
  const name = fallbackName.includes(".") ? fallbackName : `${fallbackName}${ext ? `.${ext}` : ""}`;
  return new File([blob], name, { type: blob.type || undefined });
}

export function recreate(item, { run = false } = {}) {
  const app = byId.get(item.app);
  if (!app) return;
  const payload = { appId: app.id, values: { ...(item.values || {}) }, preset: item.preset || null, files: (item.inputs || []).filter((i) => i.file), run };
  if (activeController && activeController.app.id === app.id) {
    activeController.load(payload);
  } else {
    pendingLoad = payload;
    location.hash = `#/app/${app.id}`;
  }
}

export function useIn(anchor, item, done) {
  const targets = apps.filter((a) => a.inputs.some((i) => i.type === item.type && !i.paint));
  if (!targets.length) return;
  const preferred = targets.filter((a) => a.id !== item.app).slice(0, 10);
  const rest = targets.filter((a) => a.id !== item.app).slice(10);

  const sendTo = (target) => {
    closePopover();
    const inp = target.inputs.find((i) => i.type === item.type && !i.paint);
    if (!inp) return;
    const payload = { appId: target.id, values: {}, files: [{ id: inp.id, file: item.full, name: downloadName(item, item.full) }], run: false };
    done?.();
    if (activeController && activeController.app.id === target.id) {
      activeController.load(payload);
    } else {
      pendingLoad = payload;
      location.hash = `#/app/${target.id}`;
    }
    toast(t("toast.sent", { app: target.name }));
  };

  const rowFor = (a) => {
    const ex = a.example;
    const th = ex?.poster || (ex && ex.type !== "video" ? ex.card : null);
    return el("button", { class: "opt", type: "button", onclick: () => sendTo(a) },
      el("span", { class: "thumb" }, th ? el("img", { src: th, alt: "" }) : icon(iconOf(a))),
      el("span", { class: "two" }, el("b", {}, a.name), el("small", {}, tagline(a))));
  };

  const box = el("div", { class: "usein" },
    el("h4", {}, t("act.usein")),
    ...preferred.map(rowFor),
    rest.length ? el("details", {}, el("summary", {}, t("usein.more", { n: rest.length })), ...rest.map(rowFor)) : null);
  popover(anchor, box, { align: "end", width: 320 });
}

function isAdvanced(input) {
  return ["seed", "steps", "cfg", "guidance", "negative", "negative_prompt", "denoise", "shift"].includes(input.id)
    || input.type === "seed";
}

function acceptOf(type) {
  return type === "video" ? "video/*" : type === "audio" ? "audio/*" : "image/*";
}

function defaultState(app) {
  const values = {};
  for (const inp of app.inputs) {
    if (isMedia(inp.type)) continue;
    if (inp.multiple) values[inp.id] = Array.isArray(inp.default) ? [...inp.default] : [];
    else if (inp.default !== undefined) values[inp.id] = inp.default;
    else if (inp.type === "toggle") values[inp.id] = false;
    else if (inp.type === "seed") values[inp.id] = -1;
    else if (inp.type === "select" && inp.options?.length) values[inp.id] = inp.options[0].value;
    else values[inp.id] = "";
  }
  return values;
}

function parseHashQuery() {
  const q = location.hash.split("?")[1];
  return q ? new URLSearchParams(q) : new URLSearchParams();
}

function buildHowTab(app) {
  const grid = el("div", { class: "how-grid" });

  // Pipeline card
  const cliParts = ["npm run app --", app.id];
  for (const inp of app.inputs) {
    if (isMedia(inp.type) && inp.required) cliParts.push(`--file ${inp.id}=path/to/${inp.id}.${inp.type === "video" ? "mp4" : inp.type === "audio" ? "mp3" : "jpg"}`);
    else if (inp.type === "textarea" && inp.required) cliParts.push(`--set ${inp.id}="${String(inp.default || "your prompt").slice(0, 48)}"`);
  }
  const pipeCard = el("div", { class: "card" },
    el("h3", {}, icon("layers"), t("how.pipeline")),
    el("p", {}, t("how.pipeline.d", { id: app.id })),
    el("div", { class: "statline" },
      el("span", {}, `${t("how.pack")}: ${app.pack}`),
      el("span", {}, app.status),
      app.higgsfield_feature ? el("span", {}, `${t("how.equiv")}: ${app.higgsfield_feature}`) : null),
    el("div", { style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
      el("a", { class: "btn small", href: `/api/apps/${app.id}/workflow`, download: `freefield-${app.id}.json` }, icon("download"), t("how.workflow")),
      el("span", { class: "dim", style: { fontSize: "12px" } }, t("how.workflow.d"))),
    el("div", { style: { display: "grid", gap: "6px" } },
      el("small", { class: "dim" }, t("how.download")),
      el("pre", { class: "code" }, `modal run infra/modal_app.py::download --pack ${app.pack}`)),
    el("div", { style: { display: "grid", gap: "6px" } },
      el("small", { class: "dim" }, t("how.cli")),
      el("pre", { class: "code" }, cliParts.join(" "))));
  grid.append(pipeCard);

  // Open-weight models card
  const totalGb = app.models.reduce((s, m) => s + (m.optional ? 0 : (Number(m.gb) || 0)), 0);
  const modelsCard = el("div", { class: "card" },
    el("h3", {}, icon("box"), t("how.models"), el("span", { class: "dim", style: { marginLeft: "auto", fontWeight: 500, fontSize: "12.5px" } }, t("how.total", { gb: totalGb.toFixed(1) }))),
    app.models.length ? el("table", { class: "models" }, el("tbody", {}, ...app.models.map((m) => {
      const sub = [m.repo, m.license, m.gated ? t("how.gated") : null, m.optional ? t("how.optional") : null].filter(Boolean).join(" · ");
      return el("tr", {},
        el("td", {}, el("div", { style: { fontWeight: 600 } }, m.name), el("small", { class: "dim" }, sub)),
        el("td", { class: "r" }, `${m.gb} ${t("unit.gb")}`));
    }))) : el("p", {}, t("fit.none")));
  grid.append(modelsCard);

  // VRAM card
  if (app.vram) {
    const v = app.vram;
    const fit = fitOf(app);
    const maxGb = Math.max(48, v.whole_gb || 0, v.measured_gb || 0);
    const pct = (g) => `${Math.min(100, ((g || 0) / maxGb) * 100)}%`;
    const row = (label, gb, cls = "") => el("div", { style: { display: "grid", gap: "6px" } },
      el("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "12.5px" } },
        el("span", { class: "dim" }, label), el("b", {}, `${Number(gb).toFixed(2)} ${t("unit.gb")}`)),
      el("div", { class: "vbar" }, el("i", { class: cls, style: { width: pct(gb) } }), el("u", { style: { left: pct(24) } })));
    grid.append(el("div", { class: "card" },
      el("h3", {}, icon("chip"), t("how.vram"), fit ? el("span", { class: `fit ${fit[1]}`, style: { marginLeft: "auto" } }, t(fit[0])) : null),
      row(t("how.whole"), v.whole_gb || 0, "whole"),
      row(t("how.phase"), v.largest_phase_gb || 0),
      v.measured_gb ? row(t("how.measured"), v.measured_gb) : null));
  }

  // Credits & notes
  if (app.credits?.length || app.notes) {
    grid.append(el("div", { class: "card" },
      app.credits?.length ? el("h3", {}, t("how.credits")) : null,
      ...(app.credits || []).map((c) => el("p", {}, c)),
      app.notes ? el("h3", { style: { marginTop: app.credits?.length ? "6px" : 0 } }, t("how.notes")) : null,
      app.notes ? el("p", {}, app.notes) : null));
  }

  return grid;
}

function buildLibraryTab(app, onLoadExample, onPickOption) {
  const wrap = el("div", { style: { display: "grid", gap: "20px" } });
  const item = exampleItem(app);
  if (item) {
    const stats = [];
    if (item.seconds) stats.push(t("view.gpu", { s: fmtSeconds(item.seconds) }));
    if (item.peak) stats.push(t("view.peak", { gb: Number(item.peak).toFixed(1) }));
    if (item.gpu) stats.push(item.gpu.split(",")[0]);

    const valRows = Object.entries(item.values || {}).filter(([, v]) => v !== "" && v !== null && v !== undefined).map(([k, v]) => {
      const def = app.inputs.find((i) => i.id === k);
      const label = def?.options?.find((o) => String(o.value) === String(v))?.label ?? String(v);
      return [def?.label || k, label];
    });

    wrap.append(el("div", { class: "ex-big" },
      el("div", { class: "stage" }, fullMedia(item.type, item.full, { poster: item.poster, autoplay: true })),
      el("div", { class: "side2" },
        el("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } },
          el("b", {}, t("ws.example")),
          flagButton(app.id, { mini: true })),
        stats.length ? el("div", { class: "statline" }, ...stats.map((s) => el("span", {}, s))) : null,
        item.inputs.length ? el("div", { class: "ins-row" }, ...item.inputs.map((inp) =>
          el("figure", {},
            el("div", { class: "media" }, inp.thumb ? el("img", { src: inp.thumb, alt: inp.label }) : icon(inp.type === "video" ? "video" : "image")),
            el("figcaption", {}, inp.label)))) : null,
        valRows.length ? el("dl", { class: "vals" }, ...valRows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])) : null,
        el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
          el("button", { class: "btn lime small", type: "button", onclick: onLoadExample }, icon("redo"), t("ws.useex")),
          el("button", { class: "btn ghost small", type: "button", onclick: () => hooks.compare?.(item) }, icon("compare"), t("act.compare")),
          el("a", { class: "btn ghost small", href: item.full, download: downloadName(item, item.full) }, icon("download"), t("act.download"))))));
  } else {
    wrap.append(el("div", { class: "empty" }, t("explore.noex")));
  }

  // Per-option gallery examples if present
  const galleryInputs = app.inputs.filter((i) => i.type === "select" && i.gallery && app.example?.options?.[i.id]);
  for (const inp of galleryInputs) {
    const shots = app.example.options[inp.id];
    const opts = (inp.options || []).filter((o) => shots[String(o.value)]);
    if (!opts.length) continue;
    wrap.append(
      el("h3", { class: "display", style: { margin: "8px 0 0", fontSize: "20px" } }, inp.label),
      el("div", { class: "fx-wall" }, ...opts.map((opt) =>
        optionTile(opt, shots[String(opt.value)], {
          play: "hover",
          flagKey: flags.key(app.id, inp.id, String(opt.value)),
          onPick: () => onPickOption(inp.id, opt.value),
        }))));
  }

  return wrap;
}

export function workspaceView(appId) {
  const app = byId.get(appId);
  if (!app) {
    return { node: el("div", { class: "page" }, el("div", { class: "empty" }, `Unknown app "${appId}".`)), app: null };
  }
  rememberApp(app);

  const layout = layoutOf(app);
  const values = defaultState(app);
  const files = new Map();       // input.id -> File
  const fileUrls = new Map();    // input.id -> objectURL
  let preset = null;
  let batch = 1;
  let activeTab = "history";
  let dense = Boolean(store.get("ws.dense", false));
  const cleanups = [];
  const fieldUpdaters = [];
  const missingEls = new Map();

  // Apply URL query overrides (e.g., clicking a gallery option on Explore)
  const hashQ = parseHashQuery();
  for (const inp of app.inputs) {
    if (!isMedia(inp.type) && hashQ.has(inp.id)) {
      const raw = hashQ.get(inp.id);
      if (inp.type === "select" && inp.options) {
        const hit = inp.options.find((o) => String(o.value) === raw);
        if (hit) values[inp.id] = hit.value;
      } else {
        values[inp.id] = raw;
      }
    }
  }

  const revokeUrl = (id) => {
    const u = fileUrls.get(id);
    if (u) { URL.revokeObjectURL(u); fileUrls.delete(id); }
  };
  const setFile = (id, file) => {
    revokeUrl(id);
    if (file) {
      files.set(id, file);
      fileUrls.set(id, URL.createObjectURL(file));
    } else {
      files.delete(id);
    }
    // Clear any painted mask that depends on this photo if the photo changed
    for (const inp of app.inputs) {
      if (inp.paint === id && !file) { revokeUrl(inp.id); files.delete(inp.id); }
    }
    refreshFields();
  };
  const refreshFields = () => { for (const fn of fieldUpdaters) fn(); };

  // Load example or recreate payload
  async function loadPayload(payload) {
    for (const [k, v] of Object.entries(payload.values || {})) {
      const inp = app.inputs.find((i) => i.id === k);
      if (!inp || isMedia(inp.type)) continue;
      if (inp.multiple) values[k] = Array.isArray(v) ? [...v] : (v ? [v] : []);
      else values[k] = v;
    }
    if (payload.preset !== undefined) preset = payload.preset;
    refreshFields();
    if (payload.files?.length) {
      await Promise.all(payload.files.map(async (f) => {
        const inp = app.inputs.find((i) => i.id === f.id);
        if (!inp || !isMedia(inp.type) || !f.file) return;
        try {
          const fileObj = await urlToFile(f.file, f.name || `${inp.id}.${inp.type === "video" ? "mp4" : inp.type === "audio" ? "mp3" : "jpg"}`);
          setFile(inp.id, fileObj);
        } catch { /* ignore broken example file */ }
      }));
    }
    toast(t("toast.loaded", { app: app.name }));
    if (payload.run) void submitRun();
  }

  const loadLabExample = () => {
    const ex = exampleItem(app);
    if (!ex) return;
    void loadPayload({ appId: app.id, values: ex.values, files: ex.inputs, preset: null, run: false });
  };

  // Submit run(s)
  let submitting = false;
  const noteEl = el("p", { class: layout === "composer" ? "cmp-hint" : "side-note", hidden: true });
  const setNote = (msg, err = false) => {
    noteEl.textContent = msg || "";
    noteEl.hidden = !msg;
    noteEl.className = `${layout === "composer" ? "cmp-hint" : "side-note"}${err ? " err" : ""}`;
  };

  const canRun = app.runnable && !app.needs && !app.missing_pack;
  async function submitRun() {
    if (submitting) return;
    if (!app.runnable) {
      toast(app.status === "draft" ? t("ws.draft") : t("ws.noworkflow"), { error: true });
      return;
    }
    // Validate required inputs
    for (const inp of app.inputs) {
      const target = missingEls.get(inp.id);
      if (isMedia(inp.type)) {
        if ((inp.required || inp.paint) && !files.has(inp.id)) {
          target?.classList.remove("missing");
          void target?.offsetWidth;
          target?.classList.add("missing");
          setNote(inp.paint ? t("paint.empty") : t("ws.need", { label: inp.label }), true);
          return;
        }
      } else if (inp.required) {
        const v = values[inp.id];
        if (v === undefined || v === null || String(v).trim() === "") {
          target?.classList.remove("missing");
          void target?.offsetWidth;
          target?.classList.add("missing");
          target?.focus?.();
          setNote(t("ws.needtext", { label: inp.label }), true);
          return;
        }
      }
    }
    setNote("");
    submitting = true;
    try {
      for (let i = 0; i < batch; i++) {
        const fd = new FormData();
        for (const inp of app.inputs) {
          if (isMedia(inp.type)) {
            const f = files.get(inp.id);
            if (f) fd.append(inp.id, f, f.name);
          } else {
            const v = values[inp.id];
            if (v === undefined || v === null) continue;
            if (inp.multiple) fd.append(inp.id, JSON.stringify(Array.isArray(v) ? v : []));
            else fd.append(inp.id, String(v));
          }
        }
        if (preset) fd.append("preset", preset);
        await feed.run(app.id, fd);
      }
      toast(t("toast.started", { app: app.name }));
      if (activeTab !== "history") { activeTab = "history"; drawMain(); }
    } catch (err) {
      setNote(err.message, true);
      toast(err.message, { error: true });
    } finally {
      submitting = false;
    }
  }

  // Shared UI builders
  function openSwitcher(anchor) {
    const fam = familyOf(app);
    const list = fam.length > 1 ? fam : apps.filter((a) => a.section === app.section);
    const content = el("div", {},
      el("h4", {}, app.name),
      ...list.map((a) => {
        const ex = a.example;
        const th = ex?.poster || (ex && ex.type !== "video" ? ex.card : null);
        return el("a", { class: "opt", href: `#/app/${a.id}`, "aria-selected": String(a.id === app.id), onclick: closePopover },
          el("span", { class: "thumb" }, th ? el("img", { src: th, alt: "" }) : icon(iconOf(a))),
          el("span", { class: "two" }, el("b", {}, a.name), el("small", {}, tagline(a))),
          el("span", { class: "chk" }, icon("check")));
      }));
    popover(anchor, content, { width: 320 });
  }

  function modesSwitch() {
    if (!app.modes?.length) return null;
    const siblings = app.modes.map((id) => byId.get(id)).filter(Boolean);
    if (siblings.length < 2) return null;
    return el("div", { class: "seg modes" }, ...siblings.map((sib) =>
      el("button", {
        type: "button",
        "aria-pressed": String(sib.id === app.id),
        onclick: () => { if (sib.id !== app.id) location.hash = `#/app/${sib.id}`; },
      }, icon(sib.section === "video" ? "video" : "image"), sib.mode_label || sib.name)));
  }

  function openSelectPopover(anchor, inp) {
    const opts = inp.options || [];
    if (inp.gallery) {
      const shots = app.example?.options?.[inp.id] || {};
      const grid = el("div", { class: "fx-grid" }, ...opts.map((opt) =>
        optionTile(opt, shots[String(opt.value)], {
          selected: String(values[inp.id]) === String(opt.value),
          play: "hover",
          flagKey: shots[String(opt.value)] ? flags.key(app.id, inp.id, String(opt.value)) : null,
          onPick: () => { values[inp.id] = opt.value; refreshFields(); closePopover(); },
        })));
      popover(anchor, el("div", {}, el("h4", {}, inp.label), grid), { cls: "wide", width: 580 });
      return;
    }
    if (inp.multiple) {
      const max = inp.multiple.max || 99;
      const ordered = Boolean(inp.multiple.ordered);
      const wrap = el("div", {});
      const drawList = () => {
        const cur = Array.isArray(values[inp.id]) ? values[inp.id] : [];
        const hint = max < 99 ? t(ordered ? "ws.multi.upto.ordered" : "ws.multi.upto", { n: max }) : "";
        wrap.replaceChildren(
          el("h4", {}, inp.label, hint ? el("span", { class: "n" }, hint) : null,
            cur.length ? el("button", { class: "mini-link", type: "button", onclick: () => { values[inp.id] = []; refreshFields(); drawList(); } }, t("ws.multi.clear")) : null),
          el("div", { class: "multi-list" }, ...opts.map((o) => {
            const valStr = String(o.value);
            const pos = cur.map(String).indexOf(valStr);
            const picked = pos >= 0;
            return el("button", {
              class: "opt",
              type: "button",
              "aria-pressed": String(picked),
              onclick: () => {
                const next = [...cur];
                if (picked) next.splice(pos, 1);
                else if (next.length >= max) { toast(t("ws.multi.max", { n: max }), { error: true }); return; }
                else next.push(o.value);
                values[inp.id] = next;
                refreshFields();
                drawList();
              },
            },
            el("span", {}, o.label),
            picked ? el("span", { class: "pick" }, ordered ? String(pos + 1) : icon("check")) : null);
          })));
      };
      drawList();
      popover(anchor, wrap, { width: 290 });
      return;
    }
    const box = el("div", {},
      el("h4", {}, inp.label),
      ...opts.map((o) => el("button", {
        class: "opt",
        type: "button",
        "aria-selected": String(String(values[inp.id]) === String(o.value)),
        onclick: () => { values[inp.id] = o.value; refreshFields(); closePopover(); },
      }, el("span", {}, o.label), el("span", { class: "chk" }, icon("check")))));
    popover(anchor, box, { width: 280 });
  }

  function selectLabel(inp) {
    const v = values[inp.id];
    if (inp.multiple) {
      const list = Array.isArray(v) ? v : [];
      if (!list.length) return t("ws.none");
      return list.map((x) => inp.options?.find((o) => String(o.value) === String(x))?.label ?? String(x)).join(" → ");
    }
    return inp.options?.find((o) => o.value === v || String(o.value) === String(v))?.label ?? String(v ?? t("ws.none"));
  }

  function batchCounter() {
    const minus = el("button", { type: "button", "aria-label": "-", onclick: () => { batch = clamp(batch - 1, 1, 4); update(); } }, "−");
    const plus = el("button", { type: "button", "aria-label": "+", onclick: () => { batch = clamp(batch + 1, 1, 4); update(); } }, "+");
    const label = el("span", {});
    const update = () => {
      label.replaceChildren(String(batch), el("small", {}, "/4"));
      minus.disabled = batch <= 1;
      plus.disabled = batch >= 4;
    };
    update();
    return el("div", { class: "count", title: t("ws.count") }, minus, label, plus);
  }

  function generateButton() {
    const est = estimate(app);
    return el("button", {
      class: "generate",
      type: "button",
      disabled: !canRun,
      title: est ? t("ws.est", { gpu: est.gpu }) : null,
      onclick: submitRun,
    },
    t("ws.generate"),
    est ? el("span", { class: "cost" }, icon("spark"), fmtShort(est.seconds)) : icon("spark"));
  }

  // Dropzone field for sidebar
  function buildDropzone(inp) {
    const zone = el("div", { class: "drop", role: "button", tabindex: "0" });
    missingEls.set(inp.id, zone);

    if (inp.paint) {
      zone.classList.add("paint");
      const openBrush = async () => {
        const srcFile = files.get(inp.paint);
        if (!srcFile) {
          const srcInp = app.inputs.find((i) => i.id === inp.paint);
          toast(t("paint.first", { label: srcInp?.label || inp.paint }), { error: true });
          return;
        }
        const mask = await openPainter(srcFile, { mask: files.get(inp.id) || null, title: inp.label });
        if (mask) setFile(inp.id, mask);
      };
      zone.onclick = openBrush;
      zone.onkeydown = (e) => { if (e.key === "Enter") openBrush(); };
      const update = async () => {
        const srcUrl = fileUrls.get(inp.paint);
        const maskFile = files.get(inp.id);
        zone.classList.toggle("off", !srcUrl);
        zone.classList.toggle("has", Boolean(srcUrl && maskFile));
        zone.classList.remove("missing");
        if (srcUrl && maskFile) {
          try {
            const canvas = await maskPreview(srcUrl, maskFile);
            zone.replaceChildren(canvas,
              el("div", { class: "bar2" },
                el("button", { class: "mini", type: "button", title: t("paint.edit"), onclick: (e) => { e.stopPropagation(); openBrush(); } }, icon("wand")),
                el("button", { class: "mini", type: "button", title: t("ws.remove"), onclick: (e) => { e.stopPropagation(); setFile(inp.id, null); } }, icon("x"))));
            return;
          } catch { /* fall through */ }
        }
        const srcInp = app.inputs.find((i) => i.id === inp.paint);
        zone.replaceChildren(
          srcUrl ? el("img", { src: srcUrl, alt: "" }) : null,
          el("span", { class: "ic" }, icon("wand")),
          el("b", {}, inp.label),
          el("small", {}, srcUrl ? t("paint.cta") : t("paint.first", { label: srcInp?.label || inp.paint })));
      };
      fieldUpdaters.push(update);
      update();
      return zone;
    }

    const fileInput = el("input", { type: "file", accept: acceptOf(inp.type), hidden: true });
    fileInput.addEventListener("change", () => { if (fileInput.files?.[0]) setFile(inp.id, fileInput.files[0]); fileInput.value = ""; });
    zone.addEventListener("click", () => fileInput.click());
    zone.addEventListener("keydown", (e) => { if (e.key === "Enter") fileInput.click(); });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      const f = e.dataTransfer.files?.[0];
      if (f) setFile(inp.id, f);
    });

    const lims = [t("ws.drop.hint")];
    if (inp.limits?.max_mb) lims.push(t("ws.drop.mb", { mb: inp.limits.max_mb }));
    if (inp.limits?.seconds) lims.push(t("ws.drop.seconds", { a: inp.limits.seconds[0], b: inp.limits.seconds[1] }));

    const update = () => {
      const f = files.get(inp.id);
      const u = fileUrls.get(inp.id);
      zone.classList.toggle("has", Boolean(f));
      zone.classList.remove("missing");
      if (f && u) {
        const preview = inp.type === "video" ? el("video", { src: u, muted: true, controls: true, playsinline: true })
          : inp.type === "audio" ? el("audio", { src: u, controls: true })
            : el("img", { src: u, alt: f.name });
        zone.replaceChildren(preview,
          el("div", { class: "bar2" },
            el("button", { class: "mini", type: "button", title: t("ws.replace"), onclick: (e) => { e.stopPropagation(); fileInput.click(); } }, icon("upload")),
            el("button", { class: "mini", type: "button", title: t("ws.remove"), onclick: (e) => { e.stopPropagation(); setFile(inp.id, null); } }, icon("x"))),
          el("span", { class: "fname" }, f.name),
          fileInput);
      } else {
        zone.replaceChildren(
          el("span", { class: "ic" }, icon(inp.type === "video" ? "video" : inp.type === "audio" ? "audio" : "image")),
          el("b", {}, inp.label),
          el("small", {}, t(`ws.drop.${inp.type}`)),
          el("small", {}, lims.join(" · ")),
          fileInput);
      }
    };
    fieldUpdaters.push(update);
    update();
    return zone;
  }

  // Standard sidebar field builder
  function buildField(inp) {
    if (isMedia(inp.type)) return buildDropzone(inp);

    const lbl = el("div", { class: "lbl" },
      el("span", {}, inp.label),
      !inp.required && inp.type === "textarea" ? el("small", {}, t("ws.optional")) : null);
    const help = inp.help ? el("p", { class: "help" }, inp.help) : null;

    if (inp.type === "textarea") {
      const ta = el("textarea", {
        class: inp.required ? "" : "short",
        placeholder: inp.default ? t("ws.eg", { x: String(inp.default) }) : (inp.required ? t("ws.prompt.ph") : t("ws.prompt.opt", { label: inp.label })),
        value: String(values[inp.id] ?? ""),
      });
      missingEls.set(inp.id, ta);
      ta.addEventListener("input", () => { values[inp.id] = ta.value; ta.classList.remove("missing"); });
      ta.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submitRun(); } });
      fieldUpdaters.push(() => { if (ta.value !== String(values[inp.id] ?? "")) ta.value = String(values[inp.id] ?? ""); });
      return el("div", { class: "field" }, lbl, ta, help);
    }

    if (inp.type === "text") {
      const input = el("input", { type: "text", value: String(values[inp.id] ?? ""), placeholder: inp.default ? t("ws.eg", { x: String(inp.default) }) : "" });
      missingEls.set(inp.id, input);
      input.addEventListener("input", () => { values[inp.id] = input.value; input.classList.remove("missing"); });
      fieldUpdaters.push(() => { if (input.value !== String(values[inp.id] ?? "")) input.value = String(values[inp.id] ?? ""); });
      return el("div", { class: "field" }, lbl, input, help);
    }

    if (inp.type === "slider" || inp.type === "number") {
      const min = inp.min ?? 0, max = inp.max ?? 100, step = inp.step ?? 1;
      if (inp.type === "slider") {
        const valB = el("b", {}, String(values[inp.id]));
        const range = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(values[inp.id]) });
        const sync = () => {
          const n = Number(values[inp.id] ?? min);
          range.value = String(n);
          valB.textContent = String(n);
          range.style.setProperty("--p", `${((n - min) / (max - min || 1)) * 100}%`);
        };
        range.addEventListener("input", () => { values[inp.id] = Number(range.value); sync(); });
        fieldUpdaters.push(sync);
        sync();
        return el("div", { class: "field" }, el("div", { class: "range" }, el("div", { class: "top" }, el("span", {}, inp.label), valB), range), help);
      }
      const num = el("input", { type: "number", min: inp.min, max: inp.max, step: inp.step, value: String(values[inp.id] ?? "") });
      num.addEventListener("input", () => { values[inp.id] = Number(num.value); });
      fieldUpdaters.push(() => { num.value = String(values[inp.id] ?? ""); });
      return el("div", { class: "field" }, lbl, num, help);
    }

    if (inp.type === "toggle") {
      const cb = el("input", { type: "checkbox", checked: Boolean(values[inp.id]) });
      cb.addEventListener("change", () => { values[inp.id] = cb.checked; });
      fieldUpdaters.push(() => { cb.checked = Boolean(values[inp.id]); });
      return el("div", { class: "field" },
        el("div", { class: "togrow" },
          el("div", { class: "t" }, el("span", { style: { fontWeight: 600, fontSize: "13px" } }, inp.label), inp.help ? el("small", {}, inp.help) : null),
          el("label", { class: "switch" }, cb, el("i", {}))));
    }

    if (inp.type === "seed") {
      const num = el("input", { type: "number", value: String(values[inp.id] ?? -1), placeholder: "-1" });
      num.addEventListener("input", () => { values[inp.id] = num.value === "" ? -1 : Number(num.value); });
      const rnd = el("button", { class: "btn small", type: "button", title: t("ws.seed.random"), onclick: () => { values[inp.id] = -1; refreshFields(); } }, icon("dice"));
      fieldUpdaters.push(() => { num.value = String(values[inp.id] ?? -1); });
      return el("div", { class: "field" }, lbl, el("div", { style: { display: "flex", gap: "6px" } }, num, rnd), help);
    }

    if (inp.type === "select") {
      const opts = inp.options || [];
      if (!inp.gallery && !inp.multiple && opts.length <= 4 && opts.every((o) => String(o.label).length <= 14)) {
        const seg = el("div", { class: "seg" });
        const btns = opts.map((o) => el("button", {
          type: "button",
          onclick: () => { values[inp.id] = o.value; refreshFields(); },
        }, o.label));
        seg.append(...btns);
        const sync = () => {
          opts.forEach((o, i) => btns[i].setAttribute("aria-pressed", String(String(values[inp.id]) === String(o.value))));
        };
        fieldUpdaters.push(sync);
        sync();
        return el("div", { class: "field" }, lbl, seg, help);
      }

      const valSpan = el("span", { class: "v" });
      const rowBtn = el("button", { class: "selrow", type: "button", onclick: (e) => openSelectPopover(e.currentTarget, inp) }, valSpan, icon("chevD"));
      const previewHost = inp.gallery ? el("div", { class: "fx-now", hidden: true }) : null;
      const sync = () => {
        valSpan.textContent = selectLabel(inp);
        if (previewHost) {
          const shot = app.example?.options?.[inp.id]?.[String(values[inp.id])];
          if (shot) {
            previewHost.hidden = false;
            const media = thumb({ kind: "example", type: shot.type, card: shot.card, poster: shot.poster }, { play: "hover" });
            previewHost.replaceChildren(media);
            hoverPlay(previewHost, media._video);
          } else {
            previewHost.hidden = true;
          }
        }
      };
      fieldUpdaters.push(sync);
      sync();
      return el("div", { class: "field" }, lbl, previewHost, rowBtn, help);
    }

    return null;
  }

  // Build Sidebar layout left column
  function buildSidebar() {
    const side = el("aside", { class: "side" });

    // Video studio tabs
    const vtab = videoTabOf(app.id);
    if (vtab) {
      side.append(el("div", { class: "side-tabs", role: "tablist" }, ...VIDEO_TABS.map((tab) => {
        const first = tab.apps.map((id) => byId.get(id)).find(Boolean);
        return el("button", {
          type: "button",
          role: "tab",
          "aria-selected": String(tab.id === vtab),
          onclick: () => { if (first && tab.id !== vtab) location.hash = `#/app/${first.id}`; },
        }, t(`vtab.${tab.id}`));
      })));
    }

    const scroll = el("div", { class: "side-scroll" });

    // Model/app card with Change button
    const ex = exampleItem(app);
    const cardMedia = ex ? thumb(ex, { play: "hover" }) : el("div", { class: "media" });
    const modelCard = el("div", { class: "model-card", onclick: (e) => openSwitcher(e.currentTarget) },
      cardMedia,
      el("button", { class: "change", type: "button", onclick: (e) => { e.stopPropagation(); openSwitcher(e.currentTarget); } }, icon("swap"), t("ws.change")),
      el("div", { class: "txt" }, el("h3", { class: "display" }, app.name), el("p", {}, tagline(app))));
    hoverPlay(modelCard, cardMedia._video);
    scroll.append(modelCard);

    const modes = modesSwitch();
    if (modes) scroll.append(modes);

    const basic = app.inputs.filter((i) => !isAdvanced(i));
    const adv = app.inputs.filter((i) => isAdvanced(i));
    for (const inp of basic) {
      const f = buildField(inp);
      if (f) scroll.append(f);
    }

    // Presets
    if (app.presets?.length) {
      const seg = el("div", { class: "seg" });
      const allPresets = [{ id: null, label: t("ws.preset.none") }, ...app.presets];
      const btns = allPresets.map((p) => el("button", { type: "button", onclick: () => { preset = p.id; refreshFields(); } }, p.label));
      seg.append(...btns);
      const sync = () => allPresets.forEach((p, i) => btns[i].setAttribute("aria-pressed", String(preset === p.id)));
      fieldUpdaters.push(sync);
      sync();
      scroll.append(el("div", { class: "field" }, el("div", { class: "lbl" }, el("span", {}, t("ws.preset"))), seg));
    }

    if (adv.length) {
      scroll.append(el("details", { class: "adv" },
        el("summary", {}, t("ws.advanced"), el("span", { class: "i-chev" }, icon("chevD"))),
        el("div", { class: "in" }, ...adv.map(buildField).filter(Boolean))));
    }

    const needBanner = needNode(app);
    const foot = el("div", { class: "side-foot" },
      needBanner ? el("p", { class: "side-note" }, needBanner) : null,
      noteEl,
      el("div", { class: "row" }, batchCounter(), generateButton()));

    side.append(scroll, foot);
    return side;
  }

  // Build Floating Composer bar (prompt-first image & audio apps)
  function buildComposer() {
    const pIn = promptInput(app);
    const fileInputs = app.inputs.filter((i) => isMedia(i.type));
    const otherInputs = app.inputs.filter((i) => i !== pIn && !isMedia(i.type));
    const basicChips = otherInputs.filter((i) => !isAdvanced(i));
    const advChips = otherInputs.filter((i) => isAdvanced(i));

    const attachBox = el("div", { class: "cmp-attach" });
    for (const inp of fileInputs) {
      const fileIn = el("input", { type: "file", accept: acceptOf(inp.type), hidden: true });
      fileIn.addEventListener("change", () => { if (fileIn.files?.[0]) setFile(inp.id, fileIn.files[0]); fileIn.value = ""; });
      const slot = el("div", { class: "att need", role: "button", tabindex: "0", title: inp.label, onclick: () => fileIn.click() });
      missingEls.set(inp.id, slot);
      const sync = () => {
        const f = files.get(inp.id), u = fileUrls.get(inp.id);
        slot.className = f ? "att" : "att need";
        if (f && u) {
          slot.replaceChildren(
            inp.type === "video" ? el("video", { src: u, muted: true }) : el("img", { src: u, alt: f.name }),
            el("button", { class: "x", type: "button", onclick: (e) => { e.stopPropagation(); setFile(inp.id, null); } }, "×"),
            el("span", { class: "lbl" }, inp.label),
            fileIn);
        } else {
          slot.replaceChildren(icon("plus"), el("span", { class: "lbl" }, inp.label), fileIn);
        }
      };
      fieldUpdaters.push(sync);
      sync();
      attachBox.append(slot);
    }

    const ta = el("textarea", {
      class: "cmp-prompt",
      rows: "2",
      placeholder: pIn?.default ? t("ws.eg", { x: String(pIn.default) }) : t("ws.prompt.ph"),
      value: pIn ? String(values[pIn.id] ?? "") : "",
    });
    if (pIn) {
      missingEls.set(pIn.id, ta);
      ta.addEventListener("input", () => { values[pIn.id] = ta.value; ta.classList.remove("missing"); });
      ta.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submitRun(); } });
      fieldUpdaters.push(() => { if (ta.value !== String(values[pIn.id] ?? "")) ta.value = String(values[pIn.id] ?? ""); });
    }

    // Model switcher chip
    const ex = app.example;
    const thSrc = ex?.poster || (ex && ex.type !== "video" ? ex.card : null);
    const modelChip = el("button", { class: "chip model", type: "button", onclick: (e) => openSwitcher(e.currentTarget) },
      el("span", { class: "thumb" }, thSrc ? el("img", { src: thSrc, alt: "" }) : icon(iconOf(app))),
      el("span", { class: "v" }, app.name),
      icon("chevD"));

    const makeChip = (inp) => {
      if (inp.type === "toggle") {
        const b = el("button", { class: "chip", type: "button", onclick: () => { values[inp.id] = !values[inp.id]; refreshFields(); } }, inp.label);
        const sync = () => b.classList.toggle("on", Boolean(values[inp.id]));
        fieldUpdaters.push(sync);
        sync();
        return b;
      }
      if (inp.type === "select") {
        const val = el("span", { class: "v" });
        const b = el("button", { class: "chip", type: "button", onclick: (e) => openSelectPopover(e.currentTarget, inp) },
          el("span", { class: "k" }, inp.label), val);
        const sync = () => { val.textContent = selectLabel(inp); b.classList.toggle("filled", Boolean(values[inp.id] && (!Array.isArray(values[inp.id]) || values[inp.id].length))); };
        fieldUpdaters.push(sync);
        sync();
        return b;
      }
      if (inp.type === "slider" || inp.type === "number") {
        const val = el("span", { class: "v" });
        const b = el("button", { class: "chip", type: "button", onclick: (e) => {
          const min = inp.min ?? 0, max = inp.max ?? 100, step = inp.step ?? 1;
          const r = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(values[inp.id]) });
          const num = el("b", {}, String(values[inp.id]));
          r.addEventListener("input", () => { values[inp.id] = Number(r.value); num.textContent = r.value; refreshFields(); });
          popover(e.currentTarget, el("div", { class: "pad" }, el("div", { class: "range" }, el("div", { class: "top" }, el("span", {}, inp.label), num), r), inp.help ? el("p", { class: "help" }, inp.help) : null));
        } }, el("span", { class: "k" }, inp.label), val);
        const sync = () => { val.textContent = String(values[inp.id]); };
        fieldUpdaters.push(sync);
        sync();
        return b;
      }
      if (inp.type === "textarea" || inp.type === "text") {
        const b = el("button", { class: "chip", type: "button", onclick: (e) => {
          const box = el("textarea", { value: String(values[inp.id] ?? ""), placeholder: inp.default ? t("ws.eg", { x: String(inp.default) }) : "" });
          box.addEventListener("input", () => { values[inp.id] = box.value; refreshFields(); });
          popover(e.currentTarget, el("div", { class: "pad" }, el("h4", {}, inp.label), box, inp.help ? el("p", { class: "help" }, inp.help) : null), { width: 340 });
        } }, el("span", { class: "k" }, inp.label));
        const sync = () => b.classList.toggle("filled", Boolean(String(values[inp.id] ?? "").trim()));
        fieldUpdaters.push(sync);
        sync();
        return b;
      }
      return null;
    };

    const advBtn = advChips.length ? el("button", {
      class: "chip square",
      type: "button",
      title: t("ws.advanced"),
      "aria-label": t("ws.advanced"),
      onclick: (e) => popover(e.currentTarget, el("div", { class: "pad", style: { width: "300px" } }, ...advChips.map(buildField).filter(Boolean)), { align: "end" }),
    }, icon("sliders")) : null;

    const composer = el("div", { class: "composer" },
      el("div", { class: "cmp-top" }, fileInputs.length ? attachBox : null, ta),
      el("div", { class: "cmp-row" },
        modelChip,
        modesSwitch(),
        ...basicChips.map(makeChip).filter(Boolean),
        advBtn,
        el("span", { class: "grow" }),
        batchCounter(),
        generateButton()),
      needNode(app) ? el("div", { class: "cmp-hint" }, needNode(app)) : null,
      noteEl);

    if (fileInputs.length) {
      composer.addEventListener("dragover", (e) => { e.preventDefault(); composer.classList.add("drag"); });
      composer.addEventListener("dragleave", () => composer.classList.remove("drag"));
      composer.addEventListener("drop", (e) => {
        e.preventDefault();
        composer.classList.remove("drag");
        const f = e.dataTransfer.files?.[0];
        if (f) setFile(fileInputs[0].id, f);
      });
    }
    return composer;
  }

  // Empty history hero
  function buildEmptyHistory() {
    const ex = exampleItem(app);
    if (layout === "composer") {
      return el("div", { class: "feed-empty" },
        el("div", {},
          el("div", { class: "glass" }, logoMark()),
          el("h2", { class: "display" }, el("span", {}, t("ws.create.title")), app.name),
          app.summary ? el("p", {}, app.summary) : null,
          ex ? el("button", { class: "ex", type: "button", onclick: loadLabExample },
            thumb(ex, { play: "none" }),
            el("div", {}, el("b", {}, t("ws.useex")), el("small", {}, ex.seconds ? fmtSeconds(ex.seconds) : tagline(app)))) : null));
    }

    // Sidebar empty hero + "More like this"
    const wrap = el("div", { style: { display: "grid", gap: "22px" } });
    const flow = ex ? el("div", { class: "flow" },
      ex.inputs.length ? el("div", { class: "ins" }, ...ex.inputs.slice(0, 3).map((inp) =>
        el("div", { class: "media" }, inp.thumb ? el("img", { src: inp.thumb, alt: inp.label }) : icon(inp.type === "video" ? "video" : "image")))) : null,
      ex.inputs.length ? el("span", { class: "arrow" }, icon("chevR")) : null,
      el("div", { class: "out" }, thumb(ex, { play: "visible" }))) : null;

    wrap.append(el("div", { class: "ws-hero" },
      el("div", {},
        el("h1", { class: "display" }, tagline(app)),
        app.summary ? el("p", {}, app.summary) : null,
        el("div", { class: "row" },
          ex ? el("button", { class: "btn lime", type: "button", onclick: loadLabExample }, icon("redo"), t("ws.useex")) : null,
          el("button", { class: "btn ghost", type: "button", onclick: () => { activeTab = "how"; drawMain(); } }, icon("info"), t("ws.how")))),
      flow));

    const related = familyOf(app).filter((a) => a.id !== app.id && a.example?.full).slice(0, 12);
    if (related.length) {
      const relItems = related.map(exampleItem).filter(Boolean);
      const grid = el("div", {});
      const cards = related.map((a) => {
        const it = exampleItem(a);
        const media = thumb(it, { play: "hover" });
        const card = el("a", { class: "m-item", href: `#/app/${a.id}` },
          media,
          el("div", { class: "cap" }, el("span", {}, a.name)));
        hoverPlay(card, media._video);
        return card;
      });
      wrap.append(el("h2", { class: "display", style: { margin: "4px 0 0", fontSize: "22px" } }, t("ws.related")), grid);
      cleanups.push(masonry(grid, cards, { min: 220, gap: 12 }));
      void relItems;
    }
    return wrap;
  }

  // Main right-hand panel (History / Library / How it works)
  const mainPanel = el("div", { class: "ws-main" });
  const tabsEl = el("div", { class: "tabs", role: "tablist" });
  const denseBtn = el("button", {
    class: "icon-btn",
    type: "button",
    title: t("ws.dense"),
    "aria-label": t("ws.dense"),
    onclick: () => { dense = !dense; store.set("ws.dense", dense); drawMain(); },
  }, icon(dense ? "rows" : "grid"));
  const topRow = el("div", { class: "ws-top" }, tabsEl, el("div", { class: "right" }, denseBtn));
  const stage = el("div", { style: { flex: "1", display: "flex", flexDirection: "column" } });
  mainPanel.append(topRow, stage);

  let disposeTab = null;
  function drawMain() {
    disposeTab?.();
    disposeTab = null;
    denseBtn.replaceChildren(icon(dense ? "rows" : "grid"));
    tabsEl.replaceChildren(
      ...[["history", "clock", t("ws.history")], ["library", "film", t("ws.library")], ["how", "info", t("ws.how")]].map(([id, ic, label]) =>
        el("button", { type: "button", role: "tab", "aria-selected": String(activeTab === id), onclick: () => { activeTab = id; drawMain(); } }, icon(ic), label)));

    if (activeTab === "history") {
      const host = el("div", { style: { flex: "1", display: "flex", flexDirection: "column" } });
      stage.replaceChildren(host);
      disposeTab = feedView(host, { app: app.id, dense, empty: buildEmptyHistory });
    } else if (activeTab === "library") {
      stage.replaceChildren(buildLibraryTab(app, loadLabExample, (inpId, val) => {
        values[inpId] = val;
        refreshFields();
        activeTab = "history";
        drawMain();
      }));
    } else {
      stage.replaceChildren(buildHowTab(app));
    }
  }

  // Global paste support for the first image input
  const onPaste = (e) => {
    const firstImg = app.inputs.find((i) => i.type === "image" && !i.paint);
    if (!firstImg) return;
    const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith("image/"));
    if (item) {
      const f = item.getAsFile();
      if (f) setFile(firstImg.id, f);
    }
  };
  document.addEventListener("paste", onPaste);

  const ws = el("div", { class: `ws l-${layout}` });
  if (layout === "sidebar") ws.append(buildSidebar(), mainPanel);
  else ws.append(mainPanel, buildComposer());

  drawMain();

  activeController = { app, load: loadPayload };
  if (pendingLoad && pendingLoad.appId === app.id) {
    const p = pendingLoad;
    pendingLoad = null;
    void loadPayload(p);
  }

  return {
    node: ws,
    app,
    dispose: () => {
      if (activeController?.app === app) activeController = null;
      disposeTab?.();
      cleanups.forEach((fn) => fn?.());
      document.removeEventListener("paste", onPaste);
      for (const u of fileUrls.values()) URL.revokeObjectURL(u);
      fileUrls.clear();
    },
  };
}
