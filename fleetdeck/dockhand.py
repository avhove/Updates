"""Read cached status and, when opted in, explicitly request registry checks in Dockhand.

An empty pending list is not proof of a successful check. Dockhand does not expose
successful/failed checks for every container there; scheduled logs provide additional
explicit outcomes, with identity checks and persistent last-confirmed results.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import time
from datetime import UTC, datetime

import httpx
from pydantic import BaseModel, Field

from .config import DockhandConfig
from .store import Store


class ContainerStatus(BaseModel):
    container_id: str = ""
    name: str
    image: str
    state: str
    stack: str | None = None
    status: str = "unknown"
    checked_at: datetime | None = None
    source: str | None = None


class DockhandStatus(BaseModel):
    manager_url: str
    synced_at: datetime | None = None
    containers: list[ContainerStatus] = Field(default_factory=list)
    error: str | None = None
    stale: bool = True
    simulated: bool = False
    checking: bool = False
    last_check_at: datetime | None = None
    check_error: str | None = None
    scheduled_check_at: datetime | None = None
    scheduled_status: str | None = None
    scheduled_checked: int | None = None
    scheduled_errors: int | None = None
    history_error: str | None = None


class SavedDockhand(BaseModel):
    status: DockhandStatus
    checked: list[ContainerStatus]


def timestamp(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed
    except (ValueError, TypeError):
        return None


def scheduled_results(execution: dict, containers: list, environment_id: int) -> list[ContainerStatus]:
    """Recognise explicit, timestamped outcomes only; never infer success from absence.

    Dockhand v1.0.56 stores successful per-container checks in text logs. Container
    creation time, exact unique name and image guard against reusing a run for a replacement.
    Unknown formats, partial runs, duplicates and missing creation dates fail closed.
    """
    started, finished = timestamp(execution.get("startedAt")), timestamp(execution.get("completedAt"))
    if (
        type(execution.get("environmentId")) is not int
        or execution.get("environmentId") != environment_id
        or execution.get("scheduleType") != "env_update_check"
        or execution.get("status") not in {"success", "warning"}
        or not started
        or not finished
        or finished < started
        or not isinstance(execution.get("logs"), str)
    ):
        return []
    names: dict[str, list[dict]] = {}
    for container in containers:
        names.setdefault(container["name"], []).append(container)
    outcomes: dict[str, ContainerStatus] = {}
    seen = set()
    check_lines = 0
    current = None
    for line in execution["logs"].splitlines():
        match = re.fullmatch(r"\[([^]\n]+)\] (.*)", line)
        if not match:
            current = None
            continue
        at, message = timestamp(match[1]), match[2]
        if not at or not started <= at <= finished:
            current = None
            continue
        check = re.fullmatch(r"  Checking: (.+) \((.+)\)", message)
        if check:
            check_lines += 1
            current = None
            candidates = names.get(check[1], [])
            if len(candidates) != 1:
                continue
            container = candidates[0]
            created = container.get("created")
            labels = container.get("labels") or {}
            if (
                not isinstance(created, (int, float))
                or isinstance(created, bool)
                or not 0 < created <= started.timestamp()
                or container.get("image") != check[2]
                or str(labels.get("dockhand.update", labels.get("wud.watch", ""))).lower() in {"false", "no", "0"}
                or str(labels.get("dockhand.watch.digest", labels.get("wud.watch.digest", ""))).lower()
                in {"false", "no", "0"}
            ):
                continue
            if container["id"] in seen:
                outcomes.pop(container["id"], None)
                continue
            seen.add(container["id"])
            current = container
            continue
        outer_error = re.fullmatch(r"  \[(.+)\] Error:.*", message)
        if current is not None and outer_error and outer_error[1] == current["name"]:
            outcomes[current["id"]] = ContainerStatus(
                container_id=current["id"],
                name=current["name"],
                image=current["image"],
                state=str(current.get("state", "unknown"))[:40],
                status="failed",
                checked_at=at,
                source="dockhand_schedule",
            )
        if not message.startswith("    "):
            current = None
        if current is None:
            continue
        value = message.strip()
        status = None
        if value == "Up to date":
            previous = outcomes.get(current["id"])
            status = previous.status if previous else "current"
        elif value == "UPDATE AVAILABLE":
            status = "update"
        elif value.startswith("Error:"):
            status = "failed"
        elif value == "Local image - skipping update check":
            status = "local"
        elif value.startswith("Update deferred:"):
            status = "deferred"
        elif value.startswith(("NEWER VERSION:", "Reported only - the digest is pinned")):
            previous = outcomes.get(current["id"])
            status = previous.status if previous and previous.status in {"update", "deferred"} else "advisory"
        if status:
            outcomes[current["id"]] = ContainerStatus(
                container_id=current["id"],
                name=current["name"],
                image=current["image"],
                state=str(current.get("state", "unknown"))[:40],
                status=status,
                checked_at=at,
                source="dockhand_schedule",
            )
    details = execution.get("details") or {}
    expected = details.get("containersChecked") if isinstance(details, dict) else None
    if type(expected) is not int or expected != check_lines:
        return []  # Truncated, duplicated or unexpected log structure cannot prove a healthy run.
    return list(outcomes.values())


def demo_status(url: str) -> DockhandStatus:
    """An in-memory fixture for a mapped demo machine; never an HTTP request."""
    now = datetime.now(UTC)
    return DockhandStatus(
        manager_url=url,
        synced_at=now,
        stale=False,
        simulated=True,
        scheduled_check_at=now,
        scheduled_status="success",
        scheduled_checked=3,
        scheduled_errors=0,
        containers=[
            ContainerStatus(
                name="web",
                image="example/web:latest",
                state="running",
                stack="demo-app",
                status="update",
                checked_at=now,
            ),
            ContainerStatus(
                name="worker",
                image="example/worker:latest",
                state="running",
                stack="demo-app",
                status="current",
                checked_at=now,
                source="dockhand_schedule",
            ),
            ContainerStatus(
                name="standalone", image="example/tool:latest", state="running", status="update", checked_at=now
            ),
        ],
    )


def normalize(containers: object, pending: object) -> list[ContainerStatus]:
    if not isinstance(containers, list) or not isinstance(pending, dict):
        raise ValueError("Unsupported Dockhand response")
    updates = pending.get("pendingUpdates")
    if not isinstance(updates, list):
        raise ValueError("Unsupported Dockhand pending records")
    by_id = {r["containerId"]: r for r in updates if isinstance(r, dict) and isinstance(r.get("containerId"), str)}
    result = []
    for c in containers:
        if not isinstance(c, dict) or not isinstance(c.get("id"), str) or not isinstance(c.get("name"), str):
            raise ValueError("Unsupported Dockhand container record")
        labels = c.get("labels") or {}
        if not isinstance(labels, dict):
            raise ValueError("Unsupported Dockhand labels")
        if labels.get("dockhand.hidden") == "true":
            continue
        row = by_id.get(c["id"], {})
        status = "unknown"
        if labels.get("dockhand.update") == "false":
            status = "excluded"
        elif row.get("pinnedToDigest") is True:
            status = "advisory"
        elif row.get("hasImageUpdate") is True:
            cooldown = pending.get("minimumReleaseAgeHours")
            held = (row.get("releaseAgeRemainingHours") or 0) > 0 and cooldown != 0
            status = "deferred" if held else "update"
        elif row.get("newerVersion"):
            status = "advisory"
        try:
            checked = (
                datetime.fromisoformat(str(row["checkedAt"]).replace("Z", "+00:00")) if row.get("checkedAt") else None
            )
            if checked and checked.tzinfo is None:
                checked = checked.replace(tzinfo=UTC)
        except ValueError:
            checked = None
        result.append(
            ContainerStatus(
                container_id=c["id"],
                name=c["name"][:256],
                image=str(c.get("image", ""))[:512],
                state=str(c.get("state", "unknown"))[:40],
                stack=str(labels["com.docker.compose.project"])[:256]
                if labels.get("com.docker.compose.project")
                else None,
                status=status,
                checked_at=checked,
            )
        )
    return sorted(result, key=lambda c: (c.stack or "", c.name))


class DockhandReader:
    def __init__(self, cfg: DockhandConfig, *, transport=None, store: Store | None = None):
        self.cfg = cfg
        self.client = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {cfg.token}"},
            timeout=5,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )
        self.status: dict[str, DockhandStatus] = {}
        self.next_poll = 0.0
        self.lock = asyncio.Lock()
        self.tasks: dict[str, asyncio.Task] = {}
        self.last_started: dict[str, float] = {}
        self.checked: dict[str, dict[str, ContainerStatus]] = {}
        self.store = store
        for mapping in cfg.environments:
            saved = store.get_value(self._cache_key(mapping.target_id)) if store else None
            if saved:
                try:
                    cache = SavedDockhand.model_validate_json(saved)
                    self.status[mapping.target_id] = cache.status.model_copy(update={"stale": True, "checking": False})
                    self.checked[mapping.target_id] = {c.container_id: c for c in cache.checked}
                except ValueError:
                    pass  # Corrupt saved state must not establish a successful check.

    def _cache_key(self, target_id: str) -> str:
        mapping = next(m for m in self.cfg.environments if m.target_id == target_id)
        scope = f"{self.cfg.url}\n{mapping.environment_id}\n{target_id}"
        return "dockhand:v1:" + hashlib.sha256(scope.encode()).hexdigest()

    def _save(self, target_id: str) -> None:
        if self.store:
            self.store.set_value(
                self._cache_key(target_id),
                SavedDockhand(
                    status=self.status[target_id], checked=list(self.checked.get(target_id, {}).values())
                ).model_dump_json(),
            )

    async def _history(self, environment_id: int, containers: list) -> tuple[dict, list[ContainerStatus]]:
        data = await self._read_json(
            "schedules/executions",
            {
                "environmentId": environment_id,
                "scheduleType": "env_update_check",
                "limit": 1,
            },
        )
        if not isinstance(data, dict) or not isinstance(data.get("executions"), list):
            raise ValueError("Unsupported history")
        if not data["executions"]:
            return {}, []
        row = data["executions"][0]
        if (
            not isinstance(row, dict)
            or type(row.get("environmentId")) is not int
            or row.get("environmentId") != environment_id
            or row.get("scheduleType") != "env_update_check"
            or type(row.get("id")) is not int
            or not 0 < row["id"] < 2**53
        ):
            raise ValueError("Unmapped history")
        details = row.get("details") or {}
        if not isinstance(details, dict):
            raise ValueError("Unsupported summary")

        def count(key):
            value = details.get(key)
            return value if type(value) is int and 0 <= value < 2**31 else None

        summary = {
            "scheduled_check_at": timestamp(row.get("completedAt")) or timestamp(row.get("startedAt")),
            "scheduled_status": row.get("status")
            if row.get("status") in {"success", "warning", "failed", "running", "queued", "skipped"}
            else "unknown",
            "scheduled_checked": count("containersChecked"),
            "scheduled_errors": count("errors"),
        }
        if row.get("status") not in {"success", "warning"}:
            return summary, []
        execution = await self._read_json(f"schedules/executions/{row['id']}", {})
        if not isinstance(execution, dict) or execution.get("id") != row["id"]:
            raise ValueError("Unmatched execution")
        return summary, scheduled_results(execution, containers, environment_id)

    def request_check(self, target_id: str) -> None:
        if not self.cfg.allow_checks:
            raise PermissionError("Enable dockhand.allow_checks in Settings to allow explicit Dockhand checks")
        mapping = next((m for m in self.cfg.environments if m.target_id == target_id), None)
        if mapping is None:
            raise KeyError(target_id)
        if target_id in self.tasks or time.monotonic() - self.last_started.get(target_id, -60) < 30:
            raise ValueError("A Dockhand check is running or was started recently; wait before retrying")
        if len(self.tasks) >= 4:
            raise ValueError("Four Dockhand checks are already running; wait before starting another")
        previous = self.status.get(target_id, DockhandStatus(manager_url=self.cfg.url))
        self.status[target_id] = previous.model_copy(update={"checking": True, "check_error": None})
        self.last_started[target_id] = time.monotonic()
        self.tasks[target_id] = asyncio.create_task(self._check(target_id, mapping.environment_id))

    def _merge(self, target_id: str, items: list[ContainerStatus]) -> list[ContainerStatus]:
        known = self.checked.get(target_id, {})
        for index, item in enumerate(items):
            old = known.get(item.container_id)
            if (
                old
                and item.status != "excluded"
                and old.image == item.image
                and (item.checked_at is None or (old.checked_at is not None and old.checked_at >= item.checked_at))
            ):
                items[index] = item.model_copy(
                    update={"status": old.status, "checked_at": old.checked_at, "source": old.source}
                )
        return items

    async def _check(self, target_id: str, environment_id: int) -> None:
        try:
            # A fixed JSON endpoint returns the complete per-container result. No deployment endpoints exist here.
            async with asyncio.timeout(180):
                containers = await self._get("containers", environment_id)
                response = await self.client.post(
                    f"{self.cfg.url}/api/containers/check-updates",
                    params={"env": environment_id},
                    headers={"Accept": "application/json"},
                    timeout=180,
                )
                response.raise_for_status()
                if len(response.content) > 2_000_000:
                    raise ValueError("Oversized check response")
                data = response.json()
                if not isinstance(data, dict) or not isinstance(data.get("results"), list):
                    raise ValueError("Dockhand did not return complete check results")
                results = {
                    r["containerId"]: r
                    for r in data["results"]
                    if isinstance(r, dict) and isinstance(r.get("containerId"), str)
                }
                items = normalize(containers, {"pendingUpdates": []})
                now = datetime.now(UTC)
                for item in items:
                    row = results.get(item.container_id)
                    if not row:
                        continue
                    if row.get("error"):
                        item.status = "failed"
                    elif row.get("updateDisabled") is True or item.status == "excluded":
                        item.status = "excluded"
                    elif row.get("isLocalImage") is True:
                        item.status = "local"
                    elif row.get("pinnedToDigest") is True:
                        item.status = "advisory"
                    elif (row.get("releaseAgeRemainingHours") or 0) > 0:
                        item.status = "deferred"
                    elif row.get("hasUpdate") is True:
                        item.status = "update"
                    elif row.get("newerVersion"):
                        item.status = "advisory"
                    elif row.get("hasUpdate") is False:
                        item.status = "current"
                    else:
                        continue  # incomplete records are never a successful check
                    item.checked_at = now
                    item.source = "fleetdeck_button"
                if items and not any(item.checked_at for item in items):
                    raise ValueError("No complete check results matched the current container inventory")
                self.checked[target_id] = {c.container_id: c for c in items if c.checked_at is not None}
                self.status[target_id] = DockhandStatus(
                    manager_url=self.cfg.url,
                    synced_at=now,
                    stale=False,
                    last_check_at=now,
                    containers=items,
                    scheduled_check_at=self.status[target_id].scheduled_check_at,
                    scheduled_status=self.status[target_id].scheduled_status,
                    scheduled_checked=self.status[target_id].scheduled_checked,
                    scheduled_errors=self.status[target_id].scheduled_errors,
                    history_error=self.status[target_id].history_error,
                )
                self._save(target_id)
        except (httpx.HTTPError, ValueError, TypeError, KeyError, TimeoutError):
            previous = self.status[target_id]
            self.status[target_id] = previous.model_copy(
                update={
                    "checking": False,
                    "check_error": (
                        "Dockhand check did not complete. Check connection, token permissions and API version. "
                        "A timed-out check may still be running in Dockhand; previous results are retained."
                    ),
                }
            )
            self._save(target_id)
        finally:
            self.tasks.pop(target_id, None)

    async def refresh(self, *, force: bool = False) -> None:
        if not force and time.monotonic() < self.next_poll:
            return
        async with self.lock:
            if not force and time.monotonic() < self.next_poll:
                return
            # Limit network fan-out, including for malformed or unreachable configured instances.
            sem = asyncio.Semaphore(4)

            async def read(mapping):
                async with sem:
                    if mapping.target_id in self.tasks:
                        return
                    previous = self.status.get(mapping.target_id, DockhandStatus(manager_url=self.cfg.url))
                    try:
                        containers = await self._get("containers", mapping.environment_id)
                        pending = await self._get("containers/pending-updates", mapping.environment_id)
                        # Some Dockhand versions return [] when the environment is unreachable.
                        if not containers:
                            raise ValueError("Empty inventory cannot establish environment health")
                        items = normalize(containers, pending)
                        summary = {
                            key: getattr(previous, key)
                            for key in (
                                "scheduled_check_at",
                                "scheduled_status",
                                "scheduled_checked",
                                "scheduled_errors",
                            )
                        }
                        history_error = None
                        try:
                            summary, outcomes = await self._history(mapping.environment_id, containers)
                            known = self.checked.setdefault(mapping.target_id, {})
                            for outcome in outcomes:
                                old = known.get(outcome.container_id)
                                if not old or not old.checked_at or outcome.checked_at > old.checked_at:
                                    known[outcome.container_id] = outcome
                        except (httpx.HTTPError, ValueError, TypeError, KeyError):
                            history_error = (
                                "Dockhand check history unavailable. Check read access to schedules "
                                "and API compatibility; container inventory is still synced."
                            )
                        if mapping.target_id in self.tasks:
                            return
                        previous = self.status.get(mapping.target_id, previous)
                        self.status[mapping.target_id] = DockhandStatus(
                            manager_url=self.cfg.url,
                            synced_at=datetime.now(UTC),
                            containers=self._merge(mapping.target_id, items),
                            stale=False,
                            last_check_at=previous.last_check_at,
                            check_error=previous.check_error,
                            history_error=history_error,
                            **summary,
                        )
                        # Drop retired/replaced records instead of growing the saved cache forever.
                        images = {item.container_id: item.image for item in items}
                        self.checked[mapping.target_id] = {
                            k: v for k, v in self.checked.get(mapping.target_id, {}).items() if images.get(k) == v.image
                        }
                        self._save(mapping.target_id)
                    except (httpx.HTTPError, ValueError, TypeError, KeyError) as exc:
                        # Never expose response bodies, URLs or exceptions that could contain credentials.
                        reason = "Dockhand status unavailable; check connection, permissions and API version."
                        if isinstance(exc, httpx.HTTPStatusError):
                            code = exc.response.status_code
                            reason = {
                                401: "Dockhand rejected authentication (HTTP 401). Check the Fleetdeck token.",
                                403: "Dockhand denied access (HTTP 403). Check token permissions for this environment.",
                                404: "Dockhand returned HTTP 404. Check its base URL, environment ID and API version.",
                            }.get(code, f"Dockhand returned HTTP {code}. Redirects are not followed.")
                        elif isinstance(exc, httpx.TimeoutException):
                            reason = "Dockhand connection timed out. Check reachability from the Fleetdeck container."
                        elif isinstance(exc, httpx.RequestError):
                            reason = "Could not connect to Dockhand. Check DNS, network access and its TLS certificate."
                        self.status[mapping.target_id] = previous.model_copy(
                            update={
                                "error": reason,
                                "stale": True,
                            }
                        )

            await asyncio.gather(*(read(m) for m in self.cfg.environments))
            self.next_poll = time.monotonic() + self.cfg.poll_seconds

    async def _get(self, path: str, env: int):
        # These are the only outgoing routes and methods; never forward browser-supplied paths.
        return await self._read_json(path, {"env": env})

    async def _read_json(self, path: str, params: dict):
        response = await self.client.get(f"{self.cfg.url}/api/{path}", params=params)
        response.raise_for_status()
        if len(response.content) > 2_000_000:
            raise ValueError("Dockhand response is too large")
        return response.json()

    async def aclose(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self.client.aclose()
