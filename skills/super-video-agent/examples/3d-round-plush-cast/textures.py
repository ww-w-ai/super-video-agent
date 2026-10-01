"""Textures for the cast: painted faces, outfit decals, pancake surfaces, prop patterns.

Run: python3 textures.py <out_dir>   (make_cast.py calls it first)

UV frames must match make_cast.py:
- biped face:  u = (x + 0.56) / 1.12, v = (z - 0.72) / 1.0         (head centre z 1.22)
- puppy face:  u = (x + 0.25) / 0.50, v = (z - 0.20) / 0.44
- outfit:      u = (x + 0.42) / 0.84, v = (z - 0.08) / 0.84        (body front)
- pancake:     u = angle / 2pi, v = profile position (bottom centre 0 -> top centre 1),
               regions: bottom 0-.28, lower edge .28-.36, side .36-.64, upper edge .64-.72, top .72-1
"""
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
S = 1024
SS = 4  # supersample, then downscale: smooth edges

DARK = (52, 38, 33, 255)
WHITE = (255, 255, 255, 255)
BLUSH = (246, 148, 160, 255)
MOUTH_IN = (171, 74, 78, 255)
TONGUE = (240, 136, 142, 255)


class Frame:
    """Maps model units (x, z) on a front-projected decal to supersampled pixels."""

    def __init__(self, half_w, z0, h):
        self.half_w, self.z0, self.h = half_w, z0, h

    def px(self, x, z):
        return (x + self.half_w) / (2 * self.half_w) * S * SS, (1 - (z - self.z0) / self.h) * S * SS

    def size(self, w, h):
        return w / (2 * self.half_w) * S * SS, h / self.h * S * SS

    def ellipse(self, d, cx, cz, rx, rz, fill):
        x, y = self.px(cx, cz)
        w, h = self.size(rx, rz)
        d.ellipse([x - w, y - h, x + w, y + h], fill=fill)

    def line(self, d, pts, width, fill=DARK):
        d.line([self.px(x, z) for x, z in pts], fill=fill, width=int(width * SS), joint="curve")
        for x, z in (pts[0], pts[-1]):  # round caps
            cx, cy = self.px(x, z)
            r = width * SS / 2
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)

    def arc(self, d, cx, cz, rx, rz, start, end, width, fill=DARK, n=24):
        pts = [(cx + rx * math.cos(math.radians(a)), cz - rz * math.sin(math.radians(a)))
               for a in (start + (end - start) * i / n for i in range(n + 1))]
        self.line(d, pts, width, fill)


def canvas():
    return Image.new("RGBA", (S * SS, S * SS), (0, 0, 0, 0))


def save(img, name):
    img = img.resize((S, S), Image.LANCZOS)
    path = os.path.join(OUT, name)
    img.save(path)
    print("wrote", path)


# ---- faces ------------------------------------------------------------------------------
# One spec per character. Eyes are painted; muzzle and nose are 3D in make_cast.py.
FACE_SPECS = {
    "bear": dict(frame=Frame(0.56, 0.72, 1.0), eye_x=0.19, eye_z=1.27, eye_r=(0.062, 0.082), lashes=True,
                 mouth=(0.0, 1.03, 0.05, 0.04), blush=(0.30, 1.12, 0.078, 0.046), whiskers=False, stripes=False,
                 faces=["smile", "talk", "happy", "wink", "blink", "sleep"]),
    "cat": dict(frame=Frame(0.56, 0.72, 1.0), eye_x=0.2, eye_z=1.25, eye_r=(0.066, 0.086), lashes=True,
                mouth=(0.0, 0.992, 0.042, 0.034), blush=(0.31, 1.1, 0.074, 0.044), whiskers=True, stripes=True,
                faces=["smile", "talk", "happy", "blink"]),
    "rabbit": dict(frame=Frame(0.56, 0.72, 1.0), eye_x=0.19, eye_z=1.25, eye_r=(0.064, 0.084), lashes=True,
                   mouth=(0.0, 0.99, 0.036, 0.03), blush=(0.3, 1.1, 0.08, 0.048), whiskers=False, stripes=False,
                   faces=["smile", "talk", "happy", "blink"]),
    "puppy": dict(frame=Frame(0.25, 0.20, 0.44), eye_x=0.095, eye_z=0.462, eye_r=(0.036, 0.046), lashes=False,
                  mouth=(0.0, 0.29, 0.026, 0.022), blush=(0.165, 0.39, 0.045, 0.028), whiskers=False, stripes=False,
                  faces=["smile", "happy", "blink"]),
}


