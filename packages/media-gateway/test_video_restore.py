"""SeedVR2 restore planning and assembly arithmetic.

These are the numbers a render cannot recover from being wrong about: an
off-lattice batch is refused by the model, a chunk plan that loses frames
delivers a master shorter than its own soundtrack, and a seam plan that
double-counts the overlap delivers one longer. All three still look like
working code.
"""

import unittest

from video_restore import (
    TENSORRT_MIN_CHUNKS_TO_BUILD,
    torch_compile_supported,
    TENSORRT_NODE_CLASS,
    resolve_offload_device,
    tensorrt_policy,
    BATCH_MODULUS,
    BATCH_OFFSET,
    DEFAULT_DIT,
    RestoreError,
    CLOUD_LANE,
    SINK_CLIP,
    SINK_CLOUD,
    SINK_FRAMES,
    assembled_frame_count,
    assembly_steps,
    blend_expression,
    blend_filter_complex,
    build_restore_graph,
    finishing_filters,
    first_unfinished_chunk,
    master_encode_args,
    new_project,
    project_progress,
    cloud_chunk_request,
    cloud_quote_request,
    restore_plan,
    sink_assembles_locally,
    sink_supports_seams,
    snap_batch_size,
    target_dimensions,
    trim_filter,
)


def plan(**overrides):
    args = {"frames": 480, "fps": 24.0, "width": 640, "height": 360, "options": {}}
    args.update(overrides)
    return restore_plan(**args)


class BatchLatticeTest(unittest.TestCase):
    def test_every_snapped_batch_is_4n_plus_1(self):
        for value in range(1, 60):
            snapped = snap_batch_size(value)
            self.assertEqual((snapped - BATCH_OFFSET) % BATCH_MODULUS, 0, value)
            self.assertLessEqual(snapped, value)

    def test_snapping_never_returns_zero_frames(self):
        self.assertEqual(snap_batch_size(0), 1)
        self.assertEqual(snap_batch_size(-4), 1)
        self.assertEqual(snap_batch_size("nonsense"), 5)

    def test_chunk_length_is_whole_batches(self):
        built = plan(options={"batch_size": 9, "chunk_seconds": 4})
        self.assertEqual(built["chunk_frames"] % 9, 0)
        # …and so is the lead-in, so the context occupies whole batches.
        self.assertEqual(built["context_frames"] % 9, 0)


class TargetSizeTest(unittest.TestCase):
    def test_short_edge_drives_the_scale(self):
        self.assertEqual(target_dimensions(640, 360, 1440), (2560, 1440))
        self.assertEqual(target_dimensions(360, 640, 1440), (1440, 2560))

    def test_max_edge_pulls_both_dimensions_back(self):
        # 21:9 at a 1440 short edge would be 3360 wide; capped to 2560 the short
        # edge has to give, which is the whole point of the cap.
        width, height = target_dimensions(2560, 1080, 1440, 2560)
        self.assertEqual(width, 2560)
        self.assertLess(height, 1440)

    def test_dimensions_are_even(self):
        width, height = target_dimensions(1080, 1920, 1080)
        self.assertEqual(width % 2, 0)
        self.assertEqual(height % 2, 0)

    def test_a_sourceless_clip_is_refused_rather_than_guessed(self):
        with self.assertRaises(RestoreError):
            target_dimensions(0, 0, 1080)
        with self.assertRaises(RestoreError):
            restore_plan(frames=0, fps=24, width=640, height=360)


