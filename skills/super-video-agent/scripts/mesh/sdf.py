# Signed-distance modelling kit: a 3D shape from primitives, matched to reference photos (references/photo-to-3d.md).
# Our own code, no third-party mesh: everything a figure script makes from it is the film's own.
# Units are LDraw LDU and axes are LDraw axes: x right (the figure's left), y DOWN, z toward the BACK (the face looks to -z);
# other units work the same if every number in the figure script uses them.
# A figure script builds one distance function f(x, y, z) from primitives + smooth booleans, then calls
#   save_outputs(f, name, bounds, h, outdir)  -> <name>.obj (surface-nets mesh), <name>.sdf.bin + <name>.sdf.json (the grid a
#   brickifier reads). Negative = inside. Mirror symmetry: build paired features with mx(x) = |x| so left == right exactly.
# Use from a figure script:  sys.path.insert(0, "<skill>/scripts/mesh"); from sdf import *
# Runs in plain Python 3 + numpy (or Blender's bundled Python). Origin: ww-w-kids Sejong statue head (2026-10-27), EV-37.
import json, os, sys
import numpy as np

# ---------------- primitives (x, y, z are numpy arrays of equal shape) ----------------
def _len(*c):
    return np.sqrt(sum(v * v for v in c))

def rot(x, y, z, c, ax=0.0, ay=0.0, az=0.0):
    """points into a frame turned by angles (degrees) about x, then y, then z, around centre c (inverse transform)."""
    x, y, z = x - c[0], y - c[1], z - c[2]
    for ang, axis in ((az, 'z'), (ay, 'y'), (ax, 'x')):
        if not ang:
            continue
        a = -np.radians(ang); ca, sa = np.cos(a), np.sin(a)
        if axis == 'x':
            y, z = ca * y - sa * z, sa * y + ca * z
        elif axis == 'y':
            x, z = ca * x + sa * z, -sa * x + ca * z
        else:
            x, y = ca * x - sa * y, sa * x + ca * y
    return x + c[0], y + c[1], z + c[2]

def ellipsoid(x, y, z, c, r):
    """iq's ellipsoid bound: close to the true distance near the surface, exact for spheres."""
    px, py, pz = (x - c[0]) / r[0], (y - c[1]) / r[1], (z - c[2]) / r[2]
    k0 = _len(px, py, pz)
    k1 = _len(px / r[0], py / r[1], pz / r[2])
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)

def sphere(x, y, z, c, r):
    return _len(x - c[0], y - c[1], z - c[2]) - r

def capsule(x, y, z, a, b, r):
    a, b = np.asarray(a, float), np.asarray(b, float)
    ba = b - a; px, py, pz = x - a[0], y - a[1], z - a[2]
    t = np.clip((px * ba[0] + py * ba[1] + pz * ba[2]) / ba.dot(ba), 0, 1)
    return _len(px - t * ba[0], py - t * ba[1], pz - t * ba[2]) - r

