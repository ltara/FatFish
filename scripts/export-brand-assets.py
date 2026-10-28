"""Export the user-approved artwork without model redrawing.

Requires Pillow for deterministic crop, edge alpha recovery, resize and ICO export.
This is an offline development tool; it never starts the application.
"""
from collections import deque
from hashlib import sha256
from pathlib import Path
import json

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/brand/logo-approved-20261028.png"
DEST = ROOT / "app/electron-ui/assets"
EXPECTED = "465633a4d2952b772added6fa48e64fbca715fb13f61ccaac6344ba6107e7636"
STATUS = {"ok": (47, 158, 100), "warn": (201, 162, 39), "bad": (196, 86, 74), "info": (90, 143, 168)}
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def largest_dark_component(image):
    width, height = image.size
    pixels = image.load()
    pending = {(x, y) for y in range(height) for x in range(width) if max(pixels[x, y][:3]) < 110}
    largest = []
    while pending:
        start = pending.pop()
        component, queue = [start], deque([start])
        while queue:
            x, y = queue.popleft()
            for p in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if p in pending:
                    pending.remove(p)
                    component.append(p)
                    queue.append(p)
        if len(component) > len(largest):
            largest = component
    if len(largest) < 80000:
        raise ValueError("approved dark icon was not found")
    xs, ys = zip(*largest)
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def remove_connected_board_background(image):
    """Remove only the outside board, recovering white-matted edge pixels.

    The opaque dark tile protects the approved cream fish from the flood fill.
    Colour recovery is restricted to a two-pixel external boundary, not the art.
    """
    image = image.convert("RGBA")
    width, height = image.size
    pixels = image.load()
    outside, queue = set(), deque()

    def background(p):
        rgb = pixels[p][:3]
        return min(rgb) >= 238 and max(rgb) - min(rgb) <= 18

    for x in range(width):
        queue.extend(((x, 0), (x, height - 1)))
    for y in range(height):
        queue.extend(((0, y), (width - 1, y)))
    while queue:
        x, y = queue.popleft()
        if not (0 <= x < width and 0 <= y < height) or (x, y) in outside or not background((x, y)):
            continue
        outside.add((x, y))
        queue.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    if not outside or len(outside) > width * height // 3:
        raise ValueError("unexpected icon background coverage")
    boundary = set()
    for x, y in outside:
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                p = x + dx, y + dy
                if 0 <= p[0] < width and 0 <= p[1] < height and p not in outside:
                    boundary.add(p)
    changes = 0
    original = image.copy().load()
    for x, y in boundary:
        sample = [original[nx, ny][:3]
                  for ny in range(max(0, y - 3), min(height, y + 4))
                  for nx in range(max(0, x - 3), min(width, x + 4))
                  if max(original[nx, ny][:3]) < 85]
        if not sample:
            continue
        foreground = tuple(sum(p[c] for p in sample) / len(sample) for c in range(3))
        current = original[x, y][:3]
        denominator = sum((255 - c) ** 2 for c in foreground)
        alpha = max(0, min(1, sum((255 - current[c]) * (255 - foreground[c]) for c in range(3)) / denominator))
        if alpha >= .98:
            continue
        recovered = tuple(max(0, min(255, round((current[c] - (1 - alpha) * 255) / max(alpha, .001)))) for c in range(3))
        pixels[x, y] = recovered + (round(alpha * 255),)
        changes += 1
    for p in outside:
        pixels[p] = (0, 0, 0, 0)
    return image, {"outsidePixelsRemoved": len(outside), "boundaryPixelsUnmatted": changes}


def main():
    source_hash = sha256(SOURCE.read_bytes()).hexdigest()
    if source_hash != EXPECTED:
        raise ValueError("approved artwork hash changed; obtain a new explicit approval")
    image = Image.open(SOURCE).convert("RGBA")
    if image.size != (1536, 1024):
        raise ValueError("unexpected approved board dimensions")
    roi = (530, 220, 1010, 710)
    bounds = largest_dark_component(image.crop(roi))
    crop_box = (roi[0] + bounds[0] - 2, roi[1] + bounds[1] - 2,
                roi[0] + bounds[2] + 2, roi[1] + bounds[3] + 2)
    crop, alpha_record = remove_connected_board_background(image.crop(crop_box))
    side = max(crop.size)
    native = Image.new("RGBA", (side, side))
    native.alpha_composite(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
    DEST.mkdir(parents=True, exist_ok=True)
    outputs = []

    def save_png(name, art):
        target = DEST / name
        art.save(target, optimize=True)
        outputs.append({"file": name, "width": art.width, "height": art.height,
                        "sha256": sha256(target.read_bytes()).hexdigest()})

    icon = native.resize((512, 512), Image.Resampling.LANCZOS)
    save_png("icon.png", icon)
    ico = DEST / "icon.ico"
    icon.save(ico, format="ICO", sizes=[(size, size) for size in ICO_SIZES])
    outputs.append({"file": "icon.ico", "sizes": list(ICO_SIZES), "sha256": sha256(ico.read_bytes()).hexdigest()})

    for size, suffix in ((16, ""), (32, "@2x")):
        save_png("tray" + suffix + ".png", native.resize((size, size), Image.Resampling.LANCZOS))
        for kind, colour in STATUS.items():
            scale = 4
            art = native.resize((size * scale, size * scale), Image.Resampling.LANCZOS)
            draw = ImageDraw.Draw(art)
            center, radius = size * scale * .82, size * scale * .16
            draw.ellipse((center - radius, center - radius, center + radius, center + radius),
                         fill=colour + (255,), outline=(32, 38, 37, 255), width=max(1, round(size * scale / 24)))
            save_png("tray-" + kind + suffix + ".png", art.resize((size, size), Image.Resampling.LANCZOS))

    manifest = {"approvalDate": "2026-10-28", "source": SOURCE.relative_to(ROOT).as_posix(),
                "sourceSha256": source_hash, "sourceSize": list(image.size), "cropBox": list(crop_box),
                "nativePaddedSize": side, "method": "approved crop, external-edge alpha recovery and proportional resize; no redrawing",
                "alphaRecovery": alpha_record, "trayStatusPalette": {k: list(v) for k, v in STATUS.items()},
                "outputs": outputs}
    (DEST / "brand-assets.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    assert icon.getpixel((0, 0))[3] == 0 and icon.getpixel((256, 256))[3] == 255
    assert Image.open(ico).ico.sizes() == {(size, size) for size in ICO_SIZES}
    print(json.dumps({"cropBox": crop_box, "nativeSize": side, "outputs": len(outputs), "sourceSha256": source_hash}))


if __name__ == "__main__":
    main()
