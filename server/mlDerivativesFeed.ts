import type { TimeframeId } from '../shared/types.ts';
import type { RawKline } from './collectorUtils.ts';

export interface DerivPoint {
  t: number;
  v: number;
}

export interface HtfSummaryPoint {
  /** Close timestamp of the completed higher-TF candle (strictly causal!) */
  closeT: number;
  distMa50: number;
  rsi14: number;
  atrRatio: number;
}

interface DerivCacheEntry {
  fetchedAt: number;
  interval: '1h' | '4h' | '1d';
  takerBuyMap: Map<number, { vol: number; tbv: number }>;
  spotMap: Map<number, { vol: number; tbv: number }>;
  fundingSeries: DerivPoint[];
  basisSeries: DerivPoint[];
  oiSeries: DerivPoint[];
  htfSeries: HtfSummaryPoint[];
}

const CACHE_TTL_MS = 120_000;
const PREWARM_INTERVAL_MS = 50_000;
const derivCache = new Map<string, DerivCacheEntry>();
const inFlight = new Map<string, Promise<DerivCacheEntry | null>>();

function mapTfToDerivInterval(tf: TimeframeId): '1h' | '4h' | '1d' {
  if (tf === '1d') return '1d';
  if (tf === '4h') return '4h';
  return '1h';
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 4500): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'BTC-Orderbook-Heatmap/1.0' },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strictly causal alignment: returns the value of the latest point with `p.t <= targetTimeMs`,
 * using binary search in O(log N). Never peeks into future points!
 */
export function lookupLatestCausal(series: DerivPoint[], targetTimeMs: number): number | undefined {
  const n = series.length;
  if (n === 0 || targetTimeMs < series[0].t) return undefined;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid].t <= targetTimeMs) lo = mid;
    else hi = mid - 1;
  }
  return series[lo].v;
}

export function lookupLatestCausalHtf(
  series: HtfSummaryPoint[],
  targetTimeMs: number
): HtfSummaryPoint | undefined {
  const n = series.length;
  if (n === 0 || targetTimeMs < series[0].closeT) return undefined;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid].closeT <= targetTimeMs) lo = mid;
    else hi = mid - 1;
  }
  return series[lo];
}

/**
 * Computes strictly causal completed Higher-Timeframe indicator snapshots (`distMa50`, `rsi14`, `atrRatio`)
 * indexed by each HTF candle's CLOSE time (`bar.t + htfIntervalMs`), guaranteeing zero look-ahead.
 */
