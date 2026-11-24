import fs from 'node:fs';
import type {
  AggregatedTradeBubble,
  ClusterBucketSummary,
  HeatmapSlice,
  LiquidationEvent,
  PriceStep,
  TickerStats,
  TimeframeId,
  TradeEvent,
  VenueBreakdown,
  WallLevel,
} from '../shared/types.ts';

export const BASE_PRICE_STEP = 1;
export const BASE_TIME_STEP_MS = 500;
export const LIVE_TICK_MS = 250;
export const MAX_RING_SLICES = 720; // 6 minutes at 500ms active resolution
export const MAX_RECENT_TRADES = 250;
export const MAX_WHALE_TRADES = 150;
export const MAX_LIQUIDATIONS = 100;
export const WHALE_TRADE_MIN_BTC = 0.5;
export const OUTER_LEVEL_TTL_MS = 20 * 60 * 1000;
export const MAX_OUTER_LEVELS = 600;

export function appendTradeBuffers(
  recentTrades: TradeEvent[],
  whaleTrades: TradeEvent[],
  trade: TradeEvent
) {
  if (trade.market !== 'SPOT') {
    recentTrades.unshift(trade);
    if (recentTrades.length > MAX_RECENT_TRADES) {
      recentTrades.length = MAX_RECENT_TRADES;
    }
  }
  if (trade.v >= WHALE_TRADE_MIN_BTC) {
    whaleTrades.unshift(trade);
    if (whaleTrades.length > MAX_WHALE_TRADES) {
      whaleTrades.length = MAX_WHALE_TRADES;
    }
  }
}

export function appendLiquidationBuffer(
  recentLiquidations: LiquidationEvent[],
  liq: LiquidationEvent
) {
  recentLiquidations.unshift(liq);
  if (recentLiquidations.length > MAX_LIQUIDATIONS) {
    recentLiquidations.length = MAX_LIQUIDATIONS;
  }
}

export function compactLevelsForHistory(
  levels: [number, number][],
  mid: number,
  maxLevels = 160
): [number, number][] {
  if (levels.length === 0) return levels;
  const lo = mid > 0 ? mid * 0.94 : 0;
  const hi = mid > 0 ? mid * 1.06 : Infinity;
  const filtered: [number, number][] = [];
  for (let i = 0; i < levels.length; i++) {
    const [p, v] = levels[i];
    if (p >= lo && p <= hi && v >= 0.1) {
      filtered.push([p, v]);
    }
  }
  if (filtered.length <= maxLevels) return filtered;
  // levels are sorted nearest-to-spread first (bids desc, asks asc), so slice keeps closest levels
  return filtered.slice(0, maxLevels);
}

export function trimLevelsForWire(
  levels: [number, number][],
  mid: number,
  maxLevels = 400
): [number, number][] {
  if (levels.length <= maxLevels && mid <= 0) return levels;
  const lo = mid > 0 ? mid * 0.85 : 0;
  const hi = mid > 0 ? mid * 1.15 : Infinity;
  const out: [number, number][] = [];
  for (let i = 0; i < levels.length; i++) {
    const [p, v] = levels[i];
    if (p < lo || p > hi) continue;
    out.push([p, v]);
    if (out.length >= maxLevels) break;
  }
  return out;
}

export const TIMEFRAME_CONFIG: Record<
  TimeframeId,
  {
    ms: number;
    bybitInterval?: string;
    binanceInterval?: string;
    hlInterval?: string;
    okxBar?: string;
    coinbaseGranularity?: number;
    defaultPriceStep: PriceStep;
  }
