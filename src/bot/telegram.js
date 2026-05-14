'use strict';

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const logger = require('../utils/logger');
const { safeParseJson } = require('../utils/safeJson');
const { popJob, ackJob, nackJob, pushJob } = require('../utils/queue');
const { readVideoJson } = require('../utils/storage');
const { updateVideo, updateClip, getClip, getClipsBySourceVideo, getSourceVideo, getDb } = require('../utils/db');

const AGENT = 'TelegramBot';

let bot;

// Pending state for multi-step interactions
const pendingState = new Map();
const pendingTimeouts = new Map();
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Init ─────────────────────────────────────────────────────────────────────

function initBot() {
  if (bot) return bot;

  bot = new TelegramBot(config.telegram.botToken, { polling: true });

  bot.on('message', (msg) => _handleMessage(msg).catch((e) => {
    logger.error('Bot error pada message', { agent: AGENT, error_message: e.message });
  }));

  bot.on('callback_query', (q) => _handleCallback(q).catch((e) => {
    logger.error('Bot error pada callback', { agent: AGENT, error_message: e.message });
  }));

  bot.on('polling_error', (err) => {
    logger.error('Telegram polling error', { agent: AGENT, error_message: err.message });
  });

  logger.info('Telegram Bot aktif', { agent: AGENT });
  return bot;
}

// ─── Main pipeline entry: kirim clips untuk di-review ────────────────────────

