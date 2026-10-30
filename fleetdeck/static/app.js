"use strict";

const state = { targets: [], errors: {}, settings: {}, backupPlaces: {}, jobs: [], schedule: null, selected: new Set(), expanded: new Set(), containerExpanded: new Set(), logJob: null, logLines: [], showHidden: false, view: "machines", filter: null };
const mobileDashboard = matchMedia("(max-width: 1399px)");
const $ = (sel) => document.querySelector(sel);
const renderedHTML = new WeakMap();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PLATFORM = { proxmox: "Proxmox", incus: "Incus", ssh: "Standalone", demo: "Demo" };
const KIND = { host: "Host", lxc: "LXC", vm: "VM", container: "Container" };
const ICON = {
  boxes: '<path d="m12 3 4 2.3v4.6L12 12 8 9.9V5.3L12 3Z"/><path d="m8 10-5 3v5l5 3 4-2.5V14l-4-4Zm8 0 5 3v5l-5 3-4-2.5V14l4-4Z"/>',
  external: '<path d="M15 3h6v6M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  monitor: '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  reboot: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  refresh: '<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  backup: '<path d="M3 6h18"/><path d="M19 6v14H5V6"/><path d="M8 3h8l1 3H7Z"/><path d="M9 11h6"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  eye: '<path d="M2.1 12a10.8 10.8 0 0 1 19.8 0 10.8 10.8 0 0 1-19.8 0Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="m3 3 18 18"/><path d="M10.6 10.6A2 2 0 0 0 13.4 13.4"/><path d="M9.9 4.2A10.7 10.7 0 0 1 21.9 12a10.5 10.5 0 0 1-2.1 3.1"/><path d="M6.2 6.2A10.8 10.8 0 0 0 2.1 12a10.8 10.8 0 0 0 12 7.8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
  backupJob: '<path d="M8 2v4"/><path d="M16 2v4"/><path d="M21 11V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/><path d="M3 10h18"/><circle cx="17" cy="17" r="5"/><path d="M17 14v3l2 1"/>',
  noBackup: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  tag: '<path d="M20 13 13 20a2 2 0 0 1-3 0L2 12V2h10l8 8a2 2 0 0 1 0 3Z"/><path d="M7 7h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4"/><path d="M12 17h.01"/>',
  alert: '<path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};
const icon = (name) => `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
const plural = (count, one, many) => count === 1 ? one : many;
const kindLabel = (t) => t.kind === "host" && t.platform === "proxmox" ? "Node" : KIND[t.kind] || t.kind;
const isProxmox = (t) => t.platform === "proxmox";
const isProxmoxNode = (t) => t.kind === "host" && t.platform === "proxmox";
// Status dot: Proxmox says online/offline for nodes, running/stopped for guests; anything else is grey.
const DOT = { running: "on", online: "on", stopped: "off", offline: "off" };

// Per-browser conveniences only; the hidden machines themselves are kept on the server.
const remember = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ } },
};
state.containerFilters = Object.create(null);
state.showHidden = !!remember.get("showHidden");
state.view = remember.get("dashboardView") === "containers" ? "containers" : "machines";
// Hidden machines stay out of the counts, Check all and Update selected, even while shown.
const active = () => state.targets.filter((v) => !v.hidden);

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 604800) return `${Math.round(s / 86400)} d ago`;
  return `${Math.round(s / 604800)} w ago`;
}

function until(iso) {
  const s = Math.round((new Date(iso) - Date.now()) / 1000);
  if (s < 60) return "in under a minute";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} d`;
}

function every(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400} d`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  return `${Math.round(seconds / 60)} min`;
}

function scheduleStat() {
  const sc = state.schedule;
  if (!sc?.check_every) return "Automatic checks off";
  const next = sc.next_run ? until(sc.next_run) : "running now";
  const notify = sc.notify_targets ? `notifies ${sc.notify_targets} target${sc.notify_targets > 1 ? "s" : ""}` : "no notifications set up";
  return `<span class="schedule-next" title="Every ${every(sc.check_every)}; ${notify}">${icon("clock")}Next check ${next}</span>`;
}

function groupKey(t) {
  if (t.platform === "ssh") return "ssh";
  return `${t.platform}:${t.source}:${t.parent || t.name}`;
}

function groups() {
  const map = new Map();
  for (const v of state.showHidden ? state.targets : active()) {
    const k = groupKey(v.target);
    if (!map.has(k)) map.set(k, { key: k, platform: v.target.platform, title: v.target.platform === "ssh" ? "Standalone hosts" : v.target.parent || v.target.name, rows: [] });
    map.get(k).rows.push(v);
  }
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  for (const g of map.values()) g.rows.sort((a, b) => Number(b.target.kind === "host") - Number(a.target.kind === "host") || compare(a.target.name, b.target.name) || compare(a.target.id, b.target.id));
  const order = { proxmox: 0, incus: 1, ssh: 2, demo: 3 };
  return [...map.values()].sort((a, b) => (order[a.platform] ?? 4) - (order[b.platform] ?? 4) || compare(a.title, b.title) || compare(a.key, b.key));
}

const canUpgrade = (t) => t.updatable && !t.check_only;
const phasedPackages = (check) => check?.packages?.filter((p) => p.phased) || [];
const actionablePackages = (check) => check?.packages?.filter((p) => !p.phased) || [];
const securityPackages = (check) => actionablePackages(check).filter((p) => p.security);
const regularPackages = (check) => actionablePackages(check).filter((p) => !p.security);
const displayCheck = (v) => v.check?.error ? v.check.last_successful : v.check;
const staleCheck = (v) => !!displayCheck(v) && (!v.target.updatable || !!v.check?.error);
const needsRecheck = (v) => !v.target.updatable || !v.check || !!v.check.error;
function matchesKpi(v, filter) {
  if (!filter) return true;
  if (v.hidden) return false;
  if (filter === "recheck") return needsRecheck(v);
  if (filter === "updates") return actionablePackages(displayCheck(v)).length > 0;
  if (filter === "security") return securityPackages(displayCheck(v)).length > 0;
  if (needsRecheck(v)) return false;
  if (filter === "reboot") return v.check.reboot_required === true;
  return true;
}
const selectable = (v) => canUpgrade(v.target) && !v.check?.error && actionablePackages(v.check).length > 0 && !v.hidden && !v.blocked && !v.active_job && !v.monitor_only;
const MONITOR_TIP = "Monitor only: checked and reported; updates are installed elsewhere. Reboots, backups and snapshots remain available.";
const canReboot = (t) => canUpgrade(t) && !t.no_reboot;
const BUSY = { upgrade: "updating", check: "checking", reboot: "rebooting", rollback: "rolling back", backup: "backing up", stacks: "checking Docker", "stack-update": "updating Docker" };

function metricButton(v, kind, count) {
  if (!displayCheck(v)?.packages?.length) return "";
  const id = esc(v.target.id), open = state.expanded.has(v.target.id);
  const label = { security: "security", package: "package", phased: "phased" }[kind];
  const iconName = { security: "shield", package: "package", phased: "clock" }[kind];
  const metric = count ? `<span class="update-metric ${kind}${staleCheck(v) ? " stale" : ""}" title="${count} ${label} update${count === 1 ? "" : "s"}">${icon(iconName)}<span>${count}</span></span>` : "";
  const caption = count ? `${count} ${label} update${count === 1 ? "" : "s"}${staleCheck(v) ? " from the last successful check" : ""}; ` : "";
  return `<button class="update-list-hit" data-toggle="${id}" data-focus-key="updates:${id}:${kind}" aria-expanded="${open}" aria-controls="packages-${id}" aria-label="${caption}${open ? "Hide" : "Show"} package list for ${esc(v.target.name)}">${metric}</button>`;
}

function updateColumns(v) {
  const c = displayCheck(v);
  const security = securityPackages(c).length;
  const regular = regularPackages(c).length;
  const phased = phasedPackages(c).length;
  return `<td class="update-metric-cell section-start" data-label="Security">${metricButton(v, "security", security)}</td><td class="update-metric-cell" data-label="Package">${metricButton(v, "package", regular)}</td><td class="update-metric-cell" data-label="Phased">${metricButton(v, "phased", phased)}</td>`;
}

function updateState(v) {
  const t = v.target, c = v.check;
  const busy = !!v.active_job;
  if (busy) {
    return `<span class="status-inline muted"><span class="spin"></span>${esc(BUSY[v.active_job.action] || v.active_job.action)}…</span>`;
  }
  if (!t.updatable) {
    const stopped = t.status === "stopped" || t.note?.toLowerCase() === "not running";
    const offline = t.status === "offline";
    const label = stopped ? "Not running" : offline ? "Offline" : t.note || "Unavailable";
    return `<span class="status-inline unavailable" title="${esc(t.note || label)}">${icon(stopped || offline ? "power" : "alert")}${esc(label)}</span>`;
  }
  if (!c) return `<span class="status-inline muted">${icon("help")}Not checked</span>`;
  if (c.error) return `<span class="status-inline bad" title="${esc(c.error)}">${icon("alert")}Check failed</span>`;
  const pending = actionablePackages(c).length > 0;
  if (pending) return `<span class="status-inline updates-available">${icon("package")}Updates available</span>`;
  if (!pending) return `<span class="status-inline ok">${icon("check")}Up to date</span>`;
  return "";
}

function nextAction(v) {
  const t = v.target, c = v.check, id = esc(t.id);
  if (!t.updatable || v.active_job) return "";
  if (!c || c.error) return `<button class="small" data-act="check" data-id="${id}" data-focus-key="check:${id}">${icon("refresh")}<span>${c?.error ? "Retry" : "Check"}</span></button>`;
  if (actionablePackages(c).length && canUpgrade(t) && !v.monitor_only) return `<button class="small primary" data-act="upgrade" data-id="${id}" data-focus-key="upgrade:${id}" ${v.blocked ? "disabled" : ""} title="${esc(v.blocked || "Install available OS packages")}">${icon("download")}<span>Update</span></button>`;
  if (c.reboot_required && canReboot(t)) return `<button class="small reboot-action" data-act="reboot" data-id="${id}" data-focus-key="reboot:${id}" ${v.blocked ? "disabled" : ""} title="${esc(v.blocked || "Reboot required — reboot this machine")}">${icon("reboot")}<span>Reboot</span></button>`;
  return "";
}

function compactOS(os) {
  return String(os || "").replace(/^Debian GNU\/Linux /, "Debian ").replace(/^Proxmox VE /, "PVE ").replace(/\s*\([^)]*\)/g, "").replace(/ LTS$/, "");
}

function backupCell(t) {
  const b = t.backup;
  if (!b) return isProxmoxNode(t) ? "" : `<span class="backup-missing muted" aria-label="Backup information unavailable">—</span>`;
  if (b.last) {
    return `<span class="${b.stale ? "warn" : ""}" title="${esc(window.FleetdeckDates.dateTime(b.last))}">${ago(b.last)}</span>`;
  }
  if (isProxmoxNode(t)) {
    // Proxmox node configuration-backup context is available from the neutral information popover.
    return "";
  }
  const label = b.note && !b.stale && !b.not_set_up ? "Backup information unavailable" : "No backup found";
  return `<span class="backup-missing muted" aria-label="${label}">—</span>`;
}

function backupJobCell(t) {
  if (!t.backup || isProxmoxNode(t) || t.backup.in_job !== true) return "";
  return `<span class="backup-job muted" role="img" aria-label="Covered by a backup job">${icon("backupJob")}</span>`;
}

function machineInfoButton(t, c) {
  const id = esc(t.id);
  return `<button class="small ghost machine-info-trigger" data-machine-info="${id}" data-focus-key="machine-info:${id}" aria-label="Information for ${esc(t.name)}" aria-controls="machine-information" aria-expanded="false">${icon("info")}</button>`;
}

function csTip(app) {
  return `Installed by the community-scripts helper script for ${app}. ` + (state.settings.community_scripts_update
    ? `Updating it also runs ${app}'s own update afterwards (like typing "update" in it), which keeps the app working.`
    : `Its own update is turned off (community_scripts_update), so after an OS update run "update" inside it if ${app} misbehaves.`);
}

