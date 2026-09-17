"""Private, bounded local composition. No network access or provider requests.

Scene/word/layer times are seconds relative to their scene. Untimed captions are
static scene text, deliberately not presented as speech alignment. Font aliases
use installed DejaVu fonts so exports do not depend on a browser's fonts.
"""
from __future__ import annotations

import json
import hashlib
import math
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
from typing import Callable

from PIL import Image, ImageColor, ImageDraw, ImageFont, ImageOps

FPS = 30
MAX_SECONDS = 1200
MAX_SCENE_SECONDS = 120
MAX_ASSET_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024
MAX_WORK_BYTES = 4 * 1024 * 1024 * 1024
DEADLINE_SECONDS = 900
FORMATS = "mov,matroska,webm,mp3,wav,ogg,flac,aac,png_pipe,jpeg_pipe,webp_pipe"
FONT_ROOT = Path("/usr/share/fonts/truetype/dejavu")
EFFECTS = {"none", "zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down",
           "ken_burns", "drift", "pulse", "rotate", "tilt", "bounce"}
TRANSITIONS = {"none", "fade", "crossfade", "dissolve", "slide_left", "slide_right", "slide_up", "slide_down",
               "wipe_left", "wipe_right", "wipe_up", "wipe_down", "zoom"}


class RenderError(ValueError):
    """A safe, user-readable export failure."""


class RenderCancelled(RenderError):
    pass


def _number(value, default=0.0, low=0.0, high=MAX_SECONDS, label="Value") -> float:
    try:
        n = float(default if value is None else value)
    except (TypeError, ValueError):
        raise RenderError(f"{label} must be a number.") from None
    if not math.isfinite(n) or not low <= n <= high:
        raise RenderError(f"{label} must be between {low:g} and {high:g}.")
    return n


def _fmt(value: float) -> str:
    return f"{value:.6f}"


def _atempo(speed: float) -> str:
    filters = []
    while speed > 2:
        filters.append("atempo=2")
        speed /= 2
    while speed < .5:
        filters.append("atempo=0.5")
        speed /= .5
    return ",".join(filters + [f"atempo={_fmt(speed)}"])


def _image_effect(effect_type: str, intensity: float, duration: float, width: int, height: int) -> str:
    """Deterministic 2D image transforms, shared mathematically with Preview.tsx."""
    if effect_type == "none" or not intensity:
        return ""
    fraction = f"on/{max(1,round(duration*FPS)-1)}"
    strength = _fmt(intensity)
    if effect_type in ("rotate", "tilt"):
        fraction = f"min(1,n/{max(1,round(duration*FPS)-1)})"
        degrees = f"20*{strength}*(2*{fraction}-1)" if effect_type == "rotate" else f"8*{strength}*sin(2*PI*{fraction})"
        return f",rotate=angle='({degrees})*PI/180':ow=iw:oh=ih:fillcolor=black"
    zoom, x, y = f"1+{strength}", "0.5", "0.5"
    if effect_type == "zoom_in":
        zoom = f"1+{strength}*{fraction}"
    elif effect_type == "zoom_out":
        zoom = f"1+{strength}*(1-{fraction})"
    elif effect_type == "pan_left":
        x = fraction
    elif effect_type == "pan_right":
        x = f"1-{fraction}"
    elif effect_type == "pan_up":
        y = fraction
    elif effect_type == "pan_down":
        y = f"1-{fraction}"
    elif effect_type == "ken_burns":
        zoom, x, y = f"1+{strength}*{fraction}", fraction, fraction
    elif effect_type == "drift":
        x, y = f"0.5+0.5*sin(2*PI*{fraction})", f"0.5+0.5*cos(2*PI*{fraction})"
    elif effect_type == "pulse":
        zoom = f"1+{strength}*(0.5-0.5*cos(2*PI*{fraction}))"
    elif effect_type == "bounce":
        y = f"0.5-0.5*cos(4*PI*{fraction})"
    return f",zoompan=z='{zoom}':x='(iw-iw/zoom)*({x})':y='(ih-ih/zoom)*({y})':d=1:s={width}x{height}:fps={FPS}"


