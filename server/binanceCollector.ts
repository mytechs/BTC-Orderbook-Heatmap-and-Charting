import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type {
  AggregatedTradeBubble,
  BinanceBookScope,
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
  MAX_LIQUIDATIONS,
  MAX_RING_SLICES,
  MAX_WHALE_TRADES,
  OUTER_LEVEL_TTL_MS,
  type RawKline,
  TIMEFRAME_CONFIG,
  WHALE_TRADE_MIN_BTC,
  appendLiquidationBuffer,
  appendTradeBuffers,
  buildClusterMetrics,
  buildKlineHeatmapSlices,
  capOuterMap,
  compactLevelsForHistory,
  groupTickSlices,
  loadCollectorCheckpoint,
  reBucketAggregatedResult,
  saveCollectorCheckpoint,
  saveCollectorCheckpointAsync,
} from './collectorUtils.ts';

type BinanceCategory = 'usdm' | 'coinm' | 'spot';

interface BinanceSymbolSpec {
  id: string; // e.g. 'btcusdt'
  symbol: string; // e.g. 'BTCUSDT'
  category: BinanceCategory;
  venueKey: 'USDM' | 'COINM' | 'SPOT';
  restDepthUrl: string;
  contractSizeUsd?: number; // For COIN-M (100 USD/contract)
  isPrimary?: boolean;
}

const BINANCE_SYMBOLS: BinanceSymbolSpec[] = [
  // USD-M Futures Perpetuals
  {
    id: 'btcusdt',
    symbol: 'BTCUSDT',
    category: 'usdm',
    venueKey: 'USDM',
    restDepthUrl: 'https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000',
    isPrimary: true,
  },
  {
    id: 'btcusdc',
    symbol: 'BTCUSDC',
    category: 'usdm',
    venueKey: 'USDM',
    restDepthUrl: 'https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDC&limit=1000',
  },
  {
    id: 'btcusd1',
    symbol: 'BTCUSD1',
    category: 'usdm',
    venueKey: 'USDM',
    restDepthUrl: 'https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSD1&limit=1000',
  },
  {
    id: 'btcu',
    symbol: 'BTCU',
    category: 'usdm',
    venueKey: 'USDM',
    restDepthUrl: 'https://fapi.binance.com/fapi/v1/depth?symbol=BTCU&limit=1000',
  },
  // COIN-M Perpetual
  {
    id: 'btcusd_perp',
    symbol: 'BTCUSD_PERP',
    category: 'coinm',
    venueKey: 'COINM',
    restDepthUrl: 'https://dapi.binance.com/dapi/v1/depth?symbol=BTCUSD_PERP&limit=1000',
    contractSizeUsd: 100,
  },
  // Spot USD/Stablecoin BTC Pairs (1000 levels/side each)
  {
    id: 'btcusdt',
    symbol: 'BTCUSDT',
    category: 'spot',
    venueKey: 'SPOT',
    restDepthUrl: 'https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=1000',
  },
  {
    id: 'btcusdc',
    symbol: 'BTCUSDC',
    category: 'spot',
    venueKey: 'SPOT',
    restDepthUrl: 'https://api.binance.com/api/v3/depth?symbol=BTCUSDC&limit=1000',
  },
  {
    id: 'btcfdusd',
    symbol: 'BTCFDUSD',
    category: 'spot',
    venueKey: 'SPOT',
    restDepthUrl: 'https://api.binance.com/api/v3/depth?symbol=BTCFDUSD&limit=1000',
  },
  {
    id: 'btcusd1',
    symbol: 'BTCUSD1',
    category: 'spot',
    venueKey: 'SPOT',
    restDepthUrl: 'https://api.binance.com/api/v3/depth?symbol=BTCUSD1&limit=1000',
  },
  {
    id: 'btcu',
    symbol: 'BTCU',
    category: 'spot',
    venueKey: 'SPOT',
    restDepthUrl: 'https://api.binance.com/api/v3/depth?symbol=BTCU&limit=1000',
  },
  {
    id: 'btcusd',
    symbol: 'BTCUSD',
    category: 'spot',
    venueKey: 'SPOT',
    restDepthUrl: 'https://api.binance.com/api/v3/depth?symbol=BTCUSD&limit=1000',
  },
  {
    id: 'btcusds',
    symbol: 'BTCUSDS',
    category: 'spot',
    venueKey: 'SPOT',
    restDepthUrl: 'https://api.binance.com/api/v3/depth?symbol=BTCUSDS&limit=1000',
  },
];

interface DepthEventBufferItem {
  U: number;
  u: number;
  b: [string, string][];
  a: [string, string][];
}

interface OuterLevelEntry {
  size: number;
  updatedAt: number;
}

interface BinanceBookState {
  spec: BinanceSymbolSpec;
  bids: Map<number, number>;
  asks: Map<number, number>;
  outerBids: Map<number, OuterLevelEntry>;
  outerAsks: Map<number, OuterLevelEntry>;
  lastUpdateId: number;
  syncing: boolean;
  bufferedUpdates: DepthEventBufferItem[];
  bestBidCents: number;
  bestAskCents: number;
  minBidCents: number;
  maxAskCents: number;
  lastBoundsPruneAt: number;
  lastWsAt: number;
  connected: boolean;
}

