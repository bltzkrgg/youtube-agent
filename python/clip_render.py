#!/usr/bin/env python3
"""
Clip Render Agent — Cut source video and render to 9:16 Shorts format.
Input: config JSON with clip plan (start_sec, end_sec, caption_plan, reframe_strategy).
Output: final 1080x1920 MP4 + thumbnail.

Pipeline:
  1. Extract clip from source video (start_sec to end_sec)
  2. Reframe to 9:16 (1080x1920) based on strategy
  3. Burn captions/subtitles
  4. Generate thumbnail
"""

import sys
import json
import os
import subprocess
import textwrap
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
    import numpy as np
except ImportError:
    print(json.dumps({"error": "Pillow/numpy not installed: pip install Pillow numpy"}))
    sys.exit(1)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: clip_render.py <config_json>"}))
        sys.exit(1)

    config_path = sys.argv[1]

    if not os.path.exists(config_path):
        print(json.dumps({"error": f"Config tidak ditemukan: {config_path}"}))
        sys.exit(1)

    with open(config_path, encoding="utf-8") as f:
        cfg = json.load(f)

    try:
        result = process_clip(cfg)
        print(json.dumps({"success": True, **result}))
    except Exception as e:
        import traceback
        err = {"error": str(e), "traceback": traceback.format_exc()}
        print(json.dumps(err))
        sys.exit(1)


# ─── Main pipeline ────────────────────────────────────────────────────────────

def process_clip(cfg):
    source_video_path = cfg["source_video_path"]
    start_sec = float(cfg["start_sec"])
    end_sec = float(cfg["end_sec"])
    caption_plan = cfg.get("caption_plan", "")
    captions_data = cfg.get("captions", None)  # Advanced captions from CaptionAgent
    reframe_strategy = cfg.get("reframe_strategy", "center")
    reframe_details = cfg.get("reframe_details", None)
    width = int(cfg.get("width", 1080))
    height = int(cfg.get("height", 1920))
    fps = int(cfg.get("fps", 30))
    output_video = cfg["output_video"]
    output_thumbnail = cfg["output_thumbnail"]
    work_dir = cfg.get("work_dir", os.path.dirname(output_video))

    # Render quality settings — prefer values passed in cfg, fallback to env vars
    _VALID_PRESETS = {"ultrafast","superfast","veryfast","faster","fast","medium","slow","slower","veryslow"}

    _crf_raw = int(cfg.get("crf", os.environ.get("VIDEO_CRF", "20")))
    crf = _crf_raw if 15 <= _crf_raw <= 35 else 20

    _preset_raw = str(cfg.get("preset", os.environ.get("VIDEO_PRESET", "veryfast"))).lower()
    preset = _preset_raw if _preset_raw in _VALID_PRESETS else "veryfast"

    _abr = str(cfg.get("audio_bitrate", os.environ.get("VIDEO_AUDIO_BITRATE", "192k"))).lower()
    import re as _re
    audio_bitrate = _abr if _re.match(r"^\d+(k|m)$", _abr) else "192k"

    scale_flags = str(cfg.get("scale_flags", os.environ.get("VIDEO_SCALE_FLAGS", "lanczos")))
    caption_template = str(cfg.get("caption_template", "default")).lower()
    enable_face_crop = bool(cfg.get("enable_face_crop", False))

    os.makedirs(work_dir, exist_ok=True)

    duration = end_sec - start_sec

    # ffprobe log of source before processing (non-fatal)
    _log_ffprobe("source", source_video_path)

    # Step 1: Extract clip from source video
    extracted_clip = os.path.join(work_dir, "extracted.mp4")
    _extract_clip(source_video_path, start_sec, duration, extracted_clip, crf, preset, audio_bitrate)

    # Step 2: Reframe to 9:16
    reframed_clip = os.path.join(work_dir, "reframed.mp4")
    _reframe_clip(extracted_clip, reframed_clip, width, height, fps,
                  reframe_strategy, reframe_details, crf, preset, scale_flags,
                  enable_face_crop, source_video_path, start_sec, end_sec)

    # Step 3: Burn captions
    final_clip = _burn_captions(
        reframed_clip,
        work_dir,
        captions_data,
        caption_plan,
        width, height,
        crf, preset,
        caption_template,
    )

    # Step 4: Copy to final output
    if final_clip != output_video:
        subprocess.run(["cp", final_clip, output_video], check=True)

    # Step 5: Generate thumbnail
    _generate_thumbnail(output_video, output_thumbnail, width, height)

    actual_duration = _get_duration(output_video)

    # ffprobe log of final render (non-fatal) — reports actual video quality
    _log_ffprobe("final", output_video, render_settings={"crf": crf, "preset": preset, "audio_bitrate": audio_bitrate})

    return {
        "final_video_path": output_video,
        "thumbnail_path": output_thumbnail,
        "duration_sec": actual_duration,
        "width": width,
        "height": height,
    }


