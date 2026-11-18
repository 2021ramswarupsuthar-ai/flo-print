import hashlib
import json
import os
import time
from pathlib import Path
from PIL import Image, ImageWin
from print_agent.models import TemporaryError, ValidationError, UncertainPrint


class WindowsPrinter:
    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("Actual printing requires Windows")
        import win32print, win32gui, win32con

        self.wp, self.wg, self.wc = win32print, win32gui, win32con

    def names(self):
        flags = self.wp.PRINTER_ENUM_LOCAL | self.wp.PRINTER_ENUM_CONNECTIONS
        return [p["pPrinterName"] for p in self.wp.EnumPrinters(flags, None, 2)]

    def info(self, name):
        if name not in self.names():
            raise ValidationError("Selected printer is not installed")
        handle = self.wp.OpenPrinter(name)
        try:
            return self.wp.GetPrinter(handle, 2)
        finally:
            self.wp.ClosePrinter(handle)

    def fingerprint(self, name):
        info = self.info(name)
        identity = [
            name,
            info["pDriverName"],
            info["pPortName"],
            info.get("pPrintProcessor"),
        ]
        return hashlib.sha256(json.dumps(identity).encode()).hexdigest()

    def ready(self, name):
        info = self.info(name)
        mask = 0
        for key in (
            "PRINTER_STATUS_OFFLINE",
            "PRINTER_STATUS_ERROR",
            "PRINTER_STATUS_PAPER_OUT",
            "PRINTER_STATUS_PAPER_JAM",
            "PRINTER_STATUS_PAUSED",
            "PRINTER_STATUS_NOT_AVAILABLE",
            "PRINTER_STATUS_USER_INTERVENTION",
            "PRINTER_STATUS_DOOR_OPEN",
            "PRINTER_STATUS_NO_TONER",
        ):
            mask |= getattr(self.wp, key, 0)
        if info["Status"] & mask or info["Attributes"] & getattr(
            self.wp, "PRINTER_ATTRIBUTE_WORK_OFFLINE", 1024
        ):
            raise TemporaryError(
                "Printer reports offline, paused or an error; inspect Windows printer queue"
            )
        return info

    def devmode(self, name, settings):
        info = self.ready(name)
        dm = info["pDevMode"]
        if dm is None:
            raise ValidationError("Printer driver does not expose DEVMODE")
        wc = self.wc
        # Copies are implemented by repeating rendered pages, never by driver copies.
        if not dm.Fields & wc.DM_ORIENTATION:
            raise ValidationError("Driver does not advertise orientation control")
        has_color_control = bool(dm.Fields & wc.DM_COLOR)
        if settings.color == "color" and not has_color_control:
            raise ValidationError("Selected printer driver does not support color control; choose B&W")
        if settings.color == "color":
            capability = self.wp.DeviceCapabilities(name, info["pPortName"], 32)
            if capability != 1:
                raise ValidationError("Selected printer does not support color")
        desired_color = (
            wc.DMCOLOR_COLOR if settings.color == "color" else wc.DMCOLOR_MONOCHROME
        )
        desired_orientation = (
            wc.DMORIENT_LANDSCAPE
            if settings.orientation == "landscape"
            else wc.DMORIENT_PORTRAIT
        )
        dm.Fields |= wc.DM_ORIENTATION
        if has_color_control:
            dm.Fields |= wc.DM_COLOR
            dm.Color = desired_color
        # A monochrome driver may omit DM_COLOR. B&W pages are rendered in grayscale.
        dm.Orientation = desired_orientation
        if dm.Fields & wc.DM_COPIES:
            dm.Copies = 1
        if dm.Fields & getattr(wc, "DM_DUPLEX", 4096):
            dm.Duplex = getattr(wc, "DMDUP_SIMPLEX", 1)
        handle = self.wp.OpenPrinter(name)
        try:
            result = self.wp.DocumentProperties(
                0, handle, name, dm, dm, wc.DM_IN_BUFFER | wc.DM_OUT_BUFFER
            )
            if result != 1:
                raise ValidationError("Printer driver rejected print settings")
        finally:
            self.wp.ClosePrinter(handle)
        if (
            (has_color_control and dm.Color != desired_color)
            or dm.Orientation != desired_orientation
            or (dm.Fields & wc.DM_COPIES and dm.Copies != 1)
        ):
            raise ValidationError(
                "Driver changed requested color/orientation/copies; print aborted"
            )
        return dm

    def submit(self, name, pages, settings, title, on_spooled, timeout=180):
        dm = self.devmode(name, settings)  # All failures here are before submission.
        dc = None
        job_id = None
        began = False
        try:
            dc = self.wg.CreateDC("WINSPOOL", name, dm)
            width = self.wp.GetDeviceCaps(dc, self.wc.HORZRES)
            height = self.wp.GetDeviceCaps(dc, self.wc.VERTRES)
            if width <= 0 or height <= 0:
                raise ValidationError("Invalid printer page dimensions")
            began = (
                True  # StartDoc may succeed remotely even if its return is interrupted.
            )
            job_id = self.wp.StartDoc(dc, (title, None, None, 0))
            if not job_id or job_id < 0:
                raise UncertainPrint("StartDoc did not return a valid job ID")
            on_spooled(job_id)
            for _ in range(settings.copies):
                for path in pages:
                    self.wp.StartPage(dc)
                    with Image.open(path) as source:
                        image = source.convert("RGB")
                        scale = min(width / image.width, height / image.height)
                        w, h = max(1, int(image.width * scale)), max(
                            1, int(image.height * scale)
                        )
                        x, y = (width - w) // 2, (height - h) // 2
                        ImageWin.Dib(image).draw(dc, (x, y, x + w, y + h))
                    self.wp.EndPage(dc)
            self.wp.EndDoc(dc)
        except Exception as exc:
            if dc and began:
                try:
                    self.wp.AbortDoc(dc)
                except Exception:
                    pass
            if began:
                raise UncertainPrint(
                    f"Printing interrupted after submission (spool ID {job_id}); inspect output before retry"
                ) from None
            if isinstance(exc, (TemporaryError, ValidationError)):
                raise
            raise TemporaryError("Could not open printer device context") from None
        finally:
            if dc:
                self.wg.DeleteDC(dc)
        return self.wait(name, job_id, timeout, submitted=True)

    def wait(self, name, job_id, timeout, submitted=False):
        handle = self.wp.OpenPrinter(name)
        try:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    job = self.wp.GetJob(handle, job_id, 1)
                except Exception as error:
                    code = getattr(error, "winerror", None)
                    if code is None and error.args:
                        code = error.args[0]
                    if submitted and code in (2, 87):
                        # EndDoc succeeded. Confirm only an independently empty, healthy queue.
                        try:
                            remaining = self.wp.EnumJobs(handle, 0, 10000, 1)
                            self.ready(name)
                            gone = len(remaining) < 10000 and not any(item["JobId"] == job_id for item in remaining)
                        except Exception:
                            gone = False
                        if gone:
                            return "QUEUE_CLEARED: Windows accepted the full document and removed it from a healthy queue. Automatically confirmed; physical paper delivery was not independently verified."
                    raise UncertainPrint(
                        "Print job disappeared; completion cannot be established from queue removal alone"
                    ) from None
                flags = job["Status"]
                failure = 0
                for key in (
                    "JOB_STATUS_ERROR",
                    "JOB_STATUS_OFFLINE",
                    "JOB_STATUS_PAPEROUT",
                    "JOB_STATUS_BLOCKED_DEVQ",
                    "JOB_STATUS_USER_INTERVENTION",
                    "JOB_STATUS_DELETED",
                    "JOB_STATUS_DELETING",
                ):
                    failure |= getattr(self.wp, key, 0)
                if flags & failure:
                    raise UncertainPrint(
                        "Submitted job reports an error; it may still print after the printer recovers"
                    )
                if flags & self.wp.JOB_STATUS_PRINTED:
                    return "Windows spooler reported JOB_STATUS_PRINTED. Physical paper delivery is not independently measurable; some port monitors report this early."
                if flags & getattr(self.wp, "JOB_STATUS_COMPLETE", 0):
                    return "SPOOLER_COMPLETE: Windows reports the job was sent to the printer. Automatically confirmed; physical paper delivery was not independently verified."
                time.sleep(1)
            raise UncertainPrint(
                "Timed out waiting for spooler completion; inspect queue and output"
            )
        finally:
            self.wp.ClosePrinter(handle)