class ChunkPlanTest(unittest.TestCase):
    def test_chunks_cover_every_source_frame_exactly_once(self):
        built = plan(frames=487)
        covered = []
        for chunk in built["chunks"]:
            start = chunk["source_start"] + chunk["context"]
            covered.extend(range(start, start + chunk["output_length"]))
        self.assertEqual(covered, list(range(487)))

    def test_the_first_chunk_has_no_lead_in(self):
        built = plan()
        self.assertEqual(built["chunks"][0]["context"], 0)
        self.assertEqual(built["chunks"][0]["source_start"], 0)

    def test_later_chunks_re_read_context_frames_before_their_body(self):
        built = plan(options={"batch_size": 5, "chunk_seconds": 2})
        second = built["chunks"][1]
        self.assertEqual(second["context"], built["context_frames"])
        self.assertEqual(second["source_start"], second["index"] * built["chunk_frames"] - second["context"])
        self.assertEqual(second["source_length"], second["context"] + second["output_length"])

    def test_a_clip_shorter_than_one_chunk_is_a_single_chunk(self):
        built = plan(frames=17, options={"chunk_seconds": 30})
        self.assertEqual(len(built["chunks"]), 1)
        self.assertEqual(built["chunks"][0]["output_length"], 17)

    def test_a_preview_is_one_chunk_at_the_playhead_with_no_context(self):
        built = plan(options={"preview_frames": 48, "preview_start_frame": 120})
        self.assertTrue(built["preview"])
        self.assertEqual(len(built["chunks"]), 1)
        self.assertEqual(built["chunks"][0]["source_start"], 120)
        self.assertEqual(built["chunks"][0]["context"], 0)
        self.assertEqual(built["seam_frames"], 0)

    def test_a_preview_near_the_end_cannot_ask_for_frames_that_do_not_exist(self):
        built = plan(frames=200, options={"preview_frames": 120, "preview_start_frame": 190})
        chunk = built["chunks"][0]
        self.assertLessEqual(chunk["source_start"] + chunk["source_length"], 200)
        self.assertGreater(chunk["source_length"], 0)

    def test_a_playhead_in_the_last_frames_slides_back_rather_than_overrunning(self):
        built = plan(frames=200, options={"batch_size": 5, "preview_frames": 60, "preview_start_frame": 199})
        chunk = built["chunks"][0]
        self.assertEqual(chunk["source_start"], 195)
        self.assertLessEqual(chunk["source_start"] + chunk["source_length"], 200)

    def test_a_single_chunk_project_reports_no_seam_at_all(self):
        # Not just "no blend steps": the panel SHOWS this number, and a
        # 3-frame dissolve on a clip with no boundary is a promise nothing keeps.
        built = plan(frames=40, options={"chunk_seconds": 30, "seam_frames": 4})
        self.assertEqual(len(built["chunks"]), 1)
        self.assertEqual(built["seam_frames"], 0)

    def test_a_preview_chunk_length_is_the_preview_length(self):
        built = plan(frames=480, options={"preview_frames": 48, "preview_start_frame": 0})
        self.assertEqual(built["chunk_frames"], built["chunks"][0]["output_length"])