const dockerSettings = (v) => v.docker_settings || { mode: "managed", manager_name: "Dockhand", manager_url: null };
const containersVisible = () => !!(state.settings.docker_enabled || state.settings.containers_visible);
const dockerEnabled = (v) => !!state.settings.docker_enabled && ["managed", "monitor"].includes(dockerSettings(v).mode);
const hasDocker = (v) => containersVisible() && (!!v.dockhand || (state.settings.docker_enabled && (v.check?.docker_installed === true || (v.stacks && v.stacks.docker !== "none") || dockerSettings(v).mode !== "managed")));
const dockerHosts = () => active().filter(hasDocker).sort((a, b) => a.target.name.localeCompare(b.target.name, undefined, { numeric: true }) || a.target.id.localeCompare(b.target.id));
const dockerBehind = (v) => dockerEnabled(v) ? (v.stacks?.stacks || []).filter((s) => !s.error && s.update_available && s.state !== "stopped").length : 0;
const dockerErrors = (v) => !dockerEnabled(v) ? 0 : v.stacks?.error && v.stacks.docker !== "none" ? 1 : (v.stacks?.stacks || []).filter((s) => s.error).length;
function managerLink(v, label) {
  if (v.dockhand?.simulated) return '<span class="chip">Simulated Dockhand</span>';
  const url = dockerSettings(v).manager_url;
  // Treat stored values as untrusted too; never turn a javascript: URL into a link.
  try { if (url && ["http:", "https:"].includes(new URL(url).protocol)) return `<a class="docker-status-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`; } catch { /* invalid old setting */ }
  return `<button class="docker-status-link" data-docker-settings="${esc(v.target.id)}">${esc(label)}</button>`;
}

// Single-purpose columns span both header rows; only real groups get subheadings.
function machineTableHead(withBackup) {
  const containers = containersVisible(), grouped = withBackup || containers;
  const span = grouped ? ' rowspan="2"' : "";
  const machine = `<th${span} scope="col" aria-label="Selection"></th><th${span} scope="col">Machine</th>`;
  const utilities = `${containers ? `<th${span} scope="col" class="container-heading section-start" title="Container image updates; managed separately from OS packages">Containers</th>` : ""}<th${span} scope="col" class="info-heading section-start">Info</th><th${span} scope="col" class="more-heading">More</th>`;
  const os = '<th class="update-heading section-start" scope="col">Security</th><th class="update-heading" scope="col">Packages</th><th class="update-heading" scope="col">Phased</th><th class="reboot-heading" scope="col">Reboot</th><th scope="col">Status</th><th scope="col">Action</th><th scope="col" title="Latest OS update check">OS checked</th>';
  if (!grouped) return `<thead><tr class="column-headings">${machine}${os}${utilities}</tr></thead>`;
  return `<thead><tr class="scope-headings">${machine}${withBackup ? '<th colspan="2" scope="colgroup" class="section-start">Backups</th>' : ""}<th colspan="7" scope="colgroup" class="section-start">Operating system</th>${utilities}</tr><tr class="column-headings">${withBackup ? '<th scope="col" class="section-start" title="Last backup">Latest</th><th scope="col" class="backup-job-heading" title="Covered by a backup job">Job</th>' : ""}${os}</tr></thead>`;
}

