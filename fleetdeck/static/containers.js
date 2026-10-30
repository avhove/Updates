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
    stale: !!r?.error || (!v.target.updatable && !!r), error: r?.error, checkedAt: r?.checked_at, syncedAt: r?.checked_at };
}

function containerSummary(v) {
  const view = containerView(v), rows = view.rows, facts = rows.map(containerFacts);
  const count = key => facts.filter(f => f[key]).length;
  const useful = facts.some((f, i) => f.update || f.current || (f.review && rows[i].image_update === false && !f.failure && rows[i].status !== "unknown"));
  return { ...view, updates: count("update"), reviews: count("review"), coverage: count("coverage"), failures: count("failure"),
    current: count("current"), usable: useful, unknown: !useful, value: useful ? count("update") : "—" };
}

function containerStatus(v) {
  const policy = dockerSettings(v), s = containerSummary(v);
  let symbol = "help", label = "Not checked", tone = "muted";
  if (policy.mode === "disabled") label = "Disabled";
  else if (!v.dockhand && !dockerEnabled(v)) { symbol = "external"; label = "Managed externally"; }
  else if (s.checking) return '<span class="status-inline muted"><span class="spin"></span>Checking containers…</span>';
  else if (s.error || s.checkError) { symbol = "alert"; label = "Check unavailable"; tone = "bad"; }
  else if (s.stale && s.rows.length) { symbol = "clock"; label = "Last-known results"; }
  else if (s.failures) { symbol = "alert"; label = s.usable ? "Partial results" : "Check failed"; tone = s.usable ? "warn" : "bad"; }
  else if (s.historyError || s.scheduledStatus === "failed") { symbol = "alert"; label = "History warning"; tone = "warn"; }
  else if (s.updates) { symbol = "boxes"; label = "Updates available"; tone = "container-tone"; }
  else if (s.reviews) { symbol = "tag"; label = "Review needed"; tone = "container-review-tone"; }
  else if (s.coverage) { symbol = "info"; label = "Coverage exceptions"; }
  else if (s.current) { symbol = "check"; label = s.provider === "native" ? "Compose up to date" : "Up to date"; tone = "ok"; }
  return `<span class="status-inline ${tone}">${icon(symbol)}${label}</span>`;
}

function containerCheckTime(v, withLabel = false) {
  const policy = dockerSettings(v), s = containerSummary(v);
  if (policy.mode === "disabled") return '<span class="muted">Disabled</span>';
  if (!v.dockhand && !dockerEnabled(v)) return '<span class="muted">External manager</span>';
  const relevant = s.rows.filter(r => !["local", "excluded"].includes(r.status));
  const dated = relevant.filter(r => r.checked_at && Number.isFinite(Date.parse(r.checked_at)));
  const times = dated.map(r => Date.parse(r.checked_at));
  if (!times.length) {
    if (s.provider === "native" && s.checkedAt && s.error) return `<span title="Latest native container check attempt">${withLabel ? "Attempt " : ""}${ago(s.checkedAt)}<span class="cell-detail">Latest attempt</span></span>`;
    return `<span>${s.rows.length && !relevant.length ? "Not applicable" : "Not checked"}</span>`;
  }
  const newest = new Date(Math.max(...times)).toISOString(), oldest = new Date(Math.min(...times)).toISOString();
  const age = ago(newest) === ago(oldest) ? ago(newest) : `${ago(newest)} – ${ago(oldest)}`;
  const attempts = dated.filter(r => containerFacts(r).failure || r.check_issue === "missing_result").length;
  const unchecked = relevant.length - dated.length;
  const notes = [attempts ? attempts === dated.length ? "Latest attempts" : `${attempts} ${plural(attempts, "attempt", "attempts")}` : "", unchecked ? `${unchecked} unchecked` : "", s.stale ? "Last known" : ""].filter(Boolean);
  const title = `Container results and attempts, not inventory sync. Newest: ${window.FleetdeckDates.dateTime(newest)}. Oldest: ${window.FleetdeckDates.dateTime(oldest)}.${notes.length ? ` ${notes.join("; ")}.` : ""}`;
  return `<span title="${esc(title)}">${withLabel ? "Checked " : ""}${esc(age)}${notes.length ? `<span class="cell-detail">${esc(notes.join(" · "))}</span>` : ""}</span>`;
}