class AssemblyTest(unittest.TestCase):
    def test_a_hard_cut_master_is_exactly_as_long_as_the_source(self):
        built = plan(frames=487, options={"seam_frames": 0})
        self.assertEqual(assembled_frame_count(built), 487)

    def test_a_dissolved_master_is_still_exactly_as_long_as_the_source(self):
        built = plan(frames=487, options={"batch_size": 5, "seam_frames": 3})
        self.assertEqual(built["seam_frames"], 3)
        self.assertEqual(assembled_frame_count(built), 487)

    def test_a_dissolve_can_only_span_frames_two_chunks_both_restored(self):
        # Asking for a longer dissolve than there is overlap is clamped, not
        # honoured with frames one chunk never saw.
        built = plan(options={"batch_size": 5, "context_frames": 5, "seam_frames": 30})
        self.assertLessEqual(built["seam_frames"], built["context_frames"])
        for step in assembly_steps(built):
            if step["kind"] == "blend":
                self.assertGreaterEqual(step["next_start"], 0)

    def test_blend_segments_name_matching_frames_in_both_chunks(self):
        built = plan(frames=480, options={"batch_size": 5, "chunk_seconds": 2, "seam_frames": 3})
        chunks = {chunk["index"]: chunk for chunk in built["chunks"]}
        for step in assembly_steps(built):
            if step["kind"] != "blend":
                continue
            here = chunks[step["chunk"]]
            following = chunks[step["next_chunk"]]
            # Absolute source frame of the first blended frame, computed from
            # each side independently — they have to agree.
            self.assertEqual(
                here["source_start"] + step["start"],
                following["source_start"] + step["next_start"],
            )

    def test_segments_are_in_playback_order(self):
        built = plan(frames=480, options={"seam_frames": 2})
        steps = assembly_steps(built)
        self.assertEqual([step["chunk"] for step in steps], sorted(step["chunk"] for step in steps))

    def test_a_single_chunk_project_has_nothing_to_blend(self):
        built = plan(frames=48, options={"chunk_seconds": 30, "seam_frames": 4})
        steps = assembly_steps(built)
        self.assertEqual([step["kind"] for step in steps], ["trim"])

    def test_every_segment_rebuilds_its_timestamps_from_the_frame_index(self):
        # Regression, measured 2026-08-31: without this, Matroska's millisecond
        # timestamps left two trimmed chunks a millisecond apart, blend's
        # framesync invented a frame per seam, and a 24-frame master came out
        # 26 frames long against a 24-frame soundtrack.
        self.assertIn("settb=AVTB", trim_filter(7, 3))
        self.assertIn("setpts=N/(FRAME_RATE*TB)", trim_filter(7, 3))
        complex_filter = blend_filter_complex(
            {"kind": "blend", "chunk": 0, "start": 7, "next_chunk": 1, "next_start": 2, "length": 3},
        )
        self.assertEqual(complex_filter.count("settb=AVTB"), 2, "BOTH sides or the seam drifts again")

    def test_the_two_sides_of_a_seam_are_trimmed_to_the_same_length(self):
        step = {"kind": "blend", "chunk": 0, "start": 7, "next_chunk": 1, "next_start": 2, "length": 3}
        complex_filter = blend_filter_complex(step)
        self.assertIn("trim=start_frame=7:end_frame=10", complex_filter)
        self.assertIn("trim=start_frame=2:end_frame=5", complex_filter)

    def test_the_dissolve_starts_on_a_and_ends_on_b(self):
        expression = blend_expression(5)
        self.assertIn("N/4", expression)
        # N=0 -> all A, N=length-1 -> all B.
        self.assertEqual(eval(expression.replace("N", "0"), {"A": 1.0, "B": 0.0}), 1.0)
        self.assertEqual(eval(expression.replace("N", "4"), {"A": 1.0, "B": 0.0}), 0.0)


