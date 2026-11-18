import json
import subprocess
import sys
import warnings
from pathlib import Path
from PIL import Image
from print_agent.models import ValidationError


def pages(value, count):
    if value == "all":
        return list(range(count))
    try:
        numbers = [int(n) - 1 for n in value.split(",")]
    except Exception:
        raise ValidationError("Invalid requested page list") from None
    if not numbers or len(set(numbers)) != len(numbers) or any(n < 0 for n in numbers):
        raise ValidationError("Invalid requested page list")
    beyond = [n + 1 for n in numbers if n >= count]
    if beyond:
        raise ValidationError(
            f"Page {beyond[0]} does not exist: the document has {count} page{'s' if count != 1 else ''}"
        )
    return numbers


def inspect(path, config, selection):
    if path.suffix.lower() not in (".pdf", ".jpg", ".jpeg"):
        raise ValidationError(
            "Not Supported: Only PDF and JPG/JPEG files are supported."
        )
    if not 0 < path.stat().st_size <= config["max_file_mb"] * 1048576:
        raise ValidationError("File size exceeds configured limit")
    try:
        if path.suffix.lower() == ".pdf":
            with path.open("rb") as f:
                if f.read(5) != b"%PDF-":
                    raise ValidationError("Invalid PDF signature")
            import fitz  # imported lazily so JPEG-only environments (and tests) do not need PyMuPDF

            with fitz.open(path) as doc:
                if doc.needs_pass:
                    raise ValidationError("Encrypted PDF is unsupported")
                count = len(doc)
                if not 1 <= count <= config["max_pages"]:
                    raise ValidationError("Invalid PDF page count")
        else:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(path) as image:
                    if image.format != "JPEG" or image.width * image.height > 8_000_000:
                        raise ValidationError("Invalid or excessive JPEG")
                    image.verify()
                with Image.open(path) as image:
                    image.load()
            count = 1
        return pages(selection, count), count
    except ValidationError:
        raise
    except Exception:
        raise ValidationError("Corrupt or unsafe document") from None


def render(path, directory, selected, color):
    directory.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "print_agent.render_worker",
                str(path),
                str(directory),
                json.dumps({"selected": selected, "color": color}),
            ],
            cwd=str(Path(__file__).resolve().parents[1]),
            timeout=60,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except subprocess.TimeoutExpired:
        raise ValidationError("Rendering exceeded timeout") from None
    output = sorted(directory.glob("*.png"))
    if result.returncode or not output:
        raise ValidationError("Rendering failed")
    return output
