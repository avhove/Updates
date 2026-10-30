from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_jobs import FakeExecutor, _inventory, _target

from fleetdeck.app import create_app
from fleetdeck.config import AppConfig, AuthConfig, DockhandConfig
from fleetdeck.dockhand import DockhandReader, normalize
from fleetdeck.jobs import JobManager
from fleetdeck.models import DockerSettings
from fleetdeck.scheduler import Scheduler
from fleetdeck.updates import DOCKER_DETECT_SCRIPT


def config(**kwargs):
    return DockhandConfig(
        url="https://dockhand.example",
        token="secret-test-token",
        environments=[
            {"target_id": "t1", "environment_id": 1},
        ],
        **kwargs,
    )


def containers():
    return [
        {
            "id": "a",
            "name": "web",
            "image": "web:latest",
            "state": "running",
            "labels": {
                "com.docker.compose.project": "media",
            },
        },
        {"id": "b", "name": "standalone", "image": "tool:latest", "state": "running"},
    ]


async def test_reader_only_gets_cached_routes_preserves_history_and_never_follows_redirects():
    calls = []
    fail = False

    def respond(request):
        calls.append(request)
        assert request.method == "GET"
        assert request.headers["authorization"] == "Bearer secret-test-token"
        assert request.url.params["env"] == "1"
        if fail:
            return httpx.Response(302, headers={"location": "https://other.example/steal"})
        if request.url.path == "/api/containers":
            return httpx.Response(200, json=containers())
        assert request.url.path == "/api/containers/pending-updates"
        return httpx.Response(
            200,
            json={
                "pendingUpdates": [
                    {
                        "containerId": "a",
                        "hasImageUpdate": True,
                        "checkedAt": "2026-10-30T10:00:00Z",
                    }
                ]
            },
        )

    reader = DockhandReader(config(), transport=httpx.MockTransport(respond))
    await reader.refresh()
    assert len(calls) == 2
    result = reader.status["t1"]
    assert result.stale is False
    assert result.containers[0].status == "unknown"  # standalone record with no cached outcome
    assert result.containers[1].stack == "media"
    assert result.containers[1].status == "update"
    await reader.refresh()
    assert len(calls) == 2  # dashboard refresh cannot bypass polling interval
    fail = True
    reader.next_poll = 0
    await reader.refresh()
    failed = reader.status["t1"]
    assert failed.stale and failed.error
    assert failed.synced_at == result.synced_at
    assert failed.containers == result.containers
    assert len(calls) == 3
    assert "secret-test-token" not in failed.model_dump_json()
    assert "other.example" not in failed.model_dump_json()
    await reader.aclose()


def test_normalizer_is_conservative_about_pending_advisories_and_policy():
    source = containers()
    source.extend(
        [
            {"id": "c", "name": "excluded", "labels": {"dockhand.update": "false"}},
            {"id": "d", "name": "hidden", "labels": {"dockhand.hidden": "true"}},
            {"id": "e", "name": "advice"},
            {"id": "f", "name": "waiting"},
        ]
    )
    rows = normalize(
        source,
        {
            "pendingUpdates": [
                {"containerId": "a"},  # older API record: presence alone is not proof
                {"containerId": "c", "hasImageUpdate": True},
                {"containerId": "e", "hasImageUpdate": False, "pinnedToDigest": True},
                {"containerId": "f", "hasImageUpdate": True, "releaseAgeRemainingHours": 3},
                {"containerId": "removed", "hasImageUpdate": True},
            ]
        },
    )
    by_name = {c.name: c for c in rows}
    assert "hidden" not in by_name
    assert len(rows) == 5
    assert by_name["web"].status == "unknown"
    assert by_name["excluded"].status == "excluded"
    assert by_name["advice"].status == "advisory"
    assert by_name["waiting"].status == "deferred"


@pytest.mark.parametrize("payload", [[], {}, {"pendingUpdates": {}}, {"pendingUpdates": None}])
def test_bad_pending_shapes_do_not_become_healthy(payload):
    with pytest.raises(ValueError):
        normalize(containers(), payload)


