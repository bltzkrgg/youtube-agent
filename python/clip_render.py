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

    os.makedirs(work_dir, exist_ok=True)

    duration = end_sec - start_sec

    # Step 1: Extract clip from source video
    extracted_clip = os.path.join(work_dir, "extracted.mp4")
    _extract_clip(source_video_path, start_sec, duration, extracted_clip)

    # Step 2: Reframe to 9:16
    reframed_clip = os.path.join(work_dir, "reframed.mp4")
    _reframe_clip(extracted_clip, reframed_clip, width, height, fps, reframe_strategy, reframe_details)

    # Step 3: Burn captions
    if captions_data and captions_data.get("srt_format"):
        # Use advanced SRT captions
        captioned_clip = os.path.join(work_dir, "captioned.mp4")
        srt_path = os.path.join(work_dir, "captions.srt")
        with open(srt_path, "w", encoding="utf-8") as f:
            f.write(captions_data["srt_format"])
        _burn_srt_captions(reframed_clip, captioned_clip, srt_path, captions_data.get("caption_style", {}))
        final_clip = captioned_clip
    elif caption_plan and caption_plan.lower() not in ["none", "no caption"]:
        # Fallback to simple caption
        captioned_clip = os.path.join(work_dir, "captioned.mp4")
        _burn_simple_caption(reframed_clip, captioned_clip, caption_plan, width, height)
        final_clip = captioned_clip
    else:
        final_clip = reframed_clip

    # Step 4: Copy to final output
    if final_clip != output_video:
        subprocess.run(["cp", final_clip, output_video], check=True)

    # Step 5: Generate thumbnail
    _generate_thumbnail(output_video, output_thumbnail, width, height)

    actual_duration = _get_duration(output_video)

    return {
        "final_video_path": output_video,
        "thumbnail_path": output_thumbnail,
        "duration_sec": actual_duration,
        "width": width,
        "height": height,
    }


# ─── Extract clip from source ────────────────────────────────────────────────

def _extract_clip(source_path, start_sec, duration, output_path):
    """Extract clip from source video using FFmpeg."""
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start_sec),
        "-i", source_path,
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg extract gagal: {result.stderr[-400:]}")


# ─── Reframe to 9:16 ──────────────────────────────────────────────────────────

def _reframe_clip(input_path, output_path, width, height, fps, strategy, reframe_details=None):
    """
    Reframe video to 9:16 aspect ratio.
    Strategies:
    - center: Simple center crop
    - face_track: Track faces (requires face detection, fallback to center)
    - action_follow: Follow motion (complex, fallback to center)
    - zoom_in: Progressive zoom for emphasis
    - split_screen: Multiple subjects (fallback to center)
    """
    
    if strategy == "center":
        vf = _center_crop_filter(width, height, fps)
    elif strategy == "zoom_in":
        vf = _zoom_in_filter(width, height, fps, reframe_details)
    elif strategy == "face_track":
        # TODO: Implement face tracking with OpenCV
        # For now, fallback to center
        vf = _center_crop_filter(width, height, fps)
    elif strategy == "action_follow":
        # TODO: Implement motion tracking
        # For now, fallback to center
        vf = _center_crop_filter(width, height, fps)
    elif strategy == "split_screen":
        # TODO: Implement split screen
        # For now, fallback to center
        vf = _center_crop_filter(width, height, fps)
    else:
        vf = _center_crop_filter(width, height, fps)

    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg reframe gagal: {result.stderr[-400:]}")


def _center_crop_filter(width, height, fps):
    """Scale to cover and center crop to target aspect ratio."""
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height}:(iw-{width})/2:(ih-{height})/2,"
        f"fps={fps}"
    )


def _zoom_in_filter(width, height, fps, reframe_details):
    """Progressive zoom in for dramatic effect."""
    # Start at 1.0x, end at 1.2x zoom over the clip duration
    zoom_end = 1.2
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"zoompan=z='min(zoom+0.0005,{zoom_end})':d=1:s={width}x{height}:fps={fps},"
        f"crop={width}:{height}:(iw-{width})/2:(ih-{height})/2"
    )


# ─── Burn SRT captions (advanced) ────────────────────────────────────────────

def _burn_srt_captions(input_path, output_path, srt_path, caption_style):
    """
    Burn SRT subtitles with advanced styling.
    Uses FFmpeg subtitles filter with ASS styling.
    """
    
    # Map caption_style to ASS style
    font_size = 48 if caption_style.get("font_size") == "large" else 40
    color = caption_style.get("color", "white")
    position = caption_style.get("position", "bottom")
    
    # Convert color name to hex
    color_map = {
        "white": "&HFFFFFF",
        "yellow": "&H00FFFF",
        "red": "&H0000FF",
    }
    primary_color = color_map.get(color, "&HFFFFFF")
    
    # Position: 2 = bottom (default), 8 = center
    alignment = 2 if position == "bottom" else 8
    
    vf = (
        f"subtitles={srt_path}:force_style='"
        f"FontName=Arial Bold,"
        f"FontSize={font_size},"
        f"PrimaryColour={primary_color},"
        f"OutlineColour=&H000000,"
        f"BorderStyle=1,"
        f"Outline=3,"
        f"Shadow=2,"
        f"Alignment={alignment},"
        f"MarginV=80"
        f"'"
    )
    
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        # Fallback: copy without subtitles if burn fails
        subprocess.run(["cp", input_path, output_path], check=True)


# ─── Burn simple caption ──────────────────────────────────────────────────────

def _burn_simple_caption(input_path, output_path, caption_text, width, height):
    """
    Burn a simple caption overlay at the bottom of the video.
    For more advanced subtitle timing, use separate subtitle file.
    """
    
    # Wrap text for readability
    max_chars = 32
    wrapped = textwrap.fill(caption_text[:150], width=max_chars)
    safe_text = _escape_ffmpeg_text(wrapped)

    # Caption position — bottom third
    y_pos = f"h*0.75"

    vf = (
        f"drawtext=text='{safe_text}'"
        f":fontsize=48"
        f":fontcolor=white"
        f":bordercolor=black:borderw=3"
        f":x=(w-tw)/2:y={y_pos}"
        f":box=1:boxcolor=black@0.6:boxborderw=10"
        f":line_spacing=6"
    )

    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        # Fallback: copy without caption if drawtext fails
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