> = {
  '100ms': { ms: 100, defaultPriceStep: 1 },
  '250ms': { ms: 250, defaultPriceStep: 2 },
  '500ms': { ms: 500, defaultPriceStep: 2 },
  '1s': { ms: 1000, defaultPriceStep: 5 },
  '1m': {
    ms: 60 * 1000,
    bybitInterval: '1',
    binanceInterval: '1m',
    hlInterval: '1m',
    okxBar: '1m',
    coinbaseGranularity: 60,
    defaultPriceStep: 5,
  },
  '3m': {
    ms: 3 * 60 * 1000,
    bybitInterval: '3',
    binanceInterval: '3m',
    hlInterval: '3m',
    okxBar: '3m',
    coinbaseGranularity: 60,
    defaultPriceStep: 5,
  },
  '5m': {
    ms: 5 * 60 * 1000,
    bybitInterval: '5',
    binanceInterval: '5m',
    hlInterval: '5m',
    okxBar: '5m',
    coinbaseGranularity: 300,
    defaultPriceStep: 10,
  },
  '15m': {
    ms: 15 * 60 * 1000,
    bybitInterval: '15',
    binanceInterval: '15m',
    hlInterval: '15m',
    okxBar: '15m',
    coinbaseGranularity: 900,
    defaultPriceStep: 10,
  },
  '30m': {
    ms: 30 * 60 * 1000,
    bybitInterval: '30',
    binanceInterval: '30m',
    hlInterval: '30m',
    okxBar: '30m',
    coinbaseGranularity: 900,
    defaultPriceStep: 25,
  },
  '1h': {
    ms: 60 * 60 * 1000,
    bybitInterval: '60',
    binanceInterval: '1h',
    hlInterval: '1h',
    okxBar: '1H',
    coinbaseGranularity: 3600,
    defaultPriceStep: 25,
  },
  '2h': {
    ms: 2 * 60 * 60 * 1000,
    bybitInterval: '120',
    binanceInterval: '2h',
    hlInterval: '2h',
    okxBar: '2H',
    coinbaseGranularity: 3600,
    defaultPriceStep: 25,
  },
  '4h': {
    ms: 4 * 60 * 60 * 1000,
    bybitInterval: '240',
    binanceInterval: '4h',
    hlInterval: '4h',
    okxBar: '4H',
    coinbaseGranularity: 3600,
    defaultPriceStep: 50,
  },
  '6h': {
    ms: 6 * 60 * 60 * 1000,
    bybitInterval: '360',
    binanceInterval: '6h',
    hlInterval: '2h',
    okxBar: '6H',
    coinbaseGranularity: 21600,
    defaultPriceStep: 50,
  },
  '12h': {
    ms: 12 * 60 * 60 * 1000,
    bybitInterval: '720',
    binanceInterval: '12h',
    hlInterval: '12h',
    okxBar: '12H',
    coinbaseGranularity: 21600,
    defaultPriceStep: 50,
  },
  '1d': {
    ms: 24 * 60 * 60 * 1000,
    bybitInterval: 'D',
    binanceInterval: '1d',
    hlInterval: '1d',
    okxBar: '1D',
    coinbaseGranularity: 86400,
    defaultPriceStep: 100,
  },
  '1w': {
    ms: 7 * 24 * 60 * 60 * 1000,
    bybitInterval: 'W',
    binanceInterval: '1w',
    hlInterval: '1w',
    okxBar: '1W',
    coinbaseGranularity: 86400,
    defaultPriceStep: 100,
  },
};

export interface RawKline {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
}