def open_eye(fr, d, cx, cz, rx, rz, lashes, side):
    """Eye (dark oval, two highlights on the same side for both eyes) plus lashes."""
    fr.ellipse(d, cx, cz, rx, rz, DARK)
    fr.ellipse(d, cx - 0.29 * rx, cz + 0.37 * rz, 0.355 * rx, 0.29 * rz, WHITE)
    fr.ellipse(d, cx + 0.32 * rx, cz - 0.37 * rz, 0.145 * rx, 0.122 * rz, WHITE)
    if lashes:  # two short strokes at the outer top, curling outward
        for ang, ln in ((24, 0.62), (50, 0.5)):
            a = math.radians(ang)
            x0 = cx + side * rx * math.cos(a) * 0.92
            z0 = cz + rz * math.sin(a) * 0.92
            x1 = x0 + side * ln * rx * math.cos(a + 0.35)
            z1 = z0 + ln * rx * math.sin(a + 0.35)
            fr.line(d, [(x0, z0), (x1, z1)], 7)


def closed_eye(fr, d, cx, cz, rx, rz, lashes, side, happy):
    """happy: ^ arc. Otherwise a relaxed resting curve (blink / sleep).

    Frame.arc uses PIL's image-space angles: 270 is up, so 200-340 draws ^ and 20-160 draws a U.
    """
    k = rx / 0.062
    if happy:
        rxa, rza, cza = 0.07 * k, 0.05 * k, cz - 0.03 * k
        fr.arc(d, cx, cza, rxa, rza, 200, 340, 13)
        a = math.radians(340 if side > 0 else 200)
    else:
        rxa, rza, cza = 0.068 * k, 0.034 * k, cz + 0.012 * k
        fr.arc(d, cx, cza, rxa, rza, 20, 160, 11)
        a = math.radians(20 if side > 0 else 160)
    if lashes:
        x0, z0 = cx + rxa * math.cos(a), cza - rza * math.sin(a)
        fr.line(d, [(x0, z0), (x0 + side * 0.032 * k, z0 + (0.004 if happy else 0.012) * k)], 7)


def mouth(fr, d, spec, kind):
    mx, mz, w, h = spec["mouth"]
    if kind == "smile":  # the plush-toy "w" (two U arcs)
        fr.arc(d, mx - w / 2, mz + h * 0.3, w / 2, h * 0.7, 0, 180, 9)
        fr.arc(d, mx + w / 2, mz + h * 0.3, w / 2, h * 0.7, 0, 180, 9)
    elif kind in ("talk", "happy"):
        x, y = fr.px(mx, mz)
        ww, hh = fr.size(w * (1.0 if kind == "talk" else 1.25), h * (1.3 if kind == "talk" else 1.5))
        box = [x - ww, y - hh * 0.5, x + ww, y + hh * 1.1]
        d.chord(box, start=0, end=180, fill=MOUTH_IN)
        tb = [x - ww * 0.6, y + hh * 0.3, x + ww * 0.6, y + hh * 1.1]
        d.chord(tb, start=0, end=180, fill=TONGUE)
        d.arc(box, start=0, end=180, fill=DARK, width=int(5 * SS))
        d.line([(x - ww, y + hh * 0.3), (x + ww, y + hh * 0.3)], fill=DARK, width=int(5 * SS))
    elif kind == "sleep":
        fr.ellipse(d, mx, mz - h * 0.2, w * 0.28, h * 0.32, MOUTH_IN)


def blush(img, fr, spec, strength=1.0):
    b = canvas()
    bd = ImageDraw.Draw(b)
    bx, bz, rx, rz = spec["blush"]
    col = (BLUSH[0], BLUSH[1], BLUSH[2], int(200 * strength))
    for s in (1, -1):
        fr.ellipse(bd, bx * s, bz, rx, rz, col)
    b = b.filter(ImageFilter.GaussianBlur(9 * SS))
    return Image.alpha_composite(img, b)


