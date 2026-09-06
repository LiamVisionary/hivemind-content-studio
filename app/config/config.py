import copy
import errno
import os
import shutil
import socket
import tempfile
import threading
import tomllib
from contextlib import contextmanager

import tomli_w
from loguru import logger

from app import __version__
from hivemind_content_studio.config import app_dirs
from hivemind_content_studio.shared_env import load_shared_hive_env

root_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
# config.toml is WRITTEN (save_config below), so it belongs in the resolved
# config dir rather than the install tree — a signed bundle is read-only. In a
# git checkout app_dirs() still resolves to <repo>/data, so a developer machine
# keeps a single file and nothing moves.
_config_dir = app_dirs().config_dir
config_file = str(_config_dir / "config.toml")
_CONTAINER_CGROUP_MARKERS = ("docker", "containerd", "kubepods", "libpod", "podman")
_DOCKER_HOST_GATEWAY_NAME = "host.docker.internal"
_config_save_lock = threading.RLock()
_pending_config_lock = threading.RLock()
_pending_config_updates = {}
_pending_config_save_requested = False
_pending_config_flush_scheduled = False
_MISSING = object()
_DELETE = object()


class _SynchronizedConfig(dict):
    """保持 dict 使用方式不变，同时让运行期配置写操作服从同一把锁。"""

    def __setitem__(self, key, value):
        # Streamlit 每次整页 rerun 都会把当前控件值重新写回配置。视频任务持有
        # runtime_config_lock 时，如果值没有变化，这次写入没有任何副作用，也
        # 不应让刷新后的页面卡在表单中途。真正改变配置的写入仍进入下方锁，
        # 因而不能在正在生成的视频中途切换 Provider、密钥或其它全局设置。
        current = super().get(key, _MISSING)
        if current is not _MISSING and current == value:
            return
        with _config_save_lock:
            super().__setitem__(key, value)

    def __delitem__(self, key):
        with _config_save_lock:
            super().__delitem__(key)

    def clear(self):
        if not self:
            return
        with _config_save_lock:
            super().clear()

    def pop(self, key, default=_MISSING):
        # ``pop(key, default)`` 在 key 不存在时同样不会改变配置。WebUI 使用
        # 这种写法表达“采用默认策略”，刷新时必须允许它直接完成。
        if key not in self:
            if default is _MISSING:
                raise KeyError(key)
            return default
        with _config_save_lock:
            if default is _MISSING:
                return super().pop(key)
            return super().pop(key, default)

    def setdefault(self, key, default=None):
        # 与 __setitem__ 相同，已存在 key 的 setdefault 是只读操作。提前返回
        # 可以让只读取默认配置的页面刷新不受长任务配置锁影响。
        current = super().get(key, _MISSING)
        if current is not _MISSING:
            return current
        with _config_save_lock:
            return super().setdefault(key, default)

    def update(self, *args, **kwargs):
        changes = dict(*args, **kwargs)
        if all(
            (current := dict.get(self, key, _MISSING)) is not _MISSING
            and current == value
            for key, value in changes.items()
        ):
            return
        with _config_save_lock:
            super().update(changes)


def _pending_update_key(config_section, key):
    """为进程内固定配置分区生成待更新键。"""
    return id(config_section), key


def update_config_nonblocking(config_section, key, value):
    """
    非阻塞更新 WebUI 的运行期配置。

    视频生成会持有 ``runtime_config_lock``，确保同一任务不会在执行中途切换
    Provider、密钥或语音配置。Streamlit 控件发生变化时不能等待这把长任务锁，
    否则浏览器会表现为页面冻结。锁空闲时立即更新；锁繁忙时只保留每个配置项
    的最新值，并在当前任务释放锁时统一应用。

    返回 True 表示值已经生效，False 表示已进入待更新队列。
    """
    # 所有更新都先进入同一队列，再尝试获取配置锁。这样多个页面同时修改同一
    # 配置项时，写入队列的先后顺序就是最终顺序，不会出现较早线程在获取锁后
    # 把较新线程已经排队的值误删掉。
    with _pending_config_lock:
        _pending_config_updates[_pending_update_key(config_section, key)] = (
            config_section,
            key,
            copy.deepcopy(value),
        )

    acquired = _config_save_lock.acquire(blocking=False)
    if not acquired:
        # 调用方通常会在本次 Streamlit rerun 末尾请求保存，但不能依赖这一步
        # 一定执行。例如页面中途异常或更新恰好发生在任务退出保存阶段时，仍需
        # 有后台刷新线程保证排队值最终生效。
        _schedule_deferred_config_flush()
        return False

    try:
        _apply_pending_config_updates_locked()
        return config_section.get(key, _MISSING) == value
    finally:
        _config_save_lock.release()


