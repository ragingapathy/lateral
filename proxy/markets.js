/**
 * Market witness integration for Lateral.
 * Polymarket (Gamma API for discovery, CLOB/Data-API-v2 for prices)
 * Kalshi (public read API)
 *
 * Design: markets are witnesses, not oracles. They never touch evidence balance
 * or user confidence. Human confirms every link.
 */

const https = require('https');
const http = require('http');

const PM_GAMMA_URL = 'https://gamma-api.polymarket.com';
const PM_CLOB_URL = 'https://clob.polymarket.com';
const KALSHI_API_URL = 'https://api.elections.kalshi.com';

function get(urlStr, { headers = {}, timeout = 8000 } = {}) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ error: 'bad URL' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', headers, timeout }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', e => resolve({ error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timed out' }); });
    req.end();
  });
}

// ─── Polymarket ────────────────────────────────────────────────────────────────

// Search markets via Gamma API (replaces retiring Data API v1)
async function searchPolymarket(query, limit = 8) {
  const q = encodeURIComponent(query);
  const r = await get(`${PM_GAMMA_URL}/markets?limit=${limit}&offset=0&closed=false&archived=false&order=liquidity&ascending=false&search=${q}`, { timeout: 10000 });
  if (r.error) return { error: r.error };
  if (r.status !== 200) return { error: `HTTP ${r.status}` };
  try {
    const data = JSON.parse(r.body);
    const markets = (data.markets || data || []).map(m => ({
      source: 'polymarket',
      marketId: m.conditionId || m.slug || m.id,
      slug: m.slug || m.conditionId,
      question: m.question || m.title || '(untitled)',
      description: m.description || '',
      category: m.category || '',
      volume: Number(m.volume || m.volumeNum || 0),
      liquidity: Number(m.liquidity || m.liquidityNum || 0),
      endDate: m.endDate || m.closeDate || null,
      outcomes: (m.outcomes || []).map((o, i) => ({
        name: o,
        probability: Number(m.outcomePrices?.[i] || 0),
      })),
      // Best available price from outcomes (YES token probability)
      currentPrice: Number(m.outcomePrices?.[0] || 0),
    }));
    return { markets };
  } catch (e) {
    return { error: `Parse error: ${e.message}` };
  }
}

// Fetch latest price from CLOB / Data-API-v2
async function getPolymarketPrice(marketId) {
  // Try CLOB v2 market endpoint
  const r = await get(`${PM_CLOB_URL}/markets/${marketId}`, { timeout: 8000 });
  if (!r.error && r.status === 200) {
    try {
      const data = JSON.parse(r.body);
      // CLOB returns market with outcomes
      const yesOutcome = (data.outcomes || []).find(o => /yes/i.test(o.name)) || data.outcomes?.[0];
      return {
        currentPrice: Number(yesOutcome?.probability || yesOutcome?.price || data.bestBid || data.midPrice || 0),
        volume: Number(data.volume || 0),
        updatedAt: new Date().toISOString(),
      };
    } catch { /* fall through */ }
  }
  // Fallback: Gamma market detail
  const r2 = await get(`${PM_GAMMA_URL}/markets/${marketId}`, { timeout: 8000 });
  if (!r2.error && r2.status === 200) {
    try {
      const data = JSON.parse(r2.body);
      return {
        currentPrice: Number(data.outcomePrices?.[0] || 0),
        volume: Number(data.volume || 0),
        updatedAt: new Date().toISOString(),
      };
    } catch { /* fall through */ }
  }
  return { error: 'Could not fetch price' };
}

// ─── Kalshi ────────────────────────────────────────────────────────────────────

async function searchKalshi(query, limit = 8) {
  const q = encodeURIComponent(query);
  const r = await get(`${KALSHI_API_URL}/trade-api/v2/markets?limit=${limit}&search_text=${q}&status=open`, { timeout: 10000 });
  if (r.error) return { error: r.error };
  if (r.status !== 200) return { error: `HTTP ${r.status}` };
  try {
    const data = JSON.parse(r.body);
    const markets = (data.markets || []).map(m => ({
      source: 'kalshi',
      marketId: m.ticker || m.id,
      slug: m.ticker,
      question: m.title || m.subtitle || '(untitled)',
      description: m.description || '',
      category: m.category || '',
      volume: Number(m.volume || 0),
      liquidity: Number(m.open_interest || 0),
      endDate: m.close_date || m.expiration_date || null,
      currentPrice: Number(m.last_price || m.yes_ask || 0) * 100, // Kalshi is 0-100 cents
      outcomes: [{ name: 'Yes', probability: Number(m.last_price || 0) * 100 }],
    }));
    return { markets };
  } catch (e) {
    return { error: `Parse error: ${e.message}` };
  }
}

async function getKalshiPrice(marketId) {
  const r = await get(`${KALSHI_API_URL}/trade-api/v2/markets/${marketId}`, { timeout: 8000 });
  if (r.error || r.status !== 200) return { error: r.error || `HTTP ${r.status}` };
  try {
    const data = JSON.parse(r.body);
    const m = data.market || data;
    return {
      currentPrice: Number(m.last_price || m.yes_ask || 0) * 100,
      volume: Number(m.volume || 0),
      updatedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { error: `Parse error: ${e.message}` };
  }
}

// ─── Unified interface ─────────────────────────────────────────────────────────

async function searchMarkets(query, sources = ['polymarket', 'kalshi'], limit = 8) {
  const results = [];
  if (sources.includes('polymarket')) {
    const pm = await searchPolymarket(query, limit);
    if (pm.markets) results.push(...pm.markets);
  }
  if (sources.includes('kalshi')) {
    const k = await searchKalshi(query, limit);
    if (k.markets) results.push(...k.markets);
  }
  // Sort by volume descending
  results.sort((a, b) => b.volume - a.volume);
  return { markets: results.slice(0, limit) };
}

async function refreshMarketPrice(link) {
  if (link.source === 'polymarket') return getPolymarketPrice(link.marketId);
  if (link.source === 'kalshi') return getKalshiPrice(link.marketId);
  return { error: 'Unknown source' };
}

module.exports = { searchMarkets, refreshMarketPrice, searchPolymarket, searchKalshi };