function rowHtml(v, withBackup, relation = {}, mobile = false) {
  const t = v.target, c = v.check;
  const shown = displayCheck(v);
  const self = v.runs_dashboard ? ` <span class="chip" title="This dashboard runs here">dashboard</span>` : "";
  const monitor = v.monitor_only ? ` <span class="chip monitor-policy" role="img" aria-label="Monitor only" title="${MONITOR_TIP}">${icon("eye")}</span>` : "";
  const cs = c?.community_script
    ? ` <span class="chip" title="${esc(csTip(c.community_script))}">helper script</span>` : "";
  const note = t.updatable && t.note
    ? ` <span class="machine-note warn" title="${esc(t.note)}" aria-label="${esc(t.note)}">${icon("alert")}</span>` : "";
  const repoNote = !isProxmox(t) && c?.notes?.length
    ? `<span class="repo-note ${c.notes.length > 1 ? "warn" : "muted"}" title="${esc(c.notes.join("\n"))}" aria-label="Repository information">${icon("alert")}</span>` : "";
  const machineInfo = machineInfoButton(t, c);
  const information = `${machineInfo}${repoNote}`;
  const rebootTitle = t.no_reboot || v.blocked || "Reboot needed";
  const reboot = !needsRecheck(v) && c?.reboot_required === true
    ? `<span class="reboot-status required" role="img" aria-label="Reboot required" title="${esc(rebootTitle)}">${icon("reboot")}</span>` : "";
  const rowClasses = [t.kind === "host" ? "host" : "guest", "machine-row"];
  if (relation.hasGuests) rowClasses.push("has-guests");
  if (relation.firstGuest) rowClasses.push("first-guest");
  if (relation.lastGuest) rowClasses.push("last-guest");
  if (v.hidden) rowClasses.push("is-hidden");
  if (relation.context) rowClasses.push("is-context");
  if (state.selected.has(t.id)) rowClasses.push("is-selected");
  let html = `<tr class="${rowClasses.join(" ")}" data-machine-row="${esc(t.id)}">
    <td class="selection-cell"><label class="machine-select"><input type="checkbox" aria-label="Select ${esc(t.name)}" data-select="${esc(t.id)}" data-focus-key="select:${esc(t.id)}" ${state.selected.has(t.id) ? "checked" : ""} ${selectable(v) && !relation.context ? "" : "disabled"}><span class="mobile-select-label">Select</span></label></td>
    <td class="name machine-cell" data-label="Machine"><span class="machine-main"><span class="state" title="${esc(t.status)}"><span class="dot ${DOT[t.status] || ""}"></span></span><span class="machine-identity"><span class="machine-name" title="${esc(t.name)}">${esc(t.name)}</span>${monitor}<span class="chip type-chip">${esc(kindLabel(t))}</span>${self}${cs}${note}</span><span class="machine-meta">${shown?.os ? `<span class="machine-os" title="${esc(shown.os)}">${esc(compactOS(shown.os))}</span>` : ""}</span></span></td>
    ${withBackup ? `<td class="backup-cell section-start" data-label="Last backup">${backupCell(t)}</td><td class="backup-job-cell" data-label="Job">${backupJobCell(t)}</td>` : ""}
    ${updateColumns(v)}
    <td class="reboot-cell" data-label="Reboot">${reboot}</td>
    <td class="update-status-cell" data-label="Status">${updateState(v)}</td>
    <td class="update-action-cell" data-label="Actions">${relation.context ? "" : nextAction(v)}</td>
    <td class="last-check" data-label="OS checked" title="${c ? esc(window.FleetdeckDates.dateTime(c.checked_at)) : "Never checked"}">${c ? ago(c.checked_at) : "Never"}</td>
    ${containersVisible() ? `<td class="containers-cell section-start" data-label="Containers">${dockerCell(v)}</td>` : ""}
    <td class="info-cell section-start" data-label="Info">${information ? `<span class="info-cell-content">${information}</span>` : ""}</td>
    <td class="more-cell"><button class="small ghost more-actions" data-machine-menu="${esc(t.id)}" data-focus-key="menu:${esc(t.id)}" aria-label="More actions for ${esc(t.name)}" aria-controls="machine-actions" aria-expanded="false">⋯</button></td>
  </tr>`;
  if (mobile) {
    const backup = withBackup ? backupCell(t) : "";
    const os = shown?.os || c?.os;
    const action = relation.context ? "" : nextAction(v);
    const more = `<button class="small ghost more-actions" data-machine-menu="${esc(t.id)}" data-focus-key="menu:${esc(t.id)}" aria-label="More actions for ${esc(t.name)}" aria-controls="machine-actions" aria-expanded="false">⋯</button>`;
    const metrics = [["security", securityPackages(shown).length], ["package", regularPackages(shown).length], ["phased", phasedPackages(shown).length]]
      .filter(([, count]) => count > 0).map(([kind, count]) => metricButton(v, kind, count)).join("");
    html = `<article class="mc-card${relation.context ? " is-context" : ""}${v.hidden ? " is-hidden" : ""}" data-machine-row="${esc(t.id)}">
      <div class="mc-header"><div class="machine-main"><span class="state" title="${esc(t.status)}"><span class="dot ${DOT[t.status] || ""}"></span></span><span class="machine-name">${esc(t.name)}</span>${monitor}</div>
        <div class="mc-status-group">${updateState(v)}<div class="mc-check-line"><span class="mc-check-time">Checked ${c ? ago(c.checked_at) : "Never"}</span>${information}</div></div></div>
      <div class="mc-meta-row"><div class="machine-meta"><span class="chip type-chip">${esc(kindLabel(t))}</span>${os ? `<span class="machine-os" title="${esc(os)}">${esc(compactOS(os))}</span>` : ""}${self}${cs}${note}</div></div>
      ${metrics || reboot ? `<div class="mc-counts">${metrics}${reboot ? `<span class="mc-reboot">${reboot}</span>` : ""}</div>` : ""}
      ${backup ? `<div class="mc-details"><div class="mc-detail-line"><span>Backup</span><div class="mc-backup-value">${backup}${backupJobCell(t)}</div>${!action ? more : ""}</div></div>` : ""}
      ${!action && !backup ? `<div class="mc-utility-row">${more}</div>` : ""}
      ${containersVisible() && hasDocker(v) ? `<div class="mc-containers"><span class="muted">Containers</span>${dockerCell(v)}</div>` : ""}
      ${action ? `<div class="mc-footer"><div class="mc-action">${action}</div>${more}</div>` : ""}
    </article>`;
  }
  if (shown?.packages?.length && state.expanded.has(t.id)) {
    // Security updates first, so they stand out in a long list.
    const rank = (p) => p.phased_dependency ? 3 : p.phased ? 2 : p.security ? 0 : 1;
    const pkgs = [...shown.packages].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const rows = pkgs.map((p) => {
      const kind = p.phased ? "phased" : p.security ? "security" : "package";
      const label = p.phased_dependency ? "Waiting" : p.phased ? "Phased" : p.security ? "Security" : "Package";
      const iconName = p.phased ? "clock" : p.security ? "shield" : "package";
      const reason = p.phased_dependency ? ` title="Waiting on related phased packages"` : "";
      return `<tr><td><span class="package-type ${kind}"${reason}>${icon(iconName)}${label}</span></td><td class="package-name">${esc(p.name)}</td><td class="package-version">${esc(p.current || "—")}</td><td class="package-version">${esc(p.available)}</td></tr>`;
    }).join("");
    const detailClasses = ["pkgs"];
    if (state.selected.has(t.id)) detailClasses.push("is-selected");
    if (relation.hasGuests || (t.kind !== "host" && !relation.lastGuest)) detailClasses.push("tree-continues");
    const history = staleCheck(v) ? `<p class="last-known-note">Last known · ${esc(ago(shown.checked_at))}. Check again before installation.</p>` : "";
    const panel = `<div class="packages-panel">${history}<table class="packages-table"><thead><tr><th>Type</th><th>Package</th><th>Installed</th><th>Available</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    html += mobile ? `<div class="mc-package-panel" id="packages-${esc(t.id)}">${panel}</div>` : `<tr class="${detailClasses.join(" ")}" id="packages-${esc(t.id)}"><td></td><td colspan="${10 + (2 * Number(!!withBackup)) + Number(containersVisible())}">${panel}</td></tr>`;
  }
  if (state.containerExpanded.has(t.id) && hasDocker(v)) {
    const panel = stackPanel(v).replace(`id="docker-${esc(t.id)}"`, `id="inline-docker-${esc(t.id)}"`).replaceAll('data-focus-key="container-filter:', 'data-focus-key="inline-container-filter:');
    html += mobile ? `<div class="mc-container-panel">${panel}</div>` : `<tr class="container-detail"><td colspan="${11 + (2 * Number(!!withBackup)) + Number(containersVisible())}">${panel}</td></tr>`;
  }
  return html;
}

function render() {
  const mobile = mobileDashboard.matches;
  if (mobile) state.selected.clear();
  $("#groups").classList.toggle("mobile-layout", mobile);
  if (!containersVisible()) state.view = "machines";
  const focused = document.activeElement?.dataset?.focusKey;
  // Avoid replacing live controls on every poll when their rendered data did not change.
  const html = (selector, content) => {
    const el = $(selector);
    // Compare our templates, not serialized DOM (browsers normalize boolean attributes, etc.).
    if (renderedHTML.get(el) !== content) { el.innerHTML = content; renderedHTML.set(el, content); }
  };
  $("#errors").innerHTML = Object.entries(state.errors)
    .map(([p, e]) => `<div class="error-banner"><b>${esc(p)}</b>: ${esc(e)}</div>`).join("");

  const updatable = active().filter((v) => v.target.updatable);
  const pending = active().filter((v) => actionablePackages(displayCheck(v)).length);
  const secMachines = pending.filter((v) => securityPackages(displayCheck(v)).length).length;
  const reboot = updatable.filter((v) => !v.check?.error && v.check?.reboot_required).length;
  const recheck = active().filter(needsRecheck).length;
  const hosts = dockerHosts();
  const kpi = (key, count, tone, label) => `<button type="button" class="stat" data-kpi="${key}" data-focus-key="kpi:${key}" aria-pressed="${state.filter === key}"><b class="${count ? tone : "ok"}">${count}</b><span>${label}</span></button>`;
  html("#summary", `
    ${kpi("updates", pending.length, "warn", plural(pending.length, "Machine needing updates", "Machines needing updates"))}
    ${kpi("security", secMachines, "bad", plural(secMachines, "Machine with security updates", "Machines with security updates"))}
    ${kpi("reboot", reboot, "reboot", plural(reboot, "Machine requiring reboot", "Machines requiring reboot"))}
    ${kpi("recheck", recheck, "muted", plural(recheck, "Machine needing recheck", "Machines needing recheck"))}`);
  $("#overview-count").textContent = `${active().length} ${plural(active().length, "machine", "machines")}`;
  $("#schedule-status").innerHTML = scheduleStat();
  html("#check-os", `${icon("refresh")}<span>Check OS updates</span>`);
  html("#check-containers", `${icon("boxes")}<span>Check container updates</span>`);
  $("#check-containers").hidden = !active().some(hasDocker);
  $("#check-containers").disabled = requestingDockhandChecks || (!nativeContainerHosts().length && !active().some(v => v.dockhand && state.settings.dockhand_checks_allowed));
  $("#check-containers").title = "Check containers using each machine's provider. Fleetdeck native checks pull images after confirmation; Dockhand checks registry metadata.";
  $("#refresh span").textContent = "Refresh inventory";
  $("#check-all").title = state.settings.dockhand_checks_allowed || state.settings.docker_enabled ? "Check OS and container updates using their configured providers; native image pulls require confirmation" : "Check OS updates";
  $("#refresh").title = "Rediscover machines and read saved container reports; no fresh update checks";
  $("#test-notify").hidden = !state.schedule?.notify_targets;

  const hiddenCount = state.targets.length - active().length;
  const toggle = $("#show-hidden");
  toggle.hidden = hiddenCount === 0;
  $("#hidden-count").textContent = hiddenCount;
  toggle.setAttribute("aria-pressed", String(state.showHidden));
  const allGroups = groups();
  const withBackup = allGroups.some((g) => g.rows.some((v) => v.target.backup));
  const filteredGroups = allGroups.map((g) => {
    const matches = g.rows.filter((v) => matchesKpi(v, state.filter));
    return { ...g, rows: !state.filter ? g.rows : matches.length ? g.rows.filter((v) => matches.includes(v) || (v.target.kind === "host" && g.rows.some((guest) => guest.target.kind !== "host"))) : [] };
  }).filter((g) => g.rows.length);
  const matchingCount = active().filter((v) => matchesKpi(v, state.filter)).length;
  if (state.filter) $("#overview-count").textContent = `${matchingCount} of ${active().length} machines`;
  $("#filter-status").hidden = !state.filter;
  $("#filter-status").textContent = state.filter ? `${matchingCount} matching ${plural(matchingCount, "machine", "machines")} · parent nodes kept for context · click the selected KPI to clear` : "";
  html("#groups", filteredGroups.map((g) => {
    const guestIndexes = g.rows.map((v, index) => v.target.kind === "host" ? -1 : index).filter((index) => index >= 0);
    const firstGuest = guestIndexes[0], lastGuest = guestIndexes.at(-1);
    const rows = g.rows.map((v, index) => rowHtml(v, withBackup, {
      hasGuests: v.target.kind === "host" && guestIndexes.length > 0,
      firstGuest: index === firstGuest,
      lastGuest: index === lastGuest,
      context: !!state.filter && !matchesKpi(v, state.filter),
    }, mobile)).join("");
    if (mobile) return `<section class="group"><div class="group-head"><span class="chip">${PLATFORM[g.platform] || g.platform}</span> ${esc(g.title)}</div><div class="mc-stack">${rows}</div></section>`;
    return `
    <div class="group">
      <div class="group-head"><span class="chip">${PLATFORM[g.platform] || g.platform}</span> ${esc(g.title)}</div>
      <div class="group-scroll"><table class="machine-table${withBackup ? " has-backup" : ""}${containersVisible() ? " has-containers" : ""}" aria-label="${esc(g.title)} machines">
        <colgroup><col class="col-select"><col class="col-machine"></colgroup>${withBackup ? '<colgroup><col class="col-backup"><col class="col-backup-job"></colgroup>' : ""}<colgroup><col class="col-metric"><col class="col-metric"><col class="col-metric"><col class="col-reboot"><col class="col-status"><col class="col-update"><col class="col-checked"></colgroup>${containersVisible() ? '<colgroup><col class="col-containers"></colgroup>' : ""}<colgroup><col class="col-info"><col class="col-more"></colgroup>
        ${machineTableHead(withBackup)}
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }).join("") || (state.filter ? `<div class="empty"><h3>No matching machines</h3><p class="muted">Click the selected KPI again to show all machines.</p></div>` : `<div class="empty"><h3>No machines yet</h3><p class="muted">Add a Proxmox node, an Incus server or any Linux host, and it shows up here with its updates, backups and state.</p><a class="button primary" href="/setup">Add machines</a></div>`));
  const unknown = state.settings.docker_enabled ? active().filter((v) => !v.dockhand && v.target.updatable && v.check?.docker_installed == null && !v.stacks).length : 0;
  html("#containers", containersVisible() ? `${hosts.some((v) => dockerEnabled(v) && canUpgrade(v.target)) ? `<div class="containers-toolbar"><span class="muted">Fetch downloads images for Fleetdeck-managed hosts only. Dockhand checks compare registry digests and metadata.</span><button class="small" data-fetch-docker>Fetch image updates</button></div>` : ""}${hosts.map(stackPanel).join("") || `<div class="empty"><h3>No Docker hosts discovered</h3><p class="muted">Configure Dockhand mappings or use OS checks for native Docker discovery.</p></div>`}${unknown ? `<p class="muted discovery-note">Docker capability is not known on ${unknown} machine(s). <button class="small" data-discover-docker>Check OS updates to discover hosts</button></p>` : ""}` : "");
  $(".view-tabs").hidden = !containersVisible();
  $("#groups").hidden = state.view !== "machines";
  $("#containers").hidden = state.view !== "containers";
  $("#docker-host-count").textContent = hosts.length;
  document.querySelectorAll("[data-view]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.view === state.view)));

  const btn = $("#update-selected");
  btn.disabled = state.selected.size === 0;
  btn.textContent = `Update selected (${state.selected.size})`;
  $("#bulk-toolbar").hidden = state.selected.size === 0 || state.view !== "machines";
  $("#selection-count").textContent = `${state.selected.size} ${plural(state.selected.size, "machine", "machines")} selected`;
  document.querySelectorAll("[data-machine-menu]").forEach((el) => el.setAttribute("aria-expanded", String(el.dataset.machineMenu === machineMenuId)));
  document.querySelectorAll("[data-machine-info]").forEach((el) => el.setAttribute("aria-expanded", String(el.dataset.machineInfo === machineInfoId)));

  $("#jobs").innerHTML = state.jobs.map((j) => {
    const cls = j.status === "failed" ? "bad" : j.status === "succeeded" ? "ok" : "";
    const icon = j.status === "running" || j.status === "queued" ? `<span class="spin"></span>` : "";
    return `<li data-job="${j.id}" class="${state.logJob === j.id ? "sel" : ""}">
      <span>${icon} ${esc(j.target_name)} · ${j.action}</span><span class="${cls}">${j.status}</span></li>`;
  }).join("") || `<li class="muted">No jobs yet. Checks, updates, reboots and backups you start show up here.</li>`;
  if (focused && document.activeElement === document.body) {
    [...document.querySelectorAll("[data-focus-key]")].find((el) => el.dataset.focusKey === focused)?.focus({ preventScroll: true });
  }
}

