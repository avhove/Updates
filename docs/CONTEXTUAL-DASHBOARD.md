# OS-focused dashboard preview

## Container status: native Docker and optional Dockhand

The dashboard supports three views with one consistent table:

- **All** shows an OS row and, where a provider is configured/discovered, a container row.
- **Machines** shows OS rows and OS package details only.
- **Containers** shows container hosts, container rows and container details only.

Machine identity, selection and optional backup context span both rows in All. The machine's
second line contains only its OS; type and policy badges stay beside its name. A single header
reads Machine, Scope, Status, Updates, Checked, Backup (when available), Actions. **Machine information** is available in each per-machine **…** menu. A container row has its own manager symbol, status,
independent update/review/coverage/failure metrics, check ages and provider-specific action.
The **Update** button keeps its name and appears exclusively on the OS row. Native Docker uses
**View stacks**, with the existing confirmed **Update stack** action inside details; external
management links to the configured manager. Neither tab selection nor expanding details starts a check.

Both providers share the same compact details panel and flat table sorted by Stack then
container/service name (case-insensitive, natural ordering). Containers without Compose metadata
are labelled Standalone. Clicking each metric opens its corresponding details filter. Counts can
overlap for one container. Mobile cards use the same separate OS/container sections and actions,
with shared identity and backup context and no bulk-selection controls.

For a Dockhand-managed host, configure an exact mapping. This automatically blocks native Docker jobs on that host:

```yaml
dockhand:
  url: https://dockhand.example
  token: ${FLEETDECK_DOCKHAND_TOKEN}
  poll_seconds: 300
  allow_checks: false
  environments:
    - target_id: your-exact-fleetdeck-target-id
      environment_id: 1
```

Replace the example target ID with an exact ID from the authenticated `/api/targets` response,
and use the environment ID from Dockhand. Names and addresses are never used to guess a match.
Supply the token in the server environment, never in frontend code. Normal TLS verification
stays enabled; redirects are rejected so the bearer token cannot follow a different origin.
Create a dedicated Dockhand token with the least permissions supported by your installation.
The token is not returned in the dashboard status API. Configuration remains accessible through
the existing authenticated Settings editor, so protect access to that page as before.

Dockhand integration is opt-in and polls only while the dashboard requests inventory, at most
once per interval per process during ordinary polling. **Refresh inventory** bypasses that
interval to fetch the latest cached Dockhand reports immediately. **Refresh inventory** only
rediscovers machines and reads saved reports, even when `dockhand.allow_checks` is enabled.
It does not trigger an OS or registry update check. Results of checks run by Dockhand appear on the next
successful sync when exposed by its cached API; missing successful-check history remains unknown.
Ordinary automatic polling and inventory GETs use only read-only requests: `GET /api/containers?env=ID`,
`GET /api/containers/pending-updates?env=ID`, and the scheduled-check history described below. These read-only polling requests never trigger checks, pulls, deployments, pruning or restarts.
Scheduled rounds are separate and follow `schedule.check_docker` as described below. It reads both Compose labels and standalone containers. **Open Dockhand**
opens the configured manager URL; deployment and self-update stay with that manager.

### Scheduling and provider boundaries

The application supports native Docker, Dockhand and a mixed fleet. Shared wording uses
**container checks**; provider-specific controls describe the actual operation.

| Requirement | Fleetdeck native Docker | Dockhand |
| --- | --- | --- |
| Provider enabled | Available by default, eligible managed/monitor host | Exact environment mapping |
| Permission for a fresh check | Existing native policy | `dockhand.allow_checks: true` |
| Included in Fleetdeck scheduled rounds | Also `schedule.check_docker: true` | Also `schedule.check_docker: true` |
| Check operation | Pull Compose images to compare | Query registry digests and metadata |
| Deploy operation | Existing confirmed **Update stack** | Open Dockhand |
| Coverage | Compose services only | Containers exposed by Dockhand, including standalone |

`schedule.check_docker: false` disables fresh container checks in Fleetdeck scheduled rounds
for **both** providers. It does not disable explicit manual checks. Dockhand mappings block native
fallback on their hosts. Per-machine Disabled or External policies block native jobs elsewhere.
The flag never edits Dockhand's own schedule. Its independent scheduled runs continue normally.

**Check all** and global **Check container updates** route to both enabled providers. If any
native hosts participate, a confirmation explains image downloads before container checks start;
cancelling starts neither provider's container checks. The top control's OS checks are independent.
The per-machine menu offers separate OS and container checks. **Refresh inventory** and ordinary
polling only discover machines and read saved reports. Opening details and changing filters never
start checks. Manual container actions do not install updates or restart containers.

Scheduled requests use the same provider guards, target mappings, concurrency and minimum-start
interval as manual requests, skip hidden/check-only machines and never retry a refused start.
Native monitor-only policies still permit checks but block deployment. Dockhand results remain in
its provider status; the existing OS notification report is not extended to send Dockhand alerts.

### Shared details and simultaneous findings

Both the inline details and Containers tab use the same compact panel, flat table sorted by Stack
then container/service name, and All / Review / Coverage / Failures filters. The explanation lives
in collapsed **Options and how to change them** help; the summary, active warnings and provider scope stay visible.
Native controls preserve the original pull confirmation, prune preference, stack-update confirmation,
monitor-only restrictions and dashboard self-update protection. Native checks do not provide
standalone checks or newer-version-tag detection; the panel explicitly states those limitations.

| Case | Presentation and handling |
| --- | --- |
| Confirmed current | Up to date and confirmed check time |
| Image update | Blue image-update count and row finding |
| New version tag | Purple Review count; manual tag change, separate from current-tag result |
| Image update plus new tag | Both findings and counts, never collapsed to one status |
| Local image | Coverage exception; no registry comparison, repeating checks cannot resolve it |
| Policy exclusion | Coverage exception; intentionally excluded, not healthy or failed |
| New/replaced/unmatched container | Coverage exception and no confirmed result; no healthy zero |
| Cooldown / pinned digest | Review finding; no directly applicable image-update count |
| Registry rate limit/auth/timeout | Separate failure; keep earlier positive update/advisory with its time |
| Check running | Spinner and progress notice; existing results remain last-known |
| Sync failure / unavailable history | Visible warning; keep usable saved results, missing counts stay unavailable |

