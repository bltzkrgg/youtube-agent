# YouTube Shorts AI Agent

Autonomous pipeline untuk generate konten **Fakta Unik Indonesia** di YouTube Shorts — 2–3 video per hari.

## Arsitektur

```
Research → Metadata → Affiliate → Clip → Telegram (Review) → Drive Upload
                                                ↓
                                   Analytics (input manual CSV)
                                                ↓
                                            Memory (learning)
```

## Stack

- **Node.js v20** — Orchestrator, queue, bot
- **Python 3.11** — Whisper, PySceneDetect, FFmpeg assembly
- **SQLite** — Queue, videos, analytics, memory
- **OpenRouter** — AI untuk research & metadata (Claude/Gemini)
- **yt-dlp** — Download footage dari YouTube
- **Google Drive API** — Upload video final
- **Telegram Bot** — Review & approval system

## Setup

### 1. Clone & install

```bash
cd youtube-agent
npm install

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Konfigurasi `.env`

```bash
cp .env.example .env
nano .env
```

Isi semua nilai berikut:

| Key | Keterangan |
|---|---|
| `OPENROUTER_API_KEY` | Dari openrouter.ai |
| `TELEGRAM_BOT_TOKEN` | Dari @BotFather |
| `TELEGRAM_CHAT_ID` | Chat ID kamu (kirim pesan ke @userinfobot) |
| `GOOGLE_CLIENT_ID` | Dari Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Dari Google Cloud Console |
| `GOOGLE_DRIVE_FOLDER_ID` | ID folder Drive tujuan upload |

### 3. Google Drive auth (sekali saja)

```bash
node scripts/auth-drive.js
```

Ikuti instruksi — buka URL, copy code, paste ke terminal. File `token.json` akan dibuat otomatis.

### 4. Jalankan (development)

```bash
# DRY_RUN mode (default) — tidak ada API call nyata
DRY_RUN=true node src/index.js

# Langsung trigger pipeline sekarang
DRY_RUN=true node src/index.js --run-now

# Production
DRY_RUN=false node src/index.js
```

## Telegram Commands

| Command | Fungsi |
|---|---|
| `/help` | Daftar perintah |
| `/status` | Status semua video |
| `/queue` | Status job queue |
| `/trigger` | Mulai pipeline research sekarang |
| `/addshopee` | Tambah Shopee affiliate link |
| `/listshopee` | Lihat semua Shopee links |
| Kirim file `.csv` | Input analytics YouTube |

### Format CSV Analytics

Export dari YouTube Studio → Analytics → Export. Kolom yang diperlukan:

```
title, views, likes, comments, ctr, average percentage viewed (%)
```

## Jadwal Otomatis (UTC)

| Waktu | Agent |
|---|---|
| 00:00 | Research (cari topik trending) |
| 00:30 | Metadata (judul, deskripsi, hashtag) |
| 01:00 | Affiliate (match Shopee links) |
| 01:30 | Clip (render video) |
| 02:30 | Telegram (kirim untuk review) |
| 16:00 | Analytics (proses CSV dari queue) |
| 16:30 | Memory (update learning weights) |
| Minggu 03:00 | Cleanup (hapus video rejected >7 hari) |

## Output per Video

```
output/{video_id}/
├── raw/source.mp4         # Footage original dari yt-dlp
├── research.json          # Topik, keywords, source info
├── metadata.json          # Judul, deskripsi, hashtag
├── affiliate.json         # Shopee links + formatted description
├── transcript.json        # Whisper transcript
├── scenes.json            # Scene detection result
├── clip_config.json       # Config untuk Python clip agent
├── clip_state.json        # State untuk resume jika gagal
├── step1_cropped.mp4      # Intermediate: cropped + sped up
├── step2_overlay.mp4      # Intermediate: dengan overlay
├── final.mp4              # Video final siap upload
├── thumbnail.jpg          # Thumbnail
├── clip.json              # Clip agent output
└── upload.json            # Drive URL + file ID
```

## Deploy ke Hetzner CX33

```bash
# Pastikan .env sudah diisi dan token.json sudah ada
bash scripts/deploy.sh <server_ip> root
```

### Monitor di server

```bash
journalctl -u youtube-agent -f    # Live logs
systemctl status youtube-agent    # Status service
systemctl restart youtube-agent   # Restart
```

## Queue System

Jobs disimpan di SQLite dengan field:
- `job_id` — UUID v4
- `correlation_id` — Trace ID per pipeline run
- `type` — research | metadata | affiliate | clip | telegram | upload | analytics | memory
- `status` — pending | processing | done | failed
- `priority` — high=10, normal=5, low=1
- `retry_count` — Jumlah retry
- `max_retry` — Default 3 (configurable via `MAX_RETRY`)
- `timeout_at` — Auto-fail jika melewati waktu ini

Jobs yang melebihi `max_retry` dipindah ke **dead_letter** table.

## Memory System

Memory Agent belajar dari analytics YouTube:
- Setiap topik punya `weight` (0.1 – 10.0)
- Weight dihitung dari: views (40%) + engagement (35%) + retention (25%)
- **Weight decay**: topik tidak aktif >7 hari dikurangi 5% per cycle
- **Max 1000 records**: topik terendah dihapus otomatis
- Research Agent menggunakan top topics untuk prioritas konten baru

## API Keys yang Dibutuhkan

| Service | Daftar di | Biaya |
|---|---|---|
| OpenRouter | openrouter.ai | Pay-per-use (~$0.001/req) |
| Telegram Bot | @BotFather | Gratis |
| Google Cloud (Drive API) | console.cloud.google.com | Gratis (15GB) |
| yt-dlp | Built-in | Gratis |
| FFmpeg | `apt install ffmpeg` | Gratis |
