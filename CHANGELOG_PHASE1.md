# CHANGELOG - PHASE 1: Minimum Viable Clipper

## 🎯 Tujuan Phase 1
Mengubah repository dari **AI UGC Content Generator** menjadi **AI-Agent Clipper** berbasis source video YouTube.

---

## ✅ Perubahan yang Dilakukan

### 1. Dependencies

#### Python (`requirements.txt`)
- ✅ **ADDED**: `openai-whisper>=20231117` - Transcription
- ✅ **ADDED**: `scenedetect[opencv]>=0.6.2` - Scene boundary detection
- ✅ **ADDED**: `yt-dlp>=2023.12.30` - YouTube video download
- ❌ **REMOVED**: `edge-tts>=6.1.9` - TTS tidak dipakai lagi

#### Node.js (`package.json`)
- ✅ No changes (semua dependency masih relevan)

---

### 2. Database Schema (`src/utils/db.js`)

#### New Tables
- ✅ **`source_videos`** - Track source YouTube videos
  - `id`, `correlation_id`, `source_url`, `source_video_path`, `source_duration`
  - `channel_title`, `video_title`, `description`, `status`

- ✅ **`clips`** - Track clips generated from source videos
  - `id`, `source_video_id`, `correlation_id`
  - `start_sec`, `end_sec`, `duration_sec`, `score`
  - `hook_type`, `caption_plan`, `reframe_strategy`, `risk_notes`
  - `final_video_path`, `thumbnail_path`, `status`
  - `approved_at`, `rejected_at`, `reject_reason`

#### Modified Tables
- ✅ **`memory`** - Changed from topic-based to pattern-based
  - OLD: `topic`, `weight`, `views_avg`, `engagement`, `video_count`
  - NEW: `pattern_type`, `pattern_value`, `weight`, `views_avg`, `engagement`, `clip_count`

- ✅ **`analytics`** - Changed from `video_id` to `clip_id`
  - OLD: `FOREIGN KEY (video_id) REFERENCES videos(id)`
  - NEW: `FOREIGN KEY (clip_id) REFERENCES clips(id)`

#### Legacy Tables (kept for backward compatibility)
- ✅ **`videos`** - Original UGC generator table (kept)

---

### 3. Schemas (`src/schemas/index.js`)

#### New Schemas
- ✅ `SourceIngestOutput` - Source video metadata
- ✅ `TranscriptOutput` + `TranscriptSegment` - Whisper transcription
- ✅ `SceneDetectOutput` + `SceneSegment` - Scene boundaries
- ✅ `ClipPlannerOutput` + `ClipPlan` - Clip plans from LLM
- ✅ `ClipRenderOutput` - Rendered clip metadata
- ✅ `OpenRouterClipPlansResponse` - LLM response validation

#### Legacy Schemas (kept)
- ✅ `ResearchOutput`, `ScriptOutput`, `MetadataOutput`, `VoiceoverOutput`, `VisualOutput`, `ClipOutput`

---

### 4. New Agents

#### `src/agents/source_ingest/index.js`
- ✅ Download YouTube video via yt-dlp
- ✅ Extract metadata (title, channel, duration, description)
- ✅ Store to `source_videos` table
- ✅ Spawn `transcript` + `scene_detect` jobs (parallel)

#### `src/agents/transcript/index.js`
- ✅ Wrapper untuk `python/whisper_transcribe.py`
- ✅ Generate transcript dengan timestamps
- ✅ Store to `transcript.json`
- ✅ Check if scene_detect done → trigger clip_planner

#### `src/agents/scene_detect/index.js`
- ✅ Wrapper untuk `python/scene_detect.py`
- ✅ Detect scene boundaries
- ✅ Store to `scene_detect.json`
- ✅ Check if transcript done → trigger clip_planner

#### `src/agents/clip_planner/index.js`
- ✅ Rewrite dari `ScriptAgent`
- ✅ LLM analyzes transcript + scenes
- ✅ Identify 3-7 viral moments
- ✅ Output: clip plans dengan start_sec, end_sec, score, hook_type, caption_plan, reframe_strategy, risk_notes
- ✅ Insert clips to database
- ✅ Spawn `clip_render` jobs per clip

#### `src/agents/clip_render/index.js`
- ✅ Wrapper untuk `python/clip_render.py`
- ✅ Cut source video by timestamp
- ✅ Reframe to 9:16 (1080x1920)
- ✅ Burn simple captions
- ✅ Generate thumbnail
- ✅ Update clip in database
- ✅ Spawn `telegram_clip` job

---

### 5. New Python Scripts

#### `python/clip_render.py`
- ✅ **REWRITE TOTAL** dari `clip_agent.py`
- ✅ Extract clip from source video (FFmpeg)
- ✅ Reframe to 9:16 with strategy: center, face_track (TODO), action_follow (TODO)
- ✅ Burn simple caption overlay
- ✅ Generate thumbnail with play button icon
- ✅ No AI-generated footage, no voiceover mixing

#### `python/whisper_transcribe.py`
- ✅ Already exists, no changes needed

#### `python/scene_detect.py`
- ✅ Already exists, no changes needed

---

### 6. Configuration (`src/config/index.js`)

#### Removed
- ❌ `google.apiKey` - Veo tidak dipakai
- ❌ `google.model` - Veo tidak dipakai
- ❌ `tts.voice` - TTS tidak dipakai
- ❌ `tts.rate` - TTS tidak dipakai
- ❌ `openrouter.models.visualPrompt` - Visual generation tidak dipakai