@pytest.mark.parametrize("url", ["javascript:alert(1)", "https://user:secret@host", "//host", "https://host?token=x"])
def test_config_rejects_unsafe_urls(url):
    with pytest.raises(ValidationError):
        DockhandConfig(url=url, token="secret", environments=[{"target_id": "a", "environment_id": 1}])


async def test_mapping_blocks_native_jobs_even_when_native_enabled_and_policy_changes():
    jobs = JobManager(
        _inventory((_target(), FakeExecutor())),
        docker_enabled=True,
        dockhand_targets={"t1": "https://dockhand.example"},
    )
    for action in ("stacks", "stack-update"):
        with pytest.raises(ValueError, match="external"):
            jobs.submit("t1", action)
        with pytest.raises(ValueError, match="external"):
            jobs._ensure_docker_action("t1", action)  # same guard used queued/resumed jobs
    with pytest.raises(ValueError, match="mapped to Dockhand"):
        jobs.set_docker_settings("t1", DockerSettings(mode="managed"))


def test_status_api_keeps_token_private_and_docker_disabled(tmp_path, monkeypatch):
    cfg = AppConfig(allow_no_auth=True, state_file=str(tmp_path / "state.db"), dockhand=config())
    app = create_app(cfg, _inventory((_target(), FakeExecutor())))
    monkeypatch.setattr(app.state.inventory, "refresh", AsyncMock())
    reader = app.state.dockhand
    monkeypatch.setattr(reader, "refresh", AsyncMock())
    with TestClient(app) as client:
        response = client.get("/api/targets")
        assert response.status_code == 200
        data = response.json()
        assert data["settings"]["containers_visible"] is True
        assert data["settings"]["docker_enabled"] is False
        assert data["targets"][0]["docker_settings"]["mode"] == "external"
        assert cfg.dockhand.token not in response.text
        rejected = client.post("/api/actions", json={"action": "stacks", "target_ids": ["t1"]}).json()
        assert not rejected["jobs"]
        assert "disabled" in rejected["rejected"]["t1"]


def test_demo_never_creates_external_reader(tmp_path):
    cfg = AppConfig(demo=True, dockhand=config(), state_file=str(tmp_path / "state.db"))
    app = create_app(cfg)
    assert app.state.dockhand is None


def test_docker_demo_config_shows_mixed_management_without_any_http_reader(tmp_path):
    from fleetdeck.config import load_config

    cfg = load_config("config.docker-demo.yaml")
    cfg.state_file = str(tmp_path / "state.db")
    app = create_app(cfg)
    assert app.state.dockhand is None
    with TestClient(app) as client:
        targets = client.get("/api/targets").json()["targets"]
        vm = next(v for v in targets if v["target"]["name"] == "docker-vm")
        assert vm["dockhand"]["simulated"] is True
        assert vm["docker_settings"]["mode"] == "external"
        assert any(c["stack"] is None for c in vm["dockhand"]["containers"])
        assert any(c["stack"] == "demo-app" for c in vm["dockhand"]["containers"])
        pi = next(v for v in targets if v["target"]["name"] == "pi4")
        assert pi["docker_settings"]["mode"] == "managed"


def test_unauthenticated_requests_never_poll_dockhand(tmp_path, monkeypatch):
    cfg = AppConfig(auth=AuthConfig(password="test-password"), dockhand=config(), state_file=str(tmp_path / "state.db"))
    app = create_app(cfg)
    poll = AsyncMock()
    monkeypatch.setattr(app.state.dockhand, "refresh", poll)
    with TestClient(app) as client:
        assert client.get("/api/targets").status_code == 401
        poll.assert_not_awaited()


async def test_scheduled_os_checks_skip_native_discovery_and_pulls_on_dockhand_mapping(monkeypatch):
    executor = FakeExecutor()
    executor.run = AsyncMock(wraps=executor.run)
    inv = _inventory((_target(), executor))
    monkeypatch.setattr(inv, "refresh", AsyncMock())
    jobs = JobManager(inv, docker_enabled=True, dockhand_targets={"t1": "https://dockhand.example"})
    scheduler = Scheduler(None, inv, jobs, None, check_docker=True)
    await scheduler.run_once()
    assert [job.action for job in jobs.jobs.values()] == ["check"]
    assert all(call.args[0] != DOCKER_DETECT_SCRIPT for call in executor.run.call_args_list)
