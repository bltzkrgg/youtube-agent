# YouTube AI Clipper Agent

**AI-powered clipper** yang mengubah video YouTube panjang menjadi multiple viral Shorts clips (9:16) secara otomatis.

## 🚦 Production Readiness Status

**Current Status**: ⚠️ **STAGING-READY**

- ✅ All P0/P1 bugs fixed (10-step systematic review)
- ✅ Validation script available
- ✅ Permission gate implemented
- ✅ Idempotency implemented
- ⚠️ **E2E testing required** (blocking for production)
- ⚠️ **Copyright detection required** (blocking for production)

📊 **Full Report**: [PRODUCTION_READINESS_REPORT.md](./PRODUCTION_READINESS_REPORT.md)

## 🎯 Apa yang Dilakukan Sistem Ini?

1. **Input**: YouTube URL dari user
2. **Download**: Source video via yt-dlp
3. **Analyze**: Transkripsi (Whisper) + Scene detection
4. **AI Planning**: LLM mengidentifikasi 3-7 momen terbaik untuk dijadikan clips
5. **Render**: Cut, reframe ke 9:16, burn captions
6. **Review**: Kirim ke Telegram untuk approve/reject
7. **Learn**: Analytics + Memory untuk improve clip selection

---

## 📋 Pipeline

```
Manual Input (YouTube URL)
         ↓
┌────────────────┐
│ SourceIngest   │  yt-dlp download + metadata extraction
└────────┬───────┘
         ↓
    ┌────┴────┐
    │         │
┌───▼──────┐ ┌▼────────────┐
│Transcript│ │SceneDetect  │  Whisper + PySceneDetect (parallel)
└───┬──────┘ └┬────────────┘
    └────┬────┘
         ↓
┌────────────────┐
│ ClipPlanner    │  LLM analyzes transcript + scenes → identify viral moments
│                │  Output: 3-7 clip plans with start_sec, end_sec, score, hook_type
└────────┬───────┘
         ↓
┌────────────────┐
│ ClipRender     │  Per clip: cut source → reframe 9:16 → burn captions
│                │  Python + FFmpeg
└────────┬───────┘
         ↓
┌────────────────┐
│ Telegram       │  Review: ✅ Approve / ❌ Reject + reason
└────────┬───────┘
         ↓
┌────────────────┐
│ Analytics      │  Track performance (views, CTR, retention)
└────────┬───────┘
         ↓
┌────────────────┐
│ Memory         │  Learn: hook_type, duration, caption style → improve future clips
└────────────────┘
```

---

## 🚀 Setup

### Prerequisites

