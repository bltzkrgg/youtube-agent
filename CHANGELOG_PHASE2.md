# CHANGELOG - PHASE 2: Multi-Agent Scoring & Advanced Features

## 🎯 Tujuan Phase 2
Menambahkan multi-agent scoring system dan advanced features untuk meningkatkan kualitas clip selection dan rendering.

---

## ✅ Perubahan yang Dilakukan

### 1. New Agents (Node.js)

#### `src/agents/moment_scoring/index.js` ✅
**Multi-perspective scoring untuk clip moments**

- **3 Scoring Personas**:
  1. `viral_expert` - Hook strength, emotional impact, shareability, retention
  2. `audience_psychologist` - Curiosity gap, emotional resonance, cognitive ease
  3. `content_strategist` - Platform fit, trend alignment, niche relevance

- **Output**:
  - `final_score` - Weighted average dari semua persona (0-100)
  - `confidence` - Berapa banyak persona yang berhasil score (0.0-1.0)
  - `persona_scores` - Detail score per persona dengan reasoning
  - `strengths` - Top 2 strengths dari high-scoring personas
  - `weaknesses` - Top 2 weaknesses dari low-scoring personas

- **Integration**: ClipPlannerAgent calls `scoreClipMoment()` untuk setiap clip candidate

#### `src/agents/critic/index.js` ✅
**Risk assessment agent untuk content safety**

- **Risk Categories**:
  1. **Misleading Context** - Clip out of context, missing important info
  2. **Sensitive Content** - Politik, agama, SARA, adult content, violence
  3. **Copyright Issues** - Music, brand mentions, third-party footage
  4. **Fact-Check Needed** - Unverified claims, statistics
  5. **Clickbait Without Substance** - Overpromise, no value delivery

- **Risk Levels**:
  - `safe` - Aman untuk publish
  - `low` - Risk rendah, bisa publish dengan catatan
  - `medium` - Perlu review manual
  - `high` - Tidak disarankan publish
  - `critical` - Jangan publish

- **Output**:
  - `risk_level` - Level risk
  - `is_safe` - Boolean flag
  - `concerns` - Array of specific concerns
  - `recommendations` - Array of action recommendations
  - `fact_check_needed` - Boolean flag
  - `context_warning` - Warning jika ada konteks yang hilang

- **Score Penalty**:
  - `high`/`critical` risk → score × 0.5
  - `medium` risk → score × 0.8

#### `src/agents/caption/index.js` ✅
**Advanced caption generation dengan word-level timing**

- **Features**:
  1. **Emphasis Detection** - Identify kata kunci yang perlu di-highlight (angka, kata emosional, kata kunci topik)
  2. **Caption Chunking** - Max 2-4 kata per frame untuk readability
  3. **Style Recommendations** - Font size, color, animation, position
  4. **Word-Level Timing** - Align captions dengan transcript timestamps

- **Caption Styles**:
  - `font_size`: "large" (hook/climax) atau "medium" (normal)
  - `color`: "white", "yellow" (emphasis), "red" (warning)
  - `animation`: "none", "pop" (emphasis), "slide_up"
  - `position`: "bottom" (default), "center" (dramatic)

- **Output**:
  - `caption_style` - Style configuration
  - `emphasis_words` - Array of words to highlight
  - `word_captions` - Array of caption chunks dengan timing
  - `srt_format` - Standard SRT subtitle file format

#### `src/agents/reframe/index.js` ✅
**Smart reframing strategy untuk 9:16 conversion**

- **Reframe Strategies**:
  1. `center` - Simple center crop (safe default)
  2. `face_track` - Track speaker's face (TODO: face detection)
  3. `action_follow` - Follow main action/object (TODO: motion tracking)
  4. `zoom_in` - Progressive zoom for emphasis
  5. `split_screen` - Multiple subjects (TODO: implementation)

- **Output**:
  - `strategy` - Selected strategy
  - `reasoning` - Why this strategy was chosen
  - `keyframes` - Array of strategy changes during clip (optional)
  - `fallback_strategy` - Fallback if primary fails

---

### 2. Updated Agents

#### `src/agents/clip_planner/index.js` ✅
**Integrated dengan Phase 2 agents**

- **New Flow**:
  1. LLM generates initial clip plans (sama seperti Phase 1)
  2. **FOR EACH CLIP**:
     - Call `MomentScoringAgent` → update score dengan weighted average
     - Call `CriticAgent` → assess risk, apply score penalty
     - Call `CaptionAgent` → generate advanced captions
     - Call `ReframeAgent` → determine optimal reframe strategy
  3. Sort clips by final score
  4. Insert enriched clips to database

- **Feature Flags** (via env):
  - `ENABLE_MOMENT_SCORING` (default: true)
  - `ENABLE_CRITIC` (default: true)
  - `ENABLE_CAPTION_AGENT` (default: true)
  - `ENABLE_REFRAME_AGENT` (default: true)

- **Enriched Clip Data**:
  ```javascript
  {
    clip_id: "...",
    start_sec: 10.5,
    end_sec: 45.2,
    score: 87, // Updated by scoring agents
    hook_type: "shocking_fact",
    reason: "...",
    caption_plan: "...",
    reframe_strategy: "zoom_in", // Updated by ReframeAgent
    risk_notes: "Risk: low; ...", // Updated by CriticAgent
    
    // NEW: Phase 2 enrichments
    moment_scoring: {
      final_score: 85,
      confidence: 1.0,
      persona_scores: [...],
      strengths: [...],
      weaknesses: [...]
    },
    risk_assessment: {
      risk_level: "low",
      is_safe: true,
      concerns: [],
      recommendations: []
    },
    captions: {
      caption_style: {...},
      emphasis_words: [...],
      word_captions: [...],
      srt_format: "..."
    },
    reframe_details: {
      strategy: "zoom_in",
      reasoning: "...",
      keyframes: []
    }
  }
  ```