export function buildCausalHtfSummarySeries(
  htfCandles: RawKline[],
  htfIntervalMs: number
): HtfSummaryPoint[] {
  const n = htfCandles.length;
  if (n < 20) return [];
  const out: HtfSummaryPoint[] = [];

  // Wilder RSI14
  const rsi = new Array<number>(n).fill(50);
  if (n > 14) {
    let avgG = 0;
    let avgL = 0;
    for (let i = 1; i <= 14; i++) {
      const d = htfCandles[i].c - htfCandles[i - 1].c;
      if (d > 0) avgG += d;
      else avgL -= d;
    }
    avgG /= 14;
    avgL /= 14;
    rsi[14] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (let i = 15; i < n; i++) {
      const d = htfCandles[i].c - htfCandles[i - 1].c;
      avgG = (avgG * 13 + (d > 0 ? d : 0)) / 14;
      avgL = (avgL * 13 + (d < 0 ? -d : 0)) / 14;
      rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
  }

  // True ranges for ATR14 / ATR50
  const tr = new Array<number>(n).fill(0);
  tr[0] = Math.max(1, htfCandles[0].h - htfCandles[0].l);
  for (let i = 1; i < n; i++) {
    const c = htfCandles[i];
    const pc = htfCandles[i - 1].c;
    tr[i] = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  }

  for (let i = 0; i < n; i++) {
    const maStart = Math.max(0, i - 49);
    let maSum = 0;
    for (let j = maStart; j <= i; j++) maSum += htfCandles[j].c;
    const ma50 = maSum / (i - maStart + 1);
    const distMa50 = ma50 > 1e-6 ? ((htfCandles[i].c - ma50) / ma50) * 100 : 0;

    const a14Start = Math.max(0, i - 13);
    let a14Sum = 0;
    for (let j = a14Start; j <= i; j++) a14Sum += tr[j];
    const atr14 = a14Sum / (i - a14Start + 1);

    const a50Start = Math.max(0, i - 49);
    let a50Sum = 0;
    for (let j = a50Start; j <= i; j++) a50Sum += tr[j];
    const atr50 = a50Sum / (i - a50Start + 1);
    const atrRatio = atr50 > 1e-6 ? atr14 / atr50 : 1;

    out.push({
      closeT: htfCandles[i].t + htfIntervalMs,
      distMa50,
      rsi14: rsi[i],
      atrRatio,
    });
  }
  return out;
}

async function fetchLiveDerivativesBundle(interval: '1h' | '4h' | '1d'): Promise<DerivCacheEntry | null> {
  const barLimit = 240;
  const htfInterval: '4h' | '1d' = interval === '1h' ? '4h' : '1d';
  const htfIntervalMs = htfInterval === '1d' ? 86_400_000 : 14_400_000;

  const [bnKlines, bnSpotKlines, bnFunding, bnPremium, bybitOi, htfRaw] = await Promise.all([
    fetchJsonWithTimeout<unknown[][]>(
      `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${interval}&limit=${barLimit}`
    ),
    fetchJsonWithTimeout<unknown[][]>(
      `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${barLimit}`
    ),
    fetchJsonWithTimeout<{ fundingTime: number; fundingRate: string }[]>(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=120`
    ),
    fetchJsonWithTimeout<unknown[][]>(
      `https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=BTCUSDT&interval=${interval}&limit=${barLimit}`
    ),
    fetchJsonWithTimeout<{
      result?: { list?: { openInterest: string; timestamp: string }[] };
    }>(
      `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=${interval}&limit=200`
    ),
    fetchJsonWithTimeout<unknown[][]>(
      `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${htfInterval}&limit=220`
    ),
  ]);

  const takerBuyMap = new Map<number, { vol: number; tbv: number }>();
  if (Array.isArray(bnKlines)) {
    for (const r of bnKlines) {
      const t = Number(r[0]);
      const vol = Number(r[5]);
      const tbv = Number(r[9]);
      if (Number.isFinite(t) && Number.isFinite(vol) && Number.isFinite(tbv) && vol > 0) {
        takerBuyMap.set(t, { vol, tbv });
      }
    }
  }

  const spotMap = new Map<number, { vol: number; tbv: number }>();
  if (Array.isArray(bnSpotKlines)) {
    for (const r of bnSpotKlines) {
      const t = Number(r[0]);
      const vol = Number(r[5]);
      const tbv = Number(r[9]);
      if (Number.isFinite(t) && Number.isFinite(vol) && Number.isFinite(tbv) && vol > 0) {
        spotMap.set(t, { vol, tbv });
      }
    }
  }

  const fundingSeries: DerivPoint[] = [];
  if (Array.isArray(bnFunding)) {
    for (const f of bnFunding) {
      const t = Number(f.fundingTime);
      const bps = Number(f.fundingRate) * 10_000;
      if (Number.isFinite(t) && Number.isFinite(bps)) {
        fundingSeries.push({ t, v: bps });
      }
    }
    fundingSeries.sort((a, b) => a.t - b.t);
  }

  const basisSeries: DerivPoint[] = [];
  if (Array.isArray(bnPremium)) {
    for (const p of bnPremium) {
      const t = Number(p[0]);
      const bps = Number(p[4]) * 10_000;
      if (Number.isFinite(t) && Number.isFinite(bps)) {
        basisSeries.push({ t, v: bps });
      }
    }
    basisSeries.sort((a, b) => a.t - b.t);
  }

  const oiSeries: DerivPoint[] = [];
  const rawOiList = bybitOi?.result?.list;
  if (Array.isArray(rawOiList)) {
    for (const o of rawOiList) {
      const t = Number(o.timestamp);
      const oi = Number(o.openInterest);
      if (Number.isFinite(t) && Number.isFinite(oi) && oi > 0) {
        oiSeries.push({ t, v: oi });
      }
    }
    oiSeries.sort((a, b) => a.t - b.t);
  }

  if (oiSeries.length === 0) {
    const bnOi = await fetchJsonWithTimeout<{ timestamp: number; sumOpenInterest: string }[]>(
      `https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=${interval}&limit=200`
    );
    if (Array.isArray(bnOi)) {
      for (const o of bnOi) {
        const t = Number(o.timestamp);
        const oi = Number(o.sumOpenInterest);
        if (Number.isFinite(t) && Number.isFinite(oi) && oi > 0) {
          oiSeries.push({ t, v: oi });
        }
      }
      oiSeries.sort((a, b) => a.t - b.t);
    }
  }

  let htfSeries: HtfSummaryPoint[] = [];
  if (Array.isArray(htfRaw) && htfRaw.length >= 20) {
    const htfCandles: RawKline[] = htfRaw.map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      vol: Number(r[5]),
    }));
    htfSeries = buildCausalHtfSummarySeries(htfCandles, htfIntervalMs);
  }

  if (
    takerBuyMap.size === 0 &&
    spotMap.size === 0 &&
    fundingSeries.length === 0 &&
    basisSeries.length === 0 &&
    oiSeries.length === 0
  ) {
    return null;
  }

  return {
    fetchedAt: Date.now(),
    interval,
    takerBuyMap,
    spotMap,
    fundingSeries,
    basisSeries,
    oiSeries,
    htfSeries,
  };
}

async function getCachedDerivatives(interval: '1h' | '4h' | '1d'): Promise<DerivCacheEntry | null> {
  const cached = derivCache.get(interval);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  const existing = inFlight.get(interval);
  if (existing) return existing;

  const promise = fetchLiveDerivativesBundle(interval)
    .then((entry) => {
      if (entry) derivCache.set(interval, entry);
      return entry ?? cached ?? null;
    })
    .finally(() => {
      inFlight.delete(interval);
    });
  inFlight.set(interval, promise);
  return promise;
}

/**
 * Background pre-warmer: keeps 1h, 4h, and 1d derivatives/spot/MTF bundles hot in memory
 * so even the first cold `/api/ai/ml-forecast` request responds in <5ms.
 */
export function prewarmAllMlDerivatives(): Promise<void> {
  return Promise.all([
    getCachedDerivatives('1h').catch(() => null),
    getCachedDerivatives('4h').catch(() => null),
    getCachedDerivatives('1d').catch(() => null),
  ]).then(() => undefined);
}

export function startMlDerivativesPrewarmLoop(onRefreshed?: () => void): () => void {
  const run = () => {
    prewarmAllMlDerivatives()
      .then(() => onRefreshed?.())
      .catch(() => {});
  };
  const initTimer = setTimeout(run, 1200);
  const loopTimer = setInterval(run, PREWARM_INTERVAL_MS);
  return () => {
    clearTimeout(initTimer);
    clearInterval(loopTimer);
  };
}

/**
 * Enriches the tail of live chart candles with aligned Binance Taker Buy Volume,
 * Binance Spot Volume/Taker Buy, Binance 8h Funding Rate, Binance Perp-Spot Basis,
 * BTCUSDT Perp Open Interest, and strictly causal Higher-Timeframe context.
 */
export async function enrichCandlesWithLiveDerivatives(
  candles: RawKline[],
  timeframe: TimeframeId
): Promise<RawKline[]> {
  if (!candles || candles.length === 0) return candles;
  const interval = mapTfToDerivInterval(timeframe);
  const bundle = await getCachedDerivatives(interval);
  if (!bundle) return candles;

  const intervalMs = interval === '1d' ? 86_400_000 : interval === '4h' ? 14_400_000 : 3_600_000;
  const enrichStart = Math.max(0, candles.length - 220);
  const out = candles.slice();

  for (let i = enrichStart; i < out.length; i++) {
    const c = out[i];
    const bucketT = Math.floor(c.t / intervalMs) * intervalMs;
    const tbMatch = bundle.takerBuyMap.get(c.t) ?? bundle.takerBuyMap.get(bucketT);
    const spotMatch = bundle.spotMap.get(c.t) ?? bundle.spotMap.get(bucketT);
    const fundingBps = lookupLatestCausal(bundle.fundingSeries, c.t);
    const basisBps = lookupLatestCausal(bundle.basisSeries, c.t);
    const oiBtc = lookupLatestCausal(bundle.oiSeries, c.t);
    const htf = lookupLatestCausalHtf(bundle.htfSeries, c.t);

    let tbv = c.tbv;
    if (tbv === undefined && tbMatch && tbMatch.vol > 0) {
      tbv = (tbMatch.tbv / tbMatch.vol) * c.vol;
    }

    out[i] = {
      ...c,
      ...(tbv !== undefined ? { tbv } : {}),
      ...(spotMatch ? { spotVol: spotMatch.vol, spotTbv: spotMatch.tbv } : {}),
      ...(fundingBps !== undefined ? { fundingBps } : {}),
      ...(basisBps !== undefined ? { basisBps } : {}),
      ...(oiBtc !== undefined ? { oiBtc } : {}),
      ...(htf
        ? {
            htfDistMa50: htf.distMa50,
            htfRsi14: htf.rsi14,
            htfAtrRatio: htf.atrRatio,
          }
        : {}),
    };
  }
  return out;
}