# ─── Extract clip from source ────────────────────────────────────────────────

def _extract_clip(source_path, start_sec, duration, output_path, crf=20, preset="veryfast", audio_bitrate="192k"):
    """Extract clip from source video using FFmpeg."""
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start_sec),
        "-i", source_path,
        "-t", str(duration),
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", audio_bitrate,
        "-movflags", "+faststart",
        output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg extract gagal: {result.stderr[-400:]}")


# ─── Reframe to 9:16 ──────────────────────────────────────────────────────────

def _reframe_clip(input_path, output_path, width, height, fps, strategy,
                  reframe_details=None, crf=20, preset="veryfast", scale_flags="lanczos",
                  enable_face_crop=False, source_video_path=None, start_sec=0, end_sec=0):
    """
    Reframe video to 9:16 aspect ratio.
    Strategies:
    - center: Simple center crop (+ optional face-aware offset if ENABLE_FACE_CROP)
    - face_track: Face-aware crop (falls back to center if no face found)
    - action_follow: Follow motion (fallback to center)
    - zoom_in: Progressive zoom for emphasis
    - split_screen: Multiple subjects (fallback to center)
    """
    # Determine crop X offset (center by default; face-aware if requested)
    face_cx = None  # normalized [0,1] horizontal center of face region

    use_face = enable_face_crop or strategy == "face_track"
    if use_face:
        # Gunakan input_path (klip pendek) yang frame-nya jauh lebih akurat untuk OpenCV
        clip_duration = end_sec - start_sec
        face_cx = _detect_face_cx(input_path, 0, clip_duration)

    if strategy == "zoom_in":
        vf = _zoom_in_filter(width, height, fps, reframe_details, scale_flags)
    else:
        # center, face_track, action_follow, split_screen — all use crop filter
        vf = _face_aware_crop_filter(width, height, fps, scale_flags, face_cx)

    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-aspect", f"{width}:{height}",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg reframe gagal: {result.stderr[-400:]}")


def _face_aware_crop_filter(width, height, fps, scale_flags="lanczos", face_cx=None):
    """
    Build crop filter. If face_cx (normalized [0,1]) is provided, shift the
    horizontal crop to keep faces visible. Falls back to center crop if None.
    """
    if face_cx is not None:
        # face_cx is in [0,1] relative to scaled frame.
        # After scale-to-cover, the frame is at least `width` wide.
        # We want the crop window to center on face_cx.
        # Use FFmpeg expression: clamp(face_x - W/2, 0, iw - W)
        # iw = scaled width after force_original_aspect_ratio=increase
        # We approximate with a relative expression.
        # Clamp so x offset doesn't go negative or exceed frame.
        crop_x = f"max(0,min(iw-{width},iw*{face_cx:.4f}-{width//2}))"
    else:
        crop_x = f"(iw-{width})/2"

    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase:flags={scale_flags},"
        f"crop={width}:{height}:{crop_x}:(ih-{height})/2,setsar=1,"
        f"fps={fps}"
    )


def _center_crop_filter(width, height, fps, scale_flags="lanczos"):
    """Scale to cover and center crop to target aspect ratio (legacy alias)."""
    return _face_aware_crop_filter(width, height, fps, scale_flags, face_cx=None)


# ─── Face detection (OpenCV, optional) ───────────────────────────────────────