function setView(view, hostId = null) {
  state.view = containersVisible() && view === "containers" ? "containers" : "machines";
  remember.set("dashboardView", state.view);
  closeMachineMenu();
  closeMachineInformation();
  render();
  if (hostId) document.getElementById(`docker-${hostId}`)?.scrollIntoView({ block: "start" });
}

let machineMenuId = null;
function closeMachineMenu(restoreFocus = false) {
  $("#machine-actions").hidden = true;
  if (machineMenuId) {
    const trigger = [...document.querySelectorAll("[data-machine-menu]")].find((el) => el.dataset.machineMenu === machineMenuId);
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger?.focus();
  }
  machineMenuId = null;
}

function openMachineMenu(id, trigger) {
  const open = machineMenuId === id;
  closeMachineMenu();
  closeMachineInformation();
  if (open) return;
  const v = state.targets.find((item) => item.target.id === id);
  if (!v) return;
  const t = v.target, busy = !!v.active_job;
  const action = (kind, label, iconName, enabled, reason = "") => `<button data-act="${kind}" data-id="${esc(id)}" ${enabled ? "" : "disabled"} title="${esc(reason)}">${icon(iconName)}${label}</button>`;
  const menu = $("#machine-actions");
  menu.innerHTML = `<div class="muted menu-caption">${esc(t.name)}</div>` +
    action("check", "Check OS updates", "refresh", t.updatable && !busy) +
    (v.dockhand ? action("dockhand", "Check container updates", "boxes", state.settings.dockhand_checks_allowed && !v.dockhand.checking,
      !state.settings.dockhand_checks_allowed ? "Enable dockhand.allow_checks in Settings to allow fresh checks" : v.dockhand.checking ? "A Dockhand check is already running" : "Request a fresh Dockhand digest check for this machine; no downloads or restarts")
      : hasDocker(v) && dockerEnabled(v) ? action("stacks", "Check container updates", "boxes", canUpgrade(t) && !busy,
        "Fleetdeck native checks pull Compose images; confirmation is required") : "") +
    (nextAction(v).includes('data-act="reboot"') ? "" : action("reboot", "Reboot", "reboot", canReboot(t) && !busy && !v.blocked, t.no_reboot || v.blocked || t.note)) +
    (t.can_backup ? action("backup", "Back up configuration", "backup", !busy) : "") +
    (hasDocker(v) && !v.dockhand ? `<button data-docker-settings="${esc(id)}">${icon("settings")}Docker management</button>` : "") +
    (state.console?.enabled && !["stopped", "offline"].includes(t.status) ? `<button data-run="${esc(id)}">${icon("terminal")}Run command</button>` : "") +
    `<button data-hide="${v.hidden ? "0" : "1"}" data-id="${esc(id)}">${icon(v.hidden ? "eye" : "eyeOff")}${v.hidden ? "Unhide machine" : "Hide machine"}</button>`;
  machineMenuId = id;
  trigger.setAttribute("aria-expanded", "true");
  menu.hidden = false;
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, rect.bottom + menu.offsetHeight < innerHeight ? rect.bottom + 6 : rect.top - menu.offsetHeight - 6)}px`;
  menu.querySelector("button:not(:disabled)")?.focus();
}

let machineInfoId = null;
function closeMachineInformation(restoreFocus = false) {
  const panel = $("#machine-information");
  panel.hidden = true;
  if (machineInfoId) {
    const trigger = [...document.querySelectorAll("[data-machine-info]")].find((el) => el.dataset.machineInfo === machineInfoId);
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger?.focus();
  }
  machineInfoId = null;
}

function machineInfoSection(title, lines) {
  if (!lines.length) return "";
  return `<section class="machine-info-section"><h3>${esc(title)}</h3>${lines.map((line) => `<p>${esc(line)}</p>`).join("")}</section>`;
}

function backupInformation(t) {
  const b = t.backup;
  if (!b) return isProxmoxNode(t) ? [] : ["Backup information is not available for this machine."];
  const lines = [];
  if (b.last) {
    const count = `${b.count} backup${b.count === 1 ? "" : "s"} found`;
    lines.push(`Last backup ${window.FleetdeckDates.dateTime(b.last)}${b.storage ? ` on ${b.storage}` : ""}; ${count}.`);
    if (b.note) lines.push(b.note);
  } else if (b.note) {
    lines.push(b.note);
  } else if (b.not_set_up) {
    lines.push("Fleetdeck backup is not configured for this machine.");
  } else {
    lines.push("No backup was found for this machine.");
  }
  if (b.verified === false) lines.push("The newest backup failed verification.");
  if (b.in_job === true) lines.push("Covered by a backup job.");
  if (b.in_job === false) lines.push("No backup job covers this machine.");
  return lines;
}

function openMachineInformation(id, trigger) {
  const open = machineInfoId === id;
  closeMachineInformation();
  closeMachineMenu();
  if (open) return;
  const v = state.targets.find((item) => item.target.id === id);
  if (!v) return;
  const backup = backupInformation(v.target);
  const repositories = isProxmox(v.target) ? v.check?.notes || [] : [];
  const updates = [];
  if (v.monitor_only) {
    updates.push("Monitor only: updates are installed outside Fleetdeck. Checks, reboots and backups remain available.");
    updates.push(v.target.monitor_only ? "Update policy is managed in configuration on the Settings page." : "A saved monitor-only restriction from an earlier version remains active for safety.");
  }
  if (!v.check) updates.push("No update check has completed for this machine.");
  if (v.check?.os) updates.push(`Operating system: ${v.check.os}`);
  if (!v.target.updatable) updates.push(`Machine unavailable: ${v.target.note || v.target.status}`);
  if (v.check?.error) updates.push(`Latest check failed: ${v.check.error}`);
  if (v.check) updates.push(`Last attempt: ${window.FleetdeckDates.dateTime(v.check.checked_at)}`);
  if (staleCheck(v)) {
    const last = displayCheck(v);
    updates.push(`Displayed counts are from the last successful check: ${window.FleetdeckDates.dateTime(last.checked_at)}`);
    if (last.reboot_required) updates.push("A reboot was required at that check; this needs to be verified again.");
  }
  if (!backup.length && !repositories.length && !updates.length) return;
  const panel = $("#machine-information");
  panel.innerHTML = `<div class="machine-info-heading"><span>${icon("info")}<strong id="machine-information-title">${isProxmoxNode(v.target) ? "Node" : "Machine"} information</strong></span><span class="muted">${esc(v.target.name)}</span></div>${machineInfoSection("Updates", updates)}${machineInfoSection("Backup", backup)}${machineInfoSection("Repositories", repositories)}`;
  machineInfoId = id;
  trigger.setAttribute("aria-expanded", "true");
  panel.hidden = false;
  const rect = trigger.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`;
  panel.style.top = `${Math.max(8, rect.bottom + panel.offsetHeight < innerHeight ? rect.bottom + 6 : rect.top - panel.offsetHeight - 6)}px`;
  panel.focus();
}