def _xfade(transition: str, duration: float, offset: float) -> str:
    """Use custom shaders only when the browser has the identical visual rule."""
    suffix = f":duration={_fmt(duration)}:offset={_fmt(offset)}"
    if transition == "dissolve":
        cell = "(floor(X/W*32)*17+floor(Y/H*18)*29)"
        threshold = f"mod({cell}*({cell}+13)+19,997)/997"
        # FFmpeg P falls from 1 to 0; browser p rises from 0 to 1.
        return f"xfade=transition=custom{suffix}:expr='if(gt(P,{threshold}),A,B)'"
    if transition == "zoom":
        x, y = "(X-W/2)/(1+0.25*(1-P))+W/2", "(Y-H/2)/(1+0.25*(1-P))+H/2"
        sampled = f"if(eq(PLANE,0),a0({x},{y}),if(eq(PLANE,1),a1({x},{y}),a2({x},{y})))"
        return f"xfade=transition=custom{suffix}:expr='({sampled})*P+B*(1-P)'"
    name = {"fade": "fade", "crossfade": "fade", "slide_left": "slideleft", "slide_right": "slideright",
            "slide_up": "slideup", "slide_down": "slidedown", "wipe_left": "wipeleft", "wipe_right": "wiperight",
            "wipe_up": "wipeup", "wipe_down": "wipedown"}[transition]
    return f"xfade=transition={name}{suffix}"


class _Context:
    def __init__(self, work: Path, progress, cancelled):
        self.work = work
        self.progress = progress or (lambda value: None)
        self.cancelled = cancelled or (lambda: False)
        self.deadline = time.monotonic() + DEADLINE_SECONDS
        self.count = 0
        self.last_progress = 0.0
        self.last_storage_check = 0.0

    def check(self):
        if self.cancelled():
            raise RenderCancelled("Export cancelled.")
        if time.monotonic() > self.deadline:
            raise RenderError("Export exceeded the 15-minute processing limit. Try a shorter story or lower resolution.")
        if time.monotonic() - self.last_storage_check >= 1:
            self.check_storage()

    def check_storage(self):
        self.last_storage_check = time.monotonic()
        if sum(p.stat().st_size for p in self.work.rglob("*") if p.is_file()) > MAX_WORK_BYTES:
            raise RenderError("Export exceeded the temporary storage limit. Try a shorter story.")

    def report(self, value):
        self.last_progress = max(self.last_progress, min(1.0, value))
        self.progress(self.last_progress)

    def run(self, args, *, duration=None, start=0.0, span=0.0) -> str:
        self.check()
        self.check_storage()
        self.count += 1
        error_file = self.work / f"process_{self.count:03d}.log"
        limiter = shutil.which("prlimit")
        if not limiter:
            raise RenderError("The local renderer requires Linux prlimit for process resource limits.")
        command = [limiter, "--as=4294967296", "--cpu=900", f"--fsize={MAX_OUTPUT_BYTES}", "--nofile=256", "--", *map(str, args)]
        env = {**os.environ, "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "1"}
        chunks, pending = [], ""
        with error_file.open("wb") as errors:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=errors, start_new_session=True, env=env)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            try:
                while selector.get_map():
                    self.check()
                    for key, _ in selector.select(.1):
                        data = os.read(key.fd, 8192)
                        if not data:
                            selector.unregister(key.fileobj)
                            continue
                        decoded = data.decode("utf-8", errors="replace")
                        if duration:
                            pending += decoded
                            lines = pending.split("\n")
                            pending = lines.pop()
                            for line in lines:
                                if line.startswith("out_time_us="):
                                    try:
                                        fraction = float(line.partition("=")[2]) / 1_000_000 / duration
                                        self.report(start + span * max(0, min(.999, fraction)))
                                    except ValueError:
                                        pass
                        else:
                            chunks.append(decoded)
                            if sum(map(len, chunks)) > 2_000_000:
                                raise RenderError("Media metadata exceeds the supported size.")
                returncode = process.wait(timeout=2)
                if returncode:
                    # Do not expose private paths or arbitrary provider/media metadata.
                    detail = error_file.read_text(errors="replace")[-6000:]
                    if "No space left" in detail or returncode in (-signal.SIGXFSZ, 153):
                        raise RenderError("Export exceeded the available storage limit.")
                    raise RenderError("The local media renderer could not process this composition. Check uploaded media and reduce the resolution or scene count.")
                self.report(start + span)
                return "".join(chunks)
            finally:
                selector.close()
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                process.stdout.close()

    def ffmpeg(self, args, **kwargs):
        return self.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                         "-threads", "2", "-filter_threads", "1", "-filter_complex_threads", "1",
                         "-progress", "pipe:1", "-nostats", *args], **kwargs)

    def probe(self, path: Path) -> dict:
        raw = self.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                        "-format_whitelist", FORMATS, "-show_format", "-show_streams", "-of", "json", path])
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise RenderError("The media file has invalid metadata.") from None