def _detect_face_cx(video_path, start_sec, end_sec):
    try:
        import mediapipe as mp
        import cv2
    except ImportError:
        print(json.dumps({"face_crop": "mediapipe_not_available", "fallback": "center_crop"}), flush=True)
        return None

    try:
        mp_face = mp.solutions.face_detection
        duration = max(1.0, end_sec - start_sec)
        n_samples = min(8, max(1, int(duration / 2)))
        sample_ts = [start_sec + duration * i / (n_samples - 1 if n_samples > 1 else 1)
                     for i in range(n_samples)]

        all_cx = []
        cap = cv2.VideoCapture(video_path)

        with mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.4) as face_detection:
            for ts in sample_ts:
                cap.set(cv2.CAP_PROP_POS_MSEC, ts * 1000)
                ret, frame = cap.read()
                if not ret or frame is None:
                    continue

                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                results = face_detection.process(frame_rgb)

                if not results.detections:
                    continue

                # Cari wajah terbesar (pembicara utama)
                best_cx = None
                max_area = 0
                for detection in results.detections:
                    bbox = detection.location_data.relative_bounding_box
                    area = bbox.width * bbox.height
                    if area > max_area:
                        max_area = area
                        # Pusat wajah horizontal (x awal + setengah lebar)
                        best_cx = bbox.xmin + (bbox.width / 2)

                if best_cx is not None:
                    all_cx.append(best_cx)

        cap.release()

        if not all_cx:
            print(json.dumps({"face_crop": "no_face_detected", "sampled_frames": n_samples, "fallback": "center_crop"}), flush=True)
            return None

        avg_cx = sum(all_cx) / len(all_cx)
        print(json.dumps({
            "face_crop": "detected",
            "method": "mediapipe_face",
            "face_count_frames": len(all_cx),
            "avg_cx": round(avg_cx, 4),
            "sampled_frames": n_samples,
        }), flush=True)
        return avg_cx

    except Exception as e:
        print(json.dumps({"face_crop": "error", "error": str(e), "fallback": "center_crop"}), flush=True)
        return None


def _zoom_in_filter(width, height, fps, reframe_details, scale_flags="lanczos"):
    """Progressive zoom in for dramatic effect."""
    # Start at 1.0x, end at 1.2x zoom over the clip duration
    zoom_end = 1.2
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase:flags={scale_flags},"
        f"zoompan=z='min(zoom+0.0005,{zoom_end})':d=1:s={width}x{height}:fps={fps},"
        f"crop={width}:{height}:(iw-{width})/2:(ih-{height})/2,setsar=1"
    )


# ─── Caption template definitions ────────────────────────────────────────────

# Each template: font_size_ratio (relative to width), stroke, shadow, margin_v_ratio,
#                max_chars (per line), primary_color (ASS BGR+alpha), bold
_CAPTION_TEMPLATES = {
    "default": {
        "font_size_ratio": 0.048,   # ~52px at 1080px wide
        "outline":          3,
        "shadow":           1,
        "margin_v_ratio":   0.06,   # bottom margin = 6% of height
        "max_chars":        32,
        "primary_color":    "&H00FFFFFF",   # white
        "back_color":       "&H80000000",   # semi-transparent black box
        "bold":             0,
        "border_style":     3,       # 3 = opaque box
        "alignment":        2,       # bottom-center
    },
    "tiktok_bold": {
        "font_size_ratio": 0.058,   # ~63px at 1080px wide — large & punchy
        "outline":          4,
        "shadow":           2,
        "margin_v_ratio":   0.065,
        "max_chars":        28,
        "primary_color":    "&H00FFFFFF",   # white
        "back_color":       "&HA0000000",   # darker box
        "bold":             1,
        "border_style":     3,
        "alignment":        2,
    },
    "minimal": {
        "font_size_ratio": 0.036,   # ~39px at 1080px wide — small & subtle
        "outline":          1,
        "shadow":           0,
        "margin_v_ratio":   0.04,
        "max_chars":        40,
        "primary_color":    "&H00E0E0E0",   # light grey
        "back_color":       "&H60000000",
        "bold":             0,
        "border_style":     1,       # 1 = outline only (no box)
        "alignment":        2,
    },
}

def _get_template(name):
    return _CAPTION_TEMPLATES.get(name, _CAPTION_TEMPLATES["default"])