function dockerModeFields() {
  const external = $("#docker-mode").value === "external";
  $("#docker-external-fields").hidden = !external;
  $("#docker-manager-url").disabled = !external;
  $("#docker-manager-name").disabled = !external;
}

function openDockerSettings(id) {
  const v = state.targets.find((item) => item.target.id === id);
  if (!v) return;
  closeMachineMenu();
  const policy = dockerSettings(v), dlg = $("#docker-settings-dialog");
  dlg.dataset.targetId = id;
  $("#docker-settings-title").textContent = `Docker management · ${v.target.name}`;
  $("#docker-mode").value = policy.mode;
  $("#docker-manager-name").value = policy.manager_name;
  $("#docker-manager-url").value = policy.manager_url || "";
  $("#docker-settings-error").textContent = "";
  dockerModeFields();
  dlg.showModal();
}

async function load(refresh = false) {
  let loaded = false;
  try {
    const data = await api(`/api/targets${refresh ? "?refresh=true" : ""}`);
    state.targets = data.targets;
    state.errors = data.errors;
    state.settings = data.settings || {};
    state.backupPlaces = data.backup_places || {};
    state.backupFolder = data.backup_folder || null;
    state.jobs = await api("/api/jobs");
    state.schedule = await api("/api/schedule");
    loaded = true;
    // Drop selections for targets that disappeared or can no longer be upgraded.
    const ok = new Set(state.targets.filter((v) => selectable(v) && matchesKpi(v, state.filter)).map((v) => v.target.id));
    for (const id of state.selected) if (!ok.has(id)) state.selected.delete(id);
  } catch (e) {
    state.errors = { dashboard: e.message };
  }
  render();
  return loaded;
}

