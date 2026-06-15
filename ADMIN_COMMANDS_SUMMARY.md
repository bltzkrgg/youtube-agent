# Admin Commands Summary

## Overview
Fitur admin commands telah ditambahkan ke Telegram bot untuk mengelola queue, memory, dan orphan state. Semua command dilindungi dengan security check (hanya chatId yang terdaftar yang bisa menggunakan).

## Commands Baru

### 1. `/status` - Detailed System Status
**Upgrade dari command existing**

Menampilkan:
- Mode operasi (DRY_RUN atau PRODUCTION)
- Total source_videos by status
- Total clips by status
- Total jobs by type/status (top 10)
- Total dead_letter
- Jumlah orphan jobs (jika ada)
- Last 3 failed/dead-letter jobs dengan error message

**Contoh output:**
```
📊 System Status

Mode: 🔵 DRY_RUN

Source Videos:
• processing: 5
• completed: 12
• failed: 2

Clips:
• pending: 3
• manual_review: 8
• pending_review: 5
• approved: 10
• rejected: 2

Jobs:
• source_ingest/pending: 2
• transcript/processing: 1
• clip_render/pending: 5
...

Dead Letter: 3

⚠️ Orphan Jobs: 7
Use /clear_orphans to remove.

Recent Failures:
• transcript: moov atom not found
• clip_render: File not found
```

---

### 2. `/queue` - Detailed Queue Stats
**Upgrade dari command existing**

Menampilkan:
- Jobs grouped by status
- Jobs grouped by type/status (top 15)
- Retry count summary (avg, max, total retried)
- Oldest pending job (type + age)
- Oldest processing job (type + age)
- Dead letter count

**Contoh output:**
```
📋 Queue Stats

By Status:
• pending: 15
• processing: 3
• failed: 2

By Type/Status:
• source_ingest/pending: 2
• transcript/pending: 3
• scene_detect/pending: 3
• clip_planner/pending: 2
• clip_render/pending: 5
...

Retry Stats:
• Avg retry: 0.45
• Max retry: 2
• Jobs retried: 5

Oldest Pending:
• Type: transcript
• Age: 2h 15m

Oldest Processing:
• Type: clip_render
• Age: 45m

Dead Letter: 3
```

---

### 3. `/clear_queue` - Clear All Jobs
**Command baru**

Menghapus semua jobs dengan status:
- `pending`
- `processing`
- `failed`

**TIDAK menghapus:**
- source_videos
- clips
- analytics
- memory

**Contoh output:**
```
✅ Queue dibersihkan!

🗑 23 job(s) dihapus dari queue.
```

---

### 4. `/clear_dead` - Clear Dead Letter Queue
**Command baru**

Menghapus semua entries di table `dead_letter`.

**Contoh output:**
```
✅ Dead letter queue dibersihkan!

🗑 5 dead letter job(s) dihapus.
```

---

### 5. `/clear_memory` - Clear Memory Patterns
**Command baru**

Menghapus semua entries di table `memory`.

**TIDAK menghapus:**
- analytics (tetap tersimpan untuk historical data)

**Contoh output:**
```
✅ Memory dibersihkan!

🗑 12 memory pattern(s) dihapus.
```

---

### 6. `/clear_orphans` - Remove Orphan Jobs
**Command baru**

Mencari dan menghapus orphan jobs. Orphan jobs adalah jobs yang:

1. **Invalid payload** - payload JSON tidak valid atau null
2. **Missing source_video_id** - transcript/scene_detect/clip_planner job tanpa source_video_id
3. **Source video not found** - source_video_id tidak ada di table source_videos
4. **Source ingest JSON missing** - transcript/scene_detect job dengan source_video_id valid tapi file `output/{source_video_id}/source_ingest.json` tidak ada
5. **Missing clip_id** - clip_render/telegram_clip job tanpa clip_id
6. **Clip not found** - clip_id tidak ada di table clips
7. **Clip already reviewed** - telegram_clip job untuk clip dengan status `pending_review`, `approved`, `rejected`, atau `uploaded` (tidak perlu dikirim ulang)

**Contoh output:**
```
🗑 Orphan Jobs Dihapus

Total ditemukan: 15
Total dihapus: 15

Breakdown by Reason:
• source_ingest_json_missing: 8
• clip_already_reviewed: 5
• clip_not_found: 2

Breakdown by Type:
• transcript: 4
• scene_detect: 4
• telegram_clip: 5
• clip_render: 2
```