export function resampleKlines(candles: RawKline[], targetMs: number): RawKline[] {
  if (candles.length === 0 || targetMs <= 0) return candles;
  const buckets = new Map<number, RawKline>();
  for (const k of candles) {
    const bt = Math.floor(k.t / targetMs) * targetMs;
    const existing = buckets.get(bt);
    if (!existing) {
      buckets.set(bt, { t: bt, o: k.o, h: k.h, l: k.l, c: k.c, vol: k.vol });
    } else {
      if (k.h > existing.h) existing.h = k.h;
      if (k.l < existing.l) existing.l = k.l;
      existing.c = k.c;
      existing.vol = +(existing.vol + k.vol).toFixed(4);
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
}

export interface AggregatedClusterResult {
  bids: [number, number][];
  asks: [number, number][];
  bidBreakdowns?: Map<number, VenueBreakdown>;
  askBreakdowns?: Map<number, VenueBreakdown>;
  bidClusters: WallLevel[];
  askClusters: WallLevel[];
  clusterSummary: ClusterBucketSummary[];
  totalBidBtc: number;
  totalAskBtc: number;
  activeBidLevels: number;
  activeAskLevels: number;
  minBookPrice: number;
  maxBookPrice: number;
}

export function reBucketLevels(levels: [number, number][], priceStep: number): [number, number][] {
  if (priceStep === BASE_PRICE_STEP) return levels;
  const map = new Map<number, number>();
  const inv = 1 / priceStep;
  for (let i = 0; i < levels.length; i++) {
    const [p, v] = levels[i];
    const b = +(Math.floor(p * inv + 1e-9) * priceStep).toFixed(2);
    map.set(b, (map.get(b) || 0) + v);
  }
  const out: [number, number][] = [];
  for (const [b, v] of map.entries()) {
    out.push([b, +v.toFixed(3)]);
  }
  return out;
}

export function reBucketAggregatedResult(
  base: AggregatedClusterResult,
  priceStep: PriceStep,
  includeClusters: boolean,
  mid: number,
  venueOrder: string[]
): AggregatedClusterResult {
  if (priceStep === BASE_PRICE_STEP) {
    if (!includeClusters || base.bidClusters.length > 0 || base.askClusters.length > 0) {
      return base;
    }
    const clusters = buildClusterMetrics(
      base.bids,
      base.asks,
      base.bidBreakdowns || new Map(),
      base.askBreakdowns || new Map(),
      mid,
      venueOrder
    );
    return { ...base, ...clusters };
  }

  const inv = 1 / priceStep;

  // Fast path for lite ticks (3 of 4 ticks/sec): skip per-level VenueBreakdown object allocations
  if (!includeClusters) {
    const bidSum = new Map<number, number>();
    for (let i = 0; i < base.bids.length; i++) {
      const [price, vol] = base.bids[i];
      const b = Math.round(Math.floor(price * inv + 1e-9) * priceStep * 100) / 100;
      bidSum.set(b, (bidSum.get(b) || 0) + vol);
    }
    const bids: [number, number][] = [];
    for (const [b, tot] of bidSum.entries()) {
      if (tot >= 0.01) bids.push([b, Math.round(tot * 1000) / 1000]);
    }
    bids.sort((a, b) => b[0] - a[0]);

    const askSum = new Map<number, number>();
    for (let i = 0; i < base.asks.length; i++) {
      const [price, vol] = base.asks[i];
      const b = Math.round(Math.floor(price * inv + 1e-9) * priceStep * 100) / 100;
      askSum.set(b, (askSum.get(b) || 0) + vol);
    }
    const asks: [number, number][] = [];
    for (const [b, tot] of askSum.entries()) {
      if (tot >= 0.01) asks.push([b, Math.round(tot * 1000) / 1000]);
    }
    asks.sort((a, b) => a[0] - b[0]);

    return {
      bids,
      asks,
      bidClusters: [],
      askClusters: [],
      clusterSummary: [],
      totalBidBtc: base.totalBidBtc,
      totalAskBtc: base.totalAskBtc,
      activeBidLevels: base.activeBidLevels,
      activeAskLevels: base.activeAskLevels,
      minBookPrice: base.minBookPrice,
      maxBookPrice: base.maxBookPrice,
    };
  }

  const bidBuckets = new Map<number, VenueBreakdown>();
  const askBuckets = new Map<number, VenueBreakdown>();

  if (base.bidBreakdowns) {
    for (const [price, bd] of base.bidBreakdowns.entries()) {
      const b = +(Math.floor(price * inv + 1e-9) * priceStep).toFixed(2);
      let target = bidBuckets.get(b);
      if (!target) {
        target = {};
        bidBuckets.set(b, target);
      }
      for (const [k, v] of Object.entries(bd)) {
        target[k] = (target[k] || 0) + v;
      }
    }
  }

  if (base.askBreakdowns) {
    for (const [price, bd] of base.askBreakdowns.entries()) {
      const b = +(Math.floor(price * inv + 1e-9) * priceStep).toFixed(2);
      let target = askBuckets.get(b);
      if (!target) {
        target = {};
        askBuckets.set(b, target);
      }
      for (const [k, v] of Object.entries(bd)) {
        target[k] = (target[k] || 0) + v;
      }
    }
  }

  const bids: [number, number][] = [];
  for (const [b, bd] of bidBuckets.entries()) {
    let tot = 0;
    for (const v of Object.values(bd)) tot += v;
    if (tot >= 0.01) bids.push([b, +tot.toFixed(3)]);
  }
  bids.sort((a, b) => b[0] - a[0]);

  const asks: [number, number][] = [];
  for (const [b, bd] of askBuckets.entries()) {
    let tot = 0;
    for (const v of Object.values(bd)) tot += v;
    if (tot >= 0.01) asks.push([b, +tot.toFixed(3)]);
  }
  asks.sort((a, b) => a[0] - b[0]);

  const clusters = includeClusters
    ? buildClusterMetrics(bids, asks, bidBuckets, askBuckets, mid, venueOrder)
    : { bidClusters: [], askClusters: [], clusterSummary: [] };

  return {
    bids,
    asks,
    bidBreakdowns: bidBuckets,
    askBreakdowns: askBuckets,
    ...clusters,
    totalBidBtc: base.totalBidBtc,
    totalAskBtc: base.totalAskBtc,
    activeBidLevels: base.activeBidLevels,
    activeAskLevels: base.activeAskLevels,
    minBookPrice: base.minBookPrice,
    maxBookPrice: base.maxBookPrice,
  };
}

export function buildClusterMetrics(
  bids: [number, number][],
  asks: [number, number][],
  bidBreakdowns: Map<number, VenueBreakdown>,
  askBreakdowns: Map<number, VenueBreakdown>,
  mid: number,
  venueOrder: string[]
): {
  bidClusters: WallLevel[];
  askClusters: WallLevel[];
  clusterSummary: ClusterBucketSummary[];
} {
  const tiers: { label: string; minBtc: number; maxBtc: number | null }[] = [
    { label: '1–5 BTC', minBtc: 1, maxBtc: 5 },
    { label: '5–10 BTC', minBtc: 5, maxBtc: 10 },
    { label: '10–25 BTC', minBtc: 10, maxBtc: 25 },
    { label: '25–50 BTC', minBtc: 25, maxBtc: 50 },
    { label: '50–100 BTC', minBtc: 50, maxBtc: 100 },
    { label: '100+ BTC', minBtc: 100, maxBtc: null },
  ];

  const clusterSummary: ClusterBucketSummary[] = tiers.map((t) => ({
    ...t,
    bidCount: 0,
    bidBtc: 0,
    askCount: 0,
    askBtc: 0,
  }));

  const extractVenues = (bd: VenueBreakdown): string[] => {
    const v: string[] = [];
    for (const k of venueOrder) {
      if ((bd[k] || 0) > 0.02) v.push(k);
    }
    return v;
  };

  const roundBd = (bd: VenueBreakdown): VenueBreakdown => {
    const out: VenueBreakdown = {};
    for (const [k, val] of Object.entries(bd)) {
      if (val > 0.005) out[k] = +val.toFixed(2);
    }
    return out;
  };

  const allBids: WallLevel[] = [];
  for (const [price, sizeBtc] of bids) {
    for (const tier of clusterSummary) {
      if (sizeBtc >= tier.minBtc && (tier.maxBtc === null || sizeBtc < tier.maxBtc)) {
        tier.bidCount++;
        tier.bidBtc = +(tier.bidBtc + sizeBtc).toFixed(2);
        break;
      }
    }
    if (sizeBtc >= 0.5) {
      const bd = bidBreakdowns.get(price) || {};
      allBids.push({
        price,
        sizeBtc,
        distanceUsd: +(price - mid).toFixed(2),
        distancePct: mid > 0 ? +(((price - mid) / mid) * 100).toFixed(3) : 0,
        side: 'Bid',
        venues: extractVenues(bd),
        breakdown: roundBd(bd),
      });
    }
  }

  const allAsks: WallLevel[] = [];
  for (const [price, sizeBtc] of asks) {
    for (const tier of clusterSummary) {
      if (sizeBtc >= tier.minBtc && (tier.maxBtc === null || sizeBtc < tier.maxBtc)) {
        tier.askCount++;
        tier.askBtc = +(tier.askBtc + sizeBtc).toFixed(2);
        break;
      }
    }
    if (sizeBtc >= 0.5) {
      const bd = askBreakdowns.get(price) || {};
      allAsks.push({
        price,
        sizeBtc,
        distanceUsd: +(price - mid).toFixed(2),
        distancePct: mid > 0 ? +(((price - mid) / mid) * 100).toFixed(3) : 0,
        side: 'Ask',
        venues: extractVenues(bd),
        breakdown: roundBd(bd),
      });
    }
  }

  return {
    bidClusters: allBids.sort((a, b) => b.sizeBtc - a.sizeBtc).slice(0, 250),
    askClusters: allAsks.sort((a, b) => b.sizeBtc - a.sizeBtc).slice(0, 250),
    clusterSummary,
  };
}

export function buildKlineHeatmapSlices(
  klines: RawKline[],
  intervalMs: number,
  priceStep: PriceStep,
  useRecordedSnapshots: boolean,
  baseSlices: HeatmapSlice[],
  lastPrice: number,
  spread: number,
  currentBids: [number, number][],
  currentAsks: [number, number][]
): HeatmapSlice[] {
  if (klines.length === 0) return [];

  let maxLiveWall = 5;
  for (let i = 0; i < currentBids.length; i++) {
    if (currentBids[i][1] > maxLiveWall) maxLiveWall = currentBids[i][1];
  }
  for (let i = 0; i < currentAsks.length; i++) {
    if (currentAsks[i][1] > maxLiveWall) maxLiveWall = currentAsks[i][1];
  }

  const vpvrMap = new Map<number, number>();
  const inv = 1 / priceStep;
  let maxVpvrRaw = 1;

  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const lowBucket = Math.floor(k.l * inv) * priceStep;
    const highBucket = Math.floor(k.h * inv) * priceStep;
    const numBuckets = Math.max(1, Math.round((highBucket - lowBucket) / priceStep) + 1);
    const volPerBucket = k.vol / numBuckets;

    for (let b = lowBucket; b <= highBucket + 1e-6; b += priceStep) {
      const key = +b.toFixed(2);
      const distFromBody =
        b >= Math.min(k.o, k.c) - priceStep && b <= Math.max(k.o, k.c) + priceStep
          ? 1.35
          : 0.75;
      const nextVal = (vpvrMap.get(key) || 0) + volPerBucket * distFromBody;
      vpvrMap.set(key, nextVal);
      if (nextVal > maxVpvrRaw) maxVpvrRaw = nextVal;
    }
  }

  // Pre-compute scaled VPVR entries and compact live levels once before iterating candles
  const vpvrEntries: [number, number][] = [];
  for (const [b, v] of vpvrMap.entries()) {
    const scaledBtc = +((v / maxVpvrRaw) * maxLiveWall * 0.45).toFixed(2);
    if (scaledBtc >= 0.25) {
      vpvrEntries.push([b, scaledBtc]);
    }
  }

  const anchorMid = lastPrice > 0 ? lastPrice : klines[klines.length - 1].c;
  const compactLiveBids = compactLevelsForHistory(currentBids, anchorMid, 120);
  const compactLiveAsks = compactLevelsForHistory(currentAsks, anchorMid, 120);
  const earliestRecordedTime = baseSlices.length > 0 ? baseSlices[0].t : Infinity;
  const slices: HeatmapSlice[] = [];

  for (let i = 0; i < klines.length; i++) {
    const k = { ...klines[i] };
    const candleEnd = k.t + intervalMs;

    const range = Math.max(0.01, k.h - k.l);
    const closeStrength = (k.c - k.l) / range;
    const bodySign = k.c >= k.o ? 0.08 : -0.08;
    const buyRatio = Math.max(0.12, Math.min(0.88, closeStrength + bodySign));
    const bv = +(k.vol * buyRatio).toFixed(3);
    const sv = +(k.vol * (1 - buyRatio)).toFixed(3);

    let sliceBids: [number, number][] = [];
    let sliceAsks: [number, number][] = [];
    const trades: AggregatedTradeBubble[] = [];

    if (candleEnd >= earliestRecordedTime && baseSlices.length > 0) {
      let matchedBase: HeatmapSlice | null = null;
      for (let j = baseSlices.length - 1; j >= 0; j--) {
        const bs = baseSlices[j];
        if (bs.t >= k.t && bs.t <= candleEnd) {
          if (!matchedBase) matchedBase = bs;
          for (const tr of bs.trades) trades.push(tr);
        } else if (bs.t < k.t) {
          break;
        }
      }
      if (matchedBase && useRecordedSnapshots) {
        sliceBids = reBucketLevels(matchedBase.bids, priceStep);
        sliceAsks = reBucketLevels(matchedBase.asks, priceStep);
      }
      if (i === klines.length - 1 && lastPrice > 0) {
        if (lastPrice > k.h) k.h = lastPrice;
        if (lastPrice < k.l) k.l = lastPrice;
        k.c = lastPrice;
      }
    }

    const mergedBids = new Map<number, number>();
    const mergedAsks = new Map<number, number>();

    for (let vIdx = 0; vIdx < vpvrEntries.length; vIdx++) {
      const [b, scaledBtc] = vpvrEntries[vIdx];
      if (b <= k.c) mergedBids.set(b, scaledBtc);
      else mergedAsks.set(b, scaledBtc);
    }

    for (let idx = 0; idx < compactLiveBids.length; idx++) {
      const [b, v] = compactLiveBids[idx];
      const cur = mergedBids.get(b) || 0;
      if (v > cur) mergedBids.set(b, v);
    }
    for (let idx = 0; idx < compactLiveAsks.length; idx++) {
      const [b, v] = compactLiveAsks[idx];
      const cur = mergedAsks.get(b) || 0;
      if (v > cur) mergedAsks.set(b, v);
    }

    for (let idx = 0; idx < sliceBids.length; idx++) {
      const [b, v] = sliceBids[idx];
      mergedBids.set(b, v);
    }
    for (let idx = 0; idx < sliceAsks.length; idx++) {
      const [b, v] = sliceAsks[idx];
      mergedAsks.set(b, v);
    }

    if (trades.length === 0 && k.vol > 0) {
      const isBull = k.c >= k.o;
      trades.push({
        t: k.t + Math.floor(intervalMs / 2),
        p: +((k.o + k.c + k.h + k.l) / 4).toFixed(2),
        v: +Math.max(bv, sv).toFixed(2),
        s: isBull ? 'Buy' : 'Sell',
        count: 1,
        maxSingle: Math.max(bv, sv),
      });
    }

    const bidArr = Array.from(mergedBids.entries()).sort((a, b) => Math.abs(a[0] - k.c) - Math.abs(b[0] - k.c));
    const askArr = Array.from(mergedAsks.entries()).sort((a, b) => Math.abs(a[0] - k.c) - Math.abs(b[0] - k.c));

    slices.push({
      t: k.t,
      bb: +(k.c - spread / 2).toFixed(2),
      ba: +(k.c + spread / 2).toFixed(2),
      mid: k.c,
      o: k.o,
      h: k.h,
      l: k.l,
      c: k.c,
      bv,
      sv,
      bids: compactLevelsForHistory(bidArr, k.c, 120),
      asks: compactLevelsForHistory(askArr, k.c, 120),
      trades,
    });
  }

  return slices;
}

export function groupTickSlices(
  baseSlices: HeatmapSlice[],
  timeframeMs: number,
  priceStep: PriceStep,
  useBaseSlices: boolean,
  fallbackBids: [number, number][],
  fallbackAsks: [number, number][],
  maxColumns: number
): HeatmapSlice[] {
  const groupFactor = Math.max(1, Math.round(timeframeMs / BASE_TIME_STEP_MS));
  const totalBase = baseSlices.length;
  const startIdx = Math.max(0, totalBase - maxColumns * groupFactor);
  const slices: HeatmapSlice[] = [];

  for (let i = startIdx; i < totalBase; i += groupFactor) {
    const end = Math.min(totalBase, i + groupFactor);
    const first = baseSlices[i];
    const last = baseSlices[end - 1];

    let h = first.h;
    let l = first.l;
    let bv = 0;
    let sv = 0;
    let spotBv = 0;
    let spotSv = 0;
    const trades: AggregatedTradeBubble[] = [];
    const liquidations: LiquidationEvent[] = [];

    for (let j = i; j < end; j++) {
      const s = baseSlices[j];
      if (s.h > h) h = s.h;
      if (s.l < l) l = s.l;
      bv += s.bv;
      sv += s.sv;
      spotBv += s.spotBv || 0;
      spotSv += s.spotSv || 0;
      for (const tr of s.trades) {
        trades.push(tr);
      }
      if (s.liquidations) {
        for (const lq of s.liquidations) liquidations.push(lq);
      }
    }

    const bids = useBaseSlices ? reBucketLevels(last.bids, priceStep) : fallbackBids;
    const asks = useBaseSlices ? reBucketLevels(last.asks, priceStep) : fallbackAsks;

    slices.push({
      t: last.t,
      bb: last.bb,
      ba: last.ba,
      mid: last.mid,
      o: first.o,
      h,
      l,
      c: last.c,
      bv: +bv.toFixed(4),
      sv: +sv.toFixed(4),
      spotBv: +spotBv.toFixed(4),
      spotSv: +spotSv.toFixed(4),
      bids,
      asks,
      trades,
      liquidations: liquidations.length > 0 ? liquidations : undefined,
    });
  }

  return slices;
}

export function capOuterMap<V>(map: Map<number, V>, maxEntries = MAX_OUTER_LEVELS) {
  if (map.size <= maxEntries) return;
  const toDelete = map.size - maxEntries;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed++;
    if (removed >= toDelete) break;
  }
}

