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
const { updateVideo, getDb } = require('../utils/db');
const { triggerResearch } = require('../agents/research');

const AGENT = 'TelegramBot';

let bot;

// Pending state for multi-step interactions
// { chatId: { action, video_id, ... } }
const pendingState = new Map();

// Timeout map for pending user responses
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

// ─── Main pipeline entry: kirim video untuk di-review ─────────────────────────

async function runTelegramAgent() {
  const job = popJob('telegram');
  if (!job) {
    logger.info('Tidak ada job telegram di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai pengiriman review ke Telegram', { agent: AGENT, jobId: job.id });

  try {
    const { video_id, correlation_id } = job.payload;
    if (!video_id) throw new Error('video_id tidak ada di payload');

    await _sendVideoForReview(video_id, correlation_id || job.correlation_id);
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

// ─── Send video for review ────────────────────────────────────────────────────

async function _sendVideoForReview(videoId, correlationId) {
  const metadata = readVideoJson(videoId, 'metadata.json');
  const clip = readVideoJson(videoId, 'clip.json');
  const research = readVideoJson(videoId, 'research.json');

  if (!metadata || !clip) throw new Error('Data video tidak lengkap untuk review');

  const description = metadata.description;
  const hashtagStr = metadata.hashtags?.join(' ') || '';

  // Header with keyboard (MarkdownV2)
  const header = `🎬 *VIDEO BARU UNTUK REVIEW*\n\n` +
    `📌 *Topik:* ${_escape(research?.topic || '-')}\n` +
    `📝 *Judul:* ${_escape(metadata.title)}\n` +
    `⏱ *Durasi:* ${_escape(String(clip.duration_seconds))}s\n` +
    `🆔 \`${videoId}\``;

  await bot.sendMessage(config.telegram.chatId, header, {
    parse_mode: 'MarkdownV2',
    reply_markup: _buildReviewKeyboard(videoId),
  });

  // Full description + hashtags as plain text (no parse_mode → no escaping issues)
  const descMsg = `📝 Deskripsi:\n\n${description}\n\n${hashtagStr}`;
  for (const chunk of _splitMessage(descMsg, 4096)) {
    await bot.sendMessage(config.telegram.chatId, chunk);
  }

  logger.info('Video terkirim ke Telegram untuk review', { agent: AGENT, videoId });
}

function _buildReviewKeyboard(videoId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ APPROVE', callback_data: `approve|${videoId}` },
        { text: '❌ REJECT', callback_data: `reject|${videoId}` },
      ],
      [
        { text: '✏️ Edit Judul', callback_data: `edit_title|${videoId}` },
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

  const parts = (data || '').split('|');
  const action = parts[0];
  const videoId = parts[1];

  if (!action || !videoId) return;

  switch (action) {
    case 'approve':
      await _handleApprove(chatId, videoId);
      break;
    case 'reject':
      await _handleRejectStart(chatId, videoId);
      break;
    case 'edit_title':
      await _handleEditTitleStart(chatId, videoId);
      break;
    case 'view_desc':
      await _handleViewDesc(chatId, videoId);
      break;
    default:
      logger.warn('Callback action tidak dikenal', { agent: AGENT, action });
  }
}

// ─── Approve ──────────────────────────────────────────────────────────────────

async function _handleApprove(chatId, videoId) {
  logger.info('Video di-APPROVE', { agent: AGENT, videoId });

  updateVideo(videoId, { status: 'approved', approved_at: new Date().toISOString() });

  const clip = readVideoJson(videoId, 'clip.json');
  const metadata = readVideoJson(videoId, 'metadata.json');

  await bot.sendMessage(chatId,
    `✅ Video \`${videoId}\` di\\-approve\\. Mengirim file video\\.\\.\\.`,
    { parse_mode: 'MarkdownV2' }
  );

  try {
    if (config.dryRun) {
      await bot.sendMessage(chatId,
        `🔵 \\[DRY\\_RUN\\] Video tidak dikirim \\(mock file\\)\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    } else {
      if (!clip?.final_video_path || !fs.existsSync(clip.final_video_path)) {
        throw new Error(`File video tidak ditemukan: ${clip?.final_video_path}`);
      }

      await bot.sendVideo(chatId, clip.final_video_path, {
        caption: `🎬 ${_escape(metadata?.title || videoId)}\n\n📁 \`${videoId}\`\n\nDownload file ini, lalu upload manual ke YouTube\\.`,
        parse_mode: 'MarkdownV2',
        supports_streaming: true,
      });

      // Send full description + hashtags as plain text for copy-paste
      if (metadata?.description) {
        const hashtagStr = metadata.hashtags?.join(' ') || '';
        const descMsg = `📝 Deskripsi:\n\n${metadata.description}\n\n${hashtagStr}`;
        for (const chunk of _splitMessage(descMsg, 4096)) {
          await bot.sendMessage(chatId, chunk);
        }
      }
    }

    updateVideo(videoId, { status: 'uploaded' });

    await bot.sendMessage(chatId,
      '📊 Upload manual ke YouTube setelah file dicek\\. Kirim CSV analytics nanti kalau video sudah punya performa awal\\.',
      { parse_mode: 'MarkdownV2' }
    );

  } catch (err) {
    logger.error('Gagal mengirim video ke Telegram', { agent: AGENT, videoId, error_message: err.message });
    await bot.sendMessage(chatId,
      `⚠️ Gagal kirim video: ${_escape(err.message)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// ─── Reject ───────────────────────────────────────────────────────────────────

async function _handleRejectStart(chatId, videoId) {
  _setPendingState(chatId, { action: 'reject', video_id: videoId });
  await bot.sendMessage(chatId,
    `❌ Ketik alasan reject untuk video \`${videoId}\` \\(atau ketik /skip untuk skip alasan\\):`,
    { parse_mode: 'MarkdownV2' }
  );
}

async function _handleRejectConfirm(chatId, reason) {
  const state = pendingState.get(chatId);
  if (!state || state.action !== 'reject') return;

  const videoId = state.video_id;
  _clearPendingState(chatId);

  updateVideo(videoId, {
    status: 'rejected',
    rejected_at: new Date().toISOString(),
    reject_reason: reason,
  });

  logger.info('Video di-REJECT', { agent: AGENT, videoId, reason });
  await bot.sendMessage(chatId,
    `❌ Video \`${videoId}\` di-reject\\.\n📝 Alasan: ${_escape(reason)}`,
    { parse_mode: 'MarkdownV2' }
  );
}

// ─── Edit Title ───────────────────────────────────────────────────────────────

async function _handleEditTitleStart(chatId, videoId) {
  _setPendingState(chatId, { action: 'edit_title', video_id: videoId });
  const metadata = readVideoJson(videoId, 'metadata.json');
  await bot.sendMessage(chatId,
    `✏️ Judul saat ini:\n*${_escape(metadata?.title || '-')}*\n\nKetik judul baru:`,
    { parse_mode: 'MarkdownV2' }
  );
}

async function _handleEditTitleConfirm(chatId, newTitle) {
  const state = pendingState.get(chatId);
  if (!state || state.action !== 'edit_title') return;

  const videoId = state.video_id;
  _clearPendingState(chatId);

  updateVideo(videoId, { title: newTitle });
  logger.info('Judul video diupdate', { agent: AGENT, videoId, newTitle });

  await bot.sendMessage(chatId,
    `✅ Judul diupdate:\n*${_escape(newTitle)}*`,
    { parse_mode: 'MarkdownV2' }
  );
}

// ─── View description ─────────────────────────────────────────────────────────

async function _handleViewDesc(chatId, videoId) {
  const metadata = readVideoJson(videoId, 'metadata.json');
  const desc = metadata?.description || '-';

  // Split into chunks if needed (Telegram 4096 char limit)
  const chunks = _splitMessage(desc, 3900);
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk);
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
      case 'reject':
        await _handleRejectConfirm(chatId, text);
        return;
      case 'edit_title':
        await _handleEditTitleConfirm(chatId, text);
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
      await bot.sendMessage(chatId, '🔄 Memulai pipeline research\\.\\.\\.',
        { parse_mode: 'MarkdownV2' });
      triggerResearch().catch((e) => {
        bot.sendMessage(chatId, `❌ Error: ${_escape(e.message)}`, { parse_mode: 'MarkdownV2' });
      });
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

async function _sendHelp(chatId) {
  const msg = `🤖 *YouTube Shorts Agent*\n\n` +
    `/trigger \\- Mulai pipeline research sekarang\n` +
    `/status \\- Status videos\n` +
    `/queue \\- Status queue jobs\n` +
    `📊 Kirim file \\.csv untuk input analytics YouTube\n\n` +
    `*Mode:* ${config.dryRun ? '🔵 DRY\\_RUN' : '🟢 PRODUCTION'}`;

  await bot.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
}

async function _sendStatus(chatId) {
  const rows = getDb().prepare(
    `SELECT status, COUNT(*) as count FROM videos GROUP BY status`
  ).all();

  const lines = rows.map((r) => `• ${r.status}: ${r.count}`).join('\n');
  await bot.sendMessage(chatId, `📊 *Status Videos:*\n\n${lines || 'Belum ada video'}`,
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
  // Clear old timeout
  _clearPendingState(chatId);

  pendingState.set(chatId, state);

  // Auto-clear after timeout (rule 43)
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

function _escapeUrl(url) {
  return String(url || '').replace(/[)]/g, '\\$&');
}

function _splitMessage(text, maxLen) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
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

module.exports = { initBot, runTelegramAgent, notify };
