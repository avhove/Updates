/* Shared container presentation. Provider actions remain separate and server-enforced. */
function containerFacts(row) {
  const update = row.image_update === true || (row.image_update == null && row.status === "update");
  const review = !!(row.advisory || row.newer_version || row.pinned_digest || row.deferred_hours || ["advisory", "deferred"].includes(row.status));
  const failure = row.status === "failed" || (!!row.check_issue && row.check_issue !== "missing_result");
  const coverage = ["local", "excluded", "unknown"].includes(row.status) || row.check_issue === "missing_result";
  const current = !failure && row.status !== "unknown" && !row.check_issue && (row.status === "current" || (row.image_update === false && !row.pinned_digest && !row.deferred_hours && ["fleetdeck_button", "fleetdeck_schedule", "dockhand_schedule"].includes(row.source)));
  return { update, review, failure, coverage, current };
}

function containerView(v) {
  if (v.dockhand) {
    const dh = v.dockhand;
    return { provider: "dockhand", rows: dh.containers || [], checking: !!dh.checking,
      stale: !!dh.stale || !!dh.error, error: dh.error, checkError: dh.check_error,
      historyError: dh.history_error, syncedAt: dh.synced_at, checkedAt: dh.last_check_at,
      scheduledAt: dh.scheduled_check_at, scheduledStatus: dh.scheduled_status,
      scheduledErrors: dh.scheduled_errors, scheduledChecked: dh.scheduled_checked };
  }
  const r = v.stacks, rows = [];
  for (const stack of r?.stacks || []) {
    for (const service of stack.services || []) {
      const running = ["running", "restarting"].includes(service.status);
      const status = stack.error ? "failed" : !running ? "excluded" : service.outdated ? "update" : "current";
      rows.push({ container_id: `${stack.name}:${service.name}`, name: service.name, stack: stack.name,
        image: service.image, state: service.status, status, checked_at: r.checked_at,
        image_update: running && service.outdated ? true : status === "current" ? false : null,
        reported_at: running && service.outdated ? r.checked_at : null, check_issue: stack.error ? "stack" : null,
        source: "fleetdeck_native", nativeStack: stack, coverage_reason: !running ? "Stopped service · not checked" : null });
    }
    if (stack.error && !stack.services?.length) rows.push({ name: stack.name, stack: stack.name, image: "",
      status: "failed", state: "Stack check unavailable", check_issue: "stack", checked_at: r.checked_at, source: "fleetdeck_native", nativeStack: stack });
  }
  return { provider: "native", rows, scopeGap: true, checking: ["stacks", "stack-update"].includes(v.active_job?.action),
    stale: !!r?.error, error: r?.error, checkedAt: r?.checked_at, syncedAt: r?.checked_at };
}

function containerSummary(v) {
  const view = containerView(v), rows = view.rows, facts = rows.map(containerFacts);
  const count = key => facts.filter(f => f[key]).length;
  const useful = facts.some((f, i) => f.update || f.current || (f.review && rows[i].image_update === false && !f.failure && rows[i].status !== "unknown"));
  return { ...view, updates: count("update"), reviews: count("review"), coverage: count("coverage"), failures: count("failure"),
    current: count("current"), usable: useful, unknown: !useful, value: useful ? count("update") : "—" };
}