class GraphTest(unittest.TestCase):
    def setUp(self):
        self.plan = plan()
        self.chunk = self.plan["chunks"][0]

    def test_the_frames_sink_never_writes_an_output_file(self):
        graph = build_restore_graph(
            source_name="chunk-0000.mp4", plan=self.plan, chunk=self.chunk,
            sink=SINK_FRAMES, device="mps", offload_device="mps",
        )
        classes = {node["class_type"] for node in graph.values()}
        self.assertIn("PreviewImage", classes)
        self.assertNotIn("SaveVideo", classes)

    def test_the_clip_sink_writes_one_video_per_chunk(self):
        graph = build_restore_graph(
            source_name="chunk-0000.mp4", plan=self.plan, chunk=self.chunk,
            sink=SINK_CLIP, filename_prefix="restore/p1-0000", device="cuda:0", offload_device="cpu",
        )
        classes = {node["class_type"] for node in graph.values()}
        self.assertIn("SaveVideo", classes)
        self.assertNotIn("PreviewImage", classes)
        self.assertEqual(graph["7"]["inputs"]["fps"], self.plan["fps"])

    def test_the_lane_device_reaches_every_model_loader(self):
        graph = build_restore_graph(
            source_name="c.mp4", plan=self.plan, chunk=self.chunk,
            sink=SINK_FRAMES, device="cuda:1", offload_device="cpu",
        )
        self.assertEqual(graph["3"]["inputs"]["device"], "cuda:1")
        self.assertEqual(graph["4"]["inputs"]["device"], "cuda:1")

    def test_the_offload_device_reaches_both_loaders(self):
        # Measured 2026-08-31 on the local MPS lane: the VAE loader refuses
        # cache_model=True with offload_device="none", and it defaults to
        # "none", so leaving the key off the VAE (while setting it on the DiT)
        # fails the render at node 4 minutes in.
        graph = build_restore_graph(
            source_name="c.mp4", plan=self.plan, chunk=self.chunk,
            sink=SINK_FRAMES, device="mps", offload_device="mps", cache_models=True,
        )
        self.assertEqual(graph["3"]["inputs"]["offload_device"], "mps")
        self.assertEqual(graph["4"]["inputs"]["offload_device"], "mps")

    def test_caching_with_nowhere_to_cache_is_refused_before_it_is_a_job(self):
        with self.assertRaises(RestoreError):
            build_restore_graph(
                source_name="c.mp4", plan=self.plan, chunk=self.chunk,
                sink=SINK_FRAMES, device="mps", offload_device="none", cache_models=True,
            )
        # …and turning caching off makes "none" legal again.
        graph = build_restore_graph(
            source_name="c.mp4", plan=self.plan, chunk=self.chunk,
            sink=SINK_FRAMES, device="mps", offload_device="none", cache_models=False,
        )
        self.assertEqual(graph["4"]["inputs"]["cache_model"], False)

    def test_the_batch_and_resolution_the_plan_settled_are_the_ones_sent(self):
        built = plan(options={"batch_size": 9, "resolution": "4k", "color_correction": "wavelet"})
        graph = build_restore_graph(
            source_name="c.mp4", plan=built, chunk=built["chunks"][0],
            sink=SINK_FRAMES, device="mps", offload_device="mps",
        )
        sampler = graph["5"]["inputs"]
        self.assertEqual(sampler["batch_size"], 9)
        self.assertEqual(sampler["resolution"], 2160)
        self.assertEqual(sampler["color_correction"], "wavelet")

    def test_compiling_the_model_is_refused_with_the_measurement_behind_it(self):
        """MEASURED on a rented RTX 5090, four chunks, one clip each: sdpa ran
        10.56/10.50/10.06/10.44s and finished; sdpa+compile took 15.42s on chunk
        one and CRASHED on chunk two with `CompatibleDiT does not support
        len()`. There is no arrangement where a chunked render benefits."""
        supported, why = torch_compile_supported()
        self.assertFalse(supported)
        self.assertIn("crashes", why)
        # …and the reason names the speed cost too, not just the crash.
        self.assertIn("slower", why)

    def test_the_compile_node_carries_every_input_comfyui_requires(self):
        """MEASURED 2026-08-31 on a rented 5090: omitting these two made ComfyUI
        reject the graph outright with a 400, which means the studio's "Compile
        the model" toggle had never worked for anyone. A node's REQUIRED inputs
        are not optional just because they have defaults in its schema."""
        graph = build_restore_graph(
            source_name="c.mp4", plan=self.plan, chunk=self.chunk,
            sink=SINK_FRAMES, offload_device="cpu", torch_compile=True,
        )
        settings = next(n for n in graph.values()
                        if n["class_type"] == "SeedVR2TorchCompileSettings")["inputs"]
        for required in ("backend", "mode", "fullgraph", "dynamic",
                         "dynamo_cache_size_limit", "dynamo_recompile_limit"):
            self.assertIn(required, settings, required)

    def test_torch_compile_is_wired_to_both_loaders_or_to_neither(self):
        off = build_restore_graph(
            source_name="c.mp4", plan=self.plan, chunk=self.chunk,
            sink=SINK_FRAMES, offload_device="cpu",
        )
        self.assertNotIn("torch_compile_args", off["3"]["inputs"])
        on = build_restore_graph(
            source_name="c.mp4", plan=self.plan, chunk=self.chunk,
            sink=SINK_FRAMES, offload_device="cpu", torch_compile=True,
        )
        self.assertEqual(on["3"]["inputs"]["torch_compile_args"], ["6", 0])
        self.assertEqual(on["4"]["inputs"]["torch_compile_args"], ["6", 0])

    def test_a_chunk_with_no_staged_source_is_refused(self):
        with self.assertRaises(RestoreError):
            build_restore_graph(
                source_name="", plan=self.plan, chunk=self.chunk,
                sink=SINK_FRAMES, offload_device="cpu",
            )

    def test_an_unknown_sink_is_refused_rather_than_defaulted(self):
        with self.assertRaises(RestoreError):
            build_restore_graph(
                source_name="c.mp4", plan=self.plan, chunk=self.chunk,
                sink="somewhere", offload_device="cpu",
            )

    def test_an_unknown_model_falls_back_to_a_real_one(self):
        built = plan(options={"model": "not-a-model"})
        self.assertEqual(built["model"], DEFAULT_DIT)

    def test_a_short_model_name_resolves_to_its_filename(self):
        self.assertEqual(
            plan(options={"model": "7b-sharp-fp16"})["model"],
            "seedvr2_ema_7b_sharp_fp16.safetensors",
        )


