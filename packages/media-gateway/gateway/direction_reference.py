"""The two direction-control reference images Eric Venti's Flux.2 Klein 9B
LoRAs read: a red dot for where the eyes look, a lit sphere for where the sun is.

Both LoRAs are image-to-image: the edit prompt is a fixed trigger sentence, and
the ACTUAL instruction is a second reference image conditioned alongside the
source. Eyes look at a red dot; light arrives from wherever a reference sphere
is lit. So the control the studio hands the user is a picker, and this module is
what turns that pick back into the pixels the LoRA was trained to read.

WHY THIS IS RENDERED HERE RATHER THAN BY THE AUTHOR'S NODES. The author ships a
ComfyUI node for each. `EyesDirectionControl` is plain numpy and would work
headless, but `SphereLightNode` renders in the ComfyUI *browser tab* with
Three.js and posts the result back through a hidden `render_b64` widget — its
Python half only base64-decodes that string, and falls back to flat gray when it
is empty. The studio drives ComfyUI over the HTTP API with no browser attached,
so that node would hand every run a featureless gray square. Rendering both here
also means the feature depends on no custom node packs at all.

Stdlib only, like the rest of the gateway (app.py runs under the system
python3 — there is no numpy and no PIL here; see klein_character_sheet.py).

FIDELITY. The dot is a line-for-line port of the author's numpy node, so it is
exact. The sphere is a port of the author's Three.js scene (three r128,
`js/preview.js`, unchanged since the original `js/sphere_widget.js`): a 1-unit
sphere on a ground plane, one directional light, 0.2 ambient, 35 degree camera
at (0, 6, 8) looking at (0, -0.5, 0). Confirmed, not assumed: the author's own
workflow JSON carries a baked 512x512 Three.js render at rotation -66.986,
elevation 40.593, intensity 3, and this renderer reproduces it with a mean
absolute error of 0.18/255 — the residual is one-pixel antialiasing on the
silhouette and the shadow edge. Reproducing it needed two facts about that
scene that are easy to get wrong, both pinned by that comparison:

  * material colours are sRGB values decoded to linear (0xcccccc is 0.6038
    linear, not 0.8), and
  * lights are NOT pre-scaled by pi, so every lit term carries the 1/pi of the
    BRDF. Assume the legacy pi scaling and the pi factors cancel, which blows
    the image to solid white at the author's own intensity of 3.

The render is 512x512 upscaled to 1024x1024 exactly as the author's node does
(his Python resizes the browser's 512 canvas with LANCZOS); the 1024 size is
load-bearing, because that is the token count the LoRA saw in training.
"""
import math
import struct
import zlib

# --- the eyes dot: eric-venti-seeds/Eyes_Direction_Lora_Control, nodes.py ------

EYES_TRIGGER = "change the eyes to match the reference dot direction"
EYES_LORA_FILE = "Eyes_direction_Lora_Flux2Klein_9B_v1.safetensors"

_CANVAS = 1024
_FRAME = 580
_FRAME_MARGIN = (_CANVAS - _FRAME) // 2
_DOT_RADIUS = 85
_BORDER = 6

# --- the sun sphere: eric-venti-seeds/Sphere-Light-Render-ComfyUI, js/preview.js

SUN_TRIGGER = "match the sun direction from the reference"
SUN_LORA_FILE = "Sun_direction_LoRA_Flux_2_Klein_9b_v1.safetensors"
# The author's workflow does this in the pass above the relight, on the base
# model with no LoRA: the sun only lands cleanly on an image that has no light
# direction of its own yet.
SUN_OVERCAST_PROMPT = "make it an overcast day, remove the shadows"

SUN_ROTATION_RANGE = (-180.0, 180.0)
SUN_ELEVATION_RANGE = (5.0, 85.0)
SUN_INTENSITY_RANGE = (0.2, 3.0)