def whiskers(fr, d, spec):
    for s in (1, -1):
        for k, dz in enumerate((0.03, 0.0, -0.03)):
            x0, z0 = 0.31 * s, 1.035 + dz * 0.6
            fr.line(d, [(x0, z0), (x0 + 0.09 * s, z0 + dz)], 4.5, (120, 96, 84, 255))


def tabby(fr, d):
    col = (214, 170, 118, 255)
    for x, top, bot in ((-0.075, 1.63, 1.53), (0.0, 1.66, 1.52), (0.075, 1.63, 1.53)):
        fr.line(d, [(x, top), (x * 0.8, bot)], 20, col)
    for s in (1, -1):
        for k, z in enumerate((1.2, 1.15)):
            fr.line(d, [(0.52 * s, z), (0.43 * s, z - 0.01)], 14, col)


def face(char, kind):
    spec = FACE_SPECS[char]
    fr = spec["frame"]
    img = canvas()
    img = blush(img, fr, spec, 1.15 if kind == "happy" else 1.0)
    d = ImageDraw.Draw(img)
    if spec["stripes"]:
        tabby(fr, d)
    if spec["whiskers"]:
        whiskers(fr, d, spec)
    rx, rz = spec["eye_r"]
    for side in (1, -1):
        cx, cz = spec["eye_x"] * side, spec["eye_z"]
        if kind in ("smile", "talk") or (kind == "wink" and side == -1):
            open_eye(fr, d, cx, cz, rx, rz, spec["lashes"], side)
        else:
            closed_eye(fr, d, cx, cz, rx, rz, spec["lashes"], side, happy=kind in ("happy", "wink"))
    mouth(fr, d, spec, {"smile": "smile", "wink": "smile", "blink": "smile", "talk": "talk",
                        "happy": "happy", "sleep": "sleep"}[kind])
    save(img, f"face-{char}-{kind}.png")


# ---- outfit decals (body front) -----------------------------------------------------------
OUTFIT = Frame(0.42, 0.08, 0.84)


def apron_bear():
    """Apron: green bib, straps, rounded hem, pocket with a stitch."""
    green, dark, stitch = (94, 143, 110, 255), (74, 118, 90, 255), (214, 232, 214, 255)
    img = canvas()
    d = ImageDraw.Draw(img)
    fr = OUTFIT
    for s in (1, -1):
        d.line([fr.px(0.13 * s, 0.64), fr.px(0.19 * s, 0.86)], fill=green, width=int(0.05 / 0.84 * S * SS))
    body = [fr.px(-0.16, 0.66), fr.px(0.16, 0.66), fr.px(0.25, 0.30), fr.px(0.25, 0.26), fr.px(-0.25, 0.26),
            fr.px(-0.25, 0.30)]
    d.polygon(body, fill=green)
    x0, y0 = fr.px(-0.25, 0.36)
    x1, y1 = fr.px(0.25, 0.16)
    d.ellipse([x0, y0, x1, y1], fill=green)
    px0, py0 = fr.px(-0.11, 0.46)
    px1, py1 = fr.px(0.11, 0.32)
    d.rounded_rectangle([px0, py0, px1, py1], radius=int(0.03 / 0.84 * S * SS), fill=dark)
    d.line([fr.px(-0.09, 0.44), fr.px(0.09, 0.44)], fill=stitch, width=3 * SS)
    save(img, "outfit-bear.png")


def cardigan_cat():
    """Lavender cardigan (the body colour) open over a white shirt: V panel, buttons, ribbed hem."""
    shirt, button, rib = (253, 251, 247, 255), (250, 240, 214, 255), (171, 150, 205, 255)
    img = canvas()
    d = ImageDraw.Draw(img)
    fr = OUTFIT
    d.polygon([fr.px(-0.15, 0.86), fr.px(0.15, 0.86), fr.px(0.035, 0.42), fr.px(-0.035, 0.42)], fill=shirt)
    for z in (0.53, 0.40, 0.27):
        fr.ellipse(d, 0.06, z, 0.022, 0.022, button)
        fr.ellipse(d, 0.06, z, 0.022, 0.022, button)
    d.line([fr.px(0.03, 0.43), fr.px(0.03, 0.17)], fill=rib, width=int(2.5 * SS))
    for x in [i * 0.035 - 0.42 for i in range(25)]:
        d.line([fr.px(x, 0.24), fr.px(x, 0.16)], fill=rib, width=int(3 * SS))
    save(img, "outfit-cat.png")


