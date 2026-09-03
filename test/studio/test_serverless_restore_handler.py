"""The serverless restore container renders the SAME graph as the free lane.

The hosted pay-per-render lane runs on a RunPod Serverless worker
(packages/gpu-rentals/serverless/handler.py) rather than on a machine the owner
attached. That is a difference in WHERE the render happens and in who pays for
it. It is not supposed to be a difference in what comes out.

The one thing that could quietly make it one is a second graph builder. So the
container imports the studio's own `video_restore.build_restore_graph` and this
test holds it to that: same settings in, byte-identical graph out, against the
local lane's own submission. A divergence here means somebody restoring on
credits gets different pixels from somebody restoring for free, which is exactly
the kind of thing nobody notices until a customer says the paid one looks worse.

It also pins the choices the container is NOT allowed to make: no trimming (the
assembler needs both copies of a boundary to dissolve a seam), no torch.compile,
no TensorRT, and nothing of one caller's footage left behind for the next one.
"""

from __future__ import annotations

import importlib.util
import inspect
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATEWAY = ROOT / "packages" / "media-gateway"
SERVERLESS = ROOT / "packages" / "gpu-rentals" / "serverless"


def _load(name: str, path: Path):
    """By path, and without putting either directory on sys.path:
    packages/media-gateway/app.py would shadow this repo's own `app` package
    for every test collected afterwards."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


video_restore = _load("_gateway_video_restore", GATEWAY / "video_restore.py")

# The handler imports `video_restore` by bare name — inside the image the
# Dockerfile puts both files in /app. Here it is bound in sys.modules first, so
# the test is exercising the studio's real module rather than a stand-in.
import sys  # noqa: E402

sys.modules.setdefault("video_restore", video_restore)
handler = _load("_serverless_handler", SERVERLESS / "handler.py")


JOB = {
    "source_url": "https://example.invalid/in",
    "upload_url": "https://example.invalid/out",
    "frames": 30,
    "model": "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors",
    "resolution": 1440,
    "max_edge": 0,
    "batch_size": 5,
    "color_correction": "lab",
    "seed": 4242,
    "fps": 24.0,
}


class TheHostedGraphIsTheLocalGraph(unittest.TestCase):
    def test_it_is_byte_identical_to_what_a_local_lane_submits(self):
        plan = handler.chunk_plan(JOB)
        chunk = {"index": 0, "source_start": 0, "source_length": 30, "context": 0, "output_length": 30}
        expected = video_restore.build_restore_graph(
            source_name="chunk.mp4",
            plan=plan,
            chunk=chunk,
            sink=video_restore.SINK_FRAMES,
            device="cuda:0",
            offload_device="cpu",
            attention_mode="sdpa",
            cache_models=True,
        )
        self.assertEqual(handler.chunk_graph(JOB, source_name="chunk.mp4"), expected)

    def test_the_settings_that_decide_the_pixels_survive_the_wire(self):
        plan = handler.chunk_plan(JOB)
        self.assertEqual(plan["seed"], 4242)
        self.assertEqual(plan["short_edge"], 1440)
        self.assertEqual(plan["color_correction"], "lab")
        self.assertEqual(plan["model"], JOB["model"])
        self.assertEqual(plan["batch_size"], 5)

    def test_an_unknown_model_or_colour_defaults_rather_than_failing(self):
        # The two ends disagreeing is a deployment problem, not this caller's;
        # a render that produces something is a better answer than a validation
        # error arriving from inside a container they cannot see.
        plan = handler.chunk_plan({**JOB, "model": "not-a-model", "color_correction": "chartreuse"})
        self.assertEqual(plan["model"], video_restore.DEFAULT_DIT)
        self.assertEqual(plan["color_correction"], "lab")

    def test_the_batch_is_snapped_to_the_models_own_lattice(self):
        # 4n+1 is refused by the node rather than rounded, and the gateway
        # already snaps — but a container that trusted the wire would turn a
        # bad request into a failed job somebody paid a reservation for.
        self.assertEqual(handler.chunk_plan({**JOB, "batch_size": 8})["batch_size"], 5)


class TheContainerDoesNotGetAnOpinion(unittest.TestCase):
    def test_it_returns_every_frame_it_was_given(self):
        # No ImageFromBatch, no trim. The studio's assembler needs both copies
        # of a chunk boundary; a container that helpfully trimmed would turn
        # every hosted render into hard cuts and nobody would know why.
        graph = handler.chunk_graph(JOB, source_name="chunk.mp4")
        self.assertNotIn("ImageFromBatch", [node["class_type"] for node in graph.values()])
        self.assertIn("PreviewImage", [node["class_type"] for node in graph.values()])

    def test_neither_accelerator_can_be_switched_on_by_a_caller(self):
        # torch.compile makes the first chunk slower and crashes the second;
        # the TensorRT VAE measured 0.98x. Neither is a knob a paying caller
        # should be able to turn on our GPU.
        source = inspect.getsource(handler.chunk_graph)
        self.assertIn("torch_compile=False", source)
        self.assertIn("tensorrt=False", source)
        graph = handler.chunk_graph({**JOB, "torch_compile": True, "tensorrt": True}, source_name="chunk.mp4")
        classes = [node["class_type"] for node in graph.values()]
        self.assertNotIn("SeedVR2TorchCompileSettings", classes)
        self.assertNotIn(video_restore.TENSORRT_NODE_CLASS, classes)

    def test_weights_stay_cached_between_jobs_but_are_offloaded(self):
        # A warm worker takes the next chunk seconds later and must not reload
        # 8-16GB. The node REFUSES cache_model with offload_device "none", so
        # the two settings are a pair rather than two switches.
        graph = handler.chunk_graph(JOB, source_name="chunk.mp4")
        for node in ("3", "4"):
            self.assertTrue(graph[node]["inputs"]["cache_model"])
            self.assertNotIn(graph[node]["inputs"]["offload_device"], ("", "none"))


class NothingOfOneCallersFootageOutlivesTheirJob(unittest.TestCase):
    def test_the_errand_cleans_up_in_a_finally(self):
        # A serverless worker is reused by the NEXT caller. One caller's footage
        # still in the input directory when somebody else's job starts is the
        # whole disclosure risk of this design, so the cleanup cannot be on the
        # success path.
        source = inspect.getsource(handler.restore_one_chunk)
        self.assertIn("finally:", source)
        tail = source.split("finally:", 1)[1]
        self.assertIn("staged.unlink", tail)
        self.assertIn("restored.unlink", tail)
        self.assertIn("frame.unlink", tail)

    def test_a_failure_is_returned_as_data_so_the_gateway_can_refund(self):
        # The gateway reads `uploaded` to decide whether anything was delivered,
        # and a chunk nobody received is refunded in full. An exception escaping
        # to RunPod would still refund, but without the sentence saying why.
        result = handler.handler({"input": {"frames": 30}})
        self.assertIs(result["uploaded"], False)
        self.assertIn("source", result["error"])


class TheGatewayOffersExactlyWhatTheContainerCarries(unittest.TestCase):
    def test_cloud_models_match_the_baked_list(self):
        # Parsed out of modal_app.py rather than imported: the studio's venv
        # does not have the modal SDK, and it should not need it to know which
        # weights the image holds. A model on one list and not the other is
        # either a 16GB download on somebody's credits or a lane that hides a
        # model it has.
        import ast
        tree = ast.parse((SERVERLESS / "modal_app.py").read_text(encoding="utf-8"))
        baked = None
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "BAKED_MODELS" for target in node.targets
            ):
                baked = ast.literal_eval(node.value)
        self.assertIsNotNone(baked)
        dits = sorted(name for name in baked if not name.startswith("ema_vae"))
        self.assertEqual(dits, sorted(video_restore.CLOUD_MODELS))
        self.assertIn(video_restore.DEFAULT_VAE, baked)

    def test_every_offered_model_is_one_the_studio_knows(self):
        for name in video_restore.CLOUD_MODELS:
            self.assertIn(name, video_restore.DIT_MODELS)


if __name__ == "__main__":
    unittest.main()
