# YouTube Shorts AI Agent

Autonomous pipeline untuk generate konten **Fakta Unik Indonesia** di YouTube Shorts — 1 video per hari, fully AI-generated, zero copyright risk.

## Pipeline

```
Research → Script → Metadata → Voiceover → Visual → Clip → Telegram (Review)
                                                                              ↓ Approve
                                                                    Video dikirim ke Telegram
                                                                              ↓
                                                                  Analytics (input CSV manual)
                                                                              ↓
                                                                    Memory (adaptive learning)
```

## Stack

| Komponen | Teknologi |
|---|---|
| Orchestrator & queue | Node.js v20 + SQLite |
| Video assembly | Python 3.11 + FFmpeg |
| LLM (research, script, metadata) | OpenRouter (Claude / Gemini) |
| Text-to-speech | edge-tts (Microsoft, gratis) |
| Stock footage | Pexels API (CC licensed) |
| Review & delivery | Telegram Bot |

## Estimasi Biaya Bulanan

| Skenario | Video/hari | Estimasi |
|---|---|---|
| Minimal | 1 | ~$0.30 |
| Target | 2 | ~$0.60 |
| Agresif | 3 | ~$0.90 |

> TTS gratis via edge-tts. Biaya hanya dari OpenRouter (LLM) dan Pexels (opsional jika melebihi quota gratis).

## Setup

### 1. Clone & install

```bash
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

| Key | Keterangan | Daftar di |
|---|---|---|
| `OPENROUTER_API_KEY` | LLM routing (research, script, metadata) | openrouter.ai |
| `PEXELS_API_KEY` | Stock footage | pexels.com/api |
| `TELEGRAM_BOT_TOKEN` | Bot review | @BotFather |
| `TELEGRAM_CHAT_ID` | Chat ID kamu | kirim pesan ke @userinfobot |

### 3. Jalankan

```bash
# DRY_RUN — tidak ada API call, pakai mock data
DRY_RUN=true node src/index.js

# Langsung trigger pipeline sekarang
DRY_RUN=true node src/index.js --run-now

# Production
node src/index.js
```

## Telegram Commands

| Command | Fungsi |
|---|---|
| `/trigger` | Mulai pipeline research sekarang |
| `/status` | Status semua video |
| `/queue` | Status job queue |
| `/help` | Daftar perintah |
| Kirim file `.csv` | Input analytics YouTube |

### Format CSV Analytics

Export dari YouTube Studio → Analytics → Export. Kolom yang diperlukan:

```
title, views, likes, comments, ctr, average percentage viewed (%)
```

## Jadwal Otomatis (UTC)

| Waktu | Agent |
|---|---|
| 00:00 | Research — cari topik trending (trigger harian) |
| Setiap 5 menit | Script, Metadata, Voiceover, Visual, Clip, Telegram — poll queue |
| 16:00 | Analytics — proses CSV dari queue |
| 16:30 | Memory — update learning weights |
| Minggu 03:00 | Cleanup — hapus video rejected >7 hari |

Pipeline sepenuhnya event-driven via queue. Agent poll setiap 5 menit dan langsung return jika tidak ada job — tidak ada race condition antar stage.

## Output per Video

```
output/{video_id}/
├── research.json       # Topik, keywords, trending reason
├── script.json         # Segmen narasi + visual keyword + SFX hint
├── metadata.json       # Judul, deskripsi, hashtag, affiliate keywords
├── affiliate.json      # Shopee links + formatted description
├── voiceover.json      # Path audio per segmen + durasi
├── visual.json         # Path footage per segmen
├── clip_config.json    # Config untuk Python clip agent
├── clip_state.json     # State resume jika render gagal
├── work/               # Intermediate clips (dibersihkan otomatis)
├── final.mp4           # Video final
├── thumbnail.jpg       # Thumbnail
└── clip.json           # Clip agent output metadata
```

## Memory System

Memory Agent belajar dari analytics YouTube:

- Setiap topik punya `weight` (0.1 – 10.0)
- Weight dihitung dari: views (40%) + engagement (35%) + retention (25%)
- **Weight decay**: topik tidak aktif >7 hari dikurangi 5% per cycle
- **Max 1000 records**: topik terendah dihapus otomatis
- Research Agent menggunakan top topics untuk bias topik baru

## Queue System

Jobs disimpan di SQLite:

| Field | Keterangan |
|---|---|
| `job_id` | UUID v4 |
| `correlation_id` | Trace ID per pipeline run |
| `type` | research, script, metadata, voiceover, visual, clip, telegram, analytics, memory |
| `status` | pending, processing, done, failed |
| `priority` | high=10, normal=5, low=1 |
| `retry_count` | Jumlah retry (max 3, configurable via `MAX_RETRY`) |
| `timeout_at` | Auto-fail jika melewati waktu ini |

Jobs melebihi `max_retry` dipindah ke tabel **dead_letter**.

## Deploy ke VPS

```bash
bash scripts/deploy.sh <server_ip> root
```

### Monitor di server

```bash
journalctl -u youtube-agent -f       # Live logs
systemctl status youtube-agent       # Status service
systemctl restart youtube-agent      # Restart
```