# ─── Unified caption entry point ─────────────────────────────────────────────

def _burn_captions(input_path, work_dir, captions_data, caption_plan,
                   width, height, crf, preset, caption_template):
    """
    Unified caption burn with template system and safe fallback chain:
      1. Advanced SRT from CaptionAgent  → write ASS with template style
      2. Plain caption_plan text (string) → drawtext fallback
      3. No caption                       → return input unchanged
    Never raises — any burn failure falls back to no-subtitle copy.
    """
    captioned_clip = os.path.join(work_dir, "captioned.mp4")
    tpl = _get_template(caption_template)

    # ── Path 1: Advanced SRT from CaptionAgent ──
    if captions_data and isinstance(captions_data, dict):
        srt_content = captions_data.get("srt_format", "")
        if srt_content and srt_content.strip():
            srt_path = os.path.join(work_dir, "captions.srt")
            try:
                with open(srt_path, "w", encoding="utf-8") as f:
                    f.write(srt_content)

                print(json.dumps({
                    "caption_log": "burn_srt",
                    "template": caption_template,
                    "srt_path": srt_path,
                }), flush=True)

                ok = _burn_ass_styled(input_path, captioned_clip, srt_path,
                                      tpl, width, height, crf, preset)
                if ok:
                    return captioned_clip
                # SRT burn failed — fall through to drawtext
                print(json.dumps({
                    "caption_log": "srt_burn_failed_fallback_drawtext",
                    "template": caption_template,
                }), flush=True)
            except Exception as e:
                print(json.dumps({
                    "caption_log": "srt_write_error",
                    "error": str(e),
                    "fallback": "drawtext",
                }), flush=True)

    # ── Path 2: Simple caption_plan string ──
    if caption_plan and str(caption_plan).lower() not in ("", "none", "no caption", "default caption"):
        print(json.dumps({
            "caption_log": "burn_drawtext",
            "template": caption_template,
        }), flush=True)
        ok = _burn_drawtext(input_path, captioned_clip, str(caption_plan),
                            tpl, width, height, crf, preset)
        if ok:
            return captioned_clip
        print(json.dumps({
            "caption_log": "drawtext_failed_no_subtitle",
        }), flush=True)

    # ── Path 3: No caption — return input as-is ──
    print(json.dumps({
        "caption_log": "no_caption",
        "fallback_reason": "no captions_data and no caption_plan",
    }), flush=True)
    return input_path


# ─── ASS-styled subtitle burn ─────────────────────────────────────────────────

