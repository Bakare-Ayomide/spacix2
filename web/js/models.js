// Per-app studio availability notices for regular users.
// Never polls or exposes provider credentials, endpoints, or backend infrastructure.
import { el, session } from "./util.js";
import { t } from "./i18n.js";

/** Badge shown on catalog cards when an app is unavailable or requires an upgrade. */
export function needTag(app) {
  const a = app.availability;
  if (!a) return null;
  if (!a.supported) {
    return el("span", { class: "tag dark need-unsupported", title: a.reason || t("ws.unsupported") }, t("tag.unsupported"));
  }
  if (!a.available) {
    return el("span", { class: "tag dark need-unsupported", title: a.reason || t("ws.provider.unconfigured") }, t("tag.unavailable"));
  }
  return null;
}

export function needText(app) {
  const a = app.availability;
  if (!a) return "";
  if (!a.supported) return a.reason || t("ws.unsupported");
  if (!a.available) return a.reason || t("ws.provider.unconfigured");
  return "";
}

/** Inline notice inside the workspace when generation cannot currently run. */
export function needNode(app) {
  const b = session.bootstrap;
  if (b?.maintenance_mode && !session.user?.is_admin) {
    return el("span", {}, b.maintenance_message || t("ws.maintenance"));
  }
  const a = app.availability;
  if (!a) return null;
  if (!a.supported) {
    return el("span", {}, a.reason || t("ws.unsupported"));
  }
  if (!a.available) {
    return el("span", {}, a.reason || t("ws.provider.unconfigured"));
  }
  return null;
}