let requestingDockhandChecks = false;
async function requestDockhandChecks(targetIds = null) {
  if (requestingDockhandChecks || !state.settings.dockhand_checks_allowed) return;
  requestingDockhandChecks = true;
  try {
    const hosts = active().filter(v => v.dockhand && !v.dockhand.checking && (!targetIds || targetIds.includes(v.target.id)));
    const errors = [];
    for (const host of hosts) {
      try {
        await api("/api/dockhand/check", { method: "POST", body: JSON.stringify({ target_id: host.target.id }) });
        host.dockhand.checking = true;
      } catch (err) {
        errors.push(`${host.target.name}: ${err.message}`);
      }
    }
    await load();
    if (errors.length) {
      state.errors.dockhand = `Some Dockhand checks could not start. ${errors.join("; ")}`;
      render();
    }
  } finally {
    requestingDockhandChecks = false;
    render();
  }
}

const nativeContainerHosts = () => active().filter(v => !v.dockhand && dockerEnabled(v) && hasDocker(v) && canUpgrade(v.target) && !v.active_job);
function requestContainerChecks() {
  const native = nativeContainerHosts();
  if (native.length) {
    const ids = [...native, ...active().filter(v => v.dockhand && state.settings.dockhand_checks_allowed && !v.dockhand.checking)].map(v => v.target.id);
    confirmAction("containers", ids);
    return;
  }
  return requestDockhandChecks();
}

async function checkOsUpdates() {
  const button = $("#check-os");
  if (button.disabled) return;
  button.disabled = true;
  try {
    await act("check", active().filter(v => v.target.updatable).map(v => v.target.id));
  } finally {
    button.disabled = false;
  }
}

async function refreshInventory() {
  const button = $("#refresh");
  if (button.disabled) return;
  button.disabled = true;
  try {
    // Inventory refresh only discovers machines and syncs saved reports.
    await load(true);
  } finally {
    button.disabled = false;
  }
}

