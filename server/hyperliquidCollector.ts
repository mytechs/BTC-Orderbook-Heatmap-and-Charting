import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type {
  AggregatedTradeBubble,
  HeatmapSlice,
  HyperliquidBookScope,
  InitialHistoryResponse,
  LiquidationEvent,
  MarketCoverageItem,
  PriceStep,
  TickerStats,
  TimeframeId,
  TradeEvent,
  VenueBreakdown,
} from '../shared/types.ts';
import {
  type AggregatedClusterResult,
  BASE_PRICE_STEP,
  LIVE_TICK_MS,
  MAX_LIQUIDATIONS,
  MAX_RING_SLICES,
  MAX_WHALE_TRADES,
  type RawKline,
  TIMEFRAME_CONFIG,
  WHALE_TRADE_MIN_BTC,
  appendTradeBuffers,
  buildClusterMetrics,
  buildKlineHeatmapSlices,
  compactLevelsForHistory,
  groupTickSlices,
  loadCollectorCheckpoint,
  reBucketAggregatedResult,
  saveCollectorCheckpoint,
  saveCollectorCheckpointAsync,
} from './collectorUtils.ts';

const HL_REST_INFO = 'https://api.hyperliquid.xyz/info';
const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const HL_PERP_COIN = 'BTC';
const HL_SPOT_COIN = '@142'; // UBTC/USDC spot on Hyperliquid

interface HlLevel {
  px: string;
  sz: string;
  n: number;
}

interface HlBookLayer {
  bids: [number, number][]; // [price, sizeBtc] sorted desc
  asks: [number, number][]; // [price, sizeBtc] sorted asc
  updatedAt: number;
}

interface KlineCacheEntry {
  fetchedAt: number;
  candles: RawKline[];
}

function emptyLayer(): HlBookLayer {
  return { bids: [], asks: [], updatedAt: 0 };
}

function parseHlLevels(raw: HlLevel[] | undefined, descending: boolean): [number, number][] {
  if (!Array.isArray(raw)) return [];
  const out: [number, number][] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = parseFloat(raw[i].px);
    const s = parseFloat(raw[i].sz);
    if (Number.isFinite(p) && Number.isFinite(s) && p > 0 && s > 0) {
      out.push([p, s]);
    }
  }
  out.sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
  return out;
}

