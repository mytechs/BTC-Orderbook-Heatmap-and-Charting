import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type {
  AggregatedTradeBubble,
  CoinbaseBookScope,
  HeatmapSlice,
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
  MAX_RECENT_TRADES,
  MAX_RING_SLICES,
  MAX_WHALE_TRADES,
  type RawKline,
  TIMEFRAME_CONFIG,
  WHALE_TRADE_MIN_BTC,
  buildClusterMetrics,
  buildKlineHeatmapSlices,
  compactLevelsForHistory,
  groupTickSlices,
  loadCollectorCheckpoint,
  reBucketAggregatedResult,
  resampleKlines,
  saveCollectorCheckpoint,
  saveCollectorCheckpointAsync,
} from './collectorUtils.ts';

const CB_REST_BASE = 'https://api.exchange.coinbase.com';
const CB_WS_URL = 'wss://ws-feed.exchange.coinbase.com';

interface CbProductBook {
  id: 'BTC-USD' | 'BTC-USDT';
  venueKey: 'USD' | 'USDT';
  bids: Map<number, number>;
  asks: Map<number, number>;
  bestBid: number;
  bestAsk: number;
  lastPrice: number;
  open24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  connected: boolean;
}

interface KlineCacheEntry {
  fetchedAt: number;
  candles: RawKline[];
}

function makeProductBook(id: 'BTC-USD' | 'BTC-USDT', venueKey: 'USD' | 'USDT'): CbProductBook {
  return {
    id,
    venueKey,
    bids: new Map(),
    asks: new Map(),
    bestBid: 0,
    bestAsk: Infinity,
    lastPrice: 0,
    open24h: 0,
    high24h: 0,
    low24h: 0,
    volume24h: 0,
    connected: false,
  };
}

export class CoinbaseOrderbookCollector {
  private usdBook = makeProductBook('BTC-USD', 'USD');
  private usdtBook = makeProductBook('BTC-USDT', 'USDT');

  private baseSlices: HeatmapSlice[] = [];
  private recentTrades: TradeEvent[] = [];
  private whaleTrades: TradeEvent[] = [];
  private recentLiquidations: LiquidationEvent[] = [];
  private seenTradeIds = new Set<string>();
  private klineCache = new Map<TimeframeId, KlineCacheEntry>();
  private baseAggCache = new Map<
    CoinbaseBookScope,
    { updateCount: number; computedAt: number; result: AggregatedClusterResult }
  >();

  private pendingTrades: TradeEvent[] = [];
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
  private statsTimer: NodeJS.Timeout | null = null;
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
    exchange: 'coinbase',
    symbol: 'BTC-USD',
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
    this.checkpointPath = path.join(dataDir, 'coinbase-checkpoint.json');
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
    this.pollStats().catch(() => {});
    this.connectWs();