def delete_config_nonblocking(config_section, key):
    """
    非阻塞删除 WebUI 配置项。

    “使用默认值”需要真正移除配置项，而不是写入空字符串。视频任务占用配置
    锁时，删除意图会覆盖同一配置项之前排队的更新，并在任务结束后执行。
    """
    with _pending_config_lock:
        _pending_config_updates[_pending_update_key(config_section, key)] = (
            config_section,
            key,
            _DELETE,
        )

    acquired = _config_save_lock.acquire(blocking=False)
    if not acquired:
        _schedule_deferred_config_flush()
        return False

    try:
        _apply_pending_config_updates_locked()
        return key not in config_section
    finally:
        _config_save_lock.release()


def _apply_pending_config_updates_locked():
    """在持有配置写锁时应用 WebUI 暂存的最新配置值。"""
    with _pending_config_lock:
        updates = list(_pending_config_updates.values())
        _pending_config_updates.clear()
        # 应用配置时继续持有待更新锁。读取“当前值 + 待更新值”快照的线程由此
        # 只能看到应用前或应用后的完整状态，不会读到只更新了一半的配置集合。
        for config_section, key, value in updates:
            if value is _DELETE:
                config_section.pop(key, None)
            else:
                config_section[key] = value
    return bool(updates)


def snapshot_config_with_pending(config_section):
    """
    返回配置分区的有效快照，并合并尚未应用的 WebUI 更新。

    视频任务持锁期间不能改写全局配置，但用户仍可准备下一条内容。LLM 请求
    使用这个快照后，界面中刚选择的 Provider、模型和密钥会参与新请求，同时
    不会改变正在执行的视频任务。
    """
    with _pending_config_lock:
        snapshot = dict(config_section)
        section_id = id(config_section)
        for (pending_section_id, key), (_, _, value) in _pending_config_updates.items():
            if pending_section_id != section_id:
                continue
            if value is _DELETE:
                snapshot.pop(key, None)
            else:
                snapshot[key] = copy.deepcopy(value)
    return snapshot


def _flush_pending_config_locked(*, suppress_save_errors):
    """在持有配置写锁时应用并保存当前所有待处理配置。"""
    global _pending_config_save_requested

    updates_applied = _apply_pending_config_updates_locked()
    with _pending_config_lock:
        save_requested = _pending_config_save_requested
        _pending_config_save_requested = False

    if not updates_applied and not save_requested:
        return True

    try:
        save_config()
        return True
    except Exception as exc:
        # 内存中的配置已经成功应用，保存失败时只保留待保存标记。视频任务不应
        # 因配置文件暂时不可写而被改判失败；下一次页面交互会再次触发保存。
        with _pending_config_lock:
            _pending_config_save_requested = True
        if not suppress_save_errors:
            raise
        logger.exception(f"failed to save deferred runtime config: {exc}")
        return False


def _run_deferred_config_flush():
    """等待长任务释放配置锁，并可靠清空期间积累的配置更新。"""
    global _pending_config_flush_scheduled

    while True:
        with _config_save_lock:
            flush_succeeded = _flush_pending_config_locked(
                suppress_save_errors=True
            )

        with _pending_config_lock:
            has_pending_work = bool(
                _pending_config_updates or _pending_config_save_requested
            )
            if not flush_succeeded or not has_pending_work:
                _pending_config_flush_scheduled = False
                return


def _schedule_deferred_config_flush():
    """保证同一时间最多只有一个后台线程等待刷新配置。"""
    global _pending_config_flush_scheduled

    with _pending_config_lock:
        if _pending_config_flush_scheduled:
            return
        _pending_config_flush_scheduled = True

    threading.Thread(
        target=_run_deferred_config_flush,
        name="mpt-config-flush",
        daemon=True,
    ).start()


def try_save_config():
    """
    非阻塞保存 WebUI 配置，锁繁忙时交由当前长任务结束后保存。

    普通 API、CLI 和维护脚本仍可调用 ``save_config`` 获得原来的阻塞写入语义；
    只有 Streamlit rerun 使用本函数，避免页面为等待视频任务而长时间无响应。
    """
    global _pending_config_save_requested

    with _pending_config_lock:
        _pending_config_save_requested = True

    acquired = _config_save_lock.acquire(blocking=False)
    if not acquired:
        _schedule_deferred_config_flush()
        return False

    try:
        return _flush_pending_config_locked(suppress_save_errors=False)
    finally:
        _config_save_lock.release()


