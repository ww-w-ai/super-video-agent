"""EXAMPLE cast generator: round, big-headed plush animal characters and the custom props of one
cozy café film, in one script. One example style, not a default.

Run (Blender headless):
  blender --background --python make_cast.py -- <target> [--previews] [--out <dir>]
  target: tex | bear | cat | rabbit | puppy | pancake | props-small | props-set | props-town
Writes <out>/models/<target>.glb and, with --previews, EEVEE stills to <out>/previews/.
<out> defaults to ./out next to this script.

Build: rigid head sunk under a collar, each arm and leg one continuous soft stub, painted
switchable face shells, outfit decal shells. Every biped is built by build_biped(spec) from the
same shapes and the same skeleton, so every clip plays on every biped. The bear is the base
biped with the same numbers, plus a ribbon, lashes and the extra faces and clips.
Textures come from textures.py (run by target "tex").
"""
import math
import os
import random
import subprocess
import sys
import time

import bmesh
import bpy
from mathutils import Matrix, Vector

T0 = time.time()
ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["bear"]
TARGET = ARGV[0]
PREVIEWS = "--previews" in ARGV
HERE = os.path.dirname(os.path.realpath(__file__))
OUT = os.path.abspath(ARGV[ARGV.index("--out") + 1]) if "--out" in ARGV else os.path.join(HERE, "out")
MODELS = os.path.join(OUT, "models")
PREV = os.path.join(OUT, "previews")
TEX = os.path.join(OUT, "tex")
os.makedirs(MODELS, exist_ok=True)
os.makedirs(PREV, exist_ok=True)
FPS = 30

if TARGET == "tex":
    subprocess.run(["python3", os.path.join(HERE, "textures.py"), TEX], check=True)  # system Python has PIL
    sys.exit(0)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS


# ======================================================================================
# colours and materials
# ======================================================================================
def srgb(hexstr):
    out = []
    for i in (0, 2, 4):
        c = int(hexstr[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


MATS = {}


def mat(name, hexstr, rough=0.75, metal=0.0, coat=0.0, emit=0.0, alpha=1.0):
    """One Principled material per name; glTF exports it as PBR (coat -> clearcoat)."""
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*srgb(hexstr), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.06
    if emit:
        b.inputs["Emission Color"].default_value = (*srgb(hexstr), 1)
        b.inputs["Emission Strength"].default_value = emit
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    MATS[name] = m
    return m


def tex_mat(name, png, rough=0.7, blend=False, coat=0.0):
    """Image texture on Base Color; blend=True also drives Alpha (glTF alphaMode BLEND)."""
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = rough
    if coat:
        b.inputs["Coat Weight"].default_value = coat
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = bpy.data.images.load(os.path.join(TEX, png))
    t.extension = "CLIP" if blend else "REPEAT"
    nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    if blend:
        nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
        m.surface_render_method = "BLENDED"
    MATS[name] = m
    return m


# ======================================================================================
# mesh builders (bmesh, world coordinates)
# ======================================================================================
def link(name, bm, material=None, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    scene.collection.objects.link(o)
    if material is not None:
        me.materials.append(material)
    if smooth:
        me.shade_smooth()
    return o


def xform(bm, M):
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)


def R(axis, deg):
    return Matrix.Rotation(math.radians(deg), 4, axis)


def R3(axis, deg):
    return Matrix.Rotation(math.radians(deg), 3, axis)


def T(v):
    return Matrix.Translation(Vector(v))


def S(sx, sy, sz):
    return Matrix.Diagonal((sx, sy, sz, 1))


def ellipsoid(name, c, r, m=None, segs=32, rings=16, rot=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    xform(bm, T(c) @ (rot if rot is not None else Matrix()) @ S(*r))
    return link(name, bm, m)


def lathe(name, prof, m=None, segs=40, vs=None, M=None, smooth=True):
    """Surface of revolution about +Z. prof = [(r, z)] with the solid on the left of travel
    (bottom centre -> outside -> top centre). r == 0 ends become poles. vs = UV v per point
    (u = angle / 2pi), with a seam column so the texture wraps without a smear."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap") if vs else None
    rings = []
    for r, z in prof:
        if r < 1e-7:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            rings.append([bm.verts.new((r * math.cos(a), r * math.sin(a), z))
                          for a in (2 * math.pi * k / segs for k in range(segs))])

    def put(face, coords):
        if uv:
            for lp, c in zip(face.loops, coords):
                lp[uv].uv = c

    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        va, vb = (vs[i], vs[i + 1]) if vs else (0, 0)
        for k in range(segs):
            k2 = (k + 1) % segs
            u0, u1 = k / segs, (k + 1) / segs
            if len(a) == 1 and len(b) == 1:
                continue
            if len(a) == 1:
                f = bm.faces.new((a[0], b[k2], b[k]))
                put(f, [((u0 + u1) / 2, va), (u1, vb), (u0, vb)])
            elif len(b) == 1:
                f = bm.faces.new((a[k], a[k2], b[0]))
                put(f, [(u0, va), (u1, va), ((u0 + u1) / 2, vb)])
            else:
                f = bm.faces.new((a[k], a[k2], b[k2], b[k]))
                put(f, [(u0, va), (u1, va), (u1, vb), (u0, vb)])
    if M is not None:
        xform(bm, M)
    return link(name, bm, m, smooth)


def arc_prof(cx, cz, rad, a0, a1, n):
    """Points on a circle in the (r, z) plane, angles in degrees (0 = +r, 90 = +z)."""
    return [(cx + rad * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cz + rad * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def rounded_cyl_prof(r, h, e, z0=0.0, bulge=0.0, dome=0.0, n=5):
    """Puck: flat bottom, rounded edges of radius e, optional side bulge and top dome."""
    p = [(0, z0), (r - e, z0)]
    p += arc_prof(r - e, z0 + e, e, -90, 0, n)[1:]
    if bulge:
        p.append((r + bulge, z0 + h / 2))
    p += arc_prof(r - e, z0 + h - e, e, 0, 90, n)
    if dome:
        p.append(((r - e) * 0.5, z0 + h + dome * 0.75))
    p.append((0, z0 + h + dome))
    return p


def tube(name, p0, p1, r0, r1, rings=28, segs=20, power=3.0, m=None):
    """Continuous rounded stub: radius r0 -> r1, superellipse caps, rings bunched at the ends."""
    p0, p1 = Vector(p0), Vector(p1)
    d = (p1 - p0).normalized()
    u = d.orthogonal().normalized()
    w = d.cross(u)
    bm = bmesh.new()
    ring_verts = []
    for i in range(1, rings):
        t = (1 - math.cos(math.pi * i / rings)) / 2
        prof = (1 - abs(2 * t - 1) ** power) ** (1 / power)
        r = (r0 + (r1 - r0) * t) * prof
        c = p0.lerp(p1, t)
        ring_verts.append([bm.verts.new(c + (u * math.cos(a) + w * math.sin(a)) * r)
                           for a in (2 * math.pi * k / segs for k in range(segs))])
    top, bot = bm.verts.new(p0), bm.verts.new(p1)
    for k in range(segs):
        k2 = (k + 1) % segs
        bm.faces.new((top, ring_verts[0][k2], ring_verts[0][k]))
        bm.faces.new((bot, ring_verts[-1][k], ring_verts[-1][k2]))
        for a, b in zip(ring_verts, ring_verts[1:]):
            bm.faces.new((a[k], a[k2], b[k2], b[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return link(name, bm, m)


def path_tube(name, pts, radii, m=None, segs=16, sub=6, cap=True):
    """Soft tube along a Catmull-Rom path through pts; radius per point; rounded end caps."""
    P = [Vector(p) for p in pts]
    n = len(P)
    samples, rads = [], []
    for i in range(n - 1):
        p0, p1, p2, p3 = P[max(0, i - 1)], P[i], P[i + 1], P[min(n - 1, i + 2)]
        for s in range(sub):
            t = s / sub
            t2, t3 = t * t, t * t * t
            samples.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                                  + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
            rads.append(radii[i] + (radii[i + 1] - radii[i]) * t)
    samples.append(P[-1])
    rads.append(radii[-1])
    bm = bmesh.new()
    rings = []
    tangent0 = (samples[1] - samples[0]).normalized()
    normal = tangent0.orthogonal().normalized()
    for i, c in enumerate(samples):
        tng = (samples[min(i + 1, len(samples) - 1)] - samples[max(i - 1, 0)]).normalized()
        normal = (normal - tng * normal.dot(tng)).normalized()  # parallel transport
        bi = tng.cross(normal)
        rings.append([bm.verts.new(c + (normal * math.cos(a) + bi * math.sin(a)) * rads[i])
                      for a in (2 * math.pi * k / segs for k in range(segs))])
    for a, b in zip(rings, rings[1:]):
        for k in range(segs):
            k2 = (k + 1) % segs
            bm.faces.new((a[k], a[k2], b[k2], b[k]))
    if cap:
        for ring, c, tng, r in ((rings[0], samples[0], -(samples[1] - samples[0]).normalized(), rads[0]),
                                (rings[-1], samples[-1], (samples[-1] - samples[-2]).normalized(), rads[-1])):
            pole = bm.verts.new(c + tng * r * 0.9)
            for k in range(segs):
                bm.faces.new((ring[k], ring[(k + 1) % segs], pole))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return link(name, bm, m)


def torus(name, c, R_, r, m=None, rot=None, scale=(1, 1, 1), seg=40, mseg=12):
    bm = bmesh.new()
    rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ca, sa = math.cos(a), math.sin(a)
        rings.append([bm.verts.new(((R_ + r * math.cos(b)) * ca, (R_ + r * math.cos(b)) * sa, r * math.sin(b)))
                      for b in (2 * math.pi * j / mseg for j in range(mseg))])
    for i in range(seg):
        a, b = rings[i], rings[(i + 1) % seg]
        for j in range(mseg):
            j2 = (j + 1) % mseg
            bm.faces.new((a[j], b[j], b[j2], a[j2]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    xform(bm, T(c) @ (rot if rot is not None else Matrix()) @ S(*scale))
    return link(name, bm, m)


def weighted_normals(o):
    """Bevelled hard-surface look: flat faces stay flat, bevels carry the roundness."""
    mod = o.modifiers.new("wn", "WEIGHTED_NORMAL")
    mod.mode = "FACE_AREA"
    mod.weight = 100
    mod.keep_sharp = True
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def rbox(name, size, loc=(0, 0, 0), bevel=0.02, m=None, rot=None, segs=3, base=False):
    """Rounded box. base=True puts loc at the bottom centre instead of the centre."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    xform(bm, S(*size))
    b = min(bevel, min(size) * 0.49)
    if b > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=b, segments=segs, profile=0.5,
                        affect="EDGES", clamp_overlap=True)
    off = Vector((0, 0, size[2] / 2)) if base else Vector()
    xform(bm, T(Vector(loc) + off) @ (rot if rot is not None else Matrix()))
    o = link(name, bm, m)
    weighted_normals(o)
    return o


def cyl(name, r, h, loc=(0, 0, 0), bevel=0.01, m=None, rot=None, verts=32, r2=None, base=True):
    """Cylinder (or cone with r2) standing on loc (base=True) with rounded rims."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=verts, radius1=r,
                          radius2=r if r2 is None else r2, depth=h)
    if bevel > 0:
        rim = [e for e in bm.edges if all(abs(abs(v.co.z) - h / 2) < 1e-5 for v in e.verts)]
        bmesh.ops.bevel(bm, geom=rim, offset=min(bevel, h * 0.45, r * 0.45), segments=3, profile=0.5,
                        affect="EDGES", clamp_overlap=True)
    off = Vector((0, 0, h / 2)) if base else Vector()
    xform(bm, T(Vector(loc)) @ (rot if rot is not None else Matrix()) @ T(off))
    o = link(name, bm, m)
    weighted_normals(o)
    return o


def join(objs, name):
    objs = [o for o in objs if o is not None]
    if len(objs) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
    o = objs[0]
    o.name = name
    o.data.name = name
    return o


def set_origin(o, point):
    """Move the object origin to `point` (world) without moving the mesh."""
    p = Vector(point)
    o.data.transform(T(-p))
    o.location = p


def rigid(o, bone):
    vg = o.vertex_groups.get(bone) or o.vertex_groups.new(name=bone)
    vg.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
    return o


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def decal_shell(name, source, material, keep_face, uv_of, lift=0.004):
    """Copy the source surface where keep_face(centre, normal), lift it, project UVs."""
    bm = bmesh.new()
    bm.from_mesh(source.data)
    for layer in list(bm.loops.layers.uv.values()):
        bm.loops.layers.uv.remove(layer)
    bm.normal_update()
    keep = {f for f in bm.faces if keep_face(f.calc_center_median(), f.normal)}
    for f in [f for f in bm.faces if f not in keep]:
        bm.faces.remove(f)
    for v in [v for v in bm.verts if not v.link_faces]:
        bm.verts.remove(v)
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * lift
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for lp in f.loops:
            lp[uv].uv = uv_of(lp.vert.co)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    me.materials.append(material)
    me.shade_smooth()
    o = bpy.data.objects.new(name, me)
    scene.collection.objects.link(o)
    return o


def flatten(o, center, normal, k):
    """Squash an object along `normal` by k about `center` (plush ears are flat, not round)."""
    n = Vector(normal).normalized()
    c = Vector(center)
    for v in o.data.vertices:
        d = (v.co - c).dot(n)
        v.co -= n * d * (1 - k)


def bent_normals(pts, side=(1, 0, 0)):
    """Front-face normal at each point of a bent flat part: perpendicular to the local tangent and to the
    part's width direction, so the front turns with the bend (a folded ear's inside faces down)."""
    P = [Vector(p) for p in pts]
    out = []
    for k in range(len(P)):
        t = (P[min(k + 1, len(P) - 1)] - P[max(k - 1, 0)]).normalized()
        out.append(Vector(side).cross(t).normalized())
    return out


def bent_frames(pts, dense=12):
    """Dense (point, front normal) samples along a polyline through pts, for flatten_along."""
    P, N = [Vector(p) for p in pts], bent_normals(pts)
    out = []
    for k in range(len(P) - 1):
        for j in range(dense):
            u = j / dense
            out.append((P[k].lerp(P[k + 1], u), N[k].lerp(N[k + 1], u).normalized()))
    out.append((P[-1], N[-1]))
    return out


def flatten_along(o, frames, k):
    """Squash each vertex by k along the front normal of its nearest path sample (a flat part that bends)."""
    for v in o.data.vertices:
        c, n = min(frames, key=lambda f: (v.co - f[0]).length_squared)
        v.co -= n * (v.co - c).dot(n) * (1 - k)


def facing(axis, front=(0, -1, 0)):
    """The direction of `front` made perpendicular to `axis` (a flat part's face normal)."""
    a = Vector(axis).normalized()
    f = Vector(front)
    return (f - a * f.dot(a)).normalized()


def smoothstep(a, b, x):
    u = min(1.0, max(0.0, (x - a) / (b - a)))
    return u * u * (3 - 2 * u)


# ======================================================================================
# bipeds: shared shapes, skeleton, clips
# ======================================================================================
SHAPES = {
    "head": ((0, 0, 1.22), (0.56, 0.52, 0.50)),
    "body": ((0, 0, 0.55), (0.40, 0.36, 0.42)),
}
ARM_PIVOT_X, ARM_PIVOT_Z = 0.30, 0.70
ARM_OUT_DEG, ARM_LEN, ARM_ROOT = 32, 0.40, 0.10
ARM_R0, ARM_R1 = 0.108, 0.094
NECK_Z = 0.80
LEG_TOP_Z, LEG_BOTTOM_Z, LEG_R = 0.38, -0.01, 0.132
SLEEVE_END = 0.30
SIT_DROP = -0.12  # root drop in the sitting clips: the body bottom rests at the object origin


def arm_dir(side):
    s = 1 if side == "L" else -1
    a = math.radians(ARM_OUT_DEG)
    return Vector((s * math.sin(a), 0, -math.cos(a)))


def arm_ends(side):
    s = 1 if side == "L" else -1
    pivot = Vector((s * ARM_PIVOT_X, 0, ARM_PIVOT_Z))
    return pivot, pivot + arm_dir(side) * ARM_LEN


def arm_point(side, s):
    top, bottom = arm_ends(side)
    return top.lerp(bottom, s)


def arm_s(p, side):
    pivot, end = arm_ends(side)
    return (Vector(p) - pivot).dot(end - pivot) / (end - pivot).length_squared


CHARS = {
    "bear": dict(species="bear", fur="C98B5B", muzzle="F3D9B8", ear_in="F4A3A8", nose="2B211D",
                  shirt="FFF6E8", collar="E0785A", outfit="outfit-bear.png",
                  faces=["smile", "talk", "happy", "wink", "blink", "sleep"], acc=["ribbon", "nightcap"]),
    "cat": dict(species="cat", fur="F7E6CC", muzzle="FFF9F0", ear_in="F2AFB5", nose="E88E98",
                shirt="D3B9EA", collar="FDFBF7", outfit="outfit-cat.png",
                faces=["smile", "talk", "happy", "blink"], acc=["beret"], head_wide=1.12),
    "rabbit": dict(species="rabbit", fur="FCF7F4", muzzle="FFFFFF", ear_in="F7BCC6", nose="EE98A5",
                   shirt="FBE49C", collar="FFFFFF", outfit="outfit-rabbit.png",
                   faces=["smile", "talk", "happy", "blink"], acc=["sunhat", "peterpan"]),
}


def ears(spec, fur, inner):
    """Species ears as (object, bone) pieces."""
    out = []
    sp = spec["species"]
    for side, s in (("L", 1), ("R", -1)):
        if sp == "bear":
            out.append(ellipsoid(f"ear.{side}", (0.36 * s, 0.02, 1.62), (0.16, 0.10, 0.16), fur, 20, 10))
            out.append(ellipsoid(f"ear_in.{side}", (0.36 * s, -0.065, 1.63), (0.085, 0.03, 0.09), inner, 24, 12))
        elif sp == "cat":
            p0, p1 = Vector((0.27 * s, 0.02, 1.52)), Vector((0.43 * s, 0.02, 1.9))
            e = tube(f"ear.{side}", p0, p1, 0.155, 0.03, 16, 18, 2.2, fur)
            flatten(e, (p0 + p1) / 2, facing(p1 - p0), 0.52)
            q0, q1 = Vector((0.29 * s, -0.035, 1.58)), Vector((0.41 * s, -0.035, 1.84))
            i = tube(f"ear_in.{side}", q0, q1, 0.09, 0.02, 12, 14, 2.2, inner)
            flatten(i, (q0 + q1) / 2, facing(q1 - q0), 0.35)
            out += [e, i]
        elif sp == "rabbit" and side == "L":  # the folded ear: one soft tube that bends, no joint
            path = [(0.18 * s, 0.03, 1.5), (0.195 * s, 0.035, 1.76), (0.215 * s, 0.03, 1.97), (0.27 * s, -0.04, 2.09),
                    (0.36 * s, -0.15, 2.13)]
            frames = bent_frames(path)
            e = path_tube(f"ear.{side}", path, [0.105, 0.1, 0.094, 0.086, 0.078], fur, 16, 8)
            flatten_along(e, frames, 0.58)
            # the pink inside follows the whole ear, fold included, on its local front face
            ipath = [tuple(Vector(p) + f * 0.035) for p, f in zip(path, bent_normals(path))]
            i = path_tube(f"ear_in.{side}", ipath, [0.058, 0.058, 0.054, 0.05, 0.044], inner, 12, 8)
            flatten_along(i, bent_frames(ipath), 0.34)
            out += [e, i]
        elif sp == "rabbit":
            segs = [((0.18 * s, 0.03, 1.5), (0.23 * s, 0.05, 2.3))]
            for k, (a, b) in enumerate(segs):
                a, b = Vector(a), Vector(b)
                n = facing(b - a)
                e = tube(f"ear{k}.{side}", a, b, 0.105, 0.088 if k == 0 else 0.082, 14, 16, 2.4, fur)
                flatten(e, (a + b) / 2, n, 0.58)
                ia, ib = a + n * 0.035 + (b - a) * 0.08, b + n * 0.035 - (b - a) * 0.12
                i = tube(f"ear_in{k}.{side}", ia, ib, 0.06, 0.05, 10, 12, 2.4, inner)
                flatten(i, (ia + ib) / 2, n, 0.34)
                out += [e, i]
    return out


def muzzle_parts(spec):
    sp = spec["species"]
    mz, ns = mat(f"muzzle", spec["muzzle"]), mat("nose", spec["nose"], 0.3)
    if sp == "bear":
        return [ellipsoid("muzzle", (0, -0.44, 1.09), (0.19, 0.12, 0.13), mz, 28, 14),
                ellipsoid("nose", (0, -0.555, 1.14), (0.065, 0.04, 0.045), ns, 24, 12)]
    if sp == "cat":
        return [ellipsoid("puff.L", (0.056, -0.488, 1.055), (0.072, 0.046, 0.058), mz, 20, 10),
                ellipsoid("puff.R", (-0.056, -0.488, 1.055), (0.072, 0.046, 0.058), mz, 20, 10),
                ellipsoid("nose", (0, -0.528, 1.103), (0.037, 0.022, 0.026), ns, 16, 8)]
    return [ellipsoid("nose", (0, -0.513, 1.098), (0.031, 0.02, 0.023), ns, 16, 8)]  # rabbit: a pink nose only


def tail_parts(spec, fur):
    sp = spec["species"]
    if sp == "bear":
        return [(ellipsoid("tail", (0, 0.36, 0.40), (0.09, 0.09, 0.09), fur, 16, 8), "tail1")]
    if sp == "rabbit":
        return [(ellipsoid("tail", (0, 0.37, 0.36), (0.12, 0.11, 0.12), fur, 20, 10), "tail1")]
    t = path_tube("tail", [(0, 0.26, 0.32), (0.06, 0.5, 0.28), (0.14, 0.62, 0.46), (0.12, 0.6, 0.74),
                           (0.02, 0.55, 0.86)], [0.05, 0.047, 0.045, 0.044, 0.046], fur, 14, 6)
    return [(t, "tailblend")]


def bow(name, center, normal, m, size=1.0):
    """Ribbon bow facing `normal`: two loops, a knot and two tails."""
    parts = []
    for s in (1, -1):
        parts.append(ellipsoid(f"{name}_loop{s}", (0.068 * s * size, 0, 0.004), (0.07 * size, 0.026 * size, 0.046 * size),
                               m, 18, 10, R(("Y"), 18 * s)))
        parts.append(path_tube(f"{name}_tail{s}", [(0.01 * s * size, 0.004, -0.01), (0.04 * s * size, 0.006, -0.06 * size),
                                                    (0.055 * s * size, 0.004, -0.085 * size)],
                               [0.018 * size, 0.016 * size, 0.017 * size], m, 10, 4))
    parts.append(ellipsoid(f"{name}_knot", (0, -0.006, 0), (0.03 * size, 0.026 * size, 0.03 * size), m, 16, 8))
    o = join(parts, name)
    rot = Vector((0, -1, 0)).rotation_difference(Vector(normal).normalized()).to_matrix().to_4x4()
    o.data.transform(T(center) @ rot)
    return o


def accessories(spec):
    """(object, bone, separate) — separate objects stay their own node (the page toggles them)."""
    out = []
    acc = spec["acc"]
    if "ribbon" in acc:
        out.append((bow("ribbon", (0.3, -0.215, 1.575), (0.45, -0.55, 0.7), mat("coral", "E0785A", 0.6), 1.0),
                    "head", False))
    if "nightcap" in acc:
        cap = mat("nightcap", "9FD3F0", 0.85)
        cream = mat("capband", "FFF6E8", 0.9)
        parts = [path_tube("cap", [(0, 0.02, 1.6), (-0.05, 0.04, 1.8), (-0.2, 0.06, 1.95), (-0.38, 0.08, 1.97),
                                   (-0.52, 0.08, 1.88)], [0.31, 0.25, 0.16, 0.095, 0.05], cap, 24, 6),
                 torus("capband", (0, 0.02, 1.625), 0.29, 0.04, cream, scale=(1, 0.95, 1)),
                 ellipsoid("pompom", (-0.57, 0.08, 1.82), (0.075, 0.075, 0.075), cream, 16, 8)]
        out.append((join(parts, "acc_nightcap"), "head", True))
    if "beret" in acc:
        m = mat("beret", "D8707F", 0.85)
        parts = [ellipsoid("beret", (-0.05, 0.02, 1.7), (0.3, 0.3, 0.09), m, 32, 12, R("Y", -14)),
                 ellipsoid("stalk", (-0.07, 0.02, 1.79), (0.025, 0.025, 0.03), m, 10, 6)]
        out.append((join(parts, "acc_beret"), "head", False))
    if "sunhat" in acc:
        straw = mat("straw", "EBCF8E", 0.92)
        band = mat("hatband", "F4A3A8", 0.7)
        brim = lathe("brim", [(0.22, 0.0), (0.46, -0.012), (0.475, -0.004), (0.47, 0.008), (0.45, 0.012),
                              (0.22, 0.022)], straw, 48)
        brim_ring = lathe("brim_in", [(0.22, 0.022), (0.2, 0.011), (0.22, 0.0)], straw, 48)
        crown = ellipsoid("crown", (0, 0, 0.055), (0.25, 0.25, 0.14), straw, 32, 14)
        hb = torus("hatband", (0, 0, 0.04), 0.248, 0.032, band)
        hat = join([brim, brim_ring, crown, hb], "acc_sunhat")
        hat.data.transform(T((0, 0.02, 1.655)) @ R("X", 7))
        hbow = bow("hatbow", (0.2, -0.17, 1.72), (0.6, -0.8, 0.1), band, 0.8)
        out.append((join([hat, hbow], "acc_sunhat"), "head", False))
    if "peterpan" in acc:
        white = mat("collar_white", "FFFFFF", 0.8)
        parts = [ellipsoid(f"lobe{s}", (0.11 * s, -0.25, 0.79), (0.14, 0.05, 0.08), white, 20, 10,
                           R("X", -28) @ R("Y", 24 * s)) for s in (1, -1)]
        parts.append(bow("collarbow", (0, -0.3, 0.8), (0, -1, 0.25), mat("pinkbow", "F4A3A8", 0.7), 0.6))
        out.append((join(parts, "peterpan"), "chest", False))
    return out


def build_biped(name, spec):
    fur_m = mat("fur", spec["fur"], 0.85)
    shirt_m = mat("shirt", spec["shirt"], 0.8)
    inner_m = mat("ear_in", spec["ear_in"])

    def painted(o, fn):
        o.data.materials.clear()
        o.data.materials.append(fur_m)
        o.data.materials.append(shirt_m)
        for p in o.data.polygons:
            p.material_index = 1 if fn(p.center) else 0
        return o

    # ---- rigid fur pieces: head, body, legs, arms, tail
    head_o = rigid(ellipsoid("head", *SHAPES["head"], fur_m, 40, 20), "head")
    body = rigid(painted(ellipsoid("body", *SHAPES["body"], fur_m, 40, 20), lambda c: True), "chest")
    fur_pieces = [head_o, body]
    for side in "LR":
        s = 1 if side == "L" else -1
        fur_pieces.append(rigid(tube(f"leg.{side}", (0.18 * s, 0.0, LEG_TOP_Z), (0.18 * s, -0.035, LEG_BOTTOM_Z),
                                     LEG_R, LEG_R + 0.006, 20, 18, 2.6, fur_m), f"thigh.{side}"))
        pivot, end = arm_ends(side)
        a = tube(f"arm.{side}", pivot - arm_dir(side) * ARM_ROOT, end, ARM_R0, ARM_R1, m=fur_m)
        up, fore = a.vertex_groups.new(name=f"upper_arm.{side}"), a.vertex_groups.new(name=f"forearm.{side}")
        for v in a.data.vertices:
            f = smoothstep(0.36, 0.64, arm_s(v.co, side))  # elbow band, inside the arm only
            if f < 0.99:
                up.add([v.index], 1 - f, "REPLACE")
            if f > 0.01:
                fore.add([v.index], f, "REPLACE")
        painted(a, lambda c, sd=side: arm_s(c, sd) < SLEEVE_END)
        fur_pieces.append(a)
    for o, bone in tail_parts(spec, fur_m):
        if bone == "tailblend":  # cat tail: base follows tail1, tip follows tail2
            g1, g2 = o.vertex_groups.new(name="tail1"), o.vertex_groups.new(name="tail2")
            for v in o.data.vertices:
                f = smoothstep(0.38, 0.62, v.co.z)
                g1.add([v.index], 1 - f, "REPLACE")
                g2.add([v.index], f, "REPLACE")
        else:
            rigid(o, bone)
        fur_pieces.append(o)
    head_group = [head_o]  # everything that rides the head bone, widened together below
    for o in ears(spec, fur_m, inner_m):
        head_group.append(o)
        fur_pieces.append(rigid(o, "head"))
    muzzle_objs = []  # the muzzle and cheek puffs also carry the face decal, so the mouth sits on them
    for o in muzzle_parts(spec):
        if o.name.startswith(("muzzle", "puff")):
            muzzle_objs.append(o)
        head_group.append(o)
        fur_pieces.append(rigid(o, "head"))
    if "peterpan" not in spec["acc"]:
        fur_pieces.append(rigid(torus("collar", (0, 0, NECK_Z), 0.30, 0.05 if spec["species"] == "bear" else 0.042,
                                      mat("collar", spec["collar"], 0.7), scale=(1.0, 0.93, 0.9)), "chest"))
    else:
        fur_pieces.append(rigid(torus("collar", (0, 0, NECK_Z), 0.295, 0.036, mat("collar", spec["collar"], 0.8),
                                      scale=(1.0, 0.93, 0.9)), "chest"))
    separate = []
    for o, bone, sep in accessories(spec):
        rigid(o, bone)
        if bone == "head":
            head_group.append(o)
        (separate if sep else fur_pieces).append(o)

    # ---- decals: faces (switchable) and the outfit
    faces = {}
    face_keep = lambda c, n: c.y < -0.12 and 0.84 < c.z < 1.68 and n.y < -0.25
    face_uv = lambda p: ((p.x + 0.56) / 1.12, (p.z - 0.72) / 1.0)
    for k in spec["faces"]:
        m = tex_mat(f"face_{k}", f"face-{name}-{k}.png", 0.5, True)
        shells = [decal_shell(f"face_{k}", head_o, m, face_keep, face_uv)]
        for j, mo in enumerate(muzzle_objs):
            shells.append(decal_shell(f"face_{k}_muzzle{j}", mo, m, face_keep, face_uv))
        faces[k] = rigid(join(shells, f"face_{k}"), "head")
    outfit = rigid(decal_shell("outfit", body, tex_mat("outfit", spec["outfit"], 0.8, True),
                               lambda c, n: c.y < -0.05 and 0.08 < c.z < 0.86 and abs(c.x) < 0.36 and n.y < -0.2,
                               lambda p: ((p.x + 0.42) / 0.84, (p.z - 0.08) / 0.84)), "chest")
    # a wider head reads cat, not rabbit: stretch the head, its ears, muzzle, hats and faces sideways
    for o in head_group + list(faces.values()):
        for v in o.data.vertices:
            v.co.x *= spec.get("head_wide", 1.0)
    fur = join(fur_pieces, "Body")
    rig = biped_rig(name)
    for o in [fur, outfit, *faces.values(), *separate]:
        o.parent = rig
        mod = o.modifiers.new("Armature", "ARMATURE")
        mod.object = rig
    biped_sockets(rig)
    biped_clips(rig)
    print("TRIS", name, "body", tris(fur), "outfit", tris(outfit), "one face", tris(faces["smile"]),
          "separate", [(o.name, tris(o)) for o in separate])
    return rig, faces, separate


def biped_rig(name):
    bpy.ops.object.armature_add(location=(0, 0, 0))
    rig = bpy.context.active_object
    rig.name = f"{name}_rig"
    bpy.ops.object.mode_set(mode="EDIT")
    eb = rig.data.edit_bones
    eb[0].name = "root"
    eb[0].head, eb[0].tail = (0, 0, 0), (0, 0, 0.12)
    eb[0].use_deform = False

    def bone(bname, head, tail, parent, connect=False):
        b = eb.new(bname)
        b.head, b.tail = head, tail
        b.parent = eb[parent]
        b.use_connect = connect

    bone("spine", (0, 0, 0.26), (0, 0, 0.58), "root")
    bone("chest", (0, 0, 0.58), (0, 0, NECK_Z - 0.02), "spine", True)
    bone("neck", (0, 0, NECK_Z - 0.02), (0, 0, NECK_Z + 0.12), "chest", True)
    bone("head", (0, 0, NECK_Z + 0.12), (0, 0, 1.75), "neck", True)
    bone("tail1", (0, 0.28, 0.32), (0, 0.46, 0.34), "spine")
    bone("tail2", (0, 0.46, 0.34), (0, 0.6, 0.62), "tail1", True)
    for side, s in (("L", 1), ("R", -1)):
        top = arm_point(side, 0.0)
        bone(f"shoulder.{side}", (0.10 * s, 0, top.z - 0.02), tuple(top), "chest")
        bone(f"upper_arm.{side}", tuple(top), tuple(arm_point(side, 0.5)), f"shoulder.{side}", True)
        bone(f"forearm.{side}", tuple(arm_point(side, 0.5)), tuple(arm_point(side, 0.83)), f"upper_arm.{side}", True)
        bone(f"hand.{side}", tuple(arm_point(side, 0.83)), tuple(arm_point(side, 1.0)), f"forearm.{side}", True)
        bone(f"thigh.{side}", (0.18 * s, 0, 0.28), (0.18 * s, -0.02, 0.15), "root")
        bone(f"shin.{side}", (0.18 * s, -0.02, 0.15), (0.18 * s, -0.02, 0.05), f"thigh.{side}", True)
        bone(f"foot.{side}", (0.18 * s, -0.02, 0.05), (0.18 * s, -0.15, 0.02), f"shin.{side}", True)
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def socket(rig, name, bone, pos):
    """An empty parented to a bone: the page hangs props on it (phone, lid, plate, leash)."""
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.05
    scene.collection.objects.link(e)
    e.parent = rig
    e.parent_type = "BONE"
    e.parent_bone = bone
    bpy.context.view_layer.update()
    e.matrix_world = Matrix.Translation(pos)
    return e


def biped_sockets(rig):
    for side in "LR":
        socket(rig, f"hold_{side}", f"hand.{side}", arm_point(side, 0.9) + Vector((0, -0.03, 0)))


# ---- clips ------------------------------------------------------------------------------
def world_rot(pb, bname, rot3):
    rest = pb[bname].bone.matrix_local.to_3x3()
    return (rest.inverted() @ rot3 @ rest).to_quaternion()


def arm(side, up=0.0, fwd=0.0, yaw=0.0, bend=0.0, bend_up=0.0):
    """Pose one arm by world axes at rest: up = raise sideways, fwd = swing forward,
    yaw = turn about Z (toward the front for a raised arm, toward the centre line for a
    forward arm), bend / bend_up = elbow bend forward / in the raise plane (<= ~60)."""
    s = 1 if side == "L" else -1
    return {f"upper_arm.{side}": R3("Z", -s * yaw) @ R3("X", -fwd) @ R3("Y", -s * up),
            f"forearm.{side}": R3("X", -bend) @ R3("Y", -s * bend_up)}


def head(nod=0.0, tilt=0.0, turn=0.0, split=0.4):
    """nod > 0 looks down, tilt > 0 rolls the top toward +X (her left), turn > 0 looks to her left."""
    rn = R3("Z", turn * split) @ R3("Y", tilt * split) @ R3("X", nod * split)
    rh = R3("Z", turn * (1 - split)) @ R3("Y", tilt * (1 - split)) @ R3("X", nod * (1 - split))
    return {"neck": rn, "head": rh}


SIT = {"thigh.L": R3("X", -90), "thigh.R": R3("X", -90), "shin.L": R3("X", 90), "shin.R": R3("X", 90)}


def merge(*ds):
    out = {}
    for d in ds:
        for k, v in d.items():
            out[k] = v @ out[k] if k in out else v
    return out


def key_clip(rig, name, keys):
    """keys: [(frame, {bone: world-axis rot3}, root_z?, {bone: scale}?)]; unlisted bones rest."""
    pb = rig.pose.bones
    for p in pb:
        p.rotation_mode = "QUATERNION"
    rig.animation_data_create()
    rig.animation_data.action = None
    for frame, rots, *extra in keys:
        root_z = extra[0] if extra else 0.0
        scales = extra[1] if len(extra) > 1 else {}
        for p in pb:
            p.rotation_quaternion = world_rot(pb, p.name, rots[p.name]) if p.name in rots else (1, 0, 0, 0)
            p.keyframe_insert("rotation_quaternion", frame=frame)
            # the root bone points up (+Z world): its local Y is world up, its local Z is world -Y
            p.location = (0, root_z, 0) if p.name == "root" else (0, 0, 0)
            p.keyframe_insert("location", frame=frame)
            sc = scales.get(p.name, 1.0)
            p.scale = sc if isinstance(sc, tuple) else (sc, sc, sc)
            p.keyframe_insert("scale", frame=frame)
    act = rig.animation_data.action
    act.name = name
    act.use_fake_user = True
    return act


WAVE_ARM = dict(up=96, yaw=42)


def wave_keys(side, base, n=4, period=6, rz=0.0, lead=None):
    """Loop: the raised forearm wags in the plane facing the camera."""
    keys = []
    for i in range(n + 1):
        wag = 16 if i % 2 == 0 else 48
        tilt = 5 if side == "R" else -5
        keys.append((1 + i * period, merge(base, arm(side, bend_up=wag, **WAVE_ARM), head(tilt=tilt, nod=-3),
                                           lead or {}), rz))
    return keys


def biped_clips(rig):
    """Every clip the script calls for; all loops end on their first pose."""
    breathe = merge(head(tilt=2.5, nod=-1), {"chest": R3("X", 2)})
    rest_arms = merge(arm("L", up=4), arm("R", up=4))
    lap = merge(arm("L", fwd=34, yaw=24, bend=12), arm("R", fwd=34, yaw=24, bend=12))
    sit = SIT
    selfie = arm("R", fwd=84, up=6, yaw=14, bend=6)
    clips = {}
    clips["Idle"] = [(1, {}), (31, merge(breathe, rest_arms)), (61, {})]
    clips["Chat"] = [(1, merge(arm("R", fwd=22, yaw=20, bend=28), arm("L", up=6))),
                     (16, merge(arm("R", fwd=40, up=8, yaw=28, bend=44), arm("L", up=6), head(tilt=5, nod=3))),
                     (31, merge(arm("R", fwd=22, yaw=20, bend=26), arm("L", up=8), head(tilt=-3))),
                     (46, merge(arm("L", fwd=36, up=8, yaw=26, bend=38), arm("R", fwd=16, yaw=12, bend=16),
                                head(tilt=-5, nod=-2))),
                     (61, merge(arm("L", fwd=18, yaw=14, bend=18), arm("R", fwd=16, yaw=14, bend=18), head(nod=4))),
                     (76, merge(arm("R", fwd=26, yaw=20, bend=30), arm("L", up=6), head(tilt=3))),
                     (91, merge(arm("R", fwd=22, yaw=20, bend=28), arm("L", up=6)))]

    def walk_key(f, s, z, extra=None, swing_arms=True):
        k = {"thigh.L": R3("X", 26 * s), "thigh.R": R3("X", -26 * s), "chest": R3("Z", 4 * s)}
        if swing_arms:
            k = merge(k, {"upper_arm.L": R3("X", -20 * s), "upper_arm.R": R3("X", 20 * s)})
        k = merge(k, head(nod=-2 if z else 1))
        return (f, merge(k, extra or {}), z)

    clips["Walk"] = [walk_key(1, 1, 0), walk_key(6, 0, 0.04), walk_key(11, -1, 0), walk_key(16, 0, 0.04),
                     walk_key(21, 1, 0)]
    leash = arm("R", fwd=46, yaw=18, bend=8)
    clips["WalkLeash"] = [(f, merge(k, leash, {"upper_arm.L": R3("X", -20 * s)}), z) for (f, k, z), s in
                          zip([walk_key(1, 1, 0, None, False), walk_key(6, 0, 0.04, None, False),
                               walk_key(11, -1, 0, None, False), walk_key(16, 0, 0.04, None, False),
                               walk_key(21, 1, 0, None, False)], (1, 0, -1, 0, 1))]
    clips["Wave"] = wave_keys("R", arm("L", up=8))
    clips["SitIdle"] = [(1, merge(sit, lap), SIT_DROP), (31, merge(sit, lap, breathe), SIT_DROP),
                        (61, merge(sit, lap), SIT_DROP)]
    clips["SitWave"] = wave_keys("R", merge(sit, arm("L", fwd=34, yaw=24, bend=12)), rz=SIT_DROP)
    # phone in both paws in front of the chest, below the big head's chin; leaning toward the plate
    photo = merge(sit, arm("R", fwd=72, yaw=58, bend=14), arm("L", fwd=72, yaw=58, bend=14), {"spine": R3("X", 8)})
    clips["SitPhoto"] = [(1, merge(photo, head(nod=9)), SIT_DROP), (16, merge(photo, head(nod=11, tilt=3)), SIT_DROP),
                         (31, merge(photo, head(nod=9)), SIT_DROP)]
    sip = merge(sit, arm("R", fwd=100, yaw=58, bend=44), arm("L", fwd=34, yaw=24, bend=12))
    clips["SitSip"] = [(1, merge(sip, head(nod=-4)), SIT_DROP), (31, merge(sip, head(nod=-7, tilt=3)), SIT_DROP),
                       (61, merge(sip, head(nod=-4)), SIT_DROP)]
    clips["SelfieHold"] = [(1, merge(selfie, arm("L", up=10), head(tilt=6))),
                           (31, merge(selfie, arm("L", up=12), head(tilt=9, nod=-2), {"chest": R3("Y", 2)})),
                           (61, merge(selfie, arm("L", up=10), head(tilt=6)))]
    swave = []
    for i in range(5):
        wag = 16 if i % 2 == 0 else 48
        swave.append((1 + i * 6, merge(selfie, arm("L", bend_up=wag, **WAVE_ARM), head(tilt=-6, nod=-3))))
    clips["SelfieWave"] = swave
    clips["LiftLid"] = [(1, merge(arm("R", fwd=56, yaw=22, bend=18), head(nod=12))),
                        (10, merge(arm("R", fwd=58, yaw=22, bend=20), head(nod=13))),
                        (22, merge(arm("R", fwd=112, yaw=20, bend=36), arm("L", up=14), head(nod=-8),
                                   {"chest": R3("X", -4)})),
                        (37, merge(arm("R", fwd=108, yaw=20, bend=34), arm("L", up=12), head(nod=-6)))]
    clips["FlipBoard"] = [(1, merge(arm("R", fwd=118, up=12, yaw=12, bend=20), head(nod=-10))),
                          (10, merge(arm("R", fwd=124, up=12, yaw=12, bend=16), head(nod=-12))),
                          (18, merge(arm("R", fwd=62, yaw=18, bend=32), head(nod=-2))),
                          (31, merge(arm("R", fwd=24, yaw=10, bend=18), head(nod=2)))]
    promise = merge(arm("R", fwd=94, yaw=22, bend=10), arm("L", up=12, bend=10))
    clips["Promise"] = [(1, merge(promise, head(tilt=8)), 0.0), (16, merge(promise, head(tilt=10, nod=-3)), 0.025),
                        (31, merge(promise, head(tilt=8)), 0.0)]
    plate_up = merge(arm("L", up=92, yaw=40, bend_up=38), selfie)
    clips["ShowPlate"] = [(1, merge(plate_up, head(tilt=-7))), (31, merge(plate_up, head(tilt=-9, nod=-3))),
                          (61, merge(plate_up, head(tilt=-7)))]
    serve = merge(arm("R", fwd=74, yaw=56, bend=24), arm("L", fwd=74, yaw=56, bend=24))
    clips["Serve"] = [(1, merge(serve, head(nod=4))), (31, merge(serve, head(nod=6, tilt=4))), (61, merge(serve, head(nod=4)))]
    out = merge(arm("L", up=26), arm("R", up=26))
    hop = merge(arm("L", up=40, bend_up=20), arm("R", up=40, bend_up=20))
    clips["HappyBounce"] = [(1, {}), (5, out, -0.035), (10, merge(hop, head(nod=-5)), 0.11), (15, out, 0.0),
                            (18, {}, -0.015), (21, {}, 0.0)]
    # legs swing back 30°: lying on her back the stubby feet rest on the mattress instead of floating
    legs_back = {"thigh.L": R3("X", 30), "thigh.R": R3("X", 30)}
    lie = merge(arm("L", up=18, fwd=14, bend=10), arm("R", up=18, fwd=14, bend=10), head(tilt=9), legs_back)
    clips["Sleep"] = [(1, lie), (46, merge(lie, {"chest": R3("X", -3)})), (91, lie)]
    # snuggling under the quilt: paws drawn in over the belly (chibi arms raised toward the chin would
    # tent the quilt), head rolled into the pillow
    snug = merge(arm("L", up=8, fwd=26, bend=28), arm("R", up=8, fwd=26, bend=28), head(tilt=14, nod=6, turn=18),
                 legs_back)
    clips["SleepSnuggle"] = [(1, lie), (12, snug), (21, merge(snug, head(tilt=8, nod=10)))]
    acts = {name: key_clip(rig, name, keys) for name, keys in clips.items()}
    rig.animation_data.action = acts["Idle"]
    return acts


# preview frame per clip: the pose that shows what the clip is for
BIPED_PREVIEW = {"Idle": 31, "Chat": 16, "Walk": 1, "WalkLeash": 11, "Wave": 7, "SitIdle": 31, "SitWave": 7,
                 "SitPhoto": 16, "SitSip": 31, "SelfieHold": 31, "SelfieWave": 7, "LiftLid": 22, "FlipBoard": 10,
                 "Promise": 16, "ShowPlate": 31, "Serve": 31, "HappyBounce": 10, "Sleep": 46, "SleepSnuggle": 21}


# ======================================================================================
# puppy (its own four-legged skeleton, same plush build)
# ======================================================================================
PUP = dict(fur="F0CFA0", ear="D9A56C", muzzle="FFF4E4", nose="2B211D", collar="D9534F", tag="E9C46A")


def build_puppy():
    fur = mat("fur", PUP["fur"], 0.85)
    earm = mat("ear", PUP["ear"], 0.85)
    head_o = rigid(ellipsoid("head", (0, -0.13, 0.42), (0.25, 0.23, 0.22), fur, 36, 18), "head")
    pieces = [head_o, rigid(ellipsoid("body", (0, 0.08, 0.22), (0.165, 0.235, 0.155), fur, 32, 16), "body")]
    for side, s in (("L", 1), ("R", -1)):
        for end, y in (("F", -0.04), ("B", 0.21)):
            pieces.append(rigid(tube(f"leg{end}.{side}", (0.085 * s, y, 0.18), (0.085 * s, y - 0.012, -0.005),
                                     0.06, 0.064, 14, 14, 2.6, fur), f"leg{end}.{side}"))
        e = ellipsoid(f"ear.{side}", (0.25 * s, -0.09, 0.47), (0.08, 0.042, 0.13), earm, 18, 10,
                      R("Y", -22 * s) @ R("X", 8))  # floppy: tip hangs out and down
        pieces.append(rigid(e, "head"))
    pieces.append(rigid(ellipsoid("muzzle", (0, -0.325, 0.365), (0.1, 0.07, 0.066), mat("muzzle", PUP["muzzle"]), 24, 12),
                        "head"))
    pieces.append(rigid(ellipsoid("nose", (0, -0.392, 0.392), (0.038, 0.026, 0.028), mat("nose", PUP["nose"], 0.3), 16, 8),
                        "head"))
    tail = path_tube("tail", [(0, 0.28, 0.27), (0, 0.36, 0.36), (0, 0.35, 0.46), (0, 0.28, 0.49)],
                     [0.042, 0.04, 0.036, 0.034], fur, 12, 5)
    g1, g2 = tail.vertex_groups.new(name="tail1"), tail.vertex_groups.new(name="tail2")
    for v in tail.data.vertices:
        f = smoothstep(0.33, 0.42, v.co.z)
        g1.add([v.index], 1 - f, "REPLACE")
        g2.add([v.index], f, "REPLACE")
    pieces.append(tail)
    col = torus("collar", (0, -0.1, 0.25), 0.155, 0.032, mat("collar", PUP["collar"], 0.55), rot=R("X", -38),
                scale=(1, 0.92, 1))
    tag = ellipsoid("tag", (0, -0.245, 0.17), (0.032, 0.013, 0.032), mat("tag", PUP["tag"], 0.35, 0.6), 12, 6)
    pieces += [rigid(col, "body"), rigid(tag, "body")]
    faces = {k: rigid(decal_shell(f"face_{k}", head_o, tex_mat(f"face_{k}", f"face-puppy-{k}.png", 0.5, True),
                                  lambda c, n: c.y < -0.2 and 0.24 < c.z < 0.62 and n.y < -0.25,
                                  lambda p: ((p.x + 0.25) / 0.5, (p.z - 0.2) / 0.44)), "head")
             for k in ("smile", "happy", "blink")}
    body = join(pieces, "Body")
    bpy.ops.object.armature_add(location=(0, 0, 0))
    rig = bpy.context.active_object
    rig.name = "puppy_rig"
    bpy.ops.object.mode_set(mode="EDIT")
    eb = rig.data.edit_bones
    eb[0].name = "root"
    eb[0].head, eb[0].tail = (0, 0, 0), (0, 0, 0.08)
    eb[0].use_deform = False

    def bone(bname, h, t, parent, connect=False):
        b = eb.new(bname)
        b.head, b.tail = h, t
        b.parent = eb[parent]
        b.use_connect = connect

    bone("body", (0, -0.04, 0.22), (0, 0.22, 0.22), "root")  # pivot at the shoulders: sitting drops the rear
    bone("neck", (0, -0.06, 0.26), (0, -0.1, 0.34), "body")
    bone("head", (0, -0.1, 0.34), (0, -0.14, 0.62), "neck", True)
    bone("tail1", (0, 0.27, 0.27), (0, 0.35, 0.36), "body")
    bone("tail2", (0, 0.35, 0.36), (0, 0.3, 0.48), "tail1", True)
    for side, s in (("L", 1), ("R", -1)):
        bone(f"legF.{side}", (0.085 * s, -0.04, 0.18), (0.085 * s, -0.05, 0.0), "body")
        bone(f"legB.{side}", (0.085 * s, 0.21, 0.18), (0.085 * s, 0.2, 0.0), "body")
    bpy.ops.object.mode_set(mode="OBJECT")
    for o in [body, *faces.values()]:
        o.parent = rig
        o.modifiers.new("Armature", "ARMATURE").object = rig
    socket(rig, "leash_ring", "body", Vector((0, -0.2, 0.25)))
    puppy_clips(rig)
    print("TRIS puppy body", tris(body), "face", tris(faces["smile"]))
    return rig, faces


def puppy_clips(rig):
    def wag(a):
        return {"tail1": R3("Z", a), "tail2": R3("Z", a * 0.6)}

    def hd(nod=0, tilt=0, turn=0):
        return {"head": R3("Z", turn) @ R3("Y", tilt) @ R3("X", nod)}

    clips = {}
    clips["Idle"] = [(1, merge(wag(18), hd(tilt=3))), (16, merge(wag(-18), hd(tilt=6, nod=-3))),
                     (31, merge(wag(18), hd(tilt=3), {"body": R3("X", 1)})), (46, merge(wag(-18), hd(tilt=0))),
                     (61, merge(wag(18), hd(tilt=3)))]

    def trot(f, s, z):
        return (f, merge({"legF.L": R3("X", 32 * s), "legB.R": R3("X", 32 * s), "legF.R": R3("X", -32 * s),
                          "legB.L": R3("X", -32 * s), "body": R3("X", 2 * s)}, wag(26 * s), hd(nod=-4 * s)), z)

    clips["Trot"] = [trot(1, 1, 0.0), trot(4, 0, 0.035), trot(7, -1, 0.0), trot(10, 0, 0.035), trot(13, 1, 0.0)]
    # sit: the body pivots at the shoulders so the rear drops; front legs stay upright (stretched a
    # little to reach the ground), hind legs fold forward, the head looks level again
    sit = {"body": R3("X", -18), "legF.L": R3("X", 18), "legF.R": R3("X", 18), "legB.L": R3("X", -70),
           "legB.R": R3("X", -70)}
    sit_h = hd(nod=14)
    sit_z = 0.035
    long_f = {"legF.L": (1, 1.16, 1), "legF.R": (1, 1.16, 1)}
    clips["Sit"] = [(1, merge(sit, sit_h, wag(10)), sit_z, long_f),
                    (31, merge(sit, sit_h, wag(-10), hd(tilt=4)), sit_z, long_f),
                    (61, merge(sit, sit_h, wag(10)), sit_z, long_f)]
    sw = []
    for i in range(9):
        sw.append((1 + i * 4, merge(sit, sit_h, wag(34 if i % 2 == 0 else -34), hd(tilt=10 if i < 5 else 6)), sit_z,
                   long_f))
    clips["SitWag"] = sw
    clips["Happy"] = [(1, merge(wag(30), hd(nod=-6)), 0.0), (4, merge(wag(-30), hd(nod=-10)), 0.07),
                      (7, merge(wag(30), hd(nod=-4)), 0.0), (10, merge(wag(-30), hd(nod=-10)), 0.07),
                      (13, merge(wag(30), hd(nod=-6)), 0.0)]
    acts = {name: key_clip(rig, name, keys) for name, keys in clips.items()}
    rig.animation_data.action = acts["Idle"]


PUPPY_PREVIEW = {"Idle": 16, "Trot": 1, "Sit": 31, "SitWag": 5, "Happy": 4}


# ======================================================================================
# hero pancake: three soft layers on one skeleton, wobble clips
# ======================================================================================
PAN_R, PAN_H, PAN_E = 0.145, 0.115, 0.027
PLATE_TOP = 0.013
V_REGIONS = (0.0, 0.28, 0.36, 0.64, 0.72, 1.0)  # textures.py pancake-layer rows


def layer_profile(r, h, e):
    """Soufflé layer: flat bottom, soft rounded edges, a slight side bulge, a gently domed top.
    Returns points and their texture v (bottom 0 .. top 1, region bounds as textures.py)."""
    n = 6
    pts, vs = [(0, 0)], [0.0]
    for i in range(1, 4):
        pts.append(((r - e) * i / 3, 0))
        vs.append(0.28 * i / 3)
    for i, p in enumerate(arc_prof(r - e, e, e, -90, 0, n)[1:], 1):
        pts.append(p)
        vs.append(0.28 + 0.08 * i / n)
    for i in range(1, 4):
        z = e + (h - 2 * e) * i / 4
        pts.append((r + 0.005 * math.sin(math.pi * i / 4), z))
        vs.append(0.36 + 0.28 * i / 4)
    for i, p in enumerate(arc_prof(r - e, h - e, e, 0, 90, n)[1:], 1):
        pts.append(p)
        vs.append(0.64 + 0.08 * i / n)
    dome = 0.014
    for i in range(1, 4):
        rr = (r - e) * (1 - i / 3)
        pts.append((rr, h + dome * (1 - (rr / (r - e)) ** 2)))
        vs.append(0.72 + 0.28 * i / 3)
    return pts, vs


def build_pancake():
    layer_m = tex_mat("pancake", "pancake-layer.png", 0.62)
    syrup = mat("syrup", "96501A", 0.05, coat=1.0)
    plate_m = mat("plate", "FFFDF7", 0.22)
    coral = mat("plate_rim", "E0785A", 0.4)
    butter_m = mat("butter", "F9DF86", 0.28, coat=0.5)
    blue_m = mat("blueberry", "3E4585", 0.38)
    mint_m = mat("mint", "3F9A4E", 0.45)
    calyx_m = mat("calyx", "5E9E4E", 0.6)
    straw_m = tex_mat("strawberry", "strawberry.png", 0.35, coat=0.6)

    plate = lathe("plate", [(0, 0), (0.13, 0), (0.135, 0.004), (0.2, 0.009), (0.24, 0.022), (0.255, 0.032),
                            (0.258, 0.037), (0.25, 0.04), (0.236, 0.034), (0.2, 0.016), (0.17, PLATE_TOP),
                            (0, PLATE_TOP)], plate_m, 56)
    rim = torus("rimline", (0, 0, 0.0365), 0.247, 0.0032, coral, seg=64, mseg=6, scale=(1, 1, 0.6))
    static = [plate, rim]
    layers, z0s = [], []
    z = PLATE_TOP + 0.002
    radii = (PAN_R, PAN_R * 0.985, PAN_R * 0.965)
    offsets = ((0.0, 0.0, 0), (0.006, -0.004, 37), (-0.004, 0.005, 71))
    for i, (r, (ox, oy, rz)) in enumerate(zip(radii, offsets)):
        pts, vs = layer_profile(r, PAN_H, PAN_E)
        o = lathe(f"layer{i + 1}", pts, layer_m, 48, vs, T((ox, oy, z)) @ R("Z", rz))
        layers.append(o)
        z0s.append(z)
        z += PAN_H - 0.013
    top_z = z0s[-1] + PAN_H + 0.014
    r3 = radii[2]
    ox3, oy3 = offsets[2][0], offsets[2][1]
    # syrup: a lobed glaze on the top that reaches the rim only where it runs over, drips that
    # hug the stack's real outline (into each soft neck between layers), and a lobed pool on the
    # plate under the long front drip. Angles are world angles about the stack axis (-90 = front).
    DRIPS = ((-90, 0.0), (-38, 0.105), (18, 0.05), (72, 0.085), (140, 0.065), (205, 0.11), (250, 0.04))
    glaze, bead, drips = syrup_top(r3, (ox3, oy3), z0s[2], [math.radians(a) for a, _ in DRIPS], syrup)
    for k, (ang, ln) in enumerate(DRIPS):
        drips.append(syrup_drip(f"drip{k}", math.radians(ang), ln, radii, offsets, z0s, syrup))
    drips.append(bead)
    static.append(syrup_pool(syrup))
    butter = rbox("butter", (0.052, 0.044, 0.03), (ox3 + 0.008, oy3 - 0.004, top_z + 0.012), 0.011, butter_m,
                  R("Z", 24) @ R("X", 4))
    melt = ellipsoid("melt", (ox3 + 0.005, oy3, top_z + 0.004), (0.046, 0.04, 0.004), butter_m, 24, 8)
    sugar_pts = ([(0, top_z + 0.009)] + [((r3 - PAN_E) * f, z0s[2] + PAN_H + 0.014 * (1 - f * f) + 0.008)
                                           for f in (0.35, 0.7, 1.0)]
                 + [(p[0] + 0.007, p[1]) for p in arc_prof(r3 - PAN_E, z0s[2] + PAN_H - PAN_E, PAN_E, 90, 50, 3)[1:]])
    sugar = lathe("sugar", list(reversed(sugar_pts)), tex_mat("sugar", "sugar.png", 0.9, True), 48,
                  M=T((ox3, oy3, 0)))  # outside -> centre, so the sheet faces up
    uvl = sugar.data.uv_layers.new(name="UVMap")
    for poly in sugar.data.polygons:
        for li in poly.loop_indices:
            v = sugar.data.vertices[sugar.data.loops[li].vertex_index].co
            uvl.data[li].uv = ((v.x - ox3 + r3) / (2 * r3), (v.y - oy3 + r3) / (2 * r3))

    def strawberry(name, loc, rot, s=1.0):
        body = lathe(name, [(0, 0), (0.012 * s, 0.003 * s), (0.024 * s, 0.014 * s), (0.03 * s, 0.028 * s),
                            (0.029 * s, 0.04 * s), (0.02 * s, 0.049 * s), (0, 0.052 * s)], straw_m, 20,
                     [0, 0.15, 0.4, 0.6, 0.8, 0.95, 1.0])
        leaves = [ellipsoid(f"{name}_leaf{j}", (0.017 * s * math.cos(j * 1.26), 0.017 * s * math.sin(j * 1.26), 0.052 * s),
                            (0.017 * s, 0.007 * s, 0.003 * s), calyx_m, 10, 5, R("Z", math.degrees(j * 1.26)) @ R("Y", -18))
                  for j in range(5)]
        o = join([body, *leaves], name)
        o.data.transform(T(loc) @ rot)
        return o

    def blueberry(name, loc):
        return ellipsoid(name, loc, (0.019, 0.019, 0.017), blue_m, 14, 8)

    top_fruit = [strawberry("berry_t1", (ox3 - 0.05, oy3 - 0.035, top_z - 0.004), R("Y", -62) @ R("Z", 20)),
                 blueberry("blue_t1", (ox3 + 0.055, oy3 + 0.03, top_z + 0.005)),
                 blueberry("blue_t2", (ox3 + 0.028, oy3 + 0.062, top_z + 0.002))]
    mint = [ellipsoid(f"mint{j}", (ox3 - 0.012 + 0.018 * j, oy3 + 0.035, top_z + 0.03),
                      (0.02, 0.0095, 0.003), mint_m, 14, 6, R("Z", 60 * j - 20) @ R("X", 32) @ R("Y", 25 - 50 * j))
            for j in range(2)]
    plate_fruit = [strawberry("berry_p1", (0.19, -0.07, PLATE_TOP + 0.02), R("Y", 80) @ R("X", 10)),
                   strawberry("berry_p2", (-0.16, -0.12, PLATE_TOP + 0.02), R("Y", -80) @ R("Z", 150), 0.9),
                   blueberry("blue_p1", (0.175, 0.07, PLATE_TOP + 0.017)),
                   blueberry("blue_p2", (0.155, 0.11, PLATE_TOP + 0.017)),
                   blueberry("blue_p3", (-0.12, 0.175, PLATE_TOP + 0.017))]
    static += plate_fruit
    toppings = [butter, melt, sugar, *top_fruit, *mint]

    # skeleton: stack > layer1 > layer2 > layer3 > top
    bpy.ops.object.armature_add(location=(0, 0, 0))
    rig = bpy.context.active_object
    rig.name = "pancake_rig"
    bpy.ops.object.mode_set(mode="EDIT")
    eb = rig.data.edit_bones
    eb[0].name = "stack"
    eb[0].head, eb[0].tail = (0, 0, 0), (0, 0, PLATE_TOP)
    names = ["layer1", "layer2", "layer3"]
    bounds = z0s + [top_z]
    parent = "stack"
    for i, nm in enumerate(names):
        b = eb.new(nm)
        b.head, b.tail = (0, 0, bounds[i]), (0, 0, bounds[i + 1])
        b.parent = eb[parent]
        parent = nm
    b = eb.new("top")
    b.head, b.tail = (0, 0, top_z), (0, 0, top_z + 0.06)
    b.parent = eb["layer3"]
    bpy.ops.object.mode_set(mode="OBJECT")

    def z_weights(o):
        """Jelly blend: a layer's lower half leans on the bone below, so the stack bends in one piece."""
        groups = {n: o.vertex_groups.get(n) or o.vertex_groups.new(name=n) for n in ["stack", *names]}
        for v in o.data.vertices:
            z = v.co.z
            i = max(0, min(2, sum(1 for zz in z0s[1:] if z >= zz)))
            u = (z - z0s[i]) / PAN_H
            w = smoothstep(0.0, 0.55, u)
            below = "stack" if i == 0 else names[i - 1]
            if w > 0.001:
                groups[names[i]].add([v.index], w, "REPLACE")
            if w < 0.999:
                groups[below].add([v.index], 1 - w, "REPLACE")

    for o in layers + [glaze] + drips:
        z_weights(o)
    for o in toppings:
        rigid(o, "top")
    for o in static:
        rigid(o, "stack")
    stack = join(layers + [glaze] + drips + toppings, "stack_mesh")
    plate_o = join(static, "plate_mesh")
    for o in (stack, plate_o):
        o.parent = rig
        o.modifiers.new("Armature", "ARMATURE").object = rig
    drop = path_tube("syrup_drop", [(0, 0, 0.0), (0, 0, -0.012), (0, 0, -0.024)], [0.006, 0.01, 0.012], syrup, 10, 3)
    drop.parent = rig
    drop.parent_type = "BONE"
    drop.parent_bone = "stack"
    bpy.context.view_layer.update()
    drop.matrix_world = Matrix.Translation((ox3, oy3 - r3 - 0.004, z0s[2] + PAN_H - 0.02))
    pancake_clips(rig, names)
    print("TRIS pancake stack", tris(stack), "plate", tris(plate_o), "top z", round(top_z, 4))
    return rig


def layer_radius(u, r, h=PAN_H, e=PAN_E):
    """Outer radius of one layer at height u above its base (None outside the layer)."""
    if u < 0 or u > h:
        return None
    if u < e:
        return (r - e) + math.sqrt(max(0.0, e * e - (e - u) ** 2))
    if u > h - e:
        return (r - e) + math.sqrt(max(0.0, e * e - (u - (h - e)) ** 2))
    return r + 0.005 * math.sin(math.pi * (u - e) / (h - 2 * e))


def stack_outline(z, a, radii, offsets, z0s):
    """Distance from the stack axis to its outer surface at height z, toward world angle a."""
    best = None
    for r, (ox, oy, _), z0 in zip(radii, offsets, z0s):
        lr = layer_radius(z - z0, r)
        if lr is not None:
            d = lr + ox * math.cos(a) + oy * math.sin(a)
            best = d if best is None else max(best, d)
    return best


def top_surface_z(rho, r3, z0):
    """Height of the top layer's upper surface at radius rho from its centre (dome + rounded rim)."""
    e, h = PAN_E, PAN_H
    if rho <= r3 - e:
        return z0 + h + 0.014 * (1 - (rho / (r3 - e)) ** 2)
    return z0 + (h - e) + math.sqrt(max(0.0, e * e - (rho - (r3 - e)) ** 2))


def lobes(a, centres, width, rnd_amp=0.0, phase=0.0):
    g = max(math.exp(-((math.atan2(math.sin(a - c), math.cos(a - c))) / width) ** 2) for c in centres)
    return g, rnd_amp * math.sin(3 * a + phase) + 0.5 * rnd_amp * math.sin(7 * a + 2 * phase)


def polar_sheet(name, centre, radius_of, z_of, m, segs=72, rings=9):
    """Upward-facing sheet from a centre out to radius_of(angle); z_of(x, y) places each vertex."""
    cx, cy = centre
    bm = bmesh.new()
    mid = bm.verts.new((cx, cy, z_of(cx, cy)))
    grid = []
    for j in range(1, rings + 1):
        row = []
        for k in range(segs):
            a = 2 * math.pi * k / segs
            rr = radius_of(a) * j / rings
            x, y = cx + rr * math.cos(a), cy + rr * math.sin(a)
            row.append(bm.verts.new((x, y, z_of(x, y))))
        grid.append(row)
    for k in range(segs):
        k2 = (k + 1) % segs
        bm.faces.new((mid, grid[0][k], grid[0][k2]))
        for j in range(rings - 1):
            bm.faces.new((grid[j][k], grid[j + 1][k], grid[j + 1][k2], grid[j][k2]))
    outline = [v.co.copy() for v in grid[-1]]
    return link(name, bm, m), outline


def syrup_top(r3, c3, z0, drip_angles, m):
    """Glaze on the top layer: a soft pool that stretches to the rim at each drip."""
    ox, oy = c3

    def radius_of(a):
        g, n = lobes(a, drip_angles, 0.26, 0.05 * r3, 0.7)
        base = 0.66 * r3 + n
        return base + (r3 - 0.006 - base) * g

    def z_of(x, y):
        return top_surface_z(math.hypot(x - ox, y - oy), r3, z0) + 0.0032

    sheet, outline = polar_sheet("glaze", (ox, oy), radius_of, z_of, m)
    pts = outline + outline[:3]
    bead = path_tube("glaze_bead", pts, [0.0034] * len(pts), m, 8, 2, cap=False)
    return sheet, bead, []


def syrup_drip(name, a, length, radii, offsets, z0s, m):
    """One drip from the top rim down the stack, hugging its outline; ends in a hanging drop.
    length 0 = the long front drip that runs all the way to the plate."""
    top = z0s[2] + PAN_H - PAN_E * 0.35
    bottom = PLATE_TOP + 0.006 if length == 0 else top - length
    n = max(4, int((top - bottom) / 0.006))
    pts, rad = [], []
    ca, sa = math.cos(a), math.sin(a)
    for i in range(n + 1):
        z = top - (top - bottom) * i / n
        d = stack_outline(z, a, radii, offsets, z0s)
        if d is None:
            d = PAN_R * 0.7
        t = i / n
        r = 0.0056 - 0.0012 * t + (0.0034 * smoothstep(0.82, 1.0, t) if length else 0.0)
        rad.append(r)
        off = 0.35 * r  # half sunk into the surface: a flat bead of syrup, not a pipe
        pts.append(((d + off) * ca, (d + off) * sa, z))
    return path_tube(name, pts, rad, m, 10, 2)


def syrup_pool(m):
    """Lobed puddle on the plate, heaviest in front where the long drip lands."""
    def radius_of(a):
        g, n = lobes(a, [math.radians(-90), math.radians(-60)], 0.35, 0.01, 1.9)
        return 0.162 + 0.045 * g + n

    sheet, outline = polar_sheet("syrup_pool", (0, 0), radius_of, lambda x, y: PLATE_TOP + 0.0016, m, 72, 6)
    pts = outline + outline[:3]
    bead = path_tube("pool_bead", [(p.x, p.y, p.z + 0.0005) for p in pts], [0.0032] * len(pts), m, 8, 2, cap=False)
    return join([sheet, bead], "syrup_pool")


def damped(u, amp, freq, decay):
    return 0.0 if u < 0 else amp * math.exp(-decay * u) * math.sin(2 * math.pi * freq * u)


def pancake_clips(rig, names):
    """Per-frame keys from damped oscillations. own squash s_i is keyed as s_i / s_(i-1) on the
    chained bones (children inherit scale), so each layer's own squash is exactly s_i."""
    pb = rig.pose.bones
    for p in pb:
        p.rotation_mode = "QUATERNION"

    def clip(name, frames, squash, sway, roll=None):
        rig.animation_data_create()
        rig.animation_data.action = None
        for f in range(1, frames + 1):
            t = (f - 1) / FPS
            prev = 1.0
            for i, nm in enumerate(names):
                s = 1.0 - squash(i, t)
                p = pb[nm]
                rel = s / prev
                p.scale = (1 / math.sqrt(rel), rel, 1 / math.sqrt(rel))  # bone Y = stack axis
                prev = s
                rx = sway(i, t)
                ry = roll(i, t) if roll else 0.0
                p.rotation_quaternion = world_rot(pb, nm, R3("Y", ry) @ R3("X", rx))
                p.keyframe_insert("scale", frame=f)
                p.keyframe_insert("rotation_quaternion", frame=f)
        act = rig.animation_data.action
        act.name = name
        act.use_fake_user = True

    clip("Rest", 2, lambda i, t: 0.0, lambda i, t: 0.0)
    clip("Idle", 61, lambda i, t: 0.007 * math.sin(2 * math.pi * t / 2 + i * 0.6),
         lambda i, t: 0.35 * math.sin(2 * math.pi * t / 2 + 1 + i * 0.8),
         lambda i, t: 0.25 * math.sin(2 * math.pi * t / 2 + i * 1.3))
    clip("Jiggle", 37, lambda i, t: damped(t - 0.05 * i, 0.07, 1.7, 2.6),
         lambda i, t: damped(t - 0.05 * i, 1.4, 1.7, 2.4),
         lambda i, t: damped(t - 0.05 * i - 0.1, 0.8, 1.3, 2.4))
    clip("Wobble", 55, lambda i, t: damped(t - 0.07 * (2 - i), (0.06, 0.09, 0.13)[i], 3.1, 2.7),
         lambda i, t: damped(t - 0.07 * (2 - i), (-2.0, -2.6, -3.2)[i], 2.5, 2.1),
         lambda i, t: damped(t - 0.07 * (2 - i) - 0.08, (0.8, 1.1, 1.4)[i], 1.9, 2.1))
    clip("Land", 25, lambda i, t: damped(t - 0.03 * i, (0.11, 0.08, 0.06)[i], 3.4, 4.0),
         lambda i, t: damped(t - 0.03 * i, 0.9, 2.8, 4.0))
    rig.animation_data.action = bpy.data.actions["Rest"]


# ======================================================================================
# props (static; origin = base centre unless noted; the page clones nodes by name)
# ======================================================================================
PAL = dict(cream="FFF6E8", white="FFFDF7", butter="F7D774", honey="E9A955", caramel="B8661E", green="5E8F6E",
           sage="8DB89A", mint="A8DCC6", coral="E0785A", pink="F4A3A8", sky="9FD3F0", lav="C8B4E6",
           wood="D9A871", wood_dk="B98352", wood_lt="EBCB9C", brass="D7A94B", steel="C9CDD2", dark="3B3A3F",
           terracotta="E59A74", peach="F8C9A8", leaf="7DB36A", leaf_dk="5E9E4E", roof="E58B78", stone="D8D2C8")


def M_(key, rough=0.7, **kw):
    return mat(key, PAL.get(key, key), rough, **kw)


def group(name, objs, origin=(0, 0, 0)):
    o = join(objs, name)
    set_origin(o, origin)
    return o


def bake_scale(o, s):
    """Scale a prop and its child nodes in place (origin fixed), baked into the meshes.
    Hand props are chibi-sized: a real phone in a paw 0.1 wide would vanish."""
    s = (s, s, s) if isinstance(s, (int, float)) else s
    for ob in [o, *o.children_recursive]:
        if ob.type == "MESH":
            ob.data.transform(S(*s))
        if ob is not o:
            ob.location = Vector(ob.location[i] * s[i] for i in range(3))
    return o


def child(parent, o, pivot):
    """Keep `o` a separate node under `parent`, origin at `pivot` (world): the page rotates it there."""
    set_origin(o, pivot)
    o.parent = parent
    o.matrix_parent_inverse = parent.matrix_world.inverted()
    return o


def props_small():
    out = []
    steel = mat("steel", PAL["steel"], 0.28, metal=0.85)
    ceramic = mat("ceramic", PAL["white"], 0.22)
    syrup = mat("syrup", "C9782B", 0.12, coat=1.0)
    # fork: origin at the grip (handle middle); tines point +Y
    fk = [rbox("handle", (0.022, 0.13, 0.008), (0, -0.01, 0), 0.004, steel),
          rbox("neck", (0.03, 0.03, 0.007), (0, 0.065, 0.002), 0.003, steel)]
    for x in (-0.011, 0, 0.011):
        fk.append(tube(f"tine{x}", (x, 0.07, 0.003), (x, 0.13, 0.006), 0.0035, 0.003, 8, 8, 2.5, steel))
    out.append(group("prop_fork", fk))
    # phones: origin at the grip centre; screen faces -Y, camera on the back (+Y)
    # the cat's case is butter yellow: a lavender one vanished against her lavender cardigan
    for nm, case in (("prop_phone", "coral"), ("prop_phone_cat", "butter")):
        body = rbox(f"{nm}_case", (0.08, 0.013, 0.155), (0, 0, 0), 0.012, M_(case, 0.5))
        screen = rbox(f"{nm}_screen", (0.068, 0.002, 0.14), (0, -0.0066, 0), 0.008, tex_mat("screen", "phone-screen.png", 0.2))
        bpy_uv_front(screen, 0.068, 0.14)
        lens = cyl(f"{nm}_lens", 0.009, 0.004, (-0.022, 0.0065, 0.055), 0.002, M_("dark", 0.2), R("X", -90))
        flash = cyl(f"{nm}_flash", 0.004, 0.003, (-0.004, 0.0065, 0.058), 0.001, mat("flash", "FFF8E0", 0.3, emit=0.0),
                    R("X", -90))
        o = group(nm, [body, screen, lens])
        child(o, flash, (-0.004, 0.0075, 0.058)).name = f"{nm}_flash"
        out.append(o)
    # iced latte: glass, coffee, milk, ice, straw
    glass = lathe("glass", [(0, 0), (0.046, 0), (0.05, 0.004), (0.054, 0.16), (0.05, 0.162), (0.048, 0.006),
                            (0, 0.006)], mat("glass", "E8F4FA", 0.05, alpha=0.28), 32)
    coffee = lathe("coffee", rounded_cyl_prof(0.046, 0.075, 0.004, 0.006), M_("A86B45", 0.3), 28)
    milk = lathe("milk", rounded_cyl_prof(0.0475, 0.055, 0.004, 0.08), M_("EFDCC6", 0.35), 28)
    ice = [rbox(f"ice{k}", (0.03, 0.03, 0.028), (0.018 * math.cos(k * 2.1), 0.018 * math.sin(k * 2.1), 0.13 + 0.01 * k),
                0.006, mat("ice", "F4FBFF", 0.08, alpha=0.6), R("Z", 30 * k) @ R("X", 12 * k)) for k in range(3)]
    straw = tube("straw", (0.01, 0.0, 0.03), (0.03, 0.012, 0.22), 0.006, 0.006, 16, 10, 8, M_("pink", 0.5))
    out.append(group("prop_iced_latte", [glass, coffee, milk, *ice, straw]))
    # mug
    mug = lathe("mug", [(0, 0), (0.05, 0), (0.055, 0.008), (0.055, 0.1), (0.05, 0.104), (0.046, 0.1), (0.046, 0.012),
                        (0, 0.012)], M_("cream", 0.35), 32)
    band = torus("mugband", (0, 0, 0.07), 0.0555, 0.006, M_("coral", 0.4), mseg=8)
    handle = torus("mughandle", (0.062, 0, 0.055), 0.024, 0.007, M_("cream", 0.35), rot=R("X", 90))
    coffee2 = lathe("mugcoffee", [(0.046, 0.085), (0, 0.0851)], M_("8A5A3C", 0.2), 24)
    out.append(group("prop_mug", [mug, band, handle, coffee2]))
    # syrup pitcher: origin at the base; spout toward +X
    pit = lathe("pitcher", [(0, 0), (0.038, 0), (0.042, 0.006), (0.045, 0.05), (0.04, 0.078), (0.042, 0.09),
                            (0.038, 0.092), (0.035, 0.085), (0.035, 0.01), (0, 0.01)], ceramic, 32)
    spout = tube("spout", (0.03, 0, 0.082), (0.058, 0, 0.094), 0.012, 0.006, 10, 12, 2.5, ceramic)
    phandle = torus("phandle", (-0.05, 0, 0.05), 0.024, 0.0065, ceramic, rot=R("X", 90), scale=(1, 1, 1.3))
    psyrup = lathe("psyrup", [(0.035, 0.07), (0, 0.0701)], syrup, 24)
    out.append(group("prop_syrup_pitcher", [pit, spout, phandle, psyrup]))
    # syrup stream: unit length hanging down from its origin (scale Z in the page)
    out.append(group("prop_syrup_stream", [path_tube("stream", [(0, 0, 0), (0.004, 0, -0.35), (-0.003, 0, -0.7),
                                                                 (0, 0, -1.0)], [0.011, 0.009, 0.008, 0.01], syrup, 12, 5)]))
    # cloche (mint enamel dome, wooden knob): origin at the rim centre
    dome = lathe("dome", [(0.155, 0), (0.16, 0.004), (0.158, 0.03)] + arc_prof(0, 0.03, 0.158, 0, 90, 10)[1:],
                 M_("mint", 0.3), 40)
    dome_in = lathe("dome_in", list(reversed([(0.15, 0.002)] + arc_prof(0, 0.03, 0.15, 0, 88, 8)[1:])),
                    M_("mint", 0.3), 40)
    knob = ellipsoid("knob", (0, 0, 0.2), (0.03, 0.03, 0.024), M_("wood", 0.5), 16, 8)
    stem = cyl("stem", 0.012, 0.02, (0, 0, 0.183), 0.003, M_("wood", 0.5))
    out.append(group("prop_cloche", [dome, dome_in, knob, stem]))
    # ring mold and a raw soufflé pancake for the griddle (same surface texture as the hero)
    out.append(group("prop_ring_mold", [lathe("ring", [(0.078, 0), (0.08, 0), (0.08, 0.07), (0.078, 0.07),
                                                        (0.078, 0.0)], steel, 40)]))
    pts, vs = layer_profile(0.074, 0.075, 0.022)
    out.append(group("prop_pancake_raw", [lathe("rawpan", pts, tex_mat("pancake", "pancake-layer.png", 0.62), 40, vs)]))
    # griddle: origin at the base centre; top surface at z 0.045
    gr = [rbox("plate", (0.8, 0.42, 0.035), (0, 0, 0.01), 0.012, M_("5A5A63", 0.45), base=True),
          rbox("lip", (0.82, 0.44, 0.012), (0, 0, 0.0), 0.005, M_("5A5A63", 0.45), base=True)]
    for s in (1, -1):
        gr.append(rbox(f"gh{s}", (0.1, 0.07, 0.025), (0.45 * s, 0, 0.012), 0.012, M_("wood", 0.5), base=True))
    out.append(group("prop_griddle", gr))
    # mixing bowl with batter, whisk
    bowl = lathe("bowl", [(0, 0), (0.07, 0), (0.075, 0.006), (0.16, 0.1), (0.165, 0.115), (0.158, 0.118),
                          (0.15, 0.108), (0.068, 0.014), (0, 0.014)], M_("cream", 0.3), 40)
    stripe = torus("bowlstripe", (0, 0, 0.09), 0.148, 0.005, M_("coral", 0.4), mseg=6)
    batter = lathe("batter", [(0, 0.075), (0.128, 0.075), (0.13, 0.078), (0, 0.082)], M_("F8E6A8", 0.2, coat=0.4), 32)
    out.append(group("prop_mixing_bowl", [bowl, stripe, batter]))
    wh = [cyl("whandle", 0.012, 0.12, (0, 0, 0), 0.006, M_("wood", 0.5))]
    for k in range(5):
        wh.append(torus(f"wire{k}", (0, 0, 0.19), 0.035, 0.0025, steel, rot=R("Z", 36 * k) @ R("X", 90),
                        scale=(1, 2.0, 1), seg=24, mseg=5))
    out.append(group("prop_whisk", wh))
    # egg carton, six eggs
    ec = [rbox("tray", (0.3, 0.2, 0.05), (0, 0, 0), 0.015, M_("DCCFB8", 0.9), base=True)]
    for i in range(3):
        for j in range(2):
            ec.append(ellipsoid(f"egg{i}{j}", (-0.095 + 0.095 * i, -0.048 + 0.096 * j, 0.075), (0.034, 0.034, 0.044),
                                M_("F7EEE0", 0.6), 16, 10))
    out.append(group("prop_egg_carton", ec))
    # pet water bowl
    wb = lathe("wbowl", [(0, 0), (0.12, 0), (0.13, 0.01), (0.12, 0.055), (0.11, 0.058), (0.1, 0.05), (0.09, 0.012),
                         (0, 0.012)], M_("sky", 0.35), 40)
    water = lathe("water", [(0.098, 0.038), (0, 0.0381)], mat("water", "BFE6F7", 0.05, alpha=0.8), 32)
    paw = [ellipsoid(f"pawdot{k}", (0.118 * math.cos(a), 0.118 * math.sin(a), 0.035), (0.012, 0.012, 0.012),
                     M_("cream", 0.5), 8, 5) for k, a in enumerate((-2.2, -1.9, -1.6, -1.3))]
    out.append(group("prop_water_bowl", [wb, water, *paw]))
    # alarm clock (twin bells), face toward -Y; hands are nodes
    body = lathe("acbody", rounded_cyl_prof(0.09, 0.05, 0.012), M_("coral", 0.45), 36, M=T((0, 0.025, 0.13)) @ R("X", 90))
    face = lathe("acface", [(0.078, 0), (0, 0.0005)], tex_mat("clock", "clock-face.png", 0.5), 36,
                 M=T((0, -0.026, 0.13)) @ R("X", 90))
    uv_disc(face, (0, -0.026, 0.13), 0.078, "xz")
    bells = [ellipsoid(f"bell{s}", (0.062 * s, 0, 0.225), (0.042, 0.042, 0.03), M_("brass", 0.3, metal=0.8), 20, 10,
                       R("Y", 32 * s)) for s in (1, -1)]
    legs = [ellipsoid(f"acleg{s}", (0.05 * s, 0, 0.035), (0.014, 0.014, 0.03), M_("brass", 0.3, metal=0.8), 10, 6)
            for s in (1, -1)]
    hammer = cyl("hammer", 0.006, 0.05, (0, 0, 0.215), 0.002, M_("brass", 0.3, metal=0.8))
    ac = group("prop_alarm_clock", [body, face, *bells, *legs, hammer])
    add_hands(ac, (0, -0.029, 0.13), 0.045, 0.062, "xz", 7, 0)
    out.append(ac)
    # wall clock: origin at the back centre, face toward -Y; hands are nodes set to ~7:00
    wc = [lathe("wcrim", rounded_cyl_prof(0.22, 0.05, 0.016), M_("wood", 0.5), 48, M=T((0, 0.05, 0)) @ R("X", 90)),
          lathe("wcface", [(0.19, 0), (0, 0.0005)], tex_mat("clock", "clock-face.png", 0.5), 48,
                M=T((0, -0.002, 0)) @ R("X", 90))]
    uv_disc(wc[1], (0, -0.002, 0), 0.19, "xz")
    wco = group("prop_wall_clock", wc)
    add_hands(wco, (0, -0.006, 0), 0.1, 0.15, "xz", 7, 0)
    out.append(wco)
    for o in out:
        bake_scale(o, HAND_SCALE.get(o.name, 1.0))
    return out


# things held in a paw or set before a big-headed character are drawn larger than life
HAND_SCALE = {"prop_fork": 1.6, "prop_phone": 1.8, "prop_phone_cat": 1.8, "prop_iced_latte": 1.5, "prop_mug": 1.4,
              "prop_syrup_pitcher": 1.3}
FURNITURE_SCALE = {"prop_cafe_table": (1.35, 1.35, 1.15), "prop_chair_mint": 1.2, "prop_chair_pink": 1.2,
                   "prop_parasol": 1.35}


def bpy_uv_front(o, w, h):
    """Front-projected UVs (x, z) for a flat part facing -Y."""
    me = o.data
    uvl = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = ((v.x + w / 2) / w, (v.z + h / 2) / h)


def uv_disc(o, c, r, plane):
    me = o.data
    uvl = me.uv_layers.new(name="UVMap")
    c = Vector(c)
    for poly in me.polygons:
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co - c
            a, b = (v.x, v.z) if plane == "xz" else (v.x, v.y)
            uvl.data[li].uv = ((a / r + 1) / 2, (b / r + 1) / 2)


def add_hands(parent, centre, lh, lm, plane, hour, minute):
    """Clock hands as separate nodes rotating about the face normal (-Y): hand_h, hand_m."""
    dark = mat("hands", "5A4034", 0.5)
    for nm, ln, wd, ang in (("hand_h", lh, 0.012, (hour % 12) * 30 + minute * 0.5), ("hand_m", lm, 0.008, minute * 6)):
        h = rbox(f"{parent.name}_{nm}", (wd, 0.004, ln), (0, 0, ln / 2 - wd), wd * 0.45, dark)
        h.data.transform(R("Y", ang))
        h.data.transform(T(centre))
        child(parent, h, centre).name = f"{parent.name}_{nm}"


def flower_bunch(name, petal, leaf, leaf_dk, seed, n=7):
    """A leafy mound with n round five-petal flowers on thin stems, heads tilted outward. ~0.45 m tall."""
    rnd = random.Random(seed)
    stem, eye = M_("leaf_dk", 0.8), M_("cream", 0.5)
    parts = [ellipsoid(f"mound{k}", (0.1 * math.cos(a), 0.1 * math.sin(a), 0.07), (0.13, 0.075, 0.07),
                       leaf if k % 2 else leaf_dk, 16, 8, R("Z", math.degrees(a)))
             for k, a in enumerate(math.radians(45 + 90 * k) for k in range(4))]
    for i in range(n):
        a = 2 * math.pi * i / n + rnd.uniform(-0.3, 0.3)
        d = 0.0 if i == 0 else rnd.uniform(0.08, 0.16)
        top = Vector((d * math.cos(a), d * math.sin(a), 0.42 if i == 0 else rnd.uniform(0.24, 0.36)))
        parts.append(path_tube(f"stem{i}", [(top.x * 0.3, top.y * 0.3, 0.04), (top.x * 0.8, top.y * 0.8, top.z * 0.6),
                                           tuple(top)], [0.011, 0.01, 0.009], stem, 8, 4))
        head = [ellipsoid(f"petal{i}_{k}", (0.036 * math.cos(b), 0.036 * math.sin(b), 0.0), (0.04, 0.028, 0.014),
                          petal, 12, 6, R("Z", math.degrees(b)))
                for k, b in enumerate(math.radians(72 * k + 18 * i) for k in range(5))]
        head.append(ellipsoid(f"eye{i}", (0, 0, 0.008), (0.022, 0.022, 0.016), eye, 12, 6))
        h = join(head, f"head{i}")
        tilt = R("Z", math.degrees(a)) @ R("Y", 0 if i == 0 else 38) @ R("Z", -math.degrees(a))
        h.data.transform(T(top) @ tilt)
        parts.append(h)
    return group(name, parts)


BED_R = 1.2                                  # round bed frame radius; no headboard (her nightcap tip hangs past it)
BED_TOP = 0.46                               # mattress top: frame base 0.26 + mattress 0.18 + dome 0.02
PILLOW = (1.5, 0.46, 0.16, 0.55)             # width, depth, height, centre y (wider than her head: its ends show)
SLEEP_SPOT = (0.0, -0.72, BED_TOP + 0.34)    # the bear's origin on her back, head sunk into the pillow
QUILT_W, QUILT_L, QUILT_Y0 = 1.9, 1.35, -1.29  # tucked to her chin: y from QUILT_Y0 to QUILT_Y0 + QUILT_L
QUILT_PULL = 0.62                            # the "up" morph slides it headward: over her eyes, toe tips out


def bed_with_sleeper(wood):
    """Round bed with pillow, patchwork quilt and a sleep_spot node. The quilt is draped over the real
    posed bear (Sleep for the basis, SleepSnuggle for the "up" morph), so it covers her instead of cutting her."""
    bed = group("prop_bed", [lathe("bframe", rounded_cyl_prof(BED_R, 0.3, 0.09, 0.0), wood, 56),
                             lathe("mattress", rounded_cyl_prof(BED_R - 0.08, 0.18, 0.08, 0.26, dome=0.02),
                                   M_("white", 0.7), 56)])
    pw, pd, ph, py = PILLOW
    pillow = rbox("prop_bed_pillow", (pw, pd, ph), (0, py, BED_TOP - 0.02), 0.07, M_("sky", 0.8), base=True)
    child(bed, pillow, (0, py, BED_TOP)).name = "prop_bed_pillow"
    exhale, inhale, snug = sleeper_points([("Sleep", 1), ("Sleep", 46), ("SleepSnuggle", 21)])
    q = quilt_mesh("prop_bed_quilt", drape_field(exhale + inhale), drape_field(snug),
                   tex_mat("quilt", "quilt.png", 0.9))
    q.parent = bed
    spot = bpy.data.objects.new("sleep_spot", None)
    scene.collection.objects.link(spot)
    spot.matrix_world = T(SLEEP_SPOT) @ R("X", -90)
    spot.parent = bed
    return bed


def sleeper_points(poses):
    """World vertices of the bear lying at SLEEP_SPOT, one list per (clip, frame). Built, sampled, removed:
    props-set exports no character."""
    before = set(bpy.data.actions.keys())
    rig, _faces, _sep = build_biped("bear", CHARS["bear"])
    rig.matrix_world = T(SLEEP_SPOT) @ R("X", -90)
    meshes = [o for o in rig.children if o.type == "MESH" and not o.name.startswith(("face_", "acc_"))]
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    for clip, frame in poses:
        rig.animation_data.action = bpy.data.actions[clip]
        scene.frame_set(frame)
        dg.update()
        pts = []
        for o in meshes:
            ev = o.evaluated_get(dg)
            me = ev.to_mesh()
            pts += [ev.matrix_world @ v.co for v in me.vertices]
            ev.to_mesh_clear()
        out.append(pts)
    for o in [*rig.children_recursive, rig]:
        bpy.data.objects.remove(o, do_unlink=True)
    for k in set(bpy.data.actions.keys()) - before:
        bpy.data.actions.remove(bpy.data.actions[k])
    return out


def bed_surface(X, Y):
    """What the quilt lies on where she is not: domed mattress, pillow, then over the frame rim and down."""
    import numpy as np
    r = np.hypot(X, Y)
    z = BED_TOP - 0.02 * (r / BED_R) ** 2
    pw, pd, ph, py = PILLOW
    z = np.where((np.abs(X) < pw / 2) & (np.abs(Y - py) < pd / 2), BED_TOP + ph, z)
    z = z - np.clip(r - (BED_R - 0.08), 0, 0.1) - np.clip(r - (BED_R + 0.02), 0, None) * 3.0
    return np.maximum(z, 0.03)


def drape_field(pts, lo=-1.6, hi=1.6, n=161, clear=0.05, slope=1.25):
    """Quilt height over the bed: highest body point per cell plus clearance, spread as a cone (cloth tents
    between high points instead of hugging them), box-smoothed, never below the body or the bed."""
    import numpy as np
    step = (hi - lo) / (n - 1)
    g = np.linspace(lo, hi, n)
    X, Y = np.meshgrid(g, g)
    H0 = bed_surface(X, Y)
    P = np.array([(p.x, p.y, p.z) for p in pts])
    ix = np.round((P[:, 0] - lo) / step).astype(int)
    iy = np.round((P[:, 1] - lo) / step).astype(int)
    ok = (ix >= 0) & (ix < n) & (iy >= 0) & (iy < n)
    np.maximum.at(H0, (iy[ok], ix[ok]), P[ok, 2] + clear)
    near = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
    H = H0.copy()
    for _ in range(int(1.0 / (slope * step)) + 1):
        pad = np.pad(H, 1, mode="edge")
        for dy, dx in near:
            H = np.maximum(H, pad[1 + dy:n + 1 + dy, 1 + dx:n + 1 + dx] - slope * step * math.hypot(dx, dy))
    for _ in range(4):
        pad = np.pad(H, 1, mode="edge")
        H = np.maximum(sum(pad[1 + dy:n + 1 + dy, 1 + dx:n + 1 + dx] for dy, dx in near) / 9.0, H0)

    def at(x, y):
        fx = min(max((x - lo) / step, 0.0), n - 1.001)
        fy = min(max((y - lo) / step, 0.0), n - 1.001)
        x0, y0 = int(fx), int(fy)
        tx, ty = fx - x0, fy - y0
        return float(H[y0, x0] * (1 - tx) * (1 - ty) + H[y0, x0 + 1] * tx * (1 - ty) +
                     H[y0 + 1, x0] * (1 - tx) * ty + H[y0 + 1, x0 + 1] * tx * ty)
    return at


def quilt_mesh(name, down, up, m, nx=49, ny=33, th=0.035):
    """Thick quilt sheet on the draped fields. Basis = tucked to the chin; shape key "up" = the same sheet
    slid QUILT_PULL headward and re-draped (three.js: morphTargetInfluences[0])."""
    def sheet(field, dy):
        top, bot = [], []
        for j in range(ny):
            for i in range(nx):
                x = -QUILT_W / 2 + QUILT_W * i / (nx - 1)
                y = QUILT_Y0 + dy + QUILT_L * j / (ny - 1)
                z = field(x, y)
                top.append((x, y, z))
                bot.append((x, y, z - th))
        return top + bot

    base, pulled = sheet(down, 0.0), sheet(up, QUILT_PULL)
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in base]
    bm.verts.ensure_lookup_table()
    uvl = bm.loops.layers.uv.new("UVMap")
    k = lambda i, j, layer=0: layer * nx * ny + j * nx + i
    uv = lambda i, j: (i / (nx - 1), j / (ny - 1))

    def face(ids, uvs):
        f = bm.faces.new([vs[a] for a in ids])
        for loop, t in zip(f.loops, uvs):
            loop[uvl].uv = t
    for j in range(ny - 1):
        for i in range(nx - 1):
            q = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
            face([k(a, b) for a, b in q], [uv(a, b) for a, b in q])
            face([k(a, b, 1) for a, b in reversed(q)], [uv(a, b) for a, b in reversed(q)])
    ring = ([(i, 0) for i in range(nx - 1)] + [(nx - 1, j) for j in range(ny - 1)] +
            [(i, ny - 1) for i in range(nx - 1, 0, -1)] + [(0, j) for j in range(ny - 1, 0, -1)])
    for (a, b), (c, d) in zip(ring, ring[1:] + ring[:1]):
        face([k(a, b), k(a, b, 1), k(c, d, 1), k(c, d)], [uv(a, b)] * 4)
    o = link(name, bm, m)
    o.shape_key_add(name="Basis", from_mix=False)
    key = o.shape_key_add(name="up", from_mix=False)
    for idx, p in enumerate(pulled):
        key.data[idx].co = p
    return o


def props_set():
    out = []
    wood, wood_dk, wood_lt = M_("wood", 0.6), M_("wood_dk", 0.6), M_("wood_lt", 0.55)
    cream, white = M_("cream", 0.55), M_("white", 0.5)
    # counter (top at 0.55 so the chibi arms reach it): origin at the floor centre, front face -Y
    ctr = [rbox("ctop", (2.4, 0.72, 0.07), (0, 0, 0.48), 0.025, wood_lt, base=True),
           rbox("cbody", (2.3, 0.62, 0.48), (0, 0.02, 0.0), 0.02, M_("sage", 0.6), base=True),
           rbox("ckick", (2.26, 0.6, 0.06), (0, 0.0, 0.0), 0.01, wood_dk, base=True)]
    for i in range(6):
        x = -0.95 + 0.38 * i
        ctr.append(rbox(f"cpanel{i}", (0.3, 0.02, 0.3), (x, -0.3, 0.1), 0.012, M_("9DC6A8", 0.6), base=True))
    out.append(group("prop_counter", ctr))
    # espresso machine (retro, mint and cream)
    em = [rbox("embody", (0.5, 0.36, 0.42), (0, 0, 0), 0.07, M_("mint", 0.4), base=True),
          rbox("emtop", (0.46, 0.32, 0.05), (0, 0, 0.42), 0.02, cream, base=True),
          rbox("emtray", (0.36, 0.2, 0.03), (0, -0.2, 0.0), 0.012, mat("steel", PAL["steel"], 0.28, metal=0.85), base=True),
          cyl("emhead", 0.06, 0.06, (0, -0.2, 0.2), 0.01, mat("steel", PAL["steel"], 0.28, metal=0.85)),
          rbox("emhandle", (0.04, 0.16, 0.035), (0, -0.33, 0.19), 0.015, wood, base=True),
          tube("emwand", (0.19, -0.18, 0.3), (0.22, -0.22, 0.12), 0.012, 0.01, 10, 10, 6,
               mat("steel", PAL["steel"], 0.28, metal=0.85))]
    for s, col in ((1, "coral"), (-1, "butter")):
        em.append(cyl(f"emdial{s}", 0.035, 0.03, (0.14 * s, -0.19, 0.32), 0.008, M_(col, 0.4), R("X", 90)))
    out.append(group("prop_espresso_machine", em))
    # mug rack: rail with hanging mugs; origin at the rail centre
    rk = [cyl("rail", 0.018, 0.9, (0, 0, 0), 0.006, wood, R("Y", 90), base=False)]
    for k, col in enumerate(("coral", "sky", "butter", "pink")):
        x = -0.3 + 0.2 * k
        rk.append(torus(f"hook{k}", (x, 0, -0.03), 0.02, 0.004, mat("brass", PAL["brass"], 0.3, metal=0.8),
                        rot=R("X", 90), seg=16, mseg=5))
        m = lathe(f"hmug{k}", [(0, 0), (0.045, 0), (0.05, 0.008), (0.05, 0.09), (0.045, 0.094), (0.041, 0.09),
                               (0.041, 0.012), (0, 0.012)], M_(col, 0.35), 24, M=T((x, 0, -0.16)))
        hd = torus(f"hmh{k}", (x, 0, -0.08), 0.022, 0.006, M_(col, 0.35), rot=R("X", 90), seg=16, mseg=6)
        rk += [m, hd]
    out.append(group("prop_mug_rack", rk))
    # kitchen window: origin at the sill centre bottom; glass pane is its own node (tint it for dawn)
    win = [rbox("wframe_l", (0.08, 0.12, 1.0), (-0.46, 0, 0), 0.02, cream, base=True),
           rbox("wframe_r", (0.08, 0.12, 1.0), (0.46, 0, 0), 0.02, cream, base=True),
           rbox("wframe_t", (1.0, 0.12, 0.08), (0, 0, 0.96), 0.02, cream, base=True),
           rbox("wsill", (1.1, 0.2, 0.06), (0, -0.04, -0.02), 0.02, wood_lt, base=True),
           rbox("wmul_v", (0.04, 0.06, 0.92), (0, 0, 0.04), 0.01, cream, base=True),
           rbox("wmul_h", (0.88, 0.06, 0.04), (0, 0, 0.5), 0.01, cream, base=True)]
    wo = group("prop_window", win)
    pane = rbox("prop_window_glass", (0.86, 0.01, 0.9), (0, 0.02, 0.05), 0.0, mat("pane", "DDF1FA", 0.05, alpha=0.35),
                base=True)
    child(wo, pane, (0, 0.02, 0.05)).name = "prop_window_glass"
    out.append(wo)
    # café table (top at 0.72) and chairs (seat top at 0.34)
    out.append(group("prop_cafe_table", [
        lathe("ttop", rounded_cyl_prof(0.42, 0.045, 0.018, 0.68), M_("white", 0.4), 48),
        cyl("tpost", 0.035, 0.66, (0, 0, 0.02), 0.01, wood_dk),
        lathe("tbase", rounded_cyl_prof(0.2, 0.03, 0.012, 0.0, dome=0.02), wood_dk, 32)]))
    for nm, col in (("prop_chair_mint", "mint"), ("prop_chair_pink", "pink")):
        seat_m = M_(col, 0.55)
        ch = [lathe("seat", rounded_cyl_prof(0.2, 0.05, 0.022, 0.29, dome=0.01), seat_m, 32)]
        for k in range(4):
            a = math.radians(45 + 90 * k)
            ch.append(tube(f"leg{k}", (0.12 * math.cos(a), 0.12 * math.sin(a), 0.3),
                           (0.15 * math.cos(a), 0.15 * math.sin(a), 0.0), 0.018, 0.016, 10, 10, 4, wood_dk))
        ch.append(rbox("back", (0.34, 0.06, 0.26), (0, 0.19, 0.5), 0.03, seat_m, R("X", -8), base=True))
        for s in (1, -1):
            ch.append(tube(f"bpost{s}", (0.13 * s, 0.17, 0.32), (0.13 * s, 0.2, 0.55), 0.014, 0.014, 10, 8, 4, wood_dk))
        out.append(group(nm, ch))
    # parasol: canopy panels coral / cream; origin at the pole base; canopy ~2.1 up, radius 1.05
    can = lathe("canopy", [(0, 2.32), (0.35, 2.26), (0.75, 2.12), (1.06, 2.02), (1.05, 2.04), (0.75, 2.16),
                           (0.35, 2.3), (0, 2.36)], tex_mat("parasol", "parasol.png", 0.7), 48,
                [0, 0.3, 0.6, 1, 1, 0.6, 0.3, 0])
    scal = [ellipsoid(f"scal{k}", (1.03 * math.cos(a), 1.03 * math.sin(a), 2.0), (0.14, 0.05, 0.06),
                      M_("pink" if k % 2 == 0 else "cream", 0.7), 12, 6, R("Z", math.degrees(a) + 90))
            for k, a in enumerate(2 * math.pi * (k + 0.5) / 8 for k in range(8))]
    out.append(group("prop_parasol", [can, *scal, cyl("pole", 0.03, 2.38, (0, 0, 0), 0.01, M_("white", 0.5)),
                                      ellipsoid("finial", (0, 0, 2.4), (0.05, 0.05, 0.06), wood, 12, 6),
                                      lathe("pbase", rounded_cyl_prof(0.26, 0.08, 0.03), M_("E8E2D6", 0.8), 32)]))
    # planters and pots with round shrubs (the CC0 flowers/bushes can replace the shrubs)
    leaf, leaf_dk = M_("leaf", 0.8), M_("leaf_dk", 0.8)
    pl = [rbox("pbox", (0.9, 0.36, 0.34), (0, 0, 0), 0.04, wood, base=True),
          rbox("psoil", (0.82, 0.3, 0.02), (0, 0, 0.33), 0.005, M_("8A6A4E", 0.95), base=True)]
    for k in range(5):
        x = -0.34 + 0.17 * k
        pl.append(ellipsoid(f"shrub{k}", (x, 0, 0.44 + 0.03 * (k % 2)), (0.14, 0.14, 0.13), leaf if k % 2 else leaf_dk, 16, 8))
        pl.append(ellipsoid(f"fl{k}", (x + 0.04, -0.1, 0.52 + 0.02 * (k % 3)), (0.035, 0.035, 0.03),
                            M_(("pink", "butter", "cream", "coral", "lav")[k], 0.6), 10, 6))
    out.append(group("prop_planter", pl))
    out.append(group("prop_pot_topiary", [
        lathe("pot", [(0, 0), (0.14, 0), (0.15, 0.01), (0.18, 0.26), (0.19, 0.27), (0.18, 0.28), (0.16, 0.27),
                      (0, 0.27)], M_("terracotta", 0.8), 32),
        cyl("trunk", 0.025, 0.3, (0, 0, 0.25), 0.008, wood_dk),
        ellipsoid("ball", (0, 0, 0.7), (0.26, 0.26, 0.25), leaf, 24, 12),
        ellipsoid("ball2", (0.1, -0.12, 0.78), (0.13, 0.12, 0.12), leaf_dk, 16, 8)]))
    # round flower bunches (the CC0 flower cards read flat and spiky beside the cast; these replace them)
    for key, seed in (("pink", 3), ("butter", 5), ("lav", 8)):
        out.append(flower_bunch(f"prop_flowers_{key}", M_(key, 0.6), leaf, leaf_dk, seed))
    # string lights: 4 m along +X, sagging; bulbs are warm emissive
    wire_pts =[(x, 0, -0.35 * (1 - ((x - 2) / 2) ** 2)) for x in (0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4)]
    sl = [path_tube("wire", wire_pts, [0.006] * len(wire_pts), M_("4A4340", 0.6), 6, 4)]
    for k in range(12):
        x = (k + 0.5) * 4 / 12
        zz = -0.35 * (1 - ((x - 2) / 2) ** 2)
        sl.append(ellipsoid(f"bulb{k}", (x, 0, zz - 0.05), (0.032, 0.032, 0.042), mat("bulb", "FFE7A8", 0.3, emit=2.5),
                            12, 8))
        sl.append(cyl(f"sock{k}", 0.014, 0.025, (x, 0, zz - 0.02), 0.0, M_("4A4340", 0.6), verts=10))
    out.append(group("prop_string_lights", sl))
    # white picket fence segment (1.2 wide) and a rounded hedge block
    fe = [rbox("rail1", (1.2, 0.04, 0.05), (0, 0, 0.14), 0.015, white, base=True),
          rbox("rail2", (1.2, 0.04, 0.05), (0, 0, 0.38), 0.015, white, base=True)]
    for k in range(6):
        x = -0.5 + 0.2 * k
        fe.append(rbox(f"picket{k}", (0.1, 0.035, 0.5), (x, -0.03, 0), 0.02, white, base=True))
        fe.append(ellipsoid(f"ptop{k}", (x, -0.03, 0.5), (0.05, 0.0175, 0.045), white, 12, 6))
    out.append(group("prop_fence", fe))
    hg = []
    for i in range(4):
        for j in range(2):
            hg.append(ellipsoid(f"hb{i}{j}", (-0.45 + 0.3 * i, 0.0, 0.28 + 0.2 * j), (0.26, 0.24, 0.24 - 0.04 * j),
                                leaf if (i + j) % 2 else leaf_dk, 16, 8))
    out.append(group("prop_hedge", hg))
    # deck tile (2 x 2 m of planks)
    dk = [rbox(f"plank{k}", (0.24, 2.0, 0.06), (-0.875 + 0.25 * k, 0, 0), 0.012,
               M_(("wood", "wood_lt", "wood")[k % 3], 0.7), base=True) for k in range(8)]
    out.append(group("prop_deck_tile", dk))
    out.append(bed_with_sleeper(wood))
    # bedroom window with curtains; origin at the sill centre bottom
    cw = [rbox("cwf_l", (0.08, 0.1, 1.1), (-0.5, 0, 0), 0.02, cream, base=True),
          rbox("cwf_r", (0.08, 0.1, 1.1), (0.5, 0, 0), 0.02, cream, base=True),
          rbox("cwf_t", (1.08, 0.1, 0.08), (0, 0, 1.06), 0.02, cream, base=True),
          rbox("cwsill", (1.2, 0.18, 0.06), (0, -0.04, -0.02), 0.02, cream, base=True),
          rbox("cwglow", (0.92, 0.01, 1.0), (0, 0.03, 0.04), 0.0, mat("glow", "FFE9C4", 0.5, emit=1.2), base=True),
          cyl("crod", 0.015, 1.5, (0, -0.08, 1.2), 0.005, wood, R("Y", 90), base=False)]
    for s in (1, -1):
        for k in range(3):
            cw.append(ellipsoid(f"fold{s}{k}", (0.5 * s + 0.1 * k * s - 0.1 * s, -0.09, 0.62), (0.07, 0.05, 0.6),
                                M_("pink", 0.9), 12, 10))
    out.append(group("prop_curtain_window", cw))
    # door: frame + leaf (hinge node) + brass bell (swing node) + blank hanging board (node)
    dframe = [rbox("dfl", (0.1, 0.16, 2.3), (-0.6, 0, 0), 0.03, cream, base=True),
              rbox("dfr", (0.1, 0.16, 2.3), (0.6, 0, 0), 0.03, cream, base=True),
              rbox("dft", (1.3, 0.16, 0.12), (0, 0, 2.24), 0.03, cream, base=True)]
    door = group("prop_door", dframe)
    leaf = [rbox("leaf", (1.08, 0.07, 2.2), (0, 0, 0.02), 0.035, M_("6FA388", 0.55), base=True),
            lathe("porthole", rounded_cyl_prof(0.2, 0.04, 0.015), cream, 40, M=T((0, -0.03, 1.5)) @ R("X", 90)),
            lathe("porthole_glass", [(0.16, 0), (0, 0.0005)], mat("pane", "DDF1FA", 0.05, alpha=0.35), 32,
                  M=T((0, -0.05, 1.5)) @ R("X", 90)),
            ellipsoid("knobd", (0.42, -0.08, 1.02), (0.04, 0.04, 0.04), mat("brass", PAL["brass"], 0.3, metal=0.8), 16, 8)]
    for k, z in enumerate((0.4, 0.8)):
        leaf.append(rbox(f"lpanel{k}", (0.8, 0.02, 0.3), (0, -0.04, z), 0.02, M_("7DBD97", 0.55), base=True))
    lf = join(leaf, "prop_door_leaf")
    child(door, lf, (-0.54, 0, 0)).name = "prop_door_leaf"
    board = group("prop_door_board", [rbox("brd", (0.42, 0.03, 0.26), (0, -0.1, 0.86), 0.03, M_("wood_lt", 0.6), base=True),
                                      tube("rope1", (-0.14, -0.1, 1.12), (0, -0.1, 1.22), 0.006, 0.006, 8, 6, 6, M_("8A6A4E", 0.9)),
                                      tube("rope2", (0.14, -0.1, 1.12), (0, -0.1, 1.22), 0.006, 0.006, 8, 6, 6, M_("8A6A4E", 0.9))])
    child(lf, board, (0, -0.1, 1.22)).name = "prop_door_board"
    bell = group("prop_door_bell", [
        lathe("bellbody", [(0, 0), (0.07, 0.0), (0.075, 0.01), (0.05, 0.06), (0.03, 0.11), (0, 0.12)],
              mat("brass", PAL["brass"], 0.3, metal=0.8), 24, M=T((0.4, -0.2, 2.02))),
        ellipsoid("clapper", (0.4, -0.2, 2.005), (0.018, 0.018, 0.018), mat("brass", PAL["brass"], 0.3, metal=0.8), 8, 5),
        path_tube("bracket", [(0.4, -0.02, 2.2), (0.4, -0.12, 2.24), (0.4, -0.2, 2.2), (0.4, -0.2, 2.14)],
                  [0.012] * 4, M_("4A4340", 0.5), 8, 4)])
    child(door, bell, (0.4, -0.2, 2.2)).name = "prop_door_bell"
    out.append(door)
    for o in out:
        bake_scale(o, FURNITURE_SCALE.get(o.name, 1.0))
    return out


def uv_top(o, w, d, c):
    me = o.data
    uvl = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = ((v.x - c[0] + w / 2) / w, (v.y - c[1] + d / 2) / d)


def house(name, size, wall, roof, trim="FFF6E8", door_col="6FA388", seed=0):
    """Small rounded house: walls, pitched roof with soft eaves, windows, door (front = -Y)."""
    w, d, h = size
    parts = [rbox("walls", (w, d, h), (0, 0, 0), 0.06, M_(wall, 0.8), base=True)]
    rh = 0.55 * w / 2
    for s in (1, -1):
        parts.append(rbox(f"roof{s}", (w / 2 * 1.2, d + 0.3, 0.12), (s * w / 4, 0, h + rh / 2 - 0.02), 0.05,
                          M_(roof, 0.7), R("Y", s * math.degrees(math.atan2(rh, w / 2))), base=False))
    parts.append(rbox("ridge", (0.16, d + 0.32, 0.12), (0, 0, h + rh + 0.02), 0.05, M_(roof, 0.7), base=False))
    gable = bmesh.new()
    for yy in (-d / 2 - 0.001, d / 2 + 0.001):
        vs = [gable.verts.new(p) for p in ((-w / 2, yy, h), (w / 2, yy, h), (0, yy, h + rh))]
        gable.faces.new(vs if yy < 0 else vs[::-1])
    parts.append(link("gable", gable, M_(wall, 0.8), False))
    for k, x in enumerate((-w / 4, w / 4)):
        if k == 0 or w > 1.6:
            parts.append(rbox(f"win{k}", (0.42, 0.06, 0.46), (x, -d / 2, h * 0.52), 0.05, M_(trim, 0.6), base=True))
            parts.append(rbox(f"glass{k}", (0.32, 0.02, 0.36), (x, -d / 2 - 0.025, h * 0.52 + 0.05), 0.02,
                              M_("BFE0EE", 0.2), base=True))
    parts.append(rbox("door", (0.42, 0.06, 0.8), (w / 4 if w <= 1.6 else 0, -d / 2, 0), 0.06, M_(door_col, 0.6), base=True))
    return group(name, parts)


def props_town():
    out = []
    cream, wood = M_("cream", 0.7), M_("wood", 0.6)
    # the shop: building + facade; door parts and sign are nodes. Origin at the door threshold.
    W, D, H = 3.4, 3.0, 2.9
    shop = [rbox("swalls", (W, D, H), (0, D / 2, 0), 0.08, M_("FFF1DC", 0.85), base=True),
            rbox("sbase", (W + 0.06, D + 0.06, 0.35), (0, D / 2, 0), 0.05, M_("D8C3A5", 0.85), base=True)]
    rh = 0.9
    for s in (1, -1):
        shop.append(rbox(f"sroof{s}", (W / 2 * 1.22, D + 0.4, 0.16), (s * W / 4, D / 2, H + rh / 2 - 0.02), 0.06,
                         M_("roof", 0.7), R("Y", s * math.degrees(math.atan2(rh, W / 2))), base=False))
    shop.append(rbox("sridge", (0.2, D + 0.42, 0.16), (0, D / 2, H + rh + 0.02), 0.06, M_("roof", 0.7), base=False))
    g = bmesh.new()
    for yy in (-0.001, D + 0.001):
        vs = [g.verts.new(p) for p in ((-W / 2, yy, H), (W / 2, yy, H), (0, yy, H + rh))]
        g.faces.new(vs if yy < 0.5 else vs[::-1])
    shop.append(link("sgable", g, M_("FFF1DC", 0.85), False))
    shop.append(ellipsoid("gable_window", (0, -0.02, H + 0.35), (0.22, 0.03, 0.22), M_("BFE0EE", 0.2), 20, 8))
    shop.append(torus("gable_wf", (0, -0.03, H + 0.35), 0.22, 0.03, cream, rot=R("X", 90), seg=32, mseg=8))
    # big window left of the door
    wx = -1.05
    shop += [rbox("bwin", (1.1, 0.1, 1.2), (wx, -0.02, 0.75), 0.04, cream, base=True),
             rbox("bwglass", (0.96, 0.02, 1.06), (wx, -0.07, 0.82), 0.02, M_("CBE7F2", 0.15), base=True),
             rbox("bwmul", (0.04, 0.03, 1.06), (wx, -0.08, 0.82), 0.01, cream, base=True),
             rbox("fbox", (1.15, 0.3, 0.22), (wx, -0.2, 0.5), 0.04, wood, base=True)]
    for k in range(6):
        x = wx - 0.45 + 0.18 * k
        shop.append(ellipsoid(f"fbg{k}", (x, -0.2, 0.78), (0.11, 0.11, 0.1), M_("leaf" if k % 2 else "leaf_dk", 0.8), 12, 6))
        shop.append(ellipsoid(f"fbf{k}", (x + 0.03, -0.3, 0.84 + 0.02 * (k % 2)), (0.04, 0.04, 0.035),
                              M_(("pink", "butter", "coral", "cream", "lav", "pink")[k], 0.6), 10, 6))
    # awning over window and door: striped, scalloped edge above the door head
    shop.append(awning_mesh("awning", 3.0, 0.9, (-0.35, -0.02, 2.78)))
    shopo = group("prop_shop", shop)
    # door leaf, board, bell as in prop_door, set into the facade at x 0.75
    dx = 0.75
    frame = [rbox("sdfl", (0.1, 0.16, 2.1), (dx - 0.55, -0.02, 0), 0.03, cream, base=True),
             rbox("sdfr", (0.1, 0.16, 2.1), (dx + 0.55, -0.02, 0), 0.03, cream, base=True),
             rbox("sdft", (1.2, 0.16, 0.12), (dx, -0.02, 2.04), 0.03, cream, base=True)]
    fr = join(frame, "sdframe")
    fr.parent = shopo
    leaf = [rbox("sleaf", (0.98, 0.07, 2.02), (0, 0, 0.02), 0.035, M_("6FA388", 0.55), base=True),
            lathe("sport", rounded_cyl_prof(0.18, 0.04, 0.015), cream, 40, M=T((0, -0.03, 1.4)) @ R("X", 90)),
            lathe("sportg", [(0.14, 0), (0, 0.0005)], mat("pane", "DDF1FA", 0.05, alpha=0.35), 32,
                  M=T((0, -0.05, 1.4)) @ R("X", 90)),
            ellipsoid("sknob", (0.38, -0.08, 0.95), (0.04, 0.04, 0.04), mat("brass", PAL["brass"], 0.3, metal=0.8), 16, 8)]
    lf = join(leaf, "shop_door_leaf")
    lf.data.transform(T((dx, -0.03, 0)))
    child(shopo, lf, (dx - 0.49, -0.03, 0)).name = "shop_door_leaf"
    board = group("shop_door_board", [rbox("sbrd", (0.42, 0.03, 0.26), (dx, -0.13, 0.84), 0.03, M_("wood_lt", 0.6), base=True),
                                      tube("srope1", (dx - 0.14, -0.13, 1.1), (dx, -0.13, 1.2), 0.006, 0.006, 8, 6, 6, M_("8A6A4E", 0.9)),
                                      tube("srope2", (dx + 0.14, -0.13, 1.1), (dx, -0.13, 1.2), 0.006, 0.006, 8, 6, 6, M_("8A6A4E", 0.9))])
    child(lf, board, (dx, -0.13, 1.2)).name = "shop_door_board"
    bell = group("shop_door_bell", [
        lathe("sbellb", [(0, 0), (0.07, 0.0), (0.075, 0.01), (0.05, 0.06), (0.03, 0.11), (0, 0.12)],
              mat("brass", PAL["brass"], 0.3, metal=0.8), 24, M=T((dx + 0.38, -0.22, 1.86))),
        path_tube("sbracket", [(dx + 0.38, -0.02, 2.05), (dx + 0.38, -0.14, 2.08), (dx + 0.38, -0.22, 2.04),
                               (dx + 0.38, -0.22, 1.98)], [0.012] * 4, M_("4A4340", 0.5), 8, 4)])
    child(shopo, bell, (dx + 0.38, -0.22, 2.05)).name = "shop_door_bell"
    # hanging sign on a bracket at the right corner: disc with the pictogram on both faces
    br = path_tube("signarm", [(1.62, -0.02, 2.2), (1.62, -0.45, 2.2), (1.62, -0.72, 2.16)], [0.02] * 3, M_("4A4340", 0.5), 8, 4)
    br.parent = shopo
    sign = lathe("shop_sign", rounded_cyl_prof(0.3, 0.05, 0.02), tex_mat("sign", "sign-icon.png", 0.6), 40,
                 M=T((1.625, -0.5, 1.82)) @ R("Y", 90) @ T((0, 0, -0.025)))
    uv_sign(sign, (1.625, -0.5, 1.82), 0.3)
    child(shopo, sign, (1.62, -0.5, 2.18)).name = "shop_sign"
    out.append(shopo)
    # neighbour houses
    out.append(house("prop_house_peach", (2.0, 1.8, 1.9), "F8C9A8", "E58B78"))
    out.append(house("prop_house_mint", (1.6, 1.6, 1.7), "CDEBDD", "7FB59A", door_col="E0785A"))
    out.append(house("prop_house_butter", (2.2, 1.7, 2.1), "FBE7A8", "C98B5B", door_col="9FD3F0"))
    # station: building, platform, bench, clock (no digits); origin at the building's front centre
    st = [rbox("stb", (2.6, 1.6, 1.8), (0, 0.8, 0.3), 0.08, M_("CFE8F4", 0.8), base=True),
          rbox("stroof", (3.2, 2.2, 0.18), (0, 0.8, 2.1), 0.08, M_("5E8F9E", 0.6), base=True),
          rbox("stroof2", (2.4, 1.6, 0.4), (0, 0.8, 2.26), 0.15, M_("5E8F9E", 0.6), base=True),
          rbox("platform", (7.0, 1.6, 0.3), (0, -0.8, 0), 0.05, M_("stone", 0.9), base=True),
          rbox("pedge", (7.0, 0.12, 0.02), (0, -1.5, 0.3), 0.01, M_("F7D774", 0.7), base=True),
          rbox("stdoor", (0.6, 0.06, 1.0), (0, -0.01, 0.3), 0.06, M_("E0785A", 0.6), base=True)]
    for s in (1, -1):
        st.append(rbox(f"stwin{s}", (0.5, 0.06, 0.5), (0.8 * s, -0.01, 0.95), 0.05, M_("FFF6E8", 0.6), base=True))
        st.append(tube(f"stpost{s}", (1.4 * s, -0.5, 0.3), (1.4 * s, -0.5, 2.12), 0.05, 0.05, 10, 10, 6, M_("FFF6E8", 0.6)))
    st.append(lathe("stclock", rounded_cyl_prof(0.22, 0.05, 0.015), tex_mat("clock", "clock-face.png", 0.5), 32,
                    M=T((0, -0.03, 1.72)) @ R("X", 90) @ T((0, 0, -0.025))))
    uv_disc(st[-1], (0, -0.03, 1.72), 0.22, "xz")
    bench = [rbox("bseat", (1.0, 0.3, 0.06), (1.8, -0.5, 0.62), 0.02, wood, base=True),
             rbox("bback", (1.0, 0.05, 0.25), (1.8, -0.36, 0.72), 0.02, wood, base=True)]
    for s in (1, -1):
        bench.append(rbox(f"bleg{s}", (0.06, 0.26, 0.32), (1.8 + 0.42 * s, -0.5, 0.3), 0.02, M_("4A4340", 0.5), base=True))
    out.append(group("prop_station", st + bench))
    # little train: engine + one car, along +X; origin at the centre on the rails
    tr = []
    for k, (x0, ln, col) in enumerate(((-0.95, 1.5, "F7D774"), (0.75, 1.6, "E0785A"))):
        tr.append(rbox(f"body{k}", (ln, 0.9, 0.85), (x0, 0, 0.3), 0.14, M_(col, 0.5), base=True))
        tr.append(rbox(f"roof{k}", (ln + 0.12, 1.0, 0.12), (x0, 0, 1.15), 0.05, M_("FFF6E8", 0.6), base=True))
        for j in range(2 if k == 0 else 3):
            wx = x0 - ln / 2 + 0.35 + j * 0.45
            tr.append(rbox(f"tw{k}{j}", (0.32, 0.92, 0.3), (wx, 0, 0.72), 0.06, M_("BFE0EE", 0.2), base=True))
        for s in (1, -1):
            for j in (-1, 1):
                tr.append(lathe(f"wheel{k}{s}{j}", rounded_cyl_prof(0.14, 0.08, 0.03), M_("4A4340", 0.5), 20,
                                M=T((x0 + j * ln * 0.3, 0.44 * s, 0.16)) @ R("X", 90) @ T((0, 0, -0.04))))
    tr.append(lathe("chimney", rounded_cyl_prof(0.12, 0.35, 0.04), M_("4A4340", 0.5), 20, M=T((-1.4, 0, 1.15))))
    tr.append(lathe("lamp", [(0, 0), (0.11, 0), (0.12, 0.02), (0, 0.06)], mat("lamp", "FFF2C0", 0.3, emit=1.5), 20,
                    M=T((-1.72, 0, 0.62)) @ R("Y", -90)))
    out.append(group("prop_train", tr))
    # rails: 4 m segment along +X
    rl = [rbox(f"rail{s}", (4.0, 0.06, 0.08), (0, 0.44 * s, 0.06), 0.02, M_("B8B2AA", 0.4, metal=0.5), base=True)
          for s in (1, -1)]
    for k in range(8):
        rl.append(rbox(f"sleeper{k}", (0.2, 1.2, 0.07), (-1.75 + 0.5 * k, 0, 0), 0.02, M_("wood_dk", 0.8), base=True))
    out.append(group("prop_track", rl))
    # cobbled path tile: 2 m long, 1.4 m wide, soft pastel stones on a sandy bed; origin at the centre
    rnd = random.Random(9)
    cp = [rbox("bed", (1.4, 2.0, 0.04), (0, 0, 0), 0.01, M_("E6D8C2", 0.95), base=True)]
    y = -0.9
    row = 0
    while y < 0.95:
        x = -0.6 + (0.13 if row % 2 else 0.0)
        while x < 0.62:
            sx, sy = rnd.uniform(0.1, 0.13), rnd.uniform(0.08, 0.11)
            cp.append(ellipsoid(f"st{row}_{x:.2f}", (x, y, 0.04), (sx, sy, 0.035), M_(rnd.choice(["D8D2C8", "E3DCD2", "CFC7BB", "E8DFD1"]), 0.9), 10, 5))
            x += 0.26
        y += 0.2
        row += 1
    out.append(group("prop_path_cobble", cp))
    for o in out:
        bake_scale(o, TOWN_SCALE.get(o.name, 1.0))
    return out


# Background town pieces were modelled at real-house size; a 1.9 m chibi then out-grows their doors.
# Scaled so doors and cars sit at the shop's scale (the shop door already fits the bear).
TOWN_SCALE = {"prop_house_peach": 1.7, "prop_house_mint": 1.7, "prop_house_butter": 1.7, "prop_station": 1.7,
              "prop_train": 1.7, "prop_track": 1.7}


def awning_mesh(name, w, depth, loc):
    """Striped awning: a sloped curved sheet with a scalloped valance; u runs along the width."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    nx, ny = 24, 6
    grid = []
    for j in range(ny + 1):
        t = j / ny
        row = []
        for i in range(nx + 1):
            x = -w / 2 + w * i / nx
            y = -depth * t
            z = -0.55 * t * t - 0.12 * t + 0.04 * math.sin(math.pi * t)
            row.append(bm.verts.new((x, y, z)))
        grid.append(row)
    for j in range(ny):
        for i in range(nx):
            f = bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
            for lp, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                lp[uv].uv = (a / nx, 1 - b / ny)
    solid = bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=0.03)
    del solid
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    xform(bm, T(loc))
    o = link(name, bm, tex_mat("awning", "awning.png", 0.75))
    scal = []
    edge_z = loc[2] - 0.55 - 0.12
    for k in range(12):
        x = loc[0] - w / 2 + (k + 0.5) * w / 12
        scal.append(ellipsoid(f"{name}_sc{k}", (x, loc[1] - depth - 0.01, edge_z - 0.05), (w / 24, 0.02, 0.09),
                              M_("green" if k % 2 == 0 else "cream", 0.75), 12, 6))
    return join([o, *scal], name)


def uv_sign(o, c, r):
    """Pictogram on both flat faces of the sign disc (lying in the YZ plane)."""
    me = o.data
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    c = Vector(c)
    for poly in me.polygons:
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co - c
            flip = -1 if poly.normal.x > 0 else 1
            uvl.data[li].uv = ((flip * v.y / r + 1) / 2, (v.z / r + 1) / 2)


# ======================================================================================
# export and previews
# ======================================================================================
def export(path, objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
        for c in o.children_recursive:
            c.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_animations=True,
                              export_animation_mode="ACTIONS", export_skins=True, export_yup=True,
                              export_apply=False)
    print("EXPORTED", path, os.path.getsize(path))


def preview_setup(size=480):
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (*srgb("CFE7F2"), 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(-30)))
    bpy.context.active_object.data.energy = 3.2
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.data.lens = 50
    scene.camera = cam
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = 24
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.view_settings.view_transform = "Standard"
    return cam


def aim(cam, loc, target):
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


def render(path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def show_face(faces, key):
    for k, o in faces.items():
        o.hide_render = k != key


def preview_character(name, rig, faces, previews, target_z, dist, lying=(), separate=()):
    cam = preview_setup()
    files = []
    toggles = [o for o in separate if o.name == "acc_nightcap"]  # worn only in the sleep clips
    default_face = {"HappyBounce": "happy", "Sleep": "sleep", "SleepSnuggle": "sleep", "Chat": "talk"}
    for clip, frame in previews.items():
        rig.animation_data.action = bpy.data.actions[clip]
        scene.frame_set(frame)
        k = default_face.get(clip, "smile")
        show_face(faces, k if k in faces else ("blink" if k == "sleep" else "smile"))
        # lying clips: on her back, face up (the page lays her in the bed the same way)
        rig.rotation_euler = (math.radians(-90), 0, 0) if clip in lying else (0, 0, 0)
        for o in toggles:
            o.hide_render = clip not in lying
        for view, loc in (("front", (0, -dist, target_z + 0.15)), ("3q", (-dist * 0.72, -dist * 0.72, target_z + 0.35))):
            tgt = (0, 0, target_z)
            if clip in lying:
                loc, tgt = ((0, 0.3, 3.6), (0, 0.95, 0.3)) if view == "front" else ((-2.0, -0.6, 2.6), (0, 0.9, 0.3))
            aim(cam, loc, tgt)
            p = os.path.join(PREV, f"{name}-{clip}-{view}.png")
            render(p)
            files.append(p)
    rig.rotation_euler = (0, 0, 0)
    for o in toggles:
        o.hide_render = True
    rig.animation_data.action = bpy.data.actions["Idle"]
    scene.frame_set(1)
    for k in faces:
        show_face(faces, k)
        aim(cam, (0, -dist * 0.62, target_z + 0.3), (0, 0, target_z + 0.3))
        p = os.path.join(PREV, f"{name}-face-{k}.png")
        render(p)
        files.append(p)
    show_face(faces, "smile")
    return files


def main():
    if TARGET in CHARS:
        rig, faces, sep = build_biped(TARGET, CHARS[TARGET])
        export(os.path.join(MODELS, f"{TARGET}.glb"), [rig])
        if PREVIEWS:
            preview_character(TARGET, rig, faces, BIPED_PREVIEW, 1.0, 4.4, lying=("Sleep", "SleepSnuggle"),
                              separate=sep)
    elif TARGET == "puppy":
        rig, faces = build_puppy()
        export(os.path.join(MODELS, "puppy.glb"), [rig])
        if PREVIEWS:
            preview_character("puppy", rig, faces, PUPPY_PREVIEW, 0.3, 2.0)
    elif TARGET == "pancake":
        rig = build_pancake()
        export(os.path.join(MODELS, "pancake.glb"), [rig])
        if PREVIEWS:
            cam = preview_setup(560)
            for clip, frame in (("Rest", 1), ("Wobble", 5), ("Wobble", 10), ("Jiggle", 9), ("Land", 4)):
                rig.animation_data.action = bpy.data.actions[clip]
                scene.frame_set(frame)
                for view, loc, tgt in (("hero", (0.0, -0.95, 0.42), (0, 0, 0.17)),
                                       ("top", (0.25, -0.55, 0.75), (0, 0, 0.2))):
                    if clip != "Rest" and view == "top":
                        continue
                    aim(cam, loc, tgt)
                    render(os.path.join(PREV, f"pancake-{clip}{frame}-{view}.png"))
    else:
        builders = {"props-small": props_small, "props-set": props_set, "props-town": props_town}
        objs = builders[TARGET]()
        export(os.path.join(MODELS, f"{TARGET}.glb"), objs)
        print("PROPS", [(o.name, tris(o) + sum(tris(c) for c in o.children_recursive if c.type == "MESH"))
                        for o in objs])
        if PREVIEWS:
            preview_props(objs)
    print(f"TIMING {TARGET} {time.time() - T0:.1f}s")


def preview_props(objs):
    """Lay the props out in a row-wrapped grid by size and render one overview per group."""
    cam = preview_setup(900)
    cam.data.type = "ORTHO"
    dims = []
    for o in objs:
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        for c in o.children_recursive:
            if c.type == "MESH":
                bb += [c.matrix_world @ Vector(v) for v in c.bound_box]
        mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
        mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
        dims.append((o, mn, mx))
    rowlen = max(2.0, sum((mx.x - mn.x) + 0.15 for _, mn, mx in dims) / 3.2)
    x = y = rowh = 0.0
    for o, mn, mx in dims:
        w = mx.x - mn.x + max(0.1, 0.25 * (mx.x - mn.x))
        if x + w > rowlen and x > 0:
            x = 0.0
            y += rowh
            rowh = 0.0
        o.location += Vector((x - mn.x, y - mn.y, 0))
        x += w
        rowh = max(rowh, mx.y - mn.y + max(0.1, 0.3 * (mx.y - mn.y)))
    total_w, total_d = rowlen, y + rowh
    cx, cy = total_w / 2, total_d / 2
    cam.data.ortho_scale = max(total_w, total_d) * 1.1
    aim(cam, (cx - total_d * 0.9, cy - total_d * 1.4 - 3, total_d * 1.5 + 3), (cx, cy, 0.2))
    render(os.path.join(PREV, f"{TARGET}-overview.png"))
    aim(cam, (cx, cy - 40, 12), (cx, cy, 0.4))
    render(os.path.join(PREV, f"{TARGET}-front.png"))


main()