class OffloadTest(unittest.TestCase):
    def test_an_mps_lane_caches_onto_itself_because_it_offers_nothing_else(self):
        # Unified memory: the node deliberately excludes "cpu" there, so the
        # only legal cache home is the compute device.
        self.assertEqual(
            resolve_offload_device(["none", "mps"], "", device="mps", cache_models=True),
            "mps",
        )

    def test_a_cuda_lane_parks_the_weights_in_system_ram(self):
        self.assertEqual(
            resolve_offload_device(["none", "cpu", "cuda:0"], "", device="cuda:0", cache_models=True),
            "cpu",
        )

    def test_without_caching_the_weights_stay_where_they_ran(self):
        self.assertEqual(
            resolve_offload_device(["none", "cpu", "cuda:0"], "", device="cuda:0", cache_models=False),
            "none",
        )

    def test_a_request_the_lane_cannot_honour_is_dropped(self):
        self.assertEqual(
            resolve_offload_device(["none", "mps"], "cuda:3", device="mps", cache_models=True),
            "mps",
        )

    def test_asking_for_none_while_caching_is_overruled_not_obeyed(self):
        self.assertEqual(
            resolve_offload_device(["none", "cpu"], "none", device="cuda:0", cache_models=True),
            "cpu",
        )


class TensorRtTest(unittest.TestCase):
    """When the VAE decode is accelerated, and — every time it is not — why.

    "Why is my render not using TensorRT" has five different answers and only
    some of them are fixable; a policy that could not say which is a policy the
    studio has to guess about.
    """

    LANE = {"tensorrt": {"available": True, "reason": "", "speedup": 1.8}}
    NO_TRT = {"tensorrt": {"available": False, "installed": False,
                           "reason": "this machine does not have the Hivemind TensorRT node"}}

    def long(self, **overrides):
        return plan(frames=2000, options={"chunk_seconds": 4, **overrides})

    def test_a_long_render_on_a_capable_machine_builds_an_engine(self):
        policy = tensorrt_policy(self.long(), self.LANE)
        self.assertTrue(policy["enabled"])
        self.assertTrue(policy["may_build"])

    def test_a_machine_without_tensorrt_carries_its_own_reason_forward(self):
        policy = tensorrt_policy(self.long(), self.NO_TRT)
        self.assertFalse(policy["enabled"])
        # The lane's sentence, not a generic one: it names the fixable thing.
        self.assertIn("Hivemind TensorRT node", policy["reason"])

    def test_a_preview_never_pays_for_an_engine_but_will_use_one(self):
        preview = plan(options={"preview_frames": 48})
        policy = tensorrt_policy(preview, self.LANE)
        # Enabled, so a cached engine from a full render of the same shape is
        # still used — which is the common case when previewing mid-project.
        self.assertTrue(policy["enabled"])
        self.assertFalse(policy["may_build"])
        self.assertIn("will not spend minutes", policy["reason"])

    def test_a_render_too_short_to_amortize_a_build_does_not_start_one(self):
        short = plan(frames=200, options={"chunk_seconds": 4})
        self.assertLess(len(short["chunks"]), TENSORRT_MIN_CHUNKS_TO_BUILD)
        policy = tensorrt_policy(short, self.LANE)
        self.assertTrue(policy["enabled"])
        self.assertFalse(policy["may_build"])
        self.assertIn("too short", policy["reason"])

    def test_switching_it_off_is_honoured_over_a_capable_machine(self):
        policy = tensorrt_policy(self.long(), self.LANE, requested=False)
        self.assertFalse(policy["enabled"])
        self.assertIn("switched off", policy["reason"])

    def test_an_unknown_lane_is_treated_as_incapable_rather_than_assumed(self):
        for capability in (None, {}, {"tensorrt": {}}):
            policy = tensorrt_policy(self.long(), capability)
            self.assertFalse(policy["enabled"], capability)
            self.assertTrue(policy["reason"].strip(), capability)

    def test_every_outcome_says_something(self):
        for capability, requested in [
            (self.LANE, True), (self.NO_TRT, True), (self.LANE, False), (None, True),
        ]:
            policy = tensorrt_policy(self.long(), capability, requested=requested)
            self.assertTrue(policy["reason"].strip())

    def test_the_node_only_appears_in_the_graph_when_it_is_wanted(self):
        built = self.long()
        off = build_restore_graph(
            source_name="c.mp4", plan=built, chunk=built["chunks"][0],
            sink=SINK_FRAMES, device="cuda:0", offload_device="cpu", tensorrt=False,
        )
        self.assertNotIn(TENSORRT_NODE_CLASS, {n["class_type"] for n in off.values()})
        self.assertEqual(off["5"]["inputs"]["vae"], ["4", 0])

    def test_the_node_sits_between_the_vae_loader_and_the_upscaler(self):
        built = self.long()
        on = build_restore_graph(
            source_name="c.mp4", plan=built, chunk=built["chunks"][0],
            sink=SINK_FRAMES, device="cuda:0", offload_device="cpu",
            tensorrt=True, tensorrt_may_build=True,
        )
        node = next(n for n in on.values() if n["class_type"] == TENSORRT_NODE_CLASS)
        self.assertEqual(node["inputs"]["vae"], ["4", 0])
        self.assertTrue(node["inputs"]["build_engine"])
        # …and the upscaler now reads the VAE THROUGH it, or the policy would
        # be set on a node nothing depends on and never execute.
        self.assertEqual(on["5"]["inputs"]["vae"], ["4b", 0])

    def test_a_preview_graph_carries_the_engine_but_not_the_permission_to_build(self):
        built = plan(options={"preview_frames": 48})
        graph = build_restore_graph(
            source_name="c.mp4", plan=built, chunk=built["chunks"][0],
            sink=SINK_FRAMES, device="cuda:0", offload_device="cpu",
            tensorrt=True, tensorrt_may_build=False,
        )
        node = next(n for n in graph.values() if n["class_type"] == TENSORRT_NODE_CLASS)
        self.assertTrue(node["inputs"]["enabled"])
        self.assertFalse(node["inputs"]["build_engine"])


