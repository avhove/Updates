"""Read Dockhand's cached pending records. No registry checks or Docker mutations.

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

    async def refresh(self) -> None:
        if time.monotonic() < self.next_poll:
            return
        async with self.lock:
            if time.monotonic() < self.next_poll:
                return
            # Limit network fan-out, including for malformed or unreachable configured instances.
            sem = asyncio.Semaphore(4)

            async def read(mapping):
                async with sem:
                    previous = self.status.get(mapping.target_id, DockhandStatus(manager_url=self.cfg.url))
                    try:
                        containers = await self._get("containers", mapping.environment_id)
                        pending = await self._get("containers/pending-updates", mapping.environment_id)
                        # Some Dockhand versions return [] when the environment is unreachable.
                        if not containers:
                            raise ValueError("Empty inventory cannot establish environment health")
                        items = normalize(containers, pending)
                        self.status[mapping.target_id] = DockhandStatus(
                            manager_url=self.cfg.url,
                            synced_at=datetime.now(UTC),
                            containers=items,
                            stale=False,
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
        await self.client.aclose()
