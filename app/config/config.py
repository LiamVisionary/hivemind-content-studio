import os
import shutil
import socket

import toml
from loguru import logger

from hivemind_content_studio.shared_env import load_shared_hive_env

root_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
config_file = f"{root_dir}/config.toml"

_APP_SECRET_DEFAULTS = {
    "api_key": "",
    "pexels_api_keys": [],
    "pixabay_api_keys": [],
    "openai_api_key": "",
    "moonshot_api_key": "",
    "oneapi_api_key": "",
    "azure_api_key": "",
    "gemini_api_key": "",
    "qwen_api_key": "",
    "cloudflare_api_key": "",
    "cloudflare_account_id": "",
    "minimax_api_key": "",
    "deepseek_api_key": "",
    "modelscope_api_key": "",
    "ernie_api_key": "",
    "ernie_secret_key": "",
}
_AZURE_SECRET_DEFAULTS = {"speech_key": "", "speech_region": ""}
_SILICONFLOW_SECRET_DEFAULTS = {"api_key": ""}


def _load_hive_env():
    return load_shared_hive_env()


def _env_value(env, *names):
    for name in names:
        value = env.get(name)
        if value:
            return value
    return ""


def _env_list(env, *names):
    value = _env_value(env, *names)
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _apply_hive_env(_config):
    env = _load_hive_env()
    app_config = dict(_config.get("app", {}))
    azure_config = dict(_config.get("azure", {}))
    siliconflow_config = dict(_config.get("siliconflow", {}))

    app_string_map = {
        "api_key": ("MONEYPRINTERTURBO_API_KEY", "MPT_API_KEY"),
        "openai_api_key": ("OPENAI_API_KEY",),
        "openai_base_url": ("OPENAI_BASE_URL",),
        "openai_model_name": ("OPENAI_MODEL",),
        "localtts_base_url": ("LOCALTTS_BASE_URL",),
        "localtts_model_name": ("LOCALTTS_MODEL",),
        "localtts_voice_name": ("LOCALTTS_VOICE",),
        "localtts_instruct": ("LOCALTTS_INSTRUCT",),
        "moonshot_api_key": ("MOONSHOT_API_KEY",),
        "oneapi_api_key": ("ONEAPI_API_KEY",),
        "oneapi_base_url": ("ONEAPI_BASE_URL",),
        "oneapi_model_name": ("ONEAPI_MODEL",),
        "azure_api_key": ("AZURE_OPENAI_API_KEY", "AZURE_API_KEY"),
        "azure_base_url": ("AZURE_OPENAI_ENDPOINT", "AZURE_BASE_URL"),
        "azure_model_name": ("AZURE_OPENAI_DEPLOYMENT", "AZURE_MODEL"),
        "gemini_api_key": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        "qwen_api_key": ("DASHSCOPE_API_KEY", "QWEN_API_KEY"),
        "cloudflare_api_key": ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY"),
        "cloudflare_account_id": ("CLOUDFLARE_ACCOUNT_ID",),
        "minimax_api_key": ("MINIMAX_API_KEY",),
        "deepseek_api_key": ("DEEPSEEK_API_KEY",),
        "modelscope_api_key": ("MODELSCOPE_API_KEY",),
        "ernie_api_key": ("ERNIE_API_KEY",),
        "ernie_secret_key": ("ERNIE_SECRET_KEY",),
    }
    for config_key, env_names in app_string_map.items():
        value = _env_value(env, *env_names)
        if value:
            app_config[config_key] = value

    for config_key, env_names in {
        "pexels_api_keys": ("PEXELS_API_KEYS", "PEXELS_API_KEY"),
        "pixabay_api_keys": ("PIXABAY_API_KEYS", "PIXABAY_API_KEY"),
    }.items():
        values = _env_list(env, *env_names)
        if values:
            app_config[config_key] = values

    if not app_config.get("openai_api_key"):
        bankr_key = _env_value(env, "BANKR_LLM_KEY", "BANKR_MANAGEMENT_KEY")
        honey_gateway = _env_value(env, "HONEY_COMPUTE_GATEWAY_URL")
        if bankr_key and honey_gateway:
            app_config["llm_provider"] = "openai"
            app_config["openai_api_key"] = bankr_key
            app_config["openai_base_url"] = honey_gateway.rstrip("/") + "/v1"
            app_config.setdefault("openai_model_name", "gpt-4o-mini")

    for config_key, env_names in {
        "speech_key": ("AZURE_SPEECH_KEY", "SPEECH_KEY"),
        "speech_region": ("AZURE_SPEECH_REGION", "SPEECH_REGION"),
    }.items():
        value = _env_value(env, *env_names)
        if value:
            azure_config[config_key] = value

    siliconflow_key = _env_value(env, "SILICONFLOW_API_KEY")
    if siliconflow_key:
        siliconflow_config["api_key"] = siliconflow_key

    _config["app"] = app_config
    _config["azure"] = azure_config
    _config["siliconflow"] = siliconflow_config
    return _config