async function postHlInfo<T>(body: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(HL_REST_INFO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export class HyperliquidOrderbookCollector {
  // Multi-granularity non-overlapping Perp book: $1 inner (WS) + $10 mid + $100 deep (REST)
  private perpInner = emptyLayer();
  private perpMid = emptyLayer();
  private perpDeep = emptyLayer();
  // UBTC/USDC Spot book ($1 inner via WS + $10 mid via REST)
  private spotInner = emptyLayer();
  private spotMid = emptyLayer();

  private perpConnected = false;
  private spotConnected = false;

  private baseSlices: HeatmapSlice[] = [];
  private recentTrades: TradeEvent[] = [];
  private whaleTrades: TradeEvent[] = [];
  private recentLiquidations: LiquidationEvent[] = [];
  private seenTradeIds = new Set<string>();
  private klineCache = new Map<TimeframeId, KlineCacheEntry>();
  private baseAggCache = new Map<
    HyperliquidBookScope,
    { updateCount: number; computedAt: number; result: AggregatedClusterResult }
  >();

  private pendingTrades: TradeEvent[] = [];
  private pendingLiquidations: LiquidationEvent[] = [];
  private windowBuyVol = 0;
  private windowSellVol = 0;
  private windowSpotBuyVol = 0;
  private windowSpotSellVol = 0;
  private windowOpen = 0;
  private windowHigh = 0;
  private windowLow = 0;
  private windowClose = 0;

  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private deepBookTimer: NodeJS.Timeout | null = null;
  private sliceTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private tickCounter = 0;
  private hasClientsFn: () => boolean = () => true;

  private checkpointPath: string;
  private onTickCallback:
    | ((basePayload: {
        baseSlice: HeatmapSlice;
        newTrades: TradeEvent[];
        newLiquidations: LiquidationEvent[];
        ticker: TickerStats;
      }) => void)
    | null = null;
  private onTradesCallback: ((trades: TradeEvent[]) => void) | null = null;
  private onPricePulseCallback: (() => void) | null = null;

  public ticker: TickerStats = {
    exchange: 'hyperliquid',
    symbol: 'BTC',
    lastPrice: 0,
    spotPrice: 0,
    markPrice: 0,
    indexPrice: 0,
    price24hPcnt: 0,
    highPrice24h: 0,
    lowPrice24h: 0,
    volume24h: 0,
    turnover24h: 0,
    openInterestValue: 0,
    fundingRate: 0,
    bestBid: 0,
    bestAsk: 0,
    spread: 0,
    totalBidBtc: 0,
    totalAskBtc: 0,
    imbalancePct: 0,
    activeBidLevels: 0,
    activeAskLevels: 0,
    minBookPrice: 0,
    maxBookPrice: 0,
    connected: false,
    updateCount: 0,
    storedBaseSlices: 0,
    coverageItems: [],
  };

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.checkpointPath = path.join(dataDir, 'hyperliquid-checkpoint.json');
    const restored = loadCollectorCheckpoint(this.checkpointPath, this.ticker);
    this.baseSlices = restored.baseSlices;
    this.recentTrades = restored.recentTrades;
    this.whaleTrades = restored.whaleTrades;
    this.recentLiquidations = restored.recentLiquidations;
  }

  public onTick(
    cb: (basePayload: {
      baseSlice: HeatmapSlice;
      newTrades: TradeEvent[];
      newLiquidations: LiquidationEvent[];
      ticker: TickerStats;
    }) => void
  ) {
    this.onTickCallback = cb;
  }

  public onTrades(cb: (trades: TradeEvent[]) => void) {
    this.onTradesCallback = cb;
  }

  public onPricePulse(cb: () => void) {
    this.onPricePulseCallback = cb;
  }

  public setHasClientsFn(fn: () => boolean) {
    this.hasClientsFn = fn;
  }

  public start() {
    this.bootstrapInitialData().catch(() => {});
    this.connectWs();

    // Poll deeper Hyperliquid book granularities ($10 and $100) + spot mid depth smoothly
    this.deepBookTimer = setInterval(() => {
      this.pollDeepBooks().catch(() => {});
    }, 2000);

    this.sliceTimer = setInterval(() => {
      this.emitTimeSlice();
    }, LIVE_TICK_MS);

    this.checkpointTimer = setInterval(() => {
      saveCollectorCheckpointAsync(
        this.checkpointPath,
        this.baseSlices,
        this.recentTrades,
        this.ticker,
        this.whaleTrades,
        this.recentLiquidations
      ).catch(() => {});
    }, 83_000);
  }

  public stop() {
    for (const t of [
      this.pingTimer,
      this.reconnectTimer,
      this.deepBookTimer,
      this.sliceTimer,
      this.checkpointTimer,
    ]) {
      if (t) {
        clearInterval(t);
        clearTimeout(t);
      }
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    saveCollectorCheckpoint(
      this.checkpointPath,
      this.baseSlices,
      this.recentTrades,
      this.ticker,
      this.whaleTrades,
      this.recentLiquidations
    );
  }

  private async bootstrapInitialData() {
    await Promise.all([this.pollMetaAndCtx(), this.pollDeepBooks(), this.pollInitialInnerBooks()]);
    this.recomputeAggregateBounds();
  }

  private async pollMetaAndCtx() {
    const res = await postHlInfo<
      [{ universe: { name: string }[] }, Record<string, string | string[]>[]]
    >({ type: 'metaAndAssetCtxs' });
    if (!Array.isArray(res) || res.length < 2) return;
    const [meta, ctxs] = res;
    const idx = meta?.universe?.findIndex((u) => u.name === HL_PERP_COIN);
    if (idx !== undefined && idx >= 0 && ctxs[idx]) {
      this.applyAssetCtx(ctxs[idx]);
    }
  }

  private async pollInitialInnerBooks() {
    const [perpInner, spotInner] = await Promise.all([
      postHlInfo<{ levels?: [HlLevel[], HlLevel[]] }>({ type: 'l2Book', coin: HL_PERP_COIN }),
      postHlInfo<{ levels?: [HlLevel[], HlLevel[]] }>({ type: 'l2Book', coin: HL_SPOT_COIN }),
    ]);
    const now = Date.now();
    if (perpInner?.levels) {
      this.perpInner = {
        bids: parseHlLevels(perpInner.levels[0], true),
        asks: parseHlLevels(perpInner.levels[1], false),
        updatedAt: now,
      };
      this.perpConnected = true;
      this.ticker.updateCount++;
      this.recomputeFastPrimaryBounds(true);
    }
    if (spotInner?.levels) {
      this.spotInner = {
        bids: parseHlLevels(spotInner.levels[0], true),
        asks: parseHlLevels(spotInner.levels[1], false),
        updatedAt: now,
      };
      this.spotConnected = true;
      if (this.spotInner.bids[0] && this.spotInner.asks[0]) {
        this.ticker.spotPrice = +((this.spotInner.bids[0][0] + this.spotInner.asks[0][0]) / 2).toFixed(2);
      }
      this.ticker.updateCount++;
    }
  }

  private async pollDeepBooks() {
    const [perpMid, perpDeep, spotMid] = await Promise.all([
      postHlInfo<{ levels?: [HlLevel[], HlLevel[]] }>({
        type: 'l2Book',
        coin: HL_PERP_COIN,
        nSigFigs: 4,
      }),
      postHlInfo<{ levels?: [HlLevel[], HlLevel[]] }>({
        type: 'l2Book',
        coin: HL_PERP_COIN,
        nSigFigs: 3,
      }),
      postHlInfo<{ levels?: [HlLevel[], HlLevel[]] }>({
        type: 'l2Book',
        coin: HL_SPOT_COIN,
        nSigFigs: 4,
      }),
    ]);
    const now = Date.now();
    if (perpMid?.levels) {
      this.perpMid = {
        bids: parseHlLevels(perpMid.levels[0], true),
        asks: parseHlLevels(perpMid.levels[1], false),
        updatedAt: now,
      };
    }
    if (perpDeep?.levels) {
      this.perpDeep = {
        bids: parseHlLevels(perpDeep.levels[0], true),
        asks: parseHlLevels(perpDeep.levels[1], false),
        updatedAt: now,
      };
    }
    if (spotMid?.levels) {
      this.spotMid = {
        bids: parseHlLevels(spotMid.levels[0], true),
        asks: parseHlLevels(spotMid.levels[1], false),
        updatedAt: now,
      };
    }
    this.ticker.updateCount++;
  }

  private connectWs() {
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }

    const ws = new WebSocket(HL_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[Hyperliquid WS] Connected (BTC Perp + UBTC Spot)');
      this.perpConnected = true;
      this.spotConnected = true;
      this.ticker.connected = true;

      const subs = [
        { type: 'l2Book', coin: HL_PERP_COIN },
        { type: 'l2Book', coin: HL_SPOT_COIN },
        { type: 'trades', coin: HL_PERP_COIN },
        { type: 'trades', coin: HL_SPOT_COIN },
        { type: 'activeAssetCtx', coin: HL_PERP_COIN },
      ];
      for (const subscription of subs) {
        ws.send(JSON.stringify({ method: 'subscribe', subscription }));
      }

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'ping' }));
        }
      }, 25_000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          channel?: string;
          data?: unknown;
        };
        if (!msg.channel || !msg.data) return;

        if (msg.channel === 'l2Book') {
          const d = msg.data as { coin?: string; levels?: [HlLevel[], HlLevel[]] };
          if (!d.levels) return;
          const now = Date.now();
          if (d.coin === HL_PERP_COIN) {
            this.perpInner = {
              bids: parseHlLevels(d.levels[0], true),
              asks: parseHlLevels(d.levels[1], false),
              updatedAt: now,
            };
            this.perpConnected = true;
            this.ticker.updateCount++;
            this.recomputeFastPrimaryBounds(true);
          } else if (d.coin === HL_SPOT_COIN) {
            this.spotInner = {
              bids: parseHlLevels(d.levels[0], true),
              asks: parseHlLevels(d.levels[1], false),
              updatedAt: now,
            };
            this.spotConnected = true;
            if (this.spotInner.bids[0] && this.spotInner.asks[0]) {
              this.ticker.spotPrice = +(
                (this.spotInner.bids[0][0] + this.spotInner.asks[0][0]) /
                2
              ).toFixed(2);
            }
            this.ticker.updateCount++;
          }
        } else if (msg.channel === 'trades') {
          const list = msg.data as {
            coin?: string;
            side?: string;
            px?: string;
            sz?: string;
            time?: number;
            tid?: number;
          }[];
          if (Array.isArray(list)) {
            this.handleWsTrades(list);
          }
        } else if (msg.channel === 'activeAssetCtx') {
          const d = msg.data as { coin?: string; ctx?: Record<string, string | string[]> };
          if (d.coin === HL_PERP_COIN && d.ctx) {
            this.applyAssetCtx(d.ctx);
          }
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.perpConnected = false;
      this.spotConnected = false;
      this.ticker.connected = false;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connectWs(), 2000);
    });

    ws.on('error', () => {
      this.ticker.connected = false;
    });
  }

  private applyAssetCtx(ctx: Record<string, string | string[]>) {
    const markPx = parseFloat(String(ctx.markPx || '0'));
    const oraclePx = parseFloat(String(ctx.oraclePx || '0'));
    const prevDayPx = parseFloat(String(ctx.prevDayPx || '0'));
    const funding = parseFloat(String(ctx.funding || '0'));
    const oiBtc = parseFloat(String(ctx.openInterest || '0'));
    const dayNtlVlm = parseFloat(String(ctx.dayNtlVlm || '0'));
    const dayBaseVlm = parseFloat(String(ctx.dayBaseVlm || '0'));

    if (markPx > 0) {
      this.ticker.markPrice = markPx;
      if (this.ticker.lastPrice === 0) this.ticker.lastPrice = markPx;
    }
    if (oraclePx > 0) this.ticker.indexPrice = oraclePx;
    if (markPx > 0 && prevDayPx > 0) {
      this.ticker.price24hPcnt = +(((markPx - prevDayPx) / prevDayPx) * 100).toFixed(2);
    }
    if (Number.isFinite(funding)) this.ticker.fundingRate = +(funding * 100).toFixed(4);
    if (oiBtc > 0 && markPx > 0) this.ticker.openInterestValue = Math.round(oiBtc * markPx);
    if (dayNtlVlm > 0) this.ticker.turnover24h = Math.round(dayNtlVlm);
    if (dayBaseVlm > 0) this.ticker.volume24h = +dayBaseVlm.toFixed(2);
  }

  private updateWindowPrice(price: number) {
    if (price <= 0) return;
    if (this.windowOpen === 0) {
      this.windowOpen = price;
      this.windowHigh = price;
      this.windowLow = price;
    } else {
      if (price > this.windowHigh) this.windowHigh = price;
      if (price < this.windowLow) this.windowLow = price;
    }
    this.windowClose = price;
  }

  private handleWsTrades(
    list: {
      coin?: string;
      side?: string;
      px?: string;
      sz?: string;
      time?: number;
      tid?: number;
    }[]
  ) {
    const accepted: TradeEvent[] = [];

    for (const item of list) {
      const isSpot = item.coin === HL_SPOT_COIN;
      if (!isSpot && item.coin !== HL_PERP_COIN) continue;

      const price = parseFloat(item.px || '0');
      const vol = parseFloat(item.sz || '0');
      if (!Number.isFinite(price) || !Number.isFinite(vol) || price <= 0 || vol <= 0) continue;

      const id = `hl-${isSpot ? 's' : 'p'}-${item.tid || `${item.time}-${price}-${vol}`}`;
      if (this.seenTradeIds.has(id)) continue;
      this.seenTradeIds.add(id);
      if (this.seenTradeIds.size > 2000) {
        const firstKey = this.seenTradeIds.values().next().value;
        if (firstKey) this.seenTradeIds.delete(firstKey);
      }

      const side: 'Buy' | 'Sell' = item.side === 'B' ? 'Buy' : 'Sell';
      const trade: TradeEvent = {
        id,
        t: item.time || Date.now(),
        p: price,
        v: vol,
        s: side,
        exchange: 'HL',
        market: isSpot ? 'SPOT' : 'PERP',
      };

      if (isSpot) {
        this.ticker.spotPrice = price;
        if (side === 'Buy') this.windowSpotBuyVol += vol;
        else this.windowSpotSellVol += vol;
        if (vol >= WHALE_TRADE_MIN_BTC) {
          appendTradeBuffers(this.recentTrades, this.whaleTrades, trade);
          this.pendingTrades.push(trade);
        }
      } else {
        this.ticker.lastPrice = price;
        this.updateWindowPrice(price);
        if (side === 'Buy') this.windowBuyVol += vol;
        else this.windowSellVol += vol;
        this.pendingTrades.push(trade);
        appendTradeBuffers(this.recentTrades, this.whaleTrades, trade);
      }

      accepted.push(trade);
    }

    if (accepted.length > 0 && this.onTradesCallback) {
      this.onTradesCallback(accepted);
    }
  }

  private recomputeFastPrimaryBounds(updateWindow = true) {
    const bb = this.perpInner.bids[0]?.[0] || 0;
    const ba = this.perpInner.asks[0]?.[0] || 0;
    if (bb <= 0 || ba <= 0) return;

    const mid = (bb + ba) / 2;
    this.ticker.bestBid = bb;
    this.ticker.bestAsk = ba;
    this.ticker.spread = Math.max(0, +(ba - bb).toFixed(2));
    this.ticker.connected = this.perpConnected || this.spotConnected;

    if (this.ticker.lastPrice === 0) {
      this.ticker.lastPrice = +mid.toFixed(2);
    }

    if (updateWindow) {
      this.updateWindowPrice(mid);
      if (this.onPricePulseCallback) this.onPricePulseCallback();
    }
  }

  private getMergedLayerLevels(
    inner: HlBookLayer,
    mid: HlBookLayer,
    deep?: HlBookLayer
  ): { bids: [number, number][]; asks: [number, number][] } {
    const bids: [number, number][] = [];
    const asks: [number, number][] = [];

    // 1. Exact $1 inner levels
    let minInnerBid = Infinity;
    for (const [p, s] of inner.bids) {
      bids.push([p, s]);
      if (p < minInnerBid) minInnerBid = p;
    }
    let maxInnerAsk = -Infinity;
    for (const [p, s] of inner.asks) {
      asks.push([p, s]);
      if (p > maxInnerAsk) maxInnerAsk = p;
    }

    // 2. Non-overlapping $10 mid levels outside inner range
    const midBidCut = Number.isFinite(minInnerBid) ? Math.floor(minInnerBid / 10) * 10 : Infinity;
    const midAskCut = Number.isFinite(maxInnerAsk) ? Math.ceil(maxInnerAsk / 10) * 10 : -Infinity;
    let minMidBid = minInnerBid;
    let maxMidAsk = maxInnerAsk;

    for (const [p, s] of mid.bids) {
      if (p < midBidCut) {
        bids.push([p, s]);
        if (p < minMidBid) minMidBid = p;
      }
    }
    for (const [p, s] of mid.asks) {
      if (p > midAskCut) {
        asks.push([p, s]);
        if (p > maxMidAsk) maxMidAsk = p;
      }
    }

    // 3. Non-overlapping $100 deep levels outside mid range
    if (deep) {
      const deepBidCut = Number.isFinite(minMidBid) ? Math.floor(minMidBid / 100) * 100 : Infinity;
      const deepAskCut = Number.isFinite(maxMidAsk) ? Math.ceil(maxMidAsk / 100) * 100 : -Infinity;
      for (const [p, s] of deep.bids) {
        if (p < deepBidCut) bids.push([p, s]);
      }
      for (const [p, s] of deep.asks) {
        if (p > deepAskCut) asks.push([p, s]);
      }
    }

    return { bids, asks };
  }

  private recomputeAggregateBounds(precomputedAgg?: AggregatedClusterResult, updateWindow = true) {
    this.recomputeFastPrimaryBounds(updateWindow);
    const perpLevels = this.getMergedLayerLevels(this.perpInner, this.perpMid, this.perpDeep);
    const spotLevels = this.getMergedLayerLevels(this.spotInner, this.spotMid);

    const makeCov = (
      id: string,
      label: string,
      badgeClass: string,
      levels: { bids: [number, number][]; asks: [number, number][] },
      connected: boolean
    ): MarketCoverageItem => {
      let bidBtc = 0;
      let askBtc = 0;
      let minP = Infinity;
      let maxP = -Infinity;
      for (const [p, s] of levels.bids) {
        bidBtc += s;
        if (p < minP) minP = p;
      }
      for (const [p, s] of levels.asks) {
        askBtc += s;
        if (p > maxP) maxP = p;
      }
      return {
        id,
        label,
        badgeClass,
        bidBtc: +bidBtc.toFixed(2),
        askBtc: +askBtc.toFixed(2),
        bidLevels: levels.bids.length,
        askLevels: levels.asks.length,
        minPrice: minP < Infinity ? minP : 0,
        maxPrice: maxP > -Infinity ? maxP : 0,
        connected,
      };
    };

    this.ticker.coverageItems = [
      makeCov('PERP', 'HL PERP', 'tag-hl', perpLevels, this.perpConnected),
      makeCov('SPOT', 'HL UBTC', 'tag-spot', spotLevels, this.spotConnected),
    ];

    const agg = precomputedAgg || this.getAggregatedBook('all', 1, false);
    this.ticker.totalBidBtc = agg.totalBidBtc;
    this.ticker.totalAskBtc = agg.totalAskBtc;
    const total = agg.totalBidBtc + agg.totalAskBtc;
    this.ticker.imbalancePct =
      total > 0 ? +(((agg.totalBidBtc - agg.totalAskBtc) / total) * 100).toFixed(1) : 0;
    this.ticker.activeBidLevels = agg.activeBidLevels;
    this.ticker.activeAskLevels = agg.activeAskLevels;
    this.ticker.minBookPrice = agg.minBookPrice;
    this.ticker.maxBookPrice = agg.maxBookPrice;
  }

  public getAggregatedBook(
    scope: HyperliquidBookScope,
    priceStep: PriceStep,
    includeClusters = true
  ): AggregatedClusterResult {
    const mid =
      this.ticker.bestBid > 0 && this.ticker.bestAsk > 0
        ? (this.ticker.bestBid + this.ticker.bestAsk) / 2
        : this.ticker.lastPrice;
    const venueOrder = ['HLP', 'HLS'];

    if (priceStep >= 1) {
      const now = Date.now();
      const cached = this.baseAggCache.get(scope);
      if (
        cached &&
        cached.result.bids.length > 0 &&
        cached.result.asks.length > 0 &&
        (cached.updateCount === this.ticker.updateCount || now - cached.computedAt < 180)
      ) {
        return reBucketAggregatedResult(cached.result, priceStep, includeClusters, mid, venueOrder);
      }
      const baseRes = this.computeRawAggregatedBook(scope, BASE_PRICE_STEP, false);
      this.baseAggCache.set(scope, {
        updateCount: this.ticker.updateCount,
        computedAt: now,
        result: baseRes,
      });
      return reBucketAggregatedResult(baseRes, priceStep, includeClusters, mid, venueOrder);
    }

    return this.computeRawAggregatedBook(scope, priceStep, includeClusters);
  }

  private computeRawAggregatedBook(
    scope: HyperliquidBookScope,
    priceStep: PriceStep,
    includeClusters: boolean
  ): AggregatedClusterResult {
    const inv = 1 / priceStep;
    const bidBuckets = new Map<number, VenueBreakdown>();
    const askBuckets = new Map<number, VenueBreakdown>();

    const anchorBid = this.ticker.bestBid || Infinity;
    const anchorAsk = this.ticker.bestAsk || 0;
    const refMid =
      anchorBid < Infinity && anchorAsk > 0 ? (anchorBid + anchorAsk) / 2 : this.ticker.lastPrice;
    const minValidPrice = refMid > 0 ? refMid * 0.65 : 0;
    const maxValidPrice = refMid > 0 ? refMid * 1.35 : Infinity;

    let totalBidBtc = 0;
    let totalAskBtc = 0;
    let activeBidLevels = 0;
    let activeAskLevels = 0;
    let minPrice = Infinity;
    let maxPrice = -Infinity;

    const addBucket = (
      map: Map<number, VenueBreakdown>,
      price: number,
      size: number,
      venue: string
    ) => {
      if (size <= 0 || price < minValidPrice || price > maxValidPrice) return;
      const b = +(Math.floor(price * inv + 1e-9) * priceStep).toFixed(2);
      let entry = map.get(b);
      if (!entry) {
        entry = {};
        map.set(b, entry);
      }
      entry[venue] = (entry[venue] || 0) + size;
    };

    const ingest = (
      levels: { bids: [number, number][]; asks: [number, number][] },
      venue: string,
      clamp: boolean
    ) => {
      for (const [p, s] of levels.bids) {
        if (clamp && anchorAsk > 0 && p >= anchorAsk) continue;
        if (p < minValidPrice || p > maxValidPrice) continue;
        addBucket(bidBuckets, p, s, venue);
        totalBidBtc += s;
        activeBidLevels++;
        if (p < minPrice) minPrice = p;
      }
      for (const [p, s] of levels.asks) {
        if (clamp && anchorBid < Infinity && p <= anchorBid) continue;
        if (p < minValidPrice || p > maxValidPrice) continue;
        addBucket(askBuckets, p, s, venue);
        totalAskBtc += s;
        activeAskLevels++;
        if (p > maxPrice) maxPrice = p;
      }
    };

    if (scope === 'all' || scope === 'perp') {
      ingest(this.getMergedLayerLevels(this.perpInner, this.perpMid, this.perpDeep), 'HLP', false);
    }
    if (scope === 'all' || scope === 'spot') {
      ingest(this.getMergedLayerLevels(this.spotInner, this.spotMid), 'HLS', scope === 'all');
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
      ? buildClusterMetrics(bids, asks, bidBuckets, askBuckets, refMid, ['HLP', 'HLS'])
      : { bidClusters: [], askClusters: [], clusterSummary: [] };

    return {
      bids,
      asks,
      bidBreakdowns: bidBuckets,
      askBreakdowns: askBuckets,
      ...clusters,
      totalBidBtc: +totalBidBtc.toFixed(2),
      totalAskBtc: +totalAskBtc.toFixed(2),
      activeBidLevels,
      activeAskLevels,
      minBookPrice: minPrice < Infinity ? +minPrice.toFixed(2) : 0,
      maxBookPrice: maxPrice > -Infinity ? +maxPrice.toFixed(2) : 0,
    };
  }

  public getRecentTrades(limit = 120): TradeEvent[] {
    return this.recentTrades.slice(0, limit);
  }

  public getWhaleTrades(limit = MAX_WHALE_TRADES): TradeEvent[] {
    return this.whaleTrades.slice(0, limit);
  }

  public getRecentLiquidations(limit = MAX_LIQUIDATIONS): LiquidationEvent[] {
    return this.recentLiquidations.slice(0, limit);
  }

  public async getKlines(timeframe: TimeframeId): Promise<RawKline[]> {
    const cfg = TIMEFRAME_CONFIG[timeframe];
    if (!cfg || !cfg.hlInterval) return [];

    const now = Date.now();
    const cached = this.klineCache.get(timeframe);
    const cacheTtl = cfg.ms >= 60 * 60 * 1000 ? 60_000 : 20_000;
    if (cached && now - cached.fetchedAt < cacheTtl && cached.candles.length > 0) {
      return cached.candles;
    }

    const fetchCount = timeframe === '6h' ? 900 : 400;
    const rawIntervalMs = timeframe === '6h' ? 2 * 60 * 60 * 1000 : cfg.ms;
    const list = await postHlInfo<
      { t: number; o: string; h: string; l: string; c: string; v: string }[]
    >({
      type: 'candleSnapshot',
      req: {
        coin: HL_PERP_COIN,
        interval: cfg.hlInterval,
        startTime: now - fetchCount * rawIntervalMs,
        endTime: now,
      },
    });

    if (!Array.isArray(list) || list.length === 0) {
      return cached ? cached.candles : [];
    }

    let candles: RawKline[] = list.map((row) => ({
      t: Number(row.t),
      o: parseFloat(row.o),
      h: parseFloat(row.h),
      l: parseFloat(row.l),
      c: parseFloat(row.c),
      vol: parseFloat(row.v),
    }));

    // Synthesize 6h candles cleanly from Hyperliquid 2h candles
    if (timeframe === '6h') {
      const sixH = 6 * 60 * 60 * 1000;
      const grouped = new Map<number, RawKline>();
      for (const k of candles) {
        const bucket = Math.floor(k.t / sixH) * sixH;
        const cur = grouped.get(bucket);
        if (!cur) {
          grouped.set(bucket, { ...k, t: bucket });
        } else {
          if (k.h > cur.h) cur.h = k.h;
          if (k.l < cur.l) cur.l = k.l;
          cur.c = k.c;
          cur.vol = +(cur.vol + k.vol).toFixed(3);
        }
      }
      candles = Array.from(grouped.values()).sort((a, b) => a.t - b.t).slice(-400);
    } else {
      candles = candles.slice(-400);
    }

    if (candles.length > 0) {
      let hi24 = -Infinity;
      let lo24 = Infinity;
      const cutoff = now - 24 * 60 * 60 * 1000;
      for (const k of candles) {
        if (k.t >= cutoff) {
          if (k.h > hi24) hi24 = k.h;
          if (k.l < lo24) lo24 = k.l;
        }
      }
      if (hi24 > -Infinity) this.ticker.highPrice24h = hi24;
      if (lo24 < Infinity) this.ticker.lowPrice24h = lo24;
    }

    this.klineCache.set(timeframe, { fetchedAt: now, candles });
    return candles;
  }

  private emitTimeSlice() {
    if (this.perpInner.bids.length === 0 || this.perpInner.asks.length === 0) return;

    this.tickCounter++;
    const hasClients = this.hasClientsFn();
    const isHistoryBeat = hasClients ? this.tickCounter % 2 === 0 : this.tickCounter % 8 === 0;

    if (!isHistoryBeat && !hasClients) return;

    const now = Date.now();
    const bb = this.ticker.bestBid;
    const ba = this.ticker.bestAsk;
    const mid = +((bb + ba) / 2).toFixed(2);

    const o = this.windowOpen || mid;
    const h = this.windowHigh || mid;
    const l = this.windowLow || mid;
    const c = this.windowClose || mid;

    const tradeGroup = new Map<string, AggregatedTradeBubble>();
    const newRawTrades = this.pendingTrades;
    this.pendingTrades = [];
    const newLiqs = this.pendingLiquidations;
    this.pendingLiquidations = [];

    for (const tr of newRawTrades) {
      if (tr.market === 'SPOT') continue;
      const key = `${tr.s}:${Math.round(tr.p)}`;
      const existing = tradeGroup.get(key);
      if (existing) {
        existing.p = +((existing.p * existing.v + tr.p * tr.v) / (existing.v + tr.v)).toFixed(2);
        existing.v = +(existing.v + tr.v).toFixed(4);
        existing.count += 1;
        if (tr.v > existing.maxSingle) existing.maxSingle = tr.v;
      } else {
        tradeGroup.set(key, {
          t: tr.t,
          p: tr.p,
          v: +tr.v.toFixed(4),
          s: tr.s,
          count: 1,
          maxSingle: tr.v,
        });
      }
    }

    let compactBids: [number, number][] = [];
    let compactAsks: [number, number][] = [];

    if (isHistoryBeat) {
      const aggAll = this.getAggregatedBook('all', BASE_PRICE_STEP, false);
      this.recomputeAggregateBounds(aggAll, false);
      compactBids = compactLevelsForHistory(aggAll.bids, mid);
      compactAsks = compactLevelsForHistory(aggAll.asks, mid);
    }

    const slice: HeatmapSlice = {
      t: now,
      bb,
      ba,
      mid,
      o: +o.toFixed(2),
      h: +h.toFixed(2),
      l: +l.toFixed(2),
      c: +c.toFixed(2),
      bv: +this.windowBuyVol.toFixed(4),
      sv: +this.windowSellVol.toFixed(4),
      spotBv: +this.windowSpotBuyVol.toFixed(4),
      spotSv: +this.windowSpotSellVol.toFixed(4),
      bids: compactBids,
      asks: compactAsks,
      trades: Array.from(tradeGroup.values()),
      liquidations: newLiqs.length > 0 ? newLiqs : undefined,
    };

    this.windowBuyVol = 0;
    this.windowSellVol = 0;
    this.windowSpotBuyVol = 0;
    this.windowSpotSellVol = 0;
    this.windowOpen = c;
    this.windowHigh = c;
    this.windowLow = c;
    this.windowClose = c;

    if (isHistoryBeat) {
      this.baseSlices.push(slice);
      if (this.baseSlices.length > MAX_RING_SLICES) {
        this.baseSlices.splice(0, this.baseSlices.length - MAX_RING_SLICES);
      }
      this.ticker.storedBaseSlices = this.baseSlices.length;
    }

    if (this.onTickCallback && hasClients) {
      this.onTickCallback({
        baseSlice: slice,
        newTrades: newRawTrades,
        newLiquidations: newLiqs,
        ticker: this.ticker,
      });
    }
  }

  public async getAggregatedHistory(
    priceStep: PriceStep,
    bookScope: HyperliquidBookScope,
    timeframe: TimeframeId,
    maxColumns = 1200
  ): Promise<InitialHistoryResponse> {
    const cfg = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG['15m'];
    const isKlineTimeframe = Boolean(cfg.hlInterval);
    const agg = this.getAggregatedBook(bookScope, priceStep, true);

    if (isKlineTimeframe) {
      const klines = await this.getKlines(timeframe);
      const slices = buildKlineHeatmapSlices(
        klines,
        cfg.ms,
        priceStep,
        bookScope === 'all',
        this.baseSlices,
        this.ticker.lastPrice,
        this.ticker.spread,
        agg.bids,
        agg.asks
      );

      return {
        exchange: 'hyperliquid',
        priceStep,
        bookScope,
        timeframe,
        timeframeMs: cfg.ms,
        isKlineTimeframe: true,
        slices,
        currentBids: agg.bids,
        currentAsks: agg.asks,
        recentTrades: this.recentTrades.slice(0, 120),
        whaleTrades: this.whaleTrades.slice(0, 120),
        recentLiquidations: this.recentLiquidations.slice(0, 100),
        bidClusters: agg.bidClusters,
        askClusters: agg.askClusters,
        clusterSummary: agg.clusterSummary,
        ticker: this.ticker,
      };
    }

    const slices = groupTickSlices(
      this.baseSlices,
      cfg.ms,
      priceStep,
      bookScope === 'all',
      agg.bids,
      agg.asks,
      maxColumns
    );

    return {
      exchange: 'hyperliquid',
      priceStep,
      bookScope,
      timeframe,
      timeframeMs: cfg.ms,
      isKlineTimeframe: false,
      slices,
      currentBids: agg.bids,
      currentAsks: agg.asks,
      recentTrades: this.recentTrades.slice(0, 120),
      whaleTrades: this.whaleTrades.slice(0, 120),
      recentLiquidations: this.recentLiquidations.slice(0, 100),
      bidClusters: agg.bidClusters,
      askClusters: agg.askClusters,
      clusterSummary: agg.clusterSummary,
      ticker: this.ticker,
    };
  }
}