#### Added
- ✅ `ytdlp.format` - yt-dlp format string
- ✅ `whisper.model` - Whisper model size (tiny/base/small/medium/large)
- ✅ `sceneDetect.threshold` - Scene detection sensitivity
- ✅ `openrouter.models.clipPlanner` - Model untuk clip planning

#### Modified
- ✅ `youtube.apiKey` - Made optional (only for legacy research agent)
- ✅ Required env vars - Removed `YOUTUBE_API_KEY`, `GOOGLE_API_KEY`

---

### 7. Scheduler (`src/scheduler/cron.js`)

#### New Pipeline (Active)
```
*/5 min → SourceIngest, Transcript, SceneDetect, ClipPlanner, ClipRender, Telegram
16:00   → Analytics
16:30   → Memory
* * * * * → MemoryPenalty
Sun 03:00 → Cleanup
```

#### Legacy Pipeline (Commented Out)
```
00:00   → Research
*/5 min → Script, Metadata, Voiceover, Visual, Clip
```

---

### 8. Environment Config (`.env.example`)

#### Removed
- ❌ `YOUTUBE_API_KEY` (moved to legacy section)
- ❌ `GOOGLE_API_KEY` (moved to legacy section)
- ❌ `GOOGLE_VIDEO_MODEL` (moved to legacy section)
- ❌ `TTS_VOICE` (moved to legacy section)
- ❌ `TTS_RATE` (moved to legacy section)
- ❌ `BG_MUSIC_PATH` (moved to legacy section)
- ❌ `RESEARCH_MODEL` (moved to legacy section)
- ❌ `SCRIPT_MODEL` (renamed to CLIP_PLANNER_MODEL)
- ❌ `VISUAL_PROMPT_MODEL` (moved to legacy section)
- ❌ `CONTENT_NICHE` (not relevant for clipper)
- ❌ `CONTENT_LANGUAGE` (not relevant for clipper)
- ❌ `CONTENT_COUNTRY` (not relevant for clipper)
- ❌ `VIDEO_MAX_DURATION` (clips are determined by source)
- ❌ `TIMEOUT_RESEARCH`, `TIMEOUT_VISUAL`, `TIMEOUT_CLIP`, `TIMEOUT_UPLOAD` (consolidated to TIMEOUT_DEFAULT)

#### Added
- ✅ `CLIP_PLANNER_MODEL` - Model untuk clip planning
- ✅ `WHISPER_MODEL` - Whisper model size
- ✅ `SCENE_DETECT_THRESHOLD` - Scene detection sensitivity
- ✅ `YTDLP_FORMAT` - yt-dlp format string

---

### 9. New Files

- ✅ `src/trigger_clipper.js` - Manual trigger helper
- ✅ `README_CLIPPER.md` - Comprehensive documentation untuk clipper
- ✅ `CHANGELOG_PHASE1.md` - This file

---

### 10. Legacy Agents (Kept but Disabled)

#### Disabled in Scheduler
- ⏸️ `src/agents/research/index.js` - YouTube trending discovery
- ⏸️ `src/agents/script/index.js` - Viral script generation
- ⏸️ `src/agents/metadata/index.js` - Title/description generation
- ⏸️ `src/agents/voiceover/index.js` - TTS generation
- ⏸️ `src/agents/visual/index.js` - Veo AI video generation
- ⏸️ `src/agents/clip/index.js` - AI footage stitching

#### Still Active (Reusable)
- ✅ `src/agents/analytics/index.js` - Performance tracking
- ✅ `src/agents/memory/index.js` - Learning system (needs modification for clip patterns)
- ✅ `src/bot/telegram.js` - Review bot (needs modification for clip review)

---

## 🚧 TODO for Phase 2-4

### Phase 2: Multi-Agent Scoring
- [ ] `MomentScoringAgent` - Multiple LLM agents score each moment
- [ ] `CriticAgent` - Check for misleading/risky content
- [ ] `CaptionAgent` - Advanced caption generation with timing
- [ ] `ReframeAgent` - Smart reframing (face tracking, motion tracking)

### Phase 3: Memory & Analytics
- [ ] Update `MemoryAgent` untuk clip patterns (hook_type, duration, caption_style)
- [ ] Update `AnalyticsAgent` untuk track clip performance
- [ ] Link analytics to clip_id instead of video_id

### Phase 4: Cleanup & Hardening
- [ ] Update `TelegramAgent` untuk clip review (multiple clips per source)
- [ ] Update database cleanup untuk clips
- [ ] Error handling & retry logic
- [ ] Idempotency checks
- [ ] Temp file cleanup
- [ ] Update README.md (merge with README_CLIPPER.md)

---

## 📊 Testing Checklist

### Manual Testing
- [ ] DRY_RUN mode works end-to-end
- [ ] Real YouTube URL download works
- [ ] Whisper transcription works
- [ ] Scene detection works
- [ ] Clip planning generates valid plans
- [ ] Clip rendering produces 9:16 video
- [ ] Telegram review works
- [ ] Database migrations work on fresh install
- [ ] Database migrations work on existing database

### Integration Testing
- [ ] Full pipeline: URL → clips → Telegram
- [ ] Error handling: invalid URL
- [ ] Error handling: private video
- [ ] Error handling: age-restricted video
- [ ] Retry logic works
- [ ] Queue system works
- [ ] Concurrent job handling

---

## 🎉 Phase 1 Complete

**Status**: ✅ IMPLEMENTED

**Next**: Phase 2 - Multi-Agent Scoring & Advanced Features
