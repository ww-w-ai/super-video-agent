import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("offline photo adapter rejects unsafe inputs and injects only local inference loaders", () => {
  const helper = fileURLToPath(new URL("../scripts/photo-layers.py", import.meta.url));
  const script = String.raw`
import importlib.util, pathlib, sys, tempfile, types
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("photo", sys.argv[1])
photo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(photo)
with tempfile.TemporaryDirectory() as root:
    base = pathlib.Path(root).resolve()
    model = base / "model.onnx"
    model.write_bytes(b"test model boundary; not inference weights")
    assert photo.local_model(str(model), "mask") == model
    try:
        photo.local_model("remote/model-id", "depth")
        raise AssertionError("remote identifier accepted")
    except FileNotFoundError:
        pass
    try:
        photo.local_model(str(base), "depth")
        raise AssertionError("missing safetensors accepted")
    except ValueError:
        pass
    first = photo.model_hash(model)
    model.write_bytes(b"changed")
    assert first != photo.model_hash(model)
    (base / "weights.safetensors").write_bytes(b"boundary fixture")
    assert photo.local_model(str(base), "depth") == base
    calls = []
    class Loader:
        @staticmethod
        def from_pretrained(name, **kwargs):
            calls.append((name, kwargs))
            return types.SimpleNamespace(eval=lambda: "estimator")
    sys.modules["transformers"] = types.SimpleNamespace(AutoImageProcessor=Loader, AutoModelForDepthEstimation=Loader)
    assert photo.load_depth(base)[1] == "estimator"
    assert all(c[1]["local_files_only"] and c[1]["trust_remote_code"] is False for c in calls)
    assert calls[1][1]["use_safetensors"] is True
    class Session:
        def __init__(self, name, options, providers):
            assert self.download_models() == str(model)
            assert providers == ["CPUExecutionProvider"]
        def predict(self, image):
            return ["alpha"]
    sys.modules["onnxruntime"] = types.SimpleNamespace(SessionOptions=lambda: None)
    sys.modules["rembg.sessions.u2net"] = types.SimpleNamespace(U2netSession=Session)
    class Picture:
        def convert(self, mode):
            assert mode == "RGBA"
            return self
        def putalpha(self, mask):
            assert mask == "alpha"
    assert isinstance(photo.infer_mask(Picture(), model), Picture)
    (base / "escape").symlink_to(model)
    try:
        photo.model_hash(base)
        raise AssertionError("symlink accepted")
    except ValueError:
        pass
`;
  const result = spawnSync(process.env.SVA_PYTHON || "/usr/bin/python3", ["-c", script, helper], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