---

### 7. `/reset_test` - Reset All Test State (DESTRUCTIVE)
**Command baru**

Mode destructive untuk testing lokal. Memerlukan konfirmasi dua langkah:

**Step 1:** User kirim `/reset_test`
**Step 2:** Bot balas dengan warning, user harus ketik `CONFIRM_RESET` dalam 1 menit

Setelah konfirmasi, akan menghapus:
- Semua jobs
- Semua dead_letter
- Semua source_videos
- Semua clips
- Semua analytics
- Semua memory
- Folder output/* (semua subfolder)
- Folder cache/* (semua file)

Kemudian recreate folder output/ dan cache/.

**Contoh output:**
```
⚠️ DESTRUCTIVE OPERATION

Ini akan menghapus:
• Semua jobs
• Semua dead_letter
• Semua source_videos
• Semua clips
• Semua analytics
• Semua memory
• Folder output/ dan cache/ (jika aman)

Ketik CONFIRM_RESET dalam 1 menit untuk melanjutkan.
Atau ketik /skip untuk membatalkan.
```

Setelah konfirmasi:
```
✅ Test State Reset Complete

Database Rows Deleted:
• Jobs: 45
• Dead Letter: 8
• Source Videos: 12
• Clips: 35
• Analytics: 20
• Memory: 15

Files/Folders Deleted:
• 12 folder(s) dari output/cache

System siap untuk test baru.
```

---

### 8. `/help` - Updated Help Text
**Upgrade dari command existing**

Menampilkan semua command termasuk yang baru.

---

## Security

Semua admin commands dilindungi dengan check:
```javascript
if (chatId !== config.telegram.chatId) return;
```

Hanya chat ID yang terdaftar di `.env` (`TELEGRAM_CHAT_ID`) yang bisa menggunakan command ini.

**TIDAK ada data sensitif yang di-expose:**
- API keys tidak ditampilkan
- Token tidak ditampilkan
- Hanya metadata dan stats yang ditampilkan

---

## Database Helpers Baru

File: `src/utils/db.js`

### `countRows(table)`
Menghitung jumlah rows di table tertentu.

### `clearJobs()`
Menghapus semua jobs dengan status pending/processing/failed. Return count.

### `clearDeadLetters()`
Menghapus semua dead_letter entries. Return count.

### `clearMemory()`
Menghapus semua memory patterns. Return count.

### `clearAllTestState()`
Menghapus semua data test (jobs, dead_letter, source_videos, clips, analytics, memory). Return counts object.

### `getDetailedJobStats()`
Return object dengan:
- `byTypeStatus` - jobs grouped by type and status
- `byStatus` - jobs grouped by status
- `retryStats` - avg_retry, max_retry, retried_count
- `oldestPending` - oldest pending job (type, created_at)
- `oldestProcessing` - oldest processing job (type, locked_at)

### `getDeadLetterSummary()`
Return object dengan:
- `total` - total dead letter count
- `byType` - dead letters grouped by type
- `recent` - last 5 dead letters (type, error, failed_at)

### `deleteJobsByIds(jobIds)`
Menghapus jobs berdasarkan array of job IDs. Return count deleted.

### `findOrphanJobs()`
Mencari orphan jobs. Return array of `{ job, reason }`.

Orphan detection logic:
1. Parse payload dengan `safeParseJson` (invalid payload = orphan)
2. Check transcript/scene_detect/clip_planner jobs:
   - Missing source_video_id
   - source_video not found in DB
   - source_ingest.json file not found
3. Check clip_render/telegram_clip jobs:
   - Missing clip_id
   - clip not found in DB
   - telegram_clip for already reviewed clips

---

## Markdown Safety

Semua Telegram messages menggunakan MarkdownV2 dengan:

### Helper functions:
- `_escape(text)` - Escape special MarkdownV2 characters
- `_code(text)` - Wrap text in inline code block
- `_stripMarkdownV2(text)` - Remove markdown formatting

### Fallback mechanism:
Jika MarkdownV2 parse error, otomatis fallback ke plain text:
```javascript
async function _sendMessage(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (err) {
    if (err.message.includes("can't parse entities")) {
      // Fallback to plain text
      const fallbackOptions = { ...options };
      delete fallbackOptions.parse_mode;
      return bot.sendMessage(chatId, _stripMarkdownV2(text), fallbackOptions);
    }
    throw err;
  }
}
```

---

## Files Changed

1. **src/utils/db.js**
   - Added admin helper functions (countRows, clearJobs, clearDeadLetters, clearMemory, clearAllTestState, getDetailedJobStats, getDeadLetterSummary, deleteJobsByIds, findOrphanJobs)
   - Exported new functions

2. **src/bot/telegram.js**
   - Added `/clear_queue` command handler
   - Added `/clear_dead` command handler
   - Added `/clear_memory` command handler
   - Added `/clear_orphans` command handler
   - Added `/reset_test` command handler with two-step confirmation
   - Added `CONFIRM_RESET` handler
   - Upgraded `/status` to show detailed system status
   - Upgraded `/queue` to show detailed queue stats
   - Updated `/help` to include new commands
   - Added confirmation state management for destructive operations
   - Added `_getAge()` helper for timestamp formatting

---

## Validation Results

### Syntax Check
```bash
node --check src/bot/telegram.js  # ✅ PASSED
node --check src/utils/db.js      # ✅ PASSED
```

### npm run validate
```
✅ Syntax OK: All files
✅ Config & Environment: All configured
✅ Database Schema: All tables exist
✅ Database Helpers: All helpers exist
✅ Queue System: pushJob() and popJob() work
✅ Schema Validation: All schemas valid
✅ Python Scripts: All scripts exist
⚠️  Production readiness warnings (expected)
```

### npm run dry-run
```
✅ DRY-RUN E2E TEST PASSED

Summary:
  - Source videos: 1
  - Clips created: 3
  - Permission gate: WORKING
  - Idempotency: WORKING
  - Pipeline flow: COMPLETE
```

---

## Usage dari Telegram

### Normal Operations
1. Kirim `/status` untuk melihat system status
2. Kirim `/queue` untuk melihat queue stats
3. Jika ada orphan jobs, kirim `/clear_orphans`
4. Jika queue stuck, kirim `/clear_queue`
5. Jika dead letter penuh, kirim `/clear_dead`

### Testing/Development
1. Kirim `/reset_test`
2. Bot akan minta konfirmasi
3. Ketik `CONFIRM_RESET` untuk melanjutkan
4. System akan reset semua data test

### Monitoring
- `/status` - Quick overview
- `/queue` - Detailed queue analysis
- Check orphan count di `/status` output
- Check recent failures di `/status` output

---

## Known Limitations

1. **Orphan detection tidak real-time**
   - `/clear_orphans` scan semua jobs di DB
   - Untuk DB besar (>10k jobs), bisa lambat
   - Solusi: Run `/clear_orphans` secara berkala, bukan setiap saat

2. **Tidak ada undo untuk `/reset_test`**
   - Setelah konfirmasi, data langsung dihapus
   - Tidak ada backup otomatis
   - Solusi: Hanya gunakan untuk testing, bukan production

3. **Markdown escape bisa gagal untuk text kompleks**
   - Fallback ke plain text jika MarkdownV2 gagal
   - Beberapa formatting bisa hilang
   - Solusi: Sudah ada fallback mechanism

4. **File deletion di `/reset_test` hanya untuk output/cache**
   - Tidak menghapus logs/
   - Tidak menghapus memory/
   - Solusi: Manual cleanup jika perlu

5. **Tidak ada progress indicator untuk long operations**
   - `/clear_orphans` bisa lambat untuk DB besar
   - User tidak tahu berapa lama akan selesai
   - Solusi: Kirim "Mencari orphan jobs..." message dulu

---

## Next Steps

1. ✅ Commit changes
2. ✅ Push to git
3. ⏳ Test commands di real Telegram environment (tidak bisa di dry-run)
4. ⏳ Monitor production usage
5. ⏳ Add metrics/analytics untuk admin operations (optional)

---

## Changelog

**Date:** 2026-05-22
**Version:** 2.0.0
**Author:** AI Assistant

**Added:**
- Admin commands untuk queue management
- Admin commands untuk memory management
- Admin commands untuk orphan cleanup
- Two-step confirmation untuk destructive operations
- Detailed system status dan queue stats
- Markdown safety dengan fallback mechanism
- Security check untuk semua admin commands

**Changed:**
- `/status` upgraded dengan detailed info
- `/queue` upgraded dengan detailed stats
- `/help` updated dengan new commands

**Fixed:**
- None (new feature)

**Security:**
- All admin commands protected dengan chatId check
- No sensitive data exposed
- Two-step confirmation untuk destructive operations
