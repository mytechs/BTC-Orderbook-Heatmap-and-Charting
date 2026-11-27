import fs from 'node:fs';
import path from 'node:path';
import type { RawKline } from '../server/collectorUtils.ts';
import {
  buildCausalHtfSummarySeries,
  lookupLatestCausal,
  lookupLatestCausalHtf,
} from '../server/mlDerivativesFeed.ts';
import { ML_FEATURE_NAMES, extractMlFeaturesAt, precomputeSeries } from '../server/mlFeatures.ts';

interface TfSpec {
  tf: '1h' | '4h' | '1d';
  totalBars: number;
  horizonBars: number;
  horizonLabel: string;
  barrierAtrMult: number;
}

interface DerivPoint {
  t: number;
  v: number;
}

const SPECS: TfSpec[] = [
  { tf: '1h', totalBars: 10000, horizonBars: 12, horizonLabel: '12h', barrierAtrMult: 1.8 },
  { tf: '4h', totalBars: 6500, horizonBars: 12, horizonLabel: '48h', barrierAtrMult: 1.8 },
  { tf: '1d', totalBars: 1500, horizonBars: 10, horizonLabel: '10d', barrierAtrMult: 1.8 },
];

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonRetry<T>(url: string, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'BTC-Quant-ML-Trainer/1.0' } });
      if (res.status === 429 || res.status >= 500) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function fetchBinanceKlines(
  endpoint: string,
  interval: string,
  totalBars: number
): Promise<RawKline[]> {
  const out: RawKline[] = [];
  let endTime: number | undefined;
  while (out.length < totalBars) {
    const limit = Math.min(1000, totalBars - out.length);
    const url = new URL(endpoint);
    url.searchParams.set('symbol', 'BTCUSDT');
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(limit));
    if (endTime !== undefined) url.searchParams.set('endTime', String(endTime));
    const rows = await fetchJsonRetry<unknown[][]>(url.toString());
    if (!Array.isArray(rows) || rows.length === 0) break;
    const mapped: RawKline[] = rows.map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      vol: Number(r[5]),
      tbv: Number(r[9]),
    }));
    out.unshift(...mapped);
    endTime = mapped[0].t - 1;
    if (rows.length < limit) break;
    await sleep(50);
  }
  const seen = new Set<number>();
  const clean: RawKline[] = [];
  for (const k of out) {
    if (!seen.has(k.t)) {
      seen.add(k.t);
      clean.push(k);
    }
  }
  clean.sort((a, b) => a.t - b.t);
  return clean.slice(-totalBars);
}

async function fetchBinanceFundingHistory(startTimeMs: number, endTimeMs: number): Promise<DerivPoint[]> {
  const out: DerivPoint[] = [];
  let cursor = startTimeMs;
  while (cursor < endTimeMs) {
    const url = new URL('https://fapi.binance.com/fapi/v1/fundingRate');
    url.searchParams.set('symbol', 'BTCUSDT');
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endTimeMs));
    url.searchParams.set('limit', '1000');
    const rows = await fetchJsonRetry<{ fundingTime: number; fundingRate: string }[]>(url.toString());
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const t = Number(r.fundingTime);
      const bps = Number(r.fundingRate) * 10_000;
      if (Number.isFinite(t) && Number.isFinite(bps)) out.push({ t, v: bps });
    }
    const lastT = Number(rows[rows.length - 1].fundingTime);
    if (!Number.isFinite(lastT) || lastT <= cursor || rows.length < 1000) break;
    cursor = lastT + 1;
    await sleep(80);
  }
  const dedup = new Map<number, number>();
  for (const p of out) dedup.set(p.t, p.v);
  return Array.from(dedup.entries())
    .map(([t, v]) => ({ t, v }))
    .sort((a, b) => a.t - b.t);
}

async function fetchBinancePremiumBasis(interval: string, totalBars: number): Promise<DerivPoint[]> {
  const out: DerivPoint[] = [];
  let endTime: number | undefined;
  while (out.length < totalBars) {
    const limit = Math.min(1000, totalBars - out.length);
    const url = new URL('https://fapi.binance.com/fapi/v1/premiumIndexKlines');
    url.searchParams.set('symbol', 'BTCUSDT');
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(limit));
    if (endTime !== undefined) url.searchParams.set('endTime', String(endTime));
    const rows = await fetchJsonRetry<unknown[][]>(url.toString());
    if (!Array.isArray(rows) || rows.length === 0) break;
    const batch: DerivPoint[] = rows.map((r) => ({
      t: Number(r[0]),
      v: Number(r[4]) * 10_000,
    }));
    out.unshift(...batch);
    endTime = batch[0].t - 1;
    if (rows.length < limit) break;
    await sleep(60);
  }
  const dedup = new Map<number, number>();
  for (const p of out) {
    if (Number.isFinite(p.t) && Number.isFinite(p.v)) dedup.set(p.t, p.v);
  }
  return Array.from(dedup.entries())
    .map(([t, v]) => ({ t, v }))
    .sort((a, b) => a.t - b.t);
}