@contextmanager
def runtime_config_lock():
    """
    在一次依赖全局配置的完整操作期间阻止其它 WebUI 会话改写配置。

    当前项目默认绑定本地回环地址，配置仍然是单用户全局配置。这个轻量锁主要
    保护生成、试听等长操作，避免另一个标签页在操作中途切换 Provider 或密钥。
    """
    with _config_save_lock:
        # 如果上一个短操作释放锁时后台刷新线程尚未获得调度，新任务必须在读取
        # Provider、密钥等全局配置前先应用队列，不能继续使用旧配置执行整条流水线。
        _flush_pending_config_locked(suppress_save_errors=True)
        try:
            yield
        finally:
            _flush_pending_config_locked(suppress_save_errors=True)


@contextmanager
def try_runtime_config_lock():
    """
    尝试获取运行期配置锁，并立即返回是否成功。

    WebUI 试听属于用户主动触发的短操作，不应在后台视频任务持锁时等待数分钟。
    调用方可以在未获取锁时就近提示用户稍后重试；成功获取后仍能保证试听期间
    Provider、密钥和模型配置不会被其它会话修改。
    """
    acquired = _config_save_lock.acquire(blocking=False)
    try:
        if acquired:
            _flush_pending_config_locked(suppress_save_errors=True)
        yield acquired
    finally:
        if acquired:
            _flush_pending_config_locked(suppress_save_errors=True)
            _config_save_lock.release()


def is_running_in_container(
    dockerenv_path: str = "/.dockerenv",
    containerenv_path: str = "/run/.containerenv",
    cgroup_path: str = "/proc/1/cgroup",
) -> bool:
    """
    判断当前进程是否运行在容器内。

    这个判断主要用于 Ollama 默认地址选择：
    - 普通本机运行时，`localhost` 指向用户机器本身；
    - Docker 容器内，`localhost` 指向容器自己，访问宿主机 Ollama
      通常需要使用 `host.docker.internal`。

    不能只判断 `/proc/1/cgroup` 是否存在，因为普通 Linux 也会有这个文件。
    这里只在检测到明确的容器标记时返回 True，避免误伤非 Docker Linux 用户。
    参数保留为可注入路径，便于单元测试覆盖不同运行环境。
    """
    if os.path.isfile(dockerenv_path) or os.path.isfile(containerenv_path):
        return True

    try:
        with open(cgroup_path, mode="r", encoding="utf-8") as fp:
            cgroup_content = fp.read().lower()
    except OSError:
        return False

    return any(marker in cgroup_content for marker in _CONTAINER_CGROUP_MARKERS)


def _can_resolve_hostname(hostname: str) -> bool:
    try:
        socket.gethostbyname(hostname)
    except OSError:
        return False
    return True


def _decode_linux_route_gateway(hex_gateway: str) -> str:
    # /proc/net/route 里的 Gateway 是 16 进制小端序，例如 010011AC 表示
    # 172.17.0.1。这里单独解析，是为了在原生 Linux Docker 没有
    # host.docker.internal DNS 记录时，还能尝试访问容器默认网关上的宿主机。
    if len(hex_gateway) != 8:
        raise ValueError("invalid gateway length")

    octets = [
        str(int(hex_gateway[index : index + 2], 16)) for index in range(6, -1, -2)
    ]
    return ".".join(octets)


def get_container_default_gateway_ip(route_path: str = "/proc/net/route") -> str:
    """
    读取 Linux 容器里的默认网关 IP。

    Docker Desktop 通常提供 `host.docker.internal`，但原生 Linux Docker
    默认不一定提供这个 DNS 名称。默认网关通常可以作为访问宿主机服务的
    兜底地址；如果用户的 Ollama 只监听 127.0.0.1，则仍需要用户让
    Ollama 监听宿主机网卡或手动配置 `ollama_base_url`。
    """
    try:
        with open(route_path, mode="r", encoding="utf-8") as fp:
            route_lines = fp.readlines()
    except OSError:
        return ""

    for line in route_lines[1:]:
        fields = line.strip().split()
        if len(fields) < 3:
            continue

        destination = fields[1]
        gateway = fields[2]
        if destination != "00000000" or gateway == "00000000":
            continue

        try:
            return _decode_linux_route_gateway(gateway)
        except ValueError:
            logger.warning(f"invalid container gateway route entry: {line.strip()}")
            return ""

    return ""