_RENDER = 512
_TARGET = 1024
_CLEAR = 138  # renderer.setClearColor(0x8a8a8a), written unencoded
_AMBIENT = 0.2
_RECIP_PI = 1.0 / math.pi
_SPHERE_A2 = (0.8 ** 2) ** 2  # roughness 0.8 -> alpha 0.64 -> alpha^2
_PLANE_A2 = 1.0               # roughness 1.0
_CAMERA = (0.0, 6.0, 8.0)
_TAN_HALF_FOV = math.tan(math.radians(35.0) / 2)
_FOCAL = math.sqrt(6.5 * 6.5 + 8.0 * 8.0)
# camera basis for lookAt(0, -0.5, 0) with up +Y: right is exactly +X, so the
# horizontal term needs no vector at all.
_FWD = (0.0, -6.5 / _FOCAL, -8.0 / _FOCAL)
_UP = (0.0, -_FWD[2], _FWD[1])
# The shadow map is 2048 texels over a 16-unit frustum with radius 2, i.e. a
# penumbra of a small fraction of a world unit. Measured off the author's render.
_SHADOW_SOFTNESS = 0.035


def _clamp(value, low, high):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return low
    if value != value:  # NaN
        return low
    return low if value < low else (high if value > high else value)


def _srgb_to_linear(channel):
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def _linear_to_srgb_byte(value):
    if value <= 0.0:
        return 0
    value = value * 12.92 if value <= 0.0031308 else 1.055 * (value ** (1 / 2.4)) - 0.055
    return 255 if value >= 1.0 else int(value * 255.0 + 0.5)


_SPHERE_ALBEDO = _srgb_to_linear(204 / 255)  # 0xcccccc
_PLANE_ALBEDO = _srgb_to_linear(138 / 255)   # 0x8a8a8a


def _png(width, height, rgb):
    """An 8-bit RGB PNG, filter 0 on every row."""
    stride = width * 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw += rgb[y * stride:(y + 1) * stride]

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xffffffff))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + chunk(b"IEND", b""))


def render_eyes_dot_png(x, y):
    """The red-dot canvas the Eyes Direction LoRA reads, at `x`/`y` in 0..1.

    A line-for-line port of the author's EyesDirectionControl node: a white
    1024 square, a 580-wide black frame standing for the source image's own
    border, and an 85px red dot wherever the pick landed. The frame is what
    makes "outside the picture" expressible — a dot beyond it is the gaze
    leaving frame, which is the whole reason the canvas is bigger than the
    frame it draws.
    """
    x = _clamp(x, 0.0, 1.0)
    y = _clamp(y, 0.0, 1.0)
    size = _CANVAS
    inner_start, inner_end = _FRAME_MARGIN, _FRAME_MARGIN + _FRAME
    centre_x, centre_y = x * size, y * size
    white, black, red = b"\xff\xff\xff", b"\x00\x00\x00", b"\xff\x00\x00"
    out = bytearray()
    for row in range(size):
        pixels = bytearray(white * size)
        if inner_start <= row < inner_end:
            if row < inner_start + _BORDER or row >= inner_end - _BORDER:
                pixels[inner_start * 3:inner_end * 3] = black * _FRAME
            else:
                pixels[inner_start * 3:(inner_start + _BORDER) * 3] = black * _BORDER
                pixels[(inner_end - _BORDER) * 3:inner_end * 3] = black * _BORDER
        # The dot is drawn last, over the frame, exactly as the node does it.
        half_sq = _DOT_RADIUS * _DOT_RADIUS - (row - centre_y) ** 2
        if half_sq > 0:
            half = math.sqrt(half_sq)
            left = max(0, int(math.ceil(centre_x - half)))
            right = min(size, int(math.floor(centre_x + half)) + 1)
            if right > left:
                pixels[left * 3:right * 3] = red * (right - left)
        out += pixels
    return _png(size, size, out)


