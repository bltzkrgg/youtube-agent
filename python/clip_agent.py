#!/usr/bin/env python3
"""
Clip Agent — Full AI pipeline assembly.
Input: config JSON with script segments, voiceover per segment, footage per segment.
Output: final 1080x1920 MP4 + thumbnail.

Pipeline per segment:
  1. Load footage clip (Pexels)
  2. Resize/crop to 1080x1920 (center crop)
  3. Loop/trim to match voiceover duration
  4. Burn caption text with dramatic styling
  5. Apply SFX visual hint (zoom, glitch filter)

Then:
  6. Concatenate all segments
  7. Merge with concatenated voiceover audio
  8. Generate thumbnail from frame at 1s
"""

import sys
import json
import os
import subprocess
import textwrap
import shutil
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
    import numpy as np
except ImportError:
    print(json.dumps({"error": "Pillow/numpy not installed: pip install Pillow numpy"}))
    sys.exit(1)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: clip_agent.py <config_json> <output_dir>"}))
        sys.exit(1)

    config_path = sys.argv[1]
    output_dir = sys.argv[2]

    if not os.path.exists(config_path):
        print(json.dumps({"error": f"Config tidak ditemukan: {config_path}"}))
        sys.exit(1)

    with open(config_path, encoding="utf-8") as f:
        cfg = json.load(f)

    os.makedirs(output_dir, exist_ok=True)

    # Partial output state — resume on failure (rule 39)
    state_path = os.path.join(output_dir, "clip_state.json")
    state = _load_state(state_path)

    try:
        result = process_video(cfg, output_dir, state, state_path)
        print(json.dumps({"success": True, **result}))
    except Exception as e:
        import traceback
        err = {"error": str(e), "traceback": traceback.format_exc()}
        print(json.dumps(err))
        sys.exit(1)


def _load_state(path):
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_state(path, state):
    with open(path, "w") as f:
        json.dump(state, f, indent=2)


# ─── Main pipeline ────────────────────────────────────────────────────────────

def process_video(cfg, output_dir, state, state_path):
    segments      = cfg["segments"]        # from script.json
    voiceover     = cfg["voiceover"]       # from voiceover.json: [{index, audio_path, duration_seconds}]
    footage       = cfg["footage"]         # from visual.json: [{index, footage_path, duration_seconds}]
    title         = cfg.get("title", "")
    width         = int(cfg.get("width", 1080))
    height        = int(cfg.get("height", 1920))
    fps           = int(cfg.get("fps", 30))
    full_audio    = cfg["full_audio_path"]
    out_video     = cfg.get("output_video", os.path.join(output_dir, "final.mp4"))
    out_thumb     = cfg.get("output_thumbnail", os.path.join(output_dir, "thumbnail.jpg"))

    work_dir = os.path.join(output_dir, "work")
    os.makedirs(work_dir, exist_ok=True)

    # Build voiceover duration lookup: {index: duration_seconds}
    voice_dur = {v["index"]: v["duration_seconds"] for v in voiceover}

    # Step 1: Process each segment → cropped + trimmed + captioned clip
    processed_clips = []
    for seg in segments:
        idx = seg["index"]
        clip_out = os.path.join(work_dir, f"clip_{idx:02d}.mp4")

        if state.get(f"clip_{idx}_done") and os.path.exists(clip_out):
            processed_clips.append(clip_out)
            continue

        foot = next((f for f in footage if f["index"] == idx), None)
        if not foot or not os.path.exists(foot["footage_path"]):
            # Fallback: create a solid color placeholder clip
            clip_out = _make_placeholder_clip(work_dir, idx, voice_dur.get(idx, 5.0), width, height, fps)
        else:
            dur = voice_dur.get(idx, seg.get("duration_hint_sec", 5.0))
            clip_out = _process_segment_clip(
                footage_path=foot["footage_path"],
                text=seg["text"],
                sfx=seg.get("sfx", "none"),
                segment_type=seg["type"],
                duration=dur,
                width=width, height=height, fps=fps,
                output_path=clip_out,
                is_hook=(seg["type"] == "hook"),
            )

        processed_clips.append(clip_out)
        state[f"clip_{idx}_done"] = True
        _save_state(state_path, state)

    # Step 2: Concatenate all segment clips
    concat_video = os.path.join(work_dir, "concat.mp4")
    if not state.get("concat_done") or not os.path.exists(concat_video):
        _concat_clips(processed_clips, concat_video, fps)
        state["concat_done"] = True
        _save_state(state_path, state)

    # Step 3: Replace audio with full voiceover
    if not os.path.exists(out_video):
        _merge_audio(concat_video, full_audio, out_video)

    # Step 4: Generate thumbnail
    if not os.path.exists(out_thumb):
        _generate_thumbnail(out_video, out_thumb, title, width, height)

    duration = _get_duration(out_video)

    return {
        "final_video_path": out_video,
        "thumbnail_path": out_thumb,
        "duration_seconds": duration,
        "width": width,
        "height": height,
    }