    this.statsTimer = setInterval(() => {
      this.pollStats().catch(() => {});
    }, 30_000);

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
    }, 79_000);
  }

  public stop() {
    for (const t of [
      this.pingTimer,
      this.reconnectTimer,
      this.statsTimer,
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

  private async pollStats() {
    const fetchStat = async (book: CbProductBook) => {
      try {
        const res = await fetch(`${CB_REST_BASE}/products/${book.id}/stats`);
        if (!res.ok) return;
        const d = (await res.json()) as {
          open?: string;
          high?: string;
          low?: string;
          last?: string;
          volume?: string;
        };
        const open = parseFloat(d.open || '0');
        const high = parseFloat(d.high || '0');
        const low = parseFloat(d.low || '0');
        const last = parseFloat(d.last || '0');
        const vol = parseFloat(d.volume || '0');
        if (open > 0) book.open24h = open;
        if (high > 0) book.high24h = high;
        if (low > 0) book.low24h = low;
        if (last > 0) book.lastPrice = last;
        if (vol > 0) book.volume24h = vol;
      } catch {
        // ignore transient error
      }
    };
    await Promise.all([fetchStat(this.usdBook), fetchStat(this.usdtBook)]);
    this.syncTickerFromProducts();
  }

  private syncTickerFromProducts() {
    const u = this.usdBook;
    const t = this.usdtBook;
    const primaryLast = u.lastPrice || t.lastPrice;
    if (primaryLast > 0) {
      this.ticker.lastPrice = +primaryLast.toFixed(2);
      this.ticker.spotPrice = +primaryLast.toFixed(2);
      this.ticker.indexPrice = +primaryLast.toFixed(2);
      this.ticker.markPrice = +primaryLast.toFixed(2);
    }
    if (u.lastPrice > 0 && u.open24h > 0) {
      this.ticker.price24hPcnt = +(((u.lastPrice - u.open24h) / u.open24h) * 100).toFixed(2);
    }
    this.ticker.highPrice24h = Math.max(u.high24h, t.high24h);
    const lows = [u.low24h, t.low24h].filter((v) => v > 0);
    this.ticker.lowPrice24h = lows.length > 0 ? Math.min(...lows) : 0;
    const totalVol = u.volume24h + t.volume24h;
    this.ticker.volume24h = +totalVol.toFixed(2);
    if (primaryLast > 0) {
      this.ticker.turnover24h = Math.round(totalVol * primaryLast);
    }
  }

  private getBookForProduct(productId?: string): CbProductBook | null {
    if (productId === 'BTC-USD') return this.usdBook;
    if (productId === 'BTC-USDT') return this.usdtBook;
    return null;
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

    const ws = new WebSocket(CB_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[Coinbase WS] Connected (BTC-USD + BTC-USDT)');
      this.usdBook.connected = true;
      this.usdtBook.connected = true;
      this.ticker.connected = true;

      ws.send(
        JSON.stringify({
          type: 'subscribe',
          product_ids: ['BTC-USD', 'BTC-USDT'],
          channels: ['level2_batch', 'matches', 'ticker'],
        })
      );

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 25_000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          product_id?: string;
          bids?: [string, string][];
          asks?: [string, string][];
          changes?: [string, string, string][];
          trade_id?: number;
          price?: string;
          size?: string;
          side?: string;
          time?: string;
          open_24h?: string;
          high_24h?: string;
          low_24h?: string;
          volume_24h?: string;
        };

        const book = this.getBookForProduct(msg.product_id);
        if (!book) return;

        if (msg.type === 'snapshot') {
          this.handleSnapshot(book, msg.bids || [], msg.asks || []);
        } else if (msg.type === 'l2update') {
          this.handleL2Update(book, msg.changes || []);
        } else if (msg.type === 'match' || msg.type === 'last_match') {
          this.handleMatch(book, msg);
        } else if (msg.type === 'ticker') {
          const px = parseFloat(msg.price || '0');
          const open = parseFloat(msg.open_24h || '0');
          const high = parseFloat(msg.high_24h || '0');
          const low = parseFloat(msg.low_24h || '0');
          const vol = parseFloat(msg.volume_24h || '0');
          if (px > 0) book.lastPrice = px;
          if (open > 0) book.open24h = open;
          if (high > 0) book.high24h = high;
          if (low > 0) book.low24h = low;
          if (vol > 0) book.volume24h = vol;
          this.syncTickerFromProducts();
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.usdBook.connected = false;
      this.usdtBook.connected = false;
      this.ticker.connected = false;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connectWs(), 2000);
    });

    ws.on('error', () => {
      this.ticker.connected = false;
    });
  }

  private handleSnapshot(
    book: CbProductBook,
    rawBids: [string, string][],
    rawAsks: [string, string][]
  ) {
    book.bids.clear();
    book.asks.clear();
    book.bestBid = 0;
    book.bestAsk = Infinity;

    const snapBestBid = rawBids.length > 0 ? parseFloat(rawBids[0][0]) : 0;
    const snapBestAsk = rawAsks.length > 0 ? parseFloat(rawAsks[0][0]) : 0;
    const refMid =
      snapBestBid > 0 && snapBestAsk > 0
        ? (snapBestBid + snapBestAsk) / 2
        : book.lastPrice || snapBestBid || snapBestAsk;
    const minKeep = refMid > 0 ? refMid * 0.82 : 0;
    const maxKeep = refMid > 0 ? refMid * 1.18 : Infinity;
    const innerLo = refMid > 0 ? refMid * 0.98 : 0;
    const innerHi = refMid > 0 ? refMid * 1.02 : Infinity;

    for (let i = 0; i < rawBids.length; i++) {
      const p = parseFloat(rawBids[i][0]);
      const s = parseFloat(rawBids[i][1]);
      if (p < minKeep || p > maxKeep || s <= 0) continue;
      if (p < innerLo && s < 0.005) continue; // drop far dust
      book.bids.set(p, s);
      if (p > book.bestBid) book.bestBid = p;
    }
    for (let i = 0; i < rawAsks.length; i++) {
      const p = parseFloat(rawAsks[i][0]);
      const s = parseFloat(rawAsks[i][1]);
      if (p < minKeep || p > maxKeep || s <= 0) continue;
      if (p > innerHi && s < 0.005) continue; // drop far dust
      book.asks.set(p, s);
      if (p < book.bestAsk) book.bestAsk = p;
    }
    book.connected = true;
    this.ticker.connected = true;
    this.ticker.updateCount++;
    if (book === this.usdBook) {
      this.syncFastPrimaryBounds(true);
    }
  }

  private handleL2Update(book: CbProductBook, changes: [string, string, string][]) {
    const refMid = this.getPrimaryMid() || book.lastPrice;
    const minKeep = refMid > 0 ? refMid * 0.82 : 0;
    const maxKeep = refMid > 0 ? refMid * 1.18 : Infinity;
    const innerLo = refMid > 0 ? refMid * 0.98 : 0;
    const innerHi = refMid > 0 ? refMid * 1.02 : Infinity;
    let rescanBid = false;
    let rescanAsk = false;

    for (let i = 0; i < changes.length; i++) {
      const [side, pStr, sStr] = changes[i];
      const p = parseFloat(pStr);
      const s = parseFloat(sStr);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (side === 'buy') {
        if (s <= 0 || p < minKeep || p > maxKeep || (p < innerLo && s < 0.005)) {
          if (book.bids.delete(p) && p === book.bestBid) rescanBid = true;
        } else {
          book.bids.set(p, s);
          if (p > book.bestBid) book.bestBid = p;
        }
      } else {
        if (s <= 0 || p < minKeep || p > maxKeep || (p > innerHi && s < 0.005)) {
          if (book.asks.delete(p) && p === book.bestAsk) rescanAsk = true;
        } else {
          book.asks.set(p, s);
          if (p < book.bestAsk) book.bestAsk = p;
        }
      }
    }

    if (rescanBid) {
      let bb = 0;
      for (const p of book.bids.keys()) if (p > bb) bb = p;
      book.bestBid = bb;
    }
    if (rescanAsk) {
      let ba = Infinity;
      for (const p of book.asks.keys()) if (p < ba) ba = p;
      book.bestAsk = ba;
    }

    this.ticker.updateCount++;
    if (book === this.usdBook) {
      this.syncFastPrimaryBounds(true);
    }
  }

  private handleMatch(
    book: CbProductBook,
    msg: {
      trade_id?: number;
      price?: string;
      size?: string;
      side?: string;
      time?: string;
    }
  ) {
    const p = parseFloat(msg.price || '0');
    const v = parseFloat(msg.size || '0');
    if (p <= 0 || v <= 0) return;

    const id = `cb-${book.id}-${msg.trade_id || `${Date.now()}-${p}`}`;
    if (this.seenTradeIds.has(id)) return;
    this.seenTradeIds.add(id);
    if (this.seenTradeIds.size > 3000) {
      const firstKey = this.seenTradeIds.values().next().value;
      if (firstKey) this.seenTradeIds.delete(firstKey);
    }

    // Coinbase Exchange WS `match.side` is the maker side: maker 'sell' => taker Buy
    const side: 'Buy' | 'Sell' = msg.side === 'sell' ? 'Buy' : 'Sell';
    const ts = msg.time ? Date.parse(msg.time) || Date.now() : Date.now();

    const trade: TradeEvent = {
      id,
      t: ts,
      p,
      v,
      s: side,
      exchange: 'CB',
      market: 'SPOT',
    };

    book.lastPrice = p;
    if (book === this.usdBook) {
      this.ticker.lastPrice = p;
      this.ticker.spotPrice = p;
      this.updateWindowPrice(p);
    }

    if (side === 'Buy') {
      this.windowBuyVol += v;
      this.windowSpotBuyVol += v;
    } else {
      this.windowSellVol += v;
      this.windowSpotSellVol += v;
    }

    this.recentTrades.unshift(trade);
    if (this.recentTrades.length > MAX_RECENT_TRADES) {
      this.recentTrades.length = MAX_RECENT_TRADES;
    }
    if (v >= WHALE_TRADE_MIN_BTC) {
      this.whaleTrades.unshift(trade);
      if (this.whaleTrades.length > MAX_WHALE_TRADES) {
        this.whaleTrades.length = MAX_WHALE_TRADES;
      }
    }
    this.pendingTrades.push(trade);
    this.onTradesCallback?.([trade]);
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

  private syncFastPrimaryBounds(notifyPulse = false) {
    const bestBid = this.usdBook.bestBid;
    const bestAsk = this.usdBook.bestAsk;

    if (bestBid > 0 && bestAsk < Infinity && bestAsk >= bestBid) {
      this.ticker.bestBid = bestBid;
      this.ticker.bestAsk = bestAsk;
      this.ticker.spread = +(bestAsk - bestBid).toFixed(2);
      const mid = (bestBid + bestAsk) / 2;
      if (this.ticker.lastPrice === 0) this.ticker.lastPrice = +mid.toFixed(2);
      this.ticker.spotPrice = +mid.toFixed(2);
      this.updateWindowPrice(mid);
      if (notifyPulse) this.onPricePulseCallback?.();
    }
  }

  private getPrimaryMid(): number {
    if (this.ticker.bestBid > 0 && this.ticker.bestAsk > 0) {
      return (this.ticker.bestBid + this.ticker.bestAsk) / 2;
    }
    return this.ticker.lastPrice || this.usdBook.lastPrice || this.usdtBook.lastPrice || 0;
  }

  private summarizeBook(book: CbProductBook, mid: number) {
    let bidBtc = 0;
    let askBtc = 0;
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const [p, s] of book.bids.entries()) {
      if (mid > 0 && p >= mid) continue;
      bidBtc += s;
      if (p < minPrice) minPrice = p;
    }
    for (const [p, s] of book.asks.entries()) {
      if (mid > 0 && p < mid) continue;
      askBtc += s;
      if (p > maxPrice) maxPrice = p;
    }
    return {
      bidBtc: +bidBtc.toFixed(2),
      askBtc: +askBtc.toFixed(2),
      bidLevels: book.bids.size,
      askLevels: book.asks.size,
      minPrice: minPrice < Infinity ? +minPrice.toFixed(2) : 0,
      maxPrice: maxPrice > -Infinity ? +maxPrice.toFixed(2) : 0,
    };
  }

  private recomputeAggregateBounds() {
    const mid = this.getPrimaryMid();
    const usdStat = this.summarizeBook(this.usdBook, mid);
    const usdtStat = this.summarizeBook(this.usdtBook, mid);

    const totalBidBtc = +(usdStat.bidBtc + usdtStat.bidBtc).toFixed(2);
    const totalAskBtc = +(usdStat.askBtc + usdtStat.askBtc).toFixed(2);
    const tot = totalBidBtc + totalAskBtc;

    this.ticker.totalBidBtc = totalBidBtc;
    this.ticker.totalAskBtc = totalAskBtc;
    this.ticker.imbalancePct =
      tot > 0 ? +(((totalBidBtc - totalAskBtc) / tot) * 100).toFixed(1) : 0;
    this.ticker.activeBidLevels = usdStat.bidLevels + usdtStat.bidLevels;
    this.ticker.activeAskLevels = usdStat.askLevels + usdtStat.askLevels;

    const mins = [usdStat.minPrice, usdtStat.minPrice].filter((v) => v > 0);
    const maxs = [usdStat.maxPrice, usdtStat.maxPrice].filter((v) => v > 0);
    this.ticker.minBookPrice = mins.length > 0 ? Math.min(...mins) : 0;
    this.ticker.maxBookPrice = maxs.length > 0 ? Math.max(...maxs) : 0;
    this.ticker.connected = this.usdBook.connected || this.usdtBook.connected;

    const cov: MarketCoverageItem[] = [
      {
        id: 'USD',
        label: 'CB USD',
        badgeClass: 'tag-cb',
        bidBtc: usdStat.bidBtc,
        askBtc: usdStat.askBtc,
        bidLevels: usdStat.bidLevels,
        askLevels: usdStat.askLevels,
        minPrice: usdStat.minPrice,
        maxPrice: usdStat.maxPrice,
        extraNote: 'Unified USD+USDC Spot',
        connected: this.usdBook.connected,
      },
      {
        id: 'USDT',
        label: 'CB USDT',
        badgeClass: 'tag-spot',
        bidBtc: usdtStat.bidBtc,
        askBtc: usdtStat.askBtc,
        bidLevels: usdtStat.bidLevels,
        askLevels: usdtStat.askLevels,
        minPrice: usdtStat.minPrice,
        maxPrice: usdtStat.maxPrice,
        connected: this.usdtBook.connected,
      },
    ];
    this.ticker.coverageItems = cov;
  }

  public getAggregatedBook(
    scope: CoinbaseBookScope,
    priceStep: PriceStep,
    includeClusters = true
  ): AggregatedClusterResult {
    const mid = this.getPrimaryMid();
    const venueOrder = ['USD', 'USDT'];

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
    scope: CoinbaseBookScope,
    priceStep: PriceStep,
    includeClusters: boolean
  ): AggregatedClusterResult {
    const inv = 1 / priceStep;
    const bucketFloor = (p: number) => +(Math.floor(p * inv + 1e-9) * priceStep).toFixed(2);
    const bidBreakdowns = new Map<number, VenueBreakdown>();
    const askBreakdowns = new Map<number, VenueBreakdown>();
    const mid = this.getPrimaryMid();

    const addBucket = (
      target: Map<number, VenueBreakdown>,
      price: number,
      venueKey: string,
      size: number
    ) => {
      if (size <= 0) return;
      const b = bucketFloor(price);
      let bd = target.get(b);
      if (!bd) {
        bd = {};
        target.set(b, bd);
      }
      bd[venueKey] = (bd[venueKey] || 0) + size;
    };

    const books: CbProductBook[] = [];
    if (scope === 'all' || scope === 'usd') books.push(this.usdBook);
    if (scope === 'all' || scope === 'usdt') books.push(this.usdtBook);

    let totalBidBtc = 0;
    let totalAskBtc = 0;
    let activeBidLevels = 0;
    let activeAskLevels = 0;
    let minBookPrice = Infinity;
    let maxBookPrice = -Infinity;

    for (const book of books) {
      for (const [p, s] of book.bids.entries()) {
        if (mid > 0 && p >= mid) continue;
        addBucket(bidBreakdowns, p, book.venueKey, s);
        totalBidBtc += s;
        activeBidLevels++;
        if (p < minBookPrice) minBookPrice = p;
      }
      for (const [p, s] of book.asks.entries()) {
        if (mid > 0 && p < mid) continue;
        addBucket(askBreakdowns, p, book.venueKey, s);
        totalAskBtc += s;
        activeAskLevels++;
        if (p > maxBookPrice) maxBookPrice = p;
      }
    }

    const bids: [number, number][] = [];
    for (const [b, bd] of bidBreakdowns.entries()) {
      let tot = 0;
      for (const v of Object.values(bd)) tot += v;
      if (tot >= 0.01) bids.push([b, +tot.toFixed(3)]);
    }
    bids.sort((a, b) => b[0] - a[0]);

    const asks: [number, number][] = [];
    for (const [b, bd] of askBreakdowns.entries()) {
      let tot = 0;
      for (const v of Object.values(bd)) tot += v;
      if (tot >= 0.01) asks.push([b, +tot.toFixed(3)]);
    }
    asks.sort((a, b) => a[0] - b[0]);

    const clusters = includeClusters
      ? buildClusterMetrics(bids, asks, bidBreakdowns, askBreakdowns, mid, ['USD', 'USDT'])
      : { bidClusters: [], askClusters: [], clusterSummary: [] };

    return {
      bids,
      asks,
      bidBreakdowns,
      askBreakdowns,
      ...clusters,
      totalBidBtc: +totalBidBtc.toFixed(2),
      totalAskBtc: +totalAskBtc.toFixed(2),
      activeBidLevels,
      activeAskLevels,
      minBookPrice: minBookPrice < Infinity ? +minBookPrice.toFixed(2) : 0,
      maxBookPrice: maxBookPrice > -Infinity ? +maxBookPrice.toFixed(2) : 0,
    };
  }

  private emitTimeSlice() {
    this.tickCounter++;
    const hasClients = this.hasClientsFn();
    const isHistoryBeat = hasClients ? this.tickCounter % 2 === 0 : this.tickCounter % 8 === 0;

    if (!isHistoryBeat && !hasClients) return;

    const mid = this.getPrimaryMid();
    if (mid <= 0) return;

    this.updateWindowPrice(mid);

    const now = Date.now();
    const o = this.windowOpen || mid;
    const h = this.windowHigh || mid;
    const l = this.windowLow || mid;
    const c = this.windowClose || mid;

    const tradeGroup = new Map<string, AggregatedTradeBubble>();
    const newRawTrades = this.pendingTrades;
    this.pendingTrades = [];

    for (const tr of newRawTrades) {
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
      this.recomputeAggregateBounds();
      const aggAll = this.getAggregatedBook('all', BASE_PRICE_STEP, false);
      compactBids = compactLevelsForHistory(aggAll.bids, mid);
      compactAsks = compactLevelsForHistory(aggAll.asks, mid);
    }

    const slice: HeatmapSlice = {
      t: now,
      bb: this.ticker.bestBid || +(mid - 0.5).toFixed(2),
      ba: this.ticker.bestAsk || +(mid + 0.5).toFixed(2),
      mid: +mid.toFixed(2),
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
        newLiquidations: [],
        ticker: this.ticker,
      });
    }
  }

  public async getKlines(timeframe: TimeframeId): Promise<RawKline[]> {
    const cfg = TIMEFRAME_CONFIG[timeframe];
    if (!cfg || !cfg.coinbaseGranularity) return [];

    const cached = this.klineCache.get(timeframe);
    const cacheTtl = cfg.ms >= 60 * 60 * 1000 ? 60_000 : 15_000;
    if (cached && Date.now() - cached.fetchedAt < cacheTtl && cached.candles.length > 0) {
      return cached.candles;
    }

    const gran = cfg.coinbaseGranularity;
    const granMs = gran * 1000;
    const needsResample = cfg.ms > granMs;

    const fetchRange = async (startMs?: number, endMs?: number): Promise<RawKline[]> => {
      const params = new URLSearchParams({ granularity: String(gran) });
      if (startMs && endMs) {
        params.set('start', new Date(startMs).toISOString());
        params.set('end', new Date(endMs).toISOString());
      }
      const res = await fetch(`${CB_REST_BASE}/products/BTC-USD/candles?${params.toString()}`);
      if (!res.ok) return [];
      const rows = (await res.json()) as number[][];
      if (!Array.isArray(rows)) return [];
      const out: RawKline[] = [];
      for (const r of rows) {
        if (!Array.isArray(r) || r.length < 6) continue;
        // Coinbase format: [timeSec, low, high, open, close, volume]
        out.push({
          t: Number(r[0]) * 1000,
          l: Number(r[1]),
          h: Number(r[2]),
          o: Number(r[3]),
          c: Number(r[4]),
          vol: Number(r[5]),
        });
      }
      return out;
    };

    try {
      const now = Date.now();
      const page1 = await fetchRange();
      let combined = page1;

      if (needsResample && page1.length > 0) {
        const oldestTs = Math.min(...page1.map((c) => c.t));
        const page2End = oldestTs - granMs;
        const page2Start = page2End - 299 * granMs;
        const page2 = await fetchRange(page2Start, page2End).catch(() => []);
        const byTs = new Map<number, RawKline>();
        for (const k of [...page2, ...page1]) byTs.set(k.t, k);
        combined = Array.from(byTs.values());
      }

      combined.sort((a, b) => a.t - b.t);
      const candles = needsResample ? resampleKlines(combined, cfg.ms) : combined;
      const trimmed = candles.slice(-400);

      if (trimmed.length > 0) {
        this.klineCache.set(timeframe, { fetchedAt: now, candles: trimmed });
      }
      return trimmed;
    } catch {
      return cached?.candles || [];
    }
  }

  public getRecentTrades(limit = 120): TradeEvent[] {
    return this.recentTrades.slice(0, limit);
  }

  public getWhaleTrades(limit = 120): TradeEvent[] {
    return this.whaleTrades.slice(0, limit);
  }

  public getRecentLiquidations(_limit = 100): LiquidationEvent[] {
    return [];
  }

  public getVolumeBreakdown(): {
    spotBtc: number;
    spotUsd: number;
    derivBtc: number;
    derivUsd: number;
  } {
    const px = this.usdBook.lastPrice || this.usdtBook.lastPrice || this.ticker.lastPrice || 0;
    const spotBtc = this.usdBook.volume24h + this.usdtBook.volume24h;
    const spotUsd =
      this.usdBook.volume24h * (this.usdBook.lastPrice || px) +
      this.usdtBook.volume24h * (this.usdtBook.lastPrice || px);
    return {
      spotBtc: +spotBtc.toFixed(2),
      spotUsd: Math.round(spotUsd),
      derivBtc: 0,
      derivUsd: 0,
    };
  }

  public async getAggregatedHistory(
    priceStep: PriceStep,
    bookScope: CoinbaseBookScope,
    timeframe: TimeframeId,
    maxColumns = 1200
  ): Promise<InitialHistoryResponse> {
    const cfg = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG['15m'];
    const isKlineTimeframe = Boolean(cfg.coinbaseGranularity);
    this.recomputeAggregateBounds();
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
        exchange: 'coinbase',
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
        recentLiquidations: [],
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
      exchange: 'coinbase',
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
      recentLiquidations: [],
      bidClusters: agg.bidClusters,
      askClusters: agg.askClusters,
      clusterSummary: agg.clusterSummary,
      ticker: this.ticker,
    };
  }
}