def round_cone(x, y, z, a, b, ra, rb):
    """capsule whose radius goes linearly ra -> rb (approximate, fine for tapering features)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    ba = b - a; px, py, pz = x - a[0], y - a[1], z - a[2]
    t = np.clip((px * ba[0] + py * ba[1] + pz * ba[2]) / ba.dot(ba), 0, 1)
    return _len(px - t * ba[0], py - t * ba[1], pz - t * ba[2]) - (ra + (rb - ra) * t)

def box(x, y, z, c, half, rr=0.0):
    qx, qy, qz = np.abs(x - c[0]) - half[0] + rr, np.abs(y - c[1]) - half[1] + rr, np.abs(z - c[2]) - half[2] + rr
    out = _len(np.maximum(qx, 0), np.maximum(qy, 0), np.maximum(qz, 0))
    return out + np.minimum(np.maximum(qx, np.maximum(qy, qz)), 0) - rr

def disc(x, y, z, c, r, half_t, axis='z'):
    """flat round plate (cylinder) of radius r and half thickness half_t, axis along x|y|z."""
    dx, dy, dz = x - c[0], y - c[1], z - c[2]
    rad, ax = {'x': (_len(dy, dz), dx), 'y': (_len(dx, dz), dy), 'z': (_len(dx, dy), dz)}[axis]
    qx, qy = rad - r, np.abs(ax) - half_t
    return np.minimum(np.maximum(qx, qy), 0) + _len(np.maximum(qx, 0), np.maximum(qy, 0))

def plane(x, y, z, n, d):
    """half space n.p > d is outside (n unit)."""
    return x * n[0] + y * n[1] + z * n[2] - d

# ---------------- booleans ----------------
def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)

def smax(a, b, k):
    return -smin(-a, -b, k)

def sub(a, b, k=0.0):
    """a minus b"""
    return smax(a, -b, k)

def mx(x):
    """mirror helper: build a +x feature with mx(x) and it appears on both sides."""
    return np.abs(x)

# ---------------- evaluation, mesh, output ----------------
def grid(bounds, h):
    (x0, x1), (y0, y1), (z0, z1) = bounds
    xs = np.arange(x0, x1 + h * 0.5, h, dtype=np.float32)
    ys = np.arange(y0, y1 + h * 0.5, h, dtype=np.float32)
    zs = np.arange(z0, z1 + h * 0.5, h, dtype=np.float32)
    return xs, ys, zs

def evaluate(f, bounds, h, slab=24):
    xs, ys, zs = grid(bounds, h)
    F = np.empty((len(xs), len(ys), len(zs)), np.float32)
    Y, Z = np.meshgrid(ys, zs, indexing='ij')
    for i0 in range(0, len(xs), slab):
        xx = xs[i0:i0 + slab]
        X3 = np.broadcast_to(xx[:, None, None], (len(xx),) + Y.shape)
        Y3 = np.broadcast_to(Y[None], X3.shape); Z3 = np.broadcast_to(Z[None], X3.shape)
        F[i0:i0 + slab] = f(X3.astype(np.float64), Y3.astype(np.float64), Z3.astype(np.float64))
    return xs, ys, zs, F

def surface_nets(F, origin, h):
    """naive surface nets: one vertex per sign-changing cell (mean of edge crossings), one quad per sign-changing edge."""
    nx, ny, nz = F.shape
    c = [F[i:nx - 1 + i, j:ny - 1 + j, k:nz - 1 + k] for i in (0, 1) for j in (0, 1) for k in (0, 1)]   # corner index = 4i+2j+k
    corners = [(i, j, k) for i in (0, 1) for j in (0, 1) for k in (0, 1)]
    edges = [(a, b) for a in range(8) for b in range(a + 1, 8) if sum(abs(p - q) for p, q in zip(corners[a], corners[b])) == 1]
    acc = np.zeros(c[0].shape + (3,), np.float32); cnt = np.zeros(c[0].shape, np.int16)
    for a, b in edges:
        fa, fb = c[a], c[b]
        m = (fa < 0) != (fb < 0)
        t = np.where(m, fa / np.where(m, fa - fb, 1), 0)
        pa, pb = np.array(corners[a], np.float32), np.array(corners[b], np.float32)
        for d in range(3):
            acc[..., d] += np.where(m, pa[d] + t * (pb[d] - pa[d]), 0)
        cnt += m
    has = cnt > 0
    idx = -np.ones(cnt.shape, np.int64); idx[has] = np.arange(has.sum())
    cell = np.argwhere(has)
    verts = (cell + acc[has] / cnt[has][:, None]) * h + np.asarray(origin, np.float32)
    quads = []
    # x-edges: between (i,j,k) and (i+1,j,k); cells around: (i, j-1|j, k-1|k)
    for axis in range(3):
        sl0 = [slice(None)] * 3; sl1 = [slice(None)] * 3
        sl0[axis] = slice(0, -1); sl1[axis] = slice(1, None)
        f0, f1 = F[tuple(sl0)], F[tuple(sl1)]
        m = (f0 < 0) != (f1 < 0)
        e = np.argwhere(m)
        o1, o2 = [d for d in range(3) if d != axis]
        ok = (e[:, o1] >= 1) & (e[:, o2] >= 1) & (e[:, o1] <= F.shape[o1] - 2) & (e[:, o2] <= F.shape[o2] - 2)
        e = e[ok]
        inside_first = f0[tuple(e.T)] < 0
        def cid(d1, d2):
            q = e.copy(); q[:, o1] -= d1; q[:, o2] -= d2
            return idx[tuple(q.T)]
        a, b, cc, dd = cid(0, 0), cid(1, 0), cid(1, 1), cid(0, 1)
        flip = inside_first if axis != 1 else ~inside_first
        q = np.where(flip[:, None], np.stack([a, b, cc, dd], 1), np.stack([a, dd, cc, b], 1))
        quads.append(q)
    quads = np.concatenate(quads)
    quads = quads[(quads >= 0).all(1)]
    return verts, quads

def write_obj(path, verts, quads, name='mesh'):
    with open(path, 'w') as fh:
        fh.write('# sdf.py surface-nets mesh (LDraw axes: x right, y down, z back; LDU)\no %s\n' % name)
        fh.write(''.join('v %.2f %.2f %.2f\n' % tuple(v) for v in verts))
        fh.write(''.join('f %d %d %d %d\n' % tuple(q + 1) for q in quads))

def save_outputs(f, name, bounds, h=3.0, outdir=None, mesh=True):
    # default: out/ beside the figure script that runs (never inside the skill folder)
    outdir = outdir or os.path.join(os.path.dirname(os.path.abspath(sys.argv[0] or '.')), 'out')
    os.makedirs(outdir, exist_ok=True)
    xs, ys, zs, F = evaluate(f, bounds, h)
    meta = {'name': name, 'origin': [float(xs[0]), float(ys[0]), float(zs[0])], 'h': h, 'shape': list(F.shape),
            'order': 'x-major (index = (i*ny + j)*nz + k), float32 little-endian, negative inside, LDU, LDraw axes'}
    F.astype('<f4').tofile(os.path.join(outdir, name + '.sdf.bin'))
    with open(os.path.join(outdir, name + '.sdf.json'), 'w') as fh:
        json.dump(meta, fh, indent=1)
    if mesh:
        v, q = surface_nets(F, meta['origin'], h)
        write_obj(os.path.join(outdir, name + '.obj'), v, q, name)
        print('mesh', name, 'verts', len(v), 'quads', len(q))
    ins = F < 0
    if ins.any():
        ii = np.argwhere(ins)
        lo = [float(a[i]) for a, i in zip((xs, ys, zs), ii.min(0))]; hi = [float(a[i]) for a, i in zip((xs, ys, zs), ii.max(0))]
        print('solid bounds LDU x %.0f..%.0f y %.0f..%.0f z %.0f..%.0f' % (lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]))
    return F