async function act(action, ids, { rebootIfRequired = false, snapshotFirst = false, destination = null, stack = null, prune = false } = {}) {
  if (!ids.length) return;
  let res;
  try {
    const body = { action, target_ids: ids, reboot_if_required: rebootIfRequired, snapshot_first: snapshotFirst, destination, stack, prune };
    res = await api("/api/actions", { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    alert(`Could not start ${action}: ${e.message}`);
    return;
  }
  const rejected = Object.entries(res.rejected);
  // The server's reason already names the target; fall back to the id for unknown ones.
  if (rejected.length) alert(rejected.map(([id, why]) => (why === "unknown target" ? `${id}: ${why}` : why)).join("\n"));
  if (res.jobs.length === 1) {
    state.logJob = res.jobs[0].id;
    state.logLines = [];
  }
  schedule(200);
}

const CONFIRM = {
  containers: {
    title: "Check container images?",
    text: "Fleetdeck native hosts: download (pull) newer Docker Compose images to compare, which uses bandwidth and disk space. Dockhand hosts: request registry digest and metadata checks without image-layer downloads. Nothing is deployed or restarted. Cancelling leaves both container providers unchanged.",
    ok: "Check containers",
  },
  dockhand: {
    title: "Check containers in Dockhand?",
    text: "Ask Dockhand to check all containers in this machine's mapped environment against their registries. Container images are not deployed and containers are not restarted. Results will appear here.",
    ok: "Start check",
  },
  upgrade: {
    title: "Update these machines?",
    text: "Runs a full OS upgrade (apt dist-upgrade, dnf upgrade, apk upgrade or pacman -Syu).",
    ok: "Update",
  },
  backup: {
    title: "Back up these machines?",
    text: "Saves what is needed to set the machine up again, not its guests or instances. Proxmox: the node's config (to Proxmox Backup Server if there is one). Incus: its settings. Other machines: an archive of /etc and a few more config folders. Nothing is stopped or changed.",
    ok: "Back up",
  },
  stacks: {
    title: "Check Docker on these machines?",
    text: "Downloads (pulls) newer images for every running Docker Compose stack on each machine, which can use a lot of bandwidth and disk space. Nothing is restarted. Machines where Docker was found missing are left out.",
    ok: "Check Docker",
  },
  reboot: {
    title: "Reboot these machines?",
    text: "Reboots now and waits for each machine to come back, then re-checks it. Services on it will be down meanwhile.",
    ok: "Reboot",
  },
};

function confirmAction(action, ids) {
  const byId = new Map(state.targets.map((v) => [v.target.id, v]));
  const c = CONFIRM[action];
  $("#confirm-title").textContent = c.title;
  $("#confirm-text").textContent = c.text;
  const upgradeAction = action === "upgrade";
  $("#confirm").classList.toggle("upgrade-confirm", upgradeAction);
  $("#confirm-symbol").innerHTML = icon(upgradeAction ? "download" : action === "reboot" ? "reboot" : action === "backup" ? "backup" : "refresh");
  $("#confirm-ok").innerHTML = `${upgradeAction ? icon("download") : ""}<span>${esc(upgradeAction && ids.length > 1 ? `Update ${ids.length} machines` : c.ok)}</span>`;
  if (upgradeAction) {
    $("#confirm-title").textContent = ids.length === 1 ? "Update machine?" : `Update ${ids.length} machines?`;
    $("#confirm-text").textContent = `Install the available OS updates on ${ids.length === 1 ? "this machine" : "these machines"}.${containersVisible() ? " Container images are managed separately." : ""}`;
  }
  if (action === "reboot" && containersVisible()) $("#confirm-text").textContent += " All containers on these machines will be interrupted, regardless of their manager.";
  $("#confirm-reboot-row").hidden = action !== "upgrade";
  $("#confirm-reboot").checked = false;
  $("#confirm-reboot-note").hidden = true;
  const placeRow = $("#confirm-place-row");
  placeRow.hidden = action !== "backup";
  if (action === "backup") {
    const saved = state.backupPlaces[ids[0]] || "";
    const onDashboard = saved === "dashboard";
    $("#confirm-place-default").checked = !saved;
    $("#confirm-place-dashboard").checked = onDashboard;
    $("#confirm-place-dashboard-path").textContent = state.backupFolder || "its backup folder";
    $("#confirm-place-custom").checked = !!saved && !onDashboard;
    $("#confirm-place-path").value = onDashboard ? "" : saved;
    $("#confirm-place-remember").checked = !!saved;
  }
  $("#confirm-list").innerHTML = ids.map((id) => {
    const v = byId.get(id);
    const n = v?.check ? actionablePackages(v.check).length : null;
    const phased = phasedPackages(v?.check).length;
    let detail = n != null ? `${n} package${n === 1 ? "" : "s"}${phased ? ` · ${phased} phased, waiting` : ""}` : "not checked";
    let typeSummary = "";
    if (upgradeAction && n != null) {
      const security = securityPackages(v?.check).length, regular = regularPackages(v?.check).length;
      detail = [security ? `${security} security` : "", regular ? `${regular} package${regular === 1 ? "" : "s"}` : "", phased ? `${phased} phased, waiting` : ""].filter(Boolean).join(" · ") || "0 packages";
      typeSummary = [
        security ? `<span class="confirm-update-type">${icon("shield")}<span>${security} security</span></span>` : "",
        regular ? `<span class="confirm-update-type">${icon("package")}<span>${regular} package${regular === 1 ? "" : "s"}</span></span>` : "",
        phased ? `<span class="confirm-update-type phased">${icon("clock")}<span>${phased} phased, waiting</span></span>` : "",
      ].filter(Boolean).join("");
    }
    if (action === "backup" || action === "stacks" || action === "dockhand") detail = "";
    if (action === "containers") detail = v?.dockhand ? "Dockhand · registry metadata only" : "Fleetdeck native · downloads Compose images";
    if (action === "reboot") {
      detail = v?.check?.reboot_required ? "reboot needed" : "";
      const t = v?.target;
      const guests = t?.kind === "host"
        ? state.targets.filter((g) => g.target.parent === t.name && g.target.source === t.source && g.target.status === "running").length : 0;
      // Waits for running guest jobs first, but the guests themselves go down with it.
      if (guests) detail += `${detail ? " · " : ""}and every guest running on it (${guests})`;
    }
    const summaryText = detail;
    if (action === "upgrade" && v?.target.no_reboot) detail += ` · won't reboot: ${v.target.no_reboot}`;
    const app = v?.check?.community_script;
    if (action === "upgrade" && app) {
      detail += state.settings.community_scripts_update
        ? ` · then runs ${app}'s own update (helper script)`
        : ` · ${app}'s own update is off: run "update" in it if it misbehaves`;
    }
    if (upgradeAction) {
      const machineIcon = v?.target.kind === "host" ? "server" : "monitor";
      const extra = detail.slice(summaryText.length).replace(/^ · /, "");
      const summary = typeSummary ? `${typeSummary}${extra ? `<span class="confirm-detail-note">${esc(extra)}</span>` : ""}` : `${icon("package")}<span>${esc(detail)}</span>`;
      return `<li class="confirm-machine"><span class="confirm-machine-name">${icon(machineIcon)}<strong>${esc(v?.target.name || id)}</strong>${v ? `<span class="chip">${esc(kindLabel(v.target))}</span>` : ""}</span><span class="confirm-machine-detail muted">${summary}</span></li>`;
    }
    return `<li>${esc(v?.target.name || id)} <span class="muted">${esc(detail)}</span></li>`;
  }).join("");
  const snapshottable = action === "upgrade" && ids.some((id) => byId.get(id)?.target.can_snapshot);
  $("#confirm-snapshot-row").hidden = !snapshottable;
  $("#confirm-snapshot").checked = false;
  $("#confirm-snapshot-label").textContent = ids.length === 1 ? "Take a snapshot first" : "Take snapshots first";
  const dlg = $("#confirm");
  dlg.returnValue = "";
  dlg.showModal();
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "ok") return;
    if (action === "containers") {
      await act("stacks", ids.filter(id => { const v = state.targets.find(v => v.target.id === id); return v && !v.dockhand && dockerEnabled(v); }));
      await requestDockhandChecks(ids);
      schedule(1000);
      return;
    }
    if (action === "dockhand") {
      try {
        await api("/api/dockhand/check", { method: "POST", body: JSON.stringify({ target_id: ids[0] }) });
        await load();
        schedule(1000);
      } catch (e) { alert(`Could not start Dockhand check: ${e.message}`); }
      return;
    }
    if (action === "upgrade") state.selected.clear();
    const upgrade = action === "upgrade";
    let destination = null;
    if (action === "backup") {
      destination = $("#confirm-place-dashboard").checked ? "dashboard"
        : $("#confirm-place-custom").checked ? $("#confirm-place-path").value.trim() : null;
      if ($("#confirm-place-custom").checked && !destination) { alert("Enter the folder to back up to, or choose the default place."); return; }
      if ($("#confirm-place-remember").checked) {
        // Choosing the default place and remembering it clears an earlier choice.
        try {
          const r = await api("/api/backup-places", { method: "PUT", body: JSON.stringify({ target_id: ids[0], path: destination }) });
          state.backupPlaces = r.backup_places;
        } catch (e) { alert(`Could not save the backup folder: ${e.message}`); return; }
      }
    }
    act(action, ids, {
      destination,
      rebootIfRequired: upgrade && $("#confirm-reboot").checked,
      snapshotFirst: upgrade && $("#confirm-snapshot").checked,
    });
  }, { once: true });
}

async function showLog(jobId) {
  if (state.logJob !== jobId) { state.logJob = jobId; state.logLines = []; }
  let job;
  try {
    job = await api(`/api/jobs/${jobId}?since=${state.logLines.length}`);
  } catch (e) {
    $("#log-title").textContent = `Could not load job output: ${e.message}`;
    return;
  }
  // A click and the poller can fetch at the same time: drop stale answers and splice by
  // offset so lines are never appended twice.
  if (state.logJob !== jobId) return;
  state.logLines.splice(job.log_offset, Infinity, ...job.log);
  $("#log-title").textContent = `${job.target_name} · ${job.action} · ${job.status}`;
  const rb = $("#rollback");
  rb.hidden = !(job.action === "upgrade" && job.snapshot && (job.status === "succeeded" || job.status === "failed"));
  // Not while the machine has a job queued or running (e.g. the rollback just started).
  rb.disabled = state.targets.some((v) => v.target.id === job.target_id && v.active_job);
  rb.dataset.rollbackJob = job.id;
  rb.dataset.snapshot = job.snapshot || "";
  rb.dataset.name = job.target_name;
  const pre = $("#log");
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = state.logLines.join("\n");
  if (stick) pre.scrollTop = pre.scrollHeight;
  render();
}

async function setHidden(id, hidden) {
  try {
    await api("/api/hidden", { method: "POST", body: JSON.stringify({ target_ids: [id], hidden }) });
  } catch (e) {
    alert(`Could not ${hidden ? "hide" : "unhide"} it: ${e.message}`);
    return;
  }
  for (const v of state.targets) if (v.target.id === id) v.hidden = hidden;
  if (hidden) state.selected.delete(id);
  render();
}

