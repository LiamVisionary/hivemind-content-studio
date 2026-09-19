"""The two direction-control references, and the lane that sends them.

The renderer is a port of someone else's two renderers, so the tests that
matter are the ones that would catch a port drifting: the dot's geometry
against the numpy node it came from, and the sphere's shading against the
author's own baked Three.js render.
"""
import json
import os
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gateway import direction_reference as dr  # noqa: E402
from gateway import direction_reference  # noqa: E402  (the module, for its PNG writer)
from gateway import graphs  # noqa: E402


def decode_png(data):
    """(width, height, rows-of-(r,g,b)) for an 8-bit RGB PNG."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, width, height = 8, b"", 0, 0
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        tag, payload = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, depth, colour = struct.unpack(">IIBB", payload[:10])
            assert (depth, colour) == (8, 2), (depth, colour)
        elif tag == b"IDAT":
            idat += payload
    raw = zlib.decompress(idat)
    stride = width * 3
    rows = []
    for y in range(height):
        start = y * (stride + 1)
        assert raw[start] == 0, "the renderer writes filter 0 on every row"
        line = raw[start + 1:start + 1 + stride]
        rows.append([tuple(line[x * 3:x * 3 + 3]) for x in range(width)])
    return width, height, rows


class EyesDotTests(unittest.TestCase):
    """Against eric-venti-seeds/Eyes_Direction_Lora_Control, nodes.py."""

    def test_canvas_is_the_size_the_lora_was_trained_on(self):
        width, height, _ = decode_png(dr.render_eyes_dot_png(0.5, 0.5))
        self.assertEqual((width, height), (1024, 1024))

    def test_frame_is_a_580_square_of_6px_black_on_white(self):
        _, _, rows = decode_png(dr.render_eyes_dot_png(0.0, 0.0))
        self.assertEqual(rows[0][1023], (255, 255, 255))
        # The frame's own corner, and the white just outside and inside it.
        self.assertEqual(rows[222][222], (0, 0, 0))
        self.assertEqual(rows[221][300], (255, 255, 255))
        self.assertEqual(rows[228][300], (255, 255, 255))
        self.assertEqual(rows[801][300], (0, 0, 0))
        self.assertEqual(rows[802][300], (255, 255, 255))

    def test_dot_is_85px_of_pure_red_at_the_pick(self):
        _, _, rows = decode_png(dr.render_eyes_dot_png(0.5, 0.5))
        self.assertEqual(rows[512][512], (255, 0, 0))
        self.assertEqual(rows[512][512 + 84], (255, 0, 0))
        self.assertEqual(rows[512][512 + 86], (255, 255, 255))

    def test_the_dot_is_drawn_over_the_frame(self):
        # The node draws it last, so a gaze aimed at the border covers it.
        _, _, rows = decode_png(dr.render_eyes_dot_png(222 / 1024, 500 / 1024))
        self.assertEqual(rows[500][224], (255, 0, 0))

    def test_a_pick_outside_the_frame_still_lands_on_the_canvas(self):
        # The canvas is bigger than the frame precisely so a gaze can leave the
        # picture; clamping to the frame would delete that whole half.
        _, _, rows = decode_png(dr.render_eyes_dot_png(1.0, 0.5))
        self.assertEqual(rows[512][1023], (255, 0, 0))
        self.assertEqual(rows[512][1023 - 85], (255, 255, 255))

    def test_nonsense_picks_fall_back_to_centre(self):
        for value in (None, "", float("nan"), "banana"):
            _, _, rows = decode_png(dr.render_eyes_dot_png(value, 0.5))
            self.assertEqual(rows[512][0], (255, 0, 0), f"{value!r} should clamp to the left edge")


class SunSphereTests(unittest.TestCase):
    """Against the author's own baked render.

    His Sun-Direction workflow JSON carries a 512x512 Three.js render at
    rotation -66.986, elevation 40.593, intensity 3 in its `render_b64` widget.
    These are four regions measured off it — the lit ground, the ground inside
    the cast shadow, the sphere's lit face and its dark side — which together
    pin the whole shading model: the albedos, the 1/pi, the ambient term and
    the shadow. Get any of them wrong and at least one of these moves by tens
    of levels (assuming the legacy pi-scaled lights, for one, clips the entire
    image to white at this intensity).
    """

    AUTHOR = {"rotation": -66.98612102465513, "elevation": 40.593152914452105, "intensity": 3.0}

    @classmethod
    def setUpClass(cls):
        cls.width, cls.height, cls.rows = decode_png(dr.render_sun_sphere_png(**cls.AUTHOR))

    def sample(self, x512, y512):
        """The author's render is 512; ours is that render upscaled to 1024."""
        return self.rows[y512 * 2][x512 * 2][0]

    def test_reference_is_the_size_the_lora_was_trained_on(self):
        self.assertEqual((self.width, self.height), (1024, 1024))

    def test_grey_is_neutral(self):
        for x, y in ((5, 5), (360, 255), (215, 200)):
            red, green, blue = self.rows[y * 2][x * 2]
            self.assertEqual((red, green, blue), (red, red, red))

    def test_matches_the_authors_baked_render(self):
        for label, x, y, expected in (
            ("lit ground", 5, 5, 120),
            ("lit ground, far corner", 506, 5, 120),
            ("ground in shadow", 360, 255, 34),
            ("sphere, lit face", 215, 200, 204),
            ("sphere, dark side", 315, 265, 55),
        ):
            with self.subTest(label):
                self.assertAlmostEqual(self.sample(x, y), expected, delta=2)

    def test_the_ground_fills_the_frame(self):
        # Nothing in this scene should ever be the bare clear colour: the plane
        # is 100 units wide and the camera looks down at it, so a 138 anywhere
        # means a ray missed geometry it should have hit.
        for x, y in ((0, 0), (511, 0), (0, 511), (511, 511)):
            self.assertNotEqual(self.sample(x, y), 138)

    def test_the_shadow_falls_opposite_the_light(self):
        # The author's light is up and to the LEFT of camera (negative azimuth),
        # so the shadow lies to the right of the ball.
        ball_left, ball_right = self.sample(170, 230), self.sample(370, 270)
        self.assertGreater(ball_left, ball_right)

    def test_a_higher_sun_shortens_the_shadow(self):
        low = decode_png(dr.render_sun_sphere_png(0, 10, 1.5))[2]
        high = decode_png(dr.render_sun_sphere_png(0, 80, 1.5))[2]
        # A row well in front of the ball: in shadow at dawn, lit at noon.
        self.assertLess(low[760][512][0], high[760][512][0])

    def test_angles_outside_the_trained_range_are_clamped(self):
        for rotation, elevation, intensity in ((999, -50, 99), (None, None, None)):
            png = dr.render_sun_sphere_png(rotation, elevation, intensity)
            self.assertGreater(len(png), 1000)

    def test_it_is_deterministic(self):
        # A timelapse is several runs at one seed; a renderer that wobbled
        # between them would flicker the light for no reason.
        self.assertEqual(dr.render_sun_sphere_png(30, 50, 1.5), dr.render_sun_sphere_png(30, 50, 1.5))