def _build_ass_style(tpl, width, height):
    """Build an ASS [V4+ Styles] header from template settings."""
    font_size = max(12, int(width * tpl["font_size_ratio"]))
    margin_v  = max(20, int(height * tpl["margin_v_ratio"]))
    # Clamp margin so subtitles stay within safe area (bottom 8% reserved)
    max_margin = int(height * 0.08)
    margin_v   = min(margin_v, max_margin)

    return (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,Arial,{font_size},"
        f"{tpl['primary_color']},&H000000FF,&H00000000,{tpl['back_color']},"
        f"{tpl['bold']},0,0,0,"
        "100,100,0,0,"
        f"{tpl['border_style']},{tpl['outline']},{tpl['shadow']},"
        f"{tpl['alignment']},30,30,{margin_v},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )


def _srt_time_to_ass(srt_ts):
    """Convert SRT timestamp (00:00:00,000) to ASS format (0:00:00.00)."""
    try:
        srt_ts = srt_ts.strip().replace(",", ".")
        h, m, s = srt_ts.split(":")
        s_int, ms = s.split(".")
        cs = int(ms[:2])  # centiseconds
        return f"{int(h)}:{int(m):02d}:{int(s_int):02d}.{cs:02d}"
    except Exception:
        return "0:00:00.00"


def _srt_to_ass_events(srt_content, max_chars):
    """Parse SRT and emit ASS Dialogue lines, wrapping long lines."""
    lines = []
    blocks = srt_content.strip().split("\n\n")
    for block in blocks:
        rows = block.strip().split("\n")
        if len(rows) < 2:
            continue
        # Find timing line
        timing_line = next((r for r in rows if "-->" in r), None)
        if not timing_line:
            continue
        parts = timing_line.split("-->")
        if len(parts) < 2:
            continue
        start_ass = _srt_time_to_ass(parts[0].strip())
        end_ass   = _srt_time_to_ass(parts[1].strip())
        text_rows = [r for r in rows if r != timing_line and not r.strip().isdigit()]
        raw_text  = " ".join(text_rows).strip()
        if not raw_text:
            continue
        # Wrap to max_chars per line (use ASS \N line break)
        wrapped = textwrap.fill(raw_text, width=max_chars)
        ass_text = wrapped.replace("\n", "\\N")
        lines.append(
            f"Dialogue: 0,{start_ass},{end_ass},Default,,0,0,0,,{ass_text}"
        )
    return "\n".join(lines)


def _build_ass_file(srt_content, tpl, width, height):
    """Build a complete .ass file string from SRT content and template."""
    header = _build_ass_style(tpl, width, height)
    events = _srt_to_ass_events(srt_content, tpl["max_chars"])
    return header + events + "\n"


def _burn_ass_styled(input_path, output_path, srt_path, tpl, width, height, crf, preset):
    """Burn subtitles from SRT using ASS template. Returns True on success."""
    try:
        with open(srt_path, encoding="utf-8") as f:
            srt_content = f.read()

        if not srt_content.strip():
            return False

        ass_path = srt_path.replace(".srt", ".ass")
        ass_content = _build_ass_file(srt_content, tpl, width, height)
        with open(ass_path, "w", encoding="utf-8") as f:
            f.write(ass_content)

        vf = f"ass={ass_path},setsar=1"
        cmd = [
            "ffmpeg", "-y",
            "-i", input_path,
            "-vf", vf,
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-pix_fmt", "yuv420p",
            "-aspect", f"{width}:{height}",
            "-c:a", "copy",
            "-movflags", "+faststart",
            output_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return True
        # ASS burn failed — try raw SRT fallback
        vf_srt = (
            f"subtitles={srt_path}:force_style='"
            f"FontName=Arial,"
            f"FontSize={max(12, int(width * tpl['font_size_ratio']))},"
            f"PrimaryColour={tpl['primary_color']},"
            f"OutlineColour=&H00000000,"
            f"BorderStyle={tpl['border_style']},"
            f"Outline={tpl['outline']},"
            f"Shadow={tpl['shadow']},"
            f"Alignment={tpl['alignment']},"
            f"MarginV={max(20, int(height * tpl['margin_v_ratio']))}"
            f"',setsar=1"
        )
        cmd2 = [
            "ffmpeg", "-y",
            "-i", input_path,
            "-vf", vf_srt,
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-pix_fmt", "yuv420p",
            "-aspect", f"{width}:{height}",
            "-c:a", "copy",
            "-movflags", "+faststart",
            output_path,
        ]
        result2 = subprocess.run(cmd2, capture_output=True, text=True)
        return result2.returncode == 0
    except Exception:
        return False


# ─── Drawtext fallback (no SRT, plain caption_plan string) ───────────────────

def _burn_drawtext(input_path, output_path, caption_text, tpl, width, height, crf, preset):
    """Burn plain text using drawtext. Returns True on success."""
    try:
        font_size  = max(12, int(width * tpl["font_size_ratio"]))
        margin_v   = max(20, min(int(height * tpl["margin_v_ratio"]), int(height * 0.08)))
        # y position: height - margin - estimated text block height
        y_pos = f"h-{margin_v + font_size * 2}"

        wrapped    = textwrap.fill(caption_text[:200], width=tpl["max_chars"])
        safe_text  = _escape_ffmpeg_text(wrapped)

        vf = (
            f"drawtext=text='{safe_text}'"
            f":fontsize={font_size}"
            f":fontcolor=white"
            f":bordercolor=black:borderw={tpl['outline']}"
            f":x=(w-tw)/2:y={y_pos}"
            f":box=1:boxcolor=black@0.6:boxborderw=8"
            f":line_spacing=4,"
            f"setsar=1"
        )

        cmd = [
            "ffmpeg", "-y",
            "-i", input_path,
            "-vf", vf,
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-pix_fmt", "yuv420p",
            "-aspect", f"{width}:{height}",
            "-c:a", "copy",
            "-movflags", "+faststart",
            output_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode == 0
    except Exception:
        return False


# ─── Keep old helpers for backward compat (unused internally) ─────────────────

def _burn_srt_captions(input_path, output_path, srt_path, caption_style, crf=20, preset="veryfast"):
    """Legacy wrapper — delegates to template system."""
    tpl = _get_template("default")
    ok = _burn_ass_styled(input_path, output_path, srt_path, tpl, 1080, 1920, crf, preset)
    if not ok:
        subprocess.run(["cp", input_path, output_path], check=True)


def _burn_simple_caption(input_path, output_path, caption_text, width, height, crf=20, preset="veryfast"):
    """Legacy wrapper — delegates to template system."""
    tpl = _get_template("default")
    ok = _burn_drawtext(input_path, output_path, caption_text, tpl, width, height, crf, preset)
    if not ok:
        subprocess.run(["cp", input_path, output_path], check=True)


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


# ─── Thumbnail ────────────────────────────────────────────────────────────────

def _generate_thumbnail(video_path, thumb_path, width, height):
    """Extract frame at 1s and add overlay."""
    frame_path = thumb_path.replace(".jpg", "_raw.jpg")

    try:
        # Extract frame at 1 second
        subprocess.run([
            "ffmpeg", "-y", "-i", video_path,
            "-ss", "1", "-vframes", "1",
            "-s", f"{width}x{height}",
            frame_path
        ], capture_output=True, check=True)

        img = Image.open(frame_path).convert("RGB")
        draw = ImageDraw.Draw(img)

        # Add dark vignette overlay
        overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        overlay_draw = ImageDraw.Draw(overlay)
        
        # Top gradient
        for i in range(int(height * 0.3)):
            alpha = int(150 * (1 - i / (height * 0.3)))
            overlay_draw.rectangle([(0, i), (width, i+1)], fill=(0, 0, 0, alpha))

        img.paste(Image.fromarray(np.array(overlay)[:, :, :3]), (0, 0))

        # Add play button icon (simple triangle)
        center_x, center_y = width // 2, height // 2
        triangle = [
            (center_x - 40, center_y - 60),
            (center_x - 40, center_y + 60),
            (center_x + 60, center_y)
        ]
        draw.polygon(triangle, fill=(255, 255, 255, 200))

        img.save(thumb_path, "JPEG", quality=90)
        
        if os.path.exists(frame_path):
            os.remove(frame_path)

    except Exception as e:
        # Fallback: create simple dark thumbnail
        img = Image.new("RGB", (width, height), (20, 20, 40))
        draw = ImageDraw.Draw(img)
        draw.text((width // 2, height // 2), "CLIP", fill="white", anchor="mm")
        img.save(thumb_path, "JPEG", quality=85)


# ─── Utils ────────────────────────────────────────────────────────────────────

def _log_ffprobe(label, path, render_settings=None):
    """Log ffprobe info (width, height, duration, bitrate). Non-fatal."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-show_entries", "stream=width,height:format=duration,bit_rate,size",
                "-of", "json", path,
            ],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            streams = data.get("streams", [{}])
            fmt = data.get("format", {})
            video_stream = next((s for s in streams if s.get("width")), streams[0] if streams else {})
            w = video_stream.get("width", "?")
            h = video_stream.get("height", "?")
            dur = round(float(fmt.get("duration", 0)), 2)
            br_kbps = round(int(fmt.get("bit_rate", 0)) / 1000)
            size_mb = round(int(fmt.get("size", 0)) / 1024 / 1024, 2)
            entry = {
                "ffprobe": label,
                "path": str(path),
                "width": w, "height": h,
                "duration_sec": dur,
                "bitrate_kbps": br_kbps,
                "size_mb": size_mb,
            }
            if render_settings:
                entry["render_settings"] = render_settings
            print(json.dumps(entry), flush=True)
    except Exception as e:
        # Non-fatal — never block the pipeline
        print(json.dumps({"ffprobe_warn": f"ffprobe {label} failed: {str(e)}"}), flush=True)


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