class FinishingTest(unittest.TestCase):
    def test_nothing_asked_for_is_nothing_applied(self):
        self.assertEqual(finishing_filters({}, width=2560, height=1440), [])
        self.assertEqual(finishing_filters(None, width=2560, height=1440), [])

    def test_the_chain_runs_fit_then_sharpen_then_soften_then_grain(self):
        chain = finishing_filters(
            {"sharpen": 0.5, "grain": 0.4, "skin_softening": 0.3, "aspect": "pad", "aspect_ratio": "9:16"},
            width=2560, height=1440,
        )
        kinds = [item.split("=")[0] for item in chain]
        self.assertEqual(kinds, ["scale", "pad", "unsharp", "smartblur", "noise"])

    def test_softening_preserves_edges_rather_than_blurring_them(self):
        chain = finishing_filters({"skin_softening": 1.0}, width=1920, height=1080)
        # A negative luma threshold is what makes smartblur blur FLAT areas.
        self.assertIn("lt=-", chain[0])

    def test_grain_moves_between_frames(self):
        chain = finishing_filters({"grain": 1.0}, width=1920, height=1080)
        self.assertIn("allf=t", chain[0])

    def test_a_reframe_never_asks_for_pixels_the_model_did_not_make(self):
        chain = finishing_filters(
            {"aspect": "crop", "aspect_ratio": "1:1"}, width=2560, height=1440,
        )
        crop = [item for item in chain if item.startswith("crop=")][0]
        width, height = (int(value) for value in crop[len("crop="):].split(":"))
        self.assertLessEqual(width, 2560)
        self.assertLessEqual(height, 1440)
        self.assertEqual(width, height)

    def test_an_unparseable_ratio_leaves_the_frame_alone(self):
        self.assertEqual(finishing_filters({"aspect": "pad", "aspect_ratio": "wide"}, width=100, height=100), [])

    def test_quality_is_a_crf_inside_a_sane_range(self):
        self.assertIn("16", master_encode_args({}))
        self.assertIn("8", master_encode_args({"quality": 1}))
        self.assertIn("30", master_encode_args({"quality": 99}))


