import type { ExchangeId, TimeframeId } from '../shared/types.ts';
import { type RawKline, TIMEFRAME_CONFIG, resampleKlines } from './collectorUtils.ts';

interface FullCacheEntry {
  fetchedAt: number;
  candles: RawKline[];
}

const fullCache = new Map<string, FullCacheEntry>();
const inFlight = new Map<string, Promise<RawKline[]>>();
const MAX_CACHE_ENTRIES = 24;

function setCacheEntry(key: string, entry: FullCacheEntry) {
  if (fullCache.has(key)) fullCache.delete(key);
  fullCache.set(key, entry);
  while (fullCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = fullCache.keys().next().value;
    if (oldestKey === undefined) break;
    fullCache.delete(oldestKey);
  }
}

function getCacheTtlMs(timeframe: TimeframeId): number {
  const ms = TIMEFRAME_CONFIG[timeframe]?.ms || 900_000;
  if (ms >= 24 * 60 * 60 * 1000) return 5 * 60_000; // 5 min for 1d / 1w
  if (ms >= 60 * 60 * 1000) return 60_000; // 1 min for 1h - 12h
  return 20_000; // 20s for intraday < 1h
}

function getTargetBars(timeframe: TimeframeId): number {
  const ms = TIMEFRAME_CONFIG[timeframe]?.ms || 900_000;
  if (timeframe === '1d') return 4500; // Full history back to ~2015
  if (timeframe === '1w') return 700; // Full weekly history back to ~2015
  if (ms >= 4 * 60 * 60 * 1000) return 2400; // ~1-3 years
  if (ms >= 60 * 60 * 1000) return 2000; // ~3-6 months
  return 1500; // deep intraday
}

function dedupeAndSort(list: RawKline[]): RawKline[] {
  const map = new Map<number, RawKline>();
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    if (!Number.isFinite(k.t) || !Number.isFinite(k.c) || k.c <= 0) continue;
    map.set(k.t, k);
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

async function fetchWithRetry(url: string, init?: RequestInit, retries = 2): Promise<Response | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return null;
    } catch {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
  return null;
}

async function fetchBinanceFull(timeframe: TimeframeId): Promise<RawKline[]> {
  const cfg = TIMEFRAME_CONFIG[timeframe];
  if (!cfg?.binanceInterval) return [];
  const target = getTargetBars(timeframe);
  const all: RawKline[] = [];
  let endTime: number | undefined;
  const maxPages = Math.min(4, Math.ceil(target / 1500) + 1);

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      symbol: 'BTCUSDT',
      interval: cfg.binanceInterval,
      limit: '1500',
    });
    if (endTime !== undefined) params.set('endTime', String(endTime));

    const res = await fetchWithRetry(`https://fapi.binance.com/fapi/v1/klines?${params.toString()}`);
    if (!res) break;
    const rows = (await res.json()) as [number, string, string, string, string, string][];
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const r of rows) {
      all.push({
        t: Number(r[0]),
        o: parseFloat(r[1]),
        h: parseFloat(r[2]),
        l: parseFloat(r[3]),
        c: parseFloat(r[4]),
        vol: parseFloat(r[5]),
      });
    }

    const oldest = Number(rows[0][0]);
    if (rows.length < 1500 || all.length >= target) break;
    endTime = oldest - 1;
  }

  return dedupeAndSort(all).slice(-target);
}