function containerRowAction(v) {
  const policy = dockerSettings(v);
  if (policy.mode === "disabled") return "";
  if (v.dockhand || policy.mode === "external") return managerLink(v, `Open ${policy.manager_name || "manager"}`);
  return `<button class="small" data-open-docker="${esc(v.target.id)}" data-container-filter="all" data-focus-key="container-details:${esc(v.target.id)}" aria-expanded="${state.containerExpanded.has(v.target.id)}">View stacks</button>`;
}

function containerScope(v) {
  const policy = dockerSettings(v), external = !!v.dockhand || policy.mode === "external";
  const manager = policy.mode === "disabled" ? "Container checks disabled" : external ? `Managed externally by ${policy.manager_name || "manager"}` : "Fleetdeck native Docker · Compose only";
  return `Containers<span class="scope-provider" role="img" aria-label="${esc(manager)}" title="${esc(manager)}">${icon(external ? "external" : "server")}</span>`;
}

function dockerCell(v, withManager = true) {
  if (!hasDocker(v)) return "";
  const empty = filter => `<span class="metric-slot-empty" data-metric-slot="${filter}" aria-hidden="true"></span>`;
  const policy = dockerSettings(v);
  if (policy.mode === "disabled") return `<span class="container-indicators">${["all", "review", "coverage", "failures"].map(empty).join("")}</span>`;
  if (!v.dockhand && !dockerEnabled(v)) return `<span class="container-indicators"><button class="container-metric-hit" data-container-filter="all" data-open-docker="${esc(v.target.id)}" aria-label="Container status managed externally; view details">${icon("boxes")}—</button>${["review", "coverage", "failures"].map(empty).join("")}</span>`;
  const s = containerSummary(v), id = esc(v.target.id), selected = state.containerFilters?.[v.target.id] || "all";
  const manager = s.provider === "dockhand" ? "Managed externally by Dockhand" : "Managed by Fleetdeck native Docker";
  const badge = (filter, symbol, value, label, tone) => `<button class="container-metric-hit container-indicator ${tone || ""}" data-open-docker="${id}" data-container-filter="${filter}" data-focus-key="docker:${id}:${filter}:${symbol}" aria-expanded="${state.containerExpanded.has(v.target.id) && selected === filter}" title="${esc(label)}" aria-label="${esc(`${label}. ${manager}. View container details`)}"><span class="update-metric ${tone || ""}">${symbol === "spin" ? '<span class="spin"></span>' : icon(symbol)}${value === null ? "" : `<span>${value}</span>`}</span></button>`;
  const label = s.usable ? `${s.updates} ${plural(s.updates, "container with an image update", "containers with image updates")}${s.stale ? " · last-known results" : ""}` : "Container update count unavailable";
  let body = badge("all", "boxes", s.value, label, `container${s.stale ? " last-known" : ""}${s.unknown ? " unknown" : ""}`);
  body += s.reviews ? badge("review", "tag", s.reviews, `${s.reviews} containers with version / pinned-digest advisories or held updates`, "container-review") : empty("review");
  body += s.coverage || s.scopeGap ? badge("coverage", "coverage", s.coverage || null,
    s.scopeGap ? "Compose-only coverage: standalone containers and newer-version tags are outside Fleetdeck native checks" : `${s.coverage} coverage ${plural(s.coverage, "exception", "exceptions")}: local, excluded, new or unmatched containers`, "container-coverage") : empty("coverage");
  body += s.failures ? badge("failures", "alert", s.failures, `${s.failures} ${plural(s.failures, "latest container or stack check failed", "latest container or stack checks failed")}; known updates are retained`, "container-failure") : empty("failures");
  return `<span class="container-indicators">${body}${withManager ? `<span class="container-manager-symbol" role="img" aria-label="${esc(manager)}" title="${esc(manager)}">${icon(s.provider === "dockhand" ? "external" : "server")}</span>` : ""}</span>`;
}

function containerResult(row) {
  const f = containerFacts(row), lines = [], add = (tone, symbol, text, tip = "") => lines.push(`<div class="container-result ${tone}">${icon(symbol)}<span${tip ? ` title="${esc(tip)}"` : ""}>${esc(text)}</span></div>`);
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
  if (row.status === "unknown") add("muted", "info", "Check result unavailable", "Fleetdeck has no result it can reliably match to this container. Request a fresh check; if it remains unavailable, inspect the result in your container manager.");
  return lines.join("") || '<span class="muted">No confirmed check result</span>';
}

