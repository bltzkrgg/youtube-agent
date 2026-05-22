'use strict';

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const logger = require('../utils/logger');
const { popJob, ackJob, nackJob, pushJob } = require('../utils/queue');
const { readVideoJson } = require('../utils/storage');
const {
  updateClip,
  getClip,
  getClipsBySourceVideo,
  getSourceVideo,
  getDb,
} = require('../utils/db');

const AGENT = 'TelegramBot';

let bot;

// Pending state for multi-step interactions
const pendingState = new Map();
const pendingTimeouts = new Map();
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Confirmation state for destructive operations
const confirmationState = new Map();

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

  // IDEMPOTENCY: Skip if clip already sent for review or processed.
  // Allow 'rendered' through — that is the expected state after ClipRenderAgent.
  if (
    clipDb.status === 'pending_review' ||
    clipDb.status === 'approved' ||
    clipDb.status === 'rejected' ||
    clipDb.status === 'uploaded'
  ) {
    logger.info('Clip sudah dikirim untuk review atau sudah diproses, skip', {
      agent: AGENT,
      clipId,
      status: clipDb.status,
    });
    return;
  }

  // In dry-run mode, skip Telegram API calls but still mark pending_review
  if (config.dryRun) {
    updateClip(clipId, { status: 'pending_review' });
    logger.info('[DRY_RUN] Clip marked pending_review (skipping Telegram send)', {
      agent: AGENT,
      clipId,
    });
    return;
  }

  // Find enriched clip data from clip_planner.json
  const clipPlan = clipPlannerData?.clips?.find((c) => c.clip_id === clipId);

  const duration = _number(clipDb.duration_sec, 0).toFixed(1);
  const start = _number(clipDb.start_sec, 0).toFixed(1);
  const end = _number(clipDb.end_sec, 0).toFixed(1);
  const score = _number(clipDb.score, 0);

  const header = `🎬 *CLIP BARU UNTUK REVIEW*\n\n` +
    `📺 *Source:* ${_escape(sourceVideo.video_title || '-')}\n` +
    `📌 *Channel:* ${_escape(sourceVideo.channel_title || '-')}\n` +
    `⏱ *Duration:* ${_escape(duration)}s \\(${_escape(start)}s \\- ${_escape(end)}s\\)\n` +
    `🎯 *Hook Type:* ${_escape(clipDb.hook_type || '-')}\n` +
    `⭐ *Score:* ${_escape(score)}/100\n` +
    `🆔 ${_code(clipId)}`;

  await _sendMessage(config.telegram.chatId, header, {
    parse_mode: 'MarkdownV2',
  });

  if (clipPlan) {
    const details = `📝 *Reason:*\n${_escape(clipPlan.reason || '-')}\n\n` +
      `💬 *Caption Plan:*\n${_escape(clipDb.caption_plan || '-')}`;

    await _sendMessage(config.telegram.chatId, details, {
      parse_mode: 'MarkdownV2',
    });

    if (clipPlan.risk_assessment) {
      const risk = clipPlan.risk_assessment;
      const riskEmoji = {
        safe: '✅',
        low: '🟢',
        medium: '🟡',
        high: '🔴',
        critical: '⛔',
      }[risk.risk_level] || '❓';

      let riskMsg = `${riskEmoji} *Risk Level:* ${_escape(String(risk.risk_level || 'unknown').toUpperCase())}\n`;

      if (Array.isArray(risk.concerns) && risk.concerns.length > 0) {
        riskMsg += `\n⚠️ *Concerns:*\n${risk.concerns.map((c) => `• ${_escape(c)}`).join('\n')}`;
      }

      if (Array.isArray(risk.recommendations) && risk.recommendations.length > 0) {
        riskMsg += `\n\n💡 *Recommendations:*\n${risk.recommendations.map((r) => `• ${_escape(r)}`).join('\n')}`;
      }

      await _sendMessage(config.telegram.chatId, riskMsg, {
        parse_mode: 'MarkdownV2',
      });
    }

    if (clipPlan.moment_scoring) {
      const scoring = clipPlan.moment_scoring;
      const confidence = _number(scoring.confidence, 0) * 100;

      let scoreMsg = `📊 *Multi\\-Perspective Scoring*\n\n` +
        `Final Score: *${_escape(scoring.final_score ?? '-')}/100* \\(confidence: ${_escape(confidence.toFixed(0))}%\\)\n\n`;

      if (Array.isArray(scoring.strengths) && scoring.strengths.length > 0) {
        scoreMsg += `💪 *Strengths:*\n${scoring.strengths.map((s) => `• ${_escape(s)}`).join('\n')}\n\n`;
      }

      if (Array.isArray(scoring.weaknesses) && scoring.weaknesses.length > 0) {
        scoreMsg += `⚠️ *Weaknesses:*\n${scoring.weaknesses.map((w) => `• ${_escape(w)}`).join('\n')}`;
      }

      await _sendMessage(config.telegram.chatId, scoreMsg, {
        parse_mode: 'MarkdownV2',
      });
    }
  }

  if (clipDb.risk_notes) {
    await _sendMessage(
      config.telegram.chatId,
      `⚠️ *Risk Notes:*\n${_escape(clipDb.risk_notes)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }

  if (clipDb.final_video_path && fs.existsSync(clipDb.final_video_path)) {
    try {
      await bot.sendVideo(config.telegram.chatId, clipDb.final_video_path, {
        caption: `🎬 Clip Preview\n📁 ${_code(clipId)}`,
        parse_mode: 'MarkdownV2',
        supports_streaming: true,
        reply_markup: _buildClipReviewKeyboard(clipId),
      });
    } catch (err) {
      logger.error('Gagal mengirim video clip', {
        agent: AGENT,
        clipId,
        error_message: err.message,
      });

      await _sendMessage(
        config.telegram.chatId,
        `⚠️ Gagal kirim video: ${_escape(err.message)}\n\nGunakan keyboard di bawah untuk review:`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: _buildClipReviewKeyboard(clipId),
        }
      );
    }
  } else {
    await _sendMessage(
      config.telegram.chatId,
      `⚠️ Video file tidak ditemukan\\. Gunakan keyboard di bawah untuk review:`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: _buildClipReviewKeyboard(clipId),
      }
    );
  }

  // Mark pending_review only AFTER review keyboard is successfully delivered
  updateClip(clipId, { status: 'pending_review' });

  logger.info('Clip terkirim ke Telegram untuk review', {
    agent: AGENT,
    clipId,
    correlationId,
  });
}

// ─── Structured reject reasons for clips ──────────────────────────────────────

const CLIP_REJECT_REASONS = {
  visual_buruk: { label: '🎨 Visual Buruk', penaltyType: 'visual', penaltyFactor: 0.4 },
  topik_garing: { label: '😴 Topik Garing', penaltyType: 'topic', penaltyFactor: 0.3 },
  timing_buruk: { label: '⏱ Timing Buruk', penaltyType: 'general', penaltyFactor: 0.5 },
  hook_lemah: { label: '🎣 Hook Lemah', penaltyType: 'topic', penaltyFactor: 0.4 },
};

function _buildClipReviewKeyboard(clipId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ APPROVE', callback_data: `clip_approve|${clipId}` },
        { text: '❌ REJECT', callback_data: `clip_reject|${clipId}` },
      ],
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

  if (chatId !== config.telegram.chatId) return;

  await bot.answerCallbackQuery(query.id);

  const separator = String(data || '').includes(':') ? ':' : '|';
  const parts = String(data || '').split(separator);
  const action = parts[0];

  if (!action) return;

  // Actions that require at least one argument (parts[1]) — guard only those
  const REQUIRES_ARG = new Set(['clip_approve', 'clip_reject', 'clip_reject_reason', 'view_all_clips', 'approve_source']);
  if (REQUIRES_ARG.has(action) && !parts[1]) return;

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

    case 'approve_source':
      await _handleApproveSource(chatId, parts[1]);
      break;

    case 'trigger_clipper':
    case 'menu_trigger':
      await _handleTriggerClipper(chatId);
      break;

    case 'check_queue':
    case 'menu_queue':
      await _sendDetailedQueueStats(chatId);
      await _sendMainMenu(chatId);
      break;

    case 'menu_status':
      await _sendDetailedStatus(chatId);
      await _sendMainMenu(chatId);
      break;

    case 'menu_sources':
      await _sendSources(chatId);
      break;

    case 'menu_pending_sources':
      await _sendPendingSources(chatId);
      break;

    case 'menu_clear_orphans':
      await _handleClearOrphans(chatId);
      await _sendMainMenu(chatId);
      break;

    case 'menu_clear_queue':
      await _handleClearQueue(chatId);
      await _sendMainMenu(chatId);
      break;

    case 'menu_clear_dead':
      await _handleClearDead(chatId);
      await _sendMainMenu(chatId);
      break;

    case 'menu_clear_memory':
      await _handleClearMemory(chatId);
      await _sendMainMenu(chatId);
      break;

    case 'menu_reset_test':
      // Intentionally does NOT run reset — triggers the confirmation flow
      await _handleResetTest(chatId);
      break;

    case 'menu_help':
      await _sendHelp(chatId);
      break;

    default:
      logger.warn('Callback action tidak dikenal', { agent: AGENT, action });
  }
}

// ─── Clip approve ─────────────────────────────────────────────────────────────

async function _handleClipApprove(chatId, clipId) {
  logger.info('Clip di-APPROVE', { agent: AGENT, clipId });

  updateClip(clipId, {
    status: 'approved',
    approved_at: new Date().toISOString(),
  });

  const clipDb = getClip(clipId);

  await _sendMessage(
    chatId,
    `✅ Clip ${_code(clipId)} di\\-approve\\. Mengirim file\\.\\.\\.`,
    { parse_mode: 'MarkdownV2' }
  );

  try {
    if (config.dryRun) {
      await _sendMessage(
        chatId,
        `🔵 \\[DRY\\_RUN\\] Clip tidak dikirim \\(mock file\\)\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    } else {
      if (!clipDb?.final_video_path || !fs.existsSync(clipDb.final_video_path)) {
        throw new Error(`File clip tidak ditemukan: ${clipDb?.final_video_path}`);
      }

      const approvedCaption = `🎬 Clip Approved\n\n` +
        `📁 File: ${_code(path.basename(clipDb.final_video_path))}\n` +
        `⏱ Duration: ${_escape(_number(clipDb.duration_sec, 0).toFixed(1))}s\n` +
        `🎯 Hook: ${_escape(clipDb.hook_type || '-')}\n` +
        `⭐ Score: ${_escape(_number(clipDb.score, 0))}/100\n\n` +
        `Download dan upload ke YouTube Shorts\\.`;

      await bot.sendDocument(chatId, clipDb.final_video_path, {
        caption: approvedCaption,
        parse_mode: 'MarkdownV2',
      });
    }

    updateClip(clipId, { status: 'uploaded' });

    await _sendMessage(
      chatId,
      '📊 Upload manual ke YouTube Shorts\\. Kirim CSV analytics nanti untuk tracking performa\\.',
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    logger.error('Gagal mengirim clip ke Telegram', {
      agent: AGENT,
      clipId,
      error_message: err.message,
    });

    await _sendMessage(
      chatId,
      `⚠️ Gagal kirim clip: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// ─── Clip reject ──────────────────────────────────────────────────────────────

async function _handleClipRejectStart(chatId, clipId) {
  _setPendingState(chatId, {
    action: 'clip_reject',
    clip_id: clipId,
  });

  await _sendMessage(
    chatId,
    `❌ Ketik alasan reject untuk clip ${_code(clipId)} \\(atau ketik ${_code('/skip')} untuk skip alasan\\):`,
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

  logger.info('Clip di-REJECT (manual)', {
    agent: AGENT,
    clipId,
    reason,
  });

  await _sendMessage(
    chatId,
    `❌ Clip ${_code(clipId)} di\\-reject\\.\n📝 Alasan: ${_escape(reason)}`,
    { parse_mode: 'MarkdownV2' }
  );
}

async function _handleClipStructuredReject(chatId, clipId, reasonKey) {
  const reason = CLIP_REJECT_REASONS[reasonKey];

  if (!reason) {
    await _sendMessage(
      chatId,
      `⚠️ Alasan tidak dikenal: ${_escape(reasonKey)}`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const clipDb = getClip(clipId);
  if (!clipDb) {
    await _sendMessage(
      chatId,
      `⚠️ Clip tidak ditemukan: ${_code(clipId)}`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  updateClip(clipId, {
    status: 'rejected',
    rejected_at: new Date().toISOString(),
    reject_reason: reason.label,
  });

  logger.info('Clip di-REJECT (structured)', {
    agent: AGENT,
    clipId,
    reason: reasonKey,
    penaltyType: reason.penaltyType,
  });

  const correlationId = clipDb.correlation_id || uuidv4();

  pushJob(
    'memory_penalty',
    {
      clip_id: clipId,
      correlation_id: correlationId,
      penalty_type: reason.penaltyType,
      penalty_factor: reason.penaltyFactor,
      reason_label: reason.label,
    },
    {
      correlationId,
      priority: 'high',
    }
  );

  logger.info('Memory penalty job dikirim', {
    agent: AGENT,
    clipId,
    reasonKey,
  });

  await _sendMessage(
    chatId,
    `${_escape(reason.label)} — Clip ${_code(clipId)} di\\-reject\\.\n` +
      `📉 Penalti akan diterapkan ke pattern: _${_escape(clipDb.hook_type || 'unknown')}_`,
    { parse_mode: 'MarkdownV2' }
  );
}

// ─── View all clips from source ───────────────────────────────────────────────

async function _handleViewAllClips(chatId, clipId) {
  const clipDb = getClip(clipId);

  if (!clipDb) {
    await _sendMessage(
      chatId,
      '⚠️ Clip tidak ditemukan',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const allClips = getClipsBySourceVideo(clipDb.source_video_id);
  const sourceVideo = getSourceVideo(clipDb.source_video_id);

  let msg = `📊 *All Clips from Source*\n\n` +
    `📺 *Source:* ${_escape(sourceVideo?.video_title || '-')}\n` +
    `📌 *Channel:* ${_escape(sourceVideo?.channel_title || '-')}\n` +
    `🎬 *Total Clips:* ${_escape(allClips.length)}\n\n`;

  for (const clip of allClips) {
    const statusEmoji = {
      pending: '⏳',
      pending_review: '👀',
      approved: '✅',
      rejected: '❌',
      uploaded: '📤',
      manual_review: '⚠️',
    }[clip.status] || '❓';

    msg += `${statusEmoji} ${_code(String(clip.id).slice(0, 8))} \\- ` +
      `${_escape(clip.hook_type || '-')} \\- ` +
      `${_escape(_number(clip.score, 0))}/100 \\- ` +
      `${_escape(_number(clip.duration_sec, 0).toFixed(1))}s\n`;
  }

  await _sendMessage(chatId, msg, {
    parse_mode: 'MarkdownV2',
  });
}

// ─── Trigger clipper ──────────────────────────────────────────────────────────

async function _handleTriggerClipper(chatId) {
  _setPendingState(chatId, { action: 'trigger_clipper' });

  await _sendMessage(
    chatId,
    '🎬 Kirim YouTube URL untuk di\\-clip:',
    { parse_mode: 'MarkdownV2' }
  );
}

async function _handleTriggerClipperConfirm(chatId, url) {
  const state = pendingState.get(chatId);
  if (state?.action === 'trigger_clipper') {
    _clearPendingState(chatId);
  }

  if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
    await _sendMessage(
      chatId,
      '⚠️ URL harus berupa YouTube URL',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  await _sendMessage(
    chatId,
    `🔄 Memulai clipper pipeline untuk:\n${_escape(url)}`,
    { parse_mode: 'MarkdownV2' }
  );

  try {
    const { triggerSourceIngest } = require('../agents/source_ingest');

    await triggerSourceIngest(url);

    await _sendMessage(
      chatId,
      '✅ Pipeline dimulai\\! Monitor progress di logs\\.',
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    await _sendMessage(
      chatId,
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

  if (msg.document) {
    await _handleDocumentUpload(msg);
    return;
  }

  if (!text) return;

  const state = pendingState.get(chatId);

  if (state) {
    if (text === '/skip') {
      _clearPendingState(chatId);

      await _sendMessage(
        chatId,
        'Aksi dibatalkan\\.',
        { parse_mode: 'MarkdownV2' }
      );

      return;
    }

    switch (state.action) {
      case 'clip_reject':
        await _handleClipRejectConfirm(chatId, text);
        return;

      case 'trigger_clipper':
        await _handleTriggerClipperConfirm(chatId, text);
        return;

      default:
        break;
    }
  }

  if (text.startsWith('/')) {
    await _handleCommand(chatId, text, msg);
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
      await _sendDetailedStatus(chatId);
      break;

    case '/queue':
      await _sendDetailedQueueStats(chatId);
      break;

    case '/trigger':
      if (args.length > 0) {
        await _handleTriggerClipperConfirm(chatId, args[0]);
      } else {
        await _handleTriggerClipper(chatId, msg);
      }
      break;

    case '/approve_source':
      if (args.length > 0) {
        await _handleApproveSource(chatId, args[0]);
      } else {
        await _sendMessage(
          chatId,
          `⚠️ Usage: ${_code('/approve_source <source_video_id>')}`,
          { parse_mode: 'MarkdownV2' }
        );
      }
      break;

    case '/sources':
      await _sendSources(chatId);
      break;

    case '/pending_sources':
      await _sendPendingSources(chatId);
      break;

    case '/clear_queue':
      await _handleClearQueue(chatId);
      break;

    case '/clear_dead':
      await _handleClearDead(chatId);
      break;

    case '/clear_memory':
      await _handleClearMemory(chatId);
      break;

    case '/clear_orphans':
      await _handleClearOrphans(chatId);
      break;

    case '/reset_test':
      await _handleResetTest(chatId);
      break;

    case 'CONFIRM_RESET':
      await _handleResetTestConfirm(chatId);
      break;

    default:
      await _sendMessage(
        chatId,
        `❓ Perintah tidak dikenal: ${_escape(cmd)}\n\nKetik ${_code('/help')} untuk melihat daftar perintah\\.`,
        { parse_mode: 'MarkdownV2' }
      );
  }
}

// ─── CSV analytics upload ─────────────────────────────────────────────────────

async function _handleDocumentUpload(msg) {
  const doc = msg.document;

  if (!doc.file_name?.endsWith('.csv')) {
    await _sendMessage(
      msg.chat.id,
      '⚠️ Hanya file CSV yang diterima untuk analytics\\.',
      { parse_mode: 'MarkdownV2' }
    );

    return;
  }

  logger.info('CSV analytics diterima via Telegram', { agent: AGENT });

  await _sendMessage(
    msg.chat.id,
    '📊 Memproses file analytics CSV\\.\\.\\.',
    { parse_mode: 'MarkdownV2' }
  );

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const axios = require('axios');
    const res = await axios.get(fileLink, { responseType: 'arraybuffer' });

    const csvPath = path.join(config.paths.output, `analytics_${Date.now()}.csv`);
    fs.writeFileSync(csvPath, res.data);

    const correlationId = uuidv4();

    pushJob(
      'analytics',
      {
        csv_path: csvPath,
        correlation_id: correlationId,
      },
      {
        correlationId,
        priority: 'normal',
      }
    );

    await _sendMessage(
      msg.chat.id,
      `✅ CSV diterima dan dijadwalkan untuk diproses\\.\nJob ID: ${_code(correlationId)}`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    logger.error('Gagal memproses CSV analytics', {
      agent: AGENT,
      error_message: err.message,
    });

    await _sendMessage(
      msg.chat.id,
      `❌ Gagal: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// ─── Approve source ───────────────────────────────────────────────────────────

async function _handleApproveSource(chatId, sourceVideoId) {
  try {
    const {
      updateSourceVideo,
      getClipsBySourceVideo: getClipsForSource,
      getSourceVideo: getSourceById,
    } = require('../utils/db');

    const sourceVideo = getSourceById(sourceVideoId);

    if (!sourceVideo) {
      await _sendMessage(
        chatId,
        `❌ Source video tidak ditemukan: ${_code(sourceVideoId)}`,
        { parse_mode: 'MarkdownV2' }
      );

      return;
    }

    updateSourceVideo(sourceVideoId, {
      permission_status: 'approved',
      allowed_to_clip: 1,
      risk_level: 'low',
      risk_notes: 'Manually approved by user via Telegram',
    });

    const clips = getClipsForSource(sourceVideoId);
    const manualReviewClips = clips.filter((c) => c.status === 'manual_review');

    let reEnqueuedCount = 0;

    for (const clip of manualReviewClips) {
      pushJob(
        'clip_render',
        {
          clip_id: clip.id,
          source_video_id: sourceVideoId,
          correlation_id: clip.correlation_id,
        },
        {
          correlationId: clip.correlation_id || uuidv4(),
          priority: 'normal',
        }
      );

      reEnqueuedCount++;
    }

    await _sendMessage(
      chatId,
      `✅ Source video disetujui\\!\n\n` +
        `ID: ${_code(sourceVideoId)}\n` +
        `Title: ${_escape(sourceVideo.video_title || 'N/A')}\n` +
        `Channel: ${_escape(sourceVideo.channel_title || 'N/A')}\n\n` +
        `Clips dari source ini sekarang bisa dirender\\.\n` +
        `Re\\-enqueued ${_escape(reEnqueuedCount)} clip\\(s\\) untuk rendering\\.`,
      { parse_mode: 'MarkdownV2' }
    );

    logger.info('Source video approved via Telegram', {
      agent: AGENT,
      sourceVideoId,
      reEnqueuedClips: reEnqueuedCount,
    });
  } catch (err) {
    logger.error('Gagal approve source', {
      agent: AGENT,
      error_message: err.message,
    });

    await _sendMessage(
      chatId,
      `❌ Error: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// ─── Admin Commands ──────────────────────────────────────────────────────────

async function _handleClearQueue(chatId) {
  try {
    const { clearJobs } = require('../utils/db');
    const count = clearJobs();
    
    await _sendMessage(
      chatId,
      `✅ Queue dibersihkan\\!\n\n` +
        `🗑 ${_escape(count)} job\\(s\\) dihapus dari queue\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    
    logger.info('Queue cleared via Telegram', { agent: AGENT, count });
  } catch (err) {
    logger.error('Gagal clear queue', { agent: AGENT, error_message: err.message });
    await _sendMessage(
      chatId,
      `❌ Error: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

async function _handleClearDead(chatId) {
  try {
    const { clearDeadLetters } = require('../utils/db');
    const count = clearDeadLetters();
    
    await _sendMessage(
      chatId,
      `✅ Dead letter queue dibersihkan\\!\n\n` +
        `🗑 ${_escape(count)} dead letter job\\(s\\) dihapus\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    
    logger.info('Dead letter cleared via Telegram', { agent: AGENT, count });
  } catch (err) {
    logger.error('Gagal clear dead letter', { agent: AGENT, error_message: err.message });
    await _sendMessage(
      chatId,
      `❌ Error: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

async function _handleClearMemory(chatId) {
  try {
    const { clearMemory } = require('../utils/db');
    const count = clearMemory();
    
    await _sendMessage(
      chatId,
      `✅ Memory dibersihkan\\!\n\n` +
        `🗑 ${_escape(count)} memory pattern\\(s\\) dihapus\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    
    logger.info('Memory cleared via Telegram', { agent: AGENT, count });
  } catch (err) {
    logger.error('Gagal clear memory', { agent: AGENT, error_message: err.message });
    await _sendMessage(
      chatId,
      `❌ Error: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

async function _handleClearOrphans(chatId) {
  try {
    const { findOrphanJobs, deleteJobsByIds } = require('../utils/db');
    
    await _sendMessage(
      chatId,
      '🔍 Mencari orphan jobs\\.\\.\\.',
      { parse_mode: 'MarkdownV2' }
    );
    
    const orphans = findOrphanJobs();
    
    if (orphans.length === 0) {
      await _sendMessage(
        chatId,
        '✅ Tidak ada orphan jobs ditemukan\\.',
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }
    
    // Group by reason
    const byReason = {};
    const byType = {};
    
    for (const { job, reason } of orphans) {
      byReason[reason] = (byReason[reason] || 0) + 1;
      byType[job.type] = (byType[job.type] || 0) + 1;
    }
    
    const jobIds = orphans.map(o => o.job.id);
    const deleted = deleteJobsByIds(jobIds);
    
    let msg = `🗑 *Orphan Jobs Dihapus*\n\n` +
      `Total ditemukan: ${_escape(orphans.length)}\n` +
      `Total dihapus: ${_escape(deleted)}\n\n` +
      `*Breakdown by Reason:*\n`;
    
    for (const [reason, count] of Object.entries(byReason)) {
      msg += `• ${_escape(reason)}: ${_escape(count)}\n`;
    }
    
    msg += `\n*Breakdown by Type:*\n`;
    for (const [type, count] of Object.entries(byType)) {
      msg += `• ${_escape(type)}: ${_escape(count)}\n`;
    }
    
    await _sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
    
    logger.info('Orphan jobs cleared via Telegram', {
      agent: AGENT,
      found: orphans.length,
      deleted,
      byReason,
      byType,
    });
  } catch (err) {
    logger.error('Gagal clear orphans', { agent: AGENT, error_message: err.message, stack: err.stack });
    await _sendMessage(
      chatId,
      `❌ Error: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

async function _handleResetTest(chatId) {
  confirmationState.set(chatId, {
    action: 'reset_test',
    timestamp: Date.now(),
  });
  
  setTimeout(() => {
    confirmationState.delete(chatId);
  }, 60000); // 1 minute timeout
  
  await _sendMessage(
    chatId,
    `⚠️ *DESTRUCTIVE OPERATION*\n\n` +
      `Ini akan menghapus:\n` +
      `• Semua jobs\n` +
      `• Semua dead\\_letter\n` +
      `• Semua source\\_videos\n` +
      `• Semua clips\n` +
      `• Semua analytics\n` +
      `• Semua memory\n` +
      `• Folder output/ dan cache/ \\(jika aman\\)\n\n` +
      `Ketik ${_code('CONFIRM_RESET')} dalam 1 menit untuk melanjutkan\\.\n` +
      `Atau ketik ${_code('/skip')} untuk membatalkan\\.`,
    { parse_mode: 'MarkdownV2' }
  );
}

async function _handleResetTestConfirm(chatId) {
  const state = confirmationState.get(chatId);
  
  if (!state || state.action !== 'reset_test') {
    await _sendMessage(
      chatId,
      `⚠️ Tidak ada operasi reset yang menunggu konfirmasi\\.\n\nKetik ${_code('/reset_test')} terlebih dahulu\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }
  
  confirmationState.delete(chatId);
  
  try {
    const { clearAllTestState } = require('../utils/db');
    const fs = require('fs');
    const path = require('path');
    
    await _sendMessage(
      chatId,
      '🗑 Menghapus semua data test\\.\\.\\.',
      { parse_mode: 'MarkdownV2' }
    );
    
    const counts = clearAllTestState();
    
    // Clear output and cache folders
    let filesDeleted = 0;
    
    try {
      const outputPath = config.paths.output;
      if (fs.existsSync(outputPath) && outputPath.includes('output')) {
        const files = fs.readdirSync(outputPath);
        for (const file of files) {
          const filePath = path.join(outputPath, file);
          if (fs.statSync(filePath).isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
            filesDeleted++;
          }
        }
      }
    } catch (e) {
      logger.warn('Gagal hapus output folder', { agent: AGENT, error: e.message });
    }
    
    try {
      const cachePath = config.paths.cache;
      if (fs.existsSync(cachePath) && cachePath.includes('cache')) {
        const files = fs.readdirSync(cachePath);
        for (const file of files) {
          const filePath = path.join(cachePath, file);
          fs.rmSync(filePath, { recursive: true, force: true });
          filesDeleted++;
        }
      }
    } catch (e) {
      logger.warn('Gagal hapus cache folder', { agent: AGENT, error: e.message });
    }
    
    // Recreate folders
    fs.mkdirSync(config.paths.output, { recursive: true });
    fs.mkdirSync(config.paths.cache, { recursive: true });
    
    let msg = `✅ *Test State Reset Complete*\n\n` +
      `*Database Rows Deleted:*\n` +
      `• Jobs: ${_escape(counts.jobs)}\n` +
      `• Dead Letter: ${_escape(counts.dead_letter)}\n` +
      `• Source Videos: ${_escape(counts.source_videos)}\n` +
      `• Clips: ${_escape(counts.clips)}\n` +
      `• Analytics: ${_escape(counts.analytics)}\n` +
      `• Memory: ${_escape(counts.memory)}\n\n` +
      `*Files/Folders Deleted:*\n` +
      `• ${_escape(filesDeleted)} folder\\(s\\) dari output/cache\n\n` +
      `System siap untuk test baru\\.`;
    
    await _sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
    
    logger.info('Test state reset via Telegram', {
      agent: AGENT,
      counts,
      filesDeleted,
    });
  } catch (err) {
    logger.error('Gagal reset test state', { agent: AGENT, error_message: err.message, stack: err.stack });
    await _sendMessage(
      chatId,
      `❌ Error: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// ─── Sources list ────────────────────────────────────────────────────────────

async function _sendSources(chatId) {
  try {
    const db = getDb();
    const sources = db.prepare(`
      SELECT id, video_title, channel_title, status, permission_status, allowed_to_clip, risk_level
      FROM source_videos
      ORDER BY created_at DESC
      LIMIT 10
    `).all();

    if (sources.length === 0) {
      await _sendMessage(chatId, '📭 Tidak ada source video\\.', { parse_mode: 'MarkdownV2' });
      return;
    }

    let msg = `📺 *Source Videos* \\(${_escape(sources.length)} terbaru\\)\n\n`;
    for (const sv of sources) {
      const permEmoji = sv.allowed_to_clip ? '✅' : '⚠️';
      msg += `${permEmoji} ${_escape(sv.video_title || '-')}\n` +
        `  📌 ${_escape(sv.channel_title || '-')}\n` +
        `  🆔 ${_code(sv.id)}\n` +
        `  Status: ${_escape(sv.status)} \\| Perm: ${_escape(sv.permission_status)} \\| Risk: ${_escape(sv.risk_level)}\n\n`;
    }

    await _sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    logger.error('Gagal get sources', { agent: AGENT, error_message: err.message });
    await _sendMessage(chatId, `❌ Error: ${_escape(err.message)}`, { parse_mode: 'MarkdownV2' });
  }
}

async function _sendPendingSources(chatId) {
  try {
    const { getSourcesNeedingApproval } = require('../utils/db');
    const sources = getSourcesNeedingApproval(5);

    if (sources.length === 0) {
      await _sendMessage(chatId, '✅ Tidak ada source yang menunggu approval\\.', { parse_mode: 'MarkdownV2' });
      return;
    }

    let msg = `⚠️ *Sources Menunggu Approval* \\(${_escape(sources.length)}\\)\n\n`;
    const keyboard = [];

    for (const sv of sources) {
      msg += `📺 *${_escape(sv.video_title || '-')}*\n` +
        `  📌 Channel: ${_escape(sv.channel_title || '-')}\n` +
        `  🆔 ID: ${_code(sv.id)}\n` +
        `  Status: ${_escape(sv.status)} \\| Risk: ${_escape(sv.risk_level)}\n`;

      if (sv.risk_notes) {
        msg += `  ⚠️ ${_escape(String(sv.risk_notes).slice(0, 80))}\n`;
      }
      msg += `  Approve: ${_code('/approve_source ' + sv.id)}\n\n`;

      keyboard.push([{ text: `✅ Approve: ${(sv.video_title || sv.id).slice(0, 30)}`, callback_data: `approve_source|${sv.id}` }]);
    }

    await _sendMessage(chatId, msg, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    logger.error('Gagal get pending sources', { agent: AGENT, error_message: err.message });
    await _sendMessage(chatId, `❌ Error: ${_escape(err.message)}`, { parse_mode: 'MarkdownV2' });
  }
}

// ─── Permission blocked notification (called by ClipRenderAgent) ────────────

async function notifyPermissionBlocked(sourceVideoId, sourceVideo) {
  if (!bot) return;

  const title = _escape(sourceVideo.video_title || '-');
  const channel = _escape(sourceVideo.channel_title || '-');
  const riskLevel = _escape(sourceVideo.risk_level || 'unknown');
  const riskNotes = _escape(String(sourceVideo.risk_notes || 'Source permission not verified').slice(0, 100));

  const msg = `⚠️ *Permission Diperlukan*\n\n` +
    `Source video memerlukan approval sebelum bisa di\\-clip:\n\n` +
    `📺 *${title}*\n` +
    `📌 Channel: ${channel}\n` +
    `🆔 ID: ${_code(sourceVideoId)}\n` +
    `⚠️ Risk: ${riskLevel}\n` +
    `📝 ${riskNotes}\n\n` +
    `Gunakan tombol di bawah atau ketik:\n` +
    `${_code('/approve_source ' + sourceVideoId)}`;

  try {
    await _sendMessage(config.telegram.chatId, msg, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve Source', callback_data: `approve_source|${sourceVideoId}` },
          { text: '📋 Pending Sources', callback_data: 'menu_pending_sources' },
        ]],
      },
    });
  } catch (err) {
    logger.warn('notifyPermissionBlocked: gagal kirim pesan', { agent: AGENT, error_message: err.message });
  }
}

// ─── Main menu keyboard ───────────────────────────────────────────────────────

function _buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      // Main commands row
      [
        { text: '🎬 Trigger Clipper', callback_data: 'menu_trigger' },
        { text: '📊 Status',          callback_data: 'menu_status' },
        { text: '📋 Queue',           callback_data: 'menu_queue' },
      ],
      // Sources row
      [
        { text: '📺 Sources',          callback_data: 'menu_sources' },
        { text: '⚠️ Pending Approval', callback_data: 'menu_pending_sources' },
      ],
      // Admin commands row 1
      [
        { text: '🧹 Clear Orphans', callback_data: 'menu_clear_orphans' },
        { text: '🗑 Clear Queue',   callback_data: 'menu_clear_queue' },
      ],
      // Admin commands row 2
      [
        { text: '☠️ Clear Dead',  callback_data: 'menu_clear_dead' },
        { text: '🧠 Clear Memory', callback_data: 'menu_clear_memory' },
      ],
      // Destructive / support row
      [
        { text: '♻️ Reset Test', callback_data: 'menu_reset_test' },
        { text: '❓ Help',        callback_data: 'menu_help' },
      ],
    ],
  };
}

async function _sendMainMenu(chatId) {
  await _sendMessage(
    chatId,
    '📌 *Menu Utama* \\— pilih aksi:',
    { parse_mode: 'MarkdownV2', reply_markup: _buildMainMenuKeyboard() }
  );
}

// ─── Info messages ────────────────────────────────────────────────────────────

async function _sendHelp(chatId) {
  const msg = `🤖 *YouTube AI Clipper v2\\.0*\n\n` +
    `*Main Commands:*\n` +
    `${_code('/trigger')} \\- Start clipper pipeline\n` +
    `${_code('/status')} \\- Detailed system status\n` +
    `${_code('/queue')} \\- Detailed queue stats\n` +
    `${_code('/sources')} \\- List recent source videos\n` +
    `${_code('/pending_sources')} \\- Sources needing approval\n` +
    `${_code('/approve_source <source_video_id>')} \\- Approve source video\n\n` +
    `*Admin Commands:*\n` +
    `${_code('/clear_queue')} \\- Clear all jobs\n` +
    `${_code('/clear_dead')} \\- Clear dead letter queue\n` +
    `${_code('/clear_memory')} \\- Clear memory patterns\n` +
    `${_code('/clear_orphans')} \\- Remove orphan jobs\n` +
    `${_code('/reset_test')} \\- Reset all test state \\(destructive\\)\n\n` +
    `${_code('/help')} \\- Show this message\n\n` +
    `Atau gunakan tombol di bawah:`;

  await _sendMessage(chatId, msg, {
    parse_mode: 'MarkdownV2',
    reply_markup: _buildMainMenuKeyboard(),
  });
}

async function _sendDetailedStatus(chatId) {
  try {
    const { countRows, getDeadLetterSummary } = require('../utils/db');
    const db = getDb();
    
    // Source videos by status
    const sourcesByStatus = db.prepare(`
      SELECT status, COUNT(*) as count 
      FROM source_videos 
      GROUP BY status
    `).all();
    
    // Clips by status
    const clipsByStatus = db.prepare(`
      SELECT status, COUNT(*) as count 
      FROM clips 
      GROUP BY status
    `).all();
    
    // Jobs by type and status
    const jobsByType = db.prepare(`
      SELECT type, status, COUNT(*) as count 
      FROM jobs 
      GROUP BY type, status
    `).all();
    
    const deadLetterSummary = getDeadLetterSummary();
    
    // Calculate orphans (quick check)
    let orphanCount = 0;
    try {
      const { findOrphanJobs } = require('../utils/db');
      orphanCount = findOrphanJobs().length;
    } catch (e) {
      // Ignore if fails
    }
    
    let msg = `📊 *System Status*\n\n`;
    
    // Mode
    msg += `*Mode:* ${config.dryRun ? '🔵 DRY\\_RUN' : '🟢 PRODUCTION'}\n\n`;
    
    // Source Videos
    msg += `*Source Videos:*\n`;
    if (sourcesByStatus.length > 0) {
      for (const row of sourcesByStatus) {
        msg += `• ${_escape(row.status)}: ${_escape(row.count)}\n`;
      }
    } else {
      msg += `• None\n`;
    }
    
    // Clips
    msg += `\n*Clips:*\n`;
    if (clipsByStatus.length > 0) {
      for (const row of clipsByStatus) {
        msg += `• ${_escape(row.status)}: ${_escape(row.count)}\n`;
      }
    } else {
      msg += `• None\n`;
    }
    
    // Jobs summary
    msg += `\n*Jobs:*\n`;
    if (jobsByType.length > 0) {
      const jobSummary = {};
      for (const row of jobsByType) {
        const key = `${row.type}/${row.status}`;
        jobSummary[key] = row.count;
      }
      
      const entries = Object.entries(jobSummary).slice(0, 10);
      for (const [key, count] of entries) {
        msg += `• ${_escape(key)}: ${_escape(count)}\n`;
      }
      
      if (Object.keys(jobSummary).length > 10) {
        msg += `• \\.\\.\\. and ${_escape(Object.keys(jobSummary).length - 10)} more\n`;
      }
    } else {
      msg += `• None\n`;
    }
    
    // Dead letter
    msg += `\n*Dead Letter:* ${_escape(deadLetterSummary.total)}\n`;
    
    // Orphans
    if (orphanCount > 0) {
      msg += `\n⚠️ *Orphan Jobs:* ${_escape(orphanCount)}\n`;
      msg += `Use ${_code('/clear_orphans')} to remove\\.`;
    }
    
    // Recent failures
    if (deadLetterSummary.recent.length > 0) {
      msg += `\n\n*Recent Failures:*\n`;
      for (const item of deadLetterSummary.recent.slice(0, 3)) {
        const errorShort = String(item.error || 'Unknown').slice(0, 50);
        msg += `• ${_escape(item.type)}: ${_escape(errorShort)}\n`;
      }
    }

    // Sources needing approval
    const { getSourcesNeedingApproval } = require('../utils/db');
    const pendingSources = getSourcesNeedingApproval(5);
    if (pendingSources.length > 0) {
      msg += `\n\n⚠️ *Sources Menunggu Approval \\(${_escape(pendingSources.length)}\\):*\n`;
      for (const sv of pendingSources) {
        msg += `• ${_escape(sv.video_title || '-')} \\| ${_escape(sv.risk_level)}\n`;
        msg += `  ${_code('/approve_source ' + sv.id)}\n`;
      }
      msg += `\nAtau gunakan ${_code('/pending_sources')} untuk tombol approve\\.`;
    }

    await _sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    logger.error('Gagal get status', { agent: AGENT, error_message: err.message });
    await _sendMessage(
      chatId,
      `❌ Error: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

async function _sendDetailedQueueStats(chatId) {
  try {
    const { getDetailedJobStats, countRows } = require('../utils/db');
    const stats = getDetailedJobStats();
    
    let msg = `📋 *Queue Stats*\n\n`;
    
    // By status
    if (stats.byStatus.length > 0) {
      msg += `*By Status:*\n`;
      for (const row of stats.byStatus) {
        msg += `• ${_escape(row.status)}: ${_escape(row.count)}\n`;
      }
    } else {
      msg += `Queue kosong\n`;
    }
    
    // By type/status
    if (stats.byTypeStatus.length > 0) {
      msg += `\n*By Type/Status:*\n`;
      for (const row of stats.byTypeStatus.slice(0, 15)) {
        msg += `• ${_escape(row.type)}/${_escape(row.status)}: ${_escape(row.count)}\n`;
      }
      
      if (stats.byTypeStatus.length > 15) {
        msg += `• \\.\\.\\. and ${_escape(stats.byTypeStatus.length - 15)} more\n`;
      }
    }
    
    // Retry stats
    if (stats.retryStats) {
      const avgRetry = Number(stats.retryStats.avg_retry || 0).toFixed(2);
      msg += `\n*Retry Stats:*\n`;
      msg += `• Avg retry: ${_escape(avgRetry)}\n`;
      msg += `• Max retry: ${_escape(stats.retryStats.max_retry || 0)}\n`;
      msg += `• Jobs retried: ${_escape(stats.retryStats.retried_count || 0)}\n`;
    }
    
    // Oldest jobs
    if (stats.oldestPending) {
      const age = _getAge(stats.oldestPending.created_at);
      msg += `\n*Oldest Pending:*\n`;
      msg += `• Type: ${_escape(stats.oldestPending.type)}\n`;
      msg += `• Age: ${_escape(age)}\n`;
    }
    
    if (stats.oldestProcessing) {
      const age = _getAge(stats.oldestProcessing.locked_at);
      msg += `\n*Oldest Processing:*\n`;
      msg += `• Type: ${_escape(stats.oldestProcessing.type)}\n`;
      msg += `• Age: ${_escape(age)}\n`;
    }
    
    // Dead letter count
    const deadCount = countRows('dead_letter');
    if (deadCount > 0) {
      msg += `\n*Dead Letter:* ${_escape(deadCount)}\n`;
    }
    
    await _sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    logger.error('Gagal get queue stats', { agent: AGENT, error_message: err.message });
    await _sendMessage(
      chatId,
      `❌ Error: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

function _getAge(timestamp) {
  if (!timestamp) return 'unknown';
  
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

async function _sendStatus(chatId) {
  // Legacy function - redirect to detailed
  await _sendDetailedStatus(chatId);
}

async function _sendQueueStats(chatId) {
  // Legacy function - redirect to detailed
  await _sendDetailedQueueStats(chatId);
}

// ─── Pending state helpers ────────────────────────────────────────────────────

function _setPendingState(chatId, state) {
  _clearPendingState(chatId);
  pendingState.set(chatId, state);

  const timeout = setTimeout(() => {
    pendingState.delete(chatId);

    _sendMessage(
      chatId,
      '⏱ Sesi input timeout\\. Silakan mulai lagi\\.',
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {});
  }, RESPONSE_TIMEOUT_MS);

  pendingTimeouts.set(chatId, timeout);
}

function _clearPendingState(chatId) {
  pendingState.delete(chatId);

  const timeout = pendingTimeouts.get(chatId);
  if (timeout) {
    clearTimeout(timeout);
    pendingTimeouts.delete(chatId);
  }
}

// ─── Markdown helpers ─────────────────────────────────────────────────────────

function _escape(text) {
  // Telegram MarkdownV2 reserved characters:
  // _ * [ ] ( ) ~ ` > # + - = | { } . !
  return String(text ?? '').replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function _code(text) {
  return `\`${_escape(text)}\``;
}

function _stripMarkdownV2(text) {
  return String(text ?? '')
    .replace(/\\([_*\[\]()~`>#+\-=|{}.!])/g, '$1')
    .replace(/\*/g, '')
    .replace(/_/g, '')
    .replace(/`/g, '');
}

function _number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function _sendMessage(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (err) {
    const message = String(err.message || '');

    if (message.includes("can't parse entities") || message.includes('Bad Request:')) {
      logger.warn('Telegram MarkdownV2 parse gagal, fallback plain text', {
        agent: AGENT,
        error_message: err.message,
      });

      const fallbackOptions = { ...options };
      delete fallbackOptions.parse_mode;

      return bot.sendMessage(chatId, _stripMarkdownV2(text), fallbackOptions);
    }

    throw err;
  }
}

// ─── Notify helper used by other modules ──────────────────────────────────────

async function notify(message) {
  if (!bot) return;

  try {
    await _sendMessage(
      config.telegram.chatId,
      _escape(message),
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    logger.warn('Notif Telegram gagal', {
      agent: AGENT,
      error_message: err.message,
    });
  }
}

async function sendStartupMessage() {
  if (!bot) return;

  const msg = `🤖 *YouTube AI Clipper v2\\.0\\.0 aktif\\!*\n\n` +
    `Mode: ${config.dryRun ? '*DRY\\_RUN*' : '*PRODUCTION*'}\n\n` +
    `Ketik ${_code('/start')} untuk memulai\\.`;

  await _sendMessage(
    config.telegram.chatId,
    msg,
    { parse_mode: 'MarkdownV2' }
  );
}

module.exports = {
  initBot,
  runTelegramAgent,
  notify,
  notifyPermissionBlocked,
  sendStartupMessage,
};