async function fetchBybitFull(timeframe: TimeframeId): Promise<RawKline[]> {
  const cfg = TIMEFRAME_CONFIG[timeframe];
  if (!cfg?.bybitInterval) return [];
  const target = getTargetBars(timeframe);
  const all: RawKline[] = [];
  let end: number | undefined;
  const maxPages = Math.min(4, Math.ceil(target / 1000) + 1);

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      category: 'linear',
      symbol: 'BTCUSDT',
      interval: cfg.bybitInterval,
      limit: '1000',
    });
    if (end !== undefined) params.set('end', String(end));

    const res = await fetchWithRetry(`https://api.bybit.com/v5/market/kline?${params.toString()}`);
    if (!res) break;
    const json = (await res.json()) as { retCode?: number; result?: { list?: string[][] } };
    const rows = json.result?.list;
    if (json.retCode !== 0 || !Array.isArray(rows) || rows.length === 0) break;

    for (const r of rows) {
      all.push({
        t: Number(r[0]),
        o: parseFloat(r[1]),
        h: parseFloat(r[2]),
        l: parseFloat(r[3]),
        c: parseFloat(r[4]),
        vol: parseFloat(r[5]),
      });
    }

    // Bybit returns newest-first
    const oldest = Number(rows[rows.length - 1][0]);
    if (rows.length < 1000 || all.length >= target) break;
    end = oldest - 1;
  }

  return dedupeAndSort(all).slice(-target);
}

async function fetchOkxFull(timeframe: TimeframeId): Promise<RawKline[]> {
  const cfg = TIMEFRAME_CONFIG[timeframe];
  if (!cfg?.okxBar) return [];
  const target = getTargetBars(timeframe);
  const all: RawKline[] = [];

  // First call: latest 300 candles from /market/candles
  let oldestTs = 0;
  try {
    const res = await fetchWithRetry(
      `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=${encodeURIComponent(cfg.okxBar)}&limit=300`
    );
    if (res) {
      const json = (await res.json()) as { data?: string[][] };
      const rows = json.data || [];
      for (const r of rows) {
        all.push({
          t: parseInt(r[0], 10),
          o: parseFloat(r[1]),
          h: parseFloat(r[2]),
          l: parseFloat(r[3]),
          c: parseFloat(r[4]),
          vol: parseFloat(r[6]),
        });
      }
      if (rows.length > 0) oldestTs = parseInt(rows[rows.length - 1][0], 10);
    }
  } catch {
    // ignore
  }

  if (oldestTs <= 0) return dedupeAndSort(all);

  // Fetch older history in parallel chunks of 100 candles via /market/history-candles
  const remaining = Math.max(0, target - all.length);
  const maxChunks = timeframe === '1d' ? 24 : timeframe === '1w' ? 5 : Math.min(12, Math.ceil(remaining / 100));
  const chunkSpanMs = 100 * cfg.ms;

  const batchSize = 6;
  for (let startChunk = 0; startChunk < maxChunks; startChunk += batchSize) {
    const tasks: Promise<RawKline[]>[] = [];
    for (let c = startChunk; c < Math.min(maxChunks, startChunk + batchSize); c++) {
      const afterTs = oldestTs - c * chunkSpanMs;
      if (afterTs < 1546300800000) break; // before 2019-01-01
      tasks.push(
        fetchWithRetry(
          `https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=${encodeURIComponent(cfg.okxBar)}&after=${afterTs}&limit=100`
        )
          .then(async (r) => {
            if (!r) return [];
            const j = (await r.json()) as { data?: string[][] };
            return (j.data || []).map((row) => ({
              t: parseInt(row[0], 10),
              o: parseFloat(row[1]),
              h: parseFloat(row[2]),
              l: parseFloat(row[3]),
              c: parseFloat(row[4]),
              vol: parseFloat(row[6]),
            }));
          })
          .catch(() => [])
      );
    }
    if (tasks.length === 0) break;
    const results = await Promise.all(tasks);
    let gotAny = false;
    for (const chunk of results) {
      if (chunk.length > 0) {
        gotAny = true;
        for (const k of chunk) all.push(k);
      }
    }
    if (!gotAny) break;
  }

  return dedupeAndSort(all).slice(-target);
}