# 本地推理服务的默认 OpenAI-compatible 端口。两者都只监听本机，因此容器内
# 需要改指向宿主机，解析规则完全一致，只有端口和日志中的服务名不同。
OLLAMA_DEFAULT_PORT = 11434
LMSTUDIO_DEFAULT_PORT = 1234


def get_default_local_service_base_url(port: int, service_name: str) -> str:
    """
    返回本机推理服务的默认 OpenAI-compatible base_url。

    用户显式配置对应的 `*_base_url` 时不会走这里；这里只处理“未配置时的
    最佳默认值”。容器内默认指向宿主机，普通本机运行默认指向 localhost。
    `service_name` 只用于日志，便于区分是哪个服务在回退。
    """
    if not is_running_in_container():
        return f"http://localhost:{port}/v1"

    if _can_resolve_hostname(_DOCKER_HOST_GATEWAY_NAME):
        return f"http://{_DOCKER_HOST_GATEWAY_NAME}:{port}/v1"

    gateway_ip = get_container_default_gateway_ip()
    if gateway_ip:
        logger.info(
            "host.docker.internal is not resolvable, fallback to container "
            f"default gateway for {service_name}: {gateway_ip}"
        )
        return f"http://{gateway_ip}:{port}/v1"

    logger.warning(
        "failed to resolve host.docker.internal and container default gateway; "
        f"fallback to host.docker.internal for {service_name}"
    )
    return f"http://{_DOCKER_HOST_GATEWAY_NAME}:{port}/v1"


def get_default_ollama_base_url() -> str:
    """返回 Ollama 的默认 OpenAI-compatible base_url。"""
    return get_default_local_service_base_url(OLLAMA_DEFAULT_PORT, "Ollama")