function createBinanceBookState(spec: BinanceSymbolSpec): BinanceBookState {
  return {
    spec,
    bids: new Map(),
    asks: new Map(),
    outerBids: new Map(),
    outerAsks: new Map(),
    lastUpdateId: 0,
    syncing: false,
    bufferedUpdates: [],
    bestBidCents: 0,
    bestAskCents: 0,
    minBidCents: 0,
    maxAskCents: 0,
    lastBoundsPruneAt: 0,
    lastWsAt: 0,
    connected: false,
  };
}

interface KlineCacheEntry {
  fetchedAt: number;
  candles: RawKline[];
}

export class BinanceOrderbookCollector {
  private books = new Map<string, BinanceBookState>();
  private primaryKey = 'usdm:btcusdt';

  private baseSlices: HeatmapSlice[] = [];
  private recentTrades: TradeEvent[] = [];
  private whaleTrades: TradeEvent[] = [];
  private recentLiquidations: LiquidationEvent[] = [];
  private seenTradeIds = new Set<string>();
  private klineCache = new Map<TimeframeId, KlineCacheEntry>();
  private baseAggCache = new Map<
    BinanceBookScope,
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

  private wsUsdm: WebSocket | null = null;
  private wsUsdmMarket: WebSocket | null = null;
  private wsCoinm: WebSocket | null = null;
  private wsSpot: WebSocket | null = null;

  private pingUsdm: NodeJS.Timeout | null = null;
  private pingUsdmMarket: NodeJS.Timeout | null = null;
  private pingCoinm: NodeJS.Timeout | null = null;
  private pingSpot: NodeJS.Timeout | null = null;
  private reconnectUsdm: NodeJS.Timeout | null = null;
  private reconnectUsdmMarket: NodeJS.Timeout | null = null;
  private reconnectCoinm: NodeJS.Timeout | null = null;
  private reconnectSpot: NodeJS.Timeout | null = null;
  private sliceTimer: NodeJS.Timeout | null = null;
  private metaTimer: NodeJS.Timeout | null = null;
  private restFallbackTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private lastWsTradeAt = 0;
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
  private onLiquidationsCallback: ((liqs: LiquidationEvent[]) => void) | null = null;
  private onPricePulseCallback: (() => void) | null = null;

