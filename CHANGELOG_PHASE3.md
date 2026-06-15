# CHANGELOG - PHASE 3: Memory & Analytics

**Tanggal**: 2024
**Branch**: `feature/clipper-pivot`

---

## 🎯 Tujuan Phase 3

Mengubah Memory & Analytics system dari video-centric menjadi clip-centric dengan pattern learning untuk improve clip selection.

---

## 📝 Perubahan

### 1. MemoryAgent - Complete Rewrite

**File**: `src/agents/memory/index.js`

#### Perubahan Utama:
- **Pattern-based learning** menggantikan topic-based memory
- Track 4 pattern types:
  - `hook_type`: jenis hook yang digunakan (curiosity_gap, shock_value, tutorial, story, etc.)
  - `duration_range`: durasi clip (15-30s, 30-45s, 45-60s, 60s+)
  - `caption_style`: gaya caption (minimal, moderate, heavy)
  - `source_channel`: channel asal source video
  
#### Fitur Baru:
- **Weight calculation** dari analytics:
  - Views (40%)
  - Engagement (35%) = (likes + comments) / views
  - Retention (25%) = avg_view_pct
- **Rejection penalty** (near-realtime):
  - Visual Buruk: `weight × 0.4`
  - Topik Garing: `weight × 0.3`
  - Floor weight: `0.1` (pattern tidak pernah hilang permanen)
- **Weight decay**: pattern tidak aktif >7 hari dikurangi 5% per cycle
- **Auto-cleanup**: max 1000 records, hapus pattern weight terendah

#### API Methods:
```javascript
getTopPatterns(patternType, limit)    // Get best performing patterns
getAvoidPatterns(patternType)         // Get penalized patterns (weight < 0.2)
updateFromAnalytics()                 // Nightly update dari analytics
applyRejectionPenalty(clipId, reason) // Instant penalty saat reject
```

#### Database Schema:
```sql
CREATE TABLE memory (
  id              TEXT PRIMARY KEY,
  pattern_type    TEXT NOT NULL,
  pattern_value   TEXT NOT NULL,
  weight          REAL NOT NULL DEFAULT 1.0,
  views_avg       REAL NOT NULL DEFAULT 0,
  engagement      REAL NOT NULL DEFAULT 0,
  clip_count      INTEGER NOT NULL DEFAULT 0,
  last_updated    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(pattern_type, pattern_value)
);
```

---

### 2. Database Schema Updates

**File**: `src/utils/db.js`

#### Analytics Table:
```sql
-- BEFORE (Phase 1-2)
CREATE TABLE analytics (
  id              TEXT PRIMARY KEY,
  video_id        TEXT,  -- legacy field
  ...
);

-- AFTER (Phase 3)
CREATE TABLE analytics (
  id              TEXT PRIMARY KEY,
  clip_id         TEXT,  -- now tracks clips
  ...
  FOREIGN KEY (clip_id) REFERENCES clips(id)
);
```

#### Memory Table:
```sql
-- NEW in Phase 3
CREATE TABLE memory (
  id              TEXT PRIMARY KEY,
  pattern_type    TEXT NOT NULL,
  pattern_value   TEXT NOT NULL,
  weight          REAL NOT NULL DEFAULT 1.0,
  views_avg       REAL NOT NULL DEFAULT 0,
  engagement      REAL NOT NULL DEFAULT 0,
  clip_count      INTEGER NOT NULL DEFAULT 0,
  last_updated    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(pattern_type, pattern_value)
);
```

---

### 3. Scheduler Updates

**File**: `src/scheduler/cron.js`

#### Jadwal Baru:
```javascript
// Memory update (nightly)
{
  name: 'Memory',
  cron: '30 16 * * *',  // 16:30 UTC daily
  agent: () => require('../agents/memory').runMemoryAgent(),
}

// Rejection penalty (near-realtime)
{
  name: 'MemoryPenalty',
  cron: '* * * * *',  // Every minute
  agent: () => require('../agents/memory').runMemoryPenaltyAgent(),
}
```

