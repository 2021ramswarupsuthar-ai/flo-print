"""Stores the agent's settings (portal URL, connection key, printers). Encrypted with Windows DPAPI on Windows."""

import json
import os


def _path(root):
    return root / "state" / "profile.bin"


def save(root, data):
    (root / "state").mkdir(exist_ok=True)
    raw = json.dumps(data).encode()
    if os.name == "nt":
        import win32crypt

        blob = win32crypt.CryptProtectData(raw, "flo-print-agent", None, None, None, 0)
    else:  # development machines only
        blob = raw
    path = _path(root)
    path.write_bytes(blob)
    if os.name != "nt":
        os.chmod(path, 0o600)


def load(root):
    path = _path(root)
    if not path.exists():
        return None
    blob = path.read_bytes()
    if os.name == "nt":
        import win32crypt

        blob = win32crypt.CryptUnprotectData(blob, None, None, None, 0)[1]
    return json.loads(blob)
