import json
import math
import os
import re
import shutil
import sys
from functools import lru_cache
from pathlib import Path
import threading
from typing import Any, Iterable
from uuid import uuid4

from loguru import logger

from app.models import const
from hivemind_content_studio.config import app_dirs


def get_response(status: int, data: Any = None, message: str = ""):
    obj = {
        "status": status,
    }
    if data:
        obj["data"] = data
    if message:
        obj["message"] = message
    return obj


def to_json(obj):
    try:
        # Define a helper function to handle different types of objects
        def serialize(o):
            # If the object is a serializable type, return it directly
            if isinstance(o, (int, float, bool, str)) or o is None:
                return o
            # If the object is binary data, convert it to a base64-encoded string
            elif isinstance(o, bytes):
                return "*** binary data ***"
            # If the object is a dictionary, recursively process each key-value pair
            elif isinstance(o, dict):
                return {k: serialize(v) for k, v in o.items()}
            # If the object is a list or tuple, recursively process each element
            elif isinstance(o, (list, tuple)):
                return [serialize(item) for item in o]
            # If the object is a custom type, attempt to return its __dict__ attribute
            elif hasattr(o, "__dict__"):
                return serialize(o.__dict__)
            # Return None for other cases (or choose to raise an exception)
            else:
                return None

        # Use the serialize function to process the input object
        serialized_obj = serialize(obj)

        # Serialize the processed object into a JSON string
        return json.dumps(serialized_obj, ensure_ascii=False, indent=4)
    except Exception as e:
        logger.error(f"failed to serialize object to json: {str(e)}")
        return None


def get_uuid(remove_hyphen: bool = False):
    u = str(uuid4())
    if remove_hyphen:
        u = u.replace("-", "")
    return u


_CLIP_SPEED_MIN = 0.5
_CLIP_SPEED_MAX = 2.0


def normalize_clip_speed(value, default: float = 1.0) -> float:
    """将片段播放速度归一化到 WebUI 支持的安全范围。"""
    try:
        speed = float(value)
    except (TypeError, ValueError):
        return default

    # NaN 会绕过普通的大小比较，并在 MoviePy 计算 duration 时传播；无穷值也不
    # 是合法用户输入。两者统一回退默认值，保证 API 和内部直接调用都不会生成
    # 无效时间线。零值和负值同样无法表示正常播放速度。
    if not math.isfinite(speed) or speed <= 0:
        return default

    return min(max(speed, _CLIP_SPEED_MIN), _CLIP_SPEED_MAX)


def root_dir():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))


def storage_dir(sub_dir: str = "", create: bool = False):
    # Task output, not source: it goes to the resolved data dir so a read-only
    # install tree still works. resource_dir() below stays in the tree because
    # those files ship with the code and are only ever read.
    d = os.path.join(str(app_dirs().data_dir), "storage")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    if create and not os.path.exists(d):
        os.makedirs(d)

    return d


def resource_dir(sub_dir: str = ""):
    d = os.path.join(root_dir(), "resource")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    return d


def task_dir(sub_dir: str = ""):
    d = os.path.join(storage_dir(), "tasks")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    if not os.path.exists(d):
        os.makedirs(d)
    return d


def font_dir(sub_dir: str = ""):
    d = resource_dir("fonts")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    if not os.path.exists(d):
        os.makedirs(d)
    return d


# The subtitle font this project actually ships. BeVietnamPro is SIL OFL 1.1 and
# lives in resource/fonts; the faces that used to be the default —
# MicrosoftYaHei*.ttc and STHeiti*.ttc — are Windows and macOS system fonts under
# vendor licences that do not permit redistribution, so they were removed from the
# tree. See resource/FONTS.md.
DEFAULT_SUBTITLE_FONT = "BeVietnamPro-Bold.ttf"

