"""Optional offline photo inference. No models or Python source are downloaded.

Runtime references verified 2026-10-08:
https://github.com/danielgatis/rembg (MIT; model weights have separate licenses)
https://github.com/xuebinqin/U-2-Net (Apache-2.0)
https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf (Apache-2.0)
https://huggingface.co/docs/transformers/main_classes/model
Existing polygon/canvas helpers remain the default. No external source copied.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path


def local_model(value, mode):
    """Reject remote identifiers before importing inference dependencies."""
    model = Path(value).expanduser().resolve(strict=True)
    if mode == "mask" and (not model.is_file() or model.suffix != ".onnx"):
        raise ValueError("mask requires an existing .onnx file")
    if mode == "depth" and (not model.is_dir() or not list(model.glob("*.safetensors"))):
        raise ValueError("depth requires a local directory with safetensors weights")
    return model


def infer_mask(image, model):
    """Reuse the established preprocessing with an explicit local model path."""
    import onnxruntime
    from rembg.sessions.u2net import U2netSession

    class LocalSession(U2netSession):
        @classmethod
        def download_models(cls, *args, **kwargs):
            return str(model)

    session = LocalSession("u2net", onnxruntime.SessionOptions(), providers=["CPUExecutionProvider"])
    mask = session.predict(image)[0]
    result = image.convert("RGBA")
    result.putalpha(mask)
    return result


def load_depth(model):
    """Load only local safe tensors and installed model implementations."""
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    options = {"local_files_only": True, "trust_remote_code": False}
    processor = AutoImageProcessor.from_pretrained(str(model), **options)
    estimator = AutoModelForDepthEstimation.from_pretrained(str(model), use_safetensors=True, **options)
    return processor, estimator.eval()


def infer_depth(image, model):
    """Return normalized inverse depth: white near, black far, no metric claim."""
    import torch
    from PIL import Image

    processor, estimator = load_depth(model)
    with torch.inference_mode():
        output = estimator(**processor(images=image, return_tensors="pt"))
    depth = processor.post_process_depth_estimation(output, target_sizes=[(image.height, image.width)])[0]["predicted_depth"]
    low, high = depth.min(), depth.max()
    if not torch.isfinite(depth).all() or float(high - low) <= 0:
        raise ValueError("depth inference produced a non-finite or flat map")
    pixels = ((depth - low) / (high - low) * 255).round().to(torch.uint8).cpu().numpy()
    return Image.fromarray(pixels).convert("RGB")


def model_hash(model):
    """Record deterministic content hashes without loading checkpoint objects."""
    files = [model] if model.is_file() else sorted(p for p in model.rglob("*") if p.is_file())
    digest = hashlib.sha256()
    for file in files:
        if file.is_symlink():
            raise ValueError("model directories must not contain symbolic links")
        digest.update((file.name if model.is_file() else str(file.relative_to(model))).encode())
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def main():
    """Write one same-size PNG plus inference provenance beside it."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["mask", "depth"])
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-source", required=True)
    parser.add_argument("--model-license", required=True)
    args = parser.parse_args()
    model = local_model(args.model, args.mode)
    checksum = model_hash(model)
    source = args.input.resolve(strict=True)
    output = args.output.resolve()
    record = output.with_suffix(".json")
    if output == source or output.exists() or record.exists():
        raise ValueError("choose new output paths; input and existing outputs are preserved")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from PIL import Image

    with Image.open(source) as opened:
        image = opened.convert("RGB")
    result = infer_mask(image, model) if args.mode == "mask" else infer_depth(image, model)
    if result.size != image.size:
        raise ValueError("inference output dimensions differ from source")
    result.save(output, format="PNG")
    record.write_text(json.dumps({"mode": args.mode, "model": str(model), "sha256": checksum,
                                  "source": args.model_source, "license": args.model_license,
                                  "width": image.width, "height": image.height,
                                  "nearWhite": args.mode == "depth"}, indent=2) + "\n")


if __name__ == "__main__":
    main()
