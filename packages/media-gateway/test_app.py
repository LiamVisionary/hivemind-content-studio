import importlib.util
import io
import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from tempfile import TemporaryDirectory
from types import SimpleNamespace

BASE = Path(__file__).resolve().parent
APPLE_SILICON_ENV = {'ZIMG_ACCELERATOR_PROFILE': 'apple-silicon'}
CUDA_ENV = {'ZIMG_ACCELERATOR_PROFILE': 'cuda'}


def load_app():
    spec = importlib.util.spec_from_file_location('zimg_app', BASE / 'app.py')
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)
    return app


class ZImageAppTests(unittest.TestCase):
    def test_ltx_mlx_runtime_prefers_persistent_checkout_over_temp(self):
        app = load_app()
        with TemporaryDirectory() as td:
            root = Path(td)
            studio = root / 'comfy' / 'hivemind-content-studio'
            persistent = root / 'comfy' / 'ltx-2-mlx-opt'
            legacy_temp = root / 'tmp' / 'ltx-2-mlx-opt'
            studio.mkdir(parents=True)
            persistent.mkdir(parents=True)
            legacy_temp.mkdir(parents=True)
            (persistent / 'pyproject.toml').write_text('[project]\nname="ltx-pipelines-mlx"\n')
            (legacy_temp / 'pyproject.toml').write_text('[project]\nname="ltx-pipelines-mlx"\n')

            resolved = app.resolve_ltx2_mlx_dir(
                env={},
                studio_root=studio,
                home=root / 'home',
                temp_root=root / 'tmp',
            )

            self.assertEqual(resolved, persistent.resolve())

    def test_ltx_mlx_runtime_honors_explicit_override(self):
        app = load_app()
        with TemporaryDirectory() as td:
            override = Path(td) / 'custom-ltx-runtime'
            resolved = app.resolve_ltx2_mlx_dir(
                env={'LTX2_MLX_DIR': str(override)},
                studio_root=Path(td) / 'studio',
                home=Path(td) / 'home',
                temp_root=Path(td) / 'tmp',
            )

            self.assertEqual(resolved, override.resolve())

    def test_active_output_is_not_encryptable_until_native_writer_finishes(self):
        app = load_app()
        with TemporaryDirectory() as td:
            output_dir = Path(td) / 'output'
            output_dir.mkdir()
            output = output_dir / 'render.mp4'
            output.write_bytes(b'x' * 1000)

            with patch.object(app, 'OUT_DIR', output_dir), patch.object(app, 'COMFY_OUTPUT_DIR', Path(td) / 'comfy'):
                app.mark_output_active(output)
                self.assertTrue(app.output_path_is_active(output))
                self.assertFalse(app.is_encryptable_output(output))

                app.mark_output_inactive(output)
                self.assertFalse(app.output_path_is_active(output))
                self.assertTrue(app.is_encryptable_output(output))

    def test_generate_api_accepts_prompt_over_previous_character_limit(self):
        app = load_app()
        long_prompt = 'detailed image prompt ' * 200
        completed = app.threading.Event()
        captured = {}

        def fake_run_generation(job_id, prompt, loras, options):
            captured.update(job_id=job_id, prompt=prompt, loras=loras, options=options)
            completed.set()

        server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        server_thread = app.threading.Thread(target=server.serve_forever, daemon=True)
        with patch.object(app, 'TOKEN', 'test-token'), \
             patch.object(app, 'jobs', {}), \
             patch.object(app, 'load_selected_loras', return_value=[]), \
             patch.object(app, 'run_generation', side_effect=fake_run_generation):
            server_thread.start()
            try:
                request = app.Request(
                    f'http://127.0.0.1:{server.server_port}/api/generate',
                    data=json.dumps({'prompt': long_prompt}).encode('utf-8'),
                    headers={
                        'Authorization': 'Bearer test-token',
                        'Content-Type': 'application/json',
                    },
                    method='POST',
                )
                with app.urlopen(request, timeout=5) as response:
                    payload = json.loads(response.read().decode('utf-8'))
                    self.assertEqual(response.status, 202)
                self.assertTrue(completed.wait(1))
            finally:
                server.shutdown()
                server.server_close()
                server_thread.join(timeout=2)

        self.assertGreater(len(long_prompt), 1200)
        self.assertEqual(captured['prompt'], long_prompt.strip())
        self.assertEqual(captured['job_id'], payload['id'])

    def test_private_media_is_encrypted_before_serve_and_never_cacheable(self):
        app = load_app()

        class Handler:
            def __init__(self):
                self.headers = {}
                self.wfile = io.BytesIO()
                self.status = None

            def send_response(self, status): self.status = status
            def cors_headers(self): pass
            def send_header(self, key, value): self.headers[key] = value
            def end_headers(self): pass

        handler = Handler()
        logical_path = Path('/private/output.mp4')
        with patch.object(app, 'encrypt_output_file', return_value=logical_path) as encrypt, \
             patch.object(app, 'decrypt_output_bytes', return_value=(b'private-video', 'video/mp4')):
            app.send_output_file(handler, logical_path)

        encrypt.assert_called_once_with(logical_path)
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.headers['Cache-Control'], 'private, no-store, max-age=0')
        self.assertEqual(handler.headers['Pragma'], 'no-cache')
        self.assertEqual(handler.wfile.getvalue(), b'private-video')

    def test_output_encryption_failure_deletes_plaintext_and_fails_closed(self):
        app = load_app()
        with TemporaryDirectory() as td:
            output = Path(td) / 'private.png'
            output.write_bytes(b'private-image')
            with patch.object(app, 'OUT_DIR', Path(td)), \
                 patch.object(app, 'COMFY_OUTPUT_DIR', Path(td)), \
                 patch.object(app, 'OUTPUT_ENCRYPTION_ENABLED', True), \
                 patch.object(app, 'encrypt_output_file', side_effect=RuntimeError('cipher unavailable')):
                    with self.assertRaises(RuntimeError):
                        app.encrypt_outputs([output])
            self.assertFalse(output.exists())

    def test_access_log_redacts_query_credentials(self):
        app = load_app()
        handler = object.__new__(app.Handler)
        handler.client_address = ('127.0.0.1', 1234)
        handler.log_date_time_string = lambda: 'now'
        stderr = io.StringIO()

        with patch.object(app.sys, 'stderr', stderr):
            handler.log_message('"%s"', 'GET /image/a.png?token=super-secret&name=ok HTTP/1.1')

        rendered = stderr.getvalue()
        self.assertNotIn('super-secret', rendered)
        self.assertIn('token=%5Bredacted%5D', rendered)

    def test_private_input_deletion_is_confined_to_comfy_input(self):
        app = load_app()
        with TemporaryDirectory() as td:
            input_root = Path(td) / 'input'
            input_root.mkdir()
            staged = input_root / 'media-studio-input-private.png'
            staged.write_bytes(b'private-reference')
            outside = Path(td) / 'outside.png'
            outside.write_bytes(b'keep')

            with patch.object(app, 'COMFY_INPUT_DIR', input_root):
                self.assertTrue(app.delete_private_input(staged.name))
                with self.assertRaises(ValueError):
                    app.delete_private_input('../outside.png')

            self.assertFalse(staged.exists())
            self.assertTrue(outside.exists())

    def test_private_input_cleanup_covers_reference_and_ingredient_sheet_staging(self):
        # The Ingredients lane stages private references as media-studio-reference-*
        # and composes the conditioning sheet as mcp_ingredients_*; both are plaintext
        # in ComfyUI's input dir, so delete-input and the sweeper must cover them.
        app = load_app()
        with TemporaryDirectory() as td:
            input_root = Path(td) / 'input'
            input_root.mkdir()
            reference = input_root / 'media-studio-reference-abc123.png'
            sheet = input_root / 'mcp_ingredients_1721600000_deadbeef.png'
            inline = input_root / 'media-studio-inline-0123456789abcdef.png'
            unrelated = input_root / 'user-photo.png'
            for path in (reference, sheet, inline, unrelated):
                path.write_bytes(b'pixels')
            old = time.time() - app.PRIVATE_INPUT_MAX_AGE_SECONDS - 60
            for path in (reference, sheet, inline, unrelated):
                os.utime(path, (old, old))

            with patch.object(app, 'COMFY_INPUT_DIR', input_root):
                self.assertTrue(app.delete_private_input(reference.name))
                self.assertEqual(app.cleanup_staged_private_inputs_once(), 2)

            self.assertFalse(reference.exists())
            self.assertFalse(sheet.exists())
            self.assertFalse(inline.exists())
            # User-named uploads outlive pipeline staging, but only up to the
            # longer upload budget — they are plaintext the generator must read,
            # so they must not live in the input directory indefinitely.
            self.assertTrue(unrelated.exists())

    def test_user_named_uploads_expire_on_the_upload_budget(self):
        # Uploads through the generic ComfyUI route keep the caller's filename and
        # match no staging prefix. They used to persist forever in plaintext.
        app = load_app()
        with TemporaryDirectory() as td:
            input_root = Path(td) / 'input'
            (input_root / '.ltx-reference').mkdir(parents=True)
            photo = input_root / 'bigref.jpg'
            nested = input_root / '.ltx-reference' / 'clip.mkv'
            sealed = input_root / 'kept.png.e2e'
            fresh = input_root / 'today.png'
            for path in (photo, nested, sealed, fresh):
                path.write_bytes(b'pixels')
            stale = time.time() - app.PRIVATE_INPUT_UPLOAD_MAX_AGE_SECONDS - 60
            for path in (photo, nested, sealed):
                os.utime(path, (stale, stale))

            with patch.object(app, 'COMFY_INPUT_DIR', input_root):
                removed = app.cleanup_staged_private_inputs_once()

            self.assertEqual(removed, 2)
            self.assertFalse(photo.exists(), 'stale user upload must be expired')
            self.assertFalse(nested.exists(), 'nested reference folders must be swept too')
            self.assertTrue(sealed.exists(), 'sealed envelopes are already client-only')
            self.assertTrue(fresh.exists(), 'recent uploads stay usable')

    def test_private_media_defaults_do_not_allow_plaintext_grace_or_token_printing(self):
        source = (BASE / 'app.py').read_text(encoding='utf-8')
        comfy_proxy = (BASE / 'app/comfy/[[...path]]/route.js').read_text(encoding='utf-8')

        self.assertIn('ZIMG_OUTPUT_PLAINTEXT_GRACE", "0"', source)
        self.assertNotIn('print(f"Token: {TOKEN}"', source)
        self.assertNotIn('max-age=10800', comfy_proxy)
        self.assertIn("cache-control', 'private, no-store, max-age=0'", comfy_proxy)

    def test_tailscale_https_proxy_routes_next_assets_to_gateway(self):
        proxy_source = (BASE / 'tailscale-https-proxy.js').read_text(encoding='utf-8')
        self.assertIn("pathname === '/_next'", proxy_source)
        self.assertIn("pathname.startsWith('/_next/')", proxy_source)
        self.assertIn("'/api/models'", proxy_source)
        self.assertIn("'/api/civitai'", proxy_source)
        self.assertIn("'/image'", proxy_source)

    def test_output_encryption_covers_images_and_videos(self):
        app = load_app()
        with TemporaryDirectory() as td:
            output_root = Path(td)
            image = output_root / 'image.png'
            video = output_root / 'video.mp4'
            model = output_root / 'model.safetensors'
            with patch.object(app, 'OUT_DIR', output_root), patch.object(app, 'OUTPUT_ENCRYPTION_ENABLED', True):
                self.assertTrue(app.is_encryptable_output(image))
                self.assertTrue(app.is_encryptable_output(video))
                self.assertFalse(app.is_encryptable_output(model))

    def test_exact_output_lookup_is_confined_to_private_media_roots(self):
        app = load_app()
        with TemporaryDirectory() as td:
            output_root = Path(td) / 'output'
            output_root.mkdir()
            logical = output_root / 'nested-video.mp4'
            logical.with_name(logical.name + '.zenc').write_bytes(b'opaque-encrypted-payload')
            outside = Path(td) / 'outside.mp4'
            outside.write_bytes(b'outside')
            with patch.object(app, 'OUT_DIR', output_root), patch.object(app, 'COMFY_OUTPUT_DIR', output_root):
                self.assertEqual(app.find_exact_output_logical_path(logical), logical.resolve())
                self.assertIsNone(app.find_exact_output_logical_path(outside))
                self.assertIsNone(app.find_exact_output_logical_path(output_root / 'model.safetensors'))

    def test_output_encryption_preserves_original_mtime(self):
        app = load_app()
        with TemporaryDirectory() as td:
            output_root = Path(td)
            source = output_root / 'preserve-time.mp4'
            source.write_bytes(b'plaintext-video')
            original_ns = 1_700_000_000_123_456_789
            os.utime(source, ns=(original_ns, original_ns))

            def fake_openssl(command, **_kwargs):
                target = Path(command[command.index('-out') + 1])
                target.write_bytes(b'opaque-encrypted-payload' * 2)
                return subprocess.CompletedProcess(command, 0, stdout='', stderr='')

            with patch.object(app, 'OUT_DIR', output_root), \
                 patch.object(app, 'COMFY_OUTPUT_DIR', output_root), \
                 patch.object(app, 'OUTPUT_ENCRYPTION_ENABLED', True), \
                 patch.object(app, 'output_encryption_password', return_value='test-secret'), \
                 patch.object(app.subprocess, 'run', side_effect=fake_openssl):
                app.encrypt_output_file(source)

            encrypted = source.with_name(source.name + '.zenc')
            self.assertFalse(source.exists())
            self.assertEqual(encrypted.stat().st_mtime_ns, original_ns)

    def test_delete_output_everywhere_purges_copies_history_workflow_index_and_preview_cache(self):
        app = load_app()
        with TemporaryDirectory() as td:
            root = Path(td)
            comfy_output = root / 'comfy-output'
            native_output = root / 'native-output'
            preview_cache = root / 'preview-cache'
            comfy_output.mkdir()
            native_output.mkdir()
            preview_cache.mkdir()
            (comfy_output / 'purge-me.png.zenc').write_bytes(b'ciphertext-a')
            (native_output / 'purge-me.png.zenc').write_bytes(b'ciphertext-b')
            (native_output / 'keep-me.png.zenc').write_bytes(b'ciphertext-c')
            (preview_cache / 'cached-preview.jpg').write_bytes(b'preview')
            history_file = root / 'history.jsonl'
            history_file.write_text(
                json.dumps({'id': 'job-1', 'outputs': [str(native_output / 'purge-me.png'), str(native_output / 'keep-me.png')], 'prompt': '[private]'}) + '\n',
                encoding='utf-8',
            )
            workflow_index = root / 'output-workflow-index.jsonl'
            workflow_index.write_text(
                json.dumps({'prompt_id': 'prompt-1', 'filenames': ['purge-me.png'], 'workflow': {'encrypted': True, 'format': 'comfyui-mobile-encrypted-workflow'}}) + '\n',
                encoding='utf-8',
            )
            app._workflow_index = {'purge-me.png': {'encrypted': True}}
            app._workflow_index_records = {'purge-me.png': {'prompt_id': 'prompt-1', 'lane': 'default'}}
            app._workflow_index_prompts = {'prompt-1'}

            with patch.object(app, 'OUT_DIR', native_output), \
                 patch.object(app, 'COMFY_OUTPUT_DIR', comfy_output), \
                 patch.object(app, 'HISTORY_FILE', history_file), \
                 patch.object(app, 'WORKFLOW_INDEX_FILE', workflow_index), \
                 patch.object(app, 'PREVIEW_CACHE_ROOTS', [preview_cache]), \
                 patch.object(app, '_delete_prompt_ids_from_comfy', return_value=[]):
                result = app.delete_output_everywhere('purge-me.png')

            self.assertTrue(result['ok'])
            self.assertEqual(result['deleted_files'], 2)
            self.assertFalse((comfy_output / 'purge-me.png.zenc').exists())
            self.assertFalse((native_output / 'purge-me.png.zenc').exists())
            self.assertTrue((native_output / 'keep-me.png.zenc').exists())
            remaining_history = json.loads(history_file.read_text(encoding='utf-8'))
            self.assertEqual([Path(value).name for value in remaining_history['outputs']], ['keep-me.png'])
            self.assertEqual(workflow_index.read_text(encoding='utf-8'), '')
            self.assertFalse(any(preview_cache.iterdir()))
            self.assertNotIn('purge-me.png', app._workflow_index)

    def test_delete_output_everywhere_cleans_shared_prompt_trace_without_deleting_sibling_output(self):
        app = load_app()
        with TemporaryDirectory() as td:
            root = Path(td)
            output_root = root / 'output'
            output_root.mkdir()
            (output_root / 'purge-me.png.zenc').write_bytes(b'ciphertext-a')
            (output_root / 'keep-me.png.zenc').write_bytes(b'ciphertext-b')
            workflow_index = root / 'output-workflow-index.jsonl'
            workflow_index.write_text(
                json.dumps({
                    'prompt_id': 'shared-prompt',
                    'filenames': ['purge-me.png', 'keep-me.png'],
                    'workflow': {'encrypted': True, 'format': 'comfyui-mobile-encrypted-workflow'},
                }) + '\n',
                encoding='utf-8',
            )
            app._workflow_index = {
                'purge-me.png': {'encrypted': True},
                'keep-me.png': {'encrypted': True},
            }
            app._workflow_index_records = {
                'purge-me.png': {'prompt_id': 'shared-prompt', 'lane': 'default'},
                'keep-me.png': {'prompt_id': 'shared-prompt', 'lane': 'default'},
            }
            app._workflow_index_prompts = {'shared-prompt'}

            with patch.object(app, 'OUT_DIR', output_root), \
                 patch.object(app, 'COMFY_OUTPUT_DIR', output_root), \
                 patch.object(app, 'HISTORY_FILE', root / 'missing-history.jsonl'), \
                 patch.object(app, 'WORKFLOW_INDEX_FILE', workflow_index), \
                 patch.object(app, 'PREVIEW_CACHE_ROOTS', []), \
                 patch.object(app, '_delete_prompt_ids_from_comfy', return_value=[]) as delete_from_comfy:
                result = app.delete_output_everywhere('purge-me.png')

            self.assertTrue(result['ok'])
            delete_from_comfy.assert_called_once_with({'shared-prompt'})
            self.assertFalse((output_root / 'purge-me.png.zenc').exists())
            self.assertTrue((output_root / 'keep-me.png.zenc').exists())
            record = json.loads(workflow_index.read_text(encoding='utf-8'))
            self.assertEqual(record['filenames'], ['keep-me.png'])
            self.assertNotIn('purge-me.png', app._workflow_index)
            self.assertIn('keep-me.png', app._workflow_index)
            self.assertIn('shared-prompt', app._workflow_index_prompts)

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

    def test_civitai_token_uses_env_alias_or_canonical_file_and_ignores_legacy_save(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            token_file = tmp_path / 'civitai-token'
            with patch.object(app, 'CIVITAI_TOKEN_FILE', token_file), patch.dict('os.environ', {
                'CIVITAI_TOKEN': '',
                'CIVITAI_API_TOKEN': '',
                'CIVITAI_API_KEY': '',
                'CIVITAI_KEY': '',
                'CIVITAI_ACCESS_TOKEN': '',
                'CIVITAI_BEARER_TOKEN': '',
                'CIVITAI_PAT': '',
            }, clear=False):
                token_file.write_text('canonical-token\n')
                (tmp_path / 'civitai_token.txt.save').write_text('saved-token\n')
                self.assertEqual(app.civitai_token(), 'canonical-token')
                self.assertTrue(app.civitai_token_status()['configured'])
                token_file.unlink()
                self.assertEqual(app.civitai_token(), '')
            with patch.dict('os.environ', {'CIVITAI_TOKEN': 'env-token'}, clear=False):
                self.assertEqual(app.civitai_token(), 'env-token')
            with patch.dict('os.environ', {'CIVITAI_TOKEN': '', 'CIVITAI_API_KEY': 'api-key-token'}, clear=False):
                self.assertEqual(app.civitai_token(), 'api-key-token')
            with patch.dict('os.environ', {'CIVITAI_TOKEN': '', 'CIVITAI_API_KEY': '', 'CIVITAI_PAT': 'pat-token'}, clear=False):
                self.assertEqual(app.civitai_token(), 'pat-token')

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

    def test_civitai_expected_type_accepts_lora_families_and_rejects_checkpoints(self):
        app = load_app()

        app.validate_civitai_expected_type({'model': {'type': 'LORA'}}, 'LORA')
        app.validate_civitai_expected_type({'model': {'type': 'LoCon'}}, 'LORA')
        with self.assertRaisesRegex(RuntimeError, 'Expected a Civitai LoRA URL'):
            app.validate_civitai_expected_type({'model': {'type': 'Checkpoint'}}, 'LORA')

    def test_downloads_without_an_expected_type_accept_any_model_and_file_it_by_type(self):
        # The studio downloader does not pin a type: a checkpoint URL must download
        # and land in models/checkpoints instead of being rejected as "not a LoRA".
        app = load_app()

        app.validate_civitai_expected_type({'model': {'type': 'Checkpoint'}}, None)
        app.validate_civitai_expected_type({'model': {'type': 'VAE'}}, '')

        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            version = {
                'id': 321,
                'baseModel': 'SDXL 1.0',
                'model': {'type': 'Checkpoint'},
                'downloadUrl': 'https://example.test/checkpoint.safetensors',
                'files': [{
                    'id': 654,
                    'name': 'checkpoint.safetensors',
                    'type': 'Model',
                    'primary': True,
                    'downloadUrl': 'https://example.test/checkpoint.safetensors',
                }],
            }

            class FakeResponse:
                headers = {'Content-Length': '4'}
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, n):
                    if not hasattr(self, 'chunks'):
                        self.chunks = [b'abcd', b'']
                    return self.chunks.pop(0)

            with patch.object(app, 'COMFY', tmp_path), patch.object(app, 'civitai_json', return_value=version), patch.object(app, 'urlopen', return_value=FakeResponse()):
                result = app.download_civitai_version(321, 654)

            self.assertTrue(result['ok'])
            self.assertEqual(result['modelType'], 'Checkpoint')
            self.assertEqual(Path(result['directory']).resolve(), (tmp_path / 'models' / 'checkpoints').resolve())
            self.assertEqual(Path(result['path']).parent.resolve(), (tmp_path / 'models' / 'checkpoints').resolve())

    def test_cancelling_a_download_stops_the_transfer_and_removes_the_partial_file(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            version = {
                'id': 555,
                'baseModel': 'SDXL 1.0',
                'model': {'type': 'LORA', 'name': 'Look'},
                'downloadUrl': 'https://example.test/model.safetensors',
                'files': [{
                    'id': 777,
                    'name': 'model.safetensors',
                    'type': 'Model',
                    'primary': True,
                    'downloadUrl': 'https://example.test/model.safetensors',
                }],
            }

            class FakeResponse:
                headers = {'Content-Length': '12'}
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, n):
                    if not hasattr(self, 'chunks'):
                        self.chunks = [b'aa', b'bb', b'cc', b'']
                    return self.chunks.pop(0)

            # Cancel after the first chunk lands, the way a click mid-download does.
            reads = []
            def should_cancel():
                reads.append(1)
                return len(reads) > 1

            with patch.object(app, 'COMFY', tmp_path), patch.object(app, 'civitai_json', return_value=version), patch.object(app, 'urlopen', return_value=FakeResponse()):
                with self.assertRaises(app.DownloadCancelled):
                    app.download_civitai_version(555, 777, should_cancel=should_cancel)

            loras = tmp_path / 'models' / 'loras'
            self.assertEqual(sorted(p.name for p in loras.iterdir()), [])  # no file, no .part leftover

    def test_cancel_flag_only_applies_to_live_jobs_and_names_come_from_the_version(self):
        app = load_app()
        with patch.dict(app.download_jobs, {}, clear=True):
            app.download_jobs['live'] = {'id': 'live', 'status': 'running'}
            app.download_jobs['done'] = {'id': 'done', 'status': 'success'}
            with patch.object(app, 'save_download_jobs_unlocked', lambda: None):
                self.assertTrue(app.cancel_civitai_download_job('live').get('cancel_requested'))
                self.assertTrue(app.download_job_cancel_requested('live'))
                # A finished job is not retroactively cancellable.
                self.assertNotIn('cancel_requested', app.cancel_civitai_download_job('done'))
                self.assertFalse(app.download_job_cancel_requested('done'))
                self.assertIsNone(app.cancel_civitai_download_job('missing'))

        self.assertEqual(
            app.civitai_version_display_name({'name': 'v2', 'model': {'name': 'Look'}}),
            'Look · v2',
        )
        # No duplicated name when the version label already carries the model name.
        self.assertEqual(
            app.civitai_version_display_name({'name': 'Look v2', 'model': {'name': 'Look v2'}}),
            'Look v2',
        )
        self.assertEqual(app.civitai_version_display_name({}), '')

    def test_lora_cards_carry_their_installed_version_identity(self):
        app = load_app()
        # Sidecar shape Civitai actually writes: modelId on the version, and a
        # nested `model` with a name but NO id.
        record = app.compact_lora_record({
            'id': 'look.safetensors',
            'name': 'look.safetensors',
            'path': '/x/look.safetensors',
            'baseModel': 'SDXL 1.0',
            'metadata': {'modelVersion': {'id': 111, 'modelId': 42, 'name': 'v2.0', 'model': {'name': 'Look', 'type': 'LORA'}}},
        })

        self.assertEqual(record['versionId'], '111')
        self.assertEqual(record['versionName'], 'v2.0')
        self.assertEqual(record['modelId'], '42')
        self.assertEqual(record['displayName'], 'Look')
        # Older/hand-written sidecars that nest the id instead still resolve.
        nested = app.compact_lora_record({
            'id': 'old.safetensors', 'name': 'old.safetensors', 'path': '/x/old.safetensors',
            'metadata': {'modelVersion': {'id': 7, 'model': {'id': 99, 'name': 'Old'}}},
        })
        self.assertEqual(nested['modelId'], '99')
        # Hand-placed files have no Civitai identity and must not fake one.
        bare = app.compact_lora_record({'id': 'hand.safetensors', 'name': 'hand.safetensors', 'path': '/x/hand.safetensors', 'metadata': {}})
        self.assertEqual((bare['versionId'], bare['versionName'], bare['modelId']), ('', '', ''))

    def test_update_detection_compares_version_ids_not_list_order(self):
        app = load_app()
        versions = [
            {'id': '300', 'name': 'v3'},
            {'id': '100', 'name': 'v1'},
            {'id': '200', 'name': 'v2'},
        ]

        self.assertEqual(app.newer_civitai_version(versions, '100')['id'], '300')
        self.assertEqual(app.newer_civitai_version(versions, '200')['id'], '300')
        self.assertIsNone(app.newer_civitai_version(versions, '300'))  # newest installed
        self.assertIsNone(app.newer_civitai_version(versions, '400'))  # ahead of Civitai
        self.assertIsNone(app.newer_civitai_version(versions, ''))     # unknown install
        self.assertIsNone(app.newer_civitai_version([], '100'))

    def test_a_newer_version_for_another_base_model_is_not_an_update(self):
        # Real shape (Civitai model 2173844 / 1862761): one model publishes a version
        # per base model, so the newest id is often a DIFFERENT adapter. Replacing a
        # ZImageTurbo LoRA with the Krea 2 version would break the workflow using it.
        app = load_app()
        versions = [
            {'id': '3075498', 'name': 'v1.0 Krea2', 'baseModel': 'Krea 2'},
            {'id': '2882216', 'name': 'v0.5 Anima', 'baseModel': 'Anima'},
            {'id': '2683561', 'name': 'v1.0 ZImageBase', 'baseModel': 'ZImageBase'},
            {'id': '2526600', 'name': 'Z-Image (Asian edition)', 'baseModel': 'ZImageTurbo'},
            {'id': '2465980', 'name': 'v1.0 Z-Image Turbo', 'baseModel': 'ZImageTurbo'},
        ]

        # Installed is already the newest ZImageTurbo version: no update.
        self.assertIsNone(app.newer_civitai_version(versions, '2526600', ['ZImageTurbo']))
        # The older ZImageTurbo build does have one — and it is the ZImageTurbo build,
        # not the higher-id Krea 2 one.
        found = app.newer_civitai_version(versions, '2465980', ['ZImageTurbo'])
        self.assertEqual(found['id'], '2526600')
        # ZImageBase must not be treated as ZImageTurbo.
        self.assertIsNone(app.newer_civitai_version(versions, '2683561', ['ZImageBase']))
        # A version with no declared base is not assumed to match.
        self.assertIsNone(app.newer_civitai_version([{'id': '9', 'name': 'x'}], '1', ['ZImageTurbo']))
        # No base filter at all keeps the old id-only behaviour.
        self.assertEqual(app.newer_civitai_version(versions, '2526600')['id'], '3075498')

    def test_a_sibling_option_is_not_an_update(self):
        # Real case (Civitai model 2535622, "LTX 2.3 - Enhancers"): the model ships
        # "Soft Enhance" and "Crisp Enhance" as separate versions of the SAME base.
        # The higher id is the other option, not a newer one — offering it as an
        # update replaced an installed Soft with Crisp.
        app = load_app()
        versions = [
            {'id': '2849716', 'name': 'Crisp Enhance', 'baseModel': 'LTXV 2.3'},
            {'id': '2849706', 'name': 'Soft Enhance', 'baseModel': 'LTXV 2.3'},
        ]

        self.assertIsNone(app.newer_civitai_version(versions, '2849706', ['LTXV 2.3'], 'Soft Enhance'))
        self.assertIsNone(app.newer_civitai_version(versions, '2849716', ['LTXV 2.3'], 'Crisp Enhance'))
        # A newer build of the SAME option is still an update.
        with_revision = versions + [{'id': '2900000', 'name': 'Soft Enhance v2', 'baseModel': 'LTXV 2.3'}]
        found = app.newer_civitai_version(with_revision, '2849706', ['LTXV 2.3'], 'Soft Enhance')
        self.assertEqual(found['id'], '2900000')

    def test_version_lineage_keeps_real_revisions_and_rejects_options(self):
        app = load_app()

        # Revisions seen in the installed library — these must keep updating.
        for installed, candidate in [
            ('v1.0', 'v1.1'),
            ('Krea 2 v1.0', 'Krea 2 v1.1'),
            ('V4.1 Exp, pre', 'v4.3_EXP'),      # descriptive words narrow, still one lineage
            ('v3', 'v4.3_EXP'),
            ('2vector', '3vector'),             # digits glued to the label
            ('small breast-flat chest', 'V2.1'),  # renamed to a bare version
            ('Krea-2_v1', 'Krea-2_v2'),
        ]:
            self.assertTrue(app.same_version_lineage(installed, candidate), f'{installed} -> {candidate}')

        # Options published side by side — never an upgrade path.
        for installed, candidate in [
            ('Soft Enhance', 'Crisp Enhance'),
            ('Crisp Enhance', 'Soft Enhance'),
            ('SDXL', 'Pony'),
            ('anime style', 'realistic style'),
        ]:
            self.assertFalse(app.same_version_lineage(installed, candidate), f'{installed} -> {candidate}')

    def test_lora_updates_skip_uncheckable_entries_and_survive_api_failures(self):
        app = load_app()
        installed = [
            {'id': 'look.safetensors', 'name': 'look.safetensors', 'path': '/x/look.safetensors', 'baseModel': 'SDXL 1.0',
             'metadata': {'modelVersion': {'id': 100, 'name': 'v1', 'model': {'id': 42, 'name': 'Look'}}}},
            {'id': 'hand.safetensors', 'name': 'hand.safetensors', 'path': '/x/hand.safetensors', 'baseModel': 'SDXL 1.0',
             'metadata': {}},
            {'id': 'boom.safetensors', 'name': 'boom.safetensors', 'path': '/x/boom.safetensors', 'baseModel': 'SDXL 1.0',
             'metadata': {'modelVersion': {'id': 1, 'name': 'v1', 'model': {'id': 99, 'name': 'Boom'}}}},
        ]

        def versions(model_id, force=False):
            if str(model_id) == '99':
                raise RuntimeError('Civitai rate limited')
            return [
                {'id': '900', 'name': 'v3 Pony', 'baseModel': 'Pony'},  # different base: not an update
                {'id': '500', 'name': 'v2', 'baseModel': 'SDXL 1.0'},
            ]

        with patch.object(app, 'local_loras_unfiltered', return_value=installed), \
             patch.object(app, 'civitai_model_versions', side_effect=versions):
            updates = app.civitai_lora_updates(['SDXL 1.0'])

        # The rate-limited model is skipped, not fatal; the sidecar-less file cannot be checked.
        self.assertEqual(list(updates), ['look.safetensors'])
        entry = updates['look.safetensors']
        self.assertEqual(entry['latestVersionId'], '500')
        self.assertEqual(entry['currentVersionId'], '100')
        self.assertEqual(entry['url'], 'https://civitai.com/models/42?modelVersionId=500')

    def test_replacing_a_lora_removes_the_old_file_only_after_the_new_one_lands(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            loras = tmp_path / 'models' / 'loras'
            loras.mkdir(parents=True)
            old = loras / 'look-v1.safetensors'
            old.write_bytes(b'old')
            (loras / 'look-v1.safetensors.civitai.json').write_text('{}')
            new = loras / 'look-v2.safetensors'

            with patch.object(app, 'COMFY', tmp_path):
                # The replacement is not on disk yet: the old file must survive.
                app.replace_installed_lora(old, {'path': str(new)})
                self.assertTrue(old.exists())

                new.write_bytes(b'new')
                with patch.object(app, 'load_selected_loras', return_value=[{'id': 'look-v1.safetensors', 'strength': 0.7}]), \
                     patch.object(app, 'save_selected_loras') as save:
                    outcome = app.replace_installed_lora(old, {'path': str(new)})

            self.assertFalse(old.exists())
            self.assertFalse((loras / 'look-v1.safetensors.civitai.json').exists())
            self.assertTrue(new.exists())
            self.assertEqual(Path(outcome['replacedBy']).name, 'look-v2.safetensors')
            # The generation selection follows the file instead of silently dropping it.
            save.assert_called_once_with([{'id': 'look-v2.safetensors', 'strength': 0.7}])

    def test_a_same_filename_update_overwrites_in_place_and_removes_nothing(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            loras = tmp_path / 'models' / 'loras'
            loras.mkdir(parents=True)
            same = loras / 'look.safetensors'
            same.write_bytes(b'new bytes from the update')

            with patch.object(app, 'COMFY', tmp_path):
                outcome = app.replace_installed_lora(same, {'path': str(same)})

            self.assertEqual(outcome['removed'], '')
            self.assertTrue(same.exists())

    def test_replace_targets_are_confined_to_the_loras_directory(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            (tmp_path / 'models' / 'loras').mkdir(parents=True)
            (tmp_path / 'models' / 'checkpoints').mkdir(parents=True)
            outside = tmp_path / 'models' / 'checkpoints' / 'base.safetensors'
            outside.write_bytes(b'not a lora')

            with patch.object(app, 'COMFY', tmp_path):
                with self.assertRaisesRegex(RuntimeError, 'outside the ComfyUI loras directory'):
                    app.resolve_installed_lora_path('../checkpoints/base.safetensors')
                with self.assertRaisesRegex(RuntimeError, 'No installed LoRA named'):
                    app.resolve_installed_lora_path('missing.safetensors')
            self.assertTrue(outside.exists())

    def test_civitai_download_url_uses_query_token_not_bearer_redirect_header(self):
        app = load_app()
        with TemporaryDirectory() as td:
            tmp_path = Path(td)
            with patch.object(app, 'CIVITAI_TOKEN_FILE', tmp_path / 'civitai_token.txt'), patch.object(app, 'BASE', tmp_path), patch.dict('os.environ', {'CIVITAI_TOKEN': 'test-token'}, clear=False):
                url = app.civitai_download_url('https://civitai.com/api/download/models/2960556')
                self.assertIn('token=test-token', url)
                self.assertEqual(app.civitai_token(' request-token '), 'request-token')
                override_url = app.civitai_download_url('https://civitai.com/api/download/models/2960556', token_override='body-token')
                self.assertIn('token=body-token', override_url)
                self.assertNotIn('token=test-token', override_url)
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
                        'filename_prefix': 'Eros/native_mlx_ltx__eros-v14-q8-dmd',
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
        self.assertEqual(native['variant'], 'eros-v14-q8-dmd')
        self.assertEqual(native['prompt'], 'private video prompt')
        self.assertEqual(native['image_path'], 'source.png')
        self.assertEqual(native['options']['width'], 480)
        self.assertEqual(native['options']['height'], 832)
        self.assertEqual(native['options']['frames'], 233)
        self.assertEqual(native['options']['frame_rate'], 24)
        self.assertEqual(native['options']['seed'], 42)
        self.assertEqual(native['images'], [{'image_path': 'source.png', 'frame': 0, 'strength': 1.0, 'role': 'start'}])

    def test_native_mlx_ltx_fast_extension_keeps_distilled_model_and_labels_frame_units(self):
        app = load_app()
        with TemporaryDirectory() as td:
            model_dir = Path(td) / 'fast-distilled'
            model_dir.mkdir()
            variants = {key: dict(value) for key, value in app.LTX2_MLX_VARIANTS.items()}
            variants['eros-v14-q8-dmd'].update({
                'model': str(model_dir),
                'video_model': str(model_dir),
                'video_distilled': True,
            })
            body = json.dumps({
                'prompt': {
                    '597': {'class_type': 'VHS_VideoCombine', 'inputs': {'filename_prefix': 'Eros/native_mlx_ltx__eros-v14-q8-dmd'}},
                    '812': {'class_type': 'PrimitiveInt', 'inputs': {'value': 42}},
                    '824': {'class_type': 'PrimitiveStringMultiline', 'inputs': {'value': 'continue the same shot'}},
                },
                'extra_data': {
                    'extra_pnginfo': {
                        'workflow': {
                            'extra': {
                                'nativeMlxLtx': {
                                    'enabled': True,
                                    'variant': 'eros-v14-q8-dmd',
                                    'defaults': {'frame_rate': 24, 'duration_seconds': 4},
                                    'video': {'path': 'source.mp4', 'mode': 'extend'},
                                },
                            },
                        },
                    },
                },
            }).encode('utf-8')

            with patch.dict('os.environ', APPLE_SILICON_ENV, clear=False), \
                 patch.object(app, 'LTX2_MLX_VARIANTS', variants):
                native = app.detect_native_mlx_ltx_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['operation'], 'extend')
        self.assertEqual(native['options']['model'], str(model_dir))
        self.assertEqual(native['options']['extension_output_frames'], 96)
        self.assertEqual(native['options']['extension_latent_frames'], 12)
        self.assertTrue(native['options']['distilled'])

    def test_native_mlx_ltx_regular_variant_uses_metadata_frames(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '542': {'class_type': 'PrimitiveFloat', 'inputs': {'value': 24}},
                '597': {
                    'class_type': 'VHS_VideoCombine',
                    'inputs': {
                        'filename_prefix': 'LTX23/native_mlx_ltx__regular-q8-distilled',
                        'frame_rate': ['542', 0],
                        'save_output': True,
                    },
                },
                '773': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                '809': {'class_type': 'PrimitiveInt', 'inputs': {'value': 480}},
                '811': {'class_type': 'PrimitiveInt', 'inputs': {'value': 832}},
                '812': {'class_type': 'PrimitiveInt', 'inputs': {'value': 42}},
                '824': {'class_type': 'PrimitiveStringMultiline', 'inputs': {'value': 'private regular ltx prompt'}},
                '534': {'class_type': 'EmptyLTXVLatentVideo', 'inputs': {'width': ['809', 0], 'height': ['811', 0], 'length': 233}},
            },
            'extra_data': {
                'extra_pnginfo': {
                    'workflow': {
                        'extra': {
                            'nativeMlxLtx': {
                                'enabled': True,
                                'variant': 'regular-q8-distilled',
                                'defaults': {'frames': 25},
                            },
                        },
                    },
                },
            },
        }).encode('utf-8')

        with patch.dict('os.environ', APPLE_SILICON_ENV, clear=False):
            native = app.detect_native_mlx_ltx_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['variant'], 'regular-q8-distilled')
        self.assertEqual(native['prompt'], 'private regular ltx prompt')
        self.assertEqual(native['options']['frames'], 25)
        self.assertEqual(native['options']['title'], 'LTX 2.3 regular q8 distilled')

    def test_ltx_snap_render_dimensions_matches_pipeline_grid(self):
        app = load_app()
        # Two-stage (generate) renders stage 1 at half res: multiples of 64.
        self.assertEqual(app._ltx_snap_render_dimensions(928, 928), (896, 896))
        self.assertEqual(app._ltx_snap_render_dimensions(896, 896), (896, 896))
        self.assertEqual(app._ltx_snap_render_dimensions(480, 832), (448, 832))
        # Single-stage keeps the VAE's 32 grid.
        self.assertEqual(app._ltx_snap_render_dimensions(640, 480, single_stage=True), (640, 480))
        self.assertEqual(app._ltx_snap_render_dimensions(30, 30), (64, 64))

    def test_native_mlx_ltx_metadata_keyframes_are_normalized(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '542': {'class_type': 'PrimitiveFloat', 'inputs': {'value': 24}},
                '597': {
                    'class_type': 'VHS_VideoCombine',
                    'inputs': {
                        'filename_prefix': 'LTX23/native_mlx_ltx__regular-q8-distilled',
                        'frame_rate': ['542', 0],
                        'save_output': True,
                    },
                },
                '773': {'class_type': 'LoadImage', 'inputs': {'image': 'start.png'}},
                '809': {'class_type': 'PrimitiveInt', 'inputs': {'value': 480}},
                '811': {'class_type': 'PrimitiveInt', 'inputs': {'value': 832}},
                '812': {'class_type': 'PrimitiveInt', 'inputs': {'value': 42}},
                '824': {'class_type': 'PrimitiveStringMultiline', 'inputs': {'value': 'private keyed ltx prompt'}},
                '534': {'class_type': 'EmptyLTXVLatentVideo', 'inputs': {'width': ['809', 0], 'height': ['811', 0], 'length': 25}},
            },
            'extra_data': {
                'extra_pnginfo': {
                    'workflow': {
                        'extra': {
                            'nativeMlxLtx': {
                                'enabled': True,
                                'variant': 'regular-q8-distilled',
                                'defaults': {'frames': 25},
                                'keyframes': [
                                    {'image': 'middle.png', 'role': 'middle', 'strength': 0.75},
                                    {'image': 'end.png', 'role': 'end'},
                                ],
                            },
                        },
                    },
                },
            },
        }).encode('utf-8')

        with patch.dict('os.environ', APPLE_SILICON_ENV, clear=False):
            native = app.detect_native_mlx_ltx_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['images'], [
            {'image_path': 'start.png', 'frame': 0, 'strength': 1.0, 'role': 'start'},
            {'image_path': 'middle.png', 'frame': 12, 'strength': 0.75, 'role': 'middle'},
            {'image_path': 'end.png', 'frame': 24, 'strength': 1.0, 'role': 'end'},
        ])

    def test_native_mlx_ltx_metadata_loras_and_cfg_are_normalized(self):
        app = load_app()
        with TemporaryDirectory() as td:
            root = Path(td)
            lora = root / 'models' / 'loras' / 'ltx' / '2.3' / 'ltx2.3-transition.safetensors'
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b'lora')
            body = json.dumps({
                'prompt': {
                    '542': {'class_type': 'PrimitiveFloat', 'inputs': {'value': 24}},
                    '583': {'class_type': 'CFGGuider', 'inputs': {'cfg': 4.0}},
                    '597': {
                        'class_type': 'VHS_VideoCombine',
                        'inputs': {
                            'filename_prefix': 'LTX23/native_mlx_ltx__regular-q8-distilled',
                            'frame_rate': ['542', 0],
                            'save_output': True,
                        },
                    },
                    '773': {'class_type': 'LoadImage', 'inputs': {'image': 'start.png'}},
                    '809': {'class_type': 'PrimitiveInt', 'inputs': {'value': 480}},
                    '811': {'class_type': 'PrimitiveInt', 'inputs': {'value': 832}},
                    '812': {'class_type': 'PrimitiveInt', 'inputs': {'value': 42}},
                    '824': {'class_type': 'PrimitiveStringMultiline', 'inputs': {'value': 'private transition prompt zhuanchang'}},
                    '534': {'class_type': 'EmptyLTXVLatentVideo', 'inputs': {'width': ['809', 0], 'height': ['811', 0], 'length': 25}},
                },
                'extra_data': {
                    'extra_pnginfo': {
                        'workflow': {
                            'extra': {
                                'nativeMlxLtx': {
                                    'enabled': True,
                                    'variant': 'regular-q8-distilled',
                                    'defaults': {'frames': 25},
                                    'loras': [
                                        {'name': 'ltx/2.3/ltx2.3-transition.safetensors', 'strength': 1.0},
                                    ],
                                },
                            },
                        },
                    },
                },
            }).encode('utf-8')

            with patch.dict('os.environ', APPLE_SILICON_ENV, clear=False), \
                 patch.object(app, 'COMFY', root):
                native = app.detect_native_mlx_ltx_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['options']['cfg_scale'], 4.0)
        self.assertEqual(native['options']['loras'], [{
            'name': 'ltx2.3-transition.safetensors',
            'source': 'ltx/2.3/ltx2.3-transition.safetensors',
            'scale': 1.0,
            'filePath': str(lora.resolve()),
        }])

    def test_ltx_denoise_mode_is_normalized_and_off_by_default(self):
        app = load_app()

        self.assertEqual(app.normalize_ltx_denoise_mode('light'), 'light')
        self.assertEqual(app.normalize_ltx_denoise_mode('STRONG'), 'strong')
        self.assertEqual(app.normalize_ltx_denoise_mode('on'), 'light')
        for value in ('', None, 'off', 'false', 'nope', 0):
            self.assertEqual(app.normalize_ltx_denoise_mode(value), '')
        # Off means the output file is never touched.
        self.assertIsNone(app.apply_ltx_denoise_pass('/nonexistent.mp4', ''))

    def test_ltx_denoise_pass_never_fails_a_finished_generation(self):
        app = load_app()

        with patch.object(app.shutil, 'which', return_value=None):
            detail = app.apply_ltx_denoise_pass('/nonexistent.mp4', 'light')
        self.assertEqual(detail, {'mode': 'light', 'applied': False, 'error': 'ffmpeg not found'})

        # A failing ffmpeg leaves the original clip in place and reports, not raises.
        with TemporaryDirectory() as td:
            clip = Path(td) / 'clip.mp4'
            clip.write_bytes(b'x' * 2048)
            with patch.object(app.shutil, 'which', return_value='/usr/bin/false'), \
                 patch.object(app.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout='', stderr='boom')):
                detail = app.apply_ltx_denoise_pass(clip, 'strong')
            self.assertFalse(detail['applied'])
            self.assertIn('boom', detail['error'])
            self.assertEqual(clip.read_bytes(), b'x' * 2048)

    def test_ltx_denoise_filters_stay_motion_safe(self):
        app = load_app()

        # Both tiers lead with atadenoise (motion-adaptive). Any hqdn3d pass must
        # keep its two TEMPORAL terms at 0 — a temporal blur here would trade the
        # grain for exactly the ghosting this is meant to avoid.
        for mode, spec in app.LTX_DENOISE_FILTERS.items():
            self.assertTrue(spec.startswith('atadenoise='), mode)
            for stage in spec.split(','):
                if stage.startswith('hqdn3d='):
                    luma_s, chroma_s, luma_t, chroma_t = stage[len('hqdn3d='):].split(':')
                    self.assertEqual((float(luma_t), float(chroma_t)), (0.0, 0.0), mode)
                    self.assertGreater(float(luma_s), 0.0)
                    self.assertGreater(float(chroma_s), 0.0)

    def test_native_mlx_ltx_metadata_carries_the_denoise_choice(self):
        app = load_app()
        body = json.dumps({
            'prompt': {
                '542': {'class_type': 'PrimitiveFloat', 'inputs': {'value': 24}},
                '597': {
                    'class_type': 'VHS_VideoCombine',
                    'inputs': {
                        'filename_prefix': 'Eros/native_mlx_ltx__eros-v14-q8-dmd',
                        'frame_rate': ['542', 0],
                        'save_output': True,
                    },
                },
                '773': {'class_type': 'LoadImage', 'inputs': {'image': 'start.png'}},
                '809': {'class_type': 'PrimitiveInt', 'inputs': {'value': 576}},
                '811': {'class_type': 'PrimitiveInt', 'inputs': {'value': 576}},
                '812': {'class_type': 'PrimitiveInt', 'inputs': {'value': 42}},
                '824': {'class_type': 'PrimitiveStringMultiline', 'inputs': {'value': 'private prompt'}},
                '534': {'class_type': 'EmptyLTXVLatentVideo', 'inputs': {'width': ['809', 0], 'height': ['811', 0], 'length': 121}},
            },
            'extra_data': {'extra_pnginfo': {'workflow': {'extra': {'nativeMlxLtx': {
                'enabled': True,
                'variant': 'eros-v14-q8-dmd',
                'defaults': {'frames': 121, 'denoise': 'strong'},
            }}}}},
        }).encode('utf-8')

        with patch.dict('os.environ', APPLE_SILICON_ENV, clear=False):
            native = app.detect_native_mlx_ltx_prompt(body)

        self.assertIsNotNone(native)
        self.assertEqual(native['options']['denoise'], 'strong')

    def test_native_mlx_ltx_ingredients_metadata_uses_ic_reference_path(self):
        app = load_app()
        with TemporaryDirectory() as td:
            root = Path(td)
            lora = root / 'models' / 'loras' / 'ltx' / '2.3' / 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors'
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b'ingredients-lora')
            body = json.dumps({
                'prompt': {
                    '2004': {'class_type': 'LoadImage', 'inputs': {'image': 'reference-sheet.png'}},
                    '2483': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '### Reference Sheet Description\na cartoon character panel\n### Target Description\nshot'}},
                    '3059': {'class_type': 'EmptyLTXVLatentVideo', 'inputs': {'width': ['809', 0], 'height': ['811', 0], 'length': ['5072', 0]}},
                    '4832': {'class_type': 'RandomNoise', 'inputs': {'noise_seed': 7}},
                    '5011': {'class_type': 'LTXICLoRALoaderModelOnly', 'inputs': {'lora_name': 'ltx/2.3/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors', 'strength_model': 1.4}},
                    '5012': {'class_type': 'LTXAddVideoICLoRAGuide', 'inputs': {'image': ['2004', 0], 'strength': 1.0}},
                    '5072': {'class_type': 'PrimitiveInt', 'inputs': {'value': 121}},
                    '5098': {'class_type': 'PrimitiveFloat', 'inputs': {'value': 24}},
                    '809': {'class_type': 'PrimitiveInt', 'inputs': {'value': 768}},
                    '811': {'class_type': 'PrimitiveInt', 'inputs': {'value': 448}},
                },
                'extra_data': {
                    'extra_pnginfo': {
                        'workflow': {
                            'extra': {
                                'nativeMlxLtx': {
                                    'enabled': True,
                                    'variant': 'regular-q8-dev-ic',
                                    'pipeline': 'ic-lora',
                                    'defaults': {'image': 'reference-sheet.png', 'width': 768, 'height': 448, 'frames': 121, 'frame_rate': 24, 'seed': 7},
                                    'keyframes': [{'image_path': 'start.png', 'frame': 0, 'strength': 1.0, 'role': 'start'}],
                                    'ingredientSheet': {
                                        'sourceCount': 4,
                                        'columns': 2,
                                        'rows': 2,
                                        'conditioningOnly': True,
                                    },
                                    'icLora': {
                                        'single_stage': True,
                                        'reference_min_frames': 121,
                                        'target_min_frames': 121,
                                        'image_crf': 0,
                                        'conditioning_strength': 1.0,
                                        'reference_strength': 1.0,
                                        'dev_transformer': 'transformer-dev.safetensors',
                                        'distilled_lora': 'ltx-2.3-22b-distilled-lora-384-1.1.safetensors',
                                        'distilled_lora_strength': 0.5,
                                        'guided_dev': False,
                                        'stage1_steps': 8,
                                        'cfg_scale': 1.0,
                                        'stg_scale': 0.0,
                                        'runtime_timeout_seconds': 2400,
                                    },
                                    'loras': [{'name': 'ltx/2.3/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors', 'strength': 1.4}],
                                },
                            },
                        },
                    },
                },
            }).encode('utf-8')

            with patch.dict('os.environ', APPLE_SILICON_ENV, clear=False), patch.object(app, 'COMFY', root):
                native = app.detect_native_mlx_ltx_prompt(body)
                fallback_data = json.loads(body.decode('utf-8'))
                fallback_data.pop('extra_data')
                fallback_native = app.detect_native_mlx_ltx_prompt(json.dumps(fallback_data).encode('utf-8'))

        self.assertIsNotNone(native)
        self.assertEqual(native['operation'], 'ic-lora')
        self.assertEqual(native['reference_image_path'], 'reference-sheet.png')
        self.assertEqual(native['images'], [{'image_path': 'start.png', 'frame': 0, 'strength': 1.0, 'role': 'start'}])
        self.assertEqual(native['options']['width'], 768)
        self.assertEqual(native['options']['height'], 448)
        self.assertEqual(native['options']['frames'], 121)
        self.assertTrue(native['options']['single_stage'])
        self.assertEqual(native['options']['reference_min_frames'], 121)
        self.assertEqual(native['options']['target_min_frames'], 121)
        self.assertEqual(native['options']['ingredient_source_count'], 4)
        self.assertEqual(native['options']['ingredient_sheet_columns'], 2)
        self.assertEqual(native['options']['ingredient_sheet_rows'], 2)
        self.assertTrue(native['options']['ingredient_conditioning_only'])
        self.assertEqual(native['options']['image_crf'], 0)
        self.assertEqual(native['variant'], 'regular-q8-dev-ic')
        self.assertEqual(native['options']['dev_transformer'], 'transformer-dev.safetensors')
        self.assertFalse(native['options']['guided_dev'])
        self.assertEqual(native['options']['stage1_steps'], 8)
        self.assertEqual(native['options']['cfg_scale'], 1.0)
        self.assertEqual(native['options']['stg_scale'], 0.0)
        self.assertEqual(native['options']['runtime_timeout_seconds'], 2400)
        self.assertEqual(native['options']['distilled_lora'], 'ltx-2.3-22b-distilled-lora-384-1.1.safetensors')
        self.assertEqual(native['options']['distilled_lora_strength'], 0.5)
        self.assertEqual(native['options']['loras'][0]['scale'], 1.4)
        self.assertEqual(fallback_native['operation'], 'ic-lora')
        self.assertEqual(fallback_native['reference_image_path'], 'reference-sheet.png')
        self.assertEqual(fallback_native['options']['loras'][0]['scale'], 1.4)

    def test_ingredients_aliases_fall_back_to_the_regular_dev_lane(self):
        # The eros dev build (ltx-2.3-10eros-v1-mlx-q8-dev) was retired when the
        # model set was trimmed to v1.4 DMD / v1.2 DMD / regular, so the
        # ingredients aliases now resolve to the regular dev IC lane. Asserted
        # because an alias pointing at a deleted variant fails only at run time,
        # after the caller has already committed to a generation.
        app = load_app()

        spec = app.LTX2_MLX_VARIANTS['regular-q8-dev-ic']

        self.assertEqual(spec['model'], str(app.MLX_MODELS_ROOT / 'ltx-2.3-mlx-q8-dev'))
        self.assertFalse(spec['video_distilled'])
        self.assertEqual(app._normalize_ltx_mlx_variant('eros-ingredients'), 'regular-q8-dev-ic')

    def test_no_variant_alias_points_at_a_retired_variant(self):
        # The whole failure mode this trim could introduce, in one assertion.
        app = load_app()
        dangling = {
            alias: target for alias, target in app.LTX2_MLX_VARIANT_ALIASES.items()
            if target not in app.LTX2_MLX_VARIANTS
        }
        # exact-v1-merged-q8 has been dangling since before the trim; it is
        # tracked separately rather than silently blessed here.
        dangling = {a: t for a, t in dangling.items() if t != 'exact-v1-merged-q8'}
        self.assertEqual(dangling, {})

    def test_native_mlx_ltx_runner_uses_ic_lora_with_lossless_reference_video(self):
        app = load_app()
        with TemporaryDirectory() as td:
            root = Path(td)
            input_dir = root / 'input'
            output_dir = root / 'output'
            ltx_dir = root / 'ltx-2-mlx'
            model_dir = root / 'model'
            lora = root / 'models' / 'loras' / 'ltx' / '2.3' / 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors'
            input_dir.mkdir()
            output_dir.mkdir()
            ltx_dir.mkdir()
            model_dir.mkdir()
            (model_dir / 'transformer-dev.safetensors').write_bytes(b'dev-transformer')
            (model_dir / 'ltx-2.3-22b-distilled-lora-384-1.1.safetensors').write_bytes(b'distilled-lora')
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b'ingredients-lora')
            (input_dir / 'reference-sheet.png').write_bytes(b'reference-sheet')
            (input_dir / 'start.png').write_bytes(b'start-frame')
            captured = {}

            def fake_reference_video(_image, output, frames, _fps):
                captured['reference_frames'] = frames
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b'lossless-reference-video')
                return output

            def fake_run(_job_id, _rec, command, **_kwargs):
                captured['command'] = command
                captured['env'] = _kwargs['env']
                out = Path(command[command.index('-o') + 1])
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(b'video' * 600)
                return subprocess.CompletedProcess(command, 0, stdout='ok', stderr='')

            variants = {key: dict(value) for key, value in app.LTX2_MLX_VARIANTS.items()}
            variants['regular-q8-dev-ic']['model'] = str(model_dir)
            with patch.dict('os.environ', {**APPLE_SILICON_ENV, 'ZIMG_LTX_MLX_FREE_COMFY_BEFORE_RUN': '0'}, clear=False), \
                 patch.object(app, 'COMFY_INPUT_DIR', input_dir), \
                 patch.object(app, 'COMFY_OUTPUT_DIR', output_dir), \
                 patch.object(app, 'COMFY', root), \
                 patch.object(app, 'OUT_DIR', output_dir), \
                 patch.object(app, 'LTX2_MLX_DIR', ltx_dir), \
                 patch.object(app, 'LTX2_MLX_VARIANTS', variants), \
                 patch.object(app, '_create_native_ltx_static_reference_video', side_effect=fake_reference_video), \
                 patch.object(
                     app,
                     '_prepare_native_ltx_anchor_canvas',
                     side_effect=lambda source, *_args: (source, {'mode': 'passthrough', 'cached': False}),
                 ), \
                 patch.object(app, '_run_native_ltx_subprocess', side_effect=fake_run), \
                 patch.object(app, 'append_history'), \
                patch.object(app, 'mirror_output_to_comfy_output', side_effect=lambda path: path):
                app.run_native_mlx_ltx_video('job-ingredients', {
                    'variant': 'regular-q8-dev-ic',
                    'operation': 'ic-lora',
                    'prompt': '### Reference Sheet Description\na cartoon character panel\n### Target Description\nshot',
                    'reference_image_path': 'reference-sheet.png',
                    'images': [{'image_path': 'start.png', 'frame': 0, 'strength': 1.0, 'role': 'start'}],
                    'options': {
                        'width': 768,
                        'height': 448,
                        'frames': 25,
                        'frame_rate': 24,
                        'seed': 7,
                        'single_stage': True,
                        'conditioning_strength': 1.0,
                        'reference_strength': 1.0,
                        'reference_min_frames': 121,
                        'target_min_frames': 121,
                        'image_crf': 0,
                        'dev_transformer': 'transformer-dev.safetensors',
                        'distilled_lora': 'ltx-2.3-22b-distilled-lora-384-1.1.safetensors',
                        'distilled_lora_strength': 0.5,
                        'guided_dev': False,
                        'stage1_steps': 8,
                        'cfg_scale': 1.0,
                        'stg_scale': 0.0,
                        'runtime_timeout_seconds': 2400,
                        'loras': [{'name': 'ltx/2.3/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors', 'strength': 1.4}],
                    },
                })

            command = captured['command']
            self.assertEqual(captured['reference_frames'], 121)
            self.assertEqual(command[:4], ['uv', 'run', 'ltx-2-mlx', 'ic-lora'])
            self.assertEqual(command[command.index('--lora') + 1:command.index('--lora') + 3], [str(lora.resolve()), '1.4'])
            reference_arg = Path(command[command.index('--video-conditioning') + 1])
            self.assertEqual(command[command.index('--video-conditioning') + 2], '1.0')
            self.assertEqual(os.path.realpath(reference_arg.parent), os.path.realpath(input_dir / '.ltx-reference'))
            self.assertIn('--single-stage', command)
            self.assertEqual(command[command.index('--dev-transformer') + 1], 'transformer-dev.safetensors')
            self.assertNotIn('--guided-dev', command)
            self.assertNotIn('--stage1-steps', command)
            self.assertNotIn('--cfg-scale', command)
            self.assertNotIn('--stg-scale', command)
            self.assertEqual(
                command[command.index('--distilled-lora') + 1],
                'ltx-2.3-22b-distilled-lora-384-1.1.safetensors',
            )
            self.assertEqual(command[command.index('--distilled-lora-strength') + 1], '0.5')
            image_arg = command.index('--image')
            self.assertEqual(
                command[image_arg + 1:image_arg + 5],
                [str((input_dir / 'start.png').resolve()), '0', '1.0', '0'],
            )
            self.assertEqual(command[command.index('-f') + 1], '121')
            self.assertFalse(reference_arg.exists())
            self.assertEqual(app.jobs['job-ingredients']['status'], 'success')

    def test_native_mlx_ltx_runner_passes_repeated_image_anchors(self):
        app = load_app()
        with TemporaryDirectory() as td:
            root = Path(td)
            input_dir = root / 'input'
            output_dir = root / 'output'
            ltx_dir = root / 'ltx-2-mlx'
            model_path = root / 'model.safetensors'
            lora = root / 'models' / 'loras' / 'ltx' / '2.3' / 'ltx2.3-transition.safetensors'
            input_dir.mkdir()
            output_dir.mkdir()
            ltx_dir.mkdir()
            lora.parent.mkdir(parents=True)
            model_path.write_bytes(b'model')
            lora.write_bytes(b'lora')
            (input_dir / 'start.png').write_bytes(b'start-image')
            (input_dir / 'end.png').write_bytes(b'end-image')
            captured = {}

            def fake_run(_job_id, _rec, command, **_kwargs):
                captured['command'] = command
                out = Path(command[command.index('-o') + 1])
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(b'video' * 600)
                return subprocess.CompletedProcess(command, 0, stdout='ok', stderr='')

            variants = {key: dict(value) for key, value in app.LTX2_MLX_VARIANTS.items()}
            variants['regular-q8-distilled']['model'] = str(model_path)

            with patch.dict('os.environ', {**APPLE_SILICON_ENV, 'ZIMG_LTX_MLX_FREE_COMFY_BEFORE_RUN': '0'}, clear=False), \
                 patch.object(app, 'COMFY_INPUT_DIR', input_dir), \
                 patch.object(app, 'COMFY_OUTPUT_DIR', output_dir), \
                 patch.object(app, 'COMFY', root), \
                 patch.object(app, 'OUT_DIR', output_dir), \
                 patch.object(app, 'LTX2_MLX_DIR', ltx_dir), \
                 patch.object(app, 'LTX2_MLX_VARIANTS', variants), \
                 patch.object(app, '_run_native_ltx_subprocess', side_effect=fake_run), \
                 patch.object(app, 'append_history'), \
                 patch.object(app, 'mirror_output_to_comfy_output', side_effect=lambda path: path):
                app.run_native_mlx_ltx_video('job-keyed', {
                    'variant': 'regular-q8-distilled',
                    'prompt': 'private keyed ltx prompt',
                    'image_path': 'start.png',
                    'images': [
                        {'image_path': 'start.png', 'frame': 0, 'strength': 1.0, 'role': 'start'},
                        {'image_path': 'end.png', 'frame': 24, 'strength': 0.8, 'role': 'end'},
                    ],
                    'options': {
                        'width': 480,
                        'height': 832,
                        'frames': 25,
                        'frame_rate': 24,
                        'seed': 7,
                        'cfg_scale': 4.0,
                        'loras': [{'name': 'ltx/2.3/ltx2.3-transition.safetensors', 'strength': 1.0}],
                    },
                })

            command = captured['command']
            first = command.index('--image')
            second = command.index('--image', first + 1)
            lora_arg = command.index('--lora')
            cfg_arg = command.index('--cfg-scale')
            self.assertEqual(command[first + 1:first + 4], [str((input_dir / 'start.png').resolve()), '0', '1.0'])
            self.assertEqual(command[second + 1:second + 4], [str((input_dir / 'end.png').resolve()), '24', '0.8'])
            self.assertEqual(command[lora_arg + 1:lora_arg + 3], [str(lora.resolve()), '1.0'])
            self.assertEqual(command[cfg_arg + 1], '4.0')
            self.assertEqual(app.jobs['job-keyed']['status'], 'success')

    def test_native_mlx_ltx_runner_uses_extend_command_for_source_video(self):
        app = load_app()
        with TemporaryDirectory() as td:
            root = Path(td)
            input_dir = root / 'input'
            output_dir = root / 'output'
            ltx_dir = root / 'ltx-2-mlx'
            model_dir = root / 'ltx-distilled-model'
            input_dir.mkdir()
            output_dir.mkdir()
            ltx_dir.mkdir()
            model_dir.mkdir()
            source = input_dir / 'source.mp4'
            source.write_bytes(b'source-video')
            captured = {}

            def fake_run(_job_id, _rec, command, **_kwargs):
                captured['command'] = command
                out = Path(command[command.index('-o') + 1])
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(b'video' * 600)
                return subprocess.CompletedProcess(command, 0, stdout='ok', stderr='')

            variants = {key: dict(value) for key, value in app.LTX2_MLX_VARIANTS.items()}
            variants['eros-v14-q8-dmd']['video_model'] = str(model_dir)

            with patch.dict('os.environ', {**APPLE_SILICON_ENV, 'ZIMG_LTX_MLX_FREE_COMFY_BEFORE_RUN': '0'}, clear=False), \
                 patch.object(app, 'COMFY_INPUT_DIR', input_dir), \
                 patch.object(app, 'COMFY_OUTPUT_DIR', output_dir), \
                 patch.object(app, 'COMFY', root), \
                 patch.object(app, 'OUT_DIR', output_dir), \
                 patch.object(app, 'LTX2_MLX_DIR', ltx_dir), \
                 patch.object(app, 'LTX2_MLX_VARIANTS', variants), \
                 patch.object(app, '_run_native_ltx_subprocess', side_effect=fake_run), \
                 patch.object(app, 'append_history'), \
                 patch.object(app, 'mirror_output_to_comfy_output', side_effect=lambda path: path):
                app.run_native_mlx_ltx_video('job-extend', {
                    'variant': 'eros-v14-q8-dmd',
                    'operation': 'extend',
                    'prompt': 'continue the same cinematic shot',
                    'video_path': 'source.mp4',
                    'images': [],
                    'options': {
                        'model': str(model_dir),
                        'duration_seconds': 2,
                        'extension_output_frames': 48,
                        'extension_latent_frames': 6,
                        'extend_latent_frames': 6,
                        'distilled': True,
                        'frame_rate': 24,
                        'seed': 7,
                        'steps': 30,
                        'cfg_scale': 3.0,
                        'stg_scale': 1.0,
                    },
                })

            command = captured['command']
            self.assertEqual(command[:4], ['uv', 'run', 'ltx-2-mlx', 'extend'])
            self.assertEqual(command[command.index('--video') + 1], str(source.resolve()))
            self.assertEqual(command[command.index('--extend-frames') + 1], '6')
            self.assertIn('--distilled', command)
            self.assertNotIn('--steps', command)
            self.assertNotIn('--cfg-scale', command)
            self.assertNotIn('--stg-scale', command)
            self.assertNotIn('--image', command)
            self.assertEqual(app.jobs['job-extend']['status'], 'success')
            self.assertEqual(app.jobs['job-extend']['options']['extension_output_frames'], 48)
            self.assertEqual(app.jobs['job-extend']['options']['extension_latent_frames'], 6)
            self.assertEqual(app.jobs['job-extend']['options']['extension_pipeline'], 'distilled')

    def test_native_mlx_ltx_progress_tracks_real_denoise_steps(self):
        app = load_app()
        rec = {'id': 'job-progress', 'status': 'running'}

        app._update_native_ltx_process_progress(
            'job-progress',
            rec,
            '\rDenoising:  50%|#####     | 4/8 [00:12<00:12, 3.00s/it]',
        )

        self.assertEqual(rec['current_step'], 4)
        self.assertEqual(rec['total_steps'], 8)
        self.assertEqual(rec['progress'], 50)
        self.assertEqual(rec['progress_phase'], 'denoising')

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

    def test_krea2_identity_graph_uses_optional_reference_on_apple_turbo_path(self):
        app = load_app()
        options = {
            'width': 1031,
            'height': 777,
            'steps': 10,
            'cfg': 1,
            'seed': 42,
            'ref_boost': 4,
            'identity_strength': 1,
            'grounding_px': 768,
        }

        with TemporaryDirectory() as td:
            comfy = Path(td)
            model_dir = comfy / 'models' / 'diffusion_models'
            model_dir.mkdir(parents=True)
            (model_dir / app.KREA2_IDENTITY_CONVROT_MODEL).write_bytes(b'checkpoint')
            with patch.object(app, 'COMFY', comfy):
                fallback_graph = app.build_krea2_turbo_identity_prompt(
                    'private prompt', options=options, profile='apple-silicon'
                )
                template_graph = app.build_krea2_turbo_identity_prompt(
                    'private prompt', image_name='None', options=options, profile='apple-silicon'
                )
                edit_graph = app.build_krea2_turbo_identity_prompt(
                    'private prompt', image_name='reference.png', options=options, profile='apple-silicon'
                )
                custom_strength_graph = app.build_krea2_turbo_identity_prompt(
                    'private prompt',
                    image_name='reference.png',
                    options={**options, 'identity_strength': 0.8},
                    profile='apple-silicon',
                )

        self.assertEqual(fallback_graph['1']['class_type'], 'MultiLoRAStackToPreLora')
        self.assertEqual(fallback_graph['1']['inputs']['lora_stack'], '[]')
        self.assertEqual(fallback_graph['2']['class_type'], 'OTUNetLoaderW8A8')
        self.assertEqual(fallback_graph['4']['class_type'], 'TextEncodeKrea2')
        self.assertNotIn('HivemindOptionalLoadImage', {item['class_type'] for item in fallback_graph.values()})
        self.assertNotIn('HivemindOptionalLoadImage', {item['class_type'] for item in template_graph.values()})
        self.assertEqual(edit_graph['1']['inputs']['image'], 'reference.png')
        self.assertNotIn('2', edit_graph)
        self.assertEqual(edit_graph['3']['class_type'], 'OTUNetLoaderW8A8')
        self.assertEqual(edit_graph['3']['inputs']['unet_name'], app.KREA2_IDENTITY_CONVROT_MODEL)
        self.assertFalse(edit_graph['3']['inputs']['on_the_fly_quantization'])
        self.assertTrue(edit_graph['3']['inputs']['enable_convrot'])
        self.assertEqual(edit_graph['5']['class_type'], 'Krea2IdentityOptionalEncode')
        self.assertEqual(edit_graph['9']['class_type'], 'Krea2IdentityOptionalModelPatch')
        # Stale expectation: the cached identity forward was turned OFF by default
        # on 2026-07-22 (grain regression) — see krea2_identity_workflow.py.
        self.assertFalse(edit_graph['9']['inputs']['cache_static_tokens'])
        self.assertEqual(edit_graph['7']['inputs']['width'], 1024)
        self.assertEqual(edit_graph['7']['inputs']['height'], 768)
        self.assertEqual(edit_graph['9']['inputs']['ref_boost'], 4.0)
        self.assertEqual(custom_strength_graph['2']['inputs']['lora_name'], 'krea2_identity_edit_v1_2.safetensors')
        self.assertTrue(custom_strength_graph['3']['inputs']['on_the_fly_quantization'])

    def test_krea2_identity_sampler_pair_follows_step_count_and_explicit_overrides(self):
        app = load_app()

        low_step = app.build_krea2_turbo_identity_prompt(
            'private prompt', options={'steps': 2}, profile='apple-silicon',
        )
        tuned = app.build_krea2_turbo_identity_prompt(
            'private prompt', options={'steps': 10}, profile='apple-silicon',
        )
        override = app.build_krea2_turbo_identity_prompt(
            'private prompt',
            options={'steps': 2, 'sampler_name': 'res_2s', 'scheduler': 'karras'},
            profile='apple-silicon',
        )
        garbage = app.build_krea2_turbo_identity_prompt(
            'private prompt',
            options={'steps': 10, 'sampler_name': 'not_a_sampler', 'scheduler': 'nope'},
            profile='apple-silicon',
        )

        # Low step counts get the schedule that survives 2-3 steps; the tuned
        # 8-10 step pair is unchanged.
        self.assertEqual(low_step['7']['inputs']['sampler_name'], 'deis_3m')
        self.assertEqual(low_step['7']['inputs']['scheduler'], 'bong_tangent')
        self.assertEqual(tuned['7']['inputs']['sampler_name'], 'euler_ancestral')
        self.assertEqual(tuned['7']['inputs']['scheduler'], 'beta')
        self.assertEqual(override['7']['inputs']['sampler_name'], 'res_2s')
        self.assertEqual(override['7']['inputs']['scheduler'], 'karras')
        # Unknown names fall back instead of failing inside ComfyUI.
        self.assertEqual(garbage['7']['inputs']['sampler_name'], 'euler_ancestral')
        self.assertEqual(garbage['7']['inputs']['scheduler'], 'beta')

    def test_krea2_identity_edit_graph_also_honours_the_sampler_pair(self):
        app = load_app()

        edit_graph = app.build_krea2_turbo_identity_prompt(
            'private prompt',
            image_name='reference.png',
            options={'steps': 3},
            profile='apple-silicon',
        )

        self.assertEqual(edit_graph['10']['inputs']['sampler_name'], 'deis_3m')
        self.assertEqual(edit_graph['10']['inputs']['scheduler'], 'bong_tangent')

    def test_krea2_identity_job_record_reports_the_sampler_that_ran(self):
        app = load_app()

        self.assertEqual(app._krea2_sampler_choice({'steps': 2}), ('deis_3m', 'bong_tangent'))
        self.assertEqual(app._krea2_sampler_choice({'steps': 8}), ('euler_ancestral', 'beta'))
        self.assertEqual(
            app._krea2_sampler_choice({'steps': 8, 'sampler_name': 'deis_3m', 'scheduler': 'bong_tangent'}),
            ('deis_3m', 'bong_tangent'),
        )

    def test_krea2_identity_graph_uses_regular_portable_turbo_without_an_image(self):
        app = load_app()

        text_graph = app.build_krea2_turbo_identity_prompt('private prompt', profile='cuda')
        edit_graph = app.build_krea2_turbo_identity_prompt(
            'private prompt', image_name='reference.png', profile='cuda'
        )

        self.assertEqual(text_graph['2']['class_type'], 'UNETLoader')
        self.assertNotIn('LoraLoaderModelOnly', {item['class_type'] for item in text_graph.values()})
        self.assertEqual(text_graph['7']['inputs']['model'], ['2', 0])
        self.assertEqual(text_graph['4']['class_type'], 'TextEncodeKrea2')
        template_graph = app.build_krea2_turbo_identity_prompt(
            'private prompt', image_name='None', profile='cuda'
        )
        self.assertNotIn('Krea2IdentityOptionalLoraModel', {item['class_type'] for item in template_graph.values()})
        self.assertEqual(edit_graph['3']['class_type'], 'Krea2IdentityOptionalLoraModel')
        self.assertEqual(edit_graph['3']['inputs']['model'], ['2', 0])
        self.assertEqual(edit_graph['3']['inputs']['image'], ['1', 0])
        self.assertEqual(edit_graph['9']['inputs']['model'], ['3', 0])

    def test_krea2_seed_minus_one_randomizes_instead_of_clamping_to_zero(self):
        app = load_app()
        import krea2_identity_workflow as workflow

        with patch.object(workflow.random, 'randint', return_value=123456789) as randint:
            text_graph = app.build_krea2_turbo_identity_prompt(
                'private prompt', options={'seed': -1}, profile='cuda'
            )
            edit_graph = app.build_krea2_turbo_identity_prompt(
                'private prompt', image_name='reference.png', options={'seed': -1}, profile='cuda'
            )
        self.assertEqual(text_graph['7']['inputs']['seed'], 123456789)
        self.assertEqual(edit_graph['10']['inputs']['seed'], 123456789)
        randint.assert_called_with(0, workflow.SEED_MAX)

        with patch.object(workflow.random, 'randint', return_value=555):
            self.assertEqual(app.resolve_seed_option({'seed': -1}), 555)
            self.assertEqual(app.resolve_seed_option({}), 555)
            self.assertEqual(app.resolve_seed_option({'seed': 'garbage'}), 555)
        self.assertEqual(app.resolve_seed_option({'seed': 0}), 0)
        self.assertEqual(app.resolve_seed_option({'seed': 7}), 7)
        self.assertEqual(app.resolve_seed_option({'seed': 2_147_483_647}), workflow.SEED_MAX)

    def test_ltx_anchor_outpaint_preserves_source_aspect_and_has_apple_cuda_parity(self):
        app = load_app()

        apple = app.build_krea2_turbo_outpaint_prompt(
            'locked scene',
            'portrait.png',
            source_width=720,
            source_height=1024,
            options={'width': 768, 'height': 448, 'seed': 42},
            profile='apple-silicon',
            identity_checkpoint_available=True,
        )
        cuda = app.build_krea2_turbo_outpaint_prompt(
            'locked scene',
            'portrait.png',
            source_width=720,
            source_height=1024,
            options={'width': 768, 'height': 448, 'seed': 42},
            profile='cuda',
        )

        self.assertEqual(apple['geometry']['scaled_width'], 315)
        self.assertEqual(apple['geometry']['scaled_height'], 448)
        self.assertEqual(apple['geometry']['left'], 226)
        self.assertEqual(apple['geometry']['right'], 227)
        self.assertEqual(apple['output'], ['18', 0])
        self.assertEqual(apple['graph']['18']['class_type'], 'ImageCompositeMasked')
        self.assertEqual(apple['graph']['14']['class_type'], 'ImagePadForOutpaint')
        self.assertEqual(apple['graph']['15']['class_type'], 'InpaintModelConditioning')
        self.assertEqual(apple['graph']['16']['class_type'], 'DifferentialDiffusion')
        self.assertEqual(apple['graph']['20']['class_type'], 'ImageBlur')
        self.assertEqual(apple['graph']['15']['inputs']['pixels'], ['21', 0])
        self.assertEqual(apple['graph']['10']['inputs']['denoise'], 0.7)
        self.assertEqual(apple['graph']['3']['class_type'], 'OTUNetLoaderW8A8')
        self.assertEqual(cuda['geometry'], apple['geometry'])
        self.assertEqual(cuda['graph']['2']['class_type'], 'UNETLoader')
        self.assertEqual(cuda['graph']['3']['class_type'], 'Krea2IdentityOptionalLoraModel')
        self.assertEqual(cuda['graph']['18']['inputs'], apple['graph']['18']['inputs'])

    def test_ltx_anchor_context_excludes_reference_sheet_inventory(self):
        app = load_app()
        prompt = (
            '### Reference Sheet Description\n'
            'Character B and several optional props.\n'
            '### Target Description\n'
            'Character A remains alone beside the counter.'
        )

        self.assertEqual(
            app._ltx_target_description(prompt),
            'Character A remains alone beside the counter.',
        )

    def test_krea2_user_loras_use_pre_lora_on_apple_and_model_loaders_on_cuda(self):
        app = load_app()
        options = {'loras': [{'id': 'styles/look.safetensors', 'strength': 0.65}]}

        apple_text = app.build_krea2_turbo_identity_prompt(
            'private prompt', options=options, profile='apple-silicon'
        )
        apple_edit = app.build_krea2_turbo_identity_prompt(
            'private prompt', image_name='reference.png', options=options, profile='apple-silicon'
        )
        cuda_text = app.build_krea2_turbo_identity_prompt(
            'private prompt', options=options, profile='cuda'
        )
        cuda_edit = app.build_krea2_turbo_identity_prompt(
            'private prompt', image_name='reference.png', options=options, profile='cuda'
        )

        self.assertEqual(
            json.loads(apple_text['1']['inputs']['lora_stack']),
            [{'on': True, 'lora': 'styles/look.safetensors', 'strength': 0.65}],
        )
        apple_edit_stack = json.loads(apple_edit['2']['inputs']['lora_stack'])
        self.assertEqual(apple_edit_stack[0]['lora'], 'krea2_identity_edit_v1_2.safetensors')
        self.assertEqual(apple_edit_stack[1]['lora'], 'styles/look.safetensors')
        self.assertEqual(apple_edit['3']['inputs']['pre_lora'], ['2', 0])
        self.assertEqual(cuda_text['20']['class_type'], 'LoraLoaderModelOnly')
        self.assertEqual(cuda_text['20']['inputs']['model'], ['2', 0])
        self.assertEqual(cuda_text['7']['inputs']['model'], ['20', 0])
        self.assertEqual(cuda_edit['20']['inputs']['model'], ['3', 0])
        self.assertEqual(cuda_edit['9']['inputs']['model'], ['20', 0])

    def test_model_scoped_lora_catalog_and_selection_do_not_mutate_global_state(self):
        app = load_app()
        with TemporaryDirectory() as td:
            comfy = Path(td) / 'ComfyUI'
            lora_root = comfy / 'models' / 'loras'
            lora_root.mkdir(parents=True)
            krea = lora_root / 'krea-look.safetensors'
            zimage = lora_root / 'z-look.safetensors'
            krea.write_bytes(b'not-a-real-safetensor')
            zimage.write_bytes(b'not-a-real-safetensor')
            Path(str(krea) + '.civitai.json').write_text(json.dumps({
                'baseModel': 'Krea 2',
                'name': 'Krea Look',
                'trainedWords': ['krea-look'],
            }))
            Path(str(zimage) + '.civitai.json').write_text(json.dumps({
                'baseModel': 'ZImageTurbo',
                'name': 'Z Look',
            }))
            krea.with_suffix('.webp').write_bytes(b'preview')
            selected_file = Path(td) / 'selected.json'

            with patch.object(app, 'COMFY', comfy), patch.object(app, 'SELECTED_LORAS_FILE', selected_file):
                catalog = app.local_lora_catalog(['Krea 2'])
                selected = app.resolve_lora_selection(
                    [
                        {'id': 'krea-look.safetensors', 'strength': 0.75},
                        {'id': 'z-look.safetensors', 'strength': 1.0},
                    ],
                    ['Krea 2'],
                )

            self.assertEqual([item['id'] for item in catalog], ['krea-look.safetensors'])
            self.assertEqual(catalog[0]['displayName'], 'Krea Look')
            self.assertTrue(catalog[0]['hasPreview'])
            self.assertEqual([(item['id'], item['strength']) for item in selected], [('krea-look.safetensors', 0.75)])
            self.assertFalse(selected_file.exists())

    def test_generate_api_routes_optional_image_to_krea2_identity_backend(self):
        app = load_app()
        completed = app.threading.Event()
        captured = {}

        def fake_run(job_id, prompt, image_path, options):
            captured.update(
                job_id=job_id,
                prompt=prompt,
                image_path=image_path,
                image_bytes=image_path.read_bytes(),
                options=options,
            )
            completed.set()

        with TemporaryDirectory() as td:
            input_dir = Path(td) / 'input'
            input_dir.mkdir()
            comfy = Path(td) / 'ComfyUI'
            lora = comfy / 'models' / 'loras' / 'krea-look.safetensors'
            lora.parent.mkdir(parents=True)
            lora.write_bytes(b'lora')
            Path(str(lora) + '.civitai.json').write_text('{"baseModel":"Krea 2"}')
            server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
            server_thread = app.threading.Thread(target=server.serve_forever, daemon=True)
            with patch.object(app, 'TOKEN', 'test-token'), \
                 patch.object(app, 'COMFY', comfy), \
                 patch.object(app, 'COMFY_INPUT_DIR', input_dir), \
                 patch.object(app, 'jobs', {}), \
                 patch.object(app, 'run_comfy_krea2_identity', side_effect=fake_run):
                server_thread.start()
                try:
                    request = app.Request(
                        f'http://127.0.0.1:{server.server_port}/api/generate',
                        data=json.dumps({
                            'backend': 'comfy-krea2-turbo-identity-edit',
                            'prompt': 'preserve this identity in a studio portrait',
                            'image_base64': 'data:image/png;base64,' + base64.b64encode(b'image').decode(),
                            'ref_boost': 5,
                            'loras': [{'id': 'krea-look.safetensors', 'strength': 0.7}],
                        }).encode('utf-8'),
                        headers={
                            'Authorization': 'Bearer test-token',
                            'Content-Type': 'application/json',
                        },
                        method='POST',
                    )
                    with app.urlopen(request, timeout=5) as response:
                        payload = json.loads(response.read().decode('utf-8'))
                        self.assertEqual(response.status, 202)
                    self.assertTrue(completed.wait(1))
                finally:
                    server.shutdown()
                    server.server_close()
                    server_thread.join(timeout=2)

        self.assertEqual(payload['backend'], 'comfy-krea2-turbo-identity-edit')
        self.assertEqual(payload['mode'], 'identity-edit')
        self.assertEqual(captured['image_path'].parent, input_dir)
        self.assertTrue(captured['image_path'].name.startswith('media-studio-inline-'))
        self.assertEqual(captured['image_bytes'], b'image')
        self.assertEqual(captured['options']['ref_boost'], 5)
        self.assertEqual(captured['options']['loras'], [{'id': 'krea-look.safetensors', 'strength': 0.7}])

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

    def test_comfy_biglove_fallback_chains_selected_loras_before_sampling(self):
        app = load_app()
        captured = {}
        with TemporaryDirectory() as td:
            root = Path(td)
            comfy = root / 'ComfyUI'
            input_dir = comfy / 'input'
            output_dir = comfy / 'output'
            lora = comfy / 'models' / 'loras' / 'looks' / 'style.safetensors'
            input_dir.mkdir(parents=True)
            output_dir.mkdir(parents=True)
            lora.parent.mkdir(parents=True)
            source = input_dir / 'source.png'
            source.write_bytes(b'image')
            lora.write_bytes(b'lora')

            def fake_urlopen(request, timeout=0):
                if isinstance(request, app.Request):
                    captured.update(json.loads(request.data.decode('utf-8')))
                    return io.BytesIO(b'{"prompt_id":"prompt-1"}')
                return io.BytesIO(json.dumps({
                    'prompt-1': {
                        'status': {'status_str': 'error', 'completed': False},
                        'outputs': {},
                    },
                }).encode('utf-8'))

            with patch.object(app, 'COMFY', comfy), \
                 patch.object(app, 'COMFY_INPUT_DIR', input_dir), \
                 patch.object(app, 'COMFY_OUTPUT_DIR', output_dir), \
                 patch.object(app, 'OUT_DIR', output_dir), \
                 patch.object(app, 'urlopen', side_effect=fake_urlopen), \
                 patch.object(app, 'append_history'), \
                 patch.object(app, 'jobs', {}):
                app.run_comfy_klein3_edit(
                    'job-1',
                    'private prompt',
                    source,
                    {'loras': [{'filePath': str(lora), 'scale': 0.6}]},
                )

        graph = captured['prompt']
        self.assertEqual(graph['11']['class_type'], 'LoraLoaderModelOnly')
        self.assertEqual(graph['11']['inputs']['model'], ['1', 0])
        self.assertEqual(graph['11']['inputs']['lora_name'], str(Path('looks') / 'style.safetensors'))
        self.assertEqual(graph['11']['inputs']['strength_model'], 0.6)
        self.assertEqual(graph['8']['inputs']['model'], ['11', 0])

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