async function fetchMultiYearPerpOi(
  interval: '1h' | '4h' | '1d',
  startTimeMs: number,
  endTimeMs: number
): Promise<DerivPoint[]> {
  const dedup = new Map<number, number>();
  let cursorEnd = endTimeMs;
  let pages = 0;
  const maxPages = interval === '1h' ? 65 : interval === '4h' ? 45 : 15;

  while (cursorEnd >= startTimeMs && pages < maxPages) {
    pages++;
    const url = new URL('https://api.bybit.com/v5/market/open-interest');
    url.searchParams.set('category', 'linear');
    url.searchParams.set('symbol', 'BTCUSDT');
    url.searchParams.set('intervalTime', interval);
    url.searchParams.set('endTime', String(cursorEnd));
    url.searchParams.set('limit', '200');
    const json = await fetchJsonRetry<{
      retCode?: number;
      result?: { list?: { openInterest: string; timestamp: string }[] };
    }>(url.toString());
    const list = json?.result?.list;
    if (!Array.isArray(list) || list.length === 0) break;

    let oldestT = Infinity;
    for (const item of list) {
      const t = Number(item.timestamp);
      const v = Number(item.openInterest);
      if (Number.isFinite(t) && Number.isFinite(v) && v > 0) {
        dedup.set(t, v);
        if (t < oldestT) oldestT = t;
      }
    }
    if (!Number.isFinite(oldestT) || oldestT >= cursorEnd || list.length < 200) break;
    cursorEnd = oldestT - 1;
    await sleep(60);
  }

  return Array.from(dedup.entries())
    .map(([t, v]) => ({ t, v }))
    .sort((a, b) => a.t - b.t);
}

function calcAtrAt(candles: RawKline[], endIdx: number, period = 14): number {
  const start = Math.max(1, endIdx - period + 1);
  let sum = 0;
  let cnt = 0;
  for (let i = start; i <= endIdx; i++) {
    const c = candles[i];
    const prev = candles[i - 1].c;
    sum += Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
    cnt++;
  }
  return cnt > 0 ? sum / cnt : Math.max(1, candles[endIdx].h - candles[endIdx].l);
}

function buildForSpec(spec: TfSpec, candles: RawKline[]) {
  const pre = precomputeSeries(candles);
  const X: number[][] = [];
  const yDir: number[] = [];
  const yRegime: number[] = [];
  const yRangePct: number[] = [];
  const timestamps: number[] = [];
  const closes: number[] = [];

  const startIdx = 210;
  const endIdx = candles.length - spec.horizonBars - 1;

  for (let i = startIdx; i <= endIdx; i++) {
    const entry = candles[i].c;
    const atr = calcAtrAt(candles, i, 14);
    const upBarrier = entry + atr * spec.barrierAtrMult;
    const dnBarrier = entry - atr * spec.barrierAtrMult;

    let dirLabel = 1;
    let fwdHigh = entry;
    let fwdLow = entry;
    let hitFound = false;

    for (let j = i + 1; j <= i + spec.horizonBars; j++) {
      const fk = candles[j];
      if (fk.h > fwdHigh) fwdHigh = fk.h;
      if (fk.l < fwdLow) fwdLow = fk.l;
      if (!hitFound) {
        const hitUp = fk.h >= upBarrier;
        const hitDn = fk.l <= dnBarrier;
        if (hitUp && !hitDn) {
          dirLabel = 2;
          hitFound = true;
        } else if (hitDn && !hitUp) {
          dirLabel = 0;
          hitFound = true;
        } else if (hitUp && hitDn) {
          dirLabel = fk.c >= entry ? 2 : 0;
          hitFound = true;
        }
      }
    }

    const fwdEnd = candles[i + spec.horizonBars].c;
    const netMoveAtr = Math.abs(fwdEnd - entry) / Math.max(1e-6, atr);
    const fwdRangePct = ((fwdHigh - fwdLow) / Math.max(1e-6, entry)) * 100;
    const fwdRangeAtr = (fwdHigh - fwdLow) / Math.max(1e-6, atr);
    const regimeLabel = fwdRangeAtr >= 4.2 ? 2 : netMoveAtr >= 1.4 ? 1 : 0;

    X.push(extractMlFeaturesAt(candles, i, pre));
    yDir.push(dirLabel);
    yRegime.push(regimeLabel);
    yRangePct.push(+Math.min(30, fwdRangePct).toFixed(4));
    timestamps.push(candles[i].t);
    closes.push(entry);
  }

  return {
    timeframe: spec.tf,
    horizonBars: spec.horizonBars,
    horizonLabel: spec.horizonLabel,
    barrierAtrMult: spec.barrierAtrMult,
    featureNames: [...ML_FEATURE_NAMES],
    samples: X.length,
    dateRange: [
      new Date(timestamps[0]).toISOString().slice(0, 10),
      new Date(timestamps[timestamps.length - 1]).toISOString().slice(0, 10),
    ],
    X,
    yDir,
    yRegime,
    yRangePct,
    timestamps,
    closes,
  };
}