function dockerCell(v) {
  if (!hasDocker(v)) return "";
  const policy = dockerSettings(v);
  if (policy.mode === "disabled") return '<span class="muted">disabled</span>';
  if (!v.dockhand && !dockerEnabled(v)) return `<button class="container-metric-hit" data-open-docker="${esc(v.target.id)}" aria-label="Container status managed externally; view details">${icon("boxes")}—</button>`;
  const s = containerSummary(v), id = esc(v.target.id), selected = state.containerFilters?.[v.target.id] || "all";
  const manager = s.provider === "dockhand" ? "Managed externally by Dockhand" : "Managed by Fleetdeck native Docker";
  const badge = (filter, symbol, value, label, tone) => `<button class="container-metric-hit container-indicator ${tone || ""}" data-open-docker="${id}" data-container-filter="${filter}" data-focus-key="docker:${id}:${filter}:${symbol}" aria-expanded="${state.containerExpanded.has(v.target.id) && selected === filter}" title="${esc(label)}" aria-label="${esc(`${label}. ${manager}. View container details`)}"><span class="update-metric ${tone || ""}">${symbol === "spin" ? '<span class="spin"></span>' : icon(symbol)}${value === null ? "" : `<span>${value}</span>`}</span></button>`;
  const label = s.usable ? `${s.updates} ${plural(s.updates, "container with an image update", "containers with image updates")}${s.stale ? " · last-known results" : ""}` : "Container update count unavailable";
  let body = badge("all", "boxes", s.value, label, `container${s.stale ? " last-known" : ""}${s.unknown ? " unknown" : ""}`);
  if (s.reviews) body += badge("review", "tag", s.reviews, `${s.reviews} containers with version / pinned-digest advisories or held updates`, "container-review");
  if (s.coverage || s.scopeGap) body += badge("coverage", "info", s.coverage || null,
    s.scopeGap ? "Compose-only coverage: standalone containers and newer-version tags are outside Fleetdeck native checks" : `${s.coverage} coverage ${plural(s.coverage, "exception", "exceptions")}: local, excluded, new or unmatched containers`, "container-coverage");
  if (s.failures) body += badge("failures", "alert", s.failures, `${s.failures} ${plural(s.failures, "latest container or stack check failed", "latest container or stack checks failed")}; known updates are retained`, "container-failure");
  if (s.checking) body += badge("all", "spin", null, "Checking containers; previous results are shown until the check completes", "container-notice");
  else if (s.error || s.checkError) body += badge("all", s.usable ? "clock" : "alert", null, "Container checks or connection unavailable; results may be last-known", "container-notice");
  else if (s.historyError || (s.scheduledStatus === "failed")) body += badge("all", "alert", null, "Scheduled-check history has a warning; confirmed results remain visible", "container-notice");
  return `<span class="container-indicators">${body}<span class="container-manager-symbol" role="img" aria-label="${esc(manager)}" title="${esc(manager)}">${icon(s.provider === "dockhand" ? "external" : "server")}</span></span>`;
}

function containerResult(row) {
  const f = containerFacts(row), lines = [], add = (tone, symbol, text) => lines.push(`<div class="container-result ${tone}">${icon(symbol)}<span>${esc(text)}</span></div>`);
  if (f.update) add("container-tone", "boxes", `Image update reported${f.failure || row.status === "unknown" ? ` · last known${row.reported_at ? ` ${ago(row.reported_at)}` : ""}` : ""}`);
  if (f.current) add("ok", "check", row.newer_version ? "Current tag is up to date" : "Up to date");
  const oldReview = f.failure && row.advisory_at && row.checked_at && Date.parse(row.advisory_at) < Date.parse(row.checked_at);
  if (row.newer_version) add("container-review-tone", "tag", `${oldReview ? "Last-known newer version" : "Newer version"}: ${row.newer_version} · manual tag change`);
  if (row.pinned_digest) add("container-review-tone", "tag", "Pinned digest moved · manual review required");
  if (row.deferred_hours) add("container-review-tone", "clock", `${oldReview ? "Last-known held update" : "Update deferred"} · ${row.deferred_hours} h cooldown remaining${oldReview ? " when checked" : ""}`);
  if (f.review && !row.newer_version && !row.pinned_digest && !row.deferred_hours) add("container-review-tone", "tag", row.status === "deferred" ? "Update deferred by policy" : "Version / pinned digest advisory");
  if (f.failure) add("bad", "alert", ({ rate_limit: "Check failed · registry rate limit", authentication: "Check failed · registry authentication", timeout: "Check failed · registry timeout", stack: "Stack image check failed" })[row.check_issue] || "Check failed · registry unavailable");
  if (row.status === "local") add("muted", "server", "Local image · no registry comparison available");
  if (row.status === "excluded") add("muted", "info", row.coverage_reason || "Excluded by policy");
  if (row.status === "unknown") add("muted", "info", row.check_issue === "missing_result" ? "No matching result in the latest check" : "No confirmed check result · new, unchecked or replaced container");
  return lines.join("") || '<span class="muted">No confirmed check result</span>';
}