def _input(path: Path, loop=False) -> list:
    return (["-stream_loop", "-1"] if loop else []) + ["-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS, "-i", str(path)]


def _font(name: str, size: float):
    fonts = {"inter": "DejaVuSans.ttf", "arial": "DejaVuSans.ttf", "roboto": "DejaVuSans.ttf",
             "sans": "DejaVuSans.ttf", "sans-serif": "DejaVuSans.ttf", "serif": "DejaVuSerif.ttf",
             "mono": "DejaVuSansMono.ttf", "monospace": "DejaVuSansMono.ttf", "dejavu sans": "DejaVuSans.ttf",
             "dejavu serif": "DejaVuSerif.ttf", "dejavu sans mono": "DejaVuSansMono.ttf"}
    filename = fonts.get(str(name or "sans").lower())
    if filename is None:
        raise RenderError(f"Caption font {str(name)[:40]!r} is unsupported. Choose sans, serif, or monospace.")
    try:
        return ImageFont.truetype(str(FONT_ROOT / filename), max(1, round(size)))
    except OSError:
        raise RenderError("The renderer's DejaVu fonts are missing. Install fonts-dejavu-core.") from None


def _color(value, default="white"):
    try:
        if value == "transparent":
            return (0, 0, 0, 0)
        return ImageColor.getcolor(str(value or default), "RGBA")
    except ValueError:
        raise RenderError("Text and background colors must be valid CSS color names or hex colors.") from None


def _wrap(draw, text, font, width):
    if len(text) > 10000:
        raise RenderError("A text overlay is too long; limit it to 10,000 characters.")
    lines = []
    for paragraph in text.split("\n"):
        line = ""
        for word in paragraph.split():
            candidate = (line + " " + word).strip()
            if draw.textlength(candidate, font=font) <= width:
                line = candidate
            else:
                if line:
                    lines.append(line)
                line = ""
                # Split long unbroken words rather than allowing text outside its box.
                for char in word:
                    if line and draw.textlength(line + char, font=font) > width:
                        lines.append(line)
                        line = ""
                    line += char
        lines.append(line)
    return "\n".join(lines)


def _timing(clip: dict, asset: dict) -> tuple[float, float, float, float]:
    total = _number(asset.get("duration"), high=7200, label="Media duration")
    start = _number(clip.get("trim_start"), high=total, label="Trim start")
    end = _number(clip.get("trim_end"), default=total, high=total, label="Trim end")
    if end <= start:
        raise RenderError("Trim end must be after trim start.")
    speed = _number(clip.get("speed"), 1, .25, 4, "Playback speed")
    offset = _number(clip.get("offset"), high=120, label="Clip offset")
    return start, end, speed, offset


def _scene_duration(scene, assets):
    mode = scene.get("duration_mode", "manual")
    if mode == "manual":
        duration = _number(scene.get("duration"), 5, .1, MAX_SCENE_SECONDS, "Scene duration")
    elif mode in ("voice", "video"):
        asset = assets.get(scene.get(f"{mode}_id"))
        if not asset:
            raise RenderError(f"A scene uses {mode} duration but has no selected {mode} asset.")
        start, end, speed, offset = _timing(scene.get(mode, {}), asset)
        duration = offset + (end - start) / speed
        if not .1 <= duration <= MAX_SCENE_SECONDS:
            raise RenderError("Automatic scene duration must be between 0.1 and 120 seconds.")
    else:
        raise RenderError("Unsupported scene duration mode.")
    # Export and overlap boundaries sit on the output frame grid.
    return max(3, math.floor(duration * FPS + .5)) / FPS


def _prepare_assets(ctx, assets, references):
    prepared = {}
    for index, asset_id in enumerate(sorted(references)):
        ctx.check()
        asset = assets.get(asset_id)
        if not asset or not asset.get("path"):
            raise RenderError("A selected asset is missing. Select or upload it again.")
        source = Path(asset["path"])
        if not source.is_absolute() or not source.is_file() or source.is_symlink():
            raise RenderError("Selected media must be a regular private local file.")
        if not 0 < source.stat().st_size <= MAX_ASSET_BYTES:
            raise RenderError("Selected media exceeds the 512 MB file limit or is empty.")
        current_bytes = sum(p.stat().st_size for p in ctx.work.rglob("*") if p.is_file())
        if current_bytes + source.stat().st_size > MAX_WORK_BYTES:
            raise RenderError("Selected assets exceed the temporary storage limit. Use smaller media files.")
        kind = asset.get("kind")
        target = ctx.work / f"asset_{index:03d}.bin"
        shutil.copyfile(source, target)
        ctx.check_storage()
        expected_hash = asset.get("sha256") or (asset.get("metadata") or {}).get("sha256")
        if expected_hash:
            digest = hashlib.sha256()
            with target.open("rb") as source_file:
                while chunk := source_file.read(1024 * 1024):
                    ctx.check()
                    digest.update(chunk)
            if digest.hexdigest() != expected_hash:
                raise RenderError("A selected asset changed after the export was queued. Upload or select the asset again.")
        prepared[asset_id] = {**asset, "path": target}
        if kind in ("image", "character"):
            try:
                with Image.open(target) as original:
                    if original.width * original.height > 40_000_000 or original.format not in ("PNG", "JPEG", "WEBP"):
                        raise RenderError("Images must be PNG, JPEG, or WebP and at most 40 megapixels.")
                    converted = ImageOps.exif_transpose(original).convert("RGBA")
                    if converted.width > 8192 or converted.height > 8192:
                        raise RenderError("Images must be at most 8192 pixels on each side.")
                    image_path = target.with_suffix(".png")
                    converted.save(image_path)
                    prepared[asset_id]["path"] = image_path
            except (OSError, Image.DecompressionBombError):
                raise RenderError("A selected image is damaged or unsupported.") from None
        elif kind in ("video", "voice", "music"):
            metadata = ctx.probe(target)
            streams = metadata.get("streams", [])
            expected = "video" if kind == "video" else "audio"
            if not any(stream.get("codec_type") == expected for stream in streams):
                raise RenderError(f"The selected {kind} file has no {expected} stream.")
            video_streams = [s for s in streams if s.get("codec_type") == "video"]
            if any(int(s.get("width", 0)) * int(s.get("height", 0)) > 40_000_000
                   or int(s.get("width", 0)) > 8192 or int(s.get("height", 0)) > 8192 for s in video_streams):
                raise RenderError("Video dimensions exceed the 40 megapixel or 8192 pixel limit.")
            duration = _number(metadata.get("format", {}).get("duration"), low=.01, high=7200, label="Media duration")
            prepared[asset_id].update(duration=duration, has_audio=any(s.get("codec_type") == "audio" for s in streams))
        else:
            raise RenderError("Selected media has an unsupported asset kind.")
    return prepared


def _overlays(ctx, scene, assets, width, height, duration, prefix):
    caption = scene.get("caption") or {}
    layers = scene.get("layers") or []
    if len(layers) > 30:
        raise RenderError("A scene supports up to 30 overlay layers.")
    words = caption.get("words") or []
    if len(words) > 300:
        raise RenderError("A scene supports up to 300 timed caption words.")
    boundaries = {0.0, duration}
    for item in [*words, *layers]:
        start = _number(item.get("start"), high=120, label="Overlay start")
        end = _number(item.get("end"), duration, high=120, label="Overlay end")
        if end <= start:
            raise RenderError("Caption and layer end times must be after start times.")
        boundaries.update((min(duration, round(start * FPS) / FPS), min(duration, round(end * FPS) / FPS)))
    boundaries = sorted(boundaries)
    if not caption.get("enabled") and not layers:
        return None
    entries = []
    for index, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
        ctx.check()
        at = (start + end) / 2
        canvas = Image.new("RGBA", (width, height))
        draw = ImageDraw.Draw(canvas)
        for layer in layers:
            if not float(layer.get("start", 0)) <= at < float(layer.get("end") if layer.get("end") is not None else duration):
                continue
            x = round(_number(layer.get("x"), 0, 0, 1, "Layer X") * width)
            y = round(_number(layer.get("y"), 0, 0, 1, "Layer Y") * height)
            lw = max(1, round(_number(layer.get("width"), .5, .001, 1, "Layer width") * width))
            lh = max(1, round(_number(layer.get("height"), .2, .001, 1, "Layer height") * height))
            opacity = _number(layer.get("opacity"), 1, 0, 1, "Layer opacity")
            if layer.get("kind") == "image":
                asset = assets.get(layer.get("asset_id"))
                if not asset or asset.get("kind") not in ("image", "character"):
                    raise RenderError("An image layer needs a selected image asset.")
                with Image.open(asset["path"]) as source:
                    image = ImageOps.contain(source.convert("RGBA"), (lw, lh))
                image.putalpha(image.getchannel("A").point(lambda a: round(a * opacity)))
                canvas.alpha_composite(image, (x, y))
            elif layer.get("kind") == "text":
                image = Image.new("RGBA", (lw, lh))
                painter = ImageDraw.Draw(image)
                font = _font("sans", _number(layer.get("font_size"), 48, 1, 300, "Layer font size") * height / 1080)
                text = _wrap(painter, str(layer.get("text") or ""), font, lw)
                color = _color(layer.get("color"))
                painter.multiline_text((0, 0), text, font=font, fill=(*color[:3], round(color[3] * opacity)), spacing=4)
                canvas.alpha_composite(image, (x, y))
            else:
                raise RenderError("Unsupported layer type.")
        if caption.get("enabled"):
            style = caption.get("style", "plain")
            if style not in ("plain", "bubble", "highlight"):
                raise RenderError("Unsupported caption style.")
            text = " ".join(str(w.get("text", "")) for w in words if not w.get("hidden") and float(w.get("start", 0)) <= at < float(w.get("end", duration))) if words else str(caption.get("text") or scene.get("script") or "")
            font = _font(caption.get("font", "sans"), _number(caption.get("size"), 48, 1, 300, "Caption size") * height / 1080)
            text = _wrap(draw, text, font, width * .85)
            if text:
                bbox = draw.multiline_textbbox((0, 0), text, font=font, align="center", spacing=6)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                position = caption.get("position", "bottom")
                if position not in ("top", "center", "bottom"):
                    raise RenderError("Unsupported caption position.")
                center_y = {"top": height * .12, "center": height * .5, "bottom": height * .86}[position]
                x, y = (width - tw) / 2, center_y - th / 2
                padding = max(6, round(height / 1080 * 18))
                box = (x - padding, y - padding, x + tw + padding, y + th + padding)
                background = _color(caption.get("background"), "#000000B3")
                if style in ("bubble", "highlight"):
                    draw.rounded_rectangle(box, radius=padding if style == "bubble" else padding // 2, fill=background)
                else:
                    draw.rectangle(box, fill=background)
                draw.multiline_text((x - bbox[0], y - bbox[1]), text, font=font, fill=_color(caption.get("color")), align="center", spacing=6,
                                    stroke_width=1 if style == "plain" else 0, stroke_fill=(0, 0, 0, 200))
        image_path = ctx.work / f"{prefix}_overlay_{index:03d}.png"
        canvas.save(image_path)
        entries.extend([f"file '{image_path.name}'", "option framerate 30", f"duration {_fmt(end-start)}"])
    # concat needs the final file repeated to establish the last frame's duration.
    entries.extend([f"file '{image_path.name}'", "option framerate 30"])
    manifest = ctx.work / f"{prefix}_overlays.ffconcat"
    manifest.write_text("ffconcat version 1.0\n" + "\n".join(entries) + "\n")
    return manifest


def _normalize_clip(ctx, asset, clip, target, visual=False):
    start, end, speed, offset = _timing(clip, asset)
    duration = (end - start) / speed
    args = ["-ss", _fmt(start), *_input(asset["path"])]
    if visual:
        # Bound the intermediate raster and make odd-sized source video H.264 safe.
        filters = [f"[0:v]trim=duration={_fmt(end-start)},setpts=(PTS-STARTPTS)/{_fmt(speed)},scale=w='min(2560,iw)':h='min(2560,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps={FPS},setsar=1[v]"]
        args += ["-filter_complex", ";".join(filters), "-map", "[v]"]
        if asset.get("has_audio"):
            args += ["-map", "0:a:0", "-af", f"atrim=duration={_fmt(end-start)},asetpts=PTS-STARTPTS,{_atempo(speed)}", "-c:a", "aac", "-ar", "48000", "-ac", "2"]
        else:
            args += ["-an"]
        args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "2"]
    else:
        args += ["-vn", "-af", f"atrim=duration={_fmt(end-start)},asetpts=PTS-STARTPTS,{_atempo(speed)}", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"]
    # Output -t must use the speed-adjusted duration, including slow playback.
    args += ["-t", _fmt(duration), str(target)]
    ctx.ffmpeg(args, duration=duration)
    return duration, offset


def _render_scene(ctx, scene, assets, width, height, duration, index, quality, progress_start, progress_span):
    prefix = f"scene_{index:03d}"
    visual = scene.get("visual", "image")
    if visual not in ("image", "video"):
        raise RenderError("Unsupported visual type.")
    image_asset = assets.get(scene.get("image_id"))
    if image_asset and image_asset.get("kind") not in ("image", "character"):
        raise RenderError("The scene image must be an image asset.")
    # A scene without media is a black canvas for captions and text/image layers.
    args, filters = [], []
    if image_asset:
        args += ["-loop", "1", "-framerate", str(FPS), *_input(image_asset["path"])]
    else:
        args += ["-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r={FPS}"]
    crop = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1"
    effect = scene.get("effect") or {}
    effect_type = effect.get("type", "none")
    if effect_type not in EFFECTS:
        raise RenderError("Unsupported image movement effect.")
    intensity = _number(effect.get("intensity"), .15, 0, 1, "Image effect intensity")
    if visual == "image" and effect_type != "none" and intensity:
        crop += _image_effect(effect_type, intensity, duration, width, height)
    elif visual == "video" and effect_type != "none":
        raise RenderError("Pan and zoom effects apply to image scenes. Set the image effect to none for video scenes.")
    filters.append(f"[0:v]{crop},format=yuv420p[base]")
    current, next_input = "base", 1
    audio = []
    if visual == "video":
        asset = assets.get(scene.get("video_id"))
        if not asset or asset.get("kind") != "video":
            raise RenderError("Every video scene needs a selected video before export.")
        clip = scene.get("video") or {}
        if clip.get("end_behavior", "hold") not in ("hold", "image"):
            raise RenderError("Unsupported video end behavior.")
        normalized = ctx.work / f"{prefix}_clip.mp4"
        clip_duration, offset = _normalize_clip(ctx, asset, clip, normalized, visual=True)
        args += _input(normalized, bool(clip.get("loop")))
        tail = f",tpad=stop_mode=clone:stop_duration={_fmt(duration)}" if clip.get("end_behavior", "hold") == "hold" and not clip.get("loop") else ""
        filters.append(f"[{next_input}:v]{crop}{tail},setpts=PTS-STARTPTS+{_fmt(offset)}/TB[clipv]")
        visible_until = duration if clip.get("loop") or clip.get("end_behavior", "hold") == "hold" else offset + clip_duration
        filters.append(f"[base][clipv]overlay=eof_action=pass:repeatlast=0:enable='gte(t,{_fmt(offset)})*lt(t,{_fmt(visible_until)})'[visual]")
        current = "visual"
        volume = _number(clip.get("volume"), 1, 0, 2, "Video volume")
        if asset.get("has_audio"):
            filters.append(f"[{next_input}:a]atrim=duration={_fmt(max(.001,duration-offset))},asetpts=PTS-STARTPTS,volume={_fmt(volume)},adelay={round(offset*1000)}:all=1[videoa]")
            audio.append("videoa")
        next_input += 1
    voice_asset = assets.get(scene.get("voice_id"))
    if voice_asset:
        if voice_asset.get("kind") not in ("voice", "music"):
            raise RenderError("Selected narration must be an audio asset.")
        clip = scene.get("voice") or {}
        normalized = ctx.work / f"{prefix}_voice.wav"
        _, offset = _normalize_clip(ctx, voice_asset, clip, normalized)
        args += _input(normalized, bool(clip.get("loop")))
        volume = _number(clip.get("volume"), 1, 0, 2, "Voice volume")
        filters.append(f"[{next_input}:a]atrim=duration={_fmt(max(.001,duration-offset))},asetpts=PTS-STARTPTS,volume={_fmt(volume)},adelay={round(offset*1000)}:all=1[voicea]")
        audio.append("voicea")
        next_input += 1
    overlay = _overlays(ctx, scene, assets, width, height, duration, prefix)
    if overlay:
        # This manifest contains only renderer-created relative PNG filenames;
        # option framerate requires safe=0. User paths/text never enter it.
        args += ["-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "0", "-i", str(overlay)]
        filters.append(f"[{next_input}:v]format=rgba,setpts=PTS-STARTPTS[graphics]")
        filters.append(f"[{current}][graphics]overlay=eof_action=pass:format=auto[outv]")
        current = "outv"
        next_input += 1
    args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    filters.append(f"[{next_input}:a]atrim=duration={_fmt(duration)}[silence]")
    audio.append("silence")
    filters.append("".join(f"[{label}]" for label in audio) + f"amix=inputs={len(audio)}:duration=longest:normalize=0,alimiter=limit=0.95:latency=1[audio]")
    output = ctx.work / f"{prefix}.mp4"
    args += ["-filter_complex", ";".join(filters), "-map", f"[{current}]", "-map", "[audio]", "-t", _fmt(duration),
             "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18" if quality == "high" else "23",
             "-pix_fmt", "yuv420p", "-threads", "2", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", str(output)]
    ctx.ffmpeg(args, duration=duration, start=progress_start, span=progress_span)
    return output


def render_project(document: dict, assets: dict[str, dict], output: Path,
                   progress: Callable[[float], None] | None = None,
                   cancelled: Callable[[], bool] | None = None,
                   resolution: int = 720, quality: str = "high") -> dict:
    """Compose a frozen project to a verified H.264/AAC MP4, atomically published.

    Assets require ``path`` and ``kind``; media duration is reprobed locally.
    Raises RenderError/RenderCancelled and never publishes partial output.
    ``progress`` receives monotonic fractions in [0, 1].
    """
    if resolution not in (720, 1080, 1440) or quality not in ("standard", "high"):
        raise RenderError("Export supports 720p, 1080p, or 1440p and standard or high quality.")
    ratio = document.get("ratio", "16:9")
    if ratio not in ("16:9", "9:16", "1:1"):
        raise RenderError("Export supports landscape, portrait, or square aspect ratios.")
    short, long = resolution, round(resolution * 16 / 9 / 2) * 2
    width, height = (long, short) if ratio == "16:9" else (short, long) if ratio == "9:16" else (short, short)
    scenes = document.get("scenes") or []
    if not 1 <= len(scenes) <= 50:
        raise RenderError("Export needs between 1 and 50 scenes.")
    if document.get("kind", "video") != "video":
        raise RenderError("MP4 export currently supports video projects only.")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RenderError("FFmpeg and ffprobe must be installed to export video.")
    with tempfile.TemporaryDirectory(prefix="spark-render-", dir=output.parent) as directory:
        ctx = _Context(Path(directory), progress, cancelled)
        ctx.check()
        references = {str(scene[key]) for scene in scenes for key in ("image_id", "video_id", "voice_id") if scene.get(key)}
        references.update(str(layer["asset_id"]) for scene in scenes for layer in scene.get("layers", []) if layer.get("asset_id"))
        music = document.get("music") or {}
        if music.get("asset_id"):
            references.add(str(music["asset_id"]))
        prepared = _prepare_assets(ctx, assets, references)
        durations = [_scene_duration(scene, prepared) for scene in scenes]
        overlaps = []
        starts = [0.0]
        for index, scene in enumerate(scenes[:-1]):
            transition = scene.get("transition") or {}
            kind = transition.get("type", "none")
            if kind not in TRANSITIONS:
                raise RenderError("Unsupported scene transition.")
            overlap = min(_number(transition.get("duration"), .5, 0, 10, "Transition duration"), durations[index] / 2, durations[index + 1] / 2) if kind != "none" else 0
            overlap = math.floor(overlap * FPS + 1e-7) / FPS
            overlaps.append(overlap)
            starts.append(starts[-1] + durations[index] - overlap)
        total = starts[-1] + durations[-1]
        if total > MAX_SECONDS:
            raise RenderError("Exports are limited to 20 minutes.")
        ctx.report(.03)
        scene_paths = [_render_scene(ctx, scene, prepared, width, height, duration, index, quality,
                                     .03 + .67 * index / len(scenes), .67 / len(scenes))
                       for index, (scene, duration) in enumerate(zip(scenes, durations))]
        args, filters = [], []
        for index, path in enumerate(scene_paths):
            args += _input(path)
            filters += [f"[{index}:v]settb=AVTB,setpts=PTS-STARTPTS[v{index}]", f"[{index}:a]asetpts=PTS-STARTPTS[a{index}]"]
        video, sound = "v0", "a0"
        elapsed = durations[0]
        for index in range(1, len(scenes)):
            overlap = overlaps[index - 1]
            nv, na = f"joinedv{index}", f"joineda{index}"
            if overlap:
                transition = _xfade(scenes[index-1]["transition"]["type"], overlap, elapsed-overlap)
                filters += [f"[{video}][v{index}]{transition}[{nv}]",
                            f"[{sound}][a{index}]acrossfade=d={_fmt(overlap)}:c1=tri:c2=tri[{na}]"]
            else:
                filters += [f"[{video}][{sound}][v{index}][a{index}]concat=n=2:v=1:a=1[{nv}][{na}]"]
            video, sound = nv, na
            elapsed += durations[index] - overlap
        if music.get("asset_id"):
            asset = prepared[music["asset_id"]]
            if asset.get("kind") not in ("music", "voice"):
                raise RenderError("The soundtrack must be an audio asset.")
            clip = {"trim_start": music.get("trim_start", 0), "trim_end": music.get("trim_end"), "speed": 1}
            normalized = ctx.work / "music.wav"
            _normalize_clip(ctx, asset, clip, normalized)
            args += _input(normalized, bool(music.get("loop")))
            volume = _number(music.get("volume"), .2, 0, 2, "Music volume")
            volume_expr = _fmt(volume)
            if music.get("ducking"):
                intervals = []
                for scene, scene_start, duration in zip(scenes, starts, durations):
                    voice = prepared.get(scene.get("voice_id"))
                    settings = scene.get("voice") or {}
                    if voice and _number(settings.get("volume"), 1, 0, 2, "Voice volume") > 0:
                        first, last, speed, offset = _timing(settings, voice)
                        end = duration if settings.get("loop") else min(duration, offset + (last-first)/speed)
                        if end > offset:
                            intervals.append(f"between(t,{_fmt(scene_start+offset)},{_fmt(scene_start+end)})")
                if intervals:
                    volume_expr += f"*if(gt({'+'.join(intervals)},0),0.35,1)"
            fade_in = _number(music.get("fade_in"), high=120, label="Music fade in")
            fade_out = _number(music.get("fade_out"), high=120, label="Music fade out")
            chain = f"[{len(scenes)}:a]atrim=duration={_fmt(total)},asetpts=PTS-STARTPTS,volume='{volume_expr}':eval=frame,apad=whole_dur={_fmt(total)}"
            if fade_in:
                chain += f",afade=t=in:st=0:d={_fmt(min(fade_in,total))}"
            if fade_out:
                chain += f",afade=t=out:st={_fmt(max(0,total-fade_out))}:d={_fmt(min(fade_out,total))}"
            filters.append(chain + "[music]")
            filters.append(f"[{sound}][music]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95:latency=1[mixed]")
            sound = "mixed"
        final = ctx.work / "finished.mp4"
        args += ["-filter_complex", ";".join(filters), "-map", f"[{video}]", "-map", f"[{sound}]", "-t", _fmt(total),
                 "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18" if quality == "high" else "23",
                 "-pix_fmt", "yuv420p", "-threads", "2", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
                 "-movflags", "+faststart", "-fs", str(MAX_OUTPUT_BYTES), str(final)]
        ctx.ffmpeg(args, duration=total, start=.70, span=.28)
        metadata = ctx.probe(final)
        videos = [s for s in metadata.get("streams", []) if s.get("codec_type") == "video"]
        sounds = [s for s in metadata.get("streams", []) if s.get("codec_type") == "audio"]
        actual_duration = _number(metadata.get("format", {}).get("duration"), high=MAX_SECONDS + 1, label="Output duration")
        size = final.stat().st_size
        if (len(videos) != 1 or not sounds or videos[0].get("codec_name") != "h264" or sounds[0].get("codec_name") != "aac"
                or videos[0].get("width") != width or videos[0].get("height") != height
                or abs(actual_duration - total) > .15 or not 0 < size < MAX_OUTPUT_BYTES):
            raise RenderError("The rendered output did not pass video validation. No export was published.")
        ctx.check()
        os.replace(final, output)
        ctx.report(1.0)
        return {"duration": actual_duration, "width": width, "height": height, "byte_size": size}
