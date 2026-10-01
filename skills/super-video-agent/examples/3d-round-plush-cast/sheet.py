"""Contact sheet of preview stills, labelled with each file's name.

Run: python3 sheet.py <out.png> <cols> <tile_px> <bg hex> <png> [<png> ...]
Transparent images (face decals) are laid over the bg colour so they read as on fur.
"""
import os
import sys

from PIL import Image, ImageDraw

out, cols, tile, bg = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
files = sys.argv[5:]
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * tile, rows * tile), "#" + bg)
draw = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(f).convert("RGBA")
    im.thumbnail((tile, tile))
    under = Image.new("RGBA", im.size, "#" + bg)
    im = Image.alpha_composite(under, im)
    x, y = (i % cols) * tile, (i // cols) * tile
    sheet.paste(im.convert("RGB"), (x + (tile - im.width) // 2, y + (tile - im.height) // 2))
    draw.text((x + 5, y + 4), os.path.splitext(os.path.basename(f))[0], fill="black")
sheet.save(out)
print("wrote", out, sheet.size)