class CoupleModeTests(unittest.TestCase):
    """Regional (couple) auto-workflows: single-subject by default, explicit regions when enabled."""

    @staticmethod
    def _regional_graph():
        return {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "waiANIMA_v10Base10.safetensors"}},
            "2": {"class_type": "LoadQwen35AnimaCLIP", "inputs": {"clip_name": "qwen35_4b.safetensors"}},
            "11": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "turbo.safetensors"}},
            "4": {"class_type": "ForgeCoupleRegionalPrompt", "inputs": {
                "model": ["11", 0], "clip": ["2", 0],
                "positive_text": "a\nb", "width": 1024, "height": 1344,
                "mode": "Basic", "background": "None", "background_weight": 0.2,
                "advanced_mapping": "[[0.0, 0.5, 0.0, 1.0, 1.0], [0.5, 1.0, 0.0, 1.0, 1.0]]",
            }},
            "6": {"class_type": "EmptyQwenImageLayeredLatentImage", "inputs": {"width": 1024, "height": 1344}},
            "7": {"class_type": "KSampler", "inputs": {
                "model": ["4", 0], "positive": ["4", 1], "negative": ["4", 1],
                "latent_image": ["6", 0], "seed": 1, "steps": 8, "cfg": 1.0,
            }},
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
            "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
        }

    def test_couple_off_splices_regional_node_for_full_canvas(self):
        app = load_app()
        graph = self._regional_graph()
        self.assertTrue(app._auto_bypass_regional_prompt_node(graph, "4", "a person by a bonfire", "lowres"))
        self.assertNotIn("4", graph)
        sampler = graph["7"]["inputs"]
        self.assertEqual(sampler["model"], ["11", 0])
        pos_id, neg_id = sampler["positive"][0], sampler["negative"][0]
        self.assertNotEqual(pos_id, neg_id)
        self.assertEqual(graph[pos_id]["class_type"], "CLIPTextEncode")
        self.assertEqual(graph[pos_id]["inputs"], {"clip": ["2", 0], "text": "a person by a bonfire"})
        self.assertEqual(graph[neg_id]["inputs"], {"clip": ["2", 0], "text": "lowres"})

    def test_couple_on_builds_advanced_mapping_with_split_and_anchor(self):
        app = load_app()
        node = self._regional_graph()["4"]
        app._auto_apply_couple_regions(node, "positive_text", "sakura\nblack hair", {"couple_split": 0.7, "couple_direction": "horizontal"})
        self.assertEqual(node["inputs"]["mode"], "Advanced")
        self.assertEqual(node["inputs"]["background"], "None")
        rows = json.loads(node["inputs"]["advanced_mapping"])
        self.assertEqual(rows, [[0.0, 0.7, 0.0, 1.0, 1.0], [0.7, 1.0, 0.0, 1.0, 1.0]])
        # Composition anchor per line — without it regions blend into ONE subject.
        self.assertEqual(node["inputs"]["positive_text"], "2girls, sakura\n2girls, black hair")

    def test_couple_pair_anchor_replaces_conflicting_solo_tags(self):
        app = load_app()
        node = self._regional_graph()["4"]
        app._auto_apply_couple_regions(
            node, "positive_text", "1girl, sakura\nSOLO, 1boy, dark knight",
            {"couple_pair": "mixed"},
        )
        self.assertEqual(node["inputs"]["positive_text"], "1boy, 1girl, sakura\n1boy, 1girl, dark knight")

    def test_couple_shared_scene_adds_full_canvas_row_and_vertical_split(self):
        app = load_app()
        node = self._regional_graph()["4"]
        app._auto_apply_couple_regions(
            node, "positive_text", "bonfire night\nsakura\nblack hair",
            {"couple_shared": True, "couple_split": 0.5, "couple_direction": "vertical"},
        )
        rows = json.loads(node["inputs"]["advanced_mapping"])
        self.assertEqual(rows[0], [0.0, 1.0, 0.0, 1.0, 0.2])  # shared scene at the node's background weight
        self.assertEqual(rows[1], [0.0, 1.0, 0.0, 0.5, 1.0])
        self.assertEqual(rows[2], [0.0, 1.0, 0.5, 1.0, 1.0])
        # Shared scene line stays un-anchored; character lines get the pair anchor.
        self.assertEqual(node["inputs"]["positive_text"], "bonfire night\n2girls, sakura\n2girls, black hair")

    def test_couple_single_line_duplicates_character(self):
        app = load_app()
        node = self._regional_graph()["4"]
        app._auto_apply_couple_regions(node, "positive_text", "one line", {})
        self.assertEqual(node["inputs"]["positive_text"], "2girls, one line\n2girls, one line")

    def test_couple_on_gets_real_negative_conditioning(self):
        app = load_app()
        graph = self._regional_graph()
        sampler = graph["7"]["inputs"]
        self.assertEqual(sampler["negative"], ["4", 1])  # template: neg == pos, cfg is a no-op
        self.assertTrue(app._auto_split_regional_negative(graph, sampler, "4", "blurry, lowres"))
        self.assertIn("4", graph)  # regional node stays for couple mode
        self.assertEqual(sampler["positive"], ["4", 1])
        neg_id = sampler["negative"][0]
        self.assertNotEqual(neg_id, "4")
        self.assertEqual(graph[neg_id]["class_type"], "CLIPTextEncode")
        self.assertEqual(graph[neg_id]["inputs"], {"clip": ["2", 0], "text": "blurry, lowres"})

    def test_regional_negative_rewire_skips_distinct_negative_nodes(self):
        app = load_app()
        graph = self._regional_graph()
        graph["12"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": "already separate"}}
        sampler = graph["7"]["inputs"]
        sampler["negative"] = ["12", 0]
        self.assertFalse(app._auto_split_regional_negative(graph, sampler, "4", "blurry"))
        self.assertEqual(sampler["negative"], ["12", 0])

    def test_user_loras_chain_above_the_model_loader(self):
        app = load_app()
        graph = self._regional_graph()
        sampler = graph["7"]["inputs"]
        with TemporaryDirectory() as td:
            root = Path(td)
            lora_dir = root / "models" / "loras"
            lora_dir.mkdir(parents=True)
            (lora_dir / "sakura_anima.safetensors").write_bytes(b"")
            with patch.object(app, "COMFY", root):
                applied = app._auto_apply_model_loras(graph, sampler, [
                    {"id": "sakura_anima.safetensors", "path": str(lora_dir / "sakura_anima.safetensors"), "strength": 0.8},
                ])
        self.assertEqual(applied, 1)
        new_id = graph["11"]["inputs"]["model"][0]
        self.assertNotEqual(new_id, "1")  # turbo lora now feeds from the user lora...
        self.assertEqual(graph[new_id]["class_type"], "LoraLoaderModelOnly")
        self.assertEqual(graph[new_id]["inputs"]["lora_name"], "sakura_anima.safetensors")
        self.assertEqual(graph[new_id]["inputs"]["strength_model"], 0.8)
        self.assertEqual(graph[new_id]["inputs"]["model"], ["1", 0])  # ...which feeds from the loader
        self.assertEqual(sampler["model"], ["4", 0])  # sampler wiring untouched

    def test_normalize_couple_options_coerces_types(self):
        app = load_app()
        options = {"couple_mode": "true", "couple_shared": 0, "couple_split": "2.5", "couple_direction": "Diagonal", "couple_pair": "Robots"}
        app._normalize_couple_options(options)
        self.assertIs(options["couple_mode"], True)
        self.assertIs(options["couple_shared"], False)
        self.assertEqual(options["couple_split"], 0.9)
        self.assertEqual(options["couple_direction"], "horizontal")
        self.assertEqual(options["couple_pair"], "girls")


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


    def test_ltx_variant_sampling_recipe_env_is_opt_in_per_variant(self):
        app = load_app()

        # No variant ships an override today: the author's DMD ramp measured worse
        # than the built-in table (see the note on dmd-q8-v13). The mechanism stays
        # so a future recipe is a config line, not a patch.
        for variant, spec in app.LTX2_MLX_VARIANTS.items():
            recipe = spec.get('runtime_env') or {}
            self.assertIsInstance(recipe, dict, variant)
            for key, value in recipe.items():
                self.assertTrue(str(key).startswith('LTX2_'), f'{variant}: {key}')
                if key.endswith('SIGMAS'):
                    schedule = [float(x) for x in str(value).split(',')]
                    self.assertLessEqual(schedule[0], 1.0, variant)
                    self.assertEqual(schedule[-1], 0.0, variant)
                    self.assertTrue(all(b <= a for a, b in zip(schedule, schedule[1:])), variant)

    def test_every_variant_model_dir_matches_its_declared_pipeline(self):
        app = load_app()

        # --distilled aborts at load on a package with no distilled transformer,
        # and --two-stage needs the dev one. The failure surfaces to the studio as
        # a bare "did not return a job id", so assert the pairing here instead of
        # discovering it from a redacted error. Only checks variants whose model
        # directory is present, so this stays useful on a partial install.
        for variant, spec in app.LTX2_MLX_VARIANTS.items():
            model_dir = Path(spec['model'])
            if not model_dir.is_dir():
                continue
            names = {p.name for p in model_dir.iterdir()}
            has_distilled = any(n.startswith('transformer-distilled') for n in names)
            has_dev = any(n.startswith('transformer-dev') for n in names)
            if spec.get('video_distilled'):
                self.assertTrue(
                    has_distilled,
                    f'{variant} declares video_distilled but ships no distilled transformer: {sorted(names)}',
                )
            else:
                self.assertTrue(
                    has_dev,
                    f'{variant} runs the dev two-stage but ships no dev transformer: {sorted(names)}',
                )


class LoraCacheTests(unittest.TestCase):
    """The LoRA cache holds data fetched from the internet (Civitai card art and
    version lists). It must be unreadable at rest, and it must never outlive the
    installed file it describes — a replaced LoRA showing its predecessor's art, or
    an uninstalled one lingering on disk, are both failures."""

    def _app(self, root, key='cache-test-key'):
        app = load_app()
        app.LORA_CACHE_DIR = root / 'lora-cache'
        app.LORA_PREVIEW_CACHE_DIR = app.LORA_CACHE_DIR / 'previews'
        app.LORA_VERSION_CACHE_DIR = app.LORA_CACHE_DIR / 'versions'
        app.output_encryption_password = lambda create=True: key
        return app

    def _lora(self, root, name='style.safetensors', body=b'weights', url='https://image.civitai.com/card.jpg'):
        path = root / name
        path.write_bytes(body)
        return {
            'id': name,
            'name': name,
            'path': str(path),
            'baseModel': 'Krea 2',
            'metadata': {'previewUrl': url, 'modelVersion': {'id': '9', 'modelId': '42', 'name': 'v1'}},
        }

    def test_cached_preview_round_trips_and_is_unreadable_on_disk(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            app = self._app(root)
            item = self._lora(root)
            url = item['metadata']['previewUrl']

            app.cache_lora_preview(item, url, b'\x89PNG-secret-card-art', 'image/png')
            # Serve from disk, not from the in-process copy.
            app._lora_cache_memory.clear()
            app._lora_cache_memory_bytes = 0

            data, ctype = app.cached_lora_preview(item, url)
            self.assertEqual(data, b'\x89PNG-secret-card-art')
            self.assertEqual(ctype, 'image/png')

            stored = list(app.LORA_PREVIEW_CACHE_DIR.glob('*.enc'))
            self.assertEqual(len(stored), 1)
            blob = stored[0].read_bytes()
            self.assertNotIn(b'PNG-secret-card-art', blob)
            self.assertNotIn(b'image/png', blob)
            # The filename must not name the collection either.
            self.assertNotIn('style', stored[0].name)

    def test_a_replaced_lora_never_serves_the_old_preview(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            app = self._app(root)
            item = self._lora(root)
            url = item['metadata']['previewUrl']
            app.cache_lora_preview(item, url, b'old-art', 'image/png')

            # An update-and-replace keeps the id and rewrites the file.
            time.sleep(0.01)
            Path(item['path']).write_bytes(b'different-weights')
            app._lora_cache_memory.clear()
            app._lora_cache_memory_bytes = 0

            self.assertIsNone(app.cached_lora_preview(item, url))

    def test_pruning_drops_uninstalled_loras_and_keeps_installed_ones(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            app = self._app(root)
            kept = self._lora(root, 'kept.safetensors')
            removed = self._lora(root, 'removed.safetensors')
            app.cache_lora_preview(kept, kept['metadata']['previewUrl'], b'kept-art', 'image/png')
            app.cache_lora_preview(removed, removed['metadata']['previewUrl'], b'gone-art', 'image/png')
            app.cache_model_versions('42', {'at': time.time(), 'versions': [{'id': '9'}]})
            self.assertEqual(len(list(app.LORA_PREVIEW_CACHE_DIR.glob('*.enc'))), 2)

            Path(removed['path']).unlink()
            app.prune_lora_caches([kept])

            surviving = list(app.LORA_PREVIEW_CACHE_DIR.glob('*.enc'))
            self.assertEqual([p.name for p in surviving], [f"{app.lora_cache_key(kept, kept['metadata']['previewUrl'])}.enc"])
            # The version list belongs to the Civitai model, which is still installed.
            self.assertIsNotNone(app.cached_model_versions('42'))

            app.prune_lora_caches([])
            self.assertEqual(list(app.LORA_PREVIEW_CACHE_DIR.glob('*.enc')), [])
            self.assertIsNone(app.cached_model_versions('42'))

    def test_no_machine_key_means_no_cache_rather_than_a_plaintext_one(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            app = self._app(root, key=None)
            item = self._lora(root)
            url = item['metadata']['previewUrl']

            app.cache_lora_preview(item, url, b'card-art', 'image/png')
            self.assertFalse(app.LORA_PREVIEW_CACHE_DIR.exists() and list(app.LORA_PREVIEW_CACHE_DIR.glob('*')))
            app._lora_cache_memory.clear()
            app._lora_cache_memory_bytes = 0
            self.assertIsNone(app.cached_lora_preview(item, url))

    def test_version_lists_survive_a_restart_without_asking_civitai_again(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            app = self._app(root)
            record = {'at': time.time(), 'versions': [{'id': '11', 'name': 'v2', 'baseModel': 'Krea 2'}]}
            app.cache_model_versions('42', record)

            # A restart: fresh module, empty in-memory cache, same encrypted dir.
            restarted = self._app(root)
            calls = []
            restarted.civitai_json = lambda *a, **k: calls.append(a) or {'modelVersions': []}

            self.assertEqual(restarted.civitai_model_versions('42'), record['versions'])
            self.assertEqual(calls, [])


class BfsHeadSwapGuideTests(unittest.TestCase):
    """The guide layout IS the conditioning contract for the BFS head-swap LoRA.

    Its author's node reserves a chroma strip that the model was trained to read.
    Get the side, the size, or the frame dimensions wrong and the model receives
    something it has never seen, so these are asserted rather than trusted.
    """

    def _clip(self, directory, name, width, height):
        path = Path(directory) / name
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi',
             '-i', f'testsrc=size={width}x{height}:rate=8:duration=1',
             '-pix_fmt', 'yuv420p', str(path)],
            check=True, timeout=120,
        )
        return path

    def _face(self, directory, name, width, height):
        path = Path(directory) / name
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi',
             '-i', f'color=c=red:size={width}x{height}', '-frames:v', '1', str(path)],
            check=True, timeout=120,
        )
        return path

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
    def test_guide_keeps_the_frame_size_and_fits_the_footage_beside_the_strip(self):
        # ReservedRegionFrameComposer keeps the canvas at the source frame size
        # and fits the footage into what the strip leaves:
        #   canvas = Image.new("RGBA", (orig_w, orig_h), ...)
        #   video_x, video_y = region_size_px, (orig_h - fitted_video_h) // 2
        # Widening the canvas instead gives the LoRA a layout it never saw in
        # training and it copies the guide through instead of swapping a face.
        with tempfile.TemporaryDirectory() as tmp:
            source = self._clip(tmp, 'src.mp4', 640, 384)
            face = self._face(tmp, 'face.png', 200, 200)
            out = Path(tmp) / 'guide.mp4'
            info = load_app().build_bfs_headswap_guide_video(source, face, out, region_px=128)
            # Frame size is the source's, NOT source + strip.
            self.assertEqual((info['width'], info['height']), (640, 384))
            self.assertEqual(load_app()._probe_video_dimensions(out), (640, 384))
            # 512x384 of usable width; 640x384 footage fits to 512x307 (aspect kept).
            self.assertEqual(info['video_width'], 512)
            self.assertEqual(info['video_height'], 306)
            self.assertEqual(info['video_x'], 128)
            self.assertEqual(info['video_y'], (384 - 306) // 2)
            # The render is the whole canvas, so it is the delivered frame.
            self.assertEqual((info['content_width'], info['content_height']), (640, 384))

    def test_the_footage_keeps_its_aspect_ratio_inside_the_guide(self):
        # Stretching it to fill the leftover box would hand the model distorted
        # motion to track. The node fits; so do we.
        plan = load_app().plan_bfs_headswap_geometry(1080, 1920, region_px=256)
        self.assertAlmostEqual(
            plan['video_width'] / plan['video_height'], 1080 / 1920, places=2,
        )
        self.assertLessEqual(plan['video_width'], plan['width'] - plan['region_px'])
        self.assertLessEqual(plan['video_height'], plan['height'])

    def test_the_v3_trigger_is_required_before_a_render_is_spent(self):
        # No trigger -> the IC-LoRA never engages and the model reproduces the
        # guide (green column, face box, untouched footage). That failure looks
        # like a bug in the compositor and costs a full render to discover, so
        # it is caught up front instead.
        app_mod = load_app()
        self.assertTrue(app_mod.bfs_headswap_prompt_has_trigger(
            'head_swap: FACE: adult woman, fair skin ACTION: seated, facing camera'))
        self.assertTrue(app_mod.bfs_headswap_prompt_has_trigger('HEAD_SWAP: FACE: x ACTION: y'))
        self.assertFalse(app_mod.bfs_headswap_prompt_has_trigger(
            'a woman sitting on a sofa, cinematic lighting'))
        self.assertFalse(app_mod.bfs_headswap_prompt_has_trigger(''))
        # The message has to carry the template, since that is the whole fix.
        self.assertIn('FACE:', app_mod.BFS_HEADSWAP_PROMPT_HELP)
        self.assertIn('ACTION:', app_mod.BFS_HEADSWAP_PROMPT_HELP)

    def test_the_bfs_adapter_specifically_must_be_among_the_active_loras(self):
        # "At least one LoRA" passed with any unrelated LoRA selected, and the
        # render then came back as a copy of the guide after a full generation.
        # A muted LoRA is filtered out upstream, so the panel can show the
        # head-swap LoRA at strength 1 while nothing is actually fused.
        app_mod = load_app()
        bfs = {'filePath': '/l/head_swap_v3_rank_adaptive_fro_098.safetensors'}
        self.assertTrue(app_mod.bfs_headswap_lora_selected(bfs))
        self.assertTrue(app_mod.bfs_headswap_lora_selected({'name': 'BFS Head-Swap v3'}))
        self.assertFalse(app_mod.bfs_headswap_lora_selected({'filePath': '/l/LTX2.3_Crisp_Enhance.safetensors'}))
        self.assertFalse(app_mod.bfs_headswap_lora_selected({}))
        self.assertFalse(app_mod.bfs_headswap_lora_selected(None))

    def test_the_swap_engine_is_chosen_explicitly_and_defaults_to_bfs(self):
        # FaceFusion and BFS are different tools, not quality tiers, so the
        # engine is read from the request rather than guessed. An unknown value
        # must fall back to BFS instead of silently running nothing.
        app_mod = load_app()
        self.assertEqual(app_mod._headswap_backend_name({}), 'bfs')
        self.assertEqual(app_mod._headswap_backend_name({'head_swap_backend': 'facefusion'}), 'facefusion')
        self.assertEqual(app_mod._headswap_backend_name({'head_swap_backend': 'FaceFusion'}), 'facefusion')
        self.assertEqual(app_mod._headswap_backend_name({'head_swap_backend': 'nonsense'}), 'bfs')
        self.assertEqual(app_mod._headswap_backend_name(None), 'bfs')

    def test_a_strip_that_would_not_fit_is_rejected(self):
        with self.assertRaises(RuntimeError):
            load_app().plan_bfs_headswap_geometry(320, 320, region_px=512)

    def test_the_render_is_the_deliverable_so_nothing_crops_it(self):
        # The author's model card: the generated result does NOT contain the
        # strip. Sizing the render to the guide canvas and cropping the strip
        # back off is what stretched the scene and read as a zoom, so the crop
        # helper is gone — assert it stays gone.
        self.assertFalse(
            hasattr(load_app(), 'crop_bfs_headswap_region'),
            'the head-swap render is already the deliverable; nothing may crop it',
        )

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
    def test_guide_is_resampled_to_the_render_frame_rate(self):
        # The runtime reads the guide's first N frames at ITS rate, so a guide
        # left at the source's rate drifts against the render frame for frame.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'src25.mp4'
            subprocess.run(
                ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi',
                 '-i', 'testsrc=size=640x384:rate=25:duration=2',
                 '-pix_fmt', 'yuv420p', str(path)],
                check=True, timeout=120,
            )
            face = self._face(tmp, 'face.png', 64, 64)
            guide = Path(tmp) / 'guide.mp4'
            load_app().build_bfs_headswap_guide_video(path, face, guide, region_px=128, frame_rate=24)
            rate = subprocess.run(
                ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                 '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', str(guide)],
                capture_output=True, text=True, check=True, timeout=60,
            ).stdout.strip()
            self.assertEqual(rate, '24/1')

    def test_render_dimensions_are_snapped_to_the_latent_grid(self):
        # The render size comes from the source, which is arbitrary (a phone clip
        # is 1080 wide), while both axes must sit on the pipeline's grid.
        plan = load_app().plan_bfs_headswap_geometry(500, 300, region_px=128)
        self.assertEqual((plan['width'], plan['height']), (512, 320))
        self.assertEqual(plan['width'] % 64, 0)
        self.assertEqual(plan['height'] % 64, 0)

    def test_max_dimension_caps_the_render_and_keeps_the_aspect(self):
        # The speed lever: cost scales with the rendered frame.
        plan = load_app().plan_bfs_headswap_geometry(768, 1088, region_px=256, max_dimension=768)
        self.assertEqual((plan['width'], plan['height']), (512, 768))
        uncapped = load_app().plan_bfs_headswap_geometry(768, 1088, region_px=256)
        self.assertEqual((uncapped['width'], uncapped['height']), (768, 1088))

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
    def test_the_strip_is_snapped_to_a_multiple_of_32(self):
        # LTX requires both axes divisible by 32, and the strip is the only
        # dimension we choose — an odd width would make the canvas unrenderable.
        with tempfile.TemporaryDirectory() as tmp:
            source = self._clip(tmp, 'small.mp4', 256, 256)
            face = self._face(tmp, 'face.png', 200, 200)
            info = load_app().build_bfs_headswap_guide_video(
                source, face, Path(tmp) / 'g.mp4', region_px=200)
            self.assertEqual(info['region_px'], 192)
            self.assertEqual(info['width'] % 32, 0)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
    def test_reserved_strip_is_chroma_green_on_the_expected_side(self):
        # Dimensions alone would still pass if the strip flipped sides or the key
        # colour changed, and either would hand the LoRA conditioning it was never
        # trained on. Sample actual pixels instead.
        with tempfile.TemporaryDirectory() as tmp:
            source = self._clip(tmp, 'src.mp4', 640, 384)
            face = self._face(tmp, 'face.png', 64, 64)
            out = Path(tmp) / 'guide.mp4'
            app_mod = load_app()
            app_mod.build_bfs_headswap_guide_video(source, face, out, region_px=128)

            def sample(x, y):
                raw = subprocess.run(
                    ['ffmpeg', '-v', 'error', '-i', str(out), '-frames:v', '1',
                     '-vf', f'crop=4:4:{x}:{y}', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
                    capture_output=True, check=True, timeout=60,
                ).stdout
                return raw[0], raw[1], raw[2]

            # Top-left corner sits inside the reserved strip, above the face.
            r, g, b = sample(0, 0)
            self.assertGreater(g, 200, f'reserved strip should be chroma green, got rgb({r},{g},{b})')
            self.assertLess(r, 80)
            self.assertLess(b, 80)
            # 640x384 source, 128 strip -> footage fitted to 512x306 at (128, 39).
            # Its middle must carry picture...
            r2, g2, b2 = sample(384, 192)
            self.assertFalse(
                g2 > 200 and r2 < 80 and b2 < 80,
                f'fitted footage should carry frame, got rgb({r2},{g2},{b2})',
            )
            # ...and the band above it must be chroma, because the node fits the
            # footage rather than stretching it. Asserting this keeps the layout
            # honest: stretching to fill would track distorted motion, and
            # widening the canvas hands the LoRA an unseen layout entirely.
            r3, g3, b3 = sample(384, 4)
            self.assertGreater(g3, 200, f'letterbox above the footage should be chroma, got rgb({r3},{g3},{b3})')
            self.assertLess(r3, 80)
            self.assertLess(b3, 80)


class CancelGenerationJobTests(unittest.TestCase):
    """The studio Cancel button must actually stop the backend render — an
    un-interrupted job keeps burning the GPU and makes the next generation run
    at half speed (the reported 'regen took twice as long' symptom)."""

    def test_cancel_route_terminates_a_native_jobs_live_subprocess(self):
        app = load_app()
        proc = subprocess.Popen(['sleep', '30'])
        jobs = {'native1': {'id': 'native1', 'status': 'running', 'backend': 'ltx23-eros-dmd'}}
        server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        server_thread = app.threading.Thread(target=server.serve_forever, daemon=True)
        try:
            with patch.object(app, 'TOKEN', 'test-token'), \
                 patch.object(app, 'jobs', jobs), \
                 patch.object(app, 'native_job_procs', {'native1': proc}):
                server_thread.start()
                request = app.Request(
                    f'http://127.0.0.1:{server.server_port}/api/job/native1/cancel',
                    data=b'{}',
                    headers={'Authorization': 'Bearer test-token', 'Content-Type': 'application/json'},
                    method='POST',
                )
                with app.urlopen(request, timeout=5) as response:
                    payload = json.loads(response.read().decode('utf-8'))
                self.assertEqual(response.status, 200)
            self.assertTrue(payload['ok'])
            self.assertTrue(payload['interrupted'])
            self.assertTrue(jobs['native1']['cancel_requested'])
            self.assertIsNotNone(proc.wait(timeout=5))
        finally:
            if proc.poll() is None:
                proc.kill()
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)

    def test_cancel_between_native_stages_flags_the_record_as_interrupted(self):
        # No live subprocess right now (e.g. staging inputs, or between the main
        # render and a post pass) — the flag alone stops the runner at its next
        # checkpoint, so that still counts as an interrupt.
        app = load_app()
        jobs = {'native2': {'id': 'native2', 'status': 'queued'}}
        with patch.object(app, 'jobs', jobs), patch.object(app, 'native_job_procs', {}):
            result = app.cancel_generation_job('native2')
        self.assertTrue(result['interrupted'])
        self.assertTrue(jobs['native2']['cancel_requested'])

    def test_cancel_of_a_pending_comfy_prompt_deletes_it_from_the_queue(self):
        app = load_app()
        calls = []

        class FakeResponse:
            def __init__(self, payload):
                self._payload = payload
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self):
                return self._payload

        def fake_urlopen(request, timeout=None):
            url = request.full_url
            calls.append((request.get_method(), url, request.data))
            if url.endswith('/queue') and request.get_method() == 'GET':
                return FakeResponse(json.dumps({
                    'queue_running': [[1, 'running-prompt']],
                    'queue_pending': [[2, 'pending-prompt']],
                }).encode('utf-8'))
            return FakeResponse(b'{}')

        with patch.object(app, 'jobs', {}), patch.object(app, 'native_job_procs', {}), \
             patch.object(app, 'COMFY_LANES', {'default': 'http://comfy.test'}), \
             patch.object(app, 'urlopen', side_effect=fake_urlopen):
            result = app.cancel_generation_job('pending-prompt')
        self.assertTrue(result['interrupted'])
        deletes = [c for c in calls if c[0] == 'POST' and c[1].endswith('/queue')]
        self.assertEqual(len(deletes), 1)
        self.assertEqual(json.loads(deletes[0][2].decode('utf-8')), {'delete': ['pending-prompt']})

    def test_cancel_of_the_executing_comfy_prompt_interrupts_it(self):
        app = load_app()
        calls = []

        class FakeResponse:
            def __init__(self, payload):
                self._payload = payload
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self):
                return self._payload

        def fake_urlopen(request, timeout=None):
            url = request.full_url
            calls.append((request.get_method(), url))
            if url.endswith('/queue') and request.get_method() == 'GET':
                return FakeResponse(json.dumps({
                    'queue_running': [[1, 'running-prompt']],
                    'queue_pending': [],
                }).encode('utf-8'))
            return FakeResponse(b'{}')

        with patch.object(app, 'jobs', {}), patch.object(app, 'native_job_procs', {}), \
             patch.object(app, 'COMFY_LANES', {'default': 'http://comfy.test'}), \
             patch.object(app, 'urlopen', side_effect=fake_urlopen):
            result = app.cancel_generation_job('running-prompt')
        self.assertTrue(result['interrupted'])
        self.assertIn(('POST', 'http://comfy.test/interrupt'), calls)

    def test_cancel_of_a_finished_or_unknown_job_is_a_noop(self):
        app = load_app()

        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self):
                return json.dumps({'queue_running': [], 'queue_pending': []}).encode('utf-8')

        jobs = {'done1': {'id': 'done1', 'status': 'success'}}
        with patch.object(app, 'jobs', jobs), patch.object(app, 'native_job_procs', {}), \
             patch.object(app, 'COMFY_LANES', {'default': 'http://comfy.test'}), \
             patch.object(app, 'urlopen', return_value=FakeResponse()):
            finished = app.cancel_generation_job('done1')
            unknown = app.cancel_generation_job('nope')
        self.assertTrue(finished['ok'])
        self.assertFalse(finished['interrupted'])
        self.assertNotIn('cancel_requested', jobs['done1'])
        self.assertTrue(unknown['ok'])
        self.assertFalse(unknown['interrupted'])

    def test_native_runner_raises_cancelled_when_flagged_before_the_spawn(self):
        app = load_app()
        jobs = {'native3': {'id': 'native3', 'status': 'running', 'cancel_requested': True}}
        with patch.object(app, 'jobs', jobs), patch.object(app, 'native_job_procs', {}):
            with self.assertRaises(app.NativeJobCancelled):
                app._run_native_ltx_subprocess('native3', jobs['native3'], ['sleep', '30'], cwd='.', env=os.environ.copy())

    def test_native_runner_raises_cancelled_when_flagged_mid_render(self):
        app = load_app()
        jobs = {'native4': {'id': 'native4', 'status': 'running'}}
        procs = {}

        def flag_soon():
            time.sleep(0.5)
            with app.jobs_lock:
                jobs['native4']['cancel_requested'] = True

        flagger = app.threading.Thread(target=flag_soon, daemon=True)
        started = time.monotonic()
        with patch.object(app, 'jobs', jobs), patch.object(app, 'native_job_procs', procs):
            flagger.start()
            with self.assertRaises(app.NativeJobCancelled):
                app._run_native_ltx_subprocess('native4', jobs['native4'], ['sleep', '30'], cwd='.', env=os.environ.copy())
        flagger.join(timeout=2)
        # The render must die promptly, not run the sleep to completion.
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(procs, {})