#### `src/agents/clip_render/index.js` ✅
**Pass advanced data ke Python script**

- Read `clip_planner.json` untuk get enriched clip data
- Pass `captions` dan `reframe_details` ke Python config
- Python script uses advanced data jika available

---

### 3. Updated Python Scripts

#### `python/clip_render.py` ✅
**Support advanced captions dan reframe strategies**

- **New Parameters**:
  - `captions_data` - Advanced captions dari CaptionAgent
  - `reframe_details` - Reframe details dari ReframeAgent

- **New Functions**:
  - `_burn_srt_captions()` - Burn SRT subtitles dengan ASS styling
  - `_zoom_in_filter()` - Progressive zoom filter untuk FFmpeg

- **Caption Rendering**:
  - Priority 1: Use SRT captions jika available (advanced)
  - Priority 2: Use simple caption burn-in (fallback)
  - Priority 3: No captions

- **Reframe Strategies**:
  - `center` - ✅ Implemented
  - `zoom_in` - ✅ Implemented (progressive zoom 1.0x → 1.2x)
  - `face_track` - ⏸️ TODO (fallback to center)
  - `action_follow` - ⏸️ TODO (fallback to center)
  - `split_screen` - ⏸️ TODO (fallback to center)

---

### 4. Configuration Updates

#### `.env.example` ✅
**Added Phase 2 feature flags**

```env
# ─── PHASE 2: Advanced Agents (Multi-Agent Scoring) ──────────────────────────
# Enable/disable advanced processing agents
# Set to 'false' to disable (default: enabled)
ENABLE_MOMENT_SCORING=true
ENABLE_CRITIC=true
ENABLE_CAPTION_AGENT=true
ENABLE_REFRAME_AGENT=true
```

---

## 🎯 Benefits of Phase 2

### 1. **Better Clip Selection**
- Multi-perspective scoring → more balanced evaluation
- Risk assessment → avoid problematic content
- Confidence scoring → know when to trust the AI

### 2. **Higher Quality Clips**
- Advanced captions → better readability, emphasis on key words
- Smart reframing → optimal framing for different content types
- Word-level timing → professional subtitle sync

### 3. **Risk Mitigation**
- Automatic detection of misleading context
- Flag sensitive content before publish
- Fact-check reminders for claims
- Copyright issue warnings

### 4. **Flexibility**
- Feature flags → enable/disable agents per need
- Graceful degradation → fallback jika agent gagal
- Modular design → easy to add more agents

---

## 📊 Performance Impact

### API Calls per Clip (with all agents enabled)
- **Phase 1**: 1 LLM call (ClipPlanner)
- **Phase 2**: 5 LLM calls per clip
  - 1× ClipPlanner (initial)
  - 3× MomentScoring (3 personas)
  - 1× Critic
  - 1× Caption
  - 1× Reframe

### Cost Estimate
- **Phase 1**: ~$0.01-0.05 per source video
- **Phase 2**: ~$0.05-0.20 per source video (tergantung jumlah clips)

### Processing Time
- **Phase 1**: ~30-60 seconds per source video
- **Phase 2**: ~2-5 minutes per source video (tergantung jumlah clips)

### Mitigation
- Feature flags untuk disable agents jika tidak diperlukan
- Parallel processing untuk independent agents (future optimization)
- Caching untuk repeated analysis

---

## 🚧 Known Limitations (Phase 2)

1. **Face Tracking** - Belum diimplementasi, fallback to center crop
2. **Motion Tracking** - Belum diimplementasi, fallback to center crop
3. **Split Screen** - Belum diimplementasi, fallback to center crop
4. **Parallel Agent Calls** - Agents dipanggil sequential, bisa dioptimasi dengan parallel
5. **Caption Animation** - SRT tidak support animation, perlu custom solution
6. **Emphasis Highlighting** - SRT styling terbatas, perlu ASS format atau custom overlay

---

## 🔜 Next Steps (Phase 3)

### Phase 3: Memory & Analytics
- Update `MemoryAgent` untuk track clip patterns
  - Hook type performance
  - Duration sweet spot
  - Caption style effectiveness
  - Reframe strategy success rate
  - Risk level vs performance correlation
- Update `AnalyticsAgent` untuk clip-level tracking
- Link rejection feedback ke pattern learning
- Implement pattern-based recommendations

---

## ✅ Testing Checklist

### Unit Testing
- [ ] MomentScoringAgent returns valid scores
- [ ] CriticAgent detects risk correctly
- [ ] CaptionAgent generates valid SRT
- [ ] ReframeAgent returns valid strategies
- [ ] Feature flags work correctly

### Integration Testing
- [ ] ClipPlanner integrates all agents correctly
- [ ] Score updates propagate correctly
- [ ] Risk penalties apply correctly
- [ ] Advanced captions render correctly
- [ ] Reframe strategies work in Python
- [ ] Graceful degradation when agents fail

### End-to-End Testing
- [ ] Full pipeline with all agents enabled
- [ ] Full pipeline with all agents disabled
- [ ] Full pipeline with selective agents
- [ ] Error handling for agent failures
- [ ] Performance acceptable for production

---

## 🎉 Phase 2 Complete

**Status**: ✅ IMPLEMENTED

**Key Achievements**:
- ✅ Multi-perspective scoring system
- ✅ Risk assessment for content safety
- ✅ Advanced caption generation with word-level timing
- ✅ Smart reframing strategy selection
- ✅ Modular design with feature flags
- ✅ Graceful degradation on failures

**Next**: Phase 3 - Memory & Analytics Integration