def _specular(nx, ny, nz, vx, vy, vz, lx, ly, lz, n_dot_l, alpha_sq):
    """three.js BRDF_GGX: Schlick fresnel over a Smith-correlated GGX lobe.

    The 1/pi lives in D here rather than being cancelled against a pi-scaled
    light, because this scene's lights are not pi-scaled (see the module note).
    """
    hx, hy, hz = lx + vx, ly + vy, lz + vz
    length = math.sqrt(hx * hx + hy * hy + hz * hz) or 1.0
    hx, hy, hz = hx / length, hy / length, hz / length
    n_dot_h = max(0.0, nx * hx + ny * hy + nz * hz)
    n_dot_v = max(1e-4, nx * vx + ny * vy + nz * vz)
    v_dot_h = max(0.0, vx * hx + vy * hy + vz * hz)
    denominator = n_dot_h * n_dot_h * (alpha_sq - 1.0) + 1.0
    distribution = alpha_sq * _RECIP_PI / (denominator * denominator)
    visibility = 0.5 / (
        n_dot_l * math.sqrt(n_dot_v * n_dot_v * (1 - alpha_sq) + alpha_sq)
        + n_dot_v * math.sqrt(n_dot_l * n_dot_l * (1 - alpha_sq) + alpha_sq)
    )
    fresnel = 0.04 + 0.96 * ((1 - v_dot_h) ** 5)
    return fresnel * visibility * distribution


def _shade(px, py, inv, light, intensity):
    """One camera ray: the sphere if it is hit, otherwise the ground plane."""
    lx, ly, lz = light
    fx, fy, fz = _FWD
    _, uy, uz = _UP
    cx, cy, cz = _CAMERA
    screen_x = (px * 2.0 * inv) - 1.0
    screen_y = 1.0 - (py * 2.0 * inv)
    offset_x = screen_x * _TAN_HALF_FOV
    offset_y = screen_y * _TAN_HALF_FOV
    dx = fx + offset_x
    dy = fy + offset_y * uy
    dz = fz + offset_y * uz
    length = math.sqrt(dx * dx + dy * dy + dz * dz)
    dx, dy, dz = dx / length, dy / length, dz / length

    half_b = cx * dx + cy * dy + cz * dz
    c = cx * cx + cy * cy + cz * cz - 1.0
    discriminant = half_b * half_b - c
    if discriminant > 0:
        t = -half_b - math.sqrt(discriminant)
        if t > 0:
            # Unit sphere at the origin, so the hit point IS the normal.
            nx, ny, nz = cx + dx * t, cy + dy * t, cz + dz * t
            n_dot_l = nx * lx + ny * ly + nz * lz
            value = _SPHERE_ALBEDO * _RECIP_PI * (_AMBIENT + intensity * max(0.0, n_dot_l))
            if n_dot_l > 0:
                value += intensity * n_dot_l * _specular(
                    nx, ny, nz, -dx, -dy, -dz, lx, ly, lz, n_dot_l, _SPHERE_A2)
            return value

    if dy >= -1e-9:
        return None
    t = (-1.0 - cy) / dy
    if t <= 0:
        return None
    hit_x, hit_z = cx + dx * t, cz + dz * t
    if abs(hit_x) > 50 or abs(hit_z) > 50:  # PlaneGeometry(100, 100)
        return None
    # Cast shadow, analytically: the point is occluded when the ray toward the
    # light passes within the unit sphere. Smoothstep over the last fraction of
    # a unit stands in for the PCF penumbra.
    to_centre_x, to_centre_y, to_centre_z = -hit_x, 1.0, -hit_z
    along = to_centre_x * lx + to_centre_y * ly + to_centre_z * lz
    shadow = 1.0
    if along > 0:
        perpendicular_sq = (to_centre_x * to_centre_x + to_centre_y * to_centre_y
                            + to_centre_z * to_centre_z) - along * along
        distance = math.sqrt(perpendicular_sq) if perpendicular_sq > 0 else 0.0
        if distance < 1.0 + _SHADOW_SOFTNESS:
            edge = (distance - 1.0) / _SHADOW_SOFTNESS
            shadow = 0.0 if edge <= 0 else edge * edge * (3 - 2 * edge)
    n_dot_l = max(0.0, ly)  # the plane's normal is +Y
    value = _PLANE_ALBEDO * _RECIP_PI * (_AMBIENT + intensity * n_dot_l * shadow)
    if n_dot_l > 0 and shadow > 0:
        value += intensity * n_dot_l * shadow * _specular(
            0.0, 1.0, 0.0, -dx, -dy, -dz, lx, ly, lz, n_dot_l, _PLANE_A2)
    return value