function containerCheckGuidance(v, s) {
  const native = s.provider === "native", policy = dockerSettings(v);
  const scheduled = !!state.settings.scheduled_container_checks;
  const interval = state.schedule?.check_every;
  const hasSchedule = Number.isFinite(interval) && interval > 0;
  const allowed = native ? dockerEnabled(v) && !v.target.check_only : !!state.settings.dockhand_checks_allowed;
  let outcome;
  if (!hasSchedule) outcome = "Fleetdeck’s schedule is off. It will not start container checks automatically.";
  else if (!scheduled) outcome = "Fleetdeck’s scheduled rounds will not request container checks.";
  else if (!allowed) outcome = native ? "Scheduled container checks are on, but native checks are disabled for this machine." : "Scheduled container checks are on, but Dockhand check permission is disabled. Enable dockhand.allow_checks to allow fresh checks.";
  else if (v.target.check_only) outcome = "Fleetdeck’s scheduled container checks skip this check-only machine.";
  else outcome = `Fleetdeck requests fresh ${native ? "Compose image" : "Dockhand"} checks every ${every(interval)}.`;
  if (!native) outcome += " Dockhand’s own schedule is unchanged.";
  outcome += allowed ? " Manual fresh checks are enabled." : " Manual fresh checks are disabled.";
  const settings = `<section class="container-check-settings" aria-label="Current container check settings"><strong>Current settings</strong><dl><div><dt>Container provider</dt><dd>${native ? `Fleetdeck native Docker${policy.mode === "monitor" || v.monitor_only ? " · monitor only" : ""}` : "Dockhand"}</dd></div><div><dt>Fleetdeck scheduled container checks</dt><dd>${scheduled ? "On" : "Off"}</dd></div><div><dt>Manual container checks</dt><dd>${allowed ? "Enabled" : "Disabled"}</dd></div><div><dt>Fleetdeck check interval</dt><dd>${hasSchedule ? `Every ${esc(every(interval))}` : "Scheduling off"}</dd></div></dl><p class="container-check-outcome">${esc(outcome)}</p></section>`;
  const options = native
    ? '<p><strong>Check manually.</strong> Native checks require <code>docker_enabled: true</code> and a Managed or Monitor only host policy. Use <strong>Check all</strong>, <strong>Check container updates</strong> or <strong>Fetch image updates</strong>. You will be asked to confirm image downloads.</p><p><strong>Also check on Fleetdeck’s schedule.</strong> Set <code>schedule.check_docker: true</code>. The interval comes from <code>schedule.check_every</code>. Set the flag to <code>false</code> to keep checks manual.</p><p><strong>What happens?</strong> Native checks download Compose images to compare them. They do not deploy or restart containers. <strong>Update stack</strong> recreates affected running services after confirmation; stopped services stay stopped. Native checks cover Compose stacks only; standalone containers and newer-version-tag advisories are not provided by this checker.</p>'
    : '<p><strong>Use Dockhand’s schedule.</strong> Set <code>schedule.check_docker: false</code>. Dockhand decides when to check registries. Fleetdeck automatically reads its saved reports; <strong>Refresh inventory</strong> reloads those reports without requesting another check.</p><p><strong>Also check on Fleetdeck’s schedule.</strong> Set <code>schedule.check_docker: true</code> and <code>dockhand.allow_checks: true</code>. Fleetdeck requests fresh checks at the interval in <code>schedule.check_every</code>. Dockhand’s own schedule continues unchanged, so either application can request a check.</p><p><strong>Allow manual checks.</strong> Set <code>dockhand.allow_checks: true</code>. You can then request a fresh check with <strong>Check all</strong>, <strong>Check container updates</strong> or <strong>Check in Dockhand</strong>, even when Fleetdeck’s scheduled container checks are off.</p><p><strong>What happens?</strong> Dockhand checks registry digests and metadata without downloading image layers or restarting containers. Install container updates in <strong>Dockhand</strong>. Automatic dashboard polling and <strong>Refresh inventory</strong> only read saved results.</p>';
  const schedule = !native && s.scheduledAt ? `<p class="container-schedule-report muted">Latest Dockhand scheduled check: ${esc(ago(s.scheduledAt))} · ${esc(({ success: s.scheduledErrors ? `Completed with ${s.scheduledErrors} ${plural(s.scheduledErrors, "check error", "check errors")}` : "Completed", failed: "Failed", running: "Running", warning: "Completed with warnings", queued: "Queued", skipped: "Skipped" })[s.scheduledStatus] || "Result unavailable")}${s.scheduledChecked != null ? ` · ${s.scheduledChecked} containers checked` : ""}.</p>` : "";
  const persistence = state.settings.dockhand_results_persistent === false ? "State storage is unavailable, so results last until restart." : "Confirmed results are saved across Fleetdeck restarts.";
  return `${settings}${schedule}<details class="container-help"><summary>Options and how to change them</summary>${options}<p><strong>How to set it.</strong> Open <a href="/settings">Settings</a>, edit the existing values, save, then apply/restart Fleetdeck. Set <code>schedule.check_every</code> to your desired interval if scheduling is off.${native ? " Host policies are available through this panel’s Settings button." : " Keep the Dockhand URL, token and environment mappings. For a Dockhand-only setup, keep <code>docker_enabled: false</code>."}</p><p>Unavailable machines and running or recently requested checks may be skipped. The machine’s <strong>Update</strong> button installs OS packages only.</p><p><strong>Reading the results.</strong> Synced means Fleetdeck fetched the reports. Last checked is each container’s result or labelled failed attempt. Unknown means no reliable result is available. Local images have no registry counterpart to compare. A container can have both an image update and a version advisory, so counts may overlap. ${persistence}</p></details>`;
}

