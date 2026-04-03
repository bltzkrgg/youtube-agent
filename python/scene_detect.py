#!/usr/bin/env python3
"""
Detect scene cuts in a video using PySceneDetect.
Usage: python scene_detect.py <input_path> <output_json_path> [threshold]
Output: JSON list of { start_sec, end_sec, duration_sec }
"""

import sys
import json
import os


def detect_scenes(input_path: str, output_path: str, threshold: float = 27.0) -> list:
    """Detect scene boundaries and return list of scene intervals."""
    try:
        from scenedetect import open_video, SceneManager
        from scenedetect.detectors import ContentDetector
    except ImportError:
        print(json.dumps({"error": "scenedetect not installed: pip install scenedetect[opencv]"}))
        sys.exit(1)

    if not os.path.exists(input_path):
        print(json.dumps({"error": f"File tidak ditemukan: {input_path}"}))
        sys.exit(1)

    try:
        video = open_video(input_path)
        scene_manager = SceneManager()
        scene_manager.add_detector(ContentDetector(threshold=threshold))
        scene_manager.detect_scenes(video, show_progress=False)

        scene_list = scene_manager.get_scene_list()

        scenes = [
            {
                "index": i,
                "start_sec": round(scene[0].get_seconds(), 2),
                "end_sec": round(scene[1].get_seconds(), 2),
                "duration_sec": round(scene[1].get_seconds() - scene[0].get_seconds(), 2),
            }
            for i, scene in enumerate(scene_list)
        ]

        # If no scenes detected, treat entire video as one scene
        if not scenes:
            import subprocess
            result = subprocess.run(
                ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
                 "-of", "csv=p=0", input_path],
                capture_output=True, text=True
            )
            duration = float(result.stdout.strip() or "0")
            scenes = [{"index": 0, "start_sec": 0.0, "end_sec": duration, "duration_sec": duration}]

        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(scenes, f, indent=2)

        print(json.dumps({"success": True, "scene_count": len(scenes), "output_path": output_path}))
        return scenes

    except Exception as e:
        error = {"error": str(e), "type": type(e).__name__}
        print(json.dumps(error))
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: scene_detect.py <input> <output_json> [threshold]"}))
        sys.exit(1)

    inp = sys.argv[1]
    out = sys.argv[2]
    thresh = float(sys.argv[3]) if len(sys.argv) > 3 else 27.0

    detect_scenes(inp, out, thresh)
