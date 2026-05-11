# YouTube Shorts AI Agent

Autonomous pipeline untuk generate konten **Fakta Unik Indonesia** di YouTube Shorts — fully AI-generated, zero copyright risk.

## Pipeline

```
┌─────────────┐
│  Research   │  YouTube Data API v3 (trending ID + niche search)
│             │  → LLM analisis virality score (views/subscribers)
└──────┬──────┘
       │
┌──────▼──────┐
│   Script    │  Narasi Gen-Z curiosity-gap (Hook → Buildup → Climax → Cliffhanger)
│             │  → visual_prompts[] per segmen (maks 5 detik/klip) + SFX hints
└──────┬──────┘
       │ (parallel)
  ┌────┴────┐
  │         │
┌─▼──────┐ ┌▼────────┐
│Metadata│ │Voiceover│  edge-tts (id-ID-ArdiNeural, gratis)
└─┬──────┘ └┬────────┘
  └────┬────┘
       │
┌──────▼──────┐
│   Visual    │  Prompt Engineer LLM → cinematic 4K prompt
│             │  → KlingAI text-to-video (multi-klip per segmen)
└──────┬──────┘
       │
┌──────▼──────┐
│    Clip     │  Python + FFmpeg:
│             │  • Stitch footage_paths[] per segmen
│             │  • Audio mix: voiceover + SFX stems + BGM (12%)
│             │  • Output: 1080×1920, tanpa subtitle
└──────┬──────┘
       │
┌──────▼──────┐
│  Telegram   │  Review: ✅ Approve / ❌ Reject / 🎨 Visual Buruk / 😴 Topik Garing
│             │  → Reject terstruktur kirim feedback ke Memory Agent
└──────┬──────┘
       │ Approve
┌──────▼──────┐
│  Analytics  │  Input CSV dari YouTube Studio (manual upload ke bot)
└──────┬──────┘
       │
┌──────▼──────┐
│   Memory    │  Update weight topik dari analytics
│             │  + Penalti instan saat reject (near-realtime, poll 1 menit)
└─────────────┘
```

## Stack

| Komponen | Teknologi |
|---|---|
| Orchestrator & queue | Node.js v20 + SQLite |
| Video assembly | Python 3.11 + FFmpeg |
| Trend discovery | YouTube Data API v3 |
| LLM — research | `RESEARCH_MODEL` via OpenRouter |
| LLM — script | `SCRIPT_MODEL` via OpenRouter |
| LLM — metadata | `METADATA_MODEL` via OpenRouter |
| LLM — visual prompt engineer | `VISUAL_PROMPT_MODEL` via OpenRouter |
| Text-to-speech | edge-tts (Microsoft, gratis) |
| AI video generation | KlingAI text-to-video (multi-klip) |
| Audio mixing | FFmpeg amix (voiceover + SFX + BGM) |
| Review & delivery | Telegram Bot |
| Adaptive memory | SQLite weight system + rejection feedback |

## Estimasi Biaya Bulanan

| Skenario | Video/hari | Estimasi |
|---|---|---|
| Minimal | 1 | ~$1.50 |
| Target | 2 | ~$3.00 |
| Agresif | 3 | ~$4.50 |

> TTS gratis via edge-tts. Biaya utama: **OpenRouter** (4 LLM calls/video) + **KlingAI** (~5-15 klip/video) + **YouTube Data API** (gratis s.d. 10k units/hari).

---

## Setup

### Prasyarat