def get_default_lmstudio_base_url() -> str:
    """
    返回 LM Studio 的默认 OpenAI-compatible base_url。

    LM Studio 的本地服务器默认监听 1234 端口并暴露 `/v1`，与 Ollama 一样
    只监听本机，因此容器内的解析规则完全复用同一个实现。
    """
    return get_default_local_service_base_url(LMSTUDIO_DEFAULT_PORT, "LM Studio")

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
    # Providers added upstream after the 1.2.x line.
    "coverr_api_keys": [],
    "twelvelabs_api_keys": [],
    "sonilo_api_key": "",
    "volcengine_api_key": "",
    "grok_api_key": "",
    "groq_api_key": "",
    "mimo_api_key": "",
    "aihubmix_api_key": "",
    "aimlapi_api_key": "",
    "evolink_api_key": "",
    "pollinations_api_key": "",
}
_AZURE_SECRET_DEFAULTS = {"speech_key": "", "speech_region": ""}
_SILICONFLOW_SECRET_DEFAULTS = {"api_key": ""}
_MINIMAX_TTS_SECRET_DEFAULTS = {"api_key": ""}
_ELEVENLABS_SECRET_DEFAULTS = {"api_key": ""}
_CHATTERBOX_SECRET_DEFAULTS = {"api_key": ""}


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
        # Providers added upstream after the 1.2.x line.
        "sonilo_api_key": ("SONILO_API_KEY",),
        "volcengine_api_key": ("VOLCENGINE_API_KEY", "ARK_API_KEY"),
        "grok_api_key": ("XAI_API_KEY", "GROK_API_KEY"),
        "groq_api_key": ("GROQ_API_KEY",),
        "mimo_api_key": ("MIMO_API_KEY", "XIAOMI_MIMO_API_KEY"),
        "aihubmix_api_key": ("AIHUBMIX_API_KEY",),
        "aimlapi_api_key": ("AIMLAPI_API_KEY",),
        "evolink_api_key": ("EVOLINK_API_KEY",),
        "pollinations_api_key": ("POLLINATIONS_API_KEY",),
        "ollama_base_url": ("OLLAMA_BASE_URL",),
    }
    for config_key, env_names in app_string_map.items():
        value = _env_value(env, *env_names)
        if value:
            app_config[config_key] = value

    for config_key, env_names in {
        "pexels_api_keys": ("PEXELS_API_KEYS", "PEXELS_API_KEY"),
        "pixabay_api_keys": ("PIXABAY_API_KEYS", "PIXABAY_API_KEY"),
        "coverr_api_keys": ("COVERR_API_KEYS", "COVERR_API_KEY"),
        "twelvelabs_api_keys": ("TWELVELABS_API_KEYS", "TWELVELABS_API_KEY"),
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

    # Upstream 1.3.x moved MiniMax TTS, ElevenLabs, and Chatterbox into their own
    # sections. They each carry a credential, so they read from the hive env too.
    minimax_tts_config = dict(_config.get("minimax_tts", {}))
    minimax_tts_key = _env_value(env, "MINIMAX_TTS_API_KEY", "MINIMAX_API_KEY")
    if minimax_tts_key:
        minimax_tts_config["api_key"] = minimax_tts_key

    elevenlabs_config = dict(_config.get("elevenlabs", {}))
    elevenlabs_key = _env_value(env, "ELEVENLABS_API_KEY", "ELEVEN_API_KEY")
    if elevenlabs_key:
        elevenlabs_config["api_key"] = elevenlabs_key

    chatterbox_config = dict(_config.get("chatterbox", {}))
    for config_key, env_names in {
        "base_url": ("CHATTERBOX_BASE_URL",),
        "api_key": ("CHATTERBOX_API_KEY",),
    }.items():
        value = _env_value(env, *env_names)
        if value:
            chatterbox_config[config_key] = value

    _config["app"] = app_config
    _config["azure"] = azure_config
    _config["siliconflow"] = siliconflow_config
    _config["minimax_tts"] = minimax_tts_config
    _config["elevenlabs"] = elevenlabs_config
    _config["chatterbox"] = chatterbox_config
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
        os.makedirs(os.path.dirname(config_file), exist_ok=True)
        legacy_file = f"{root_dir}/config.toml"
        example_file = f"{root_dir}/config.example.toml"
        if os.path.isfile(legacy_file):
            # One-time adoption of the pre-app_dirs location, so an existing
            # checkout does not silently start from the example again.
            shutil.move(legacy_file, config_file)
            logger.info("moved config.toml into the studio config dir")
        elif os.path.isfile(example_file):
            shutil.copyfile(example_file, config_file)
            logger.info("copy config.example.toml to config.toml")

    logger.info(f"load config from file: {config_file}")

    try:
        with open(config_file, mode="rb") as fp:
            _config_ = tomllib.load(fp)
    except Exception as e:
        # A BOM is not TOML, and a file saved by an editor that writes one used
        # to fail here too. Read it as text with the signature stripped.
        logger.warning(f"load config failed: {str(e)}, try to load as utf-8-sig")
        with open(config_file, mode="r", encoding="utf-8-sig") as fp:
            _cfg_content = fp.read()
            _config_ = tomllib.loads(_cfg_content)
    return _apply_hive_env(_config_)


def _without_none(value):
    """Drop None at any depth before serialising.

    TOML has no null. The writer this replaced (`toml`) skipped a None key
    silently, so a runtime value cleared with None never reached the file;
    tomli_w raises on one instead. Keep the file the shape it always had.
    """
    if isinstance(value, dict):
        return {
            key: _without_none(item)
            for key, item in value.items()
            if item is not None
        }
    if isinstance(value, (list, tuple)):
        return [_without_none(item) for item in value if item is not None]
    return value


def save_config():
    """
    原子保存运行时配置。

    Streamlit 的不同会话可能在相近时间触发配置保存。直接覆盖 config.toml 时，
    另一个线程可能读取到只写了一部分的 TOML 内容。这里使用进程内可重入锁串行化
    保存，并先写入同目录临时文件，再通过 os.replace 原子替换目标文件。

    Docker Desktop 单文件 bind mount 会把 config.toml 本身作为挂载点，
    Linux 内核不允许通过 rename/replace 替换挂载点，因此会返回 EBUSY。
    该场景下只能在锁内原地覆盖文件；其它异常仍然抛出，避免掩盖权限、磁盘
    或路径错误。

    这仍然保留项目现有的单用户全局配置语义，不额外引入复杂的多用户配置系统；
    主要用于避免多标签页或快速 rerun 时损坏配置文件。
    """
    with _config_save_lock:
        config_to_save = dict(_cfg)
        config_to_save["app"] = dict(app)
        config_to_save["azure"] = dict(azure)
        config_to_save["siliconflow"] = dict(siliconflow)
        config_to_save["minimax_tts"] = dict(minimax_tts)
        config_to_save["elevenlabs"] = dict(elevenlabs)
        config_to_save["chatterbox"] = dict(chatterbox)
        config_to_save["ui"] = dict(ui)

        # Credentials injected from the shared hive env are runtime-only. They stay
        # live in memory but must never be written back into config.toml, or a
        # fleet-wide key would be persisted into the repository working tree.
        persisted_config = dict(config_to_save)
        for section, defaults in (
            ("app", _APP_SECRET_DEFAULTS),
            ("azure", _AZURE_SECRET_DEFAULTS),
            ("siliconflow", _SILICONFLOW_SECRET_DEFAULTS),
            ("minimax_tts", _MINIMAX_TTS_SECRET_DEFAULTS),
            ("elevenlabs", _ELEVENLABS_SECRET_DEFAULTS),
            ("chatterbox", _CHATTERBOX_SECRET_DEFAULTS),
        ):
            persisted_config[section] = _without_runtime_secrets(
                persisted_config.get(section, {}), defaults
            )
        serialized_config = tomli_w.dumps(_without_none(persisted_config))

        # WebUI 完整 rerun 结束时会调用保存。内容没有变化时直接返回，避免每次
        # 点击普通控件都产生一次磁盘写入和 fsync。
        try:
            with open(config_file, mode="r", encoding="utf-8") as f:
                if f.read() == serialized_config:
                    _cfg.clear()
                    _cfg.update(config_to_save)
                    return
        except (OSError, UnicodeError):
            pass

        temp_path = ""
        try:
            fd, temp_path = tempfile.mkstemp(
                prefix=".config-",
                suffix=".toml.tmp",
                dir=root_dir,
            )
            with os.fdopen(fd, mode="w", encoding="utf-8") as f:
                f.write(serialized_config)
                f.flush()
                os.fsync(f.fileno())
            try:
                os.replace(temp_path, config_file)
            except OSError as exc:
                if exc.errno != errno.EBUSY:
                    raise

                logger.warning(
                    "atomic config replacement is unavailable for the mounted "
                    f"file, fallback to in-place write: {config_file}"
                )
                with open(config_file, mode="w", encoding="utf-8") as f:
                    f.write(serialized_config)
                    f.flush()
                    os.fsync(f.fileno())
            _cfg.clear()
            _cfg.update(config_to_save)
        finally:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)