- **Node.js** v20+
- **Python** 3.11+
- **FFmpeg** (wajib ada di PATH)
- **yt-dlp** (install via pip atau package manager)
- Akun: [OpenRouter](https://openrouter.ai) · [Telegram BotFather](https://t.me/BotFather)

### 1. Clone & Install

```bash
git clone https://github.com/bltzkrgg/youtube-agent.git
cd youtube-agent

# Node dependencies
npm install

# Python virtual environment
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Konfigurasi `.env`

```bash
cp .env.example .env
nano .env   # atau editor favoritmu
```

#### Variabel Wajib

| Key | Keterangan | Daftar di |
|---|---|---|
| `OPENROUTER_API_KEY` | LLM untuk clip planning | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TELEGRAM_BOT_TOKEN` | Bot review clips | [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | ID chat tujuan | kirim pesan ke [@userinfobot](https://t.me/userinfobot) |

#### Model LLM (Opsional)

```env
# Clip planning butuh model yang bagus untuk analisis
CLIP_PLANNER_MODEL=anthropic/claude-3-5-sonnet

# Metadata generation (title/description) bisa pakai model murah
METADATA_MODEL=anthropic/claude-3-haiku
```

#### Whisper & Scene Detection

```env
# Whisper model size: tiny, base, small, medium, large
# 'base' = good balance antara speed & accuracy
WHISPER_MODEL=base

# Scene detection threshold (default 27.0)
# Lower = more sensitive (more scenes detected)
SCENE_DETECT_THRESHOLD=27.0
```

### 3. Validasi Setup

```bash
# Validate config, database, schemas, helpers
npm run validate

# Expected output: ✅ All checks passed
```

### 4. Jalankan

```bash
# Start the agent (scheduler mode)
node src/index.js

# Manual trigger untuk satu video
node src/trigger_clipper.js "https://www.youtube.com/watch?v=VIDEO_ID"

# DRY_RUN mode (mock data, no API calls)
npm run dry-run
```

---

## 📊 Output per Source Video

```
output/{source_video_id}/
├── source.mp4              # Downloaded source video
├── source_ingest.json      # Metadata (title, channel, duration)
├── transcript.json         # Full transcript with timestamps
├── scene_detect.json       # Scene boundaries
├── clip_planner.json       # Clip plans (3-7 clips)
└── clips/
    ├── {clip_id_1}/
    │   ├── final.mp4       # Rendered clip 1080x1920
    │   ├── thumbnail.jpg   # Thumbnail
    │   └── clip_config.json
    ├── {clip_id_2}/
    │   ├── final.mp4
    │   └── ...
    └── ...
```

---

## 🤖 Telegram Commands

| Command | Fungsi |
|---|---|
| `/trigger <youtube_url>` | Trigger clipper untuk URL tertentu |
| `/status` | Status semua clips (processing/approved/rejected) |
| `/approve_source <id>` | **NEW**: Approve source video untuk rendering |
| `/queue` | Jumlah job per type di queue |
| `/help` | Daftar perintah |

### Permission Gate Flow

**Default behavior**: Source videos require manual approval sebelum rendering.

1. Trigger clipper: `/trigger <youtube_url>`
2. System downloads & analyzes video (transcript + scenes)
3. System creates clip plans
4. **Bot sends notification**: "Source video requires approval"
5. User reviews source video
6. User approves: `/approve_source <source_video_id>`
7. System renders clips

**Why?** Sistem tidak melakukan copyright check otomatis. User bertanggung jawab memastikan source video boleh di-clip.

### Review Buttons

Saat clip selesai dirender, bot akan mengirim preview dengan tombol:

| Tombol | Aksi |
|---|---|
| ✅ **APPROVE** | Kirim file `.mp4` untuk upload manual |
| ❌ **REJECT** | Reject dengan alasan teks bebas |
| 🎨 **Visual Buruk** | Reject + penalti pada visual pattern |
| 😴 **Topik Garing** | Reject + penalti kuat pada hook type |

---

## 🧠 Memory & Learning System

Memory Agent belajar dari dua sumber:

### 1. Analytics (nightly)
- Weight dihitung dari: **views (40%)** + **engagement (35%)** + **retention (25%)**
- Track pattern: `hook_type`, `duration_range`, `caption_style`, `source_channel`

### 2. Rejection Feedback (near-realtime)

| Reject Button | Penalty | Efek |
|---|---|---|
| 🎨 Visual Buruk | `weight × 0.4` | Penalti pada reframe_strategy pattern |
| 😴 Topik Garing | `weight × 0.3` | Penalti kuat pada hook_type pattern |

Pattern dengan `weight < 0.2` tidak akan direkomendasikan oleh ClipPlanner.

---

## ⚙️ Advanced Configuration

### Whisper Model Selection

| Model | Speed | Accuracy | Use Case |
|---|---|---|---|
| `tiny` | Fastest | Low | Quick testing |
| `base` | Fast | Good | **Recommended default** |
| `small` | Medium | Better | High-quality content |
| `medium` | Slow | Great | Professional use |
| `large` | Very slow | Best | Maximum accuracy |

### Scene Detection Tuning

```env
# Default: 27.0
# Lower (15-25) = more scenes detected (good for fast-paced videos)
# Higher (30-40) = fewer scenes (good for slow, cinematic videos)
SCENE_DETECT_THRESHOLD=27.0
```

### Clip Planning Prompt Tuning

Edit `src/agents/clip_planner/index.js` → `_analyzeWithLLM()` untuk customize:
- Kriteria viral moment
- Hook types
- Risk assessment rules
- Scoring algorithm

---

## 🧪 Testing & Validation

### Validation
```bash
# Validate config, database, schemas
npm run validate

# Expected: 0 errors, warnings OK for missing API keys in DRY_RUN
```

### Dry-Run E2E Test
```bash
# Run full pipeline with mock data (no API calls, no downloads)
npm run dry-run

# Tests:
# - SourceIngest → Transcript → SceneDetect → ClipPlanner → ClipRender
# - Permission gate enforcement
# - Idempotency (source URL, clips, render)
# - Pipeline flow
```

### Real E2E Test (Required for Production)
```bash
# Prerequisites:
# 1. Set real API keys in .env
# 2. Use owned/licensed YouTube video
# 3. Approve source manually

# Start agent
npm start

# In another terminal, trigger clipper
node src/trigger_clipper.js "https://youtube.com/watch?v=YOUR_VIDEO_ID"

# Monitor logs
tail -f logs/app.log

# In Telegram, approve source
/approve_source <source_video_id>

# Wait for clips to render and review in Telegram
```

**⚠️ IMPORTANT**: System is **STAGING-READY**, not production-ready until:
1. Real E2E test completed with actual YouTube video
2. Copyright detection implemented OR clear legal disclaimer added
3. Test results documented

---

## 🔧 Troubleshooting

### yt-dlp not found

```bash
# macOS
brew install yt-dlp

# Linux
pip install yt-dlp

# Verify
yt-dlp --version
```

### FFmpeg not found

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Verify
ffmpeg -version
```

### Whisper model download slow

Model akan didownload otomatis saat pertama kali dipakai. Untuk pre-download:

```bash
python3 -c "import whisper; whisper.load_model('base')"
```

### Scene detection gagal

Pastikan OpenCV terinstall:

```bash
pip install scenedetect[opencv]
```

---

## 📈 Estimasi Biaya

| Komponen | Biaya |
|---|---|
| yt-dlp | Gratis |
| Whisper (local) | Gratis |
| Scene detection | Gratis |
| OpenRouter (ClipPlanner) | ~$0.01-0.05 per video (tergantung model) |
| FFmpeg | Gratis |

**Total per source video**: ~$0.01-0.05 (hanya LLM API)

---

## 🚨 Known Limitations

1. **Copyright**: Sistem ini **TIDAK** melakukan copyright check otomatis. User bertanggung jawab memastikan source video boleh di-clip. Permission gate (`/approve_source`) adalah manual review, bukan automated detection.
2. **E2E Testing**: Belum dilakukan testing dengan real YouTube videos. System tested dengan mock data only.
3. **Face tracking**: Belum diimplementasi. Reframe strategy `face_track` fallback ke `center`.
4. **Motion tracking**: Belum diimplementasi. Reframe strategy `action_follow` fallback ke `center`.
5. **Subtitle timing**: Caption burn-in masih sederhana (static text). Untuk word-by-word timing, perlu integrasi dengan subtitle file.
6. **Multi-speaker**: Whisper tidak membedakan speaker. Untuk podcast/interview, perlu diarization.

**⚠️ IMPORTANT**: System adalah **STAGING-READY**, bukan production-ready. E2E testing dan copyright solution required sebelum production deployment.

---

## 🔄 Migration dari UGC Generator

Jika Anda sudah punya database lama dari UGC generator:

```bash
# Backup database lama
cp data.db data.db.backup

# Database akan auto-migrate saat pertama kali dijalankan
node src/index.js
```

Legacy tables (`videos`, `analytics` lama) tetap ada untuk backward compatibility.

---

## 📝 Development

### Validation & Testing

```bash
# Validate config, database, schemas
npm run validate

# Dry-run with mock data (no API calls)
npm run dry-run

# Test config only
npm run test:config
```

### Run Tests (TODO)

```bash
npm test
```

### Enable Legacy Pipeline

Uncomment di `src/scheduler/cron.js`:

```javascript
// LEGACY PIPELINE (disabled by default, uncomment to enable)
{
  name: 'Research',
  cron: '0 0 * * *',
  agent: () => require('../agents/research').runResearchAgent(),
},
// ... dst
```

---

## 📄 License

MIT

---

## 🙏 Credits

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - Video download
- [OpenAI Whisper](https://github.com/openai/whisper) - Transcription
- [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) - Scene detection
- [FFmpeg](https://ffmpeg.org/) - Video processing
- [OpenRouter](https://openrouter.ai/) - LLM API routing

---

## 📞 Support

Issues: [GitHub Issues](https://github.com/bltzkrgg/youtube-agent/issues)