class ProjectTest(unittest.TestCase):
    def setUp(self):
        self.plan = plan(frames=480)
        self.project = new_project(
            project_id="p1", source={"frames": 480}, plan=self.plan,
            options={}, lane="default", sink=SINK_FRAMES,
        )

    def test_a_fresh_project_resumes_from_the_first_chunk(self):
        self.assertEqual(first_unfinished_chunk(self.project), 0)

    def test_resume_skips_the_chunks_already_on_disk(self):
        self.project["chunks"]["0"] = {"file": "out-0000.mov"}
        self.project["chunks"]["1"] = {"file": "out-0001.mov"}
        self.assertEqual(first_unfinished_chunk(self.project), 2)

    def test_a_gap_resumes_at_the_gap_not_at_the_end(self):
        self.project["chunks"]["0"] = {"file": "a"}
        self.project["chunks"]["2"] = {"file": "c"}
        self.assertEqual(first_unfinished_chunk(self.project), 1)

    def test_a_finished_project_has_nothing_to_resume(self):
        for chunk in self.plan["chunks"]:
            self.project["chunks"][str(chunk["index"])] = {"file": "x"}
        self.assertEqual(first_unfinished_chunk(self.project), -1)

    def test_progress_extrapolates_only_from_this_project_own_chunks(self):
        self.assertEqual(project_progress(self.project)["eta_seconds"], 0)
        self.project["chunks"]["0"] = {"file": "a", "elapsed_seconds": 60}
        progress = project_progress(self.project)
        self.assertEqual(progress["chunks_done"], 1)
        self.assertEqual(progress["seconds_per_chunk"], 60.0)
        self.assertEqual(progress["eta_seconds"], 60.0 * (progress["chunks_total"] - 1))


if __name__ == "__main__":
    unittest.main()


# --- the hosted lane ---------------------------------------------------------

