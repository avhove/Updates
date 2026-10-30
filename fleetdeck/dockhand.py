"""Read cached status and, when opted in, explicitly request registry checks in Dockhand.

An empty pending list is not proof of a successful check. Dockhand does not expose
successful/failed checks for every container here, so unlisted containers stay unknown.
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime

import httpx
from pydantic import BaseModel, Field

from .config import DockhandConfig


class ContainerStatus(BaseModel):
    container_id: str = ""
    name: str
    image: str
    state: str
    stack: str | None = None
    status: str = "unknown"
    checked_at: datetime | None = None


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


def demo_status(url: str) -> DockhandStatus:
    """An in-memory fixture for a mapped demo machine; never an HTTP request."""
    now = datetime.now(UTC)
    return DockhandStatus(
        manager_url=url,
        synced_at=now,
        stale=False,
        simulated=True,
        containers=[
            ContainerStatus(
                name="web",
                image="example/web:latest",
                state="running",
                stack="demo-app",
                status="update",
                checked_at=now,
            ),
            ContainerStatus(name="worker", image="example/worker:latest", state="running", stack="demo-app"),
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
    def __init__(self, cfg: DockhandConfig, *, transport=None):
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
                items[index] = item.model_copy(update={"status": old.status, "checked_at": old.checked_at})
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
                if items and not any(item.checked_at for item in items):
                    raise ValueError("No complete check results matched the current container inventory")
                self.checked[target_id] = {c.container_id: c for c in items if c.checked_at is not None}
                self.status[target_id] = DockhandStatus(
                    manager_url=self.cfg.url,
                    synced_at=now,
                    stale=False,
                    last_check_at=now,
                    containers=items,
                )
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
                        )
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
        response = await self.client.get(f"{self.cfg.url}/api/{path}", params={"env": env})
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