# Where a font named by filename actually lives on each platform. A user who asks
# for "STHeitiMedium.ttc" is asking for their OWN copy of a system font, which is
# a request this can honour without shipping it.
_SYSTEM_FONT_DIRS: dict[str, tuple[str, ...]] = {
    "darwin": (
        "/System/Library/Fonts",
        "/System/Library/Fonts/Supplemental",
        "/Library/Fonts",
        "~/Library/Fonts",
    ),
    "win32": (
        "C:/Windows/Fonts",
        "~/AppData/Local/Microsoft/Windows/Fonts",
    ),
    "linux": (
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        "~/.local/share/fonts",
        "~/.fonts",
    ),
}

# The names the removed files carry once they are installed by the OS rather than
# copied into resource/fonts. Keyed lowercase so a saved task that still says
# "STHeitiMedium.ttc" keeps rendering in the same face on the machine that has it.
_SYSTEM_FONT_ALIASES: dict[str, tuple[str, ...]] = {
    "stheitimedium.ttc": ("STHeiti Medium.ttc",),
    "stheitilight.ttc": ("STHeiti Light.ttc",),
    "microsoftyaheibold.ttc": ("msyhbd.ttc", "msyh.ttc"),
    "microsoftyaheinormal.ttc": ("msyh.ttc",),
}

# Ordered per platform: the first face here that can draw the script in hand is
# what a run falls back to when the bundled Latin font cannot. Every entry is a
# font the OS installs itself, so nothing is downloaded and nothing is shipped.
_SCRIPT_FALLBACK_FONTS: dict[str, tuple[str, ...]] = {
    "darwin": ("PingFang.ttc", "STHeiti Medium.ttc", "Hiragino Sans GB.ttc", "Arial Unicode.ttf"),
    "win32": ("msyh.ttc", "msyhbd.ttc", "simhei.ttf", "arialuni.ttf"),
    "linux": (
        "NotoSansCJK-Regular.ttc",
        "NotoSansCJKsc-Regular.otf",
        "DroidSansFallbackFull.ttf",
        "wqy-zenhei.ttc",
    ),
}


def _platform_key() -> str:
    if sys.platform.startswith("win"):
        return "win32"
    if sys.platform == "darwin":
        return "darwin"
    return "linux"


def system_font_dirs() -> tuple[str, ...]:
    """The directories this OS keeps installed fonts in, expanded and existing."""
    return tuple(
        path
        for path in (
            os.path.expanduser(candidate)
            for candidate in _SYSTEM_FONT_DIRS.get(_platform_key(), ())
        )
        if os.path.isdir(path)
    )


def find_system_font(font_name: str) -> str:
    """Locate an installed font by file name. Returns "" when the machine has none.

    Linux keeps fonts in per-family subdirectories, so the search descends one
    level; macOS and Windows keep them flat and the walk costs nothing there.
    """
    name = os.path.basename(str(font_name or "").strip())
    if not name:
        return ""
    wanted = [name, *_SYSTEM_FONT_ALIASES.get(name.lower(), ())]
    lowered = {candidate.lower(): candidate for candidate in wanted}
    for directory in system_font_dirs():
        for root, _dirs, files in os.walk(directory):
            for file_name in files:
                if file_name.lower() in lowered:
                    return os.path.join(root, file_name)
            # One level down is enough for the fontconfig layout; deeper walks
            # turn a font lookup into a filesystem scan.
            if os.path.dirname(root) != os.path.dirname(directory):
                _dirs[:] = []
    return ""


def script_fallback_fonts() -> list[str]:
    """Installed fonts, in preference order, that can carry a non-Latin script."""
    found = []
    for candidate in _SCRIPT_FALLBACK_FONTS.get(_platform_key(), ()):
        path = find_system_font(candidate)
        if path:
            found.append(path)
    return found


def resolve_font_path(font_name: str = "") -> str:
    """Turn a subtitle font NAME into a path that exists on this machine.

    Order: the OFL fonts this project ships, then the same name installed as a
    system font (which is how a task that names STHeiti or YaHei keeps working
    without those files being redistributed), then the bundled default. Only the
    base name is used, so a task cannot point the renderer at an arbitrary file.
    """
    name = os.path.basename(str(font_name or "").strip()) or DEFAULT_SUBTITLE_FONT
    bundled = os.path.join(font_dir(), name)
    if os.path.isfile(bundled):
        return bundled
    installed = find_system_font(name)
    if installed:
        return installed
    fallback = os.path.join(font_dir(), DEFAULT_SUBTITLE_FONT)
    if name != DEFAULT_SUBTITLE_FONT:
        logger.warning(
            f"subtitle font not found: name={name}. Using the bundled "
            f"{DEFAULT_SUBTITLE_FONT}; install the font or pick one from "
            f"{font_dir()} to change it."
        )
    return fallback if os.path.isfile(fallback) else ""