async function runTelegramAgent() {
  const job = popJob('telegram_clip');
  if (!job) {
    logger.info('Tidak ada job telegram_clip di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai pengiriman clip review ke Telegram', { agent: AGENT, jobId: job.id });

  try {
    const { clip_id, source_video_id, correlation_id } = job.payload;
    if (!clip_id) throw new Error('clip_id tidak ada di payload');
    if (!source_video_id) throw new Error('source_video_id tidak ada di payload');

    await _sendClipForReview(clip_id, source_video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
  } catch (err) {
    logger.error('Telegram Agent gagal', {
      agent: AGENT,
      step: 'runTelegramAgent',
      error_message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Send clip for review ─────────────────────────────────────────────────────

async function _sendClipForReview(clipId, sourceVideoId, correlationId) {
  const clipDb = getClip(clipId);
  const sourceVideo = getSourceVideo(sourceVideoId);
  const clipPlannerData = readVideoJson(sourceVideoId, 'clip_planner.json');

  if (!clipDb || !sourceVideo) throw new Error('Data clip tidak lengkap untuk review');

  // Find enriched clip data from clip_planner.json
  const clipPlan = clipPlannerData?.clips?.find(c => c.clip_id === clipId);

  // Build clip info message
  const header = `🎬 *CLIP BARU UNTUK REVIEW*\n\n` +
    `📺 *Source:* ${_escape(sourceVideo.video_title)}\n` +
    `📌 *Channel:* ${_escape(sourceVideo.channel_title || '-')}\n` +
    `⏱ *Duration:* ${_escape(String(clipDb.duration_sec.toFixed(1)))}s \\(${_escape(String(clipDb.start_sec.toFixed(1)))}s \\- ${_escape(String(clipDb.end_sec.toFixed(1)))}s\\)\n` +
    `🎯 *Hook Type:* ${_escape(clipDb.hook_type || '-')}\n` +
    `⭐ *Score:* ${_escape(String(clipDb.score))}/100\n` +
    `🆔 \`${clipId}\``;

  await bot.sendMessage(config.telegram.chatId, header, {
    parse_mode: 'MarkdownV2',
  });

  // Send reason and caption plan
  if (clipPlan) {
    const details = `📝 *Reason:*\n${_escape(clipPlan.reason || '-')}\n\n` +
      `💬 *Caption Plan:*\n${_escape(clipDb.caption_plan || '-')}`;
    await bot.sendMessage(config.telegram.chatId, details, { parse_mode: 'MarkdownV2' });

    // Send risk assessment if available
    if (clipPlan.risk_assessment) {
      const risk = clipPlan.risk_assessment;
      const riskEmoji = {
        safe: '✅',
        low: '🟢',
        medium: '🟡',
        high: '🔴',
        critical: '⛔'
      }[risk.risk_level] || '❓';

      let riskMsg = `${riskEmoji} *Risk Level:* ${_escape(risk.risk_level.toUpperCase())}\n`;
      if (risk.concerns && risk.concerns.length > 0) {
        riskMsg += `\n⚠️ *Concerns:*\n${risk.concerns.map(c => `• ${_escape(c)}`).join('\n')}`;
      }
      if (risk.recommendations && risk.recommendations.length > 0) {
        riskMsg += `\n\n💡 *Recommendations:*\n${risk.recommendations.map(r => `• ${_escape(r)}`).join('\n')}`;
      }
      await bot.sendMessage(config.telegram.chatId, riskMsg, { parse_mode: 'MarkdownV2' });
    }

    // Send moment scoring if available
    if (clipPlan.moment_scoring) {
      const scoring = clipPlan.moment_scoring;
      let scoreMsg = `📊 *Multi\\-Perspective Scoring*\n\n` +
        `Final Score: *${scoring.final_score}/100* \\(confidence: ${(scoring.confidence * 100).toFixed(0)}%\\)\n\n`;
      
      if (scoring.strengths && scoring.strengths.length > 0) {
        scoreMsg += `💪 *Strengths:*\n${scoring.strengths.map(s => `• ${_escape(s)}`).join('\n')}\n\n`;
      }
      if (scoring.weaknesses && scoring.weaknesses.length > 0) {
        scoreMsg += `⚠️ *Weaknesses:*\n${scoring.weaknesses.map(w => `• ${_escape(w)}`).join('\n')}`;
      }
      await bot.sendMessage(config.telegram.chatId, scoreMsg, { parse_mode: 'MarkdownV2' });
    }
  }

  // Send risk notes if any
  if (clipDb.risk_notes) {
    await bot.sendMessage(config.telegram.chatId,
      `⚠️ *Risk Notes:*\n${_escape(clipDb.risk_notes)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }

  // Send video file if exists
  if (clipDb.final_video_path && fs.existsSync(clipDb.final_video_path)) {
    try {
      await bot.sendVideo(config.telegram.chatId, clipDb.final_video_path, {
        caption: `🎬 Clip Preview\n📁 \`${clipId}\``,
        parse_mode: 'MarkdownV2',
        supports_streaming: true,
        reply_markup: _buildClipReviewKeyboard(clipId),
      });
    } catch (err) {
      logger.error('Gagal mengirim video clip', { agent: AGENT, clipId, error_message: err.message });
      await bot.sendMessage(config.telegram.chatId,
        `⚠️ Gagal kirim video: ${_escape(err.message)}\n\nGunakan keyboard di bawah untuk review:`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: _buildClipReviewKeyboard(clipId),
        }
      );
    }
  } else {
    await bot.sendMessage(config.telegram.chatId,
      `⚠️ Video file tidak ditemukan\\. Gunakan keyboard di bawah untuk review:`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: _buildClipReviewKeyboard(clipId),
      }
    );
  }

  logger.info('Clip terkirim ke Telegram untuk review', { agent: AGENT, clipId });
}

// Structured reject reasons for clips
const CLIP_REJECT_REASONS = {
  visual_buruk: { label: '🎨 Visual Buruk',  penaltyType: 'visual',  penaltyFactor: 0.4 },
  topik_garing: { label: '😴 Topik Garing',  penaltyType: 'topic',   penaltyFactor: 0.3 },
  timing_buruk: { label: '⏱ Timing Buruk',  penaltyType: 'general', penaltyFactor: 0.5 },
  hook_lemah:   { label: '🎣 Hook Lemah',    penaltyType: 'topic',   penaltyFactor: 0.4 },
};

function _buildClipReviewKeyboard(clipId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ APPROVE', callback_data: `clip_approve|${clipId}` },
        { text: '❌ REJECT',  callback_data: `clip_reject|${clipId}` },
      ],
      // Structured reject shortcuts
      [
        { text: CLIP_REJECT_REASONS.visual_buruk.label, callback_data: `clip_reject_reason|${clipId}|visual_buruk` },
        { text: CLIP_REJECT_REASONS.topik_garing.label, callback_data: `clip_reject_reason|${clipId}|topik_garing` },
      ],
      [
        { text: CLIP_REJECT_REASONS.timing_buruk.label, callback_data: `clip_reject_reason|${clipId}|timing_buruk` },
        { text: CLIP_REJECT_REASONS.hook_lemah.label, callback_data: `clip_reject_reason|${clipId}|hook_lemah` },
      ],
      [
        { text: '📊 View All Clips', callback_data: `view_all_clips|${clipId}` },
      ],
    ],
  };
}

