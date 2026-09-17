"""Real local media qualification; no provider calls or internet access."""
import subprocess
import wave
import math
import struct

from PIL import Image
import pytest

from studio.render import EFFECTS, TRANSITIONS, RenderCancelled, RenderError, _image_effect, _xfade, render_project


def scene(image="red", **changes):
    return {"id": "scene", "script": "A short story", "visual": "image", "image_id": image,
            "video_id": None, "voice_id": None, "duration_mode": "manual", "duration": .4,
            "caption": {"enabled": False}, "effect": {"type": "none"}, "transition": {"type": "none"},
            "video": {}, "voice": {}, "layers": [], **changes}


@pytest.fixture
def media(tmp_path):
    assets = {}
    for name, color in (("red", "red"), ("blue", "blue")):
        path = tmp_path / f"{name}.png"
        Image.new("RGB", (96, 64), color).save(path)
        assets[name] = {"path": str(path), "kind": "image"}
    audio = tmp_path / "tone.wav"
    with wave.open(str(audio), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(b"".join(struct.pack("<h", round(4000 * math.sin(i * 2 * math.pi * 440 / 48000))) for i in range(48000)))
    assets["voice"] = {"path": str(audio), "kind": "voice", "duration": 1}
    assets["music"] = {"path": str(audio), "kind": "music", "duration": 1}
    return assets


def frame(path, at=0):
    data = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-vf", "scale=1:1", "pipe:1"], check=True, capture_output=True).stdout
    return tuple(data[:3])


def test_real_transition_overlay_narration_and_music(tmp_path, media):
    scenes = [scene(voice_id="voice", voice={"trim_start": .1, "trim_end": .4, "speed": 1, "offset": .05, "volume": .7},
                    effect={"type": "zoom_in", "intensity": .1}, transition={"type": "fade", "duration": .2},
                    caption={"enabled": True, "text": "Hello", "style": "bubble", "font": "DejaVu Sans", "size": 64, "color": "white", "background": "#00000099"}),
              scene("blue", layers=[{"kind": "text", "text": "The end", "x": .2, "y": .2, "width": .6, "height": .3,
                                       "start": 0, "end": .3, "opacity": .9, "font_size": 80, "color": "white"}])]
    output = tmp_path / "result.mp4"
    progress = []
    result = render_project({"ratio": "16:9", "scenes": scenes, "music": {"asset_id": "music", "volume": .1, "trim_start": .2, "trim_end": .5, "loop": True, "fade_in": .1, "fade_out": .2, "ducking": True}}, media, output, progress.append)
    assert result["duration"] == pytest.approx(.6, abs=.07)
    assert (result["width"], result["height"]) == (1280, 720)
    assert result["byte_size"] == output.stat().st_size
    assert progress == sorted(progress) and progress[-1] == 1
    assert frame(output, .03)[0] > frame(output, .03)[2]
    assert frame(output, .55)[2] > frame(output, .55)[0]
    assert not list(tmp_path.glob("spark-render-*"))


@pytest.mark.parametrize("ratio,size", [("9:16", (720, 1280)), ("1:1", (720, 720))])
def test_output_aspect_ratios(tmp_path, media, ratio, size):
    result = render_project({"ratio": ratio, "scenes": [scene(duration=.1)]}, media, tmp_path / "ratio.mp4")
    assert (result["width"], result["height"]) == size


def test_video_trim_speed_offset_return_to_image_and_looped_voice(tmp_path, media):
    video = tmp_path / "video.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=lime:s=96x64:r=30:d=1", "-i", media["voice"]["path"], "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video)], check=True)
    media["clip"] = {"path": str(video), "kind": "video", "duration": 1}
    item = scene(duration=.8, visual="video", video_id="clip", voice_id="voice",
                 video={"trim_start": .2, "trim_end": .6, "speed": 2, "offset": .2, "volume": .2, "end_behavior": "image"},
                 voice={"trim_start": .1, "trim_end": .2, "speed": 1, "offset": .1, "loop": True},
                 caption={"enabled": True, "style": "highlight", "size": 40, "words": [
                     {"text": "Shown", "start": .1, "end": .3, "hidden": False},
                     {"text": "Hidden", "start": .3, "end": .6, "hidden": True}]})
    output = tmp_path / "video-result.mp4"
    result = render_project({"scenes": [item]}, media, output)
    assert result["duration"] == pytest.approx(.8, abs=.05)
    before, during, after = frame(output, .05), frame(output, .28), frame(output, .65)
    assert before[0] > before[1]
    assert during[1] > during[0]
    assert after[0] > after[1]


def test_cancel_missing_assets_and_unsupported_settings_never_publish(tmp_path, media):
    output = tmp_path / "absent.mp4"
    with pytest.raises(RenderCancelled):
        render_project({"scenes": [scene()]}, media, output, cancelled=lambda: True)
    with pytest.raises(RenderError, match="missing"):
        render_project({"scenes": [scene("absent")]}, media, output)
    with pytest.raises(RenderError, match="Unsupported image movement"):
        render_project({"scenes": [scene(effect={"type": "unknown"})]}, media, output)
    assert not output.exists()
    assert not list(tmp_path.glob("spark-render-*"))


def test_remote_playlist_and_symlink_assets_rejected(tmp_path, media):
    path = tmp_path / "bad.mp4"
    path.write_text("#EXTM3U\nhttps://example.invalid/private\n")
    media["bad"] = {"path": str(path), "kind": "video"}
    with pytest.raises(RenderError):
        render_project({"scenes": [scene(visual="video", video_id="bad")]}, media, tmp_path / "bad-output.mp4")
    link = tmp_path / "linked.png"
    link.symlink_to(media["red"]["path"])
    media["linked"] = {"path": str(link), "kind": "image"}
    with pytest.raises(RenderError, match="regular private local"):
        render_project({"scenes": [scene("linked")]}, media, tmp_path / "link-output.mp4")


def test_blank_canvas_and_asset_integrity(tmp_path, media):
    result = render_project({"scenes": [scene(None, duration=.1, caption={"enabled": True, "font": "DejaVu Sans", "text": "Text-only story"})]}, {}, tmp_path / "text.mp4")
    assert result["duration"] == pytest.approx(.1, abs=.05)
    media["red"]["sha256"] = "0" * 64
    with pytest.raises(RenderError, match="changed after"):
        render_project({"scenes": [scene()]}, media, tmp_path / "changed.mp4")


def test_cancellation_during_active_render_keeps_existing_output(tmp_path, media):
    output = tmp_path / "existing.mp4"
    output.write_bytes(b"existing export")
    updates = []
    with pytest.raises(RenderCancelled):
        render_project({"scenes": [scene(duration=3)]}, media, output,
                       progress=updates.append, cancelled=lambda: bool(updates and updates[-1] > .04))
    assert output.read_bytes() == b"existing export"
    assert not list(tmp_path.glob("spark-render-*"))


@pytest.mark.parametrize("effect", sorted(EFFECTS - {"none"}))
def test_every_advertised_2d_effect_produces_real_motion(tmp_path, effect):
    """Exercise each filter on a static gradient, so movement cannot be faked by input motion."""
    source = tmp_path / "gradient.png"
    image = Image.new("RGB", (96, 72))
    image.putdata([(x * 2, y * 3, (x + y) % 256) for y in range(72) for x in range(96)])
    image.save(source)
    transform = _image_effect(effect, .5, .4, 96, 72).lstrip(",")
    result = subprocess.run(["ffmpeg", "-v", "error", "-filter_threads", "1", "-loop", "1", "-framerate", "30", "-i", str(source),
                             "-vf", transform, "-t", "0.4", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], capture_output=True, timeout=10, check=True)
    frame_bytes = 96 * 72 * 3
    assert len(result.stdout) == frame_bytes * 12
    assert result.stdout[:frame_bytes] != result.stdout[5 * frame_bytes:6 * frame_bytes]


@pytest.mark.parametrize("transition", sorted(TRANSITIONS - {"none"}))
def test_every_transition_has_correct_endpoints_and_dissolve_matches_preview(transition):
    result = subprocess.run(["ffmpeg", "-v", "error", "-filter_complex_threads", "1",
                             "-f", "lavfi", "-i", "color=c=red:s=96x72:r=30:d=0.6",
                             "-f", "lavfi", "-i", "color=c=blue:s=96x72:r=30:d=0.6",
                             "-filter_complex", f"[0:v][1:v]{_xfade(transition,.2,.4)}[v]", "-map", "[v]",
                             "-t", "1.0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], capture_output=True, timeout=10, check=True)
    frame_bytes = 96 * 72 * 3
    first, middle, last = result.stdout[:frame_bytes], result.stdout[15*frame_bytes:16*frame_bytes], result.stdout[-frame_bytes:]
    assert first[0] > 200 and first[2] < 30
    assert last[2] > 200 and last[0] < 30
    def pixel(x, y):
        return middle[(y*96+x)*3:(y*96+x)*3+3]
    if transition.startswith("wipe_"):
        left, right, top, bottom = [pixel(x,y) for x,y in ((5,36),(90,36),(48,5),(48,67))]
        revealed, covered = {"wipe_left": (right,left), "wipe_right": (left,right),
                             "wipe_up": (bottom,top), "wipe_down": (top,bottom)}[transition]
        assert revealed[2] > revealed[0] and covered[0] > covered[2]
    if transition == "dissolve":
        for cx, cy in ((1,2),(5,7),(17,12),(29,15)):
            cell = cx*17+cy*29
            threshold = ((cell*(cell+13)+19) % 997) / 997
            sample = pixel(cx*3+1,cy*4+2)
            assert (sample[2] > sample[0]) == (.5 >= 1-threshold)