- Node.js v20+
- Python 3.11+
- FFmpeg (wajib ada di PATH)
- Akun: [OpenRouter](https://openrouter.ai) · [KlingAI](https://klingai.com) · [Google Cloud](https://console.cloud.google.com) · [Telegram BotFather](https://t.me/BotFather)

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
| `OPENROUTER_API_KEY` | LLM routing untuk semua agent | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `YOUTUBE_API_KEY` | YouTube Data API v3 untuk riset trending | [console.cloud.google.com](https://console.cloud.google.com) → Enable **YouTube Data API v3** |
| `KLING_ACCESS_KEY` | KlingAI video generation | [klingai.com](https://klingai.com) → Developer → API Keys |
| `KLING_SECRET_KEY` | KlingAI secret | sama seperti di atas |
| `TELEGRAM_BOT_TOKEN` | Bot review video | [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | ID chat tujuan | kirim pesan ke [@userinfobot](https://t.me/userinfobot) |

#### Model LLM Per-Agent (Opsional, default: `anthropic/claude-3-haiku`)

```env
# Tiap agent bisa pakai model berbeda untuk trade-off kualitas vs biaya
RESEARCH_MODEL=anthropic/claude-3-haiku        # riset & analisis virality
SCRIPT_MODEL=anthropic/claude-3-5-sonnet       # kreativitas narasi Gen-Z
METADATA_MODEL=anthropic/claude-3-haiku        # judul + hashtag
VISUAL_PROMPT_MODEL=google/gemini-flash-1.5    # enrichment prompt sinematik
```

> Lihat daftar model di [openrouter.ai/models](https://openrouter.ai/models). Model mahal hanya perlu di `SCRIPT_MODEL` — di sanalah kualitas narasi paling terasa.

#### Background Music (Opsional)

```env
# Path ke file mp3 yang akan di-mix 12% volume di bawah voiceover
BG_MUSIC_PATH=./assets/bg_music.mp3
```

### 3. Setup Google Cloud (YouTube API)

1. Buka [Google Cloud Console](https://console.cloud.google.com)
2. Buat project baru → **APIs & Services** → **Enable APIs**
3. Cari dan aktifkan **YouTube Data API v3**
4. **Credentials** → **Create Credentials** → **API Key**
5. Salin ke `YOUTUBE_API_KEY` di `.env`

> Kuota default: **10.000 units/hari** (gratis). Pipeline ini menggunakan ~100 units/hari — sangat aman.

### 4. Jalankan

```bash
# DRY_RUN — zero API call, semua pakai mock data
DRY_RUN=true node src/index.js

# DRY_RUN + trigger pipeline langsung sekarang
DRY_RUN=true node src/index.js --run-now

# Production (pastikan DRY_RUN=false atau tidak di-set di .env)
node src/index.js
```

---

## Telegram — Review & Commands

### Tombol Review Video

Saat video selesai dirender, bot akan mengirim preview dengan tombol:

| Tombol | Aksi |
|---|---|
| ✅ **APPROVE** | Kirim file `.mp4` ke Telegram untuk upload manual |
| ❌ **REJECT** | Reject dengan alasan teks bebas |
| 🎨 **Visual Buruk** | Reject + penalti sedang (`×0.4`) pada visual keyword di Memory |
| 😴 **Topik Garing** | Reject + penalti kuat (`×0.3`) pada topik di Memory |
| ✏️ **Edit Judul** | Ganti judul sebelum approve |

### Commands Bot

| Command | Fungsi |
|---|---|
| `/trigger` | Jalankan pipeline research sekarang |
| `/status` | Status semua video (processing/approved/rejected) |
| `/queue` | Jumlah job per type di queue |
| `/help` | Daftar perintah |
| Kirim file `.csv` | Input analytics dari YouTube Studio |

### Format CSV Analytics

Export dari **YouTube Studio → Analytics → Advanced Mode → Export**.

Kolom yang diperlukan:
```
title, views, likes, comments, ctr, average percentage viewed (%)
```

---

## Jadwal Otomatis (UTC)

| Waktu | Agent | Keterangan |
|---|---|---|
| `00:00` | Research | Ambil trending YouTube API + LLM pick topik harian |
| `*/5 min` | Script, Metadata, Voiceover, Visual, Clip, Telegram | Poll queue, langsung return jika kosong |
| `16:00` | Analytics | Proses CSV dari queue |
| `16:30` | Memory | Update weight topik dari analytics |
| `* * * * *` | MemoryPenalty | Terapkan penalti rejection instan (near-realtime) |
| `Sun 03:00` | Cleanup | Hapus video rejected >7 hari |

---

## Output per Video

```
output/{video_id}/
├── research.json       # Topik, keywords, trending_reason, virality score
├── script.json         # Segmen narasi + visual_prompts[] + sfx enum
├── metadata.json       # Judul, deskripsi, hashtag
├── voiceover.json      # Path audio per segmen + durasi
├── visual.json         # footage_paths[] per segmen (multi-klip)
├── clip_config.json    # Config lengkap untuk Python clip agent
├── clip_state.json     # State resume jika render gagal di tengah jalan
├── work/               # Intermediate clips (dibersihkan otomatis)
│   ├── seg_00_c0.mp4   # Klip individual per segmen per prompt
│   ├── seg_00_c1.mp4
│   └── ...
├── sfx/                # SFX stems per segmen (opsional)
├── final.mp4           # Video final 1080×1920, tanpa subtitle
├── thumbnail.jpg       # Frame 1s + vignette cinematic (FFmpeg only)
└── clip.json           # Output metadata clip agent
```

---

## Memory & Feedback System

Memory Agent belajar dari dua sumber:

### 1. Analytics (nightly)
- Weight dihitung dari: **views (40%)** + **engagement (35%)** + **retention (25%)**
- **Weight decay**: topik tidak aktif >7 hari dikurangi 5% per cycle
- **Max 1.000 records**: topik weight terendah dihapus otomatis

### 2. Rejection Feedback (near-realtime)

| Reject Button | Penalty | Efek |
|---|---|---|
| 🎨 Visual Buruk | `weight × 0.4` | Topik masih bisa muncul; visual keyword cluster juga dipenalti |
| 😴 Topik Garing | `weight × 0.3` | Topik hampir tidak muncul di rekomendasi Research |

- **Floor weight**: `0.1` — topik tidak pernah hilang permanen, bisa recover via analytics
- **`getTopTopics()`** — hanya return topik `weight > 0.2` (lolos threshold penalti)
- **`getAvoidTopics()`** — daftar topik terpenalti, bisa dipakai di Research prompt

---

## Queue System

Jobs disimpan di SQLite (`data.db`):

| Field | Keterangan |
|---|---|
| `job_id` | UUID v4 |
| `correlation_id` | Trace ID per pipeline run |
| `type` | `research` · `script` · `metadata` · `voiceover` · `visual` · `clip` · `telegram` · `analytics` · `memory` · `memory_penalty` |
| `status` | `pending` → `processing` → `done` / `failed` |
| `priority` | `high=10` · `normal=5` · `low=1` |
| `retry_count` | Max retry configurable via `MAX_RETRY` |
| `timeout_at` | Auto-fail jika melewati batas waktu |

Jobs melebihi `max_retry` dipindah ke tabel **dead_letter**.

---

## Deploy ke VPS

```bash
bash scripts/deploy.sh <server_ip> root
```

### Monitor di Server

```bash
journalctl -u youtube-agent -f       # Live logs
systemctl status youtube-agent       # Status service
systemctl restart youtube-agent      # Restart
```

### Update di Server

```bash
git pull origin main
npm install
systemctl restart youtube-agent
```
