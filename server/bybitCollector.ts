import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type {
  AggregatedTradeBubble,
  BybitBookScope,
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

const BYBIT_LINEAR_WS = 'wss://stream.bybit.com/v5/public/linear';
const BYBIT_SPOT_WS = 'wss://stream.bybit.com/v5/public/spot';
const BYBIT_INVERSE_WS = 'wss://stream.bybit.com/v5/public/inverse';

const BYBIT_REST_LINEAR_OB =
  'https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=1000';
const BYBIT_REST_SPOT_OB =
  'https://api.bybit.com/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=1000';
const BYBIT_REST_INVERSE_OB =
  'https://api.bybit.com/v5/market/orderbook?category=inverse&symbol=BTCUSD&limit=1000';
const BYBIT_REST_USDC_OB =
  'https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCPERP&limit=1000';

const BYBIT_REST_TICKER =
  'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT';
const BYBIT_REST_TRADES =
  'https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=BTCUSDT&limit=60';

interface OuterLevelEntry {
  size: number;
  updatedAt: number;
}

interface MarketBookState {
  bids: Map<number, number>;
  asks: Map<number, number>;
  rpiBids: Map<number, number>;
  rpiAsks: Map<number, number>;
  outerBids: Map<number, OuterLevelEntry>;
  outerAsks: Map<number, OuterLevelEntry>;
  bestBidCents: number;
  bestAskCents: number;
  minBidCents: number;
  maxAskCents: number;
  lastBoundsPruneAt: number;
  lastWsAt: number;
  connected: boolean;
  isInverse: boolean;
}

function createBookState(isInverse = false): MarketBookState {
  return {
    bids: new Map(),
    asks: new Map(),
    rpiBids: new Map(),
    rpiAsks: new Map(),
    outerBids: new Map(),
    outerAsks: new Map(),
    bestBidCents: 0,
    bestAskCents: 0,
    minBidCents: 0,
    maxAskCents: 0,
    lastBoundsPruneAt: 0,
    lastWsAt: 0,
    connected: false,
    isInverse,
  };
}

interface KlineCacheEntry {
  fetchedAt: number;
  candles: RawKline[];
}

export class BybitOrderbookCollector {
  private linearBook = createBookState(false);
  private spotBook = createBookState(false);
  private inverseBook = createBookState(true);
  private usdcBook = createBookState(false);

  private baseSlices: HeatmapSlice[] = [];
  private recentTrades: TradeEvent[] = [];
  private whaleTrades: TradeEvent[] = [];
  private recentLiquidations: LiquidationEvent[] = [];
  private seenTradeIds = new Set<string>();
  private klineCache = new Map<TimeframeId, KlineCacheEntry>();
  private baseAggCache = new Map<
    BybitBookScope,
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

  private wsLinear: WebSocket | null = null;
  private wsSpot: WebSocket | null = null;
  private wsInverse: WebSocket | null = null;
  private lastWsTradeAt = 0;

  private pingLinear: NodeJS.Timeout | null = null;
  private pingSpot: NodeJS.Timeout | null = null;
  private pingInverse: NodeJS.Timeout | null = null;
  private reconnectLinear: NodeJS.Timeout | null = null;
  private reconnectSpot: NodeJS.Timeout | null = null;
  private reconnectInverse: NodeJS.Timeout | null = null;
  private sliceTimer: NodeJS.Timeout | null = null;
  private restFallbackTimer: NodeJS.Timeout | null = null;
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
  private onLiquidationsCallback: ((liqs: LiquidationEvent[]) => void) | null = null;
  private onPricePulseCallback: (() => void) | null = null;

  public ticker: TickerStats = {
    exchange: 'bybit',
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
    this.checkpointPath = path.join(dataDir, 'checkpoint-v2.json');
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
    this.pollAllRestSnapshots(true).catch(() => {});
    this.connectLinearWs();
    this.connectSpotWs();
    this.connectInverseWs();

    this.sliceTimer = setInterval(() => {
      this.emitTimeSlice();
    }, LIVE_TICK_MS);

    this.restFallbackTimer = setInterval(() => {
      const now = Date.now();
      if (
        now - this.linearBook.lastWsAt > 2500 ||
        now - this.spotBook.lastWsAt > 3500 ||
        now - this.inverseBook.lastWsAt > 3500 ||
        now - this.usdcBook.lastWsAt > 3500 ||
        now - this.lastWsTradeAt > 3500
      ) {
        this.pollAllRestSnapshots(false).catch(() => {});
      }
    }, 2500);

    this.checkpointTimer = setInterval(() => {
      saveCollectorCheckpointAsync(
        this.checkpointPath,
        this.baseSlices,
        this.recentTrades,
        this.ticker,
        this.whaleTrades,
        this.recentLiquidations
      ).catch(() => {});
    }, 61_000);
  }

  public stop() {
    if (this.sliceTimer) clearInterval(this.sliceTimer);
    if (this.restFallbackTimer) clearInterval(this.restFallbackTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    for (const t of [
      this.pingLinear,
      this.pingSpot,
      this.pingInverse,
      this.reconnectLinear,
      this.reconnectSpot,
      this.reconnectInverse,
    ]) {
      if (t) {
        clearInterval(t);
        clearTimeout(t);
      }
    }
    for (const ws of [this.wsLinear, this.wsSpot, this.wsInverse]) {
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

  private async pollAllRestSnapshots(isInitial: boolean) {
    const now = Date.now();
    const tasks: Promise<void>[] = [];

    const fetchBook = (url: string, book: MarketBookState) =>
      fetch(url)
        .then(async (res) => {
          if (!res.ok) return;
          const json = (await res.json()) as {
            retCode: number;
            result?: { b?: [string, string][]; a?: [string, string][] };
          };
          if (json.retCode === 0 && json.result) {
            this.applyBookRestSync(book, json.result.b || [], json.result.a || []);
            book.connected = true;
            this.ticker.updateCount++;
          }
        })
        .catch(() => {});

    if (isInitial || now - this.linearBook.lastWsAt > 2500) {
      tasks.push(fetchBook(BYBIT_REST_LINEAR_OB, this.linearBook));
    }
    if (isInitial || now - this.spotBook.lastWsAt > 3500) {
      tasks.push(fetchBook(BYBIT_REST_SPOT_OB, this.spotBook));
    }
    if (isInitial || now - this.inverseBook.lastWsAt > 3500) {
      tasks.push(fetchBook(BYBIT_REST_INVERSE_OB, this.inverseBook));
    }
    if (isInitial || now - this.usdcBook.lastWsAt > 3500) {
      tasks.push(fetchBook(BYBIT_REST_USDC_OB, this.usdcBook));
    }

    if (isInitial || now - this.lastWsTradeAt > 3500) {
      tasks.push(
        fetch(BYBIT_REST_TRADES)
          .then(async (res) => {
            if (!res.ok) return;
            const trJson = (await res.json()) as {
              retCode: number;
              result?: {
                list?: {
                  execId: string;
                  price: string;
                  size: string;
                  side: 'Buy' | 'Sell';
                  time: string;
                }[];
              };
            };
            if (trJson.retCode === 0 && Array.isArray(trJson.result?.list)) {
              const list = [...trJson.result.list].reverse();
              const mapped = list.map((item) => ({
                T: Number(item.time) || Date.now(),
                s: 'BTCUSDT',
                S: item.side,
                v: item.size,
                p: item.price,
                i: item.execId,
              }));
              this.handleTradeMessage({ data: mapped }, isInitial);
            }
          })
          .catch(() => {}),
        fetch(BYBIT_REST_TICKER)
          .then(async (res) => {
            if (!res.ok) return;
            const tkJson = (await res.json()) as {
              retCode: number;
              result?: { list?: Record<string, string>[] };
            };
            const item = tkJson.result?.list?.[0];
            if (item) this.applyTickerUpdate(item);
          })
          .catch(() => {})
      );
    }

    await Promise.all(tasks);
    this.recomputeAggregateBounds();
  }

  private connectLinearWs() {
    if (this.wsLinear) {
      this.wsLinear.removeAllListeners();
      try {
        this.wsLinear.close();
      } catch {
        // ignore
      }
    }

    const ws = new WebSocket(BYBIT_LINEAR_WS);
    this.wsLinear = ws;

    ws.on('open', () => {
      console.log('[Bybit Linear WS] Connected:', BYBIT_LINEAR_WS);
      this.linearBook.connected = true;
      this.usdcBook.connected = true;
      this.ticker.connected = true;

      ws.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.1000.BTCUSDT'] }));
      ws.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.rpi.BTCUSDT'] }));
      ws.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.1000.BTCPERP'] }));
      ws.send(JSON.stringify({ op: 'subscribe', args: ['publicTrade.BTCUSDT'] }));
      ws.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] }));
      ws.send(JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT'] }));

      if (this.pingLinear) clearInterval(this.pingLinear);
      this.pingLinear = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: 'ping' }));
        }
      }, 20_000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg.topic) return;

        if (msg.topic === 'orderbook.1000.BTCUSDT') {
          this.linearBook.lastWsAt = Date.now();
          this.handleBookMessage(this.linearBook, msg, true);
        } else if (msg.topic === 'orderbook.rpi.BTCUSDT') {
          this.linearBook.lastWsAt = Date.now();
          this.handleRpiMessage(this.linearBook, msg);
        } else if (msg.topic === 'orderbook.1000.BTCPERP') {
          this.usdcBook.lastWsAt = Date.now();
          this.handleBookMessage(this.usdcBook, msg, false);
        } else if (msg.topic === 'publicTrade.BTCUSDT') {
          this.lastWsTradeAt = Date.now();
          this.handleTradeMessage(msg, false);
        } else if (msg.topic === 'allLiquidation.BTCUSDT') {
          this.handleLiquidationMessage(msg);
        } else if (msg.topic === 'tickers.BTCUSDT') {
          if (msg.data) this.applyTickerUpdate(msg.data);
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      if (this.pingLinear) clearInterval(this.pingLinear);
      this.linearBook.connected = false;
      this.usdcBook.connected = false;
      if (this.reconnectLinear) clearTimeout(this.reconnectLinear);
      this.reconnectLinear = setTimeout(() => this.connectLinearWs(), 2000);
    });

    ws.on('error', () => {
      this.linearBook.connected = false;
    });
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

    const ws = new WebSocket(BYBIT_SPOT_WS);
    this.wsSpot = ws;

    ws.on('open', () => {
      console.log('[Bybit Spot WS] Connected:', BYBIT_SPOT_WS);
      this.spotBook.connected = true;
      ws.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.1000.BTCUSDT'] }));
      ws.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.rpi.BTCUSDT'] }));
      ws.send(JSON.stringify({ op: 'subscribe', args: ['publicTrade.BTCUSDT'] }));

      if (this.pingSpot) clearInterval(this.pingSpot);
      this.pingSpot = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: 'ping' }));
        }
      }, 20_000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg.topic) return;

        if (msg.topic === 'orderbook.1000.BTCUSDT') {
          this.spotBook.lastWsAt = Date.now();
          this.handleBookMessage(this.spotBook, msg, false);
        } else if (msg.topic === 'orderbook.rpi.BTCUSDT') {
          this.spotBook.lastWsAt = Date.now();
          this.handleRpiMessage(this.spotBook, msg);
        } else if (msg.topic === 'publicTrade.BTCUSDT') {
          this.handleSpotTradeMessage(msg);
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      if (this.pingSpot) clearInterval(this.pingSpot);
      this.spotBook.connected = false;
      if (this.reconnectSpot) clearTimeout(this.reconnectSpot);
      this.reconnectSpot = setTimeout(() => this.connectSpotWs(), 2500);
    });

    ws.on('error', () => {
      this.spotBook.connected = false;
    });
  }

  private connectInverseWs() {
    if (this.wsInverse) {
      this.wsInverse.removeAllListeners();
      try {
        this.wsInverse.close();
      } catch {
        // ignore
      }
    }

    const ws = new WebSocket(BYBIT_INVERSE_WS);
    this.wsInverse = ws;

    ws.on('open', () => {
      console.log('[Bybit Inverse WS] Connected:', BYBIT_INVERSE_WS);
      this.inverseBook.connected = true;
      ws.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.1000.BTCUSD'] }));

      if (this.pingInverse) clearInterval(this.pingInverse);
      this.pingInverse = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: 'ping' }));
        }
      }, 20_000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg.topic) return;

        if (msg.topic === 'orderbook.1000.BTCUSD') {
          this.inverseBook.lastWsAt = Date.now();
          this.handleBookMessage(this.inverseBook, msg, false);
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      if (this.pingInverse) clearInterval(this.pingInverse);
      this.inverseBook.connected = false;
      if (this.reconnectInverse) clearTimeout(this.reconnectInverse);
      this.reconnectInverse = setTimeout(() => this.connectInverseWs(), 2500);
    });

    ws.on('error', () => {
      this.inverseBook.connected = false;
    });
  }

  private handleBookMessage(
    book: MarketBookState,
    msg: {
      type: 'snapshot' | 'delta';
      data: { b?: [string, string][]; a?: [string, string][]; u?: number };
    },
    isPrimary: boolean
  ) {
    const { type, data } = msg;
    if (!data) return;

    if (type === 'snapshot' || data.u === 1) {
      this.applyBookSnapshot(book, data.b || [], data.a || []);
    } else {
      this.applyBookDelta(book, data.b || [], data.a || []);
    }
    this.ticker.updateCount++;
    if (isPrimary) {
      this.recomputeFastPrimaryBounds();
    }
  }

  private handleRpiMessage(
    book: MarketBookState,
    msg: {
      type: 'snapshot' | 'delta';
      data: { b?: [string, string, string][]; a?: [string, string, string][]; u?: number };
    }
  ) {
    const { type, data } = msg;
    if (!data) return;

    if (type === 'snapshot' || data.u === 1) {
      book.rpiBids.clear();
      book.rpiAsks.clear();
    }

    for (const row of data.b || []) {
      const priceCents = Math.round(parseFloat(row[0]) * 100);
      const rpiSize = parseFloat(row[2] || '0');
      if (!Number.isFinite(priceCents)) continue;
      if (rpiSize <= 0) book.rpiBids.delete(priceCents);
      else book.rpiBids.set(priceCents, rpiSize);
    }

    for (const row of data.a || []) {
      const priceCents = Math.round(parseFloat(row[0]) * 100);
      const rpiSize = parseFloat(row[2] || '0');
      if (!Number.isFinite(priceCents)) continue;
      if (rpiSize <= 0) book.rpiAsks.delete(priceCents);
      else book.rpiAsks.set(priceCents, rpiSize);
    }
  }

  private applyBookRestSync(
    book: MarketBookState,
    bids: [string, string][],
    asks: [string, string][]
  ) {
    const now = Date.now();
    if (book.bids.size > 0 && book.minBidCents > 0) {
      for (const [priceCents, prevSize] of book.bids.entries()) {
        if (prevSize >= 0.25 && priceCents <= book.minBidCents + 300) {
          book.outerBids.set(priceCents, { size: prevSize, updatedAt: now });
        }
      }
    }
    if (book.asks.size > 0 && book.maxAskCents > 0) {
      for (const [priceCents, prevSize] of book.asks.entries()) {
        if (prevSize >= 0.25 && priceCents >= book.maxAskCents - 300) {
          book.outerAsks.set(priceCents, { size: prevSize, updatedAt: now });
        }
      }
    }
    this.applyBookSnapshot(book, bids, asks);
  }

  private applyBookSnapshot(
    book: MarketBookState,
    bids: [string, string][],
    asks: [string, string][]
  ) {
    book.bids.clear();
    book.asks.clear();

    for (let i = 0; i < bids.length; i++) {
      const price = parseFloat(bids[i][0]);
      const rawSize = parseFloat(bids[i][1]);
      if (!Number.isFinite(price) || price <= 0 || rawSize <= 0) continue;
      const sizeBtc = book.isInverse ? rawSize / price : rawSize;
      const priceCents = Math.round(price * 100);
      book.bids.set(priceCents, sizeBtc);
      book.outerBids.delete(priceCents);
    }

    for (let i = 0; i < asks.length; i++) {
      const price = parseFloat(asks[i][0]);
      const rawSize = parseFloat(asks[i][1]);
      if (!Number.isFinite(price) || price <= 0 || rawSize <= 0) continue;
      const sizeBtc = book.isInverse ? rawSize / price : rawSize;
      const priceCents = Math.round(price * 100);
      book.asks.set(priceCents, sizeBtc);
      book.outerAsks.delete(priceCents);
    }

    this.updateSingleBookBounds(book, true);
  }

  private applyBookDelta(
    book: MarketBookState,
    bids: [string, string][],
    asks: [string, string][]
  ) {
    const now = Date.now();
    const minActiveBidCents = book.minBidCents;
    const maxActiveAskCents = book.maxAskCents;

    for (let i = 0; i < bids.length; i++) {
      const price = parseFloat(bids[i][0]);
      const rawSize = parseFloat(bids[i][1]);
      if (!Number.isFinite(price) || price <= 0) continue;
      const priceCents = Math.round(price * 100);
      if (rawSize === 0) {
        const prevSize = book.bids.get(priceCents);
        book.bids.delete(priceCents);
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
      } else if (rawSize > 0) {
        const sizeBtc = book.isInverse ? rawSize / price : rawSize;
        book.bids.set(priceCents, sizeBtc);
        book.outerBids.delete(priceCents);
      }
    }

    for (let i = 0; i < asks.length; i++) {
      const price = parseFloat(asks[i][0]);
      const rawSize = parseFloat(asks[i][1]);
      if (!Number.isFinite(price) || price <= 0) continue;
      const priceCents = Math.round(price * 100);
      if (rawSize === 0) {
        const prevSize = book.asks.get(priceCents);
        book.asks.delete(priceCents);
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
      } else if (rawSize > 0) {
        const sizeBtc = book.isInverse ? rawSize / price : rawSize;
        book.asks.set(priceCents, sizeBtc);
        book.outerAsks.delete(priceCents);
      }
    }

    this.updateSingleBookBounds(book, false);
  }

  private updateSingleBookBounds(book: MarketBookState, forcePrune = false) {
    let bestBidCents = -Infinity;
    let minBidCents = Infinity;
    for (const priceCents of book.bids.keys()) {
      if (priceCents > bestBidCents) bestBidCents = priceCents;
      if (priceCents < minBidCents) minBidCents = priceCents;
    }

    let bestAskCents = Infinity;
    let maxAskCents = -Infinity;
    for (const priceCents of book.asks.keys()) {
      if (priceCents < bestAskCents) bestAskCents = priceCents;
      if (priceCents > maxAskCents) maxAskCents = priceCents;
    }

    if (bestBidCents === -Infinity || bestAskCents === Infinity) return;

    book.bestBidCents = bestBidCents;
    book.bestAskCents = bestAskCents;
    book.minBidCents = minBidCents;
    book.maxAskCents = maxAskCents;

    const now = Date.now();
    if (forcePrune || now - book.lastBoundsPruneAt >= 500) {
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

  private buildCoverageItem(
    id: string,
    label: string,
    badgeClass: string,
    book: MarketBookState
  ): MarketCoverageItem {
    let bidBtc = 0;
    let askBtc = 0;
    let rpiBtc = 0;
    let minC = Infinity;
    let maxC = -Infinity;

    for (const [p, s] of book.bids.entries()) {
      bidBtc += s;
      if (p < minC) minC = p;
    }
    for (const [p, entry] of book.outerBids.entries()) {
      bidBtc += entry.size;
      if (p < minC) minC = p;
    }
    for (const s of book.rpiBids.values()) {
      bidBtc += s;
      rpiBtc += s;
    }
    for (const [p, s] of book.asks.entries()) {
      askBtc += s;
      if (p > maxC) maxC = p;
    }
    for (const [p, entry] of book.outerAsks.entries()) {
      askBtc += entry.size;
      if (p > maxC) maxC = p;
    }
    for (const s of book.rpiAsks.values()) {
      askBtc += s;
      rpiBtc += s;
    }

    return {
      id,
      label,
      badgeClass,
      bidBtc: +bidBtc.toFixed(2),
      askBtc: +askBtc.toFixed(2),
      bidLevels: book.bids.size + book.outerBids.size,
      askLevels: book.asks.size + book.outerAsks.size,
      minPrice: minC < Infinity ? +(minC / 100).toFixed(2) : 0,
      maxPrice: maxC > -Infinity ? +(maxC / 100).toFixed(2) : 0,
      extraNote: rpiBtc > 0.1 ? `+${rpiBtc.toFixed(1)} RPI` : undefined,
      connected: book.connected,
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
    const lin = this.linearBook;
    if (lin.bestBidCents <= 0 || lin.bestAskCents <= 0) return;

    const bestBid = lin.bestBidCents / 100;
    const bestAsk = lin.bestAskCents / 100;
    const mid = (bestBid + bestAsk) / 2;

    this.ticker.bestBid = bestBid;
    this.ticker.bestAsk = bestAsk;
    this.ticker.spread = Math.max(0, +(bestAsk - bestBid).toFixed(2));
    this.ticker.connected =
      this.linearBook.connected || this.spotBook.connected || this.inverseBook.connected;

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
    const lin = this.linearBook;
    if (lin.bestBidCents <= 0 || lin.bestAskCents <= 0) return;

    this.ticker.coverageItems = [
      this.buildCoverageItem('LIN', 'LIN+RPI', 'tag-lin', this.linearBook),
      this.buildCoverageItem('SPOT', 'SPOT', 'tag-spot', this.spotBook),
      this.buildCoverageItem('INV', 'INV', 'tag-inv', this.inverseBook),
      this.buildCoverageItem('USDC', 'USDC', 'tag-usdc', this.usdcBook),
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

  private handleTradeMessage(
    msg: {
      data?: {
        T: number;
        s: string;
        S: 'Buy' | 'Sell';
        v: string;
        p: string;
        i: string;
      }[];
    },
    isHistoricalBootstrap = false
  ) {
    if (!Array.isArray(msg.data)) return;
    const acceptedTrades: TradeEvent[] = [];

    for (const tr of msg.data) {
      const id = tr.i || `${tr.T}-${tr.p}-${tr.v}`;
      if (this.seenTradeIds.has(id)) continue;
      this.seenTradeIds.add(id);
      if (this.seenTradeIds.size > 2000) {
        const firstKey = this.seenTradeIds.values().next().value;
        if (firstKey) this.seenTradeIds.delete(firstKey);
      }

      const price = parseFloat(tr.p);
      const vol = parseFloat(tr.v);
      if (!Number.isFinite(price) || !Number.isFinite(vol) || vol <= 0) continue;

      const side: 'Buy' | 'Sell' = tr.S === 'Buy' ? 'Buy' : 'Sell';
      const trade: TradeEvent = {
        id,
        t: tr.T || Date.now(),
        p: price,
        v: vol,
        s: side,
        exchange: 'BYB',
        market: 'PERP',
      };

      this.ticker.lastPrice = price;

      if (!isHistoricalBootstrap) {
        this.updateWindowPrice(price);

        if (side === 'Buy') {
          this.windowBuyVol += vol;
        } else {
          this.windowSellVol += vol;
        }

        this.pendingTrades.push(trade);
        acceptedTrades.push(trade);
      }

      appendTradeBuffers(this.recentTrades, this.whaleTrades, trade);
    }

    if (!isHistoricalBootstrap && acceptedTrades.length > 0 && this.onTradesCallback) {
      this.onTradesCallback(acceptedTrades);
    }
  }

  private handleSpotTradeMessage(msg: {
    data?: {
      T: number;
      S: 'Buy' | 'Sell';
      v: string;
      p: string;
      i: string;
    }[];
  }) {
    if (!Array.isArray(msg.data)) return;
    const acceptedSpot: TradeEvent[] = [];

    for (const tr of msg.data) {
      const id = `byb-spot-${tr.i || `${tr.T}-${tr.p}-${tr.v}`}`;
      if (this.seenTradeIds.has(id)) continue;
      this.seenTradeIds.add(id);
      if (this.seenTradeIds.size > 2000) {
        const firstKey = this.seenTradeIds.values().next().value;
        if (firstKey) this.seenTradeIds.delete(firstKey);
      }

      const price = parseFloat(tr.p);
      const vol = parseFloat(tr.v);
      if (!Number.isFinite(price) || !Number.isFinite(vol) || vol <= 0) continue;

      const side: 'Buy' | 'Sell' = tr.S === 'Buy' ? 'Buy' : 'Sell';
      this.ticker.spotPrice = price;
      if (side === 'Buy') this.windowSpotBuyVol += vol;
      else this.windowSpotSellVol += vol;

      const trade: TradeEvent = {
        id,
        t: tr.T || Date.now(),
        p: price,
        v: vol,
        s: side,
        exchange: 'BYB',
        market: 'SPOT',
      };

      if (vol >= WHALE_TRADE_MIN_BTC) {
        appendTradeBuffers(this.recentTrades, this.whaleTrades, trade);
        this.pendingTrades.push(trade);
      }
      acceptedSpot.push(trade);
    }

    if (acceptedSpot.length > 0 && this.onTradesCallback) {
      this.onTradesCallback(acceptedSpot);
    }
  }

  private handleLiquidationMessage(msg: {
    data?:
      | { T?: number; S?: 'Buy' | 'Sell'; v?: string; p?: string }[]
      | { T?: number; S?: 'Buy' | 'Sell'; v?: string; p?: string };
  }) {
    const items = Array.isArray(msg.data) ? msg.data : msg.data ? [msg.data] : [];
    const added: LiquidationEvent[] = [];

    for (const item of items) {
      const price = parseFloat(item.p || '0');
      const vol = parseFloat(item.v || '0');
      if (!Number.isFinite(price) || !Number.isFinite(vol) || price <= 0 || vol <= 0) continue;
      const t = item.T || Date.now();
      const side: 'Long' | 'Short' = item.S === 'Sell' ? 'Long' : 'Short';
      const id = `byb-liq-${t}-${price}-${vol}`;
      if (this.seenTradeIds.has(id)) continue;
      this.seenTradeIds.add(id);

      const liq: LiquidationEvent = {
        id,
        t,
        p: price,
        v: +vol.toFixed(4),
        usd: Math.round(price * vol),
        side,
        exchange: 'BYB',
      };
      appendLiquidationBuffer(this.recentLiquidations, liq);
      this.pendingLiquidations.push(liq);
      added.push(liq);
    }

    if (added.length > 0 && this.onLiquidationsCallback) {
      this.onLiquidationsCallback(added);
    }
  }

  private applyTickerUpdate(data: Record<string, string>) {
    if (data.lastPrice) this.ticker.lastPrice = parseFloat(data.lastPrice);
    if (data.markPrice) this.ticker.markPrice = parseFloat(data.markPrice);
    if (data.indexPrice) this.ticker.indexPrice = parseFloat(data.indexPrice);
    if (data.price24hPcnt) this.ticker.price24hPcnt = parseFloat(data.price24hPcnt) * 100;
    if (data.highPrice24h) this.ticker.highPrice24h = parseFloat(data.highPrice24h);
    if (data.lowPrice24h) this.ticker.lowPrice24h = parseFloat(data.lowPrice24h);
    if (data.volume24h) this.ticker.volume24h = parseFloat(data.volume24h);
    if (data.turnover24h) this.ticker.turnover24h = parseFloat(data.turnover24h);
    if (data.openInterestValue)
      this.ticker.openInterestValue = parseFloat(data.openInterestValue);
    if (data.fundingRate) this.ticker.fundingRate = parseFloat(data.fundingRate) * 100;
  }

  public getAggregatedBook(
    scope: BybitBookScope,
    priceStep: PriceStep,
    includeClusters = true
  ): AggregatedClusterResult {
    const mid =
      this.ticker.bestBid > 0 && this.ticker.bestAsk > 0
        ? (this.ticker.bestBid + this.ticker.bestAsk) / 2
        : this.ticker.lastPrice;
    const venueOrder = ['LIN', 'RPI', 'SPOT', 'INV', 'USDC'];

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
    scope: BybitBookScope,
    priceStep: PriceStep,
    includeClusters: boolean
  ): AggregatedClusterResult {
    const inv = 1 / priceStep;
    const bidBuckets = new Map<number, VenueBreakdown>();
    const askBuckets = new Map<number, VenueBreakdown>();

    const anchorBidCents = this.linearBook.bestBidCents || Infinity;
    const anchorAskCents = this.linearBook.bestAskCents || 0;
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

    const ingestBook = (
      book: MarketBookState,
      venue: string,
      rpiVenue: string | null,
      clampToLinearSpread: boolean
    ) => {
      for (const [priceCents, size] of book.bids.entries()) {
        if (clampToLinearSpread && anchorAskCents > 0 && priceCents >= anchorAskCents) continue;
        const p = priceCents / 100;
        if (p < minValidPrice || p > maxValidPrice) continue;
        addLevel(bidBuckets, priceCents, size, venue);
        totalBidBtc += size;
        activeBidLevels++;
        if (p < minPrice) minPrice = p;
      }
      for (const [priceCents, entry] of book.outerBids.entries()) {
        if (clampToLinearSpread && anchorAskCents > 0 && priceCents >= anchorAskCents) continue;
        const p = priceCents / 100;
        if (p < minValidPrice || p > maxValidPrice) continue;
        addLevel(bidBuckets, priceCents, entry.size, venue);
        totalBidBtc += entry.size;
        activeBidLevels++;
        if (p < minPrice) minPrice = p;
      }
      if (rpiVenue) {
        for (const [priceCents, size] of book.rpiBids.entries()) {
          if (clampToLinearSpread && anchorAskCents > 0 && priceCents >= anchorAskCents) continue;
          const p = priceCents / 100;
          if (p < minValidPrice || p > maxValidPrice) continue;
          addLevel(bidBuckets, priceCents, size, rpiVenue);
          totalBidBtc += size;
        }
      }

      for (const [priceCents, size] of book.asks.entries()) {
        if (clampToLinearSpread && anchorBidCents < Infinity && priceCents <= anchorBidCents)
          continue;
        const p = priceCents / 100;
        if (p < minValidPrice || p > maxValidPrice) continue;
        addLevel(askBuckets, priceCents, size, venue);
        totalAskBtc += size;
        activeAskLevels++;
        if (p > maxPrice) maxPrice = p;
      }
      for (const [priceCents, entry] of book.outerAsks.entries()) {
        if (clampToLinearSpread && anchorBidCents < Infinity && priceCents <= anchorBidCents)
          continue;
        const p = priceCents / 100;
        if (p < minValidPrice || p > maxValidPrice) continue;
        addLevel(askBuckets, priceCents, entry.size, venue);
        totalAskBtc += entry.size;
        activeAskLevels++;
        if (p > maxPrice) maxPrice = p;
      }
      if (rpiVenue) {
        for (const [priceCents, size] of book.rpiAsks.entries()) {
          if (clampToLinearSpread && anchorBidCents < Infinity && priceCents <= anchorBidCents)
            continue;
          const p = priceCents / 100;
          if (p < minValidPrice || p > maxValidPrice) continue;
          addLevel(askBuckets, priceCents, size, rpiVenue);
          totalAskBtc += size;
        }
      }
    };

    if (scope === 'all' || scope === 'linear') {
      ingestBook(this.linearBook, 'LIN', 'RPI', false);
    }
    if (scope === 'all' || scope === 'spot') {
      ingestBook(this.spotBook, 'SPOT', 'RPI', scope === 'all');
    }
    if (scope === 'all' || scope === 'inverse') {
      ingestBook(this.inverseBook, 'INV', null, scope === 'all');
    }
    if (scope === 'all' || scope === 'usdc') {
      ingestBook(this.usdcBook, 'USDC', null, scope === 'all');
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
          'LIN',
          'RPI',
          'SPOT',
          'INV',
          'USDC',
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
    return this.fetchBybitKlines(timeframe);
  }

  private emitTimeSlice() {
    if (this.linearBook.bids.size === 0 || this.linearBook.asks.size === 0) return;

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

  private async fetchBybitKlines(timeframe: TimeframeId): Promise<RawKline[]> {
    const cfg = TIMEFRAME_CONFIG[timeframe];
    if (!cfg || !cfg.bybitInterval) return [];

    const now = Date.now();
    const cached = this.klineCache.get(timeframe);
    if (cached && now - cached.fetchedAt < 8_000 && cached.candles.length > 0) {
      return cached.candles;
    }

    try {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=${cfg.bybitInterval}&limit=400`;
      const res = await fetch(url);
      if (!res.ok) return cached ? cached.candles : [];

      const json = (await res.json()) as {
        retCode: number;
        result?: { list?: string[][] };
      };
      if (json.retCode !== 0 || !Array.isArray(json.result?.list)) {
        return cached ? cached.candles : [];
      }

      const candles: RawKline[] = json.result.list
        .map((row) => ({
          t: Number(row[0]),
          o: parseFloat(row[1]),
          h: parseFloat(row[2]),
          l: parseFloat(row[3]),
          c: parseFloat(row[4]),
          vol: parseFloat(row[5]),
        }))
        .reverse();

      this.klineCache.set(timeframe, { fetchedAt: now, candles });
      return candles;
    } catch {
      return cached ? cached.candles : [];
    }
  }

  public async getAggregatedHistory(
    priceStep: PriceStep,
    bookScope: BybitBookScope,
    timeframe: TimeframeId,
    maxColumns = 1200
  ): Promise<InitialHistoryResponse> {
    const cfg = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG['15m'];
    const isKlineTimeframe = Boolean(cfg.bybitInterval);
    const agg = this.getAggregatedBook(bookScope, priceStep, true);

    if (isKlineTimeframe) {
      const klines = await this.fetchBybitKlines(timeframe);
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
        exchange: 'bybit',
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
      exchange: 'bybit',
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