// ─── Callback handler ─────────────────────────────────────────────────────────

async function _handleCallback(query) {
  const { data, message } = query;
  const chatId = message.chat.id.toString();

  // Only respond to authorized chat
  if (chatId !== config.telegram.chatId) return;

  await bot.answerCallbackQuery(query.id);

  const separator = data.includes(':') ? ':' : '|';
  const parts = (data || '').split(separator);
  const action = parts[0];

  if (!action || !parts[1]) return;

  switch (action) {
    case 'clip_approve':
      await _handleClipApprove(chatId, parts[1]);
      break;
    case 'clip_reject':
      await _handleClipRejectStart(chatId, parts[1]);
      break;
    case 'clip_reject_reason':
      await _handleClipStructuredReject(chatId, parts[1], parts[2]);
      break;
    case 'view_all_clips':
      await _handleViewAllClips(chatId, parts[1]);
      break;
    case 'trigger_clipper':
      await _handleTriggerClipper(chatId, message);
      break;
    case 'check_queue':
      await _sendQueueStats(chatId);
      break;
    default:
      logger.warn('Callback action tidak dikenal', { agent: AGENT, action });
  }
}

// ─── Clip Approve ─────────────────────────────────────────────────────────────

async function _handleClipApprove(chatId, clipId) {
  logger.info('Clip di-APPROVE', { agent: AGENT, clipId });

  updateClip(clipId, { status: 'approved', approved_at: new Date().toISOString() });

  const clipDb = getClip(clipId);

  await bot.sendMessage(chatId,
    `✅ Clip \`${clipId}\` di\\-approve\\. Mengirim file\\.\\.\\.`,
    { parse_mode: 'MarkdownV2' }
  );

  try {
    if (config.dryRun) {
      await bot.sendMessage(chatId,
        `🔵 \\[DRY\\_RUN\\] Clip tidak dikirim \\(mock file\\)\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    } else {
      if (!clipDb?.final_video_path || !fs.existsSync(clipDb.final_video_path)) {
        throw new Error(`File clip tidak ditemukan: ${clipDb?.final_video_path}`);
      }

      await bot.sendDocument(chatId, clipDb.final_video_path, {
        caption: `🎬 Clip Approved\n\n` +
          `📁 File: \`${path.basename(clipDb.final_video_path)}\`\n` +
          `⏱ Duration: ${clipDb.duration_sec.toFixed(1)}s\n` +
          `🎯 Hook: ${_escape(clipDb.hook_type || '-')}\n` +
          `⭐ Score: ${clipDb.score}/100\n\n` +
          `Download dan upload ke YouTube Shorts\\.`,
        parse_mode: 'MarkdownV2',
      });
    }

    updateClip(clipId, { status: 'uploaded' });

    await bot.sendMessage(chatId,
      '📊 Upload manual ke YouTube Shorts\\. Kirim CSV analytics nanti untuk tracking performa\\.',
      { parse_mode: 'MarkdownV2' }
    );

  } catch (err) {
    logger.error('Gagal mengirim clip ke Telegram', { agent: AGENT, clipId, error_message: err.message });
    await bot.sendMessage(chatId,
      `⚠️ Gagal kirim clip: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// ─── Clip Reject ──────────────────────────────────────────────────────────────

async function _handleClipRejectStart(chatId, clipId) {
  _setPendingState(chatId, { action: 'clip_reject', clip_id: clipId });
  await bot.sendMessage(chatId,
    `❌ Ketik alasan reject untuk clip \`${clipId}\` \\(atau ketik /skip untuk skip alasan\\):`,
    { parse_mode: 'MarkdownV2' }
  );
}

async function _handleClipRejectConfirm(chatId, reason) {
  const state = pendingState.get(chatId);
  if (!state || state.action !== 'clip_reject') return;

  const clipId = state.clip_id;
  _clearPendingState(chatId);

  updateClip(clipId, {
    status: 'rejected',
    rejected_at: new Date().toISOString(),
    reject_reason: reason,
  });

  logger.info('Clip di-REJECT (manual)', { agent: AGENT, clipId, reason });
  await bot.sendMessage(chatId,
    `❌ Clip \`${clipId}\` di\\-reject\\.\n📝 Alasan: ${_escape(reason)}`,
    { parse_mode: 'MarkdownV2' }
  );
}

