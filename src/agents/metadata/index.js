'use strict';

const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');
const { extractJson } = require('../../utils/safeJson');
const { withRetry } = require('../../utils/retry');
const { rateLimited } = require('../../utils/rateLimit');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson } = require('../../utils/storage');
const { updateVideo } = require('../../utils/db');
const { validate, OpenRouterMetadataResponse, MetadataOutput } = require('../../schemas');

const AGENT = 'MetadataAgent';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runMetadataAgent() {
  const job = popJob('metadata');
  if (!job) {
    logger.info('Tidak ada job metadata di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Metadata Agent', { agent: AGENT, jobId: job.id });

  try {
    const { video_id, correlation_id } = job.payload;
    if (!video_id) throw new Error('video_id tidak ada di payload');

    const result = await _processMetadata(video_id, correlation_id || job.correlation_id);
    ackJob(job.id);
    logger.info('Metadata Agent selesai', { agent: AGENT, videoId: video_id });

    // Next: Affiliate
    pushJob('affiliate', { video_id, correlation_id: result.correlation_id }, {
      correlationId: result.correlation_id,
      priority: 'normal',
    });
  } catch (err) {
    logger.error('Metadata Agent gagal', {
      agent: AGENT, step: 'runMetadataAgent',
      error_message: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processMetadata(videoId, correlationId) {
  const research = readVideoJson(videoId, 'research.json');
  const script   = readVideoJson(videoId, 'script.json'); // optional — enriches metadata

  if (!research) throw new Error(`research.json tidak ditemukan untuk video ${videoId}`);

  if (config.dryRun) return _mockMetadata(videoId, correlationId, research, script);

  logger.info('Membuat metadata via OpenRouter', { agent: AGENT, step: 'generateMetadata' });

  const metadata = await withRetry(
    () => rateLimited('openrouter', () => _callOpenRouter(research, script), 2000),
    { maxRetry: config.maxRetry, agent: AGENT, step: 'generateMetadata' }
  );

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    ...metadata,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(MetadataOutput, output, AGENT);
  if (!success) throw new Error(`Validasi MetadataOutput gagal: ${error}`);

  writeVideoJson(videoId, 'metadata.json', data);
  updateVideo(videoId, {
    title:       data.title,
    description: data.description,
    hashtags:    JSON.stringify(data.hashtags),
  });

  return data;
}

// ─── OpenRouter call ─────────────────────────────────────────────────────────

async function _callOpenRouter(research, script) {
  // Use script hook as inspiration for title if available
  const hookContext = script?.hook_line
    ? `\nHook viral yang sudah dibuat: "${script.hook_line}"`
    : '';

  const prompt = `Kamu adalah ahli SEO YouTube Indonesia spesialis konten Shorts viral.

Topik: "${research.topic}"
Keywords: ${research.keywords.join(', ')}${hookContext}

Buat metadata YouTube Shorts yang maksimalkan CTR dan watch time.
- Judul: gunakan angka, kata power ("ternyata", "jarang diketahui", "mengejutkan", "gelap"), max 70 karakter
- Deskripsi: 150-200 kata, informatif, natural keyword placement, call to action
- Hashtag: 20-25 tag, mix antara populer (#shorts, #faktaunik) dan niche spesifik
- affiliate_keywords: 3-5 keyword produk yang relevan dengan topik untuk link Shopee

Format JSON persis:
{
  "title": "...",
  "description": "...",
  "hashtags": ["#...", "#..."],
  "affiliate_keywords": ["keyword1", "keyword2"]
}

Hanya JSON, tanpa teks lain.`;

  const res = await axios.post(
    `${config.openrouter.baseUrl}/chat/completions`,
    {
      model: config.openrouter.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1500,
    },
    {
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://youtube-agent.local',
        'X-Title': 'YouTube Shorts Agent',
      },
      timeout: 30000,
    }
  );

  const raw = res.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(raw, 'MetadataAgent');
  if (!parsed) throw new Error('Gagal parse respons OpenRouter untuk metadata');

  const { success, data, error } = validate(OpenRouterMetadataResponse, parsed, AGENT);
  if (!success) throw new Error(`Validasi respons metadata dari OpenRouter gagal: ${error}`);

  return data;
}

// ─── Mock (DRY_RUN) ──────────────────────────────────────────────────────────

function _mockMetadata(videoId, correlationId, research, script) {
  logger.info('[DRY_RUN] Menggunakan data mock untuk Metadata', { agent: AGENT });

  const hook = script?.hook_line || research.topic;

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    title: `FAKTA GELAP: ${hook.slice(0, 55)}`,
    description: `Kamu tidak akan percaya fakta-fakta mengejutkan tentang ${research.topic} ini. Konten ini khusus untuk kamu yang penasaran dengan hal-hal yang jarang diketahui orang.\n\nJangan lupa LIKE dan SUBSCRIBE untuk fakta unik setiap hari!\n\n${research.keywords.join(' ')}`,
    hashtags: ['#faktaunik', '#faktaindonesia', '#shorts', '#faktagelap', '#ilmupengetahuan'],
    affiliate_keywords: research.keywords.slice(0, 3),
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  writeVideoJson(videoId, 'metadata.json', output);
  updateVideo(videoId, {
    title:       output.title,
    description: output.description,
    hashtags:    JSON.stringify(output.hashtags),
  });

  return output;
}

module.exports = { runMetadataAgent };