$("#confirm-reboot").addEventListener("change", () => {
  $("#confirm-reboot-note").hidden = !$("#confirm-reboot").checked;
});

document.addEventListener("click", (e) => {
  const kpi = e.target.closest("[data-kpi]");
  if (kpi) {
    state.filter = state.filter === kpi.dataset.kpi ? null : kpi.dataset.kpi;
    state.view = "machines";
    for (const id of state.selected) if (!state.targets.some((v) => v.target.id === id && matchesKpi(v, state.filter))) state.selected.delete(id);
    closeMachineMenu(); closeMachineInformation(); render(); return;
  }
  const el = e.target.closest("[data-act],[data-toggle],[data-job],[data-hide],[data-stack]");
  if (!el || el.disabled) return;
  closeMachineMenu();
  $("#dashboard-menu").open = false;
  if (el.dataset.stack) {
    const id = el.dataset.id, name = el.dataset.stack;
    const host = state.targets.find((v) => v.target.id === id)?.target.name || id;
    if (!confirm(`Update ${name} on ${host}?\n\nPulls newer images and restarts the containers that changed. Stopped services stay stopped.`)) return;
    act("stack-update", [id], { stack: name, prune: !!remember.get("pruneImages") });
  } else if (el.dataset.act === "docker") {
    setView("containers", el.dataset.id);
  } else if (el.dataset.act === "dockhand") {
    confirmAction("dockhand", [el.dataset.id]);
  } else if (el.dataset.act === "stacks") {
    confirmAction("stacks", [el.dataset.id]);
  } else if (el.dataset.hide) {
    setHidden(el.dataset.id, el.dataset.hide === "1");
  } else if (el.dataset.toggle) {
    const id = el.dataset.toggle;
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    render();
  } else if (el.dataset.job) {
    showLog(el.dataset.job);
  } else if (el.dataset.act === "check") {
    act("check", [el.dataset.id]);
  } else if (el.dataset.act === "upgrade" || el.dataset.act === "reboot" || el.dataset.act === "backup") {
    confirmAction(el.dataset.act, [el.dataset.id]);
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#dashboard-menu") || e.target.closest(".dashboard-menu-items button,.dashboard-menu-items a")) $("#dashboard-menu").open = false;
  const el = e.target.closest("[data-machine-menu],[data-machine-info],[data-open-docker],[data-docker-settings],[data-view],[data-fetch-docker],[data-discover-docker],[data-dockhand-check],[data-container-view-filter]");
  if (el?.dataset.machineMenu) { openMachineMenu(el.dataset.machineMenu, el); return; }
  if (el?.dataset.machineInfo) { openMachineInformation(el.dataset.machineInfo, el); return; }
  if (!e.target.closest("#machine-actions")) closeMachineMenu();
  if (!e.target.closest("#machine-information")) closeMachineInformation();
  if (!el || el.disabled) return;
  if (el.dataset.containerViewFilter) { state.containerFilters[el.dataset.id] = el.dataset.containerViewFilter; render(); return; }
  if (el.dataset.dockhandCheck) confirmAction("dockhand", [el.dataset.dockhandCheck]);
  else if (el.dataset.view) setView(el.dataset.view);
  else if (el.dataset.openDocker) {
    const id = el.dataset.openDocker;
    const filter = el.dataset.containerFilter || "all";
    if (state.containerExpanded.has(id) && (state.containerFilters[id] || "all") === filter) state.containerExpanded.delete(id);
    else { state.containerExpanded.add(id); state.containerFilters[id] = filter; }
    render();
  }
  else if (el.dataset.dockerSettings) openDockerSettings(el.dataset.dockerSettings);
  else if (el.hasAttribute("data-fetch-docker")) {
    const ids = dockerHosts().filter((v) => dockerEnabled(v) && canUpgrade(v.target) && !v.active_job).map((v) => v.target.id);
    if (ids.length) confirmAction("stacks", ids);
  } else if (el.hasAttribute("data-discover-docker")) {
    act("check", active().filter((v) => v.target.updatable && !v.active_job).map((v) => v.target.id));
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMachineMenu(true); closeMachineInformation(true); $("#dashboard-menu").open = false; }
});
window.addEventListener("resize", () => { closeMachineMenu(); closeMachineInformation(); });
mobileDashboard.addEventListener?.("change", () => { closeMachineMenu(); closeMachineInformation(); render(); });
window.addEventListener("scroll", () => { closeMachineMenu(); closeMachineInformation(); }, true);
$("#clear-selected").onclick = () => { state.selected.clear(); render(); };
$("#docker-mode").onchange = dockerModeFields;
$("#docker-settings-close").onclick = () => $("#docker-settings-dialog").close();
$("#docker-settings-form").onsubmit = async (e) => {
  e.preventDefault();
  const dlg = $("#docker-settings-dialog"), id = dlg.dataset.targetId;
  const body = { target_id: id, mode: $("#docker-mode").value, manager_name: $("#docker-manager-name").value.trim() || "Dockhand", manager_url: $("#docker-manager-url").value.trim() || null };
  $("#docker-settings-save").disabled = true;
  $("#docker-settings-error").textContent = "";
  try {
    const res = await api("/api/docker-settings", { method: "PUT", body: JSON.stringify(body) });
    const view = state.targets.find((v) => v.target.id === id);
    if (view) view.docker_settings = res.docker_settings;
    dlg.close();
    render();
  } catch (err) {
    $("#docker-settings-error").textContent = err.message;
  } finally {
    $("#docker-settings-save").disabled = false;
  }
};

document.addEventListener("change", (e) => {
  if (e.target.matches("[data-prune]")) { remember.set("pruneImages", e.target.checked); return; }
  const id = e.target.dataset?.select;
  if (!id) return;
  e.target.checked ? state.selected.add(id) : state.selected.delete(id);
  render();
});

$("#confirm-place-path").addEventListener("input", () => { $("#confirm-place-custom").checked = true; });
$("#refresh").onclick = refreshInventory;
$("#show-hidden").onclick = () => {
  state.showHidden = !state.showHidden;
  remember.set("showHidden", state.showHidden);
  render();
};
$("#test-notify").onclick = window.FleetdeckTools.testNotification;
$("#rollback").onclick = async (e) => {
  const { rollbackJob: job, snapshot, name } = e.currentTarget.dataset;
  if (!confirm(`Roll ${name} back to snapshot ${snapshot}? Everything changed on it since the snapshot is lost.`)) return;
  try {
    const j = await api(`/api/jobs/${job}/rollback`, { method: "POST" });
    state.logJob = j.id;
    state.logLines = [];
    schedule(200);
  } catch (err) {
    alert(`Could not roll back: ${err.message}`);
  }
};
window.FleetdeckTools.bindBackup($("#backup"), $("#backup-dialog"));

$("#check-os").onclick = checkOsUpdates;
$("#check-containers").onclick = requestContainerChecks;
$("#check-all").onclick = async () => {
  const button = $("#check-all");
  if (button.disabled) return;
  button.disabled = true;
  try {
    await checkOsUpdates();
    await requestContainerChecks();
  } finally {
    button.disabled = false;
  }
};
$("#update-selected").onclick = () => confirmAction("upgrade", [...state.selected]);

// Poll fast while anything is running, slowly otherwise.
let timer;
function schedule(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
async function tick() {
  try {
    await load();
    if (state.logJob && state.jobs.some((j) => j.id === state.logJob)) await showLog(state.logJob);
  } catch (e) {
    console.error(e);
  } finally {
    // Always keep polling, even if one request failed (e.g. a job evicted from history).
    const busy = state.jobs.some((j) => j.status === "running" || j.status === "queued") || state.targets.some(v => v.dockhand?.checking);
    schedule(busy ? 1500 : 15000);
  }
}
tick();