async function _handleClipStructuredReject(chatId, clipId, reasonKey) {
  const reason = CLIP_REJECT_REASONS[reasonKey];
  if (!reason) {
    await bot.sendMessage(chatId, `⚠️ Alasan tidak dikenal: ${_escape(reasonKey)}`,
      { parse_mode: 'MarkdownV2' });
    return;
  }

  const clipDb = getClip(clipId);
  if (!clipDb) {
    await bot.sendMessage(chatId, `⚠️ Clip tidak ditemukan: \`${clipId}\``,
      { parse_mode: 'MarkdownV2' });
    return;
  }

  updateClip(clipId, {
    status: 'rejected',
    rejected_at: new Date().toISOString(),
    reject_reason: reason.label,
  });

  logger.info('Clip di-REJECT (structured)', {
    agent: AGENT, clipId, reason: reasonKey, penaltyType: reason.penaltyType,
  });

  // Push feedback to MemoryAgent for pattern penalty
  pushJob('memory_penalty', {
    clip_id:        clipId,
    correlation_id: clipDb.correlation_id || uuidv4(),
    penalty_type:   reason.penaltyType,
    penalty_factor: reason.penaltyFactor,
    reason_label:   reason.label,
  }, {
    correlationId: clipDb.correlation_id || uuidv4(),
    priority: 'high',
  });

  logger.info('Memory penalty job dikirim', { agent: AGENT, clipId, reasonKey });

  await bot.sendMessage(chatId,
    `${reason.label} — Clip \`${clipId}\` di\\-reject\\.\n` +
    `📉 Penalti akan diterapkan ke pattern: _${_escape(clipDb.hook_type || 'unknown')}_`,
    { parse_mode: 'MarkdownV2' }
  );
}

// ─── View all clips from source ───────────────────────────────────────────────

async function _handleViewAllClips(chatId, clipId) {
  const clipDb = getClip(clipId);
  if (!clipDb) {
    await bot.sendMessage(chatId, `⚠️ Clip tidak ditemukan`,
      { parse_mode: 'MarkdownV2' });
    return;
  }

  const allClips = getClipsBySourceVideo(clipDb.source_video_id);
  const sourceVideo = getSourceVideo(clipDb.source_video_id);

  let msg = `📊 *All Clips from Source*\n\n` +
    `📺 *Source:* ${_escape(sourceVideo?.video_title || '-')}\n` +
    `📌 *Channel:* ${_escape(sourceVideo?.channel_title || '-')}\n` +
    `🎬 *Total Clips:* ${allClips.length}\n\n`;

  for (const clip of allClips) {
    const statusEmoji = {
      pending: '⏳',
      pending_review: '👀',
      approved: '✅',
      rejected: '❌',
      uploaded: '📤',
    }[clip.status] || '❓';

    msg += `${statusEmoji} \`${clip.id.slice(0, 8)}\` \\- ` +
      `${_escape(clip.hook_type || '-')} \\- ` +
      `${clip.score}/100 \\- ` +
      `${clip.duration_sec.toFixed(1)}s\n`;
  }

  await bot.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
}

// ─── Trigger clipper ──────────────────────────────────────────────────────────

async function _handleTriggerClipper(chatId, message) {
  _setPendingState(chatId, { action: 'trigger_clipper' });
  await bot.sendMessage(chatId,
    `🎬 Kirim YouTube URL untuk di\\-clip:`,
    { parse_mode: 'MarkdownV2' }
  );
}

