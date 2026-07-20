#!/usr/bin/env python3
"""Regenerate Tauri icon set from the padded master icon.

Windows taskbar / tray need sharp small frames. This script:
  - keeps Apple-padded master for large assets / macOS
  - builds tighter small frames for Windows ICO + tray
  - embeds classic BMP frames for 16..48 and PNG for larger sizes
  - writes a valid multi-image ICO that Windows shell can pick by size
"""

from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "icons.png"
OUT_DIR = ROOT / "src-tauri" / "icons"


def _png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _content_square(image: Image.Image, content_ratio: float = 0.94) -> Image.Image:
    rgba = image.convert("RGBA")
    bbox = rgba.getbbox()
    if not bbox:
        return rgba
    content = rgba.crop(bbox)
    width, height = content.size
    side = max(width, height)
    canvas_side = max(1, int(round(side / max(0.5, min(content_ratio, 0.98)))))
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    offset = ((canvas_side - width) // 2, (canvas_side - height) // 2)
    canvas.paste(content, offset, content)
    return canvas


def _resize_crisp(image: Image.Image, size: int) -> Image.Image:
    # Super-sample then downscale for tiny sizes — sharper than single-step LANCZOS.
    if size <= 48:
        big = image.resize((size * 4, size * 4), Image.Resampling.LANCZOS)
        resized = big.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
        resized = resized.filter(ImageFilter.UnsharpMask(radius=0.55, percent=160, threshold=1))
        return resized
    return image.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")


def _bmp_ico_entry(image: Image.Image) -> bytes:
    """Classic 32-bpp XOR+AND ICO image (bottom-up BGRA)."""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    header = struct.pack(
        "<IIIHHIIIIII",
        40,
        width,
        height * 2,
        1,
        32,
        0,
        width * height * 4,
        0,
        0,
        0,
        0,
    )
    pixels = bytearray()
    for y in range(height - 1, -1, -1):
        for x in range(width):
            r, g, b, a = rgba.getpixel((x, y))
            pixels.extend((b, g, r, a))
    # AND mask: fully opaque (alpha already present)
    row_bytes = ((width + 31) // 32) * 4
    and_mask = bytes(row_bytes * height)
    return header + bytes(pixels) + and_mask


def write_multi_size_ico(path: Path, images: list[Image.Image]) -> None:
    entries: list[tuple[int, int, bytes]] = []
    for image in images:
        rgba = image.convert("RGBA")
        width, height = rgba.size
        if width > 256 or height > 256:
            raise ValueError(f"ICO entry too large: {width}x{height}")
        # Use classic BMP for every size Windows taskbar commonly requests.
        # PNG-in-ICO is fine for 256 but some shell paths only pick the first
        # PNG and then downscale, which looks soft.
        if width <= 64:
            data = _bmp_ico_entry(rgba)
        else:
            data = _png_bytes(rgba)
        entries.append((width, height, data))

    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory = bytearray()
    blobs = bytearray()
    for width, height, data in entries:
        directory.extend(
            struct.pack(
                "<BBBBHHII",
                0 if width == 256 else width,
                0 if height == 256 else height,
                0,
                0,
                1,
                32,
                len(data),
                offset,
            )
        )
        blobs.extend(data)
        offset += len(data)
    path.write_bytes(header + directory + blobs)


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing source icon: {SRC}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = Image.open(SRC).convert("RGBA")
    tight = _content_square(master, content_ratio=0.94)
    print(f"source {master.size} tight {tight.size}")

    assets = {
        "32x32.png": (32, tight),
        "64x64.png": (64, tight),
        "128x128.png": (128, master),
        "henry.w@example.net": (256, master),
        "icon.png": (512, master),
        "512x512.png": (512, master),
        "icon-1024.png": (1024, master),
        "128x128@2x.png": (256, master),
        "tray-icon.png": (64, tight),
        "tray-icon-32.png": (32, tight),
    }
    for name, (size, source) in assets.items():
        img = _resize_crisp(source, size)
        path = OUT_DIR / name
        img.save(path, format="PNG", optimize=True)
        print(f"wrote {path.name} {size}")

    logo = _resize_crisp(master, 512)
    logo_path = ROOT / "public" / "logo.png"
    logo.save(logo_path, format="PNG", optimize=True)
    print(f"wrote {logo_path.name}")

    # ICNS for macOS (padded master)
    icns_types = [
        ("icp4", 16),
        ("icp5", 32),
        ("icp6", 64),
        ("ic07", 128),
        ("ic08", 256),
        ("ic09", 512),
        ("ic10", 1024),
        ("ic11", 32),
        ("ic12", 64),
        ("ic13", 256),
        ("ic14", 512),
    ]
    entries: list[tuple[bytes, bytes]] = []
    for type_code, size in icns_types:
        entries.append((type_code.encode("ascii"), _png_bytes(_resize_crisp(master, size))))
    total = 8 + sum(8 + len(data) for _, data in entries)
    icns_path = OUT_DIR / "icon.icns"
    with open(icns_path, "wb") as handle:
        handle.write(b"icns")
        handle.write(struct.pack(">I", total))
        for type_code, data in entries:
            handle.write(type_code)
            handle.write(struct.pack(">I", 8 + len(data)))
            handle.write(data)
    print(f"wrote {icns_path.name} bytes={total}")

    # Windows ICO — include every size the shell asks for.
    # IMPORTANT: Tauri's default_window_icon reads ONLY entries[0] from the ICO.
    # Putting 16px first makes the taskbar upscale a tiny bitmap and look soft.
    # Put 32px first (common taskbar size @100% DPI), then other sizes, then 256.
    ico_plan = [
        (32, tight),
        (16, tight),
        (20, tight),
        (24, tight),
        (40, tight),
        (48, tight),
        (64, tight),
        (256, master),
    ]
    ico_images = [_resize_crisp(source, size) for size, source in ico_plan]
    ico_path = OUT_DIR / "icon.ico"
    write_multi_size_ico(ico_path, ico_images)
    print(f"wrote {ico_path.name} sizes={[s for s, _ in ico_plan]}")

    # Also write a pure 32x32 ICO fallback some shells prefer.
    write_multi_size_ico(OUT_DIR / "icon-32.ico", [_resize_crisp(tight, 32)])
    print("wrote icon-32.ico")


if __name__ == "__main__":
    main()
