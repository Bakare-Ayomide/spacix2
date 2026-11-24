// Shared DOM helpers, icons, API fetch wrapper, toasts, popovers, masonry, and formatting.
// Must NOT import i18n.js (i18n.js imports store from here).

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`ff.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ff.${key}`, JSON.stringify(value));
    } catch { /* ignore quota or private mode errors */ }
  },
};

export const live = { gpuWarm: false };

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function extOf(url) {
  if (!url) return "";
  const clean = String(url).split(/[?#]/)[0];
  const m = /\.([a-z0-9]{1,8})$/i.exec(clean);
  return m ? m[1].toLowerCase() : "";
}

function units() {
  const code = (typeof document !== "undefined" ? document.documentElement?.lang : "en") || "en";
  if (code === "ru") return { s: "с", min: "мин" };
  return { s: "s", min: "min" };
}

export function fmtSeconds(seconds) {
  const n = Number(seconds);
  if (seconds === null || seconds === undefined || !Number.isFinite(n)) return "";
  const u = units();
  const total = Math.max(0, Math.round(n));
  if (total < 60) return `${total} ${u.s}`;
  const m = Math.floor(total / 60);
  const rem = total % 60;
  return `${m} ${u.min} ${String(rem).padStart(2, "0")} ${u.s}`;
}

export function fmtShort(seconds) {
  const n = Number(seconds);
  if (seconds === null || seconds === undefined || !Number.isFinite(n)) return "";
  const u = units();
  const total = Math.max(0, Math.round(n));
  if (total < 60) return `~${total} ${u.s}`;
  return `~${Math.round(total / 60)} ${u.min}`;
}

const BOOL_ATTRS = new Set([
  "hidden", "disabled", "controls", "loop", "muted", "autoplay",
  "playsinline", "disablepictureinpicture", "required", "checked", "selected", "open",
]);

function appendChild(parent, child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
  } else if (child instanceof Node) {
    parent.append(child);
  } else {
    parent.append(document.createTextNode(String(child)));
  }
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === "class" || k === "className") {
        node.className = v;
      } else if (k === "style" && typeof v === "object") {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv === null || sv === undefined) continue;
          if (sk.startsWith("--")) node.style.setProperty(sk, String(sv));
          else node.style[sk] = sv;
        }
      } else if (k === "dataset" && typeof v === "object") {
        for (const [dk, dv] of Object.entries(v)) {
          if (dv !== null && dv !== undefined) node.dataset[dk] = String(dv);
        }
      } else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (BOOL_ATTRS.has(k)) {
        if (v) {
          node.setAttribute(k, "");
          if (k in node) node[k] = true;
        } else {
          node.removeAttribute(k);
          if (k in node) node[k] = false;
        }
      } else if (k === "value" && ("value" in node)) {
        node.value = String(v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  for (const child of children) appendChild(node, child);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = {
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  redo: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
  compare: '<path d="M12 3v18"/><rect x="3" y="6" width="6" height="12" rx="1.5"/><rect x="15" y="6" width="6" height="12" rx="1.5"/>',
  upload: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 20h14"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  mute: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  swap: '<path d="M16 3l4 4-4 4"/><path d="M20 7H4"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h16"/>',
  thumbdown: '<path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  spark: '<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z"/>',
  video: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-4 4-3-3-6 5"/>',
  layers: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 12l10 5 10-5"/><path d="M2 17l10 5 10-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><polygon points="16.2 7.8 14.1 14.1 7.8 16.2 9.9 9.9 16.2 7.8"/>',
  film: '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18M17 3v18M2 9h5M2 15h5M17 9h5M17 15h5"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3a14 14 0 0 0 0 18M12 3a14 14 0 0 1 0 18"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  code: '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3.3 8.2L12 13l8.7-4.8"/><path d="M12 22V13"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v4M14 10V4a2 2 0 0 0-4 0v6M10 10V5a2 2 0 0 0-4 0v9"/><path d="M18 11a2 2 0 0 1 4 0v3a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8v-2a2 2 0 0 1 4 0"/>',
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `i i-${name}`);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] ?? ICONS.spark;
  return svg;
}

export function logoMark() {
  return el("img", {
    class: "mark",
    src: "https://spacix.ticketplaster.com/brand/logo.png",
    alt: "SPACIX",
    decoding: "async",
  });
}

export async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

let toastHost = null;
export function toast(message, { error = false, duration = 3500 } = {}) {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const node = el("div", { class: `toast${error ? " err" : ""}` }, message);
  toastHost.append(node);
  setTimeout(() => node.remove(), duration);
}

let activePopover = null;

export function closePopover() {
  if (!activePopover) return;
  activePopover.cleanup();
  activePopover = null;
}

export function popover(anchor, content, { align = "start", wide = false } = {}) {
  if (activePopover?.anchor === anchor) {
    closePopover();
    return null;
  }
  closePopover();
  const pop = el("div", { class: `pop${wide ? " wide" : ""}` }, content);
  document.body.append(pop);

  const position = () => {
    const ar = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const pad = 10;
    let left = align === "end" ? ar.right - pr.width : ar.left;
    left = clamp(left, pad, Math.max(pad, window.innerWidth - pr.width - pad));
    let top = ar.bottom + 6;
    if (top + pr.height > window.innerHeight - pad && ar.top - pr.height - 6 >= pad) {
      top = ar.top - pr.height - 6;
    }
    top = clamp(top, pad, Math.max(pad, window.innerHeight - pr.height - pad));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  };
  position();
  requestAnimationFrame(position);

  const onPointerDown = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    closePopover();
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePopover();
      anchor.focus?.();
    }
  };
  const onScroll = () => position();

  setTimeout(() => {
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onScroll);
  }, 0);

  activePopover = {
    anchor,
    node: pop,
    cleanup: () => {
      pop.remove();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onScroll);
    },
  };
  return pop;
}

export function masonry(host, nodes, { min = 270, gap = 12 } = {}) {
  host._ro?.disconnect();
  const build = () => {
    const width = host.clientWidth || window.innerWidth;
    const count = Math.max(1, Math.floor((width + gap) / (min + gap)));
    if (host._cols === count && host._masonryNodes === nodes) return;
    host._cols = count;
    host._masonryNodes = nodes;
    const cols = Array.from({ length: count }, () => el("div", { class: "col" }));
    nodes.forEach((n, idx) => cols[idx % count].append(n));
    const wrap = el("div", { class: "masonry" }, ...cols);
    host.replaceChildren(wrap);
  };
  build();
  const ro = new ResizeObserver(() => build());
  ro.observe(host);
  host._ro = ro;
}