class TheCloudSinkKeepsWhatTheSealedOneCannot(unittest.TestCase):
    """The three sinks differ in exactly one thing: who may read a chunk.

    That single fact decides two features, and getting it wrong is invisible
    until somebody's render silently hard-cuts or their re-finish costs another
    hour of GPU. A hosted chunk comes back as ordinary bytes, so it keeps both.
    """

    def test_a_hosted_chunk_can_be_dissolved_and_assembled_here(self):
        self.assertTrue(sink_supports_seams(SINK_CLOUD))
        self.assertTrue(sink_assembles_locally(SINK_CLOUD))

    def test_only_the_sealed_sink_gives_either_up(self):
        self.assertTrue(sink_supports_seams(SINK_FRAMES))
        self.assertTrue(sink_assembles_locally(SINK_FRAMES))
        self.assertFalse(sink_supports_seams(SINK_CLIP))
        self.assertFalse(sink_assembles_locally(SINK_CLIP))

    def test_the_cloud_lane_is_not_a_comfy_lane_name(self):
        # It has no /object_info, no URL and nothing running between renders.
        # A name that collided with a real lane would make a pin ambiguous.
        self.assertEqual(CLOUD_LANE, "cloud")
        self.assertNotIn(CLOUD_LANE, ("default", "video", "image"))


class WhatTheHostedServiceIsTold(unittest.TestCase):
    def setUp(self):
        self.plan = restore_plan(frames=120, fps=24.0, width=640, height=360, options={
            "resolution": "1080p", "batch_size": 5, "chunk_seconds": 2, "seed": 99,
            "model": "seedvr2_ema_3b_fp8_e4m3fn.safetensors", "color_correction": "wavelet",
        })

    def test_it_asks_for_every_frame_including_the_lead_in(self):
        # source_length, not output_length. The assembler needs BOTH copies of a
        # chunk boundary to dissolve the seam; a request that asked only for the
        # body would turn every hosted render into hard cuts, and the panel
        # would still be promising a dissolve.
        chunk = self.plan["chunks"][1]
        self.assertGreater(chunk["context"], 0)
        request = cloud_chunk_request(plan=self.plan, chunk=chunk, project_id="r123")
        self.assertEqual(request["frames"], chunk["source_length"])
        self.assertNotEqual(request["frames"], chunk["output_length"])

    def test_it_carries_the_settings_that_decide_the_pixels(self):
        request = cloud_chunk_request(plan=self.plan, chunk=self.plan["chunks"][0], project_id="r123")
        self.assertEqual(request["model"], "seedvr2_ema_3b_fp8_e4m3fn.safetensors")
        self.assertEqual(request["color_correction"], "wavelet")
        self.assertEqual(request["seed"], 99)
        self.assertEqual(request["batch_size"], 5)
        self.assertEqual(request["short_edge"], 1080)
        self.assertEqual(request["fps"], 24.0)

    def test_it_carries_both_sizes_because_both_move_the_price(self):
        # The encode scales with the SOURCE pixels and the decode with the
        # output ones. A request that sent only the output size would be priced
        # as though a 4K source cost the same to read as a 480p one.
        request = cloud_chunk_request(plan=self.plan, chunk=self.plan["chunks"][0])
        self.assertEqual((request["source_width"], request["source_height"]), (640, 360))
        self.assertEqual((request["width"], request["height"]), (self.plan["width"], self.plan["height"]))

    def test_it_never_carries_a_graph(self):
        # The container builds the graph from this repo's own builder. A caller
        # who could POST a graph could run anything they liked on the GPU.
        request = cloud_chunk_request(plan=self.plan, chunk=self.plan["chunks"][0])
        self.assertNotIn("prompt", request)
        self.assertNotIn("graph", request)
        for value in request.values():
            self.assertNotIsInstance(value, dict)

    def test_the_whole_render_is_quoted_in_one_request(self):
        # One round trip rather than one per chunk: the studio has to put a
        # number on the button while the file is still in the picker.
        quote = cloud_quote_request(self.plan)
        self.assertEqual(len(quote["chunk_frames"]), len(self.plan["chunks"]))
        self.assertEqual(
            quote["chunk_frames"],
            [chunk["source_length"] for chunk in self.plan["chunks"]],
        )
        self.assertEqual(quote["model"], self.plan["model"])

    def test_a_project_reference_is_truncated_rather_than_trusted(self):
        request = cloud_chunk_request(
            plan=self.plan, chunk=self.plan["chunks"][0], project_id="r" * 400)
        self.assertLessEqual(len(request["project_ref"]), 64)
