# Blender headless renderer for sdf.py meshes (OBJ in LDraw axes/LDU, scripts/mesh/sdf.py), to compare with reference photos
# (references/photo-to-3d.md). Blender from scripts/probe-blender.mjs:
#   <blender> --background --factory-startup --disable-autoexec --python-exit-code 1 --python <skill>/scripts/blender/render-mesh.py -- <mesh.obj> <outdir> [size] [views]
#   views: comma list of name:azimuth:elevation[:fov] (azimuth 0 = facing the figure, +90 = from the figure's left (+x)),
#          or name:az:el:O:cx:cy:width:height for an orthographic view framed in LDU (to overlay a photo at the same scale)
# Bronze-gold material, low warm key light from the upper left + sky fill, so relief reads like statue photos; change the
# material and lights for another subject. Writes <outdir>/<name>.png per view. Origin: ww-w-kids Sejong head (EV-37).
import bpy, sys, math, os
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
obj_path, outdir = argv[0], argv[1]
size = int(argv[2]) if len(argv) > 2 else 900
views = argv[3] if len(argv) > 3 else 'front:0:-6,q34L:38:-8,s60R:-55:-6,side:90:0'
os.makedirs(outdir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
# ---- mesh: LDraw (x, y down, z back) -> Blender (x, z back -> +Y, -y up) ----
V, F = [], []
with open(obj_path) as fh:
    for ln in fh:
        if ln.startswith('v '):
            x, y, z = map(float, ln.split()[1:4]); V.append((x, z, -y))
        elif ln.startswith('f '):
            F.append([int(t.split('/')[0]) - 1 for t in ln.split()[1:]])
me = bpy.data.meshes.new('m'); me.from_pydata(V, [], F); me.update()
ob = bpy.data.objects.new('statue', me); sc.collection.objects.link(ob)
import bmesh
bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
for p in me.polygons: p.use_smooth = True
mat = bpy.data.materials.new('bronze'); mat.use_nodes = True
bs = mat.node_tree.nodes['Principled BSDF']
bs.inputs['Base Color'].default_value = (0.50, 0.33, 0.12, 1)
bs.inputs['Metallic'].default_value = 0.75
bs.inputs['Roughness'].default_value = 0.38
me.materials.append(mat)
# ---- world + lights ----
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.42, 0.58, 0.85, 1); bg.inputs['Strength'].default_value = 0.9
def sun(name, rx, rz, e, col):
    l = bpy.data.lights.new(name, 'SUN'); l.energy = e; l.color = col; l.angle = math.radians(3)
    o = bpy.data.objects.new(name, l); o.rotation_euler = (math.radians(rx), 0, math.radians(rz)); sc.collection.objects.link(o)
sun('key', 50, -35, 4.0, (1.0, 0.93, 0.82))
sun('rim', 70, 160, 1.5, (0.8, 0.88, 1.0))
# ---- camera ----
bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
ctr = sum(bb, Vector()) / 8
rad = max((v - ctr).length for v in bb)
cam = bpy.data.cameras.new('c'); cam.clip_start = 10; cam.clip_end = 100000; co = bpy.data.objects.new('c', cam); sc.collection.objects.link(co); sc.camera = co
sc.render.resolution_x = size; sc.render.resolution_y = int(size * 1.25)
try:
    sc.render.engine = 'BLENDER_EEVEE'
except Exception:
    sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.view_settings.view_transform = 'Standard'
sc.render.film_transparent = False
for spec in views.split(','):
    # perspective: name:az:el[:fov]   orthographic, framed in LDraw units to overlay a reference photo:
    # name:az:el:O:cx:cy:width:height  (cx, cy = LDraw x / y of the frame centre; width x height in LDU; set size to match)
    name, az, el, *rest = spec.split(':'); az, el = math.radians(float(az)), math.radians(float(el))
    d = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    if rest and rest[0] == 'O':
        cx, cy, wd, ht = map(float, rest[1:5])
        cam.type = 'ORTHO'; cam.ortho_scale = max(wd, ht)
        sc.render.resolution_y = int(round(sc.render.resolution_x * ht / wd))
        tgt = Vector((cx * math.cos(az), cx * math.sin(az), -cy)) if abs(az) > 1e-6 else Vector((cx, 0, -cy))
        co.location = tgt + d * 3000
        co.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(outdir, name + '.png')
        bpy.ops.render.render(write_still=True); print('wrote', sc.render.filepath)
        cam.type = 'PERSP'; sc.render.resolution_y = int(size * 1.25)
        continue
    fov = float(rest[0]) if rest else 14.0
    cam.angle = math.radians(fov)
    dist = rad / math.tan(cam.angle / 2) * 0.92
    # azimuth 0: camera on -Y (in front of the face); +az swings toward +X (the figure's left)
    co.location = ctr + d * dist
    co.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = os.path.join(outdir, name + '.png')
    bpy.ops.render.render(write_still=True)
    print('wrote', sc.render.filepath)
