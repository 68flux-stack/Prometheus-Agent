from __future__ import annotations

import asyncio
import importlib
import unittest
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")


def job_payload(**overrides):
    payload = {
        "id": "job-1234",
        "command": "make test",
        "cwd": "/tmp/project",
        "status": "running",
        "revision": 2,
        "startedAt": "2026-08-11T00:00:00.000Z",
        "detached": False,
        "outputBytes": 12,
        "progress": {"percent": 25},
    }
    payload.update(overrides)
    return payload


class JobsTest(unittest.TestCase):
    def test_starts_and_waits_for_job(self) -> None:
        host_request = AsyncMock(
            side_effect=[
                {"job": job_payload()},
                {"job": job_payload(status="completed", revision=3, exitCode=0)},
            ]
        )
        with patch.object(rlm_module, "host_request", host_request):
            job = asyncio.run(rlm_module.jobs.start("make test"))
            completed = asyncio.run(job.wait(timeout=2))

        self.assertEqual(job.progress.percent, 25)
        self.assertEqual(completed.status, "completed")
        host_request.assert_any_await(
            "jobs.start",
            {"command": "make test", "cwd": None, "env": None, "detached": False},
        )
        host_request.assert_any_await(
            "jobs.wait",
            {"id": "job-1234", "since_revision": 2, "timeout_ms": 2000},
        )

    def test_lists_and_tails_jobs(self) -> None:
        host_request = AsyncMock(side_effect=[{"jobs": [job_payload()]}, {"output": "test output"}])
        with patch.object(rlm_module, "host_request", host_request):
            jobs = asyncio.run(rlm_module.rlm.jobs.list())
            output = asyncio.run(jobs[0].tail(100))

        self.assertEqual(output, "test output")
        host_request.assert_any_await("jobs.list", None)
        host_request.assert_any_await("jobs.tail", {"id": "job-1234", "max_chars": 100})


if __name__ == "__main__":
    unittest.main()
