"""HTTPS client for the FLO Print portal (agent endpoints only)."""

import requests
from print_agent.models import TemporaryError


class ApiError(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"Portal rejected request (HTTP {status})")


class Client:
    def __init__(self, profile):
        self.profile = profile
        self.base = profile["backend_url"].rstrip("/")
        self.http = requests.Session()
        self.http.headers.update({"Authorization": "Bearer " + profile["agent_token"]})

    def call(self, path, payload=None, claim=None):
        try:
            response = self.http.request(
                "POST" if payload is not None else "GET",
                self.base + "/api" + path,
                json=payload,
                headers={"X-Claim-ID": claim} if claim else {},
                timeout=(10, 45),
                allow_redirects=False,
            )
        except requests.RequestException:
            raise TemporaryError("Portal connection unavailable") from None
        if response.status_code == 429 or response.status_code >= 500:
            raise TemporaryError("Portal temporarily unavailable")
        if response.status_code // 100 != 2:
            raise ApiError(response.status_code)
        try:
            return response.json()
        except ValueError:
            raise TemporaryError("Unexpected portal response") from None

    def download(self, job, path):
        """Fetches the document part by part (the portal serves ~2 MB per request) and checks the size."""
        limit = min(job["bytes"], job["config"]["max_file_mb"] * 1048576)
        size = 0
        try:
            with path.open("wb") as out:
                for part in range(job["total_chunks"]):
                    response = self.http.get(
                        self.base + f"/api/agent/jobs/{job['id']}/file",
                        params={"part": part},
                        headers={"X-Claim-ID": job["claim_id"]},
                        timeout=(10, 60),
                        allow_redirects=False,
                    )
                    if response.status_code == 429 or response.status_code >= 500:
                        raise TemporaryError("Portal temporarily unavailable")
                    if response.status_code != 200:
                        raise ApiError(response.status_code)
                    size += len(response.content)
                    if size > limit:
                        raise ValueError("Download size limit")
                    out.write(response.content)
        except requests.RequestException:
            raise TemporaryError("Document download interrupted") from None
        if size != job["bytes"]:
            raise ValueError("Download byte count mismatch")