async function main() {
  const outDir = path.resolve('training/data');
  fs.mkdirSync(outDir, { recursive: true });

  const candlesByTf = new Map<TfSpec['tf'], RawKline[]>();
  let globalMinT = Infinity;
  let globalMaxT = 0;

  for (const spec of SPECS) {
    console.log(`[ML Features] Fetching ${spec.totalBars} Binance Perp BTCUSDT ${spec.tf} klines...`);
    const candles = await fetchBinanceKlines(
      'https://fapi.binance.com/fapi/v1/klines',
      spec.tf,
      spec.totalBars
    );
    candlesByTf.set(spec.tf, candles);
    if (candles.length > 0) {
      globalMinT = Math.min(globalMinT, candles[0].t);
      globalMaxT = Math.max(globalMaxT, candles[candles.length - 1].t);
    }
  }

  // Build strictly causal Higher-Timeframe indicator series (4H for 1H; 1D for 4H & 1D)
  const htf4hSeries = buildCausalHtfSummarySeries(candlesByTf.get('4h') || [], 14_400_000);
  const htf1dSeries = buildCausalHtfSummarySeries(candlesByTf.get('1d') || [], 86_400_000);

  console.log(`[ML Features] Fetching multi-year Binance 8h funding history...`);
  const fundingSeries = await fetchBinanceFundingHistory(
    globalMinT - 15 * 86_400_000,
    globalMaxT + 86_400_000
  );
  console.log(`[ML Features] Loaded ${fundingSeries.length} Binance 8h funding settlements.`);

  for (const spec of SPECS) {
    const candles = candlesByTf.get(spec.tf) || [];
    if (candles.length < 250) continue;

    const minT = candles[0].t;
    const maxT = candles[candles.length - 1].t;
    console.log(`[ML Features] Fetching ${spec.tf} Binance Spot + Basis + multi-year Perp OI...`);
    const [spotCandles, basisSeries, oiSeries] = await Promise.all([
      fetchBinanceKlines('https://api.binance.com/api/v3/klines', spec.tf, spec.totalBars),
      fetchBinancePremiumBasis(spec.tf, spec.totalBars + 100),
      fetchMultiYearPerpOi(spec.tf, minT - 30 * 86_400_000, maxT + 86_400_000),
    ]);

    const spotMap = new Map<number, { vol: number; tbv: number }>();
    for (const sc of spotCandles) {
      if (sc.vol > 0 && typeof sc.tbv === 'number') {
        spotMap.set(sc.t, { vol: sc.vol, tbv: sc.tbv });
      }
    }

    const htfSeries = spec.tf === '1h' ? htf4hSeries : htf1dSeries;
    let hasTbv = 0;
    let hasSpot = 0;
    let hasFund = 0;
    let hasBasis = 0;
    let hasOi = 0;
    let hasHtf = 0;

    for (const c of candles) {
      const sp = spotMap.get(c.t);
      const f = lookupLatestCausal(fundingSeries, c.t);
      const b = lookupLatestCausal(basisSeries, c.t);
      const o = lookupLatestCausal(oiSeries, c.t);
      const h = lookupLatestCausalHtf(htfSeries, c.t);

      if (typeof c.tbv === 'number' && c.tbv > 0) hasTbv++;
      if (sp) {
        c.spotVol = sp.vol;
        c.spotTbv = sp.tbv;
        hasSpot++;
      }
      if (f !== undefined) {
        c.fundingBps = f;
        hasFund++;
      }
      if (b !== undefined) {
        c.basisBps = b;
        hasBasis++;
      }
      if (o !== undefined) {
        c.oiBtc = o;
        hasOi++;
      }
      if (h) {
        c.htfDistMa50 = h.distMa50;
        c.htfRsi14 = h.rsi14;
        c.htfAtrRatio = h.atrRatio;
        hasHtf++;
      }
    }

    const built = buildForSpec(spec, candles);
    const outPath = path.join(outDir, `ml_features_${spec.tf}.json`);
    fs.writeFileSync(outPath, JSON.stringify(built), 'utf8');
    const cDown = built.yDir.filter((x) => x === 0).length;
    const cChop = built.yDir.filter((x) => x === 1).length;
    const cUp = built.yDir.filter((x) => x === 2).length;
    const pct = (n: number) => `${((n / candles.length) * 100).toFixed(1)}%`;
    console.log(
      `[ML Features] ${spec.tf}: ${built.samples} samples (${built.dateRange[0]} -> ${built.dateRange[1]}) | ` +
        `${ML_FEATURE_NAMES.length} features | Coverage: Taker=${pct(hasTbv)} Spot=${pct(hasSpot)} Fund=${pct(hasFund)} Basis=${pct(hasBasis)} OI=${pct(hasOi)} MTF=${pct(hasHtf)} | ` +
        `Down=${cDown} Chop=${cChop} Up=${cUp}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
