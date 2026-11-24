// App workspace view: builds forms from app.json, handles uploads/painting/presets, submits runs, and shows history/how-it-works.
import { el, icon, popover, closePopover, toast, clamp, fmtSeconds, session } from "./util.js";
import { t } from "./i18n.js";
import {
  apps, byId, layoutOf, familyOf, VIDEO_TABS, videoTabOf,
  tagline, estimate, iconOf, promptInput, draftsAllowed,
} from "./catalog.js";
import { exampleItem, thumb, hoverPlay, optionTile } from "./media.js";
import { feed, feedView } from "./feed.js";
import { openPainter, maskPreview } from "./paint.js";
import { needNode } from "./models.js";
import { flagButton, flags } from "./flags.js";
import { openAuthModal, refreshBootstrap } from "./account.js";

const FILE_TYPES = new Set(["image", "video", "audio"]);
const isFile = (inp) => FILE_TYPES.has(inp.type);

// Pending state carried across route switches (recreate, useIn, loadExampleInto)
let pending = null;

async function fetchAsFile(url, name = "input") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const ext = url.split(/[?#]/)[0].split(".").pop() || "bin";
  const finalName = name.includes(".") ? name : `${name}.${ext}`;
  return new File([blob], finalName, { type: blob.type || "application/octet-stream" });
}

export function loadExampleInto(app) {
  const ex = exampleItem(app);
  pending = {
    appId: app.id,
    values: { ...(ex?.values || {}), ...(ex?.seed != null ? { seed: ex.seed } : {}) },
    inputs: ex?.inputs || [],
    run: false,
  };
  if (location.hash === `#/app/${app.id}`) location.replace(`#/app/${app.id}?ex=${Date.now()}`);
  else location.hash = `#/app/${app.id}`;
}

export function recreate(item, { run = false } = {}) {
  pending = {
    appId: item.app,
    values: { ...(item.values || {}), ...(item.seed != null ? { seed: item.seed } : {}) },
    preset: item.preset ?? null,
    inputs: item.inputs || [],
    run,
  };
  if (location.hash.startsWith(`#/app/${item.app}`)) {
    location.replace(`#/app/${item.app}?r=${Date.now()}`);
  } else {
    location.hash = `#/app/${item.app}`;
  }
}

export function useIn(anchor, item, done) {
  const mediaKind = item.type === "video" ? "video" : "image";
  const compatible = apps.filter((a) => a.inputs.some((i) => i.type === mediaKind && !i.paint));
  const preferredIds = mediaKind === "video"
    ? ["recast", "mixed-media", "upscale-video", "smooth", "reframe", "extend-video", "vfx-day-to-night", "dub"]
    : ["video", "relight", "edit", "upscale", "remove-bg", "effects", "morph", "angles", "camera-moves", "speak"];
  const top = preferredIds.map((id) => compatible.find((a) => a.id === id)).filter(Boolean);
  const topSet = new Set(top.map((a) => a.id));
  const rest = compatible.filter((a) => !topSet.has(a.id));

  const sendTo = (targetApp) => {
    const targetInput = targetApp.inputs.find((i) => i.type === mediaKind && !i.paint);
    if (!targetInput) return;
    pending = {
      appId: targetApp.id,
      values: {},
      inputs: [{ id: targetInput.id, file: item.full, name: `${item.app}.${mediaKind === "video" ? "mp4" : "png"}` }],
      run: false,
    };
    closePopover();
    done?.();
    toast(t("toast.sent", { app: targetApp.name }));
    if (location.hash.startsWith(`#/app/${targetApp.id}`)) location.replace(`#/app/${targetApp.id}?u=${Date.now()}`);
    else location.hash = `#/app/${targetApp.id}`;
  };

  const row = (a) => el("button", { class: "opt", type: "button", onclick: () => sendTo(a) },
    el("span", { class: "thumb" }, exampleItem(a) ? thumb(exampleItem(a), { play: "none" }) : icon(iconOf(a))),
    el("span", { class: "two" }, el("b", {}, a.name), el("small", {}, tagline(a))));

  const content = el("div", { class: "usein" },
    el("h4", {}, t("act.usein")),
    ...top.map(row),
    rest.length ? el("details", {},
      el("summary", {}, t("usein.more", { n: rest.length })),
      ...rest.map(row)) : null);

  popover(anchor, content, { align: "end" });
}

export function workspaceView(appId) {
  const app = byId.get(appId);
  if (!app) {
    return {
      node: el("div", { class: "page" }, el("div", { class: "empty" }, `Unknown app: ${appId}`)),
      app: null,
    };
  }

  const layout = layoutOf(app);
  const values = {};
  const files = {};
  const previews = new Map();
  let presetId = null;
  let selectedModelId = app.available_models?.[0]?.id || null;
  let activeTab = "history";
  let dense = false;
  let submitting = false;
  let count = 1;
  let lastSeed = null;

  // Initial defaults
  for (const inp of app.inputs) {
    if (isFile(inp)) continue;
    if (inp.default !== undefined) values[inp.id] = inp.default;
    else if (inp.type === "select" && inp.multiple) values[inp.id] = [];
    else if (inp.type === "select" && inp.options?.length) values[inp.id] = inp.options[0].value;
    else if (inp.type === "toggle") values[inp.id] = false;
  }

  // Option from URL ?opt=input:value
  const optMatch = /\?opt=([^&]+)/.exec(location.hash);
  if (optMatch) {
    const [inpId, val] = decodeURIComponent(optMatch[1]).split(":");
    const inp = app.inputs.find((i) => i.id === inpId);
    if (inp) values[inpId] = val;
  }

  // Consume pending state from recreate / useIn / loadExampleInto
  const loadJob = pending && pending.appId === app.id ? pending : null;
  if (loadJob) {
    pending = null;
    Object.assign(values, loadJob.values || {});
    if (loadJob.preset) presetId = loadJob.preset;
  }

  const cleanups = [];
  const mainBody = el("div", { style: { display: "grid", gap: "14px", flex: 1, minHeight: 0 } });
  const fieldUpdaters = new Map();

  function setFile(inputId, file) {
    const prevUrl = previews.get(inputId);
    if (prevUrl) URL.revokeObjectURL(prevUrl);
    if (file) {
      files[inputId] = file;
      previews.set(inputId, URL.createObjectURL(file));
    } else {
      delete files[inputId];
      previews.delete(inputId);
      // Clear any mask painted over this image
      for (const inp of app.inputs) {
        if (inp.paint === inputId) setFile(inp.id, null);
      }
    }
    fieldUpdaters.get(inputId)?.();
    for (const inp of app.inputs) {
      if (inp.paint === inputId) fieldUpdaters.get(inp.id)?.();
    }
  }

  cleanups.push(() => {
    for (const u of previews.values()) URL.revokeObjectURL(u);
    previews.clear();
  });

  // Switcher popover for familyOf(app)
  function openFamilyPicker(anchor) {
    const fam = familyOf(app);
    const list = el("div", {},
      el("h4", {}, t("ws.change")),
      ...fam.map((a) => {
        const ex = exampleItem(a);
        return el("a", {
          class: "opt", href: `#/app/${a.id}`, "aria-selected": String(a.id === app.id),
          onclick: () => closePopover(),
        },
        el("span", { class: "thumb" }, ex ? thumb(ex, { play: "none" }) : icon(iconOf(a))),
        el("span", { class: "two" }, el("b", {}, a.name), el("small", {}, tagline(a))),
        el("span", { class: "chk" }, icon("check")));
      }));
    popover(anchor, list);
  }

  function openSelectPopover(anchor, inp, onChange) {
    if (inp.gallery) {
      const optShots = app.example?.options?.[inp.id] || {};
      const grid = el("div", { class: "fx-grid" }, ...(inp.options || []).map((opt) =>
        optionTile(opt, optShots[String(opt.value)] || null, {
          selected: String(values[inp.id]) === String(opt.value),
          play: "hover",
          flagKey: optShots[String(opt.value)] ? flags.key(app.id, inp.id, opt.value) : null,
          onPick: () => {
            values[inp.id] = opt.value;
            closePopover();
            onChange();
          },
        })));
      popover(anchor, el("div", {}, el("h4", {}, inp.label), grid), { wide: true });
      return;
    }

    if (inp.multiple) {
      const max = inp.multiple.max;
      const ordered = Boolean(inp.multiple.ordered);
      const wrap = el("div");
      const drawMulti = () => {
        const cur = Array.isArray(values[inp.id]) ? [...values[inp.id]] : [];
        const hint = max ? t(ordered ? "ws.multi.upto.ordered" : "ws.multi.upto", { n: max }) : "";
        wrap.replaceChildren(
          el("h4", {},
            inp.label,
            hint ? el("span", { class: "n" }, hint) : null,
            cur.length ? el("button", {
              class: "mini-link", type: "button",
              onclick: () => { values[inp.id] = []; drawMulti(); onChange(); },
            }, t("ws.multi.clear")) : null),
          el("div", { class: "multi-list" }, ...(inp.options || []).map((opt) => {
            const val = String(opt.value);
            const idx = cur.map(String).indexOf(val);
            const picked = idx >= 0;
            return el("button", {
              class: "opt", type: "button", "aria-pressed": String(picked),
              onclick: () => {
                if (picked) {
                  values[inp.id] = cur.filter((x) => String(x) !== val);
                } else {
                  if (max && cur.length >= max) { toast(t("ws.multi.max", { n: max }), { error: true }); return; }
                  values[inp.id] = [...cur, opt.value];
                }
                drawMulti();
                onChange();
              },
            },
            el("span", {}, opt.label),
            picked ? el("span", { class: "pick" }, ordered ? String(idx + 1) : icon("check")) : null);
          })));
      };
      drawMulti();
      popover(anchor, wrap);
      return;
    }

    popover(anchor, el("div", {},
      el("h4", {}, inp.label),
      ...(inp.options || []).map((opt) => el("button", {
        class: "opt", type: "button", "aria-selected": String(values[inp.id] === opt.value || String(values[inp.id]) === String(opt.value)),
        onclick: () => { values[inp.id] = opt.value; closePopover(); onChange(); },
      }, el("span", {}, opt.label), el("span", { class: "chk" }, icon("check"))))));
  }

  function selectDisplay(inp) {
    const v = values[inp.id];
    if (inp.multiple) {
      const list = Array.isArray(v) ? v : [];
      if (!list.length) return t("ws.none");
      const labels = list.map((x) => inp.options?.find((o) => String(o.value) === String(x))?.label ?? x);
      return labels.slice(0, 2).join(", ") + (labels.length > 2 ? ` +${labels.length - 2}` : "");
    }
    return inp.options?.find((o) => o.value === v || String(o.value) === String(v))?.label ?? String(v ?? "");
  }

  function renderFieldControl(inp, { compact = false } = {}) {
    const box = el("div", { class: "field" });
    const lbl = el("div", { class: "lbl" },
      el("span", {}, inp.label),
      !inp.required && !isFile(inp) ? el("small", {}, t("ws.optional")) : null);

    if (isFile(inp)) {
      const fileInput = el("input", {
        type: "file", hidden: true,
        accept: inp.type === "video" ? "video/*" : inp.type === "audio" ? "audio/*" : "image/*",
        onchange: () => { if (fileInput.files?.[0]) setFile(inp.id, fileInput.files[0]); fileInput.value = ""; },
      });

      const zone = el("div", { class: "drop", tabindex: "0", role: "button" });
      const drawDrop = async () => {
        const f = files[inp.id];
        const url = previews.get(inp.id);
        zone.className = "drop";
        if (inp.paint) zone.classList.add("paint");

        if (f && url) {
          zone.classList.add("has");
          let previewEl;
          if (inp.paint && previews.get(inp.paint)) {
            previewEl = await maskPreview(previews.get(inp.paint), f).catch(() => el("img", { src: url, alt: f.name }));
          } else if (inp.type === "video") {
            previewEl = el("video", { src: url, controls: true, muted: true, playsinline: true });
          } else if (inp.type === "audio") {
            previewEl = el("audio", { src: url, controls: true });
          } else {
            previewEl = el("img", { src: url, alt: f.name });
          }
          zone.replaceChildren(
            previewEl,
            el("span", { class: "fname" }, f.name),
            el("div", { class: "bar2" },
              el("button", {
                class: "mini", type: "button", title: inp.paint ? t("paint.edit") : t("ws.replace"),
                onclick: async (e) => {
                  e.stopPropagation();
                  if (inp.paint) {
                    const srcFile = files[inp.paint];
                    if (srcFile) {
                      const nextMask = await openPainter(srcFile, { mask: f, title: inp.label });
                      if (nextMask) setFile(inp.id, nextMask);
                    }
                  } else {
                    fileInput.click();
                  }
                },
              }, icon(inp.paint ? "redo" : "upload")),
              el("button", {
                class: "mini", type: "button", title: t("ws.remove"),
                onclick: (e) => { e.stopPropagation(); setFile(inp.id, null); },
              }, icon("x"))),
            fileInput);
          return;
        }

        const srcFile = inp.paint ? files[inp.paint] : null;
        if (inp.paint && !srcFile) zone.classList.add("off");
        const hintBits = [t("ws.drop.hint")];
        if (inp.limits?.max_mb) hintBits.push(t("ws.drop.mb", { mb: inp.limits.max_mb }));
        if (inp.limits?.seconds) hintBits.push(t("ws.drop.seconds", { a: inp.limits.seconds[0], b: inp.limits.seconds[1] }));

        zone.replaceChildren(
          inp.paint && previews.get(inp.paint) ? el("img", { src: previews.get(inp.paint), alt: "" }) : null,
          el("span", { class: "ic" }, icon(inp.paint ? "sliders" : inp.type)),
          el("b", {}, inp.paint ? t("paint.cta") : t(`ws.drop.${inp.type}`)),
          el("small", {}, inp.paint && !srcFile
            ? t("paint.first", { label: app.inputs.find((x) => x.id === inp.paint)?.label ?? inp.paint })
            : hintBits.join(" · ")),
          fileInput);
      };

      zone.onclick = async () => {
        if (inp.paint) {
          const srcFile = files[inp.paint];
          if (!srcFile) {
            toast(t("paint.first", { label: app.inputs.find((x) => x.id === inp.paint)?.label ?? inp.paint }), { error: true });
            return;
          }
          const mask = await openPainter(srcFile, { mask: files[inp.id] ?? null, title: inp.label });
          if (mask) setFile(inp.id, mask);
        } else {
          fileInput.click();
        }
      };
      zone.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zone.click(); } };
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("over"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("over");
        const f = e.dataTransfer.files?.[0];
        if (f && !inp.paint) setFile(inp.id, f);
      });

      fieldUpdaters.set(inp.id, drawDrop);
      drawDrop();
      box.append(lbl, zone);
      if (inp.help) box.append(el("p", { class: "help" }, inp.help));
      return box;
    }

    if (inp.type === "textarea") {
      const ta = el("textarea", {
        class: compact ? "short" : "",
        placeholder: inp.displayDefault ? t("ws.eg", { x: inp.displayDefault }) : t("ws.prompt.ph"),
        value: values[inp.id] ?? "",
        oninput: () => { values[inp.id] = ta.value; },
      });
      fieldUpdaters.set(inp.id, () => { ta.value = String(values[inp.id] ?? ""); });
      box.append(lbl, ta);
    } else if (inp.type === "text") {
      const input = el("input", {
        type: "text",
        placeholder: inp.displayDefault ? t("ws.eg", { x: inp.displayDefault }) : "",
        value: values[inp.id] ?? "",
        oninput: () => { values[inp.id] = input.value; },
      });
      fieldUpdaters.set(inp.id, () => { input.value = String(values[inp.id] ?? ""); });
      box.append(lbl, input);
    } else if (inp.type === "slider" || inp.type === "number") {
      const min = inp.min ?? 0;
      const max = inp.max ?? 100;
      const step = inp.step ?? 1;
      const valNode = el("b", {}, String(values[inp.id] ?? min));
      const range = el("input", {
        type: "range", min: String(min), max: String(max), step: String(step),
        value: String(values[inp.id] ?? min),
        oninput: () => {
          const num = Number(range.value);
          values[inp.id] = num;
          valNode.textContent = String(num);
          range.style.setProperty("--p", `${clamp(((num - min) / Math.max(1e-6, max - min)) * 100, 0, 100)}%`);
        },
      });
      const sync = () => {
        const num = Number(values[inp.id] ?? min);
        range.value = String(num);
        valNode.textContent = String(num);
        range.style.setProperty("--p", `${clamp(((num - min) / Math.max(1e-6, max - min)) * 100, 0, 100)}%`);
      };
      sync();
      fieldUpdaters.set(inp.id, sync);
      box.append(el("div", { class: "range" }, el("div", { class: "top" }, el("span", {}, inp.label), valNode), range));
    } else if (inp.type === "seed") {
      const numIn = el("input", {
        type: "number", value: String(values[inp.id] ?? -1),
        oninput: () => { values[inp.id] = Number(numIn.value); },
      });
      const sync = () => { numIn.value = String(values[inp.id] ?? -1); };
      fieldUpdaters.set(inp.id, sync);
      box.append(lbl,
        el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
          numIn,
          el("button", {
            class: "btn small ghost", type: "button", title: t("ws.seed.random"),
            onclick: () => { values[inp.id] = -1; sync(); },
          }, icon("dice")),
          lastSeed !== null ? el("button", {
            class: "btn small ghost", type: "button",
            onclick: () => { values[inp.id] = lastSeed; sync(); },
          }, t("ws.seed.reuse")) : null));
    } else if (inp.type === "toggle") {
      const cb = el("input", {
        type: "checkbox", checked: Boolean(values[inp.id]),
        onchange: () => { values[inp.id] = cb.checked; },
      });
      fieldUpdaters.set(inp.id, () => { cb.checked = Boolean(values[inp.id]); });
      box.append(el("label", { class: "togrow" },
        el("span", { class: "t" }, el("span", {}, inp.label), inp.help ? el("small", {}, inp.help) : null),
        el("span", { class: "switch" }, cb, el("i"))));
      return box;
    } else if (inp.type === "select") {
      const opts = inp.options || [];
      const shortSeg = !inp.multiple && !inp.gallery && opts.length > 0 && opts.length <= 4
        && opts.every((o) => String(o.label).length <= 14);

      if (shortSeg) {
        const seg = el("div", { class: "seg" });
        const sync = () => {
          seg.replaceChildren(...opts.map((opt) => el("button", {
            type: "button",
            "aria-pressed": String(values[inp.id] === opt.value || String(values[inp.id]) === String(opt.value)),
            onclick: () => { values[inp.id] = opt.value; sync(); },
          }, opt.label)));
        };
        sync();
        fieldUpdaters.set(inp.id, sync);
        box.append(lbl, seg);
      } else {
        const valSpan = el("span", { class: "v" });
        const btn = el("button", {
          class: "selrow", type: "button",
          onclick: () => openSelectPopover(btn, inp, sync),
        }, valSpan, icon("chev"));
        const sync = () => {
          valSpan.textContent = selectDisplay(inp);
        };
        sync();
        fieldUpdaters.set(inp.id, sync);
        box.append(lbl, btn);
      }
    }

    if (inp.help) box.append(el("p", { class: "help" }, inp.help));
    return box;
  }

  function applyPreset(p) {
    presetId = presetId === p.id ? null : p.id;
    fieldUpdaters.get("__preset")?.();
  }

  function canRun() {
    if (session.bootstrap?.maintenance_mode && !session.user?.is_admin) {
      return { ok: false, reason: needNode(app) };
    }
    if (app.availability && !app.availability.supported) return { ok: false, reason: needNode(app) };
    if (app.status === "draft" && !draftsAllowed && !session.user?.is_admin) {
      return { ok: false, reason: el("span", {}, t("ws.draft")) };
    }
    const need = needNode(app);
    if (need) return { ok: false, reason: need };
    return { ok: true, reason: null };
  }

  async function submitRun() {
    if (submitting) return;
    const status = canRun();
    if (!status.ok) return;

    // Validate required fields client-side for immediate feedback
    for (const inp of app.inputs) {
      if (isFile(inp) && !files[inp.id]) {
        if (inp.required !== false) {
          toast(inp.paint ? t("paint.empty") : t("ws.need", { label: inp.label }), { error: true });
          return;
        }
      }
      if (!isFile(inp) && inp.required && !String(values[inp.id] ?? "").trim()) {
        toast(t("ws.needtext", { label: inp.label }), { error: true });
        return;
      }
    }

    submitting = true;
    try {
      for (let i = 0; i < count; i++) {
        const fd = new FormData();
        for (const inp of app.inputs) {
          if (isFile(inp)) {
            if (files[inp.id]) fd.append(inp.id, files[inp.id], files[inp.id].name);
          } else {
            const v = values[inp.id];
            if (v === undefined) continue;
            if (inp.multiple) fd.append(inp.id, JSON.stringify(Array.isArray(v) ? v : []));
            else fd.append(inp.id, String(v));
          }
        }
        if (presetId) fd.append("preset", presetId);
        if (selectedModelId) fd.append("model_id", selectedModelId);
        const entry = await feed.run(app.id, fd);
        if (entry.values?.seed != null) lastSeed = entry.values.seed;
      }
      refreshBootstrap().catch(() => {});
      toast(t("toast.started", { app: app.name }));
      if (activeTab !== "history") {
        activeTab = "history";
        drawMain();
      }
    } catch (err) {
      if (err.status === 401) {
        openAuthModal("login");
      }
      toast(err.message, { error: true });
    } finally {
      submitting = false;
    }
  }

  function modesSwitch() {
    if (!app.modes?.length) return null;
    return el("div", { class: "seg modes", role: "group", "aria-label": app.mode_label || "Mode" },
      ...app.modes.map((id) => {
        const other = byId.get(id);
        if (!other) return null;
        return el("button", {
          type: "button", "aria-pressed": String(id === app.id),
          onclick: () => { if (id !== app.id) location.hash = `#/app/${id}`; },
        }, icon(iconOf(other)), other.mode_label || other.name);
      }).filter(Boolean));
  }

  let syncRunUi = null;

  function generateButton({ wide = false } = {}) {
    const est = estimate(app);
    const runStatus = canRun();
    const billingOn = session.bootstrap?.credit_billing_enabled !== false;
    const costCredits = billingOn && Number(app.credit_cost) > 0 ? `${app.credit_cost} ${t("acc.cr")}` : null;
    const costLabel = [costCredits, est ? fmtSeconds(est.seconds) : null].filter(Boolean).join(" · ");
    const btn = el("button", {
      class: `generate${wide ? " wide" : ""}`, type: "button",
      disabled: !runStatus.ok,
      title: est ? t("ws.est", { s: fmtSeconds(est.seconds) }) : null,
      onclick: submitRun,
    },
    icon("spark"),
    t("ws.generate"),
    costLabel ? el("span", { class: "cost" }, costLabel) : null);
    btn._syncRun = (ok) => { btn.disabled = !ok; };
    return btn;
  }

  function countControl() {
    const num = el("span", {}, String(count));
    const dec = el("button", {
      type: "button", "aria-label": "-",
      onclick: () => { if (count > 1) { count--; sync(); } },
    }, "−");
    const inc = el("button", {
      type: "button", "aria-label": "+",
      onclick: () => { if (count < 4) { count++; sync(); } },
    }, "+");
    const sync = () => {
      num.textContent = String(count);
      dec.disabled = count <= 1;
      inc.disabled = count >= 4;
    };
    sync();
    return el("div", { class: "count", title: t("ws.count") }, dec, num, inc);
  }

  // ------------------------------------------------------------------ Composer layout (prompt-first image & audio)
  function buildComposer() {
    const pInp = promptInput(app);
    const fileInputs = app.inputs.filter(isFile);
    const primarySelects = app.inputs.filter((i) => !isFile(i) && i !== pInp && (i.type === "select" || i.gallery));
    const advInputs = app.inputs.filter((i) => !isFile(i) && i !== pInp && !primarySelects.includes(i));
    const ex = exampleItem(app);

    const ta = pInp ? el("textarea", {
      class: "cmp-prompt",
      placeholder: pInp.required ? t("ws.prompt.ph") : t("ws.prompt.opt", { label: pInp.label }),
      value: values[pInp.id] ?? "",
      oninput: () => { values[pInp.id] = ta.value; },
      onkeydown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submitRun(); } },
    }) : null;
    if (pInp) fieldUpdaters.set(pInp.id, () => { ta.value = String(values[pInp.id] ?? ""); });

    const attachRow = fileInputs.length ? el("div", { class: "cmp-attach" }) : null;
    if (attachRow) {
      const drawAttach = () => {
        attachRow.replaceChildren(...fileInputs.map((inp) => {
          const f = files[inp.id];
          const url = previews.get(inp.id);
          const fileIn = el("input", {
            type: "file", hidden: true,
            accept: inp.type === "video" ? "video/*" : inp.type === "audio" ? "audio/*" : "image/*",
            onchange: () => { if (fileIn.files?.[0]) setFile(inp.id, fileIn.files[0]); fileIn.value = ""; },
          });
          if (f && url) {
            return el("div", { class: "att" },
              inp.type === "video" ? el("video", { src: url, muted: true }) : el("img", { src: url, alt: f.name }),
              el("span", { class: "lbl" }, inp.label),
              el("button", { class: "x", type: "button", title: t("ws.remove"), onclick: () => setFile(inp.id, null) }, "×"));
          }
          return el("button", {
            class: "att need", type: "button", title: t("ws.add", { what: inp.label }),
            onclick: () => fileIn.click(),
          }, "+", el("span", { class: "lbl" }, inp.label), fileIn);
        }));
      };
      for (const inp of fileInputs) fieldUpdaters.set(inp.id, drawAttach);
      drawAttach();
    }

    const fam = familyOf(app);
    const modelBtn = el("button", {
      class: "chip model", type: "button",
      onclick: () => fam.length > 1 && openFamilyPicker(modelBtn),
    },
    el("span", { class: "thumb" }, ex ? thumb(ex, { play: "none" }) : icon(iconOf(app))),
    el("span", { class: "v" }, app.name),
    fam.length > 1 ? icon("chev") : null);

    const chips = [modelBtn, modesSwitch()];

    if (app.presets?.length) {
      const pVal = el("span", { class: "v" });
      const pBtn = el("button", {
        class: "chip", type: "button",
        onclick: () => popover(pBtn, el("div", {},
          el("h4", {}, t("ws.preset")),
          el("button", { class: "opt", type: "button", "aria-selected": String(!presetId), onclick: () => { presetId = null; closePopover(); syncPreset(); } }, t("ws.preset.none"), el("span", { class: "chk" }, icon("check"))),
          ...app.presets.map((p) => el("button", {
            class: "opt", type: "button", "aria-selected": String(presetId === p.id),
            onclick: () => { presetId = p.id; closePopover(); syncPreset(); },
          }, p.label, el("span", { class: "chk" }, icon("check")))))),
      }, el("span", { class: "k" }, t("ws.preset")), pVal, icon("chev"));
      const syncPreset = () => {
        const cur = app.presets.find((p) => p.id === presetId);
        pVal.textContent = cur ? cur.label : t("ws.preset.none");
        pBtn.classList.toggle("on", Boolean(cur));
      };
      syncPreset();
      fieldUpdaters.set("__preset", syncPreset);
      chips.push(pBtn);
    }

    for (const inp of primarySelects.slice(0, 4)) {
      const vSpan = el("span", { class: "v" });
      const cBtn = el("button", {
        class: "chip", type: "button",
        onclick: () => openSelectPopover(cBtn, inp, syncChip),
      }, el("span", { class: "k" }, inp.label), vSpan, icon("chev"));
      const syncChip = () => {
        vSpan.textContent = selectDisplay(inp);
        cBtn.classList.toggle("filled", Boolean(values[inp.id] && (!Array.isArray(values[inp.id]) || values[inp.id].length)));
      };
      syncChip();
      fieldUpdaters.set(inp.id, syncChip);
      chips.push(cBtn);
    }

    if (app.available_models?.length > 1) {
      const mVal = el("span", { class: "v" });
      const mBtn = el("button", {
        class: "chip", type: "button",
        onclick: () => popover(mBtn, el("div", {},
          el("h4", {}, t("how.primary_model")),
          ...app.available_models.map((m) => el("button", {
            class: "opt", type: "button", "aria-selected": String(selectedModelId === m.id),
            onclick: () => { selectedModelId = m.id; closePopover(); syncModel(); },
          }, m.name, el("span", { class: "chk" }, icon("check")))))),
      }, el("span", { class: "k" }, t("ws.model")), mVal, icon("chev"));
      const syncModel = () => {
        const cur = app.available_models.find((m) => m.id === selectedModelId) || app.available_models[0];
        mVal.textContent = cur ? cur.name : "Default";
      };
      syncModel();
      chips.push(mBtn);
    }

    const extraAdv = [...primarySelects.slice(4), ...advInputs];
    if (extraAdv.length) {
      const advBtn = el("button", {
        class: "chip square", type: "button", title: t("ws.advanced"), "aria-label": t("ws.advanced"),
        onclick: () => popover(advBtn, el("div", { class: "pad", style: { width: "320px" } },
          el("h4", { style: { margin: 0 } }, t("ws.advanced")),
          ...extraAdv.map((i) => renderFieldControl(i, { compact: true })))),
      }, icon("sliders"));
      chips.push(advBtn);
    }

    const runStatus = canRun();
    const genBtn = generateButton();
    const hint = el("div", { class: "cmp-hint err", hidden: !runStatus.reason }, runStatus.reason);
    syncRunUi = () => {
      const next = canRun();
      genBtn._syncRun(next.ok);
      hint.hidden = !next.reason;
      hint.replaceChildren(...(next.reason ? [next.reason] : []));
    };

    const composer = el("div", { class: "composer" },
      el("div", { class: "cmp-top" }, attachRow, ta),
      el("div", { class: "cmp-row" }, ...chips.filter(Boolean), el("span", { class: "grow" }), countControl(), genBtn),
      hint);

    composer.addEventListener("dragover", (e) => { e.preventDefault(); composer.classList.add("drag"); });
    composer.addEventListener("dragleave", () => composer.classList.remove("drag"));
    composer.addEventListener("drop", (e) => {
      e.preventDefault();
      composer.classList.remove("drag");
      const f = e.dataTransfer.files?.[0];
      if (f && fileInputs[0]) setFile(fileInputs[0].id, f);
    });

    return composer;
  }

  // ------------------------------------------------------------------ Sidebar layout (video & tools)
  function buildSidebar() {
    const ex = exampleItem(app);
    const fam = familyOf(app);
    const vTab = videoTabOf(app.id);

    const sideTabs = vTab ? el("div", { class: "side-tabs" }, ...VIDEO_TABS.map((tab) =>
      el("button", {
        type: "button", "aria-selected": String(tab.id === vTab),
        onclick: () => { if (tab.apps[0]) location.hash = `#/app/${tab.apps[0]}`; },
      }, t(`vtab.${tab.id}`)))) : null;

    const modelCard = el("div", {
      class: "model-card", tabindex: "0", role: "button",
      onclick: () => fam.length > 1 && openFamilyPicker(modelCard),
      onkeydown: (e) => { if (e.key === "Enter" && fam.length > 1) openFamilyPicker(modelCard); },
    },
    ex ? thumb(ex, { play: "hover" }) : el("div", { class: "media" }),
    fam.length > 1 ? el("span", { class: "change" }, t("ws.change"), icon("chev")) : null,
    el("div", { class: "txt" },
      el("h3", { class: "display" }, app.name),
      el("p", {}, tagline(app))));
    hoverPlay(modelCard, modelCard.querySelector("video"));

    const primary = [];
    const advanced = [];
    for (const inp of app.inputs) {
      if (isFile(inp) || inp.required || inp.type === "textarea" || inp.gallery) primary.push(inp);
      else advanced.push(inp);
    }

    const presetField = app.presets?.length ? (() => {
      const seg = el("div", { class: "seg" });
      const sync = () => {
        seg.replaceChildren(
          el("button", { type: "button", "aria-pressed": String(!presetId), onclick: () => { presetId = null; sync(); } }, t("ws.preset.none")),
          ...app.presets.map((p) => el("button", {
            type: "button", "aria-pressed": String(presetId === p.id),
            onclick: () => applyPreset(p),
          }, p.label)));
      };
      sync();
      fieldUpdaters.set("__preset", sync);
      return el("div", { class: "field" }, el("div", { class: "lbl" }, t("ws.preset")), seg);
    })() : null;

    const modelPickerField = app.available_models?.length > 1 ? (() => {
      const sel = el("select", {
        style: {
          width: "100%", height: "38px", padding: "0 10px", borderRadius: "10px",
          background: "#0f0f11", border: "1px solid #2a2a2f", color: "var(--ink)", font: "inherit",
        },
        onchange: () => { selectedModelId = sel.value; },
      }, ...app.available_models.map((m) => el("option", { value: m.id, selected: m.id === selectedModelId }, m.name)));
      return el("div", { class: "field" }, el("div", { class: "lbl" }, t("ws.model")), sel);
    })() : null;

    const advDetails = advanced.length ? el("details", { class: "adv" },
      el("summary", {}, t("ws.advanced"), icon("chev")),
      el("div", { class: "in" }, ...advanced.map((i) => renderFieldControl(i)))) : null;

    const runStatus = canRun();
    const genBtn = generateButton({ wide: true });
    const noteEl = el("p", { class: "side-note err", hidden: !runStatus.reason }, runStatus.reason);
    syncRunUi = () => {
      const next = canRun();
      genBtn._syncRun(next.ok);
      noteEl.hidden = !next.reason;
      noteEl.replaceChildren(...(next.reason ? [next.reason] : []));
    };

    return el("aside", { class: "side" },
      sideTabs,
      el("div", { class: "side-scroll" },
        modelCard,
        modesSwitch(),
        modelPickerField,
        ...primary.map((i) => renderFieldControl(i)),
        presetField,
        advDetails),
      el("div", { class: "side-foot" },
        el("div", { class: "row" }, countControl(), genBtn),
        noteEl));
  }

  // ------------------------------------------------------------------ Main area (History / Lab Example / How it works)
  let stopFeed = null;

  function emptyHistoryState() {
    const ex = exampleItem(app);
    if (layout === "composer") {
      return el("div", { class: "feed-empty" },
        el("div", {},
          el("div", { class: "glass" }, icon(iconOf(app))),
          el("h2", { class: "display" }, t("ws.create.title"), el("span", {}, app.name)),
          el("p", {}, app.summary || tagline(app)),
          ex ? el("button", { class: "ex", type: "button", onclick: () => applyExample(ex) },
            thumb(ex, { play: "none" }),
            el("div", {}, el("b", {}, t("ws.example")), el("small", {}, t("ws.useex")))) : null));
    }

    return el("div", { class: "ws-hero" },
      el("div", {},
        el("h1", { class: "display" }, app.name),
        el("p", {}, app.summary || tagline(app)),
        el("div", { class: "row" },
          ex ? el("button", { class: "btn lime", type: "button", onclick: () => applyExample(ex) }, icon("spark"), t("ws.useex")) : null,
          el("button", { class: "btn ghost", type: "button", onclick: () => { activeTab = "how"; drawMain(); } }, t("ws.how")))),
      ex ? el("div", { class: "flow" },
        ex.inputs?.length ? el("div", { class: "ins" }, ...ex.inputs.slice(0, 2).map((inp) =>
          el("div", { class: "media" }, inp.play
            ? el("video", { src: `${inp.play}#t=0.1`, muted: true, preload: "metadata" })
            : el("img", { src: inp.thumb || inp.file, alt: inp.label })))) : null,
        ex.inputs?.length ? el("span", { class: "arrow" }, icon("arrow")) : null,
        el("div", { class: "out" }, thumb(ex, { play: "visible" }))) : null);
  }

  async function applyExample(ex) {
    if (!ex) return;
    Object.assign(values, ex.values || {});
    if (ex.seed != null && app.inputs.some((i) => i.id === "seed")) values.seed = ex.seed;
    for (const fn of fieldUpdaters.values()) fn();
    if (ex.inputs?.length) {
      await Promise.all(ex.inputs.map(async (inp) => {
        if (!inp.file) return;
        try {
          const f = await fetchAsFile(inp.file, inp.id);
          setFile(inp.id, f);
        } catch { /* ignore */ }
      }));
    }
    toast(t("toast.loaded", { app: app.name }));
  }

  function renderLabTab() {
    const ex = exampleItem(app);
    if (!ex) return el("div", { class: "empty" }, t("explore.noex"));
    const labelMap = Object.fromEntries(app.inputs.map((i) => [i.id, i.label]));
    const vals = Object.entries(ex.values || {});
    return el("div", { class: "ex-big" },
      el("div", { class: "stage" },
        ex.type === "video"
          ? el("video", { src: ex.full, poster: ex.poster, controls: true, loop: true, playsinline: true })
          : ex.type === "audio"
            ? el("div", { class: "audio-box" }, el("audio", { src: ex.full, controls: true }))
            : el("img", { src: ex.full, alt: app.name })),
      el("div", { class: "side2" },
        el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
          el("button", { class: "btn lime", type: "button", onclick: () => applyExample(ex) }, icon("spark"), t("ws.useex")),
          flagButton(flags.key(app.id))),
        ex.inputs?.length ? el("div", { class: "ins-row" }, ...ex.inputs.map((inp) =>
          el("figure", {},
            el("div", { class: "media" }, inp.play
              ? el("video", { src: `${inp.play}#t=0.1`, muted: true, preload: "metadata" })
              : el("img", { src: inp.thumb || inp.file, alt: inp.label })),
            el("figcaption", {}, inp.label)))) : null,
        vals.length ? el("dl", { class: "vals" }, ...vals.flatMap(([k, v]) => [
          el("dt", {}, labelMap[k] || k),
          el("dd", {}, Array.isArray(v) ? v.join(", ") : String(v)),
        ])) : null));
  }

  function renderHowTab() {
    const a = app.availability || {};
    const filteredCredits = (app.credits || []).filter((c) => !/comfy|higgsfield|kijai/i.test(String(c)));
    const statusLabel = !a.supported
      ? t("tag.unsupported")
      : a.available
        ? t("status.ready")
        : t("tag.unavailable");

    return el("div", { class: "how-grid" },
      el("div", { class: "card" },
        el("h3", {}, icon("layers"), t("how.pipeline")),
        el("p", {}, t("how.pipeline.d", { name: app.name })),
        el("dl", { class: "vals" },
          el("dt", {}, t("how.capability")), el("dd", {}, a.capability || app.section),
          el("dt", {}, t("how.primary_model")), el("dd", {}, a.modelName || app.name),
          el("dt", {}, t("how.credit_cost")), el("dd", {}, `${app.credit_cost ?? 1} ${t("acc.cr")}`),
          el("dt", {}, t("how.status")), el("dd", {}, statusLabel)),
        a.reason ? el("p", {}, a.reason) : null),

      el("div", { class: "card" },
        el("h3", {}, icon("chip"), t("how.models")),
        app.available_models?.length
          ? el("table", { class: "models" }, ...app.available_models.map((m) => el("tr", {},
            el("td", {}, el("div", {}, m.name)),
            el("td", { class: "r" }, `${m.credit_price} ${t("acc.cr")}`))))
          : app.models?.length
            ? el("table", { class: "models" }, ...app.models.map((m) => el("tr", {},
              el("td", {},
                el("div", {}, m.name),
                m.license || m.optional
                  ? el("small", { class: "dim" }, [m.license, m.optional ? t("how.optional") : null].filter(Boolean).join(" · "))
                  : null),
              el("td", { class: "r" }, m.phase || ""))))
            : el("p", {}, t("fit.none"))),

      el("div", { class: "card" },
        el("h3", {}, icon("sliders"), t("how.settings")),
        el("dl", { class: "vals" },
          el("dt", {}, t("how.inputs")), el("dd", {}, String(app.inputs.length)),
          el("dt", {}, t("ws.preset")), el("dd", {}, String(app.presets?.length ?? 0))),
        filteredCredits.length ? el("div", {},
          el("h3", { style: { marginTop: "6px" } }, t("how.credits")),
          ...filteredCredits.map((c) => el("p", {}, c))) : null,
        app.notes ? el("p", {}, el("b", {}, `${t("how.notes")}: `), app.notes) : null));
  }

  function drawMain() {
    stopFeed?.();
    stopFeed = null;

    const tabs = el("div", { class: "tabs" }, ...[
      ["history", t("ws.history")],
      ["lab", t("ws.library")],
      ["how", t("ws.how")],
    ].map(([id, label]) => el("button", {
      type: "button", "aria-selected": String(activeTab === id),
      onclick: () => { activeTab = id; drawMain(); },
    }, label)));

    const right = activeTab === "history" ? el("div", { class: "right" },
      el("label", { style: { display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "12.5px", color: "var(--dim)", cursor: "pointer" } },
        t("ws.dense"),
        el("span", { class: "switch" },
          el("input", { type: "checkbox", checked: dense, onchange: (e) => { dense = e.target.checked; drawMain(); } }),
          el("i")))) : null;

    const top = el("div", { class: "ws-top" }, tabs, right);
    const content = el("div", { style: { flex: 1, display: "flex", flexDirection: "column" } });

    if (activeTab === "history") {
      stopFeed = feedView(content, { app: app.id, empty: () => emptyHistoryState(), dense });
    } else if (activeTab === "lab") {
      content.replaceChildren(renderLabTab());
    } else {
      content.replaceChildren(renderHowTab());
    }

    mainBody.replaceChildren(top, content);
  }

  drawMain();
  cleanups.push(() => stopFeed?.());

  const onSessionChange = () => {
    syncRunUi?.();
    if (activeTab === "how") drawMain();
  };
  session.listeners.add(onSessionChange);
  cleanups.push(() => session.listeners.delete(onSessionChange));

  // Hydrate any pending files (recreate / useIn / example)
  if (loadJob?.inputs?.length) {
    Promise.all(loadJob.inputs.map(async (inp) => {
      if (!inp.file) return;
      try {
        const f = await fetchAsFile(inp.file, inp.name || inp.id);
        setFile(inp.id, f);
      } catch { /* ignore */ }
    })).then(() => {
      if (loadJob.run) submitRun();
    });
  } else if (loadJob?.run) {
    queueMicrotask(() => submitRun());
  }

  // Paste image support on the workspace
  const onPaste = (e) => {
    const fileItem = [...(e.clipboardData?.items || [])].find((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (!fileItem) return;
    const targetInput = app.inputs.find((i) => i.type === "image" && !i.paint);
    if (!targetInput) return;
    const f = fileItem.getAsFile();
    if (f) setFile(targetInput.id, f);
  };
  document.addEventListener("paste", onPaste);
  cleanups.push(() => document.removeEventListener("paste", onPaste));

  const root = layout === "composer"
    ? el("div", { class: "ws l-composer" },
      el("div", { class: "ws-main" }, mainBody),
      buildComposer())
    : el("div", { class: "ws l-sidebar" },
      buildSidebar(),
      el("div", { class: "ws-main" }, mainBody));

  return {
    node: root,
    app,
    dispose: () => cleanups.forEach((fn) => fn()),
  };
}