  public ticker: TickerStats = {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    lastPrice: 0,
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
    this.checkpointPath = path.join(dataDir, 'binance-checkpoint.json');
    for (const spec of BINANCE_SYMBOLS) {
      this.books.set(`${spec.category}:${spec.id}`, createBinanceBookState(spec));
    }
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

  public onLiquidations(cb: (liqs: LiquidationEvent[]) => void) {
    this.onLiquidationsCallback = cb;
  }

  public onPricePulse(cb: () => void) {
    this.onPricePulseCallback = cb;
  }

  public setHasClientsFn(fn: () => boolean) {
    this.hasClientsFn = fn;
  }

  public start() {
    this.bootstrapInitialData().catch(() => {});
    this.connectUsdmWs();
    this.connectUsdmMarketWs();
    this.connectCoinmWs();
    this.connectSpotWs();

    this.sliceTimer = setInterval(() => {
      this.emitTimeSlice();
    }, LIVE_TICK_MS);

    this.metaTimer = setInterval(() => {
      this.pollFuturesMeta().catch(() => {});
    }, 10_000);

    this.restFallbackTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastWsTradeAt > 5000) {
        this.bootstrapRecentTrades(false).catch(() => {});
      }
    }, 3000);

    this.checkpointTimer = setInterval(() => {
      saveCollectorCheckpointAsync(
        this.checkpointPath,
        this.baseSlices,
        this.recentTrades,
        this.ticker,
        this.whaleTrades,
        this.recentLiquidations
      ).catch(() => {});
    }, 67_000);
  }

  public stop() {
    for (const t of [
      this.sliceTimer,
      this.metaTimer,
      this.restFallbackTimer,
      this.checkpointTimer,
      this.pingUsdm,
      this.pingUsdmMarket,
      this.pingCoinm,
      this.pingSpot,
      this.reconnectUsdm,
      this.reconnectUsdmMarket,
      this.reconnectCoinm,
      this.reconnectSpot,
    ]) {
      if (t) {
        clearInterval(t);
        clearTimeout(t);
      }
    }
    for (const ws of [this.wsUsdm, this.wsUsdmMarket, this.wsCoinm, this.wsSpot]) {
      if (ws) {
        ws.removeAllListeners();
        try {
          ws.close();
        } catch {
          // ignore
        }
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
    await Promise.all([this.pollFuturesMeta(), this.bootstrapRecentTrades()]);

    // Sync all 12 Binance books smoothly
    await Promise.all(
      Array.from(this.books.values()).map((book) => this.syncBookFromRest(book))
    );
    this.recomputeAggregateBounds();
  }

  private async pollFuturesMeta() {
    try {
      const [tkRes, premRes, oiRes] = await Promise.all([
        fetch('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT'),
        fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
        fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT'),
      ]);

      if (tkRes.ok) {
        const tk = (await tkRes.json()) as Record<string, string>;
        if (tk.lastPrice) this.ticker.lastPrice = parseFloat(tk.lastPrice);
        if (tk.priceChangePercent)
          this.ticker.price24hPcnt = parseFloat(tk.priceChangePercent);
        if (tk.highPrice) this.ticker.highPrice24h = parseFloat(tk.highPrice);
        if (tk.lowPrice) this.ticker.lowPrice24h = parseFloat(tk.lowPrice);
        if (tk.volume) this.ticker.volume24h = parseFloat(tk.volume);
        if (tk.quoteVolume) this.ticker.turnover24h = parseFloat(tk.quoteVolume);
      }

      if (premRes.ok) {
        const prem = (await premRes.json()) as Record<string, string>;
        if (prem.markPrice) this.ticker.markPrice = parseFloat(prem.markPrice);
        if (prem.indexPrice) this.ticker.indexPrice = parseFloat(prem.indexPrice);
        if (prem.lastFundingRate)
          this.ticker.fundingRate = parseFloat(prem.lastFundingRate) * 100;
      }

      if (oiRes.ok) {
        const oi = (await oiRes.json()) as { openInterest?: string };
        const oiBtc = parseFloat(oi.openInterest || '0');
        const refPrice = this.ticker.markPrice || this.ticker.lastPrice || 0;
        if (oiBtc > 0 && refPrice > 0) {
          this.ticker.openInterestValue = Math.round(oiBtc * refPrice);
        }
      }
    } catch {
      // Ignore transient REST error
    }
  }

  private async bootstrapRecentTrades(isBootstrap = true) {
    try {
      const res = await fetch(
        'https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&limit=80'
      );
      if (!res.ok) return;
      const list = (await res.json()) as {
        a: number;
        p: string;
        q: string;
        T: number;
        m: boolean;
      }[];
      if (!Array.isArray(list)) return;
      const accepted: TradeEvent[] = [];
      for (const tr of list) {
        const added = this.recordTrade(
          `bn-${tr.a}`,
          tr.T,
          parseFloat(tr.p),
          parseFloat(tr.q),
          tr.m ? 'Sell' : 'Buy',
          isBootstrap
        );
        if (added && !isBootstrap) accepted.push(added);
      }
      if (!isBootstrap && accepted.length > 0 && this.onTradesCallback) {
        this.onTradesCallback(accepted);
      }
    } catch {
      // Ignore
    }
  }

  private async syncBookFromRest(book: BinanceBookState) {
    if (book.syncing) return;
    book.syncing = true;
    try {
      const res = await fetch(book.spec.restDepthUrl);
      if (!res.ok) return;
      const json = (await res.json()) as {
        lastUpdateId: number;
        bids?: [string, string][];
        asks?: [string, string][];
      };
      if (!json.bids || !json.asks) return;

      book.bids.clear();
      book.asks.clear();
      book.bestBidCents = 0;
      book.bestAskCents = 0;
      book.minBidCents = 0;
      book.maxAskCents = 0;

      const bestBidPx = json.bids.length > 0 ? parseFloat(json.bids[0][0]) : 0;
      const bestAskPx = json.asks.length > 0 ? parseFloat(json.asks[0][0]) : 0;
      const refMid =
        bestBidPx > 0 && bestAskPx > 0
          ? (bestBidPx + bestAskPx) / 2
          : this.ticker.lastPrice || bestBidPx || bestAskPx;
      const minKeep = refMid > 0 ? refMid * 0.82 : 0;
      const maxKeep = refMid > 0 ? refMid * 1.18 : Infinity;
      const innerLo = refMid > 0 ? refMid * 0.98 : 0;
      const innerHi = refMid > 0 ? refMid * 1.02 : Infinity;

      for (const [pStr, qStr] of json.bids) {
        const price = parseFloat(pStr);
        const rawQty = parseFloat(qStr);
        if (!Number.isFinite(price) || price <= 0 || rawQty <= 0) continue;
        if (price < minKeep || price > maxKeep) continue;
        const sizeBtc = book.spec.contractSizeUsd
          ? (rawQty * book.spec.contractSizeUsd) / price
          : rawQty;
        if (price < innerLo && sizeBtc < 0.005) continue;
        const priceCents = Math.round(price * 100);
        book.bids.set(priceCents, sizeBtc);
        book.outerBids.delete(priceCents);
      }

      for (const [pStr, qStr] of json.asks) {
        const price = parseFloat(pStr);
        const rawQty = parseFloat(qStr);
        if (!Number.isFinite(price) || price <= 0 || rawQty <= 0) continue;
        if (price < minKeep || price > maxKeep) continue;
        const sizeBtc = book.spec.contractSizeUsd
          ? (rawQty * book.spec.contractSizeUsd) / price
          : rawQty;
        if (price > innerHi && sizeBtc < 0.005) continue;
        const priceCents = Math.round(price * 100);
        book.asks.set(priceCents, sizeBtc);
        book.outerAsks.delete(priceCents);
      }

      book.lastUpdateId = json.lastUpdateId || 0;

      // Apply any buffered WS deltas newer than lastUpdateId
      for (const ev of book.bufferedUpdates) {
        if (ev.u > book.lastUpdateId) {
          this.applyDepthDelta(book, ev);
        }
      }
      book.bufferedUpdates = [];
      this.updateSingleBookBounds(book);
      this.ticker.updateCount++;
    } catch {
      // Ignore transient REST error
    } finally {
      book.syncing = false;
    }
  }

  private connectUsdmWs() {
    if (this.wsUsdm) {
      this.wsUsdm.removeAllListeners();
      try {
        this.wsUsdm.close();
      } catch {
        // ignore
      }
    }

    // Binance USD-M partitioned depth streams live under /public/stream
    const streams = [
      'btcusdt@depth@100ms',
      'btcusdc@depth@100ms',
      'btcusd1@depth@100ms',
      'btcu@depth@100ms',
    ].join('/');

    const url = `wss://fstream.binance.com/public/stream?streams=${streams}`;
    const ws = new WebSocket(url);
    this.wsUsdm = ws;

    ws.on('open', () => {
      console.log('[Binance USD-M Depth WS] Connected');
      for (const book of this.books.values()) {
        if (book.spec.category === 'usdm') {
          book.connected = true;
          this.syncBookFromRest(book).catch(() => {});
        }
      }
      this.ticker.connected = true;
      if (this.pingUsdm) clearInterval(this.pingUsdm);
      this.pingUsdm = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 25_000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          stream?: string;
          data?: Record<string, unknown>;
        };
        if (!msg.stream || !msg.data) return;

        const [sym, streamType] = msg.stream.split('@');
        if (streamType === 'depth') {
          const book = this.books.get(`usdm:${sym}`);
          if (book) this.handleWsDepthEvent(book, msg.data as unknown as DepthEventBufferItem);
        }
      } catch {
        // Ignore malformed
      }
    });

    ws.on('close', () => {
      if (this.pingUsdm) clearInterval(this.pingUsdm);
      for (const book of this.books.values()) {
        if (book.spec.category === 'usdm') book.connected = false;
      }
      if (this.reconnectUsdm) clearTimeout(this.reconnectUsdm);
      this.reconnectUsdm = setTimeout(() => this.connectUsdmWs(), 2000);
    });

    ws.on('error', () => {});
  }

  private connectUsdmMarketWs() {
    if (this.wsUsdmMarket) {
      this.wsUsdmMarket.removeAllListeners();
      try {
        this.wsUsdmMarket.close();
      } catch {
        // ignore
      }
    }

    // Binance USD-M aggTrade, ticker, markPrice & forceOrder live under /market/stream
    const streams = [
      'btcusdt@aggTrade',
      'btcusdt@ticker',
      'btcusdt@markPrice@1s',
      'btcusdt@forceOrder',
    ].join('/');

    const url = `wss://fstream.binance.com/market/stream?streams=${streams}`;
    const ws = new WebSocket(url);
    this.wsUsdmMarket = ws;

    ws.on('open', () => {
      console.log('[Binance USD-M Market WS] Connected (aggTrade + ticker + markPrice + forceOrder)');
      this.ticker.connected = true;
      if (this.pingUsdmMarket) clearInterval(this.pingUsdmMarket);
      this.pingUsdmMarket = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 25_000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          stream?: string;
          data?: Record<string, unknown>;
        };
        if (!msg.stream || !msg.data) return;

        const [, streamType] = msg.stream.split('@');
        if (streamType === 'aggTrade') {
          this.lastWsTradeAt = Date.now();
          const d = msg.data as { a: number; p: string; q: string; T: number; m: boolean };
          const added = this.recordTrade(
            `bn-${d.a}`,
            d.T || Date.now(),
            parseFloat(d.p),
            parseFloat(d.q),
            d.m ? 'Sell' : 'Buy',
            false
          );
          if (added && this.onTradesCallback) {
            this.onTradesCallback([added]);
          }
        } else if (streamType === 'forceOrder') {
          this.handleForceOrder(msg.data as { o?: Record<string, string | number> });
        } else if (streamType === 'ticker') {
          const d = msg.data as Record<string, string>;
          if (d.c) this.ticker.lastPrice = parseFloat(d.c);
          if (d.P) this.ticker.price24hPcnt = parseFloat(d.P);
          if (d.h) this.ticker.highPrice24h = parseFloat(d.h);
          if (d.l) this.ticker.lowPrice24h = parseFloat(d.l);
          if (d.v) this.ticker.volume24h = parseFloat(d.v);
          if (d.q) this.ticker.turnover24h = parseFloat(d.q);
        } else if (streamType === 'markPrice') {
          const d = msg.data as Record<string, string>;
          if (d.p) this.ticker.markPrice = parseFloat(d.p);
          if (d.i) this.ticker.indexPrice = parseFloat(d.i);
          if (d.r) this.ticker.fundingRate = parseFloat(d.r) * 100;
        }
      } catch {
        // Ignore malformed
      }
    });

    ws.on('close', () => {
      if (this.pingUsdmMarket) clearInterval(this.pingUsdmMarket);
      if (this.reconnectUsdmMarket) clearTimeout(this.reconnectUsdmMarket);
      this.reconnectUsdmMarket = setTimeout(() => this.connectUsdmMarketWs(), 2000);
    });

    ws.on('error', () => {});
  }

  private connectCoinmWs() {
    if (this.wsCoinm) {
      this.wsCoinm.removeAllListeners();
      try {
        this.wsCoinm.close();
      } catch {
        // ignore
      }
    }

    const url = 'wss://dstream.binance.com/stream?streams=btcusd_perp@depth@100ms';
    const ws = new WebSocket(url);
    this.wsCoinm = ws;

    ws.on('open', () => {
      console.log('[Binance COIN-M WS] Connected');
      const book = this.books.get('coinm:btcusd_perp');
      if (book) {
        book.connected = true;
        this.syncBookFromRest(book).catch(() => {});
      }
      if (this.pingCoinm) clearInterval(this.pingCoinm);
      this.pingCoinm = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 150_000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          stream?: string;
          data?: DepthEventBufferItem;
        };
        if (!msg.stream || !msg.data) return;
        const sym = msg.stream.split('@')[0];
        const book = this.books.get(`coinm:${sym}`);
        if (book) this.handleWsDepthEvent(book, msg.data);
      } catch {
        // Ignore
      }
    });

    ws.on('close', () => {
      if (this.pingCoinm) clearInterval(this.pingCoinm);
      const book = this.books.get('coinm:btcusd_perp');
      if (book) book.connected = false;
      if (this.reconnectCoinm) clearTimeout(this.reconnectCoinm);
      this.reconnectCoinm = setTimeout(() => this.connectCoinmWs(), 2500);
    });

    ws.on('error', () => {});
  }

  private connectSpotWs() {
    if (this.wsSpot) {
      this.wsSpot.removeAllListeners();
      try {
        this.wsSpot.close();
      } catch {
        // ignore
      }
    }

    const spotStreams = [
      ...BINANCE_SYMBOLS.filter((s) => s.category === 'spot').map((s) => `${s.id}@depth@100ms`),
      'btcusdt@aggTrade',
    ].join('/');

    const url = `wss://stream.binance.com:9443/stream?streams=${spotStreams}`;
    const ws = new WebSocket(url);
    this.wsSpot = ws;

    ws.on('open', () => {
      console.log('[Binance Spot WS] Connected (7 BTC pairs + spot trades)');
      for (const book of this.books.values()) {
        if (book.spec.category === 'spot') {
          book.connected = true;
        }
      }
      if (this.pingSpot) clearInterval(this.pingSpot);
      this.pingSpot = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 25_000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          stream?: string;
          data?: Record<string, unknown>;
        };
        if (!msg.stream || !msg.data) return;
        const [sym, streamType] = msg.stream.split('@');
        if (streamType === 'aggTrade') {
          const d = msg.data as { a: number; p: string; q: string; T: number; m: boolean };
          this.handleSpotAggTrade(d);
          return;
        }
        const book = this.books.get(`spot:${sym}`);
        if (book) this.handleWsDepthEvent(book, msg.data as unknown as DepthEventBufferItem);
      } catch {
        // Ignore
      }
    });

    ws.on('close', () => {
      if (this.pingSpot) clearInterval(this.pingSpot);
      for (const book of this.books.values()) {
        if (book.spec.category === 'spot') book.connected = false;
      }
      if (this.reconnectSpot) clearTimeout(this.reconnectSpot);
      this.reconnectSpot = setTimeout(() => this.connectSpotWs(), 2500);
    });

    ws.on('error', () => {});
  }

  private handleWsDepthEvent(book: BinanceBookState, ev: DepthEventBufferItem) {
    book.lastWsAt = Date.now();
    book.connected = true;

    if (book.lastUpdateId === 0 || book.syncing) {
      book.bufferedUpdates.push(ev);
      if (book.bufferedUpdates.length > 250) {
        book.bufferedUpdates.splice(0, book.bufferedUpdates.length - 250);
      }
      return;
    }

    if (ev.u <= book.lastUpdateId) return;

    this.applyDepthDelta(book, ev);
    this.ticker.updateCount++;
    if (book.spec.isPrimary) {
      this.recomputeFastPrimaryBounds();
    }
  }

  private applyDepthDelta(book: BinanceBookState, ev: DepthEventBufferItem) {
    const now = Date.now();
    const minActiveBidCents = book.minBidCents;
    const maxActiveAskCents = book.maxAskCents;
    let forceFullScan = book.bestBidCents <= 0 || book.bestAskCents <= 0;

    for (let i = 0; i < (ev.b?.length || 0); i++) {
      const price = parseFloat(ev.b[i][0]);
      const rawQty = parseFloat(ev.b[i][1]);
      if (!Number.isFinite(price) || price <= 0) continue;
      const priceCents = Math.round(price * 100);
      if (rawQty === 0) {
        const prevSize = book.bids.get(priceCents);
        book.bids.delete(priceCents);
        if (priceCents >= book.bestBidCents || priceCents <= book.minBidCents) {
          forceFullScan = true;
        }
        if (
          prevSize &&
          prevSize >= 0.2 &&
          book.bids.size >= 900 &&
          minActiveBidCents > 0 &&
          priceCents <= minActiveBidCents + 500
        ) {
          book.outerBids.set(priceCents, { size: prevSize, updatedAt: now });
        } else {
          book.outerBids.delete(priceCents);
        }
      } else if (rawQty > 0) {
        const sizeBtc = book.spec.contractSizeUsd
          ? (rawQty * book.spec.contractSizeUsd) / price
          : rawQty;
        book.bids.set(priceCents, sizeBtc);
        book.outerBids.delete(priceCents);
        if (priceCents > book.bestBidCents) book.bestBidCents = priceCents;
        if (book.minBidCents === 0 || priceCents < book.minBidCents) book.minBidCents = priceCents;
      }
    }

    for (let i = 0; i < (ev.a?.length || 0); i++) {
      const price = parseFloat(ev.a[i][0]);
      const rawQty = parseFloat(ev.a[i][1]);
      if (!Number.isFinite(price) || price <= 0) continue;
      const priceCents = Math.round(price * 100);
      if (rawQty === 0) {
        const prevSize = book.asks.get(priceCents);
        book.asks.delete(priceCents);
        if (priceCents <= book.bestAskCents || priceCents >= book.maxAskCents) {
          forceFullScan = true;
        }
        if (
          prevSize &&
          prevSize >= 0.2 &&
          book.asks.size >= 900 &&
          maxActiveAskCents > 0 &&
          priceCents >= maxActiveAskCents - 500
        ) {
          book.outerAsks.set(priceCents, { size: prevSize, updatedAt: now });
        } else {
          book.outerAsks.delete(priceCents);
        }
      } else if (rawQty > 0) {
        const sizeBtc = book.spec.contractSizeUsd
          ? (rawQty * book.spec.contractSizeUsd) / price
          : rawQty;
        book.asks.set(priceCents, sizeBtc);
        book.outerAsks.delete(priceCents);
        if (book.bestAskCents === 0 || priceCents < book.bestAskCents) book.bestAskCents = priceCents;
        if (priceCents > book.maxAskCents) book.maxAskCents = priceCents;
      }
    }

    book.lastUpdateId = ev.u;
    this.updateSingleBookBounds(book, forceFullScan, now);
  }

  private updateSingleBookBounds(book: BinanceBookState, forceFullScan = true, now = Date.now()) {
    const shouldPrune = now - book.lastBoundsPruneAt >= 500;
    if (!forceFullScan && !shouldPrune && book.bestBidCents > 0 && book.bestAskCents > 0) {
      return;
    }

    let bestBidCents = -Infinity;
    let minBidCents = Infinity;
    for (const p of book.bids.keys()) {
      if (p > bestBidCents) bestBidCents = p;
      if (p < minBidCents) minBidCents = p;
    }

    let bestAskCents = Infinity;
    let maxAskCents = -Infinity;
    for (const p of book.asks.keys()) {
      if (p < bestAskCents) bestAskCents = p;
      if (p > maxAskCents) maxAskCents = p;
    }

    if (bestBidCents === -Infinity || bestAskCents === Infinity) return;

    book.bestBidCents = bestBidCents;
    book.bestAskCents = bestAskCents;
    book.minBidCents = minBidCents;
    book.maxAskCents = maxAskCents;

    if (shouldPrune) {
      book.lastBoundsPruneAt = now;
      for (const [p, entry] of book.outerBids.entries()) {
        if (p >= minBidCents || p >= bestBidCents || now - entry.updatedAt > OUTER_LEVEL_TTL_MS) {
          book.outerBids.delete(p);
        }
      }
      for (const [p, entry] of book.outerAsks.entries()) {
        if (p <= maxAskCents || p <= bestAskCents || now - entry.updatedAt > OUTER_LEVEL_TTL_MS) {
          book.outerAsks.delete(p);
        }
      }
      capOuterMap(book.outerBids);
      capOuterMap(book.outerAsks);
    }
  }

  private buildCategoryCoverage(
    id: string,
    label: string,
    badgeClass: string,
    category: BinanceCategory
  ): MarketCoverageItem {
    let bidBtc = 0;
    let askBtc = 0;
    let bidLevels = 0;
    let askLevels = 0;
    let minC = Infinity;
    let maxC = -Infinity;
    let connectedCount = 0;
    let pairCount = 0;

    for (const book of this.books.values()) {
      if (book.spec.category !== category) continue;
      pairCount++;
      if (book.connected) connectedCount++;
      bidLevels += book.bids.size + book.outerBids.size;
      askLevels += book.asks.size + book.outerAsks.size;
      for (const [p, s] of book.bids.entries()) {
        bidBtc += s;
        if (p < minC) minC = p;
      }
      for (const [p, entry] of book.outerBids.entries()) {
        bidBtc += entry.size;
        if (p < minC) minC = p;
      }
      for (const [p, s] of book.asks.entries()) {
        askBtc += s;
        if (p > maxC) maxC = p;
      }
      for (const [p, entry] of book.outerAsks.entries()) {
        askBtc += entry.size;
        if (p > maxC) maxC = p;
      }
    }

    return {
      id,
      label,
      badgeClass,
      bidBtc: +bidBtc.toFixed(2),
      askBtc: +askBtc.toFixed(2),
      bidLevels,
      askLevels,
      minPrice: minC < Infinity ? +(minC / 100).toFixed(2) : 0,
      maxPrice: maxC > -Infinity ? +(maxC / 100).toFixed(2) : 0,
      extraNote: `${pairCount} pair${pairCount > 1 ? 's' : ''}`,
      connected: connectedCount > 0,
    };
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

  private recomputeFastPrimaryBounds(updateWindow = true) {
    const primary = this.books.get(this.primaryKey);
    if (!primary || primary.bestBidCents <= 0 || primary.bestAskCents <= 0) return;

    const bestBid = primary.bestBidCents / 100;
    const bestAsk = primary.bestAskCents / 100;
    const mid = (bestBid + bestAsk) / 2;

    this.ticker.bestBid = bestBid;
    this.ticker.bestAsk = bestAsk;
    this.ticker.spread = Math.max(0, +(bestAsk - bestBid).toFixed(2));
    this.ticker.connected = Array.from(this.books.values()).some((b) => b.connected);

    if (this.ticker.lastPrice === 0) {
      this.ticker.lastPrice = +mid.toFixed(2);
    }

    if (updateWindow) {
      this.updateWindowPrice(mid);
      if (this.onPricePulseCallback) this.onPricePulseCallback();
    }
  }

  private recomputeAggregateBounds(precomputedAgg?: AggregatedClusterResult, updateWindow = true) {
    this.recomputeFastPrimaryBounds(updateWindow);
    const primary = this.books.get(this.primaryKey);
    if (!primary || primary.bestBidCents <= 0 || primary.bestAskCents <= 0) return;

    this.ticker.coverageItems = [
      this.buildCategoryCoverage('USDM', 'USD-M (4)', 'tag-lin', 'usdm'),
      this.buildCategoryCoverage('COINM', 'COIN-M', 'tag-inv', 'coinm'),
      this.buildCategoryCoverage('SPOT', 'SPOT (7)', 'tag-spot', 'spot'),
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

  private recordTrade(
    id: string,
    t: number,
    price: number,
    vol: number,
    side: 'Buy' | 'Sell',
    isBootstrap: boolean
  ): TradeEvent | null {
    if (!Number.isFinite(price) || !Number.isFinite(vol) || vol <= 0) return null;
    if (this.seenTradeIds.has(id)) return null;
    this.seenTradeIds.add(id);
    if (this.seenTradeIds.size > 2000) {
      const firstKey = this.seenTradeIds.values().next().value;
      if (firstKey) this.seenTradeIds.delete(firstKey);
    }

    const trade: TradeEvent = {
      id,
      t,
      p: price,
      v: vol,
      s: side,
      exchange: 'BN',
      market: 'PERP',
    };
    this.ticker.lastPrice = price;

    if (!isBootstrap) {
      this.updateWindowPrice(price);

      if (side === 'Buy') this.windowBuyVol += vol;
      else this.windowSellVol += vol;

      this.pendingTrades.push(trade);
    }

    appendTradeBuffers(this.recentTrades, this.whaleTrades, trade);
    return trade;
  }

  private handleSpotAggTrade(d: { a: number; p: string; q: string; T: number; m: boolean }) {
    const id = `bn-spot-${d.a}`;
    if (this.seenTradeIds.has(id)) return;
    this.seenTradeIds.add(id);
    if (this.seenTradeIds.size > 2000) {
      const firstKey = this.seenTradeIds.values().next().value;
      if (firstKey) this.seenTradeIds.delete(firstKey);
    }

    const price = parseFloat(d.p);
    const vol = parseFloat(d.q);
    if (!Number.isFinite(price) || !Number.isFinite(vol) || vol <= 0) return;

    const side: 'Buy' | 'Sell' = d.m ? 'Sell' : 'Buy';
    this.ticker.spotPrice = price;
    if (side === 'Buy') this.windowSpotBuyVol += vol;
    else this.windowSpotSellVol += vol;

    const trade: TradeEvent = {
      id,
      t: d.T || Date.now(),
      p: price,
      v: vol,
      s: side,
      exchange: 'BN',
      market: 'SPOT',
    };

    if (vol >= WHALE_TRADE_MIN_BTC) {
      appendTradeBuffers(this.recentTrades, this.whaleTrades, trade);
      this.pendingTrades.push(trade);
    }
    if (this.onTradesCallback) {
      this.onTradesCallback([trade]);
    }
  }

  private handleForceOrder(data: { o?: Record<string, string | number> }) {
    const o = data.o;
    if (!o) return;
    const price = parseFloat(String(o.ap || o.p || '0'));
    const vol = parseFloat(String(o.z || o.q || '0'));
    if (!Number.isFinite(price) || !Number.isFinite(vol) || price <= 0 || vol <= 0) return;
    const t = Number(o.T) || Date.now();
    const side: 'Long' | 'Short' = String(o.S).toUpperCase() === 'SELL' ? 'Long' : 'Short';
    const id = `bn-liq-${t}-${price}-${vol}`;
    if (this.seenTradeIds.has(id)) return;
    this.seenTradeIds.add(id);

    const liq: LiquidationEvent = {
      id,
      t,
      p: price,
      v: +vol.toFixed(4),
      usd: Math.round(price * vol),
      side,
      exchange: 'BN',
    };
    appendLiquidationBuffer(this.recentLiquidations, liq);
    this.pendingLiquidations.push(liq);
    if (this.onLiquidationsCallback) {
      this.onLiquidationsCallback([liq]);
    }
  }

  public getAggregatedBook(
    scope: BinanceBookScope,
    priceStep: PriceStep,
    includeClusters = true
  ): AggregatedClusterResult {
    const mid =
      this.ticker.bestBid > 0 && this.ticker.bestAsk > 0
        ? (this.ticker.bestBid + this.ticker.bestAsk) / 2
        : this.ticker.lastPrice;
    const venueOrder = ['USDM', 'COINM', 'SPOT'];

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
    scope: BinanceBookScope,
    priceStep: PriceStep,
    includeClusters: boolean
  ): AggregatedClusterResult {
    const inv = 1 / priceStep;
    const bidBuckets = new Map<number, VenueBreakdown>();
    const askBuckets = new Map<number, VenueBreakdown>();

    const primary = this.books.get(this.primaryKey);
    const anchorBidCents = primary?.bestBidCents || Infinity;
    const anchorAskCents = primary?.bestAskCents || 0;
    const refMid =
      anchorBidCents < Infinity && anchorAskCents > 0
        ? (anchorBidCents + anchorAskCents) / 200
        : this.ticker.lastPrice;
    const minValidPrice = refMid > 0 ? refMid * 0.65 : 0;
    const maxValidPrice = refMid > 0 ? refMid * 1.35 : Infinity;

    let totalBidBtc = 0;
    let totalAskBtc = 0;
    let activeBidLevels = 0;
    let activeAskLevels = 0;
    let minPrice = Infinity;
    let maxPrice = -Infinity;

    const addLevel = (
      map: Map<number, VenueBreakdown>,
      priceCents: number,
      size: number,
      venue: string
    ) => {
      if (size <= 0) return;
      const price = priceCents / 100;
      if (price < minValidPrice || price > maxValidPrice) return;
      const b = +(Math.floor(price * inv + 1e-9) * priceStep).toFixed(2);
      let entry = map.get(b);
      if (!entry) {
        entry = {};
        map.set(b, entry);
      }
      entry[venue] = (entry[venue] || 0) + size;
    };

    for (const [key, book] of this.books.entries()) {
      const cat = book.spec.category;
      const include =
        scope === 'all' ||
        (scope === 'usdm' && cat === 'usdm') ||
        (scope === 'coinm' && cat === 'coinm') ||
        (scope === 'spot' && cat === 'spot') ||
        (scope === 'btcusdt_perp' && key === this.primaryKey);

      if (!include) continue;

      const clamp = scope === 'all' && key !== this.primaryKey;
      const venue = book.spec.venueKey;

      for (const [priceCents, size] of book.bids.entries()) {
        if (clamp && anchorAskCents > 0 && priceCents >= anchorAskCents) continue;
        const p = priceCents / 100;
        if (p < minValidPrice || p > maxValidPrice) continue;
        addLevel(bidBuckets, priceCents, size, venue);
        totalBidBtc += size;
        activeBidLevels++;
        if (p < minPrice) minPrice = p;
      }
      for (const [priceCents, entry] of book.outerBids.entries()) {
        if (clamp && anchorAskCents > 0 && priceCents >= anchorAskCents) continue;
        const p = priceCents / 100;
        if (p < minValidPrice || p > maxValidPrice) continue;
        addLevel(bidBuckets, priceCents, entry.size, venue);
        totalBidBtc += entry.size;
        activeBidLevels++;
        if (p < minPrice) minPrice = p;
      }

      for (const [priceCents, size] of book.asks.entries()) {
        if (clamp && anchorBidCents < Infinity && priceCents <= anchorBidCents) continue;
        const p = priceCents / 100;
        if (p < minValidPrice || p > maxValidPrice) continue;
        addLevel(askBuckets, priceCents, size, venue);
        totalAskBtc += size;
        activeAskLevels++;
        if (p > maxPrice) maxPrice = p;
      }
      for (const [priceCents, entry] of book.outerAsks.entries()) {
        if (clamp && anchorBidCents < Infinity && priceCents <= anchorBidCents) continue;
        const p = priceCents / 100;
        if (p < minValidPrice || p > maxValidPrice) continue;
        addLevel(askBuckets, priceCents, entry.size, venue);
        totalAskBtc += entry.size;
        activeAskLevels++;
        if (p > maxPrice) maxPrice = p;
      }
    }

    const bids: [number, number][] = [];
    const asks: [number, number][] = [];

    for (const [b, bd] of bidBuckets.entries()) {
      let tot = 0;
      for (const v of Object.values(bd)) tot += v;
      if (tot >= 0.01) bids.push([b, +tot.toFixed(3)]);
    }
    bids.sort((a, b) => b[0] - a[0]);

    for (const [b, bd] of askBuckets.entries()) {
      let tot = 0;
      for (const v of Object.values(bd)) tot += v;
      if (tot >= 0.01) asks.push([b, +tot.toFixed(3)]);
    }
    asks.sort((a, b) => a[0] - b[0]);

    const mid =
      this.ticker.bestBid > 0 && this.ticker.bestAsk > 0
        ? (this.ticker.bestBid + this.ticker.bestAsk) / 2
        : this.ticker.lastPrice;

    const clusters = includeClusters
      ? buildClusterMetrics(bids, asks, bidBuckets, askBuckets, mid, [
          'USDM',
          'COINM',
          'SPOT',
        ])
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
    return this.fetchBinanceKlines(timeframe);
  }

  private emitTimeSlice() {
    const primary = this.books.get(this.primaryKey);
    if (!primary || primary.bids.size === 0 || primary.asks.size === 0) return;

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

  private async fetchBinanceKlines(timeframe: TimeframeId): Promise<RawKline[]> {
    const cfg = TIMEFRAME_CONFIG[timeframe];
    if (!cfg || !cfg.binanceInterval) return [];

    const now = Date.now();
    const cached = this.klineCache.get(timeframe);
    if (cached && now - cached.fetchedAt < 8_000 && cached.candles.length > 0) {
      return cached.candles;
    }

    try {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${cfg.binanceInterval}&limit=400`;
      const res = await fetch(url);
      if (!res.ok) return cached ? cached.candles : [];

      const list = (await res.json()) as [number, string, string, string, string, string][];
      if (!Array.isArray(list)) return cached ? cached.candles : [];

      const candles: RawKline[] = list.map((row) => ({
        t: Number(row[0]),
        o: parseFloat(row[1]),
        h: parseFloat(row[2]),
        l: parseFloat(row[3]),
        c: parseFloat(row[4]),
        vol: parseFloat(row[5]),
      }));

      this.klineCache.set(timeframe, { fetchedAt: now, candles });
      return candles;
    } catch {
      return cached ? cached.candles : [];
    }
  }

  public async getAggregatedHistory(
    priceStep: PriceStep,
    bookScope: BinanceBookScope,
    timeframe: TimeframeId,
    maxColumns = 1200
  ): Promise<InitialHistoryResponse> {
    const cfg = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG['15m'];
    const isKlineTimeframe = Boolean(cfg.binanceInterval);
    const agg = this.getAggregatedBook(bookScope, priceStep, true);

    if (isKlineTimeframe) {
      const klines = await this.fetchBinanceKlines(timeframe);
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
        exchange: 'binance',
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
      exchange: 'binance',
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
