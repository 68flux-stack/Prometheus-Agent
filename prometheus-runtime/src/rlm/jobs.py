"""Session-owned background command jobs for the Prometheus runtime."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

async def _host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    # Imported lazily because rlm.__init__ re-exports this module's public API.
    from . import host_request

    return await host_request(request_type, payload)


@dataclass(frozen=True)
class JobProgress:
    percent: float | None = None
    current: float | None = None
    total: float | None = None
    message: str | None = None


@dataclass(frozen=True)
class Job:
    id: str
    command: str
    cwd: str
    status: str
    revision: int
    started_at: str
    finished_at: str | None = None
    elapsed_ms: int | None = None
    pid: int | None = None
    exit_code: int | None = None
    signal: str | None = None
    detached: bool = False
    output_bytes: int = 0
    progress: JobProgress | None = None

    async def tail(self, max_chars: int = 16_000) -> str:
        payload = await _host_request("jobs.tail", {"id": self.id, "max_chars": max_chars})
        output = payload.get("output")
        if not isinstance(output, str):
            raise RuntimeError("jobs.tail returned invalid output")
        return output

    async def wait(self, timeout: float = 30.0) -> Job:
        payload = await _host_request(
            "jobs.wait",
            {"id": self.id, "since_revision": self.revision, "timeout_ms": round(timeout * 1000)},
        )
        return _job_from_payload(payload.get("job"), "jobs.wait")

    async def cancel(self) -> Job:
        payload = await _host_request("jobs.cancel", {"id": self.id})
        return _job_from_payload(payload.get("job"), "jobs.cancel")

    async def write(self, input_text: str) -> Job:
        if not isinstance(input_text, str):
            raise TypeError(f"input_text must be str, got {type(input_text).__name__}")
        payload = await _host_request("jobs.write", {"id": self.id, "input": input_text})
        return _job_from_payload(payload.get("job"), "jobs.write")


def _job_from_payload(payload: Any, operation: str) -> Job:
    if not isinstance(payload, dict):
        raise RuntimeError(f"{operation} returned an invalid job")
    required = ("id", "command", "cwd", "status", "revision", "startedAt")
    if any(key not in payload for key in required):
        raise RuntimeError(f"{operation} returned an incomplete job")
    progress_payload = payload.get("progress")
    progress = None
    if isinstance(progress_payload, dict):
        progress = JobProgress(
            percent=progress_payload.get("percent"),
            current=progress_payload.get("current"),
            total=progress_payload.get("total"),
            message=progress_payload.get("message"),
        )
    return Job(
        id=str(payload["id"]),
        command=str(payload["command"]),
        cwd=str(payload["cwd"]),
        status=str(payload["status"]),
        revision=int(payload["revision"]),
        started_at=str(payload["startedAt"]),
        finished_at=payload.get("finishedAt"),
        elapsed_ms=payload.get("elapsedMs"),
        pid=payload.get("pid"),
        exit_code=payload.get("exitCode"),
        signal=payload.get("signal"),
        detached=payload.get("detached") is True,
        output_bytes=int(payload.get("outputBytes", 0)),
        progress=progress,
    )


class Jobs:
    async def start(
        self,
        command: str,
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        detached: bool = False,
    ) -> Job:
        if not isinstance(command, str):
            raise TypeError(f"command must be str, got {type(command).__name__}")
        payload = await _host_request(
            "jobs.start",
            {"command": command, "cwd": cwd, "env": env, "detached": detached},
        )
        return _job_from_payload(payload.get("job"), "jobs.start")

    async def list(self) -> list[Job]:
        payload = await _host_request("jobs.list")
        entries = payload.get("jobs")
        if not isinstance(entries, list):
            raise RuntimeError("jobs.list returned an invalid job list")
        return [_job_from_payload(entry, "jobs.list") for entry in entries]

    async def get(self, job_id: str) -> Job:
        payload = await _host_request("jobs.get", {"id": job_id})
        return _job_from_payload(payload.get("job"), "jobs.get")


jobs = Jobs()

__all__ = ["Job", "JobProgress", "Jobs", "jobs"]