async function fetchCoinbaseFull(timeframe: TimeframeId): Promise<RawKline[]> {
  const cfg = TIMEFRAME_CONFIG[timeframe];
  if (!cfg?.coinbaseGranularity) return [];

  const gran = cfg.coinbaseGranularity;
  const granMs = gran * 1000;
  const needsResample = cfg.ms > granMs;
  const target = getTargetBars(timeframe);
  const ratio = Math.max(1, Math.round(cfg.ms / granMs));
  const neededBaseBars = Math.min(4500, target * ratio);
  const chunkSize = 300;
  const totalChunks = Math.min(15, Math.ceil(neededBaseBars / chunkSize));

  const now = Date.now();
  const all: RawKline[] = [];
  const batchSize = 3;

  for (let startChunk = 0; startChunk < totalChunks; startChunk += batchSize) {
    const tasks: Promise<RawKline[]>[] = [];
    for (let c = startChunk; c < Math.min(totalChunks, startChunk + batchSize); c++) {
      const endMs = now - c * chunkSize * granMs;
      const startMs = endMs - (chunkSize - 1) * granMs;
      if (endMs < 1420070400000) break; // before 2015-01-01
      const params = new URLSearchParams({
        granularity: String(gran),
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      });
      tasks.push(
        fetchWithRetry(
          `https://api.exchange.coinbase.com/products/BTC-USD/candles?${params.toString()}`
        )
          .then(async (r) => {
            if (!r) return [];
            const rows = (await r.json()) as number[][];
            if (!Array.isArray(rows)) return [];
            return rows
              .filter((row) => Array.isArray(row) && row.length >= 6)
              .map((row) => ({
                t: Number(row[0]) * 1000,
                l: Number(row[1]),
                h: Number(row[2]),
                o: Number(row[3]),
                c: Number(row[4]),
                vol: Number(row[5]),
              }));
          })
          .catch(() => [])
      );
    }
    if (tasks.length === 0) break;
    const results = await Promise.all(tasks);
    let gotAny = false;
    for (const chunk of results) {
      if (chunk.length > 0) {
        gotAny = true;
        for (const k of chunk) all.push(k);
      }
    }
    if (!gotAny) break;
    if (startChunk + batchSize < totalChunks) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const sorted = dedupeAndSort(all);
  const finalCandles = needsResample ? resampleKlines(sorted, cfg.ms) : sorted;
  return finalCandles.slice(-target);
}

async function fetchHyperliquidFull(timeframe: TimeframeId): Promise<RawKline[]> {
  const cfg = TIMEFRAME_CONFIG[timeframe];
  if (!cfg?.hlInterval) return [];
  const target = getTargetBars(timeframe);
  const now = Date.now();
  const isFullDailyOrWeekly = timeframe === '1d' || timeframe === '1w';
  const rawIntervalMs = timeframe === '6h' ? 2 * 60 * 60 * 1000 : cfg.ms;
  const startTime = isFullDailyOrWeekly
    ? 1672531200000 // 2023-01-01 (before HL mainnet)
    : now - Math.min(4800, target * (timeframe === '6h' ? 3 : 1)) * rawIntervalMs;

  try {
    const res = await fetchWithRetry('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: {
          coin: 'BTC',
          interval: cfg.hlInterval,
          startTime,
          endTime: now,
        },
      }),
    });
    if (!res) return [];
    const rows = (await res.json()) as {
      t: number;
      o: string;
      h: string;
      l: string;
      c: string;
      v: string;
    }[];
    if (!Array.isArray(rows)) return [];
    const parsed: RawKline[] = rows.map((r) => ({
      t: Number(r.t),
      o: parseFloat(r.o),
      h: parseFloat(r.h),
      l: parseFloat(r.l),
      c: parseFloat(r.c),
      vol: parseFloat(r.v),
    }));
    const sorted = dedupeAndSort(parsed);
    const out = timeframe === '6h' ? resampleKlines(sorted, cfg.ms) : sorted;
    return out.slice(-target);
  } catch {
    return [];
  }
}

