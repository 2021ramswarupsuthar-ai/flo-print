"""Agent tests. They run the REAL portal backend (Node, in-memory SQLite) and drive the real agent worker against it
with a fake Windows printer, so the whole protocol (claim -> download -> verify -> render -> print -> report) is exercised.
Windows-only code (GDI printing) and PDF rendering (needs PyMuPDF) cannot run here and are covered separately.
"""

import base64
import importlib.util
import io
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
AGENT_ROOT = HERE.parent
PROJECT = AGENT_ROOT.parent
sys.path.insert(0, str(AGENT_ROOT))

from print_agent import documents, worker as worker_module  # noqa: E402
from print_agent.client import Client  # noqa: E402
from print_agent.models import TemporaryError, UncertainPrint, ValidationError  # noqa: E402
from print_agent.state import Journal  # noqa: E402
from print_agent.worker import Worker  # noqa: E402

CHUNK = 2 * 1024 * 1024


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakePrinter:
    def __init__(self):
        self.submitted, self.fail, self.not_ready = [], None, None
        self.wp = SimpleNamespace(DeviceCapabilities=lambda *a: 1)

    def names(self):
        return ["EPSON L6270 Series"]

    def ready(self, name):
        if self.not_ready:
            raise self.not_ready
        return {"pPortName": "USB001"}

    def devmode(self, name, settings):
        return None

    def submit(self, name, pages, settings, title, on_spooled, timeout=180):
        if self.fail:
            raise self.fail
        on_spooled(77)
        self.submitted.append({"name": name, "pages": [Path(p).name for p in pages], "settings": settings, "title": title})
        return "SPOOLER_COMPLETE: Windows reports the job was sent to the printer."


def jpeg_bytes(w=300, h=200, noise=False):
    img = Image.frombytes("RGB", (w, h), os.urandom(w * h * 3)) if noise else Image.new("RGB", (w, h), (200, 30, 30))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=95)
    return buf.getvalue()


class AgentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.base = f"http://127.0.0.1:{cls.port}"
        env = {**os.environ, "PORT": str(cls.port), "DB_FILE": ":memory:", "ADMIN_PASSWORD": "adminpass123"}
        cls.server = subprocess.Popen(["node", "--no-warnings", "server/dev.js"], cwd=PROJECT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                if requests.get(cls.base + "/api/health", timeout=1).ok:
                    break
            except requests.RequestException:
                time.sleep(0.25)
        else:
            raise RuntimeError("portal did not start")
        cls.admin = requests.Session()
        cls.admin.headers["X-Requested-With"] = "flo-print"
        r = cls.admin.post(cls.base + "/api/login", json={"username": "admin", "password": "adminpass123"})
        assert r.ok, r.text
        token = cls.api("POST", "/admin/agents", {"name": "Test PC"})["token"]
        cls.profile = {"backend_url": cls.base, "agent_token": token, "printers": ["EPSON L6270 Series"], "poll_seconds": 1}

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=5)

    @classmethod
    def api(cls, method, path, body=None):
        r = cls.admin.request(method, cls.base + "/api" + path, json=body)
        if not r.ok:
            raise AssertionError(f"{method} {path} -> {r.status_code} {r.text}")
        return r.json()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.printer = FakePrinter()
        self.client = Client(self.profile)
        self.worker = Worker(self.root, self.profile, Journal(self.root / "state" / "agent.db"), self.client, self.printer)
        self.worker.stop.set()
        self.client.call("/agent/heartbeat", {"printers": self.worker.inventory(), "installed": self.worker.installed()})
        self.drain()

    def tearDown(self):
        self.tmp.cleanup()

    def drain(self):
        """Clear anything left in the portal queue by earlier tests."""
        for j in self.api("GET", "/jobs?status=active&scope=all")["jobs"]:
            if j["raw_status"] in ("QUEUED", "UPLOADING"):
                self.api("POST", f"/jobs/{j['id']}/cancel", {})
            elif j["raw_status"] == "NEEDS_REVIEW":
                self.api("POST", f"/jobs/{j['id']}/resolve", {"outcome": "not-printed"})

    def submit(self, name, data, **settings):
        body = {"key": uuid.uuid4().hex, "printer_id": "epson-l6270", "copies": 1, "color": "bw", "orientation": "portrait", "pages": "all"}
        body.update(settings)
        body["files"] = [{"name": name, "size": len(data)}]
        job = self.api("POST", "/jobs/start", body)["jobs"][0]
        for n in range(job["total_chunks"]):
            part = data[n * CHUNK : (n + 1) * CHUNK]
            self.api("POST", f"/jobs/{job['id']}/chunk/{n}", {"data": base64.b64encode(part).decode()})
        return self.api("POST", f"/jobs/{job['id']}/finish", {})["job"]

    def claim_and_process(self):
        job = self.client.call("/agent/claim", {}).get("job")
        if job:
            self.worker.process(job)
        return job

    def portal_job(self, jid):
        return self.api("GET", f"/jobs/{jid}")["job"]

    # ---------- tests ----------
    def test_inventory_reaches_portal(self):
        rows = self.worker.inventory()
        self.assertEqual(rows, [{"name": "EPSON L6270 Series", "online": True, "color": True, "note": ""}])
        printers = self.api("GET", "/printers")["printers"]
        self.assertTrue(printers[0]["online"])
        self.assertTrue(printers[0]["color"])

    def test_jpeg_job_end_to_end(self):
        job = self.submit("photo.jpg", jpeg_bytes(), copies=3, color="color", orientation="landscape")
        self.assertEqual(self.claim_and_process()["id"], job["id"])
        sent = self.printer.submitted[0]
        self.assertEqual((sent["settings"].copies, sent["settings"].color, sent["settings"].orientation), (3, "color", "landscape"))
        self.assertEqual(sent["pages"], ["00000.png"])
        done = self.portal_job(job["id"])
        self.assertEqual(done["raw_status"], "COMPLETED")
        self.assertEqual(done["page_count"], 1)
        self.assertIn("SPOOLER_COMPLETE", done["evidence"])
        self.assertEqual(list((self.root / "downloads").glob("*")), [])  # cleaned up

    def test_multi_part_download_is_verified(self):
        data = jpeg_bytes(2200, 1800, noise=True)
        self.assertGreater(len(data), CHUNK, "test needs a multi-part file")
        job = self.submit("big.jpg", data)
        self.assertGreater(job["bytes"], CHUNK)
        self.claim_and_process()
        self.assertEqual(self.portal_job(job["id"])["raw_status"], "COMPLETED")

    def test_duplicate_claim_never_prints_twice(self):
        job = self.submit("once.jpg", jpeg_bytes())
        claimed = self.client.call("/agent/claim", {})["job"]
        self.worker.process(claimed)
        self.worker.process(claimed)  # same claim delivered again
        self.assertEqual(len(self.printer.submitted), 1)
        self.assertEqual(self.portal_job(job["id"])["raw_status"], "COMPLETED")

    def test_unknown_printer_fails_without_printing(self):
        job = self.submit("a.jpg", jpeg_bytes())
        self.worker.profile = {**self.profile, "printers": ["Some Other Printer"]}
        self.claim_and_process()
        failed = self.portal_job(job["id"])
        self.assertEqual(failed["raw_status"], "FAILED")
        self.assertIn("not set up for the printer", failed["error"])
        self.assertEqual(self.printer.submitted, [])

    def test_corrupt_image_fails_cleanly(self):
        job = self.submit("bad.jpg", b"\xff\xd8\xff\xe0" + os.urandom(2000))
        self.claim_and_process()
        failed = self.portal_job(job["id"])
        self.assertEqual(failed["raw_status"], "FAILED")
        self.assertEqual(self.printer.submitted, [])

    def test_uncertain_print_blocks_queue_until_admin_resolves(self):
        first = self.submit("one.jpg", jpeg_bytes())
        second = self.submit("two.jpg", jpeg_bytes())
        self.printer.fail = UncertainPrint("Printing interrupted after submission (spool ID 9); inspect output before retry")
        self.claim_and_process()
        self.assertEqual(self.portal_job(first["id"])["raw_status"], "NEEDS_REVIEW")
        self.assertIsNone(self.client.call("/agent/claim", {})["job"])  # queue is held
        self.api("POST", f"/jobs/{first['id']}/resolve", {"outcome": "printed"})
        self.printer.fail = None
        self.assertEqual(self.claim_and_process()["id"], second["id"])
        self.assertEqual(self.portal_job(second["id"])["raw_status"], "COMPLETED")

    def test_printer_not_ready_requeues_for_retry(self):
        job = self.submit("wait.jpg", jpeg_bytes())
        self.printer.not_ready = TemporaryError("Printer reports offline, paused or an error; inspect Windows printer queue")
        self.claim_and_process()
        waiting = self.portal_job(job["id"])
        self.assertEqual(waiting["raw_status"], "QUEUED")
        self.assertIn("retry", waiting["message"].lower())
        self.assertEqual(self.printer.submitted, [])
        self.assertEqual(self.worker.journal.get(job["id"])["state"], "SAFE_RETRY")

    def test_pdf_page_selection_reaches_the_renderer(self):
        seen = {}

        def fake_inspect(path, config, selection):
            seen["selection"] = selection
            return [0, 1], 5

        def fake_render(path, directory, chosen, color):
            directory.mkdir(parents=True, exist_ok=True)
            out = []
            for i, _ in enumerate(chosen):
                p = directory / f"{i:05}.png"
                Image.new("RGB", (50, 50), "white").save(p)
                out.append(p)
            return out

        original = worker_module.inspect, worker_module.render
        worker_module.inspect, worker_module.render = fake_inspect, fake_render
        try:
            job = self.submit("doc.pdf", b"%PDF-1.4\n" + os.urandom(5000), pages="1-2", copies=2)
            self.claim_and_process()
        finally:
            worker_module.inspect, worker_module.render = original
        self.assertEqual(seen["selection"], "1,2")
        self.assertEqual(len(self.printer.submitted[0]["pages"]), 2)
        done = self.portal_job(job["id"])
        self.assertEqual((done["raw_status"], done["page_count"]), ("COMPLETED", 5))

    def test_cancelled_job_is_never_handed_out(self):
        job = self.submit("c.jpg", jpeg_bytes())
        self.api("POST", f"/jobs/{job['id']}/cancel", {})
        self.assertIsNone(self.client.call("/agent/claim", {})["job"])


