#!/usr/bin/env python3
"""
Edge TTS wrapper — generate MP3 audio dari text menggunakan Microsoft Edge TTS.
Usage: python3 tts.py <text> <output_path> [voice] [rate]
"""

import asyncio
import sys
import json

try:
    import edge_tts
except ImportError:
    print(json.dumps({"error": "edge-tts not installed: pip install edge-tts"}))
    sys.exit(1)


async def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: tts.py <text> <output_path> [voice] [rate]"}))
        sys.exit(1)

    text = sys.argv[1]
    output_path = sys.argv[2]
    voice = sys.argv[3] if len(sys.argv) > 3 else 'id-ID-ArdiNeural'
    rate = sys.argv[4] if len(sys.argv) > 4 else '+0%'

    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(output_path)
    print(json.dumps({"success": True, "output": output_path}))


asyncio.run(main())
