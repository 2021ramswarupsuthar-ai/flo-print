import json, sys
from pathlib import Path
import os
from PIL import Image, ImageOps


def main():
    source, dest, spec = Path(sys.argv[1]), Path(sys.argv[2]), json.loads(sys.argv[3])
    if source.suffix.lower() == ".pdf":
        import fitz

        with fitz.open(source) as doc:
            for index, number in enumerate(spec["selected"]):
                page = doc[number]
                scale = int(os.environ.get("FLO_PRINT_DPI", "200")) / 72
                if (page.rect.width * scale + 1) * (
                    page.rect.height * scale + 1
                ) > 20_000_000:
                    raise ValueError("Pixel limit")
                pix = page.get_pixmap(
                    matrix=fitz.Matrix(scale, scale),
                    colorspace=fitz.csGRAY if spec["color"] == "bw" else fitz.csRGB,
                    alpha=False,
                )
                pix.save(dest / f"{index:05}.png")
    else:
        with Image.open(source) as im:
            image = ImageOps.exif_transpose(im).convert(
                "L" if spec["color"] == "bw" else "RGB"
            )
            image.save(dest / "00000.png")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(2)
