import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch
from tempfile import TemporaryDirectory

BASE = Path(__file__).resolve().parent
APPLE_SILICON_ENV = {'ZIMG_ACCELERATOR_PROFILE': 'apple-silicon'}
CUDA_ENV = {'ZIMG_ACCELERATOR_PROFILE': 'cuda'}


def load_app():
    spec = importlib.util.spec_from_file_location('zimg_app', BASE / 'app.py')
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)
    return app


class ZImageAppTests(unittest.TestCase):
    def test_hardware_profile_cuda_disables_apple_specific_routes(self):
        app = load_app()
        with patch.dict('os.environ', CUDA_ENV, clear=False):
            self.assertEqual(app.accelerator_profile(), 'cuda')
            self.assertFalse(app.supports_apple_silicon_optimizations())
            self.assertFalse(app.supports_native_mlx_biglove_route())
            self.assertFalse(app.supports_native_mlx_ltx_route())
            self.assertFalse(app.use_swift_flux2_server())

    def test_hardware_profile_apple_silicon_enables_native_routes(self):
        app = load_app()
        with patch.dict('os.environ', {**APPLE_SILICON_ENV, 'ZIMG_USE_FLUX2_SERVER': '1'}, clear=False):
            self.assertEqual(app.accelerator_profile(), 'apple-silicon')
            self.assertTrue(app.supports_apple_silicon_optimizations())
            self.assertTrue(app.supports_native_mlx_biglove_route())
            self.assertTrue(app.supports_native_mlx_ltx_route())
            self.assertTrue(app.use_swift_flux2_server())

    def test_civitai_token_uses_env_or_canonical_file_and_ignores_legacy_save(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            token_file = tmp_path / 'civitai-token'
            with patch.object(app, 'CIVITAI_TOKEN_FILE', token_file), patch.dict('os.environ', {'CIVITAI_TOKEN': ''}, clear=False):
                token_file.write_text('canonical-token\n')
                (tmp_path / 'civitai_token.txt.save').write_text('saved-token\n')
                self.assertEqual(app.civitai_token(), 'canonical-token')
                token_file.unlink()
                self.assertEqual(app.civitai_token(), '')
            with patch.dict('os.environ', {'CIVITAI_TOKEN': 'env-token'}, clear=False):
                self.assertEqual(app.civitai_token(), 'env-token')

    def test_download_progress_callback_receives_bytes_and_total(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            version = {
                'id': 123,
                'baseModel': 'ZImageTurbo',
                'model': {'type': 'LORA'},
                'downloadUrl': 'https://example.test/model.safetensors',
                'files': [{
                    'id': 456,
                    'name': 'model.safetensors',
                    'type': 'Model',
                    'primary': True,
                    'downloadUrl': 'https://example.test/model.safetensors',
                }],
            }

            class FakeResponse:
                headers = {'Content-Length': '6'}
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, n):
                    if not hasattr(self, 'chunks'):
                        self.chunks = [b'ab', b'cd', b'ef', b'']
                    return self.chunks.pop(0)

            progress = []
            with patch.object(app, 'COMFY', tmp_path), patch.object(app, 'civitai_json', return_value=version), patch.object(app, 'urlopen', return_value=FakeResponse()):
                result = app.download_civitai_version(123, 456, progress_cb=lambda done, total: progress.append((done, total)))

            self.assertTrue(result['ok'])
            self.assertEqual(Path(result['path']).read_bytes(), b'abcdef')
            self.assertEqual(Path(result['path']).parent.resolve(), (tmp_path / 'models' / 'loras').resolve())
            self.assertEqual(progress[-1], (6, 6))
            self.assertGreaterEqual(len(progress), 3)
    def test_civitai_download_url_uses_query_token_not_bearer_redirect_header(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            with patch.object(app, 'CIVITAI_TOKEN_FILE', tmp_path / 'civitai_token.txt'), patch.object(app, 'BASE', tmp_path), patch.dict('os.environ', {'CIVITAI_TOKEN': 'test-token'}, clear=False):
                url = app.civitai_download_url('https://civitai.com/api/download/models/2960556')
                self.assertIn('token=test-token', url)
                self.assertEqual(app.civitai_download_headers(), {'User-Agent': 'Hermes-ZImage-ComfyUI/1.0'})
                self.assertNotIn('Authorization', app.civitai_download_headers())

    def test_equip_lora_adds_generation_selection_and_unequip_removes_it(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            lora = tmp_path / 'models' / 'loras' / 'style.safetensors'
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b'1234')
            Path(str(lora) + '.civitai.json').write_text('{"baseModel":"ZImageTurbo"}')
            equipped_file = tmp_path / 'equipped_models.json'
            selected_file = tmp_path / 'selected_loras.json'
            with patch.object(app, 'COMFY', tmp_path), patch.object(app, 'EQUIPPED_FILE', equipped_file), patch.object(app, 'SELECTED_LORAS_FILE', selected_file), patch.object(app, 'ram_info', return_value={'total': 128 * 1024**3, 'free': 100 * 1024**3, 'used': 28 * 1024**3, 'reserved_equipped': 0}), patch.object(app, 'comfy_json', return_value={}):
                ok, msg = app.equip_model('loras/style.safetensors')
                self.assertTrue(ok)
                self.assertIn('added to generation selection', msg)
                selected = app.load_selected_loras()
                self.assertEqual([x['id'] for x in selected], ['style.safetensors'])

                changed = app.unequip_model('loras/style.safetensors')
                self.assertTrue(changed)
                self.assertEqual(app.load_selected_loras(), [])

    def test_generation_request_has_loras_checks_request_or_saved_selection(self):
        app = load_app()
        with patch.object(app, 'load_selected_loras', return_value=[]):
            self.assertFalse(app._generation_request_has_loras({'loras': []}))
            self.assertTrue(app._generation_request_has_loras({'loras': [{'id': 'style.safetensors'}]}))
        with patch.object(app, 'load_selected_loras', return_value=[{'id': 'style.safetensors'}]):
            self.assertTrue(app._generation_request_has_loras({}))

    def test_native_mlx_ltx_prompt_marker_extracts_fast_variant(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '542': {'class_type': 'PrimitiveFloat', 'inputs': {'value': 24}},
                '597': {
                    'class_type': 'VHS_VideoCombine',
                    'inputs': {
                        'filename_prefix': 'Eros/native_mlx_ltx__fast-q8-v12',
                        'frame_rate': ['542', 0],
                        'save_output': True,
                    },
                },
                '773': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                '809': {'class_type': 'PrimitiveInt', 'inputs': {'value': 480}},
                '811': {'class_type': 'PrimitiveInt', 'inputs': {'value': 832}},
                '812': {'class_type': 'PrimitiveInt', 'inputs': {'value': 42}},
                '824': {'class_type': 'PrimitiveStringMultiline', 'inputs': {'value': 'private video prompt'}},
                '536': {'class_type': 'CLIPTextEncode', 'inputs': {'text': ['824', 0]}},
                '534': {'class_type': 'EmptyLTXVLatentVideo', 'inputs': {'width': ['809', 0], 'height': ['811', 0], 'length': 233}},
            },
        }).encode('utf-8')

        with patch.dict('os.environ', APPLE_SILICON_ENV, clear=False):
            native = app.detect_native_mlx_ltx_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['variant'], 'fast-q8-v12')
        self.assertEqual(native['prompt'], 'private video prompt')
        self.assertEqual(native['image_path'], 'source.png')
        self.assertEqual(native['options']['width'], 480)
        self.assertEqual(native['options']['height'], 832)
        self.assertEqual(native['options']['frames'], 233)
        self.assertEqual(native['options']['frame_rate'], 24)
        self.assertEqual(native['options']['seed'], 42)

    def test_native_mlx_ltx_prompt_marker_is_ignored_on_cuda(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '597': {'class_type': 'VHS_VideoCombine', 'inputs': {'filename_prefix': 'Eros/native_mlx_ltx__exact-v1-merged-q8'}},
                '773': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                '824': {'class_type': 'PrimitiveStringMultiline', 'inputs': {'value': 'private video prompt'}},
            },
        }).encode('utf-8')

        with patch.dict('os.environ', CUDA_ENV, clear=False):
            self.assertIsNone(app.detect_native_mlx_ltx_prompt(body))

    def test_krea2_turbo_legacy_runtime_lora_prompt_rewrites_to_pre_lora_route(self):
        app = load_app()
        prompt = {
            '1': {
                'class_type': 'UNETLoader',
                'inputs': {
                    'unet_name': 'Krea2_Turbo_convrot_int8mixed.safetensors',
                    'weight_dtype': 'default',
                },
            },
            '2': {
                'class_type': 'CLIPLoader',
                'inputs': {
                    'clip_name': 'qwen3vl_4b_bf16.safetensors',
                    'type': 'krea2',
                    'device': 'default',
                },
            },
            '3': {
                'class_type': 'MultiLoRAStack',
                'inputs': {
                    'model': ['1', 0],
                    'clip': ['2', 0],
                    'lora_stack': '[{"on":true,"lora":"style.safetensors","strength":1}]',
                },
            },
            '4': {
                'class_type': 'TextEncodeKrea2',
                'inputs': {'clip': ['3', 1], 'prompt': 'private prompt'},
            },
            '5': {
                'class_type': 'CLIPTextEncode',
                'inputs': {'clip': ['3', 1], 'text': ''},
            },
            '7': {
                'class_type': 'KSampler',
                'inputs': {
                    'model': ['3', 0],
                    'positive': ['4', 0],
                    'negative': ['5', 0],
                    'latent_image': ['6', 0],
                    'steps': 8,
                    'cfg': 1.0,
                    'sampler_name': 'er_sde',
                    'scheduler': 'simple',
                    'denoise': 1.0,
                },
            },
        }
        body = json.dumps({'prompt': prompt}).encode('utf-8')
        with TemporaryDirectory() as td, patch.dict('os.environ', APPLE_SILICON_ENV, clear=False):
            tmp_path = Path(td)
            model_dir = tmp_path / 'models' / 'diffusion_models'
            model_dir.mkdir(parents=True)
            (model_dir / 'krea2_turbo_bf16.safetensors').write_bytes(b'placeholder')
            with patch.object(app, 'COMFY', tmp_path):
                rewritten = app.exact_comfy_krea2_turbo_pre_lora_prompt_body(body)

        data = json.loads(rewritten.decode('utf-8'))
        self.assertEqual(data['prompt']['1']['class_type'], 'OTUNetLoaderW8A8')
        self.assertEqual(data['prompt']['1']['inputs']['unet_name'], 'krea2_turbo_bf16.safetensors')
        self.assertEqual(data['prompt']['1']['inputs']['pre_lora'], ['3', 0])
        self.assertEqual(data['prompt']['3']['class_type'], 'MultiLoRAStackToPreLora')
        self.assertEqual(data['prompt']['3']['inputs']['lora_stack'], '[{"on":true,"lora":"style.safetensors","strength":1}]')
        self.assertEqual(data['prompt']['4']['inputs']['clip'], ['2', 0])
        self.assertEqual(data['prompt']['5']['inputs']['clip'], ['2', 0])
        self.assertEqual(data['prompt']['7']['inputs']['model'], ['1', 0])
        self.assertEqual(data['prompt']['7']['inputs']['sampler_name'], 'euler_ancestral')
        self.assertEqual(data['prompt']['7']['inputs']['scheduler'], 'beta')
        self.assertEqual(data['prompt']['4']['inputs']['prompt'], 'private prompt')

    def test_native_loras_from_generation_request_resolves_selected_loras(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            lora = tmp_path / 'models' / 'loras' / 'style.safetensors'
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b'1234')
            Path(str(lora) + '.civitai.json').write_text('{"baseModel":"ZImageTurbo"}')
            selected_file = tmp_path / 'selected_loras.json'
            with patch.object(app, 'COMFY', tmp_path), patch.object(app, 'SELECTED_LORAS_FILE', selected_file):
                native_loras = app._native_loras_from_generation_request({'loras': [{'id': 'style.safetensors', 'strength': 0.7}]})

        self.assertEqual(native_loras, [{'filePath': str(lora.resolve()), 'scale': 0.7}])

    def test_save_selected_loras_allows_strengths_above_ten(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            lora = tmp_path / 'models' / 'loras' / 'style.safetensors'
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b'1234')
            Path(str(lora) + '.civitai.json').write_text('{"baseModel":"ZImageTurbo"}')
            selected_file = tmp_path / 'selected_loras.json'
            with patch.object(app, 'COMFY', tmp_path), patch.object(app, 'SELECTED_LORAS_FILE', selected_file):
                selected = app.save_selected_loras([{'id': 'style.safetensors', 'strength': 25.0}])
                self.assertEqual(selected[0]['strength'], 25.0)

                selected = app.save_selected_loras([{'id': 'style.safetensors', 'strength': 250.0}])
                self.assertEqual(selected[0]['strength'], 250.0)

                selected = app.save_selected_loras([{'id': 'style.safetensors', 'strength': 250000.0}])
                self.assertEqual(selected[0]['strength'], app.LORA_STRENGTH_MAX)

                selected = app.save_selected_loras([{'id': 'style.safetensors', 'strength': -250000.0}])
                self.assertEqual(selected[0]['strength'], app.LORA_STRENGTH_MIN)

    def test_mxfp8_biglove_flux_graph_uses_exact_comfy_route_by_default(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '1': {
                    'class_type': 'UNETLoader',
                    'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors'},
                },
                '2': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'private prompt stays in memory'}},
                '4': {'class_type': 'Flux2Scheduler', 'inputs': {'steps': 8, 'width': 1024, 'height': 1536}},
                '5': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'flux2-vae.safetensors'}},
            },
        }).encode('utf-8')

        with patch.dict('os.environ', {
            **APPLE_SILICON_ENV,
            'ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT': '0',
            'ZIMG_ALLOW_MXFP8_COMFY_FALLBACK': '1',
        }, clear=False):
            self.assertIsNone(app.detect_native_mlx_biglove_prompt(body))

    def test_exact_comfy_biglove_rewrites_mxfp8_to_clean_bf16(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '1': {
                    'class_type': 'UNETLoader',
                    'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors'},
                },
                '2': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'private prompt stays untouched'}},
            },
        }).encode('utf-8')

        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            model_dir = tmp_path / 'models' / 'diffusion_models'
            model_dir.mkdir(parents=True)
            (model_dir / 'BigLoveKlein3_mxfp8.safetensors').write_bytes(b'')
            (model_dir / 'BigLoveKlein3_mxfp8_dequant_bf16.safetensors').write_bytes(b'')
            (model_dir / 'BigLoveKlein3_bf16.safetensors').write_bytes(b'')
            with patch.object(app, 'COMFY', tmp_path), patch.dict('os.environ', APPLE_SILICON_ENV, clear=False):
                rewritten = app.exact_comfy_biglove_prompt_body(body)

        data = json.loads(rewritten.decode('utf-8'))
        self.assertEqual(
            data['prompt']['1']['inputs']['unet_name'],
            'BigLoveKlein3_bf16.safetensors',
        )
        self.assertEqual(data['prompt']['2']['inputs']['text'], 'private prompt stays untouched')

    def test_exact_comfy_biglove_rewrites_canonical_mxfp8_to_clean_bf16(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '1': {
                    'class_type': 'UNETLoader',
                    'inputs': {'unet_name': 'BigLoveKlein3_mxfp8.safetensors'},
                },
            },
        }).encode('utf-8')

        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            model_dir = tmp_path / 'models' / 'diffusion_models'
            model_dir.mkdir(parents=True)
            (model_dir / 'BigLoveKlein3_mxfp8_dequant_bf16.safetensors').write_bytes(b'')
            (model_dir / 'BigLoveKlein3_bf16.safetensors').write_bytes(b'')
            with patch.object(app, 'COMFY', tmp_path), patch.dict('os.environ', APPLE_SILICON_ENV, clear=False):
                rewritten = app.exact_comfy_biglove_prompt_body(body)

        data = json.loads(rewritten.decode('utf-8'))
        self.assertEqual(
            data['prompt']['1']['inputs']['unet_name'],
            'BigLoveKlein3_bf16.safetensors',
        )

    def test_exact_comfy_biglove_rewrites_dequant_sidecar_file_to_clean_bf16(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '1': {
                    'class_type': 'UNETLoader',
                    'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_dequant_bf16.safetensors'},
                },
            },
        }).encode('utf-8')

        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            model_dir = tmp_path / 'models' / 'diffusion_models'
            model_dir.mkdir(parents=True)
            (model_dir / 'BigLoveKlein3_mxfp8_dequant_bf16.safetensors').write_bytes(b'')
            (model_dir / 'BigLoveKlein3_bf16.safetensors').write_bytes(b'')
            with patch.object(app, 'COMFY', tmp_path), patch.dict('os.environ', APPLE_SILICON_ENV, clear=False):
                rewritten = app.exact_comfy_biglove_prompt_body(body)

        data = json.loads(rewritten.decode('utf-8'))
        self.assertEqual(
            data['prompt']['1']['inputs']['unet_name'],
            'BigLoveKlein3_bf16.safetensors',
        )

    def test_mxfp8_biglove_simple_graph_can_opt_into_native_route(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '1': {
                    'class_type': 'UNETLoader',
                    'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors'},
                },
                '2': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'private prompt stays in memory'}},
                '4': {'class_type': 'EmptyFlux2LatentImage', 'inputs': {'width': 1024, 'height': 1536}},
            },
        }).encode('utf-8')

        with patch.dict('os.environ', {
            **APPLE_SILICON_ENV,
            'ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT': '1',
            'ZIMG_ALLOW_MXFP8_COMFY_FALLBACK': '0',
        }, clear=False):
            native = app.detect_native_mlx_biglove_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['image_path'], 'source.png')
        self.assertEqual(native['options']['steps'], 4)
        self.assertEqual(native['options']['requested_width'], 1024)
        self.assertEqual(native['options']['requested_height'], 1536)
        self.assertEqual(native['options']['width'], 448)
        self.assertEqual(native['options']['height'], 672)

    def test_mxfp8_biglove_exact_feature_graph_can_force_native_speed_route(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '1': {
                    'class_type': 'UNETLoader',
                    'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors'},
                },
                '2': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'private prompt stays in memory'}},
                '4': {'class_type': 'Flux2Scheduler', 'inputs': {'steps': 8, 'width': 1024, 'height': 1536}},
                '5': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'flux2-vae.safetensors'}},
            },
        }).encode('utf-8')

        with patch.dict('os.environ', {
            **APPLE_SILICON_ENV,
            'ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT': '1',
            'ZIMG_ALLOW_MXFP8_COMFY_FALLBACK': '0',
        }, clear=False):
            native = app.detect_native_mlx_biglove_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['options']['steps'], 4)
        self.assertEqual(native['options']['requested_width'], 1024)
        self.assertEqual(native['options']['requested_height'], 1536)
        self.assertEqual(native['options']['width'], 448)
        self.assertEqual(native['options']['height'], 672)

    def test_mxfp8_biglove_lora_graph_uses_native_route_with_lora_payload(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            lora = tmp_path / 'models' / 'loras' / 'style.safetensors'
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b'1234')
            body = json.dumps({
                'prompt': {
                    '1': {
                        'class_type': 'UNETLoader',
                        'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors'},
                    },
                    '2': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                    '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'private prompt stays in memory'}},
                    '4': {'class_type': 'EmptyFlux2LatentImage', 'inputs': {'width': 1024, 'height': 1536}},
                    '5': {
                        'class_type': 'LoraLoader',
                        'inputs': {
                            'lora_name': 'style.safetensors',
                            'strength_model': 0.8,
                            'strength_clip': 1.0,
                            'model': ['1', 0],
                        },
                    },
                },
            }).encode('utf-8')

            with patch.object(app, 'COMFY', tmp_path), patch.dict('os.environ', {
                **APPLE_SILICON_ENV,
                'ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT': '1',
                'ZIMG_ALLOW_MXFP8_COMFY_FALLBACK': '0',
            }, clear=False):
                native = app.detect_native_mlx_biglove_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['options']['loras'], [{'filePath': str(lora.resolve()), 'scale': 0.8}])

    def test_mxfp8_biglove_multi_lora_stack_string_uses_native_route_with_lora_payload(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            lora = tmp_path / 'models' / 'loras' / 'style.safetensors'
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b'1234')
            body = json.dumps({
                'prompt': {
                    '1': {
                        'class_type': 'UNETLoader',
                        'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors'},
                    },
                    '2': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                    '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'private prompt stays in memory'}},
                    '4': {'class_type': 'EmptyFlux2LatentImage', 'inputs': {'width': 1024, 'height': 1536}},
                    '5': {
                        'class_type': 'MultiLoRAStackModelOnly',
                        'inputs': {
                            'model': ['1', 0],
                            'lora_stack': json.dumps([
                                {'on': True, 'lora': 'style.safetensors', 'strength': 0.65},
                            ]),
                        },
                    },
                },
            }).encode('utf-8')

            with patch.object(app, 'COMFY', tmp_path), patch.dict('os.environ', {
                **APPLE_SILICON_ENV,
                'ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT': '1',
                'ZIMG_ALLOW_MXFP8_COMFY_FALLBACK': '0',
            }, clear=False):
                native = app.detect_native_mlx_biglove_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['options']['loras'], [{'filePath': str(lora.resolve()), 'scale': 0.65}])

    def test_mxfp8_biglove_lora_prompt_token_is_stripped_and_sent_native(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            lora = tmp_path / 'models' / 'loras' / 'style.safetensors'
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b'1234')
            body = json.dumps({
                'prompt': {
                    '1': {
                        'class_type': 'UNETLoader',
                        'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors'},
                    },
                    '2': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                    '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '<lora:style:0.6> private prompt stays in memory'}},
                    '4': {'class_type': 'EmptyFlux2LatentImage', 'inputs': {'width': 1024, 'height': 1536}},
                },
            }).encode('utf-8')

            with patch.object(app, 'COMFY', tmp_path), patch.dict('os.environ', {
                **APPLE_SILICON_ENV,
                'ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT': '1',
                'ZIMG_ALLOW_MXFP8_COMFY_FALLBACK': '0',
            }, clear=False):
                native = app.detect_native_mlx_biglove_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['prompt'], 'private prompt stays in memory')
        self.assertEqual(native['options']['loras'], [{'filePath': str(lora.resolve()), 'scale': 0.6}])
        self.assertEqual(native['options']['width'], 448)
        self.assertEqual(native['options']['height'], 672)

    def test_mxfp8_biglove_preserves_repeated_reference_conditioning_images(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '1': {
                    'class_type': 'UNETLoader',
                    'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors'},
                },
                '2': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'private prompt stays in memory'}},
                '4': {'class_type': 'ImageScaleToTotalPixels', 'inputs': {'image': ['2', 0]}},
                '5': {'class_type': 'ImageScaleToTotalPixels', 'inputs': {'image': ['2', 0]}},
                '6': {
                    'class_type': 'Flux2ReferenceConditioning',
                    'inputs': {'conditioning': ['3', 0], 'pixels': ['4', 0]},
                },
                '7': {
                    'class_type': 'Flux2ReferenceConditioning',
                    'inputs': {'conditioning': ['6', 0], 'pixels': ['5', 0]},
                },
                '8': {'class_type': 'Flux2Scheduler', 'inputs': {'steps': 4, 'width': 1024, 'height': 1536}},
            },
        }).encode('utf-8')

        with patch.dict('os.environ', {
            **APPLE_SILICON_ENV,
            'ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT': '1',
            'ZIMG_ALLOW_MXFP8_COMFY_FALLBACK': '0',
        }, clear=False):
            native = app.detect_native_mlx_biglove_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['image_path'], 'source.png')
        self.assertEqual(native['options']['image_paths'], ['source.png', 'source.png'])

    def test_mxfp8_biglove_exact_comfy_fallback_blocks_native_intercept(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '1': {
                    'class_type': 'UNETLoader',
                    'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors'},
                },
                '2': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'private prompt stays in memory'}},
                '4': {'class_type': 'Flux2Scheduler', 'inputs': {'steps': 8, 'width': 1024, 'height': 1536}},
                '5': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'flux2-vae.safetensors'}},
            },
        }).encode('utf-8')

        with patch.dict('os.environ', {
            **APPLE_SILICON_ENV,
            'ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT': '1',
            'ZIMG_ALLOW_MXFP8_COMFY_FALLBACK': '1',
        }, clear=False):
            self.assertIsNone(app.detect_native_mlx_biglove_prompt(body))

    def test_mxfp8_biglove_native_intercept_is_blocked_on_cuda_profile(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '1': {
                    'class_type': 'UNETLoader',
                    'inputs': {'unet_name': 'BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors'},
                },
                '2': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'private prompt stays in memory'}},
                '4': {'class_type': 'EmptyFlux2LatentImage', 'inputs': {'width': 1024, 'height': 1536}},
            },
        }).encode('utf-8')

        with patch.dict('os.environ', {
            **CUDA_ENV,
            'ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT': '1',
            'ZIMG_ALLOW_MXFP8_COMFY_FALLBACK': '0',
        }, clear=False):
            self.assertIsNone(app.detect_native_mlx_biglove_prompt(body))

    def test_exact_comfy_biglove_rewrite_is_blocked_on_cuda_profile(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '1': {
                    'class_type': 'UNETLoader',
                    'inputs': {'unet_name': 'BigLoveKlein3_mxfp8.safetensors'},
                },
            },
        }).encode('utf-8')

        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            model_dir = tmp_path / 'models' / 'diffusion_models'
            model_dir.mkdir(parents=True)
            (model_dir / 'BigLoveKlein3_bf16.safetensors').write_bytes(b'')
            with patch.object(app, 'COMFY', tmp_path), patch.dict('os.environ', CUDA_ENV, clear=False):
                rewritten = app.exact_comfy_biglove_prompt_body(body)

        data = json.loads(rewritten.decode('utf-8'))
        self.assertEqual(data['prompt']['1']['inputs']['unet_name'], 'BigLoveKlein3_mxfp8.safetensors')


