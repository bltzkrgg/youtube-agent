'use strict';

const config = require('../../config');
const logger = require('../../utils/logger');
const { popJob, ackJob, nackJob, pushJob } = require('../../utils/queue');
const { readVideoJson, writeVideoJson } = require('../../utils/storage');
const { getShopeeLinks } = require('../../utils/db');
const { validate, AffiliateOutput } = require('../../schemas');

const AGENT = 'AffiliateAgent';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function runAffiliateAgent() {
  const job = popJob('affiliate');
  if (!job) {
    logger.info('Tidak ada job affiliate di queue', { agent: AGENT });
    return;
  }

  logger.info('Memulai Affiliate Agent', { agent: AGENT, jobId: job.id });

  try {
    const { video_id, correlation_id } = job.payload;
    if (!video_id) throw new Error('video_id tidak ada di payload');

    const result = await _processAffiliate(video_id, correlation_id || job.correlation_id);

    ackJob(job.id);
    logger.info('Affiliate Agent selesai', { agent: AGENT, videoId: video_id });

    // Push next: voiceover
    pushJob('voiceover', { video_id, correlation_id: result.correlation_id }, {
      correlationId: result.correlation_id,
      priority: 'normal',
    });
  } catch (err) {
    logger.error('Affiliate Agent gagal', {
      agent: AGENT,
      step: 'runAffiliateAgent',
      error_message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    });
    nackJob(job, err.message);
  }
}

// ─── Core processing ─────────────────────────────────────────────────────────

async function _processAffiliate(videoId, correlationId) {
  const metadata = readVideoJson(videoId, 'metadata.json');
  if (!metadata) throw new Error(`metadata.json tidak ditemukan untuk video ${videoId}`);

  const affiliateKeywords = metadata.affiliate_keywords || [];

  // Find matching Shopee links from DB
  const links = _findMatchingLinks(affiliateKeywords);

  // Build formatted description with affiliate links
  const formattedDescription = _buildDescription(metadata.description, links);

  const output = {
    video_id: videoId,
    correlation_id: correlationId,
    links,
    formatted_description: formattedDescription,
    version: '1.0',
    created_at: new Date().toISOString(),
  };

  const { success, data, error } = validate(AffiliateOutput, output, AGENT);
  if (!success) throw new Error(`Validasi output Affiliate gagal: ${error}`);

  writeVideoJson(videoId, 'affiliate.json', data);
  logger.info(`${links.length} Shopee link ditambahkan ke deskripsi`, { agent: AGENT, videoId });

  return data;
}

// ─── Match links by keyword ───────────────────────────────────────────────────

function _findMatchingLinks(keywords) {
  if (!keywords || keywords.length === 0) {
    // Return all active links if no keyword
    return getShopeeLinks().slice(0, 3).map((row) => ({
      keyword: row.keyword,
      url: row.url,
      description: row.description || '',
    }));
  }

  const matched = [];
  const seen = new Set();

  for (const kw of keywords) {
    const rows = getShopeeLinks(kw);
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        matched.push({
          keyword: row.keyword,
          url: row.url,
          description: row.description || '',
        });
      }
      if (matched.length >= 5) break;
    }
    if (matched.length >= 5) break;
  }

  // Fallback: add generic links if not enough
  if (matched.length < 2) {
    const generic = getShopeeLinks().filter((r) => !seen.has(r.id)).slice(0, 3);
    for (const row of generic) {
      matched.push({ keyword: row.keyword, url: row.url, description: row.description || '' });
    }
  }

  return matched.slice(0, 5);
}

// ─── Format description ───────────────────────────────────────────────────────

function _buildDescription(baseDescription, links) {
  if (links.length === 0) return baseDescription;

  const linksSection = links
    .map((l) => `🛍️ ${l.description || l.keyword}: ${l.url}`)
    .join('\n');

  return `${baseDescription}\n\n---\n🔗 PRODUK TERKAIT:\n${linksSection}\n\n(Link affiliate Shopee — kami mendapat komisi kecil jika kamu berbelanja)`;
}

module.exports = { runAffiliateAgent };