def song_dir(sub_dir: str = ""):
    d = resource_dir("songs")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    if not os.path.exists(d):
        os.makedirs(d)
    return d


def public_dir(sub_dir: str = ""):
    d = resource_dir("public")
    if sub_dir:
        d = os.path.join(d, sub_dir)
    if not os.path.exists(d):
        os.makedirs(d)
    return d


def get_ffmpeg_binary() -> str:
    """
    解析当前进程应该使用的 FFmpeg 可执行文件。

    增加原因：
    1. 视频编码、静音音频生成、pydub 音频转码都依赖 FFmpeg；
    2. Windows 便携包、Docker 和用户自定义安装目录经常出现 PATH 不一致；
    3. 集中解析可以让所有调用方使用同一套优先级，减少某条链路能跑、
       另一条链路找不到 FFmpeg 的现场问题。

    优先级：
    1. IMAGEIO_FFMPEG_EXE：MoviePy/imageio 约定的显式配置；
    2. 系统 PATH 中的 ffmpeg；
    3. imageio-ffmpeg 依赖提供的内置二进制；
    4. 字符串 "ffmpeg" 兜底，交给 subprocess 在运行时暴露更具体错误。
    """
    configured_ffmpeg = os.environ.get("IMAGEIO_FFMPEG_EXE")
    if configured_ffmpeg:
        return configured_ffmpeg

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg

    try:
        import imageio_ffmpeg

        bundled_ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        if bundled_ffmpeg:
            return bundled_ffmpeg
    except Exception as exc:
        logger.warning(f"failed to resolve bundled ffmpeg binary: {str(exc)}")

    return "ffmpeg"


def run_in_background(func, *args, **kwargs):
    def run():
        try:
            func(*args, **kwargs)
        except Exception as e:
            logger.error(f"run_in_background error: {e}", exc_info=True)

    thread = threading.Thread(target=run, daemon=False)
    thread.start()
    return thread