if __name__ == '__main__':
    unittest.main()


class WorkflowEnvelopeIndexTests(unittest.TestCase):
    def test_envelope_records_extracted_from_comfy_history(self):
        envelope = {"encrypted": True, "format": "comfyui-mobile-encrypted-workflow", "payload": "abc"}
        hist = {
            "pid-1": {
                "prompt": [1, "pid-1", {}, {"extra_pnginfo": {"workflow": envelope}}],
                "outputs": {"10": {"images": [{"filename": "a_00001_.png", "type": "output"}]}},
            },
            "pid-2": {  # plaintext workflow must NOT be indexed
                "prompt": [2, "pid-2", {}, {"extra_pnginfo": {"workflow": {"nodes": []}}}],
                "outputs": {"10": {"images": [{"filename": "b_00001_.png"}]}},
            },
            "pid-3": {  # already seen prompt ids are skipped
                "prompt": [3, "pid-3", {}, {"extra_pnginfo": {"workflow": envelope}}],
                "outputs": {"10": {"images": [{"filename": "c_00001_.png"}]}},
            },
        }
        records = load_app()._envelope_records_from_history(hist, seen_prompt_ids={"pid-3"})
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["prompt_id"], "pid-1")
        self.assertEqual(records[0]["filenames"], ["a_00001_.png"])
        self.assertIs(records[0]["workflow"], envelope)