export function loadCollectorCheckpoint(
  checkpointPath: string,
  ticker: TickerStats
): {
  baseSlices: HeatmapSlice[];
  recentTrades: TradeEvent[];
  whaleTrades: TradeEvent[];
  recentLiquidations: LiquidationEvent[];
} {
  try {
    if (!fs.existsSync(checkpointPath)) {
      return { baseSlices: [], recentTrades: [], whaleTrades: [], recentLiquidations: [] };
    }
    const raw = fs.readFileSync(checkpointPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      baseSlices?: HeatmapSlice[];
      recentTrades?: TradeEvent[];
      whaleTrades?: TradeEvent[];
      recentLiquidations?: LiquidationEvent[];
      ticker?: Partial<TickerStats>;
    };
    const rawSlices = Array.isArray(parsed.baseSlices)
      ? parsed.baseSlices.slice(-MAX_RING_SLICES)
      : [];
    const baseSlices = rawSlices.map((s) => ({
      ...s,
      bids: compactLevelsForHistory(s.bids || [], s.mid || 0),
      asks: compactLevelsForHistory(s.asks || [], s.mid || 0),
    }));
    const recentTrades = Array.isArray(parsed.recentTrades)
      ? parsed.recentTrades.slice(0, MAX_RECENT_TRADES)
      : [];
    const whaleTrades = Array.isArray(parsed.whaleTrades)
      ? parsed.whaleTrades.slice(0, MAX_WHALE_TRADES)
      : recentTrades.filter((t) => t.v >= WHALE_TRADE_MIN_BTC).slice(0, MAX_WHALE_TRADES);
    const recentLiquidations = Array.isArray(parsed.recentLiquidations)
      ? parsed.recentLiquidations.slice(0, MAX_LIQUIDATIONS)
      : [];
    ticker.storedBaseSlices = baseSlices.length;
    if (parsed.ticker?.lastPrice) {
      ticker.lastPrice = parsed.ticker.lastPrice;
      ticker.bestBid = parsed.ticker.bestBid || parsed.ticker.lastPrice;
      ticker.bestAsk = parsed.ticker.bestAsk || parsed.ticker.lastPrice;
    }
    return { baseSlices, recentTrades, whaleTrades, recentLiquidations };
  } catch {
    return { baseSlices: [], recentTrades: [], whaleTrades: [], recentLiquidations: [] };
  }
}