Independent optional fields preserve image updates, newer tags, digest pins, cooldowns, failure
categories and finding timestamps together. The legacy status remains accepted for old saved data.
A newer success clears obsolete findings; a failed or partial result cannot erase a previously
confirmed positive finding for the same container ID and image. Unknown or failed current-tag
checks never become green just because an earlier result was current. Raw errors/logs/tokens are
not exposed; error categories use fixed labels. Cached-result identity, timestamp and permission
safeguards remain in force.

### Automatic history sync and the Docker panel explanation

Dockhand owns its schedule. Fleetdeck reads the latest environment update-check execution via
`GET /api/schedules/executions?environmentId=ID&scheduleType=env_update_check&limit=1` and,
for a completed run, `GET /api/schedules/executions/EXECUTION_ID`. This requires read access
to schedules (and the mapped environment) in addition to containers; no edit/manage permission
is needed for history syncing. A 403, unsupported API or malformed response shows a history
warning while keeping container inventory available. Redirects remain disabled.

The Docker details panel explains the mechanism directly:

- **Synced**: when Fleetdeck fetched Dockhand's saved reports; this is not a registry check.
- **Dockhand scheduled check**: the latest reported run's time, state and summary counts.
  A successful run with container errors is labelled as having errors, never blanket success.
- **Last checked**: a container's confirmed result time, with a tooltip identifying its source.
- **Check in Dockhand**: the existing opt-in, confirmed request for a fresh registry check.
  **Check all** requests OS and enabled container-provider checks; the dashboard container-only
  menu requests container checks through each machine’s provider. Dockhand queries registry digests and metadata; it does not download image layers, change schedules,
  deploy images or restart containers.
- **Unknown / No confirmed check result**: no result can be reliably matched to this container.
  An empty pending list is never converted to an up-to-date result.

Dockhand v1.0.56 records per-container scheduled outcomes in execution logs rather than a complete
structured result list. The reader recognises explicit timestamped results only for an exact,
unique container name and image, with a creation time predating the run. Recreated containers,
missing creation times, changed images, ambiguous names, unrecognised log formats and incomplete
runs cannot establish a new healthy result. Pending records and newer button results take
precedence by check timestamp. Errors, local images, pinned/version advisories and cooldowns
remain distinct. No raw execution logs or upstream error bodies are exposed or stored.

Confirmed outcomes and the last inventory are stored in the existing state database under a
key scoped to manager URL, environment ID and Fleetdeck target ID; tokens are never stored in
this cache. Retired container records are pruned on sync. Corrupt cache records are ignored,
remapped environments cannot inherit them, and an in-flight check is never resumed. Without
persistent state storage the panel explicitly explains that results last only until restart.
Dockhand retains its own schedule. Ordinary dashboard polling and individual OS checks never
press the Dockhand button. Fleetdeck can additionally include provider checks in its own scheduled
rounds when the overall `schedule.check_docker` flag is true. With `allow_checks: true`,
manual Dockhand controls have these scopes:

| Control | OS checks | Fresh Dockhand digest checks |
| --- | --- | --- |
| Top **Check all** | Yes | Yes |
| Menu **Check OS updates** | Yes | No |
| Menu **Check container updates** | No | Yes |
| Menu **Refresh inventory** | Inventory refresh only | No |
| Machine menu **Check OS updates** | This machine only | No |
| Machine menu **Check container updates** | No | This machine only |
| Per-machine **Update** | Installs OS packages | No |

The container-only menu entry is disabled when explicit checks are not enabled, and is hidden
when there are no visible container hosts. Native hosts use their original confirmed check workflow;
Dockhand hosts use their mapped environment. Check requests skip hidden machines and
checks already running. All writes use the authenticated, CSRF-protected `POST /api/dockhand/check`
endpoint for exact mapped IDs. No native Docker jobs are submitted by these Dockhand controls. The existing four-check and thirty-second limits still
apply; checks that cannot start are reported visibly and never automatically retried. The **Checked** column always refers to the scope of that row, not the inventory sync time.

