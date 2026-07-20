#!/usr/bin/env python3
"""Regenerate Tauri icon set from the padded macOS master icon."""

from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "icons.png"
OUT_DIR = ROOT / "src-tauri" / "icons"


def _png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_multi_size_ico(path: Path, images: list[Image.Image]) -> None:
    """Write a multi-size ICO with embedded PNG images (Vista+ compatible)."""
    entries: list[tuple[int, int, bytes]] = []
    for image in images:
        rgba = image.convert("RGBA")
        width, height = rgba.size
        if width > 256 or height > 256:
            raise ValueError(f"ICO entry too large: {width}x{height}")
        entries.append((width, height, _png_bytes(rgba)))

    # ICONDIR + ICONDIRENTRY*n + image data
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
                0,  # color palette
                0,  # reserved
                1,  # color planes
                32,  # bits per pixel
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
    img = Image.open(SRC).convert("RGBA")
    print(f"source {img.size}")

    sizes = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "henry.w@example.net": 256,
        "icon.png": 512,
        "512x512.png": 512,
        "icon-1024.png": 1024,
        "128x128@2x.png": 256,
    }

    for name, size in sizes.items():
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        path = OUT_DIR / name
        resized.save(path, format="PNG", optimize=True)
        print(f"wrote {path} {size}")

    # Keep UI logo consistent with the padded master.
    logo = img.resize((512, 512), Image.Resampling.LANCZOS)
    logo_path = ROOT / "public" / "logo.png"
    logo.save(logo_path, format="PNG", optimize=True)
    print(f"wrote {logo_path}")

    # Build ICNS with PNG-compressed icon types used by modern macOS.
    icns_types = [
        ("icp4", 16),
        ("icp5", 32),
        ("icp6", 64),
        ("ic07", 128),
        ("ic08", 256),
        ("ic09", 512),
        ("ic10", 1024),
        ("ic11", 32),  # 16@2x
        ("ic12", 64),  # 32@2x
        ("ic13", 256),  # 128@2x
        ("ic14", 512),  # 256@2x
    ]

    entries: list[tuple[bytes, bytes]] = []
    for type_code, size in icns_types:
        buf = io.BytesIO()
        img.resize((size, size), Image.Resampling.LANCZOS).save(
            buf, format="PNG", optimize=True
        )
        entries.append((type_code.encode("ascii"), buf.getvalue()))

    total = 8 + sum(8 + len(data) for _, data in entries)
    icns_path = OUT_DIR / "icon.icns"
    with open(icns_path, "wb") as handle:
        handle.write(b"icns")
        handle.write(struct.pack(">I", total))
        for type_code, data in entries:
            handle.write(type_code)
            handle.write(struct.pack(">I", 8 + len(data)))
            handle.write(data)
    print(f"wrote {icns_path} bytes={total}")

    # Pillow's multi-size ICO writer is picky; build a classic multi-image ICO
    # manually so Windows packaging gets real 16..256 assets.
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_images = [
        img.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
        for size in ico_sizes
    ]
    ico_path = OUT_DIR / "icon.ico"
    write_multi_size_ico(ico_path, ico_images)
    print(f"wrote {ico_path} sizes={ico_sizes}")

    bbox = img.getbbox()
    print(f"source bbox {bbox}")
    if bbox:
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        print(
            f"content ratio: {width / img.width:.3f} x {height / img.height:.3f} "
            "(Apple-ish target ~0.80)"
        )


if __name__ == "__main__":
    main()