class DirectionLaneTests(unittest.TestCase):
    """The graph patcher: the shipped workflow, pointed at one run."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / "source.png"
        self.source.write_bytes(dr.render_eyes_dot_png(0.5, 0.5))

    def build(self, kind, direction, prompt="", **options):
        _, graph = graphs._load_auto_api_workflow(
            str(Path(__file__).resolve().parent / "workflows" / f"flux2-klein-{kind}-direction.api.json"))
        record = {"options": {}}
        graphs._apply_direction_lane(graph, kind, prompt, {
            "reference_image_paths": [str(self.source)], "direction": direction, **options}, record)
        return graph, record

    @staticmethod
    def titled(graph, title):
        return next(node for node in graph.values()
                    if (node.get("_meta") or {}).get("title") == title)

    def test_a_shipped_graph_names_the_lane_by_its_lora(self):
        for kind in ("eyes", "sun"):
            _, graph = graphs._load_auto_api_workflow(
                str(Path(__file__).resolve().parent / "workflows" / f"flux2-klein-{kind}-direction.api.json"))
            self.assertEqual(graphs._direction_lane_kind(graph), kind)

    def test_an_ordinary_graph_is_not_a_direction_lane(self):
        self.assertIsNone(graphs._direction_lane_kind({"1": {"class_type": "KSampler", "inputs": {}}}))
        self.assertIsNone(graphs._direction_lane_kind({}))

    def test_both_images_are_staged_where_comfyui_reads_them(self):
        graph, _ = self.build("eyes", {"x": 0.9, "y": 0.2})
        source = self.titled(graph, "Source image")["inputs"]["image"]
        control = self.titled(graph, "Direction reference")["inputs"]["image"]
        self.assertNotEqual(source, control)
        for name in (source, control):
            self.assertTrue((graphs.config.COMFY_INPUT_DIR / name).is_file(), name)
        self.addCleanup(lambda: [(graphs.config.COMFY_INPUT_DIR / n).unlink(missing_ok=True)
                                 for n in (source, control)])
        # The control is rendered fresh, so it carries the pick, not a template.
        self.assertEqual(decode_png((graphs.config.COMFY_INPUT_DIR / control).read_bytes())[2][204][921],
                         (255, 0, 0))

    def test_the_reference_order_is_edited_image_then_control(self):
        # ReferenceLatent stacks, and the LoRA reads the SECOND as the
        # instruction. Reversed, the model is told to edit the red dot.
        graph, _ = self.build("eyes", {"x": 0.5, "y": 0.5})
        prompt_id = next(node_id for node_id, node in graph.items()
                         if (node.get("_meta") or {}).get("title") == "Direction prompt")
        chain = []
        conditioning = [prompt_id, 0]
        while True:
            consumer = next((node for node in graph.values()
                             if node["class_type"] == "ReferenceLatent"
                             and node["inputs"]["conditioning"] == conditioning), None)
            if consumer is None:
                break
            encoder = graph[consumer["inputs"]["latent"][0]]
            chain.append(graph[encoder["inputs"]["pixels"][0]]["_meta"]["title"])
            conditioning = [next(k for k, v in graph.items() if v is consumer), 0]
        self.assertEqual(chain, ["Source image", "Direction reference"])

    def test_the_prompt_is_the_trigger_then_the_users_words(self):
        graph, _ = self.build("eyes", {}, "anime style")
        self.assertEqual(self.titled(graph, "Direction prompt")["inputs"]["text"],
                         f"{dr.EYES_TRIGGER}, anime style")
        graph, _ = self.build("sun", {})
        self.assertEqual(self.titled(graph, "Direction prompt")["inputs"]["text"], dr.SUN_TRIGGER)

    def test_strength_and_seed_reach_the_graph(self):
        graph, record = self.build("sun", {"strength": 1.25}, seed=99)
        self.assertEqual(self.titled(graph, "Direction LoRA")["inputs"]["strength_model"], 1.25)
        self.assertEqual(record["options"]["lora_strength"], 1.25)
        # Both passes share one seed, which is what makes a timelapse stable.
        self.assertEqual(self.titled(graph, "Direction noise")["inputs"]["noise_seed"], 99)
        self.assertEqual(self.titled(graph, "Overcast noise")["inputs"]["noise_seed"], 99)

    def test_the_sun_lane_flattens_the_light_first_by_default(self):
        graph, record = self.build("sun", {})
        self.assertTrue(record["options"]["flatten_light"])
        self.assertEqual(self.titled(graph, "Overcast prompt")["inputs"]["text"], dr.SUN_OVERCAST_PROMPT)
        samplers = [n for n in graph.values() if n["class_type"] == "SamplerCustomAdvanced"]
        self.assertEqual(len(samplers), 2)
        # The relight reads the flattened picture, not the original.
        self.assertEqual(self.titled(graph, "Edited image latent")["inputs"]["pixels"][0],
                         next(k for k, v in graph.items() if (v.get("_meta") or {}).get("title") == "Flattened light"))

    def test_turning_the_overcast_pass_off_prunes_it(self):
        graph, record = self.build("sun", {"flatten_light": False})
        self.assertFalse(record["options"]["flatten_light"])
        self.assertEqual(len([n for n in graph.values() if n["class_type"] == "SamplerCustomAdvanced"]), 1)
        # An orphaned pass left in the graph would still be validated by
        # ComfyUI, so the model files it names must go with it.
        self.assertNotIn("Overcast prompt", [(n.get("_meta") or {}).get("title") for n in graph.values()])
        source_id = next(k for k, v in graph.items() if (v.get("_meta") or {}).get("title") == "Source image")
        self.assertEqual(self.titled(graph, "Edited image latent")["inputs"]["pixels"][0], source_id)

    def test_a_source_inside_the_trained_range_is_left_alone(self):
        graph, record = self.build("eyes", {})
        self.assertNotIn("source_pixels_capped", record["options"])
        self.assertFalse([n for n in graph.values() if n["class_type"] == "ImageScaleToTotalPixels"])

    def test_an_oversized_source_is_capped_before_anything_reads_it(self):
        # A 12MP phone photo would otherwise sample a 12MP canvas. The cap is
        # the BigLove lane's ceiling, and it must sit ahead of BOTH readers of
        # the source — the VAE encode and the GetImageSize that sizes the
        # canvas — or the graph would sample one size and encode another.
        big = Path(self.tmp.name) / "big.png"
        big.write_bytes(direction_reference._png(2048, 2048, bytearray(b"\x40" * (2048 * 2048 * 3))))
        self.source = big
        graph, record = self.build("eyes", {})
        self.assertEqual(record["options"]["source_pixels_capped"], 2048 * 2048)
        scale = [n for n in graph.values() if n["class_type"] == "ImageScaleToTotalPixels"]
        self.assertEqual(len(scale), 1)
        self.assertAlmostEqual(scale[0]["inputs"]["megapixels"], graphs.BIGLOVE_KLEIN3_MAX_PIXELS / 1e6, places=3)
        source_id = next(k for k, v in graph.items()
                         if (v.get("_meta") or {}).get("title") == "Source image")
        scale_id = next(k for k, v in graph.items()
                        if (v.get("_meta") or {}).get("title") == "Source canvas cap")
        readers = [(k, key) for k, v in graph.items()
                   for key, value in (v.get("inputs") or {}).items()
                   if isinstance(value, list) and value and str(value[0]) == source_id]
        self.assertEqual([k for k, _ in readers], [scale_id], "something still reads the uncapped source")
        self.assertGreaterEqual(
            len([1 for v in graph.values() for value in (v.get("inputs") or {}).values()
                 if isinstance(value, list) and value and str(value[0]) == scale_id]), 2)

    def test_an_edit_with_nothing_to_edit_is_refused(self):
        _, graph = graphs._load_auto_api_workflow(
            str(Path(__file__).resolve().parent / "workflows" / "flux2-klein-eyes-direction.api.json"))
        with self.assertRaises(RuntimeError):
            graphs._apply_direction_lane(graph, "eyes", "", {"reference_image_paths": []}, {"options": {}})

    def test_the_registry_declares_what_each_lane_needs(self):
        from gateway import dependencies
        registry = dependencies.load_registry()
        for kind, lora in (("eyes", dr.EYES_LORA_FILE), ("sun", dr.SUN_LORA_FILE)):
            entry = registry[f"flux2-klein-{kind}-direction"]
            files = {Path(i["relativePath"]).name: i for i in entry["model_dependencies"]}
            self.assertIn(lora, files)
            self.assertTrue(files[lora]["url"].startswith("https://huggingface.co/"))
            self.assertEqual(len(files[lora]["sha256"]), 64)
            # The shared weights arrive by inheritance, not by repetition.
            self.assertIn("flux-2-klein-9b.safetensors", files)
            self.assertIn("qwen_3_8b_fp8mixed.safetensors", files)
            self.assertIn("flux2-vae.safetensors", files)
            # A file nobody can fetch for the user still says where it lives.
            gated = files["flux-2-klein-9b.safetensors"]
            self.assertNotIn("url", gated)
            self.assertIn("huggingface.co", gated["note"])

    def test_the_checkpoint_is_named_in_exactly_one_place(self):
        """The hot-swap property: one line decides what both lanes run.

        Not a style point. The graph JSON also names a checkpoint, and if the
        run took THAT name while the preflight checked the registry's, a lane
        could pass its preflight and then sample on a different model.
        """
        from gateway import dependencies
        raw = json.loads((Path(__file__).resolve().parent / "workflow-registry.json").read_text())
        owners = [w["id"] for w in raw["workflows"]
                  for item in (w.get("model_dependencies") or [])
                  if item.get("folder") == "diffusion_models"
                  and Path(item["relativePath"]).name.startswith("flux-2-klein-9b")]
        self.assertEqual(owners, ["flux2-klein-9b"], "the Klein 9B checkpoint is named more than once")

        registry = dependencies.load_registry()
        declared = next(i["relativePath"] for i in registry["flux2-klein-9b"]["model_dependencies"]
                        if i["folder"] == "diffusion_models")
        for kind in ("eyes", "sun"):
            definition = registry[f"flux2-klein-{kind}-direction"]
            _, graph = graphs._load_auto_api_workflow(
                str(Path(__file__).resolve().parent / "workflows" / definition["workflow_file"]))
            # Prove it is the registry and not the graph's own default that wins.
            for node in graph.values():
                if node["class_type"] == "UNETLoader":
                    node["inputs"]["unet_name"] = "something-else.safetensors"
            graphs.apply_declared_weights(graph, definition)
            loaded = {node["inputs"]["unet_name"] for node in graph.values()
                      if node["class_type"] == "UNETLoader"}
            self.assertEqual(loaded, {declared})

    def test_swapping_the_checkpoint_moves_both_lanes(self):
        """What a hot-swap actually looks like: edit the parent, rerun."""
        from gateway import dependencies
        source = Path(__file__).resolve().parent / "workflow-registry.json"
        swapped = json.loads(source.read_text())
        for entry in swapped["workflows"]:
            if entry["id"] != "flux2-klein-9b":
                continue
            for item in entry["model_dependencies"]:
                if item["folder"] == "diffusion_models":
                    item["relativePath"] = "BigLoveKlein3_bf16.safetensors"
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(swapped, handle)
            temp = Path(handle.name)
        self.addCleanup(temp.unlink, True)
        registry = dependencies.load_registry(temp)
        for kind in ("eyes", "sun"):
            definition = registry[f"flux2-klein-{kind}-direction"]
            _, graph = graphs._load_auto_api_workflow(
                str(Path(__file__).resolve().parent / "workflows" / definition["workflow_file"]))
            graphs.apply_declared_weights(graph, definition)
            self.assertEqual(
                {node["inputs"]["unet_name"] for node in graph.values()
                 if node["class_type"] == "UNETLoader"},
                {"BigLoveKlein3_bf16.safetensors"})
            # The LoRA is NOT swept along: it is the lane's identity.
            self.assertEqual(
                {node["inputs"]["lora_name"] for node in graph.values()
                 if node["class_type"] == "LoraLoaderModelOnly"},
                {dr.SUN_LORA_FILE if kind == "sun" else dr.EYES_LORA_FILE})

    def test_opting_into_inherited_weights_leaves_other_families_alone(self):
        """minimax-h3-turbo repeats four of its parent's five files and leaves
        out the latent upscaler on purpose; concatenating by default would make
        its preflight demand a model its graph never loads."""
        from gateway import dependencies
        registry = dependencies.load_registry()
        turbo = {Path(i["relativePath"]).name for i in registry["minimax-h3-turbo"]["model_dependencies"]}
        self.assertNotIn("minimax_h3_latent_upscaler_3d_bf16.safetensors", turbo)
        self.assertIn("minimax_h3_turbo_v4_step600_ema.safetensors", turbo)


class DirectionRouteTests(unittest.TestCase):
    """The request keys a direction edit needs, through the real route.

    `direction` is the whole instruction — the picker's output — and the
    comfy-api-image branch copies an allowlist of keys onto the job's options.
    A key missing from that list is dropped in silence, which would run every
    direction edit at its defaults and look like a LoRA that ignores the pick.
    """

    def test_the_pick_reaches_the_runner(self):
        from unittest.mock import patch
        import json as _json

        app = __import__("app")
        captured = {}

        def fake_start(media_type, options, runner, args):
            captured.update(media_type=media_type, options=dict(options), runner=runner, args=args)

        server = app.runtime.ThreadingHTTPServer(("127.0.0.1", 0), app.http.Handler)
        thread = app.jobs.threading.Thread(target=server.serve_forever, daemon=True)
        try:
            with patch.object(app.config, "TOKEN", "test-token"), \
                 patch.object(app.jobs, "jobs", {}), \
                 patch.object(app.jobs, "start_studio_generation_thread", side_effect=fake_start):
                thread.start()
                request = app.net.Request(
                    f"http://127.0.0.1:{server.server_port}/api/generate",
                    data=_json.dumps({
                        "backend": "comfy-api-image",
                        "prompt": "add a clear blue sky",
                        "workflow_file": "workflows/flux2-klein-sun-direction.api.json",
                        "direction": {"rotation": -70, "elevation": 30,
                                      "intensity": 2.0, "flatten_light": False, "strength": 1.25},
                    }).encode("utf-8"),
                    headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"},
                    method="POST",
                )
                with app.net.urlopen(request, timeout=5) as response:
                    self.assertEqual(response.status, 202)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertIs(captured["runner"], app.runners.run_comfy_api_image)
        self.assertEqual(captured["options"]["direction"], {
            "rotation": -70, "elevation": 30, "intensity": 2.0,
            "flatten_light": False, "strength": 1.25,
        })

    def test_the_reference_renderer_answers_on_its_own_route(self):
        from unittest.mock import patch
        app = __import__("app")
        server = app.runtime.ThreadingHTTPServer(("127.0.0.1", 0), app.http.Handler)
        thread = app.jobs.threading.Thread(target=server.serve_forever, daemon=True)
        try:
            with patch.object(app.config, "TOKEN", "test-token"):
                thread.start()
                base = f"http://127.0.0.1:{server.server_port}/api/direction-reference"
                headers = {"Authorization": "Bearer test-token"}
                for query, expected in (("kind=eyes&x=0.9&y=0.1", (1024, 1024)),
                                        ("kind=sun&rotation=30&elevation=60", (1024, 1024))):
                    with self.subTest(query):
                        request = app.net.Request(f"{base}?{query}", headers=headers)
                        with app.net.urlopen(request, timeout=30) as response:
                            self.assertEqual(response.headers.get("Content-Type"), "image/png")
                            width, height, _ = decode_png(response.read())
                            self.assertEqual((width, height), expected)
                request = app.net.Request(f"{base}?kind=nonsense", headers=headers)
                with self.assertRaises(Exception) as caught:
                    app.net.urlopen(request, timeout=10)
                self.assertEqual(getattr(caught.exception, "code", None), 400)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