def _without_runtime_secrets(section, defaults):
    clean_section = dict(section)
    for key, default_value in defaults.items():
        if key in clean_section:
            clean_section[key] = default_value
    return clean_section


def load_config():
    # fix: IsADirectoryError: [Errno 21] Is a directory: '/MoneyPrinterTurbo/config.toml'
    if os.path.isdir(config_file):
        shutil.rmtree(config_file)

    if not os.path.isfile(config_file):
        example_file = f"{root_dir}/config.example.toml"
        if os.path.isfile(example_file):
            shutil.copyfile(example_file, config_file)
            logger.info("copy config.example.toml to config.toml")

    logger.info(f"load config from file: {config_file}")

    try:
        _config_ = toml.load(config_file)
    except Exception as e:
        logger.warning(f"load config failed: {str(e)}, try to load as utf-8-sig")
        with open(config_file, mode="r", encoding="utf-8-sig") as fp:
            _cfg_content = fp.read()
            _config_ = toml.loads(_cfg_content)
    return _apply_hive_env(_config_)


def save_config():
    with open(config_file, "w", encoding="utf-8") as f:
        _cfg["app"] = _without_runtime_secrets(app, _APP_SECRET_DEFAULTS)
        _cfg["azure"] = _without_runtime_secrets(azure, _AZURE_SECRET_DEFAULTS)
        _cfg["siliconflow"] = _without_runtime_secrets(
            siliconflow, _SILICONFLOW_SECRET_DEFAULTS
        )
        _cfg["ui"] = ui
        f.write(toml.dumps(_cfg))


_cfg = load_config()
app = _cfg.get("app", {})
whisper = _cfg.get("whisper", {})
proxy = _cfg.get("proxy", {})
azure = _cfg.get("azure", {})
siliconflow = _cfg.get("siliconflow", {})
ui = _cfg.get(
    "ui",
    {
        "hide_log": False,
    },
)

hostname = socket.gethostname()

log_level = _cfg.get("log_level", "DEBUG")
listen_host = _cfg.get("listen_host", "0.0.0.0")
listen_port = _cfg.get("listen_port", 8080)
project_name = _cfg.get("project_name", "MoneyPrinterTurbo")
project_description = _cfg.get(
    "project_description",
    "<a href='https://github.com/harry0703/MoneyPrinterTurbo'>https://github.com/harry0703/MoneyPrinterTurbo</a>",
)
project_version = _cfg.get("project_version", "1.2.7")
reload_debug = False

app["redis_host"] = os.getenv(
    "MPT_APP_REDIS_HOST",
    os.getenv("REDIS_HOST", app.get("redis_host", "localhost")),
)

imagemagick_path = app.get("imagemagick_path", "")
if imagemagick_path and os.path.isfile(imagemagick_path):
    os.environ["IMAGEMAGICK_BINARY"] = imagemagick_path

ffmpeg_path = app.get("ffmpeg_path", "")
if ffmpeg_path and os.path.isfile(ffmpeg_path):
    os.environ["IMAGEIO_FFMPEG_EXE"] = ffmpeg_path

logger.info(f"{project_name} v{project_version}")