def _upscale_2x(channel, size):
    """Bilinear 512 -> 1024 on one channel, standing in for the author's
    LANCZOS resize of the browser's 512 canvas. On content this smooth the two
    differ by well under a level; what matters is that the reference arrives at
    1024, the size the LoRA was trained against."""
    target = size * 2
    out = bytearray(target * target)
    last = size - 1
    for y in range(target):
        source_y = (y + 0.5) * 0.5 - 0.5
        y0 = int(math.floor(source_y))
        wy = source_y - y0
        y0 = 0 if y0 < 0 else (last if y0 > last else y0)
        y1 = y0 + 1 if y0 < last else last
        row0, row1 = y0 * size, y1 * size
        base = y * target
        for x in range(target):
            source_x = (x + 0.5) * 0.5 - 0.5
            x0 = int(math.floor(source_x))
            wx = source_x - x0
            x0 = 0 if x0 < 0 else (last if x0 > last else x0)
            x1 = x0 + 1 if x0 < last else last
            top = channel[row0 + x0] + (channel[row0 + x1] - channel[row0 + x0]) * wx
            bottom = channel[row1 + x0] + (channel[row1 + x1] - channel[row1 + x0]) * wx
            out[base + x] = int(top + (bottom - top) * wy + 0.5)
    return out


def sun_light_vector(rotation, elevation):
    """The author's lightPosition(), normalised. +X is screen right, +Z is
    toward the camera, so rotation 0 is a light behind the viewer and +/-180 is
    a backlight."""
    azimuth = math.radians(rotation)
    altitude = math.radians(elevation)
    return (math.cos(altitude) * math.sin(azimuth),
            math.sin(altitude),
            math.cos(altitude) * math.cos(azimuth))


def render_sun_sphere_png(rotation, elevation, intensity=1.5):
    """The lit reference sphere the Sun Direction LoRA reads."""
    rotation = _clamp(rotation, *SUN_ROTATION_RANGE)
    elevation = _clamp(elevation, *SUN_ELEVATION_RANGE)
    intensity = _clamp(intensity, *SUN_INTENSITY_RANGE)
    light = sun_light_vector(rotation, elevation)
    size = _RENDER
    inverse = 1.0 / size
    grey = bytearray(size * size)
    # Edge samples are collected on the first pass and re-shaded at 3x3 below:
    # everything except the silhouette and the shadow rim is smooth enough that
    # one sample per pixel is already exact.
    for py in range(size):
        row = py * size
        for px in range(size):
            value = _shade(px + 0.5, py + 0.5, inverse, light, intensity)
            grey[row + px] = _CLEAR if value is None else _linear_to_srgb_byte(value)
    for py in range(1, size - 1):
        row = py * size
        for px in range(1, size - 1):
            here = grey[row + px]
            if (abs(grey[row + px - 1] - here) > 6 or abs(grey[row + px + 1] - here) > 6
                    or abs(grey[row - size + px] - here) > 6 or abs(grey[row + size + px] - here) > 6):
                total = 0.0
                for sy in range(3):
                    for sx in range(3):
                        value = _shade(px + (sx + 0.5) / 3, py + (sy + 0.5) / 3,
                                       inverse, light, intensity)
                        total += (_srgb_to_linear(_CLEAR / 255) if value is None else value)
                grey[row + px] = _linear_to_srgb_byte(total / 9)
    scaled = _upscale_2x(grey, size)
    out = bytearray(len(scaled) * 3)
    out[0::3] = scaled
    out[1::3] = scaled
    out[2::3] = scaled
    return _png(_TARGET, _TARGET, out)