function containerName(row) {
  const value = String(row.state || "unknown"), stateName = value.toLowerCase();
  const tone = stateName === "running" ? "running" : ["restarting", "paused"].includes(stateName) ? "paused" : stateName === "dead" ? "dead" : "stopped";
  const dot = row.nativeStack && !row.container_id ? "" : `<span class="container-runtime-dot ${tone}" role="img" aria-label="${esc(`Container ${value}`)}" title="${esc(value)}"></span>`;
  return `<div class="container-name-line">${dot}<span>${esc(row.name)}</span></div><div class="cell-detail muted">${esc(value)}</div>`;
}

function containerPanel(v) {
  const s = containerSummary(v), id = esc(v.target.id), dh = v.dockhand, native = s.provider === "native";
  const filter = state.containerFilters?.[v.target.id] || "all", compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const items = [...s.rows].sort((a, b) => compare(a.stack || "Standalone", b.stack || "Standalone") || compare(a.name, b.name) || compare(a.image, b.image));
  const shown = items.filter(row => filter === "all" || containerFacts(row)[({ review: "review", coverage: "coverage", failures: "failure" })[filter]]);
  const button = native ? `<button class="small" data-act="stacks" data-id="${id}" ${!canUpgrade(v.target) || v.active_job ? "disabled" : ""} title="Download newer Compose images to compare; confirmation is required">${icon("refresh")}Fetch image updates</button>`
    : `<button class="small" data-dockhand-check="${id}" ${!state.settings.dockhand_checks_allowed || s.checking ? "disabled" : ""} title="${state.settings.dockhand_checks_allowed ? "Request a fresh registry digest check; no image layers or restarts" : "Enable dockhand.allow_checks in Settings to allow fresh checks"}">${icon("refresh")}${s.checking ? "Checking…" : "Check in Dockhand"}</button>`;
  const mode = native ? `Fleetdeck native · ${dockerSettings(v).mode === "monitor" || v.monitor_only ? "monitor only" : "Compose"}` : "Dockhand";
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
  const table = `<div class="group-scroll"><table class="container-results-table ${native ? "native-container-table" : "dockhand-table"}" aria-label="${esc(v.target.name)} containers sorted by stack"><colgroup><col class="cr-name"><col class="cr-stack"><col class="cr-image"><col class="cr-status"><col class="cr-checked">${actions ? '<col class="cr-action">' : ""}</colgroup><thead><tr><th>${native ? "Service" : "Container"}</th><th>Stack</th><th>Image</th><th>Status</th><th>Last checked</th>${actions ? '<th>Action</th>' : ""}</tr></thead><tbody>${shown.map(row => `<tr><td class="container-name${native ? "" : " dockhand-name"}">${containerName(row)}</td><td data-label="Stack" class="muted">${esc(row.stack || "Standalone")}</td><td data-label="Image">${esc(row.image)}</td><td data-label="Status">${containerResult(row)}</td><td data-label="Last checked" class="muted" title="${esc(({ dockhand_schedule: "From Dockhand scheduled-check history", fleetdeck_button: "From a check requested through Fleetdeck", fleetdeck_schedule: "From a scheduled Fleetdeck check", fleetdeck_native: "From Fleetdeck native Compose checks" })[row.source] || "From Dockhand pending-update reports")}">${row.status === "excluded" ? "Excluded" : row.status === "local" ? "Not applicable" : row.checked_at ? `${containerFacts(row).failure || row.check_issue === "missing_result" ? "Attempt: " : ""}${ago(row.checked_at)}` : "Not checked"}</td>${actions ? `<td data-label="Action">${action(row)}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
  const notices = [s.checking ? '<p class="container-notice-line" role="status">Checking container images… Previous results remain last-known until completion.</p>' : "", s.error ? `<p class="container-notice-line bad" role="status">${esc(s.error)} Last-known results are shown where available.</p>` : "", s.checkError ? `<p class="container-notice-line bad" role="status">${esc(s.checkError)}</p>` : "", s.historyError ? `<p class="container-notice-line warn">${esc(s.historyError)} Confirmed manual results remain usable.</p>` : ""].join("");
  const guidance = containerCheckGuidance(v, s);
  const categoryNote = filter === "coverage" && !native ? '<p class="container-notice-line muted">Local images have no registry counterpart, so repeating a check cannot compare them. Policy exclusions are intentional; new or replaced containers need a fresh matching result.</p>' : filter === "review" ? '<p class="container-notice-line muted">New version tags and pinned digests require manual review. Held image updates wait for their cooldown. These items are separate from applicable image updates.</p>' : "";
  const scope = native ? '<p class="container-notice-line muted">Coverage: Compose stacks only. Standalone containers are outside Fleetdeck checks.</p>' : "";
  const prune = native && dockerSettings(v).mode === "managed" ? `<label class="container-prune muted" title="Removes all unused, untagged images on this machine, not only this stack"><input type="checkbox" data-prune ${remember.get("pruneImages") ? "checked" : ""}> remove unused, untagged images after updating</label>` : "";
  return `<section class="group docker-host" id="docker-${id}"><div class="group-head">${icon("boxes")}${esc(v.target.name)}<span class="host-mode muted">${esc(mode)}</span>${button}${native ? `<button class="small" data-docker-settings="${id}">Settings</button>` : managerLink(v, "Open Dockhand")}</div><div class="container-overview"><p class="container-sync muted">${native ? "Last native check" : "Synced"} ${s.syncedAt ? ago(s.syncedAt) : "never"}${!native ? ` · Last requested check: ${s.checkedAt ? ago(s.checkedAt) : "never"}` : ""}${s.stale ? " · last-known results" : ""}</p><p class="container-summary" role="status">${esc(counts)}</p>${notices}${scope}${prune}${guidance}${categoryNote}${filters}</div>${shown.length ? table : `<p class="container-empty muted">${s.rows.length ? "No matching per-container results in this category." : native ? (!v.stacks ? "Container images have not been checked. Fetch image updates to compare Compose images; nothing is restarted." : "No Docker Compose stacks found. Standalone containers are not checked by Fleetdeck; their update status is unknown.") : "Container status unavailable."}</p>`}</section>`;
}

function dockhandPanel(v) { return containerPanel(v); }
function stackPanel(v) {
  if (v.dockhand || dockerEnabled(v)) return containerPanel(v);
  const policy = dockerSettings(v), id = esc(v.target.id);
  return `<section class="group docker-host" id="docker-${id}"><div class="group-head">${icon("boxes")}${esc(v.target.name)}<span class="host-mode muted">${esc(policy.mode === "disabled" ? "Disabled" : `Managed by ${policy.manager_name}`)}</span><button class="small" data-docker-settings="${id}">Settings</button></div><p class="container-empty muted">${policy.mode === "disabled" ? "Docker checks and deployments are disabled. OS updates remain independent." : "Container checks and deployments are handled by the configured external manager."}</p>${policy.mode === "external" ? `<p class="container-empty">${managerLink(v, `Open ${policy.manager_name}`)}</p>` : ""}</section>`;
}