def time_convert_seconds_to_hmsm(seconds) -> str:
    hours = int(seconds // 3600)
    seconds = seconds % 3600
    minutes = int(seconds // 60)
    milliseconds = int(seconds * 1000) % 1000
    seconds = int(seconds % 60)
    return "{:02d}:{:02d}:{:02d},{:03d}".format(hours, minutes, seconds, milliseconds)


def text_to_srt(idx: int, msg: str, start_time: float, end_time: float) -> str:
    start_time = time_convert_seconds_to_hmsm(start_time)
    end_time = time_convert_seconds_to_hmsm(end_time)
    srt = """%d
%s --> %s
%s
        """ % (
        idx,
        start_time,
        end_time,
        msg,
    )
    return srt


def str_contains_punctuation(word):
    for p in const.PUNCTUATIONS:
        if p in word:
            return True
    return False


def split_string_by_punctuations(s):
    result = []
    txt = ""

    previous_char = ""
    next_char = ""
    for i in range(len(s)):
        char = s[i]
        if char == "\n":
            result.append(txt.strip())
            txt = ""
            continue

        if i > 0:
            previous_char = s[i - 1]
        if i < len(s) - 1:
            next_char = s[i + 1]

        if char == "." and previous_char.isdigit() and next_char.isdigit():
            # # In the case of "withdraw 10,000, charged at 2.5% fee", the dot in "2.5" should not be treated as a line break marker
            txt += char
            continue

        if char == "," and previous_char.isdigit() and next_char.isdigit():
            # 英文数字里的千分位逗号不是断句符，例如 "1,000 years"。
            # Edge TTS 的 word boundary 通常会把这种数字整体作为连续内容返回；
            # 如果这里拆成 "1" 和 "000 years"，后续字幕聚合会无法匹配脚本原文，
            # 进而错误回退到 Whisper。
            txt += char
            continue

        if char not in const.PUNCTUATIONS:
            txt += char
        else:
            result.append(txt.strip())
            txt = ""
    result.append(txt.strip())
    # filter empty string
    result = list(filter(None, result))
    return result


def normalize_script_for_subtitle_matching(video_script: str) -> str:
    """
    清理字幕匹配前的脚本文本。

    用户可能手动输入 Markdown 分隔符、标题强调或 `_` 这类格式符号。
    这些字符通常不会出现在 TTS/Whisper 的识别结果里；如果继续参与
    字幕逐行匹配，脚本行数量会大于真实字幕行数量，最终可能补出
    `00:00:00,000 --> 00:00:00,000`，导致剪辑软件无法导入 SRT。
    """
    video_script = video_script or ""
    underscore_count = video_script.count("_")
    video_script = video_script.replace("_", "")
    cleaned_lines = []
    removed_separator_lines = 0
    for line in video_script.splitlines():
        line = line.strip()
        # Markdown 分隔符或强调符号单独成行时不会被 TTS 朗读，必须从
        # 脚本行里移除，避免字幕聚合卡在这类“不可发声”的目标行上。
        if re.fullmatch(r"[-*_]{3,}", line):
            removed_separator_lines += 1
            continue
        cleaned_lines.append(line)

    normalized_script = "\n".join(cleaned_lines).strip()
    if underscore_count or removed_separator_lines:
        logger.debug(
            "normalized script for subtitle matching, "
            f"removed underscores: {underscore_count}, "
            f"removed markdown separator lines: {removed_separator_lines}"
        )
    return normalized_script


def md5(text):
    import hashlib

    return hashlib.md5(text.encode("utf-8")).hexdigest()


def resolve_ui_language(
    saved_language: str | None,
    browser_locale: str | None,
    supported_languages: Iterable[str],
    default_language: str = "en",
) -> str:
    """
    按“已保存设置、浏览器语言、默认语言”的优先级选择界面语言。

    浏览器通常返回带地区的 locale，例如 ``zh-CN``、``pt-BR``。语言文件使用
    ``zh``、``pt`` 这类基础代码，因此先尝试完整匹配，再回退到连字符前的语言
    代码。函数保持纯逻辑，避免把浏览器上下文和配置写入耦合到工具层，便于测试。
    """
    supported = [str(language).strip() for language in supported_languages]
    supported_by_lower = {
        language.lower(): language for language in supported if language
    }

    def match_language(value: str | None) -> str | None:
        normalized = str(value or "").strip().replace("_", "-").lower()
        if not normalized:
            return None
        if normalized in supported_by_lower:
            return supported_by_lower[normalized]
        base_language = normalized.split("-", 1)[0]
        return supported_by_lower.get(base_language)

    saved_match = match_language(saved_language)
    if saved_match:
        return saved_match

    browser_match = match_language(browser_locale)
    if browser_match:
        return browser_match

    default_match = match_language(default_language)
    if default_match:
        return default_match

    # 正常项目始终包含英文；保留空语言集合兜底，避免损坏的语言目录让页面
    # 初始化直接抛异常，后续翻译函数会继续显示原始 key 以便诊断。
    return supported[0] if supported else default_language


@lru_cache(maxsize=8)
def load_locales(i18n_dir):
    # WebUI 每次交互都会触发 Streamlit 重新执行脚本，语言文件运行期不会变化，
    # 因此缓存解析结果，避免反复读取和解析所有 i18n JSON 文件。
    _locales = {}
    for root, dirs, files in os.walk(i18n_dir):
        for file in files:
            if file.endswith(".json"):
                lang = file.split(".")[0]
                with open(os.path.join(root, file), "r", encoding="utf-8") as f:
                    _locales[lang] = json.loads(f.read())
    return _locales


def parse_extension(filename):
    return Path(filename).suffix.lower().lstrip('.')