def top_rabbit():
    """Pastel-yellow top: a scalloped hem band and two tiny daisies on the chest."""
    band, petal, core = (246, 214, 118, 255), (255, 255, 255, 255), (246, 196, 92, 255)
    img = canvas()
    d = ImageDraw.Draw(img)
    fr = OUTFIT
    for i in range(14):
        x = -0.42 + i * 0.065
        fr.ellipse(d, x, 0.235, 0.036, 0.03, band)
    x0, y0 = fr.px(-0.42, 0.235)
    x1, y1 = fr.px(0.42, 0.14)
    d.rectangle([x0, y0, x1, y1], fill=band)
    for cx, cz in ((-0.13, 0.56), (0.15, 0.47)):
        for k in range(6):
            a = k * math.pi / 3
            fr.ellipse(d, cx + 0.028 * math.cos(a), cz + 0.028 * math.sin(a), 0.02, 0.02, petal)
        fr.ellipse(d, cx, cz, 0.016, 0.016, core)
    save(img, "outfit-rabbit.png")


# ---- pancake surfaces ------------------------------------------------------------------------
def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def smooth(a, b, x):
    u = min(1.0, max(0.0, (x - a) / (b - a)))
    return u * u * (3 - 2 * u)


def pancake_layer():
    """Rows = profile position v, columns = angle. Browned top and bottom, pale custard sides."""
    W, H = 512, 512
    rnd = random.Random(7)
    img = Image.new("RGB", (W, H))
    px = img.load()
    brown_dark, brown, gold = (186, 110, 44), (210, 142, 64), (238, 188, 112)
    cream, custard = (252, 236, 200), (248, 224, 172)
    blobs = [(rnd.random(), rnd.random(), rnd.uniform(0.01, 0.05), rnd.uniform(-1, 1)) for _ in range(260)]
    for y in range(H):
        v = 1 - y / (H - 1)
        # base colour along the profile: griddled faces and rims, a golden blush into the sides
        if v < 0.28 or v > 0.72:
            vv = v if v < 0.28 else 1 - v  # 0 at the centre of a face, .28 at its rim
            c = lerp(brown, brown_dark, smooth(0.1, 0.27, vv) * 0.6)
            c = lerp(c, gold, 0.3 * (1 - smooth(0.0, 0.18, vv)))
        elif v < 0.36 or v > 0.64:
            e = (v - 0.28) / 0.08 if v < 0.36 else (0.72 - v) / 0.08  # 0 at the face, 1 at the side
            c = lerp(brown_dark, gold, smooth(0.0, 0.7, e))
        else:
            e = min(v - 0.36, 0.64 - v) / 0.14  # 0 at a rim, 1 at mid-height
            c = lerp(gold, custard, smooth(0.0, 0.45, e))
            c = lerp(c, cream, smooth(0.35, 1.0, e))
        for x in range(W):
            px[x, y] = c
    # mottling on the browned faces and faint pores on the sides (kept subtle: appetising, not dirty)
    over = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(over)
    for bu, bv, r, sgn in blobs:
        v = bv
        if 0.36 < v < 0.64:
            continue
        col = (120, 64, 24, 36) if sgn > 0 else (246, 206, 140, 40)
        cx, cy = bu * W, (1 - v) * H
        od.ellipse([cx - r * W * 1.6, cy - r * H, cx + r * W * 1.6, cy + r * H], fill=col)
    for _ in range(900):
        x, v = rnd.random() * W, rnd.uniform(0.37, 0.63)
        od.ellipse([x - 1.2, (1 - v) * H - 2.2, x + 1.2, (1 - v) * H + 2.2], fill=(224, 196, 150, 60))
    over = over.filter(ImageFilter.GaussianBlur(2.2))
    img = Image.alpha_composite(img.convert("RGBA"), over)
    path = os.path.join(OUT, "pancake-layer.png")
    img.save(path)
    print("wrote", path)