The parser is based on [Dockhand v1.0.56's scheduled check implementation](https://github.com/Finsys/dockhand/blob/v1.0.56/src/lib/server/scheduler/tasks/env-update-check.ts)
and [its execution history API](https://github.com/Finsys/dockhand/blob/v1.0.56/src/routes/api/schedules/executions/%2Bserver.ts).
Unsupported future log formats remain unknown instead of being guessed healthy.

### Explicit Dockhand image checks

Set `dockhand.allow_checks: true` and apply/restart to enable **Check in Dockhand**. Exact
mappings prevent native Docker jobs on those hosts. The check button opens a confirmation naming
the mapped machine. Confirming that dialog, or explicitly clicking the dashboard's
**Check container updates** menu item or top **Check all** button, uses the authenticated, CSRF-protected `POST /api/dockhand/check` endpoint for each
exact configured environment.
Browser input cannot supply a manager URL, environment ID or arbitrary API path.

The sole outgoing write is `POST /api/containers/check-updates?env=ID`, with
`Accept: application/json` to capture Dockhand's full per-container result. This compares registry
digests and metadata without downloading image layers; it does not deploy images, recreate
containers, prune, restart or change native Docker
policy. Each request runs in the background with a three-minute bound. The UI shows **Checking…**
while the complete result is pending; no artificial progress counts are displayed. Checks are
limited to one per environment, four globally, and at least thirty seconds between starts.
They are never automatically retried or resumed after a Fleetdeck restart. Fleetdeck scheduled
rounds can request them only when both `schedule.check_docker` and `dockhand.allow_checks` are true.

Successful `hasUpdate: false` results can establish **Up to date**, with a check timestamp.
Failures, local-only images, exclusions, advisories and cooldowns remain distinct. Source error
bodies are not exposed. Confirmed results survive polling and are saved in Fleetdeck's existing
state database when configured, while container ID and image still match; newer pending reports
take precedence. Whole-check failures retain
previous data with a visible error. A timeout or Fleetdeck restart does not cancel an operation
already running in Dockhand; check Dockhand before trying again. Restored data starts stale until
inventory is synced. Missing successful check history remains unknown until a matching scheduled
result or an explicit button check provides it.

The supplied mixed-management demo enables this opt-in but simulates the entire check in memory.
It never sends a Dockhand request. Existing configured integrations remain cached-status-only
unless the user explicitly enables `allow_checks`.

Verification of explicit checks: 131 focused backend tests passed (one existing skip and
one Linux boot-ID test deselected), and all 30 offline UI tests passed. These cover opt-in,
authentication/CSRF, mapping restrictions, duplicate starts, complete/partial results,
redirect refusal, cached reconciliation, confirmation/cancellation and simulated demo checks.
No live Dockhand environment was contacted. The history-sync revision was also reviewed in the
local browser with simulated machines; native-device appearance still needs a device check.

### Two-row layout and scope views

All is the default combined view when containers are enabled. The earlier remembered Machines
view migrates to All because it previously contained both scopes; explicit new choices are
remembered separately. An existing remembered Containers view remains Containers. Without native
Docker or Dockhand, the app falls back to the OS-only Machines view and hides the scope tabs.

OS and container details retain independent expansion state but are rendered only in applicable
views. Switching to Containers clears OS bulk selection and incompatible OS KPI filters. Switching
to Machines clears a container-only KPI filter. Container-only groups preserve their host heading
without adding OS-only parent rows. Global Check all and separate check menus keep their existing
provider scopes regardless of the selected tab. The native bulk-fetch tool remains in Containers.

The original OS/security/reboot/recheck KPI filters remain available, with explicit OS captions
where applicable. An additional container-image-update KPI appears when container hosts exist;
it selects the Containers view. Selecting targets and Update selected remain OS operations.

Each row owns its check time. OS failures show the latest attempt; stale OS snapshots remain
last-known. Container ages come from matching result/attempt timestamps, excluding local and
policy-excluded records. Different ages show a range, unmatched records show an unchecked count,
and failed/partial attempts are labelled. Empty data never borrows the inventory sync or last
requested-check time. Synced remains inside container details. Disabled/external-without-reader
providers retain explicit policy labels rather than invented successful check times.

Desktop columns have content budgets (selection 30, identity 230, scope 90, status 164, metrics
188, checked 112, optional backup 98, actions 144 px), distributed across the table width.
Machine names and badges retain full accessible/hover labels. Cards start below 1120 px;
checked results, update counts and per-scope actions wrap without page overflow. Horizontal
boundaries separate machines, lighter boundaries separate OS/container rows, and vertical
boundaries consistently separate identity, backup and actions. Single-scope views use normal
cells; combined identity/backup cells span exactly two rows, never expanded detail panels.

The pending endpoint is not a complete successful-check history. A missing pending record,
an unsupported older API response or an empty environment inventory must not become **Up to date**.
The detail table says **No confirmed check result** when no reliable outcome is available.
Version/pinned-digest advisories, policy exclusions and deferred updates are separate statuses;
only explicit `hasImageUpdate: true` records outside cooldown count as updates. Report times
describe Dockhand's cached records, not a new registry check by Fleetdeck. Poll failures retain
the last successful inventory with a stale notice and muted last-known counts. With no usable
results, the update metric shows `—`; coverage and failure indicators explain why. Saved results are restored
stale after a restart, then reconciled with current inventory. No source error bodies or tokens are sent to the browser.

For mixed management, native Docker is available by default; map Dockhand hosts as above. Configured mappings override saved per-host settings
and block native Docker jobs at submission, execution and resume, and skip native discovery.
They can be changed through each machine’s Docker management dialog, with Save then Apply. Live mappings
continue to guard native jobs until Apply. Scheduled and bulk native checks
exclude those hosts. Existing per-host external/disabled/monitor policies remain enforced.
Use per-machine Disabled policies for other hosts whose containers Fleetdeck should not check.

Fleetdeck's native implementation still checks Compose stacks only. Its metric counts
outdated running services, not stacks, and its action remains **Update stack** with the existing
confirmation and protections. No Compose stacks means `—`, not a healthy zero. Even when a
Compose result is current, the detail panel states that standalone containers are outside its
coverage. Rebooting a machine interrupts its containers regardless of manager.

Demo mode never creates a Dockhand HTTP reader or contacts a configured manager. The new
integration is tested with in-memory HTTP responses and fake machines. No live configuration
is included, and no deployment is needed to review the source branch.

To review mixed management locally, use the supplied fake-machine config with isolated state:

```sh
FLEETDECK_CONFIG=config.docker-demo.yaml FLEETDECK_DATA=/tmp/fleetdeck-container-demo \
  HOST=127.0.0.1 PORT=8081 python -m fleetdeck
```

This demo explicitly enables native features only on fake executors. `docker-vm` shows
synthetic Dockhand stack and standalone records, with external links disabled. `pi4` uses
the existing simulated Compose workflow; run its **Check** and **Fetch image updates** actions
to populate native status. No Docker installation or Docker socket is needed. Never add real
hosts, config, keys or production data to this demo.

Branch verification: 205 focused Python tests passed across Dockhand, Docker policies, app,
configuration, jobs, scheduler, security, setup, stacks, store, backups and repository hygiene.
Five existing tests skipped; eleven shell/platform-dependent tests were deselected after
reproducing the macOS boot-ID, port-tool and restricted sudo incompatibilities. All 29 offline
UI tests passed, including Dockhand with native Docker disabled, desktop/mobile expansion,
unknown/stale states, escaped source content and no action requests on open. Ruff, JavaScript
syntax and diff checks passed. Rendered browser appearance still needs a visual review; no
homelab or live Dockhand endpoint was contacted, and no container image was deployed.

This fork changes the dashboard, not the OS upgrade commands or snapshot implementation.

## What changes

- Four compact summary cards: machines needing updates, machines with security updates,
  machines requiring a reboot, and machines needing recheck. Updates and Security include the
  last successful results for offline/failed machines; those machines can also count toward recheck.
  Reboot uses current successful results only. Unchecked machines count toward recheck but do not
  imply known updates. Phased-only packages and hidden machines stay outside update/security totals.
  Labels use the correct singular/plural form, and the
  overview shows when the next automatic check will run.
  Clicking a card filters the machine list; clicking it again clears the filter. Parent nodes
  remain visible for context, with selection and the main action disabled when they do not match.
  KPI totals continue to describe the full inventory. Selections outside a filter are cleared.
- A short toolbar: **Check all**, with less frequent tasks in a compact icon-led menu.
  The menu separates inventory tasks from backup and notification tools, and marks the
  optional hidden-machine view without changing the menu label.
- Machine identity uses a name/type/policy line and an OS-only second line. The All view
  adds a container row only for applicable hosts; Machines and Containers isolate their scopes.
  Status, update metrics, Checked and Actions are shared columns, never shared check results.
- Nonzero Security, Package and Phased metrics and the reboot indicator share the OS Updates
  cell. Metrics and the OS status control open package details. Container metrics open the
  same provider-neutral details used in the Containers view. Existing status colors remain:
  OS and container updates purple, review items amber, reboot gold, confirmed current green, failures red.
  Missing and stale results remain explicit; opening a control never submits an operation.
- Dashboard and machine menus share item spacing, text, icon sizing and hover treatment.
  Machines and Settings include an icon on the Dashboard button, Back up & restore, and Test
  notifications when notification targets are configured. Shared handlers open the encrypted-backup
  dialog directly on the current page and preserve passphrase checks, preview and explicit restore
  confirmation. Loading these pages never sends notifications or starts a backup.
- Machines and Settings have separate URLs and separate entries in More. `/machines` contains
  connection security (permanently expanded above the connection cards), scripts and connection
  management. `/settings` contains the full YAML editor, with validation, read-only handling and
  the existing separate apply/restart step. `/setup` retains the first-run setup-code and admin
  creation flow, and remains a compatible machine-management entry after setup. All pages and APIs
  retain the existing authentication and request protections; connection scripts are unchanged.
- Absolute dates in information popovers and dashboard/setup restore previews use
  **yyyy-mm-dd HH:mm:ss**, in the browser's local time zone with a 24-hour clock.
  Relative ages such as **2 h ago** remain unchanged.
- Apt packages deferred by Ubuntu/Debian phasing are detected with read-only simulations.
  Packages that apt lists separately as not upgrading, but which become installable when only
  the phase policy changes, are included in the green **Phased** count and identified as
  **Waiting** in the detail table. They are excluded from actionable counts and update jobs.
- Status shows **Up to date**, **Updates available**, **Check failed**, **Not running** or **Offline**.
  Actions shows one next action: **Update**, **Check**, **Retry**, or **Reboot**. When updates and a
  reboot are both needed, Update takes priority; manual reboot remains in More and the existing
  update confirmation can request reboot afterwards. A current reboot requirement uses a small
  gold box in the OS Updates cell, including when configuration prevents rebooting. Empty cells
  do not show placeholder dashes or an ambiguous Unknown reboot value.
- Failed checks preserve the last successful package/reboot snapshot separately in persistent
  state. Offline or failed machines show muted last-known package counts, expandable with a
  **Last known · age** notice. These results are included in update/security KPIs and their filters,
  but are excluded from update selection and actionable buttons; a stale
  reboot requirement is explained in Info rather than presented as current. Info also includes
  the latest error, attempt time and last successful check time. A successful check clears the snapshot.
  Historical results lost before this version cannot be recovered.
- Per-machine **More** menus use icons and concise labels for checks, configuration backups,
  hiding and any optional command-console or Docker actions that are actually available.
- Backup age and job coverage share one compact cell: a neutral calendar icon appears only
  when a backup job covers the machine. A muted dash means no backup was found or backup
  information could not be read; Info explains which. Proxmox node configuration-backup cells stay blank.
  A job may exist even when Last backup is a dash. Ages use hours, days and weeks without changing job coverage.
  Exact dates, storage, counts, verification, job coverage and backup notes live in one neutral
  information popover opened from **Machine information** in the **…** menu; repository notes remain available there.
- Selecting machines reveals the bulk-update bar. Updates and reboots retain their confirmation dialogs.
  The update dialog has a compact machine summary and aligned options. Snapshot first follows
  `snapshot_before_upgrade` for eligible guests, matching upstream. Reboot if required starts
  unchecked each time. Both options are visible and can be changed before confirmation.
  Each nonzero update type in the confirmation has its own icon, including mixed Security,
  Package and Phased counts. Phased packages stay green and marked as waiting. Machine restrictions
  and helper-script notes remain visible beneath the type summary.
- Platform/host groups and guest rows have a deterministic order, including after refreshes.
  Hosts use **Node** for Proxmox. A centered 2 px tree line uses compact guest indentation,
  rounded branches and an exact final endpoint to keep the hierarchy clear without wasting name
  space. Online and offline dots use matching green or red halos.
- The Fleetdeck logo links home, and dashboard/setup/login pages have a favicon.
- Narrow screens render dedicated machine cards with shared name/type identity and an OS-only
  second line. OS and container sections have their own status, metrics, check age and actions,
  following the selected view. Info stays accessible in every view. Backup age and job coverage
  remain shared context. Existing confirmations and provider action guards are preserved.
  Mobile cards have no selection controls; bulk selection remains available on desktop. Switching
  to mobile clears desktop selection so hidden bulk operations cannot remain pending. The toolbar
  places the controls on a separate row below the logo, shared across Dashboard, Machines and Settings. Icon controls are 44 px squares with even gaps; menus stay inside the viewport. Machine information is available through the card’s **…** menus. KPIs use two columns with extra inset for their numbers. Expanded package details retain a local
  horizontal scroller. Menus and confirmation dialogs stay within the mobile viewport.
  Layout switching and interactions were checked in the local browser with simulated machines at
  320, 390 and 430 px widths, and the desktop table at 1200 px. Native iPhone Safari still needs
  a device check.

Existing protections, authentication and CSRF protections remain in place.
This does **not** add an OMV-specific updater. The upstream monitor-only policy is supported: checks and counts stay visible, OS and Docker deployments are blocked, and reboot/backup actions retain their existing protections. Monitor-only can be enabled or removed from the machine menu, matching upstream; configuration-enforced restrictions remain locked. A neutral eye-only label beside the machine name on desktop and mobile shows the policy, and Machine information explains it. Previously saved restrictions remain enforced until explicitly removed.

## Docker follows the original provider model

Native Docker support is available by default, as in upstream Fleetdeck. OS checks detect the
Docker executable without accessing registries or pulling images. Newly installed Docker hosts
then gain a container row and appear in the Containers view. Native results cover Compose stacks
only; containers created with docker run are outside native coverage.

Dockhand mappings select Dockhand for those exact hosts and block native checks and deployments
there. Other hosts use Fleetdeck's native Docker support. Per-machine policies remain available:
Managed, Monitor only, External manager and Disabled. They are enforced for individual, bulk,
scheduled, queued and resumed jobs. Failed checks remain unknown rather than healthy zeroes.

Native image checks pull images after confirmation; they never restart containers. Stack updates
remain a separate confirmed action. `schedule.check_docker` is the original upstream opt-in for
scheduled image checks and defaults to false. In this fork it gates both providers; Dockhand
additionally requires `dockhand.allow_checks`. Inventory refresh and ordinary polling are read-only.

The former fork-only global Docker enable switch has been removed. Remove obsolete entries from
existing YAML; per-machine policies control restrictions instead. Dockhand mappings remain protected.

## Try it without connecting to the homelab

The ordinary `docker-compose.yml` still points to the upstream published image. That image
does not include this branch's changes. Use a source build for this preview:

```sh
git clone --branch feat/contextual-update-dashboard https://github.com/avhove/Updates.git
cd Updates
docker compose -f docker-compose.preview.yml up -d --build
```

Open `http://localhost:8081` on the Docker machine. From another computer, use an SSH tunnel:

```sh
ssh -N -L 8081:127.0.0.1:8081 your-user@your-docker-host
```

Then open `http://localhost:8081` on that computer. This demo is bound to loopback because it
has no login. It uses fake machines and a separate `fleetdeck-preview_preview-data` volume.
Do not mount production config, keys, data or the Docker socket into it; do not add real
machines to the demo. Stop it without deleting its volume:

```sh
docker compose -f docker-compose.preview.yml down
```

After reviewing the demo, back up the live Fleetdeck data before deploying any source-built
image against it. Keep the current image available for rollback. No live deployment is done
by the preview instructions. The inherited GitHub workflows require the upstream author's
self-hosted runner; pushing this branch alone does not publish a new container image.

## Development checks

```sh
python -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
ruff check .
ruff format --check .
pytest -q
pnpm install --frozen-lockfile
pnpm test
```

Use Python 3.12 and Linux for the full Python suite; some existing integration tests depend
on Linux `/proc`, GNU tools and permission to run local system commands. The Node tests
use an offline DOM with synthetic API responses; they do not open a browser or contact hosts.
Node dependencies are development-only and are not included in the runtime image.

### Preview verification

After integrating `main` through `281c4e5`: all 26 offline UI tests pass, including monitor-only
controls on desktop and mobile. The focused app, jobs, scheduler, providers, config, store,
Docker-policy, security, backup and setup suite passes 196 tests, skips 5 and deselects 4 existing
platform-dependent local-shell checks (Linux boot ID, wrapper shell, port check and downloaded
bootstrap execution). The upstream monitor-only job test explicitly enables Docker in its fixture
so it tests the monitor-only guard independently of this fork's global Docker-disabled default.
Ruff and diff checks pass. No homelab machines were contacted.

For the latest page split, shared tools and confirmation fixes: all 25 offline UI tests pass. They cover KPI
filters/reset, parent context, cross-group column structure, selection pruning, historical
counts, single/bulk update dialogs, cancellation, unchecked defaults and explicit option payloads.
Ruff and diff checks pass. The setup/security Python suite passes 55 tests and skips 4; three existing
shell tests were deselected after reproducing permission failures for local system commands in this
environment. The browser check used simulated machines for separate page navigation and mixed-type
confirmation icons. These checks do not contact homelab machines.
The 20 focused Python backup tests also pass after sharing the existing front-end backup handler.

For the status/actions and last-known-results revision: all 10 offline dashboard tests pass,
including failed/offline history, update/reboot priority, confirmation dialogs, selection,
backup-job coverage, column spans, escaped content and Docker-disabled behavior. The focused
Python suite passes 121 tests, skips 1 and deselects 2 after reproducing their existing macOS
incompatibilities (GNU `script` options and Linux `/proc` boot information). Ruff checks pass.
Browser access to the loopback demo was declined for this revision, so its rendered appearance
was not verified in a browser. No homelab machines were contacted.

In the restricted development environment: 398 Python tests passed, 6 were skipped, and 16 documented
platform/sandbox-dependent tests were deselected after a full run reproduced those same failures.
All 8 offline dashboard tests, JavaScript syntax checks and Ruff checks passed. Browser visual
verification used only the built-in simulated machines; a Docker image build was not completed in
this environment. No real homelab machines were contacted or updated during development.

### Dockhand history and manual-check verification

The focused Dockhand/history/store/settings/app suite passes 89 tests, with one existing skip
and one Linux boot-ID test deselected. All 38 offline UI tests pass. Coverage includes scheduled
summary errors, timestamped individual outcomes, duplicate/truncated logs, recreated containers,
policy exclusions, redirects/permissions, persistence and corrupt/mismatched caches, newer-report
precedence, separate dashboard and per-machine menu scopes, combined top checks, read-only inventory
refresh/polling and OS-only installs.
Ruff and diff checks pass. Browser review uses only local simulated machines; no live Dockhand
instance or homelab host is contacted.

### Shared-provider follow-up verification

The provider scheduling, compound findings and shared UI revision passes 114 focused backend tests
(one existing skip and one Linux boot-ID test deselected), plus 42 offline UI tests and 5 additional native-job guard tests. The tests cover
the overall flag with native enabled/disabled and Dockhand allowed/blocked, mixed-provider manual
checks and cancellation, native deployment guards, overlapping findings, retention after failure,
missing-result coverage and read-only polling. Browser review uses local simulated providers only.

Desktop geometry was checked at 1400 and 1440 px, with labelled container rows at 390 px.
Both providers fit without page overflow. No real machines, registry or Dockhand instance were contacted.

### Two-row dashboard and three-view verification

The revision passes all 48 offline UI tests and 44 focused backend tests (one existing skip and
one Linux boot-ID test deselected). Coverage includes both providers, all scope views on desktop
and mobile, merged-cell accounting with both details open, independent check ages/ranges,
missing/local/failed results, scoped menus, read-only tab changes, OS-only selections and deployment
guards. Local browser review used simulated machines at 1440/1120 px and mobile cards at 390 px.
No configuration, scheduler behavior, backend actions or live infrastructure was changed.

### Clear check options and live settings

Container details include a collapsed **Current options and how to change them** section with a **Current settings** summary: provider,
Fleetdeck scheduled-container flag, manual-check permission and the configured Fleetdeck interval.
The values come from authenticated inventory settings and `/api/schedule`; they are never assumed
from a cached result or a Dockhand execution time. The outcome explains when the flag is on but
the scheduler is off, provider permission is disabled, or the target is check-only. Native monitor
policy remains visible. Dockhand instructions explain that exact mappings prevent native fallback.

Collapsed **Options and how to change them** explains three Dockhand choices: use Dockhand’s own
schedule, additionally request checks on Fleetdeck’s schedule, or enable manual checks. Each
choice names the required setting and its outcome. The Settings link opens the existing editor;
the help does not change configuration. Native guidance instead explains image downloads, Compose
coverage, host policies and confirmed stack updates. Scheduled history stays separate from the
configuration summary. Results, timestamps, persistence and OS-only Update scope use short plain
explanations. No check endpoints, schedules, configuration or deployment behavior changed.

All 50 offline UI tests and Ruff checks pass. Added cases cover live settings updates, scheduling
off, blocked permission, enabled scheduled checks, native monitor/check-only policies and both
mobile and desktop details without starting any action.

### Fixed metric slots, compact legend and machine information

Each Updates cell keeps a stable order. OS uses Security, Packages, Phased and Reboot;
containers use Images, Review, Coverage and Failures. Only visible metrics occupy space,
with a 14px gap between groups. Missing values never invent zeroes. Unknown image counts stay
unavailable. Coverage uses a dashed-circle symbol, distinct from machine information.
A compact Updates-only legend appears above the tables and follows All/Machines/Containers.
The Containers tab no longer shows the count of hosts.

OS update availability is purple; container availability is blue, using Lucide’s generic container icon. Routine container metrics have no filled
background; security, failure and reboot indicators retain emphasis. Review is amber and coverage
neutral. Whole machine groups highlight together, including shared identity and backup cells.
Individual controls keep their hover/focus treatment and existing action scopes.

Machine information moved out of identity/check-time areas into both per-machine menus. It
opens the same escaped information panel with OS results, policy, backups and repository context.
The popup anchors before the menu closes, and Escape returns focus to the visible More button.
Non-Proxmox repository notes retain a small warning on More and inside Machine information.

Container runtime dots sit immediately before names: running green, paused/restarting amber,
dead red, stopped/unknown neutral. They describe runtime state independently of image-check
outcomes. Unmatched update results read **Check result unavailable**, with the matching explanation
and suggested next step in a tooltip. Provider, monitoring, deployment and scheduler guards are
unchanged; the user’s native Docker setting remains untouched.

All 52 offline UI tests pass. New checks cover fixed slots, scoped legends, both providers, runtime
versus update states, escaped names and short unknown-result copy; existing popup tests now exercise
the menu workflow and focus return. Ruff checks pass. Browser review uses simulated machines only.


### Upstream main compatibility (2026-10-30)

Merged original Fleetdeck main through `81fa17f` (including dashboard PR #139 and screenshots #140).
The fork retains per-machine Docker policies, optional Dockhand integration,
All/Machines/Containers scope rows, separate check ages/actions and the offline frontend tests.
The user's configuration is not modified. Native Docker is available by default, as upstream; an
optional Dockhand mapping always prevents native fallback on its mapped hosts. `schedule.check_docker` continues to gate
scheduled checks for both providers; ordinary polling and Refresh inventory remain read-only.

Upstream custom update commands are supported through configuration and the OS machine menu.
The command is shown escaped in the update confirmation and runs inside upstream's normal
upgrade job, with its snapshot/log/recheck behavior and no built-in upgrade fallback on failure.
It replaces the built-in OS updater, so its effects depend on the configured command. Container
check/deployment actions remain separate. Upstream's password re-entry, source-network restriction,
audit and notification protections are retained. Machines with custom commands are excluded from
automatic security-only installations. Saved commands and Docker policies coexist in state storage.

The upstream Monitor only / Allow updates controls are available in machine menus; configuration
locks and backend enforcement remain in place. Snapshot defaults follow `snapshot_before_upgrade`;
reboot stays opt-in. The upstream accessible dashboard link and current login/setup headers are retained.

Integration verification: 486 backend tests passed, 6 skipped and 7 existing macOS/system-dependent
checks deselected (Linux boot ID, GNU file discovery, wrapper privileges, local port check,
downloaded bootstrap execution and GNU script). All 55 offline frontend tests passed, including
custom command escaping and OS-only menu placement alongside Dockhand, configuration-locked
monitor controls, snapshot defaults, mixed providers and read-only inventory refreshes.
Ruff lint/format and diff checks passed. No real machine or external manager was contacted.


### Filtered details, compact options and Proxmox guest boot

OS update metrics now open the corresponding Security, Packages or Phased list (including related
Waiting packages). Clicking the OS status opens the complete package list. Container image-update,
review, coverage and failure metrics likewise filter their details; clicking container status opens
all results. These navigation actions never request checks or install updates.

The original upstream Docker cube replaces the three-box icon. The legend says Reboot required;
Review uses teal/cyan, separate from the yellow reboot indicator. OS and container status labels
and update counts share typography and icon dimensions. Action headings align with actions, and
column width follows the longest supported action in the current view (compact native actions or
external manager link). Machine information anchors to the visible More button and is constrained
to the viewport. Current settings and the configuration explanation are together in the collapsed
Current options and how to change them section. Backup schedule icons explain coverage on hover,
without implying a successful backup. Monitor-only badges follow all other machine badges.

**Boot up** is a confirmed, separately logged action for stopped, unprotected Proxmox VMs and LXCs
on an online node. It uses the configured Proxmox API client and needs VM.Audit and VM.PowerMgmt
permissions; no SSH, guest agent or new credential is needed. It never changes token privileges,
forces locks, starts protected/excluded/template guests, wakes an offline hypervisor or installs
updates. Monitor-only allows booting just as it allows rebooting. The host's active upgrade/reboot
blocks a boot, and guest boot jobs block a host reboot/upgrade until finished. Eligibility is
checked at submission and execution; Proxmox status is re-read before the single start request.
The job waits for the Proxmox task and a running guest state, which does not imply guest services
are ready. Inventory is invalidated afterwards. Failed discovery revokes start handles; timeouts
are reported as uncertain and are never retried or resumed automatically. Polling never starts guests.

Verification: 59 offline frontend tests passed. The full backend run passed 506 tests, skipped 6
and deselected the same 7 documented macOS/system-dependent checks. An additional API-capability
regression passed in the 38-test app/power run (1 skip, 1 boot-ID deselection). Coverage includes
both Proxmox guest kinds, protected/template/excluded targets, missing permissions, stale status,
timeouts without retries, queued-policy changes, parent-job blocking, failed discovery and
boot confirmation/cancellation. Browser verification used simulated data only at desktop and
390px: no page overflow, matching 13px status/count text and 16px metric icons, compact options,
and an information popup anchored to the visible More button. Ruff and diff checks passed.


### Original Docker availability and mixed providers

The fork-only global Docker enable flag is removed from the config model, job manager, status API
and frontend. Native support is available by default as upstream. All/Machines/Containers navigation
is available without a second enable step. Only discovered/configured container hosts gain container
rows; ordinary OS checks discover new Docker installations without pulling images. A fresh positive
capability result overrides an older negative Docker scan for future scheduled checks. Explicit
container checks still require confirmation for native image downloads. Per-host policies and
Dockhand mappings remain enforced at submission, execution and resume.

`schedule.check_docker` is retained from upstream, default false: false keeps Fleetdeck's scheduled
rounds OS-only; true also requests native Compose image checks or mapped Dockhand checks. Dockhand
still requires allow_checks; its own schedule stays independent. Refresh inventory and dashboard
polling never request image checks. No user configuration or provider permissions are changed.


Verification: all 60 offline frontend tests passed, including discovery after a previously negative
OS result and provider-specific menu routing without a global flag. Backend checks passed 510 tests
across the full run and the successful rerun of 9 local-server checks after loopback access was
restored; 6 skipped and the same 7 known platform checks were deselected. Tests cover newly installed
Docker without image operations, positive rediscovery over an older negative stack scan, both
providers' scheduled flag/permission combinations and per-host disabled/monitor/external restrictions.
Ruff formatting, lint and diff checks passed. No user configuration or live infrastructure changed.


### Per-machine providers and final container presentation

Every machine’s More menu includes Docker management, including existing Dockhand mappings.
Choose Managed by Fleetdeck, Monitor only, Managed by Dockhand, Other external manager (link only)
or Disabled. Dockhand fields contain URL, a write-only token, saved-report polling interval,
fresh-check permission and the machine’s environment ID. There is no machine ID field: the
selected machine supplies it. Connection settings are shared; the dialog states how many hosts
use them. A blank token preserves the existing value or environment reference. A URL change
requires a new token rather than forwarding an existing secret to another URL.

Native-only policies still save immediately. Connection and provider mapping changes use the
existing configuration file and Save then Apply, with revision checking, the shared config lock,
existing authentication/CSRF and read-only handling, atomic private file writes and policy-failure
rollback. Active jobs and active Dockhand checks block config changes/apply. Existing mapped hosts
retain their native-job guard until restart applies the new provider. No opening/saving request
connects to a manager or starts an image check. Metadata and validation responses never return
stored/submitted tokens. The original authenticated full Settings editor is unchanged.

Container headers now show one filter/count bar (All, Image updates, Up to date, Review, Coverage,
Failures) and a small sync time. Current options and check history stay in the collapsed section:
a compact name/value panel, direct Docker management and Schedule settings controls, and short
provider-specific instructions. Failures and in-progress checks remain visible. Filters count
independent findings and may overlap; no missing result becomes an up-to-date result.

Container update colour is blue, OS availability remains purple, Review is teal and Reboot required
is yellow. Lucide’s ISC-licensed container icon is included inline with its licence in static assets.
Visible metrics are adjacent in a stable order with a 14px gap; missing metrics reserve no space.
Actions are a fixed 144px and More buttons align to the far right. Scope and Updates receive more
space while Machine absorbs the remaining width; narrower desktop widths use compact budgets.

Final verification: 64 offline UI tests pass. The full backend run passed 525 tests (6 skipped,
7 known platform checks deselected); the final app/Dockhand/provider-settings regression run
passed 73 tests (1 skipped, Linux boot-ID check deselected). The monitor-only API test now skips
real reboot polling backoff so random demo timing cannot exhaust its policy-test timeout.
Browser checks used simulated machines only: desktop columns measure Actions 144px, Scope 112px,
Updates 224px; ordinary metric groups have 14px gaps and share a line. The 1120px desktop and
390px mobile views have no page overflow; the mobile provider dialog retains a visible footer.
Existing tokens stay absent from the dialog, Save exposes Apply separately and starts no checks,
and all metadata and validation responses keep tokens private. Current options show running
settings; the dialog shows saved pending configuration until Apply. No homelab was contacted.


### Container menu scope and glyph alignment

Container-row More menus offer container checks and View container details (a distinct list icon).
Machine information, Docker management and the machine-wide monitor-only toggle stay in the
machine/OS menu. Both desktop and mobile preserve these scopes. The Updates cells share the same
horizontal inset; package, container and reboot glyphs use 16px boxes and a 3px inset so the first
visible icon aligns across rows. Packed 14px spacing and count order remain unchanged.
All 65 offline UI tests pass. Simulated browser measurements confirm matching insets and sizes.

Follow-up: preserve Monitor only / Allow updates in the container menu, since that policy also
controls native container updates. Machine information and Docker management remain machine-only.
Reboot glyphs are centered in their square badge again; a desktop-only outer offset aligns the glyph
with the other metrics. Mobile keeps its original badge and icon sizing.
Native container summaries now say Up to date; Compose-only coverage remains explained in the details.

### Mobile readability and distinct menu icons

Update command uses a terminal glyph; Docker management keeps the settings gear. Refresh inventory
uses a scan/search glyph, distinct from the fresh-check arrows. Labels and action behavior are unchanged.
Phone headers keep branding and controls on one line. Mobile cards put OS metrics, the action and
More menu in one footer instead of stacking the buttons; status text reads across the card width.
Container cards follow the same layout, with the manager link/tag kept beside More. Long machine
tags wrap without hiding identity. Container detail statuses now stack their separate findings
vertically instead of flowing into two narrow grid columns. Native and Dockhand actions, timestamps,
filters, confirmations and policy guards are unchanged.
Verification: 66 offline UI tests pass, including distinct menu glyphs. Simulated browser checks
at 320, 390 and 768 pixels show no page overflow; desktop remains a table. No homelab requests.

### Link-only external managers

Other external manager is explicitly link-only: the dashboard shows Managed externally, Not
monitored and Not applicable, with the configured name and optional URL. No container glyph/count
or old native findings contribute to its metrics or overview totals. A missing URL renders a neutral
manager tag rather than a hidden settings action. Its container menu offers View management details,
without checks or the machine-wide monitor toggle. Native container menus retain that toggle;
Dockhand container menus omit it because the toggle does not control Dockhand. Machine/OS menus
retain their independent monitoring control. Generic defaults, placeholders and mode-specific help
no longer assume Dockhand; existing explicitly configured manager names remain intact.
Verification: 68 offline UI tests and 37 Docker settings/provider backend tests pass. Simulated
browser save confirmed the custom manager name/link and menu without image checks or deployments.

### Restore the earlier mobile card composition

Mobile cards again pair identity on the left with OS status and checked time on the right.
Machine type now sits beside the OS on the second line. Metrics occupy a separate row, with the
OS action at bottom left and More at bottom right. When there is no OS action, backup information
shares the bottom row with More. Container hosts add a matching section below with independent
status, check time, metrics and actions. Containers-only retains the same identity and section.
Machine information remains in More, rather than adding the old inline information button.
Verification: all 69 offline UI tests pass. Simulated browser review at 320, 390 and 768 pixels
confirmed readable separate scopes and no page overflow. Desktop table layout is unchanged.

Mobile card follow-up: backup age and schedule coverage now sit on the right of the OS metric
row, above the bottom action/More row, whether or not the machine has a primary action.

Mobile spacing adapts to available actions: a menu-only OS section shares the counts/backup row
instead of reserving a separate action row. Container counts sit beside check history at widths
from 375px upward; narrower screens keep a stacked arrangement. Empty intervening grid rows and
excess count margins were removed. Actual Update/Boot up/Reboot buttons keep their own bottom row.
Simulated browser checks at 320, 390 and 768px show no page overflow. The Simulated Dockhand tag
is a demo-only replacement for a live manager link, not a production provider status.

### Touch-layout status alignment

Mobile status buttons no longer use a 44px minimum layout height: that rule centred the visible
status lower than the machine name and displaced its checked time on touch devices. A transparent
44px pseudo-element keeps the tap target while text uses a 20px line box aligned to the name.
Machine names can shrink/wrap beside the monitor badge instead of wrapping the badge onto its own
row. Mobile status hover fills are removed to avoid persistent touch-hover highlighting; keyboard
focus remains visible. Touch active styling does not translate the status text.
Verification: all 69 offline UI tests pass. Local browser review with coarse-pointer CSS rules
explicitly enabled measured zero top offset between name/status and a retained 44px hit area.
320px layout has no horizontal page overflow. This is a simulated touch-layout check, not a test
on a physical iPhone.

Mobile identity follow-up: additional dashboard/helper/monitor badges now sit with machine type and
OS metadata, so they cannot squeeze a short machine name onto multiple lines. Link-only external
rows omit the redundant Not monitored / Not applicable values and compact their empty time row.
Their status and provider tooltips now say Monitored externally, using the configured manager name.
All 70 offline UI tests pass, including badge placement and neutral external-manager rows.