async function fetchCombinedFull(timeframe: TimeframeId): Promise<RawKline[]> {
  const bucketMs = TIMEFRAME_CONFIG[timeframe]?.ms || 900_000;
  // Align timestamps cleanly to UTC timeframe boundaries (e.g. OKX 1d/1w uses UTC+8 16:00 UTC)
  // Unix epoch 1970-01-01 was Thursday; shift 1w by 3 days so weeks align on Monday 00:00 UTC
  const weekOffsetMs = 3 * 24 * 60 * 60 * 1000;
  const alignTs = (t: number) =>
    timeframe === '1w'
      ? Math.floor((t + weekOffsetMs) / bucketMs) * bucketMs - weekOffsetMs
      : Math.floor(t / bucketMs) * bucketMs;

  const sets = await Promise.all([
    fetchFullExchangeCandles('binance', timeframe),
    fetchFullExchangeCandles('bybit', timeframe),
    fetchFullExchangeCandles('okx', timeframe),
    fetchFullExchangeCandles('coinbase', timeframe),
    fetchFullExchangeCandles('hyperliquid', timeframe),
  ]);

  const maps = sets.map((arr) => {
    const m = new Map<number, RawKline>();
    for (const k of arr) m.set(alignTs(k.t), k);
    return m;
  });

  const tsSet = new Set<number>();
  for (const m of maps) {
    for (const t of m.keys()) tsSet.add(t);
  }
  const sortedTs = Array.from(tsSet).sort((a, b) => a - b);

  const merged: RawKline[] = [];
  for (const t of sortedTs) {
    let count = 0;
    let sumO = 0;
    let sumC = 0;
    let maxH = -Infinity;
    let minL = Infinity;
    let sumVol = 0;
    for (const m of maps) {
      const k = m.get(t);
      if (!k) continue;
      count++;
      sumO += k.o;
      sumC += k.c;
      if (k.h > maxH) maxH = k.h;
      if (k.l < minL) minL = k.l;
      sumVol += k.vol;
    }
    if (count === 0) continue;
    merged.push({
      t,
      o: +(sumO / count).toFixed(2),
      h: maxH,
      l: minL,
      c: +(sumC / count).toFixed(2),
      vol: +sumVol.toFixed(3),
    });
  }

  return merged.slice(-getTargetBars(timeframe));
}

export async function fetchFullExchangeCandles(
  exchange: ExchangeId,
  timeframe: TimeframeId,
  liveLastPrice = 0
): Promise<RawKline[]> {
  const key = `${exchange}:${timeframe}`;
  const ttl = getCacheTtlMs(timeframe);
  const now = Date.now();
  const cached = fullCache.get(key);

  let candles: RawKline[];
  if (cached && now - cached.fetchedAt < ttl && cached.candles.length > 0) {
    candles = cached.candles;
  } else {
    let promise = inFlight.get(key);
    if (!promise) {
      promise = (async () => {
        if (exchange === 'binance') return fetchBinanceFull(timeframe);
        if (exchange === 'bybit') return fetchBybitFull(timeframe);
        if (exchange === 'okx') return fetchOkxFull(timeframe);
        if (exchange === 'coinbase') return fetchCoinbaseFull(timeframe);
        if (exchange === 'hyperliquid') return fetchHyperliquidFull(timeframe);
        return fetchCombinedFull(timeframe);
      })();
      inFlight.set(key, promise);
    }
    try {
      const fetched = await promise;
      if (fetched.length > 0) {
        setCacheEntry(key, { fetchedAt: Date.now(), candles: fetched });
        candles = fetched;
      } else {
        candles = cached?.candles || [];
      }
    } finally {
      inFlight.delete(key);
    }
  }

  if (candles.length > 0 && liveLastPrice > 0) {
    const copy = candles.slice();
    const last = { ...copy[copy.length - 1] };
    if (liveLastPrice > last.h) last.h = liveLastPrice;
    if (liveLastPrice < last.l) last.l = liveLastPrice;
    last.c = liveLastPrice;
    copy[copy.length - 1] = last;
    return copy;
  }

  return candles;
}
