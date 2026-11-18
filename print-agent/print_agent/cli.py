import getpass
import logging
import logging.handlers
import sys
from pathlib import Path

from PIL import Image, ImageDraw

from print_agent import profile as profile_store
from print_agent.client import Client
from print_agent.lock import single_instance
from print_agent.models import Settings
from print_agent.security import protect
from print_agent.state import Journal
from print_agent.worker import Worker

ROOT = Path(__file__).resolve().parents[1]


def _logging():
    (ROOT / "logs").mkdir(exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(ROOT / "logs" / "agent.log", maxBytes=1_000_000, backupCount=3)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%H:%M:%S"))
    logging.basicConfig(level=logging.INFO, handlers=[handler, console])


def _printer():
    from print_agent.windows import WindowsPrinter

    return WindowsPrinter()


def setup():
    protect(ROOT)
    print("FLO Print Agent setup\n")
    url = input("Portal address (for example https://your-project.vercel.app): ").strip().rstrip("/")
    token = getpass.getpass("Connection key (from Manage > Printer PCs; typing is hidden): ").strip()
    if not url.startswith("https://") and not url.startswith("http://localhost"):
        sys.exit("The portal address must start with https://")
    printer = _printer()
    names = printer.names()
    if not names:
        sys.exit("No printers are installed on this PC.")
    print("\nPrinters on this PC:")
    for i, name in enumerate(names, 1):
        print(f"  {i}. {name}")
    guess = next((i for i, n in enumerate(names, 1) if "L6270" in n.upper()), 1)
    picked = input(f"\nWhich printer(s) should FLO Print use? Numbers separated by commas [{guess}]: ").strip() or str(guess)
    try:
        chosen = [names[int(n) - 1] for n in picked.split(",")]
    except (ValueError, IndexError):
        sys.exit("Please enter valid numbers from the list.")
    data = {"backend_url": url, "agent_token": token, "printers": chosen, "poll_seconds": 5}
    client = Client(data)
    try:
        reply = client.call("/agent/heartbeat", {"printers": [{"name": n, "online": True, "color": False, "note": ""} for n in chosen], "installed": names})
    except Exception as error:
        sys.exit(f"Could not reach the portal with that address and key: {error}")
    profile_store.save(ROOT, data)
    print("\nConnected. Saved (encrypted for this Windows user).")
    missing = [n for n in chosen if n not in reply.get("expected", [])]
    if missing:
        print("\nNOTE: the portal does not have these printers yet. In the portal open Manage > Printers and set")
        print("the 'Windows printer name' to exactly:", ", ".join(f"'{n}'" for n in missing))
    print("\nNext: run  test-page.bat  to print a test page, then  start.bat  to go live.")


def run():
    protect(ROOT)
    data = profile_store.load(ROOT)
    if not data:
        sys.exit("Not set up yet. Run setup.bat first.")
    _logging()
    with single_instance(ROOT):
        worker = Worker(ROOT, data, Journal(ROOT / "state" / "agent.db"), Client(data), _printer())
        logging.getLogger("print-agent").info("FLO Print Agent started for: %s", ", ".join(data["printers"]))
        worker.run()


def test_page():
    data = profile_store.load(ROOT)
    if not data:
        sys.exit("Not set up yet. Run setup.bat first.")
    printer = _printer()
    name = data["printers"][0]
    page = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(page)
    draw.rectangle((60, 60, 1180, 1694), outline="black", width=4)
    draw.text((120, 140), "FLO Print Desk - test page", fill="black")
    draw.text((120, 200), f"Printer: {name}", fill="black")
    for i, color in enumerate(["black", "red", "green", "blue"]):
        draw.rectangle((120 + i * 250, 300, 340 + i * 250, 460), fill=color)
    out = ROOT / "temp" / "testpage.png"
    out.parent.mkdir(exist_ok=True)
    page.save(out)
    print(f"Sending a test page to '{name}'...")
    print(printer.submit(name, [out], Settings(1, "color", "portrait"), "FLO test page", lambda _id: None, 120))


def printers():
    for name in _printer().names():
        print(name)


def status():
    journal = Journal(ROOT / "state" / "agent.db")
    for row in journal.db.execute("SELECT id,state,reported FROM jobs ORDER BY rowid DESC LIMIT 20"):
        print(row["id"][:8].upper(), row["state"], "reported" if row["reported"] else "not reported yet")


COMMANDS = {"setup": setup, "run": run, "test-page": test_page, "printers": printers, "status": status}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1 or argv[0] not in COMMANDS:
        sys.exit("Usage: python main.py [" + "|".join(COMMANDS) + "]")
    COMMANDS[argv[0]]()