function containerPanel(v) {
  const s = containerSummary(v), id = esc(v.target.id), dh = v.dockhand, native = s.provider === "native";
  const filter = state.containerFilters?.[v.target.id] || "all", compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const items = [...s.rows].sort((a, b) => compare(a.stack || "Standalone", b.stack || "Standalone") || compare(a.name, b.name) || compare(a.image, b.image));
  const shown = items.filter(row => filter === "all" || containerFacts(row)[({ review: "review", coverage: "coverage", failures: "failure" })[filter]]);
  const button = native ? `<button class="small" data-act="stacks" data-id="${id}" ${!canUpgrade(v.target) || v.active_job ? "disabled" : ""} title="Download newer Compose images to compare; confirmation is required">${icon("refresh")}Fetch image updates</button>`
    : `<button class="small" data-dockhand-check="${id}" ${!state.settings.dockhand_checks_allowed || s.checking ? "disabled" : ""} title="${state.settings.dockhand_checks_allowed ? "Request a fresh registry digest check; no image layers or restarts" : "Enable dockhand.allow_checks in Settings to allow fresh checks"}">${icon("refresh")}${s.checking ? "Checking…" : "Check in Dockhand"}</button>`;
  const mode = native ? `Fleetdeck native · ${dockerSettings(v).mode === "monitor" || v.monitor_only ? "monitor only" : "Compose"}` : `Dockhand · ${!state.settings.dockhand_checks_allowed ? "read-only" : state.settings.scheduled_container_checks ? "included in scheduled rounds" : "manual checks"}`;
  const counts = `${s.usable ? `${s.updates} reported image ${plural(s.updates, "update", "updates")}` : "Update count unavailable"} · ${s.current} confirmed up to date${s.reviews ? ` · ${s.reviews} review ${plural(s.reviews, "item", "items")}` : ""}${s.coverage ? ` · ${s.coverage} coverage ${plural(s.coverage, "exception", "exceptions")}` : ""}${s.failures ? ` · ${s.failures} failed ${plural(s.failures, "check", "checks")}` : ""}`;
  const tabs = [["all", "All", s.rows.length], ...(s.reviews ? [["review", "Review", s.reviews]] : []), ...(s.coverage || s.scopeGap ? [["coverage", "Coverage", s.coverage || null]] : []), ...(s.failures ? [["failures", "Failures", s.failures]] : [])];
  const filters = `<div class="container-filters" role="group" aria-label="Filter container results">${tabs.map(([value, text, count]) => `<button class="small ghost" data-container-view-filter="${value}" data-id="${id}" data-focus-key="container-filter:${id}:${value}" aria-pressed="${filter === value}">${text}${count === null ? "" : ` <span>${count}</span>`}</button>`).join("")}</div>`;
  const actions = native && dockerSettings(v).mode === "managed";
  const seen = new Set();
  const action = row => {
    if (!actions || !row.nativeStack || seen.has(row.stack)) return "";
    seen.add(row.stack);
    const stack = row.nativeStack;
    if (stack.is_dashboard) return '<span class="muted">Update externally</span>';
    if (!stack.update_available || !stack.services?.some(service => service.outdated && ["running", "restarting"].includes(service.status))) return "";
    const allowed = !v.monitor_only && canUpgrade(v.target) && !v.blocked && !v.active_job && !stack.error && stack.state !== "stopped" && v.stacks?.compose !== "none";
    return `<button class="small primary" data-stack="${esc(stack.name)}" data-id="${id}" ${allowed ? "" : "disabled"} title="${esc(v.monitor_only ? MONITOR_TIP : v.blocked || stack.error || "Download images and recreate running services")}">Update stack</button>`;
  };
  const table = `<div class="group-scroll"><table class="container-results-table ${native ? "native-container-table" : "dockhand-table"}" aria-label="${esc(v.target.name)} containers sorted by stack"><colgroup><col class="cr-name"><col class="cr-stack"><col class="cr-image"><col class="cr-status"><col class="cr-checked">${actions ? '<col class="cr-action">' : ""}</colgroup><thead><tr><th>${native ? "Service" : "Container"}</th><th>Stack</th><th>Image</th><th>Status</th><th>Last checked</th>${actions ? '<th>Action</th>' : ""}</tr></thead><tbody>${shown.map(row => `<tr><td class="container-name${native ? "" : " dockhand-name"}">${esc(row.name)}<div class="cell-detail muted">${esc(row.state)}</div></td><td data-label="Stack" class="muted">${esc(row.stack || "Standalone")}</td><td data-label="Image">${esc(row.image)}</td><td data-label="Status">${containerResult(row)}</td><td data-label="Last checked" class="muted" title="${esc(({ dockhand_schedule: "From Dockhand scheduled-check history", fleetdeck_button: "From a check requested through Fleetdeck", fleetdeck_schedule: "From a scheduled Fleetdeck check", fleetdeck_native: "From Fleetdeck native Compose checks" })[row.source] || "From Dockhand pending-update reports")}">${row.status === "excluded" ? "Excluded" : row.status === "local" ? "Not applicable" : row.checked_at ? `${containerFacts(row).failure || row.check_issue === "missing_result" ? "Attempt: " : ""}${ago(row.checked_at)}` : "Not checked"}</td>${actions ? `<td data-label="Action">${action(row)}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
  const notices = [s.checking ? '<p class="container-notice-line" role="status">Checking container images… Previous results remain last-known until completion.</p>' : "", s.error ? `<p class="container-notice-line bad" role="status">${esc(s.error)} Last-known results are shown where available.</p>` : "", s.checkError ? `<p class="container-notice-line bad" role="status">${esc(s.checkError)}</p>` : "", s.historyError ? `<p class="container-notice-line warn">${esc(s.historyError)} Confirmed manual results remain usable.</p>` : ""].join("");
  const specific = native ? "Fleetdeck native checks cover Docker Compose stacks only. Standalone containers are not checked, and newer-version-tag advisories are not provided by this checker. Fetch downloads images; Update stack recreates running services after confirmation."
    : "Dockhand owns its own schedule. Automatic dashboard polling and Refresh inventory read saved reports. Check all and Check container updates request fresh digest checks when enabled. Fleetdeck scheduled container checks additionally require schedule.check_docker. Checks compare registry metadata without downloading image layers or restarting containers. Deploy containers in Dockhand.";
  const schedule = !native && s.scheduledAt ? `Dockhand scheduled check: ${ago(s.scheduledAt)} · ${{ success: s.scheduledErrors ? `Completed with ${s.scheduledErrors} ${plural(s.scheduledErrors, "check error", "check errors")}` : "Completed", failed: "Failed", running: "Running", warning: "Completed with warnings", queued: "Queued", skipped: "Skipped" }[s.scheduledStatus] || "Result unavailable"}${s.scheduledChecked != null ? ` · ${s.scheduledChecked} containers checked` : ""}. ` : "";
  const help = `<details class="container-help"><summary>How checks work</summary><p>${specific}</p><p>Container checks in Fleetdeck scheduled rounds: <strong>${state.settings.scheduled_container_checks ? "included when the provider is enabled" : "off"}</strong>. Manual checks are separate; provider permissions still apply.</p><p>${esc(schedule)}Synced is when reports were fetched. Last checked is the confirmed result or latest failed attempt for each row. ${state.settings.dockhand_results_persistent === false ? "State storage is unavailable; results last until restart." : "Confirmed results are saved across Fleetdeck restarts using its state storage."} Unknown means no result could be reliably matched to this container; missing data is never a healthy zero. A locally built image has no registry counterpart, so repeating a check cannot resolve that coverage limit. Counts can overlap for the same container. The per-machine Update button installs OS packages only.</p></details>`;
  const categoryNote = filter === "coverage" && !native ? '<p class="container-notice-line muted">Local images have no registry counterpart, so repeating a check cannot compare them. Policy exclusions are intentional; new or replaced containers need a fresh matching result.</p>' : filter === "review" ? '<p class="container-notice-line muted">New version tags and pinned digests require manual review. Held image updates wait for their cooldown. These items are separate from applicable image updates.</p>' : "";
  const scope = native ? '<p class="container-notice-line muted">Coverage: Compose stacks only. Standalone containers are outside Fleetdeck checks.</p>' : "";
  const prune = native && dockerSettings(v).mode === "managed" ? `<label class="container-prune muted" title="Removes all unused, untagged images on this machine, not only this stack"><input type="checkbox" data-prune ${remember.get("pruneImages") ? "checked" : ""}> remove unused, untagged images after updating</label>` : "";
  return `<section class="group docker-host" id="docker-${id}"><div class="group-head">${icon("boxes")}${esc(v.target.name)}<span class="host-mode muted">${esc(mode)}</span>${button}${native ? `<button class="small" data-docker-settings="${id}">Settings</button>` : managerLink(v, "Open Dockhand")}</div><div class="container-overview"><p class="container-sync muted">${native ? "Last native check" : "Synced"} ${s.syncedAt ? ago(s.syncedAt) : "never"}${!native ? ` · Last requested check: ${s.checkedAt ? ago(s.checkedAt) : "never"}` : ""}${s.stale ? " · last-known results" : ""}</p><p class="container-summary" role="status">${esc(counts)}</p>${notices}${scope}${prune}${help}${categoryNote}${filters}</div>${shown.length ? table : `<p class="container-empty muted">${s.rows.length ? "No matching per-container results in this category." : native ? (!v.stacks ? "Container images have not been checked. Fetch image updates to compare Compose images; nothing is restarted." : "No Docker Compose stacks found. Standalone containers are not checked by Fleetdeck; their update status is unknown.") : "Container status unavailable."}</p>`}</section>`;
}

function dockhandPanel(v) { return containerPanel(v); }
function stackPanel(v) {
  if (v.dockhand || dockerEnabled(v)) return containerPanel(v);
  const policy = dockerSettings(v), id = esc(v.target.id);
  return `<section class="group docker-host" id="docker-${id}"><div class="group-head">${icon("boxes")}${esc(v.target.name)}<span class="host-mode muted">${esc(policy.mode === "disabled" ? "Disabled" : `Managed by ${policy.manager_name}`)}</span><button class="small" data-docker-settings="${id}">Settings</button></div><p class="container-empty muted">${policy.mode === "disabled" ? "Docker checks and deployments are disabled. OS updates remain independent." : "Container checks and deployments are handled by the configured external manager."}</p>${policy.mode === "external" ? `<p class="container-empty">${managerLink(v, `Open ${policy.manager_name}`)}</p>` : ""}</section>`;
}