_cfg = load_config()
app = _SynchronizedConfig(_cfg.get("app", {}))
whisper = _cfg.get("whisper", {})
proxy = _cfg.get("proxy", {})
azure = _SynchronizedConfig(_cfg.get("azure", {}))
siliconflow = _SynchronizedConfig(_cfg.get("siliconflow", {}))
minimax_tts = _SynchronizedConfig(_cfg.get("minimax_tts", {}))
elevenlabs = _SynchronizedConfig(_cfg.get("elevenlabs", {}))
chatterbox = _SynchronizedConfig(_cfg.get("chatterbox", {}))
ui = _SynchronizedConfig(
    _cfg.get(
        "ui",
        {
            "hide_log": False,
        },
    )
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
project_version = _cfg.get("project_version", __version__)
reload_debug = False

app["redis_host"] = os.getenv(
    "MPT_APP_REDIS_HOST",
    os.getenv("REDIS_HOST", app.get("redis_host", "localhost")),
)

ffmpeg_path = app.get("ffmpeg_path", "")
if ffmpeg_path and os.path.isfile(ffmpeg_path):
    os.environ["IMAGEIO_FFMPEG_EXE"] = ffmpeg_path

logger.info(f"{project_name} v{project_version}")


def refresh_hive_env() -> list[str]:
    """Re-read the machine's shared credential store into the live config.

    The load above runs ONCE, at import. A key is normally saved while the
    studio is already running — from its own Settings page, into the one shared
    store this machine has — so without this the faceless engine keeps whatever
    the empty ``config.toml`` fields held at boot and ``get_api_key`` refuses
    with "pexels_api_keys is not set ... set it in the config.toml file", which
    sends the owner to fill in a SECOND credential store for a key the first one
    is already holding. Called at the start of a faceless render.

    Returns the names of the sections that actually changed. Never a value.
    """
    sections = {
        "app": app,
        "azure": azure,
        "siliconflow": siliconflow,
        "minimax_tts": minimax_tts,
        "elevenlabs": elevenlabs,
        "chatterbox": chatterbox,
    }
    refreshed = _apply_hive_env({name: dict(section) for name, section in sections.items()})
    changed = []
    for name, section in sections.items():
        values = refreshed.get(name) or {}
        updates = {
            key: value
            for key, value in values.items()
            if dict.get(section, key, _MISSING) != value
        }
        if updates:
            section.update(updates)
            changed.append(name)
    return changed