def sugar():
    """Powdered sugar dusting, alpha-blended over the top dome (planar top-down UV)."""
    rnd = random.Random(11)
    img = Image.new("RGBA", (S * 2, S * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = S
    for _ in range(9000):
        r = (rnd.random() ** 0.6) * 0.98
        a = rnd.random() * math.tau
        x, y = c + math.cos(a) * r * c, c + math.sin(a) * r * c
        s = rnd.uniform(1.5, 5.0)
        alpha = int(rnd.uniform(150, 255) * (0.45 + 0.55 * r))  # denser toward the rim
        d.ellipse([x - s, y - s, x + s, y + s], fill=(255, 255, 255, alpha))
    haze = Image.new("RGBA", img.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(haze)
    for _ in range(90):
        r = rnd.uniform(0.55, 0.98)
        a = rnd.random() * math.tau
        x, y = c + math.cos(a) * r * c, c + math.sin(a) * r * c
        s = rnd.uniform(40, 110)
        hd.ellipse([x - s, y - s, x + s, y + s], fill=(255, 255, 255, 46))
    haze = haze.filter(ImageFilter.GaussianBlur(30))
    img = Image.alpha_composite(haze, img).resize((S, S), Image.LANCZOS)
    path = os.path.join(OUT, "sugar.png")
    img.save(path)
    print("wrote", path)


def strawberry():
    """Strawberry skin: red with pale seeds (u around, v bottom tip -> top)."""
    rnd = random.Random(3)
    W = 256
    img = Image.new("RGBA", (W, W), (214, 48, 62, 255))
    d = ImageDraw.Draw(img)
    for y in range(W):
        t = y / W
        d.line([(0, y), (W, y)], fill=lerp((238, 76, 80), (196, 34, 52), t) + (255,))
    for i in range(12):
        for j in range(10):
            x = (i + 0.5 * (j % 2)) / 12 * W + rnd.uniform(-3, 3)
            y = (j + 0.5) / 10 * W
            d.ellipse([x - 2.4, y - 3.2, x + 2.4, y + 3.2], fill=(250, 226, 150, 255))
    path = os.path.join(OUT, "strawberry.png")
    img.save(path)
    print("wrote", path)


# ---- prop patterns ---------------------------------------------------------------------------
def quilt():
    """Patchwork: 5 x 5 squares in the cast's pastels (plain, gingham, dots), cream stitching."""
    W = 1024
    n = 5
    q = W // n
    img = Image.new("RGBA", (W, W), (255, 246, 232, 255))
    d = ImageDraw.Draw(img)
    cols = [(244, 163, 168), (247, 215, 116), (159, 211, 240), (176, 214, 170), (255, 236, 214), (233, 169, 85)]
    rnd = random.Random(5)
    for i in range(n):
        for j in range(n):
            c = cols[(i * 2 + j * 3) % len(cols)]
            x0, y0 = i * q, j * q
            d.rectangle([x0, y0, x0 + q, y0 + q], fill=c + (255,))
            pat = (i + j) % 3
            light = tuple(min(255, v + 34) for v in c) + (255,)
            if pat == 1:
                for k in range(0, q, q // 6):
                    d.rectangle([x0 + k, y0, x0 + k + q // 12, y0 + q], fill=light)
                    d.rectangle([x0, y0 + k, x0 + q, y0 + k + q // 12], fill=light)
            elif pat == 2:
                for a in range(5):
                    for b in range(5):
                        cx, cy = x0 + (a + 0.5) * q / 5, y0 + (b + 0.5) * q / 5
                        d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=(255, 250, 240, 255))
            for k in range(0, q, 16):  # running stitch along the seams
                d.line([(x0 + k, y0 + 6), (x0 + k + 8, y0 + 6)], fill=(255, 250, 240, 255), width=3)
                d.line([(x0 + 6, y0 + k), (x0 + 6, y0 + k + 8)], fill=(255, 250, 240, 255), width=3)
    path = os.path.join(OUT, "quilt.png")
    img.save(path)
    print("wrote", path)


def clock_face():
    """Round wall/alarm clock face: 12 tick dots, 4 bars, no digits."""
    W = 512
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = W / 2
    d.ellipse([4, 4, W - 4, W - 4], fill=(255, 250, 238, 255))
    for k in range(12):
        a = k * math.pi / 6
        r = W * 0.39
        x, y = c + math.sin(a) * r, c - math.cos(a) * r
        if k % 3 == 0:
            dx, dy = math.sin(a) * 18, -math.cos(a) * 18
            d.line([(x - dx, y - dy), (x + dx, y + dy)], fill=(94, 143, 110, 255), width=14)
        else:
            d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=(201, 139, 91, 255))
    path = os.path.join(OUT, "clock-face.png")
    img.save(path)
    print("wrote", path)


def sign_icon():
    """Hanging shop sign: a bear face beside a three-layer pancake stack. Pictogram only, no letters."""
    W = 1024
    img = Image.new("RGBA", (W, W), (255, 246, 232, 255))
    d = ImageDraw.Draw(img)
    brown, dark, cream, green = (201, 139, 91, 255), (60, 44, 38, 255), (243, 217, 184, 255), (94, 143, 110, 255)
    d.ellipse([20, 20, W - 20, W - 20], outline=green, width=34)
    # bear face
    bx, by = 380, 470
    for s in (-1, 1):
        d.ellipse([bx + s * 150 - 70, by - 230, bx + s * 150 + 70, by - 90], fill=brown)
        d.ellipse([bx + s * 150 - 36, by - 196, bx + s * 150 + 36, by - 124], fill=(244, 163, 168, 255))
    d.ellipse([bx - 210, by - 190, bx + 210, by + 200], fill=brown)
    d.ellipse([bx - 95, by + 10, bx + 95, by + 150], fill=cream)
    d.ellipse([bx - 36, by + 36, bx + 36, by + 84], fill=dark)
    for s in (-1, 1):
        d.ellipse([bx + s * 95 - 26, by - 70, bx + s * 95 + 26, by - 8], fill=dark)
    # pancake stack
    px0 = 700
    for k in range(3):
        y = 640 - k * 92
        d.rounded_rectangle([px0 - 150, y - 80, px0 + 150, y + 8], radius=40, fill=(233, 169, 85, 255))
        d.rounded_rectangle([px0 - 150, y - 36, px0 + 150, y - 4], radius=14, fill=(247, 230, 190, 255))
    d.rounded_rectangle([px0 - 55, 330, px0 + 55, 372], radius=12, fill=(249, 224, 139, 255))
    d.ellipse([px0 - 170, 650, px0 + 170, 720], fill=(255, 255, 255, 255))
    path = os.path.join(OUT, "sign-icon.png")
    img.save(path)
    print("wrote", path)


def awning():
    """Awning stripes along u: green / cream, with a scalloped lower edge painted darker at v < .08."""
    W = 1024
    img = Image.new("RGBA", (W, 256), (255, 246, 232, 255))
    d = ImageDraw.Draw(img)
    n = 12
    for i in range(n):
        if i % 2 == 0:
            d.rectangle([i * W / n, 0, (i + 1) * W / n, 256], fill=(94, 143, 110, 255))
    path = os.path.join(OUT, "awning.png")
    img.save(path)
    print("wrote", path)


def parasol():
    """Parasol canopy panels along u: coral / cream."""
    W = 1024
    img = Image.new("RGBA", (W, 64), (255, 246, 232, 255))
    d = ImageDraw.Draw(img)
    n = 8
    for i in range(n):
        if i % 2 == 0:
            d.rectangle([i * W / n, 0, (i + 1) * W / n, 64], fill=(244, 163, 168, 255))
    path = os.path.join(OUT, "parasol.png")
    img.save(path)
    print("wrote", path)


def phone_screen():
    """Phone screen when seen from the back of the scene: a soft sky gradient, no UI, no text."""
    W, H = 256, 512
    img = Image.new("RGBA", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=lerp((255, 214, 190), (159, 211, 240), y / H) + (255,))
    path = os.path.join(OUT, "phone-screen.png")
    img.save(path)
    print("wrote", path)


if __name__ == "__main__":
    for char, spec in FACE_SPECS.items():
        for kind in spec["faces"]:
            face(char, kind)
    apron_bear()
    cardigan_cat()
    top_rabbit()
    pancake_layer()
    sugar()
    strawberry()
    quilt()
    clock_face()
    sign_icon()
    awning()
    parasol()
    phone_screen()
