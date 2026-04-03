#!/usr/bin/env python3
"""
Transcribe a video/audio file using OpenAI Whisper.
Usage: python whisper_transcribe.py <input_path> <output_json_path> [model_size]
Output: JSON { "text": "...", "segments": [...] }
"""

import sys
import json
import os


def transcribe(input_path: str, output_path: str, model_size: str = "base") -> dict:
    """Transcribe audio and return structured result."""
    try:
        import whisper
    except ImportError:
        print(json.dumps({"error": "whisper not installed: pip install openai-whisper"}))
        sys.exit(1)

    if not os.path.exists(input_path):
        print(json.dumps({"error": f"File tidak ditemukan: {input_path}"}))
        sys.exit(1)

    try:
        model = whisper.load_model(model_size)
        result = model.transcribe(input_path, language="id", fp16=False)

        output = {
            "text": result["text"].strip(),
            "language": result.get("language", "id"),
            "segments": [
                {
                    "id": seg["id"],
                    "start": round(seg["start"], 2),
                    "end": round(seg["end"], 2),
                    "text": seg["text"].strip(),
                }
                for seg in result.get("segments", [])
            ],
        }

        # Write to output JSON
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        # Print to stdout for Node.js to capture
        print(json.dumps({"success": True, "output_path": output_path, "text_length": len(output["text"])}))
        return output

    except Exception as e:
        error = {"error": str(e), "type": type(e).__name__}
        print(json.dumps(error))
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: whisper_transcribe.py <input> <output_json> [model_size]"}))
        sys.exit(1)

    inp = sys.argv[1]
    out = sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else "base"

    transcribe(inp, out, model)
