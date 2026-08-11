"""Video decode/encode with audio passthrough (PyAV).

PyAV bundles ffmpeg libraries (no ffmpeg CLI needed). Video is re-encoded
(h264) at the interpolated fps; the original audio stream is remuxed by packet
copy (no re-encode) — its duration is unchanged since interpolation only adds
frames *between* existing ones.
"""

from __future__ import annotations

import fractions

import numpy as np


def read_frames(path: str):
    """Yield (frame_rgb_uint8 [H,W,3]) and return source fps via .fps attr."""
    import av
    container = av.open(path)
    stream = container.streams.video[0]
    fps = float(stream.average_rate) if stream.average_rate else 30.0
    frames = []
    for frame in container.decode(stream):
        frames.append(frame.to_ndarray(format="rgb24"))
    container.close()
    return frames, fps


def write_video(path: str, frames, fps: float, audio_from: str | None = None) -> None:
    """Encode RGB uint8 frames at `fps`; remux audio from `audio_from` if given."""
    import av
    H, W = frames[0].shape[:2]
    out = av.open(path, mode="w")
    vstream = out.add_stream("h264", rate=fractions.Fraction(fps).limit_denominator(1000000))
    vstream.width = W
    vstream.height = H
    vstream.pix_fmt = "yuv420p"

    astream = in_audio = in_container = None
    if audio_from is not None:
        in_container = av.open(audio_from)
        if in_container.streams.audio:
            in_audio = in_container.streams.audio[0]
            # PyAV >=10: remux by copying the source audio stream (no re-encode)
            astream = out.add_stream_from_template(in_audio)

    for f in frames:
        vframe = av.VideoFrame.from_ndarray(np.ascontiguousarray(f), format="rgb24")
        for pkt in vstream.encode(vframe):
            out.mux(pkt)
    for pkt in vstream.encode():  # flush
        out.mux(pkt)

    if in_audio is not None and astream is not None:
        for pkt in in_container.demux(in_audio):
            if pkt.dts is None:
                continue
            pkt.stream = astream
            out.mux(pkt)
    if in_container is not None:
        in_container.close()
    out.close()