class DocumentTests(unittest.TestCase):
    def test_page_selection(self):
        self.assertEqual(documents.pages("all", 3), [0, 1, 2])
        self.assertEqual(documents.pages("1,3", 3), [0, 2])
        with self.assertRaises(ValidationError) as ctx:
            documents.pages("2,9", 4)
        self.assertIn("Page 9 does not exist", str(ctx.exception))
        for bad in ("", "0", "a", "1,1"):
            with self.assertRaises(ValidationError):
                documents.pages(bad, 3)

    def test_jpeg_inspect_and_render(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.jpg"
            p.write_bytes(jpeg_bytes())
            chosen, count = documents.inspect(p, {"max_file_mb": 20, "max_pages": 300}, "all")
            self.assertEqual((chosen, count), ([0], 1))
            out = documents.render(p, Path(d) / "out", chosen, "bw")
            self.assertEqual(len(out), 1)
            with Image.open(out[0]) as im:
                self.assertEqual(im.mode, "L")
            p.write_bytes(b"not an image at all")
            with self.assertRaises(ValidationError):
                documents.inspect(p, {"max_file_mb": 20, "max_pages": 300}, "all")

    def test_unsupported_extension(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.png"
            p.write_bytes(b"x")
            with self.assertRaises(ValidationError) as ctx:
                documents.inspect(p, {"max_file_mb": 20, "max_pages": 300}, "all")
            self.assertIn("Not Supported", str(ctx.exception))

    @unittest.skipUnless(importlib.util.find_spec("fitz"), "PyMuPDF not installed in this environment")
    def test_pdf_pages(self):
        import fitz

        with tempfile.TemporaryDirectory() as d:
            doc = fitz.open()
            for _ in range(3):
                doc.new_page()
            p = Path(d) / "x.pdf"
            doc.save(p)
            chosen, count = documents.inspect(p, {"max_file_mb": 20, "max_pages": 300}, "1,3")
            self.assertEqual((chosen, count), ([0, 2], 3))
            self.assertEqual(len(documents.render(p, Path(d) / "out", chosen, "color")), 2)


class JournalTests(unittest.TestCase):
    def test_crash_while_printing_needs_review(self):
        with tempfile.TemporaryDirectory() as d:
            j = Journal(Path(d) / "state" / "a.db")
            j.prepare({"id": "abc", "claim_id": "c"})
            j.set("abc", "PRINTING")
            j.recovery()
            row = j.get("abc")
            self.assertEqual(row["state"], "NEEDS_REVIEW")
            self.assertEqual(len(j.pending()), 1)


if __name__ == "__main__":
    unittest.main()