const inFlightCheckpoints = new Set<string>();

export function saveCollectorCheckpoint(
  checkpointPath: string,
  baseSlices: HeatmapSlice[],
  recentTrades: TradeEvent[],
  ticker: TickerStats,
  whaleTrades: TradeEvent[] = [],
  recentLiquidations: LiquidationEvent[] = []
) {
  try {
    if (baseSlices.length === 0) return;
    const tmpPath = `${checkpointPath}.tmp`;
    const payload = JSON.stringify({
      savedAt: Date.now(),
      baseSlices: baseSlices.slice(-250),
      recentTrades: recentTrades.slice(0, 120),
      whaleTrades: whaleTrades.slice(0, MAX_WHALE_TRADES),
      recentLiquidations: recentLiquidations.slice(0, MAX_LIQUIDATIONS),
      ticker,
    });
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, checkpointPath);
  } catch {
    // Ignore disk write error
  }
}

export async function saveCollectorCheckpointAsync(
  checkpointPath: string,
  baseSlices: HeatmapSlice[],
  recentTrades: TradeEvent[],
  ticker: TickerStats,
  whaleTrades: TradeEvent[] = [],
  recentLiquidations: LiquidationEvent[] = []
): Promise<void> {
  if (baseSlices.length === 0 || inFlightCheckpoints.has(checkpointPath)) return;
  inFlightCheckpoints.add(checkpointPath);
  try {
    const tmpPath = `${checkpointPath}.tmp`;
    const payload = JSON.stringify({
      savedAt: Date.now(),
      baseSlices: baseSlices.slice(-250),
      recentTrades: recentTrades.slice(0, 120),
      whaleTrades: whaleTrades.slice(0, MAX_WHALE_TRADES),
      recentLiquidations: recentLiquidations.slice(0, MAX_LIQUIDATIONS),
      ticker,
    });
    await fs.promises.writeFile(tmpPath, payload, 'utf-8');
    await fs.promises.rename(tmpPath, checkpointPath);
  } catch {
    // Ignore transient disk write error
  } finally {
    inFlightCheckpoints.delete(checkpointPath);
  }
}