async function _handleTriggerClipperConfirm(chatId, url) {
  const state = pendingState.get(chatId);
  if (!state || state.action !== 'trigger_clipper') return;

  _clearPendingState(chatId);

  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    await bot.sendMessage(chatId, `⚠️ URL harus berupa YouTube URL`,
      { parse_mode: 'MarkdownV2' });
    return;
  }

  await bot.sendMessage(chatId,
    `🔄 Memulai clipper pipeline untuk:\n${_escape(url)}`,
    { parse_mode: 'MarkdownV2' }
  );

  try {
    const { triggerSourceIngest } = require('../agents/source_ingest');
    await triggerSourceIngest(url);
    await bot.sendMessage(chatId,
      `✅ Pipeline dimulai\\! Monitor progress di logs\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    await bot.sendMessage(chatId,
      `❌ Error: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

async function _handleMessage(msg) {
  const chatId = msg.chat.id.toString();
  if (chatId !== config.telegram.chatId) return;

  const text = (msg.text || '').trim();

  // Handle document upload (CSV analytics)
  if (msg.document) {
    await _handleDocumentUpload(msg);
    return;
  }

  if (!text) return;

  // Check pending state first
  const state = pendingState.get(chatId);
  if (state) {
    if (text === '/skip') {
      _clearPendingState(chatId);
      await bot.sendMessage(chatId, 'Aksi dibatalkan\\.', { parse_mode: 'MarkdownV2' });
      return;
    }

    switch (state.action) {
      case 'clip_reject':
        await _handleClipRejectConfirm(chatId, text);
        return;
      case 'trigger_clipper':
        await _handleTriggerClipperConfirm(chatId, text);
        return;
    }
  }

  // Commands
  if (text.startsWith('/')) {
    await _handleCommand(chatId, text, msg);
    return;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function _handleCommand(chatId, text, msg) {
  const [cmd, ...args] = text.split(' ');

  switch (cmd) {
    case '/start':
    case '/help':
      await _sendHelp(chatId);
      break;

    case '/status':
      await _sendStatus(chatId);
      break;

    case '/queue':
      await _sendQueueStats(chatId);
      break;

    case '/trigger':
      if (args.length > 0) {
        // Direct URL provided
        await _handleTriggerClipperConfirm(chatId, args[0]);
      } else {
        // Ask for URL
        await _handleTriggerClipper(chatId, msg);
      }
      break;

    case '/approve_source':
      if (args.length > 0) {
        await _handleApproveSource(chatId, args[0]);
      } else {
        await bot.sendMessage(chatId, '⚠️ Usage: /approve\\_source <source\\_video\\_id>',
          { parse_mode: 'MarkdownV2' });
      }
      break;

    default:
      await bot.sendMessage(chatId, `❓ Perintah tidak dikenal: ${_escape(cmd)}`,
        { parse_mode: 'MarkdownV2' });
  }
}

// ─── CSV Analytics upload ─────────────────────────────────────────────────────

async function _handleDocumentUpload(msg) {
  const doc = msg.document;
  if (!doc.file_name?.endsWith('.csv')) {
    await bot.sendMessage(msg.chat.id, '⚠️ Hanya file CSV yang diterima untuk analytics\\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  logger.info('CSV analytics diterima via Telegram', { agent: AGENT });
  await bot.sendMessage(msg.chat.id, '📊 Memproses file analytics CSV\\.\\.\\.',
    { parse_mode: 'MarkdownV2' });

  try {
    // Download file
    const fileLink = await bot.getFileLink(doc.file_id);
    const axios = require('axios');
    const res = await axios.get(fileLink, { responseType: 'arraybuffer' });

    const csvPath = path.join(config.paths.output, `analytics_${Date.now()}.csv`);
    fs.writeFileSync(csvPath, res.data);

    // Push analytics job
    const correlationId = uuidv4();
    pushJob('analytics', { csv_path: csvPath, correlation_id: correlationId }, {
      correlationId,
      priority: 'normal',
    });

    await bot.sendMessage(msg.chat.id,
      `✅ CSV diterima dan dijadwalkan untuk diproses\\.\nJob ID: \`${correlationId}\``,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    logger.error('Gagal memproses CSV analytics', { agent: AGENT, error_message: err.message });
    await bot.sendMessage(msg.chat.id, `❌ Gagal: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' });
  }
}

// ─── Info messages ────────────────────────────────────────────────────────────

async function _handleApproveSource(chatId, sourceVideoId) {
  try {
    const { getSourceVideo, updateSourceVideo } = require('../utils/db');
    const sourceVideo = getSourceVideo(sourceVideoId);

    if (!sourceVideo) {
      await bot.sendMessage(chatId, `❌ Source video tidak ditemukan: \`${_escape(sourceVideoId)}\``,
        { parse_mode: 'MarkdownV2' });
      return;
    }

    // Update permission
    updateSourceVideo(sourceVideoId, {
      permission_status: 'approved',
      allowed_to_clip: 1,
      risk_level: 'low',
      risk_notes: 'Manually approved by user via Telegram',
    });

    await bot.sendMessage(chatId,
      `✅ Source video disetujui\\!\n\n` +
      `ID: \`${_escape(sourceVideoId)}\`\n` +
      `Title: ${_escape(sourceVideo.video_title || 'N/A')}\n` +
      `Channel: ${_escape(sourceVideo.channel_title || 'N/A')}\n\n` +
      `Clips dari source ini sekarang bisa dirender\\.`,
      { parse_mode: 'MarkdownV2' }
    );

    logger.info('Source video approved via Telegram', { agent: AGENT, sourceVideoId });
  } catch (err) {
    logger.error('Gagal approve source', { agent: AGENT, error_message: err.message });
    await bot.sendMessage(chatId, `❌ Error: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' });
  }
}

async function _sendHelp(chatId) {
  const msg = `🤖 *YouTube AI Clipper*\n\n` +
    `Pilih menu di bawah ini:\n\n` +
    `Commands:\n` +
    `/trigger \\- Start clipper pipeline\n` +
    `/status \\- Check clips status\n` +
    `/approve\\_source <id> \\- Approve source video\n` +
    `/queue \\- Check queue stats\n` +
    `/help \\- Show this message`;

  const opts = {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎬 Trigger Clipper', callback_data: 'trigger_clipper' }],
        [{ text: '📋 Cek Queue', callback_data: 'check_queue' }],
      ]
    }
  };

  await bot.sendMessage(chatId, msg, opts);
}

async function _sendStatus(chatId) {
  const rows = getDb().prepare(
    `SELECT status, COUNT(*) as count FROM clips GROUP BY status`
  ).all();

  const lines = rows.map((r) => `• ${r.status}: ${r.count}`).join('\n');
  await bot.sendMessage(chatId, `📊 *Status Clips:*\n\n${lines || 'Belum ada clips'}`,
    { parse_mode: 'MarkdownV2' });
}

async function _sendQueueStats(chatId) {
  const { getQueueStats } = require('../utils/queue');
  const stats = getQueueStats();
  const lines = stats.map((r) => `• ${r.type}/${r.status}: ${r.count}`).join('\n');
  await bot.sendMessage(chatId, `📋 *Queue Stats:*\n\n${lines || 'Queue kosong'}`,
    { parse_mode: 'MarkdownV2' });
}

// ─── Pending state helpers ────────────────────────────────────────────────────

function _setPendingState(chatId, state) {
  _clearPendingState(chatId);
  pendingState.set(chatId, state);

  const timeout = setTimeout(() => {
    pendingState.delete(chatId);
    bot.sendMessage(chatId, '⏱ Sesi input timeout\\. Silakan mulai lagi\\.',
      { parse_mode: 'MarkdownV2' }).catch(() => {});
  }, RESPONSE_TIMEOUT_MS);

  pendingTimeouts.set(chatId, timeout);
}

function _clearPendingState(chatId) {
  pendingState.delete(chatId);
  const t = pendingTimeouts.get(chatId);
  if (t) {
    clearTimeout(t);
    pendingTimeouts.delete(chatId);
  }
}

// ─── Markdown escape ──────────────────────────────────────────────────────────

function _escape(text) {
  return String(text || '').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// ─── Notify helper (used by other modules) ────────────────────────────────────

async function notify(message) {
  if (!bot) return;
  try {
    await bot.sendMessage(config.telegram.chatId, _escape(message), { parse_mode: 'MarkdownV2' });
  } catch (err) {
    logger.warn('Notif Telegram gagal', { agent: AGENT, error_message: err.message });
  }
}

async function sendStartupMessage() {
  if (!bot) return;
  const msg = `🤖 *YouTube AI Clipper v2\\.0\\.0 aktif\\!*\n\n` +
    `Mode: ${config.dryRun ? '*DRY\\_RUN*' : '*PRODUCTION*'}\n\n` +
    `Ketik /start untuk memulai\\.`;
  await bot.sendMessage(config.telegram.chatId, msg, { parse_mode: 'MarkdownV2' });
}

module.exports = { initBot, runTelegramAgent, notify, sendStartupMessage };
