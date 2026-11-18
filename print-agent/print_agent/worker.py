"""Main loop: claim a job from the portal, download, verify, render, print, and report the result.

Safety rules (kept from the proven design):
* A durable journal records "ARMED" *before* the portal is told printing started, so a lost
  acknowledgement can never lead to a blind second print: those jobs go to NEEDS_REVIEW instead.
* Anything that failed before paper could have moved is reported as a normal FAILED/retry.
"""

import hashlib
import json
import logging
import shutil
import threading
import time

from print_agent.client import ApiError, Client
from print_agent.documents import inspect, render
from print_agent.models import Settings, TemporaryError, UncertainPrint, ValidationError


class Worker:
    def __init__(self, root, profile, journal, client, printer):
        self.root, self.profile, self.journal, self.client, self.printer = root, profile, journal, client, printer
        self.stop = threading.Event()
        self.log = logging.getLogger("print-agent")
        for folder in ("downloads", "processing", "temp"):
            (root / folder).mkdir(exist_ok=True)

    # ---- status shown in the portal ----
    def inventory(self):
        rows = []
        for name in self.profile.get("printers", []):
            online, color, note = False, False, ""
            try:
                info = self.printer.ready(name)
                online = True
                color = self.printer.wp.DeviceCapabilities(name, info["pPortName"], 32) == 1
            except TemporaryError as error:
                note = str(error)
            except Exception as error:  # printer removed, driver problem...
                note = str(error) or "Printer not available"
            rows.append({"name": name, "online": online, "color": color, "note": note})
        return rows

    def installed(self):
        try:
            return self.printer.names()
        except Exception:
            return []

    def heartbeat(self):
        client = Client(self.profile)  # separate HTTP session so a long print never blocks heartbeats
        while not self.stop.is_set():
            try:
                client.call("/agent/heartbeat", {"printers": self.inventory(), "installed": self.installed()})
            except Exception:
                self.log.warning("Heartbeat unavailable")
            self.stop.wait(15)

    # ---- results ----
    def report_pending(self):
        for row in self.journal.pending():
            job = json.loads(row["job"])
            result = json.loads(row["result"])
            try:
                self.client.call(f"/agent/jobs/{job['id']}/result", result, job["claim_id"])
                self.journal.set(job["id"], row["state"], result, reported=1)
                if row["state"] in ("COMPLETED", "FAILED"):
                    for folder in ("downloads", "processing"):
                        for p in (self.root / folder).glob(job["id"] + ".*"):
                            p.unlink()
            except ApiError as error:
                if error.status in (404, 409):
                    # The portal already settled this job (for example an admin resolved it). Stop re-reporting.
                    self.journal.set(job["id"], row["state"], result, reported=1)
                    self.log.warning("Portal already settled job=%s (HTTP %s)", job["id"], error.status)
                else:
                    self.log.warning("Result rejected job=%s (HTTP %s)", job["id"], error.status)
            except Exception:
                self.log.warning("Result report deferred job=%s", job["id"])

    # ---- one job ----
    def process(self, job):
        old = self.journal.get(job["id"])
        if old and old["state"] not in ("PREPARING", "SAFE_RETRY"):
            self.log.warning("Duplicate physical submission blocked job=%s", job["id"])
            self.report_pending()
            return
        self.journal.prepare(job)
        with self.journal.db:  # refresh the claim when a retryable job receives a new lease
            self.journal.db.execute("UPDATE jobs SET job=? WHERE id=?", (json.dumps(job), job["id"]))
        ext = ".pdf" if job["file_type"] == "application/pdf" else ".jpg" if job["file_type"] == "image/jpeg" else ""
        path = self.root / "downloads" / (job["id"] + ext)
        directory = self.root / "temp" / job["id"]
        shutil.rmtree(directory, ignore_errors=True)
        armed = False
        page_count = None

        def review(message):
            self.journal.set(job["id"], "NEEDS_REVIEW", {"status": "NEEDS_REVIEW", "error": message})

        def failed(message):
            self.journal.set(job["id"], "FAILED", {"status": "FAILED", "error": message})

        try:
            if not ext:
                raise ValidationError("Unsupported file format")
            if job["printer"] not in self.profile.get("printers", []):
                raise ValidationError(f"This PC is not set up for the printer '{job['printer']}'")
            c = job["config"]
            settings = Settings(job["copies"], job["color"], job["orientation"])
            if (
                not 1 <= settings.copies <= c["max_copies"]
                or settings.color not in ("bw", "color")
                or settings.orientation not in ("portrait", "landscape")
            ):
                raise ValidationError("Invalid print settings")
            self.printer.ready(job["printer"])
            self.printer.devmode(job["printer"], settings)
            self.client.download(job, path)
            if hashlib.sha256(path.read_bytes()).hexdigest() != job["hash"]:
                raise ValidationError("File integrity check failed (the file changed in transit)")
            chosen, page_count = inspect(path, c, job["pages"])
            processing = self.root / "processing" / path.name
            path.replace(processing)
            path = processing
            output = render(path, directory, chosen, settings.color)
            # Durable ARMED *before* telling the portal printing started.
            self.journal.set(job["id"], "ARMED")
            armed = True
            self.client.call(f"/agent/jobs/{job['id']}/start", {}, job["claim_id"])
            self.journal.set(job["id"], "PRINTING")

            def spooled(spool_id):
                self.journal.set(job["id"], "PRINTING", spool_id=spool_id)
                try:
                    self.client.call(f"/agent/jobs/{job['id']}/spool", {"spool_id": spool_id}, job["claim_id"])
                except Exception:
                    self.log.warning("Spool report deferred job=%s", job["id"])

            evidence = self.printer.submit(job["printer"], output, settings, "FLO Print " + job["id"][:8], spooled, 180)
            self.journal.set(
                job["id"], "COMPLETED", {"status": "COMPLETED", "evidence": evidence[:400], "page_count": page_count}
            )
            self.log.info("COMPLETED job=%s", job["id"])
        except ApiError as error:
            if 400 <= error.status < 500:
                # 404/409 = the portal no longer considers this claim valid (lease expired / cancelled).
                if armed or error.status in (401, 403, 404, 409):
                    self.journal.set(job["id"], "SAFE_RETRY")
                else:
                    failed(str(error))
                if path.exists():
                    path.unlink()
                self.log.warning("Request rejected before physical submission job=%s", job["id"])
            else:
                review("Could not confirm the start of printing. Check the printer output and the Windows queue.")
        except TemporaryError as error:
            if armed:
                review(str(error))
            else:
                self.journal.set(job["id"], "SAFE_RETRY")
                try:
                    self.client.call(f"/agent/jobs/{job['id']}/retry", {"error": str(error)}, job["claim_id"])
                except Exception:
                    pass  # the portal's lease expires safely if no start was acknowledged
        except ValidationError as error:
            review(str(error)) if armed else failed(str(error))
        except UncertainPrint as error:
            review(str(error))
        except Exception:
            self.log.exception("Unexpected failure job=%s", job["id"])
            review("Unexpected failure; check the physical output before printing again.")
        finally:
            shutil.rmtree(directory, ignore_errors=True)
        self.report_pending()

    def run(self):
        self.journal.recovery()
        thread = threading.Thread(target=self.heartbeat, daemon=True)
        thread.start()
        try:
            self.client.call("/agent/heartbeat", {"printers": self.inventory(), "installed": self.installed()})
            while True:
                self.report_pending()
                try:
                    response = self.client.call("/agent/claim", {})
                    if response.get("job"):
                        self.process(response["job"])
                        continue  # look for the next job immediately
                except Exception:
                    self.log.warning("Queue connection unavailable")
                time.sleep(self.profile.get("poll_seconds", 5))
        finally:
            self.stop.set()
            thread.join(timeout=5)
