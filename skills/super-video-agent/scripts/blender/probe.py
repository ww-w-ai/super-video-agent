"""Render a disposable frame to verify the installed Blender runtime."""
import sys
import json
import bpy

bpy.ops.wm.read_factory_settings(use_empty=False)
scene = bpy.context.scene
engines = scene.render.bl_rna.properties["engine"].enum_items.keys()
scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
scene.render.resolution_x = 32
scene.render.resolution_y = 32
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = sys.argv[sys.argv.index("--") + 1]
bpy.ops.render.render(write_still=True)
print("SVA_BLENDER_OK " + json.dumps({"version": bpy.app.version_string, "renderEngine": scene.render.engine}), flush=True)