# ─── Segment processing ───────────────────────────────────────────────────────

def _process_segment_clip(footage_path, text, sfx, segment_type, duration,
                           width, height, fps, output_path, is_hook=False):
    """Crop + loop/trim footage to duration, then burn caption."""

    # Step A: Crop to 1080x1920 and trim/loop to exact duration
    cropped = output_path.replace(".mp4", "_cropped.mp4")
    _crop_and_loop(footage_path, cropped, width, height, fps, duration)

    # Step B: Burn dramatic caption overlay
    _burn_caption(cropped, output_path, text, sfx, segment_type, width, height, fps, duration)

    # Clean up intermediate
    if os.path.exists(cropped) and os.path.exists(output_path):
        os.remove(cropped)

    return output_path


def _crop_and_loop(source, output, width, height, fps, duration):
    """
    Scale to cover 1080x1920 (center crop), loop if source is shorter than duration.
    """
    src_duration = _get_duration(source)
    if src_duration <= 0:
        src_duration = duration

    # Crop filter: scale height to target maintaining aspect, then crop width
    vf = (
        f"scale=iw*{height}/ih:{height},"
        f"crop={width}:{height}:(iw-{width})/2:0,"
        f"fps={fps}"
    )

    if src_duration < duration:
        # Loop the video to fill duration
        cmd = [
            "ffmpeg", "-y",
            "-stream_loop", "-1",
            "-i", source,
            "-t", str(duration),
            "-vf", vf,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-an",  # no audio from footage
            "-movflags", "+faststart",
            output
        ]
    else:
        # Trim to duration
        cmd = [
            "ffmpeg", "-y",
            "-i", source,
            "-t", str(duration),
            "-vf", vf,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-an",
            "-movflags", "+faststart",
            output
        ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg crop/loop gagal: {result.stderr[-400:]}")


def _burn_caption(source, output, text, sfx, segment_type, width, height, fps, duration):
    """
    Add dramatic caption overlay using FFmpeg drawtext.
    Style varies by segment type for visual variety.
    """
    filters = []

    # Caption style based on segment type
    style = _get_caption_style(segment_type)

    # Wrap text for readability
    max_chars = 32
    wrapped = textwrap.fill(text, width=max_chars)
    safe_text = _escape_ffmpeg_text(wrapped)

    # Caption box position — bottom third of screen
    y_pos = f"h*0.72"

    filters.append(
        f"drawtext=text='{safe_text}'"
        f":fontsize={style['fontsize']}"
        f":fontcolor={style['color']}"
        f":bordercolor=black:borderw=4"
        f":x=(w-tw)/2:y={y_pos}"
        f":box=1:boxcolor={style['boxcolor']}:boxborderw=12"
        f":line_spacing=8"
    )

    # Hook gets extra emphasis line at top
    if segment_type == "hook":
        filters.append(
            f"drawtext=text='⚠️ FAKTA MENGEJUTKAN'"
            f":fontsize=28:fontcolor=yellow:bordercolor=black:borderw=3"
            f":x=(w-tw)/2:y=60"
            f":box=1:boxcolor=black@0.6:boxborderw=8"
        )

    # Apply SFX visual effects
    if sfx == "glitch":
        filters.append(_glitch_filter(duration))
    elif sfx == "zoom_in" or segment_type == "climax":
        filters.append(f"zoompan=z='min(zoom+0.002,1.15)':d={int(fps*duration)}:s={width}x{height}")

    vf = ",".join(filters)

    cmd = [
        "ffmpeg", "-y",
        "-i", source,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        # Fallback: copy source without overlay
        shutil.copy2(source, output)


def _get_caption_style(segment_type):
    styles = {
        "hook":        {"fontsize": 62, "color": "white",  "boxcolor": "black@0.7"},
        "buildup":     {"fontsize": 52, "color": "white",  "boxcolor": "black@0.6"},
        "climax":      {"fontsize": 58, "color": "yellow", "boxcolor": "black@0.75"},
        "cliffhanger": {"fontsize": 54, "color": "white",  "boxcolor": "black@0.65"},
    }
    return styles.get(segment_type, styles["buildup"])


def _glitch_filter(duration):
    """Simple RGB shift glitch effect using geq."""
    return (
        "geq=r='r(X,Y)':g='g(X+2,Y)':b='b(X-2,Y)'"
    )


def _escape_ffmpeg_text(text):
    """Escape special characters for FFmpeg drawtext."""
    return (
        text
        .replace("\\", "\\\\")
        .replace("'",  "'\\''")
        .replace(":",  "\\:")
        .replace(",",  "\\,")
        .replace("[",  "\\[")
        .replace("]",  "\\]")
        .replace("\n", "\\n")
    )


# ─── Placeholder clip (fallback) ──────────────────────────────────────────────

def _make_placeholder_clip(work_dir, idx, duration, width, height, fps):
    """Create a dark gradient clip when footage is unavailable."""
    out = os.path.join(work_dir, f"placeholder_{idx:02d}.mp4")
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi",
        "-i", f"color=c=0x0a0a1a:size={width}x{height}:rate={fps}:duration={duration}",
        "-c:v", "libx264", "-preset", "fast", "-crf", "28",
        "-an", out
    ]
    subprocess.run(cmd, capture_output=True)
    return out


# ─── Concatenate clips ────────────────────────────────────────────────────────

def _concat_clips(clip_paths, output, fps):
    """Concatenate video clips using FFmpeg concat demuxer."""
    list_path = output.replace(".mp4", "_list.txt")

    with open(list_path, "w") as f:
        for p in clip_paths:
            f.write(f"file '{p}'\n")

    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", list_path,
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-an",
        "-movflags", "+faststart",
        output
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg concat gagal: {result.stderr[-400:]}")

    os.remove(list_path)


# ─── Merge audio ──────────────────────────────────────────────────────────────

def _merge_audio(video_path, audio_path, output_path):
    """Replace video audio with full voiceover. Trim video to audio length."""
    audio_dur = _get_duration(audio_path)

    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-i", audio_path,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-t", str(audio_dur),     # trim video to exact audio length
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        "-movflags", "+faststart",
        output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg merge audio gagal: {result.stderr[-400:]}")


# ─── Thumbnail ────────────────────────────────────────────────────────────────

def _generate_thumbnail(video_path, thumb_path, title, width, height):
    """Extract frame at 1s and add dramatic title overlay."""
    frame_path = thumb_path.replace(".jpg", "_raw.jpg")

    try:
        subprocess.run([
            "ffmpeg", "-y", "-i", video_path,
            "-ss", "1", "-vframes", "1",
            "-s", f"{width}x{height}",
            frame_path
        ], capture_output=True, check=True)

        img = Image.open(frame_path).convert("RGB")
        draw = ImageDraw.Draw(img)

        # Dark overlay top 40%
        overlay = Image.new("RGBA", (width, int(height * 0.4)), (0, 0, 0, 180))
        img.paste(Image.fromarray(np.array(overlay)[:, :, :3]), (0, 0))

        # Title text
        wrapped = textwrap.fill(title[:60], width=20)
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 72)
            small_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 40)
        except Exception:
            font = ImageFont.load_default()
            small_font = font

        # Title
        draw.text((width // 2, int(height * 0.15)), wrapped, font=font,
                  fill="white", anchor="mm", align="center",
                  stroke_width=4, stroke_fill="black")

        # "FAKTA UNIK" badge
        draw.rectangle([(width // 2 - 120, int(height * 0.28)),
                         (width // 2 + 120, int(height * 0.33))],
                        fill=(220, 30, 30))
        draw.text((width // 2, int(height * 0.305)), "FAKTA UNIK",
                  font=small_font, fill="white", anchor="mm")

        img.save(thumb_path, "JPEG", quality=92)
        if os.path.exists(frame_path):
            os.remove(frame_path)

    except Exception:
        # Fallback: plain dark thumbnail
        img = Image.new("RGB", (width, height), (15, 15, 40))
        draw = ImageDraw.Draw(img)
        draw.text((width // 2, height // 2), title[:40] or "Fakta Unik",
                  fill="white", anchor="mm")
        img.save(thumb_path, "JPEG", quality=85)


# ─── Utils ────────────────────────────────────────────────────────────────────

def _get_duration(path):
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, check=True
        )
        return round(float(result.stdout.strip()), 2)
    except Exception:
        return 0.0


if __name__ == "__main__":
    main()