---

### 4. ClipPlannerAgent Integration

**File**: `src/agents/clip_planner/index.js`

#### Memory Integration:
```javascript
// Get top performing patterns untuk inform LLM
const topHooks = memoryAgent.getTopPatterns('hook_type', 5);
const topDurations = memoryAgent.getTopPatterns('duration_range', 3);
const avoidHooks = memoryAgent.getAvoidPatterns('hook_type');

// Include in LLM prompt untuk improve clip selection
```

---

### 5. TelegramAgent Integration

**File**: `src/bot/telegram.js`

#### Rejection Handling:
```javascript
// Saat user reject clip dengan reason
bot.on('callback_query', async (query) => {
  if (query.data.startsWith('reject_visual_')) {
    // Apply instant penalty
    await memoryAgent.applyRejectionPenalty(clipId, 'visual_bad');
  }
  if (query.data.startsWith('reject_boring_')) {
    await memoryAgent.applyRejectionPenalty(clipId, 'topic_boring');
  }
});
```

---

## 🔄 Migration Notes

### Backward Compatibility:
- Legacy `videos` table tetap ada (tidak dihapus)
- Legacy `analytics.video_id` field tetap ada (nullable)
- Sistem bisa berjalan dengan database lama tanpa data loss

### Auto-Migration:
- Database schema auto-migrate saat pertama kali dijalankan
- Tidak perlu manual migration script

---

## 📊 Impact

### Before Phase 3:
- Memory system tidak ada (atau topic-based untuk UGC generator)
- Tidak ada learning dari rejection
- Tidak ada pattern tracking
- ClipPlanner tidak informed by past performance

### After Phase 3:
- Pattern-based learning dari analytics
- Instant feedback dari rejection
- ClipPlanner informed by top performing patterns
- System improve over time

---

## 🧪 Testing

### Manual Test:
```bash
# 1. Trigger clipper untuk beberapa source videos
node src/trigger_clipper.js "https://youtube.com/watch?v=VIDEO1"
node src/trigger_clipper.js "https://youtube.com/watch?v=VIDEO2"

# 2. Review clips di Telegram, reject beberapa dengan reason
# 3. Check memory table
sqlite3 data.db "SELECT * FROM memory ORDER BY weight DESC;"

# 4. Upload analytics CSV via Telegram
# 5. Wait for Memory cron (16:30 UTC) atau trigger manual
node -e "require('./src/agents/memory').runMemoryAgent()"

# 6. Check updated weights
sqlite3 data.db "SELECT * FROM memory ORDER BY weight DESC;"
```

---

## 🐛 Known Issues

1. **Analytics matching**: Jika clip title tidak match dengan CSV, analytics tidak ter-link
2. **Pattern explosion**: Jika terlalu banyak unique pattern values, memory table bisa membesar
3. **Weight decay**: Pattern yang jarang muncul tapi perform bagus bisa ter-decay

---

## 📈 Future Improvements

1. **Fuzzy matching** untuk analytics title matching
2. **Pattern clustering** untuk group similar patterns
3. **A/B testing** framework untuk compare pattern performance
4. **Confidence intervals** untuk weight calculation
5. **Pattern correlation** analysis (e.g., hook_type × duration_range)

---

## ✅ Checklist

- [x] Rewrite MemoryAgent dengan pattern-based learning
- [x] Update database schema (memory table)
- [x] Add rejection penalty logic
- [x] Add weight decay logic
- [x] Add auto-cleanup logic
- [x] Integrate dengan ClipPlannerAgent
- [x] Integrate dengan TelegramAgent
- [x] Update scheduler (Memory + MemoryPenalty cron)
- [x] Testing dengan mock data
- [x] Documentation

---

## 📚 References

- Phase 1: `CHANGELOG_PHASE1.md` - Minimum viable clipper
- Phase 2: `CHANGELOG_PHASE2.md` - Multi-agent scoring
- Phase 4: `CHANGELOG_PHASE4.md` - Cleanup & hardening
