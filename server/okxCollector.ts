import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type {
  AggregatedTradeBubble,
  HeatmapSlice,
  InitialHistoryResponse,
  LiquidationEvent,
  MarketCoverageItem,
  OkxBookScope,
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
  type RawKline,
  TIMEFRAME_CONFIG,
  WHALE_TRADE_MIN_BTC,
  appendLiquidationBuffer,
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

const OKX_REST_BASE = 'https://www.okx.com';
const OKX_WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';

type OkxInstId = 'BTC-USDT-SWAP' | 'BTC-USD-SWAP' | 'BTC-USDT' | 'BTC-USDC';

interface OkxBookState {
  instId: OkxInstId;
  venueKey: 'USDT' | 'USD' | 'SPOT';
  isPerp: boolean;
  sizeMode: 'ct_btc' | 'ct_usd' | 'btc';
  ctVal: number;
  bids: Map<number, number>; // price -> BTC size
  asks: Map<number, number>; // price -> BTC size
  bestBid: number;
  bestAsk: number;
  lastPrice: number;
  open24h: number;
  high24h: number;
  low24h: number;
  volBtc24h: number;
  connected: boolean;
}

interface KlineCacheEntry {
  fetchedAt: number;
  candles: RawKline[];
}

function makeOkxBook(
  instId: OkxInstId,
  venueKey: 'USDT' | 'USD' | 'SPOT',
  isPerp: boolean,
  sizeMode: 'ct_btc' | 'ct_usd' | 'btc',
  ctVal: number
): OkxBookState {
  return {
    instId,
    venueKey,
    isPerp,
    sizeMode,
    ctVal,
    bids: new Map(),
    asks: new Map(),
    bestBid: 0,
    bestAsk: Infinity,
    lastPrice: 0,
    open24h: 0,
    high24h: 0,
    low24h: 0,
    volBtc24h: 0,
    connected: false,
  };
}

function convertOkxSizeToBtc(book: OkxBookState, rawSz: number, price: number): number {
  if (rawSz <= 0 || price <= 0) return 0;
  if (book.sizeMode === 'ct_btc') return rawSz * book.ctVal; // 0.01 BTC / contract
  if (book.sizeMode === 'ct_usd') return (rawSz * book.ctVal) / price; // $100 / contract
  return rawSz;
}

export class OkxOrderbookCollector {
  private books: Record<OkxInstId, OkxBookState> = {
    'BTC-USDT-SWAP': makeOkxBook('BTC-USDT-SWAP', 'USDT', true, 'ct_btc', 0.01),
    'BTC-USD-SWAP': makeOkxBook('BTC-USD-SWAP', 'USD', true, 'ct_usd', 100),
    'BTC-USDT': makeOkxBook('BTC-USDT', 'SPOT', false, 'btc', 1),
    'BTC-USDC': makeOkxBook('BTC-USDC', 'SPOT', false, 'btc', 1),
  };

  private baseSlices: HeatmapSlice[] = [];
  private recentTrades: TradeEvent[] = [];
  private whaleTrades: TradeEvent[] = [];
  private recentLiquidations: LiquidationEvent[] = [];
  private seenTradeIds = new Set<string>();
  private klineCache = new Map<TimeframeId, KlineCacheEntry>();
  private baseAggCache = new Map<
    OkxBookScope,
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
  private restPollTimer: NodeJS.Timeout | null = null;
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
  private onLiquidationsCallback: ((liqs: LiquidationEvent[]) => void) | null = null;
  private onPricePulseCallback: (() => void) | null = null;

  public ticker: TickerStats = {
    exchange: 'okx',
    symbol: 'BTC-USDT-SWAP',
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
    this.checkpointPath = path.join(dataDir, 'okx-checkpoint.json');
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
    this.pollMetaAndMetrics().catch(() => {});
    this.connectWs();

    this.restPollTimer = setInterval(() => {
      this.pollMetaAndMetrics().catch(() => {});
    }, 15_000);

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
    }, 73_000);
  }

  public stop() {
    for (const t of [
      this.pingTimer,
      this.reconnectTimer,
      this.restPollTimer,
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

  private async pollMetaAndMetrics() {
    const fetchJson = async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      }
    };

    const [oiUsdt, oiUsd, frRes, idxRes] = await Promise.all([
      fetchJson<{ data?: { oiUsd?: string }[] }>(
        `${OKX_REST_BASE}/api/v5/public/open-interest?instType=SWAP&uly=BTC-USDT`
      ),
      fetchJson<{ data?: { oiUsd?: string }[] }>(
        `${OKX_REST_BASE}/api/v5/public/open-interest?instType=SWAP&uly=BTC-USD`
      ),
      fetchJson<{ data?: { fundingRate?: string }[] }>(
        `${OKX_REST_BASE}/api/v5/public/funding-rate?instId=BTC-USDT-SWAP`
      ),
      fetchJson<{ data?: { idxPx?: string }[] }>(
        `${OKX_REST_BASE}/api/v5/market/index-tickers?instId=BTC-USDT`
      ),
    ]);

    const oi1 = parseFloat(oiUsdt?.data?.[0]?.oiUsd || '0');
    const oi2 = parseFloat(oiUsd?.data?.[0]?.oiUsd || '0');
    if (oi1 + oi2 > 0) {
      this.ticker.openInterestValue = Math.round(oi1 + oi2);
    }

    const fr = parseFloat(frRes?.data?.[0]?.fundingRate || 'NaN');
    if (Number.isFinite(fr)) {
      this.ticker.fundingRate = +(fr * 100).toFixed(4);
    }

    const idxPx = parseFloat(idxRes?.data?.[0]?.idxPx || '0');
    if (idxPx > 0) {
      this.ticker.indexPrice = idxPx;
    }
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

    const ws = new WebSocket(OKX_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[OKX WS] Connected (BTC-USDT-SWAP + BTC-USD-SWAP + Spot)');
      for (const b of Object.values(this.books)) b.connected = true;
      this.ticker.connected = true;

      const instIds: OkxInstId[] = ['BTC-USDT-SWAP', 'BTC-USD-SWAP', 'BTC-USDT', 'BTC-USDC'];
      const args: Record<string, string>[] = [];
      for (const instId of instIds) {
        args.push({ channel: 'books', instId });
        args.push({ channel: 'trades', instId });
        args.push({ channel: 'tickers', instId });
      }
      args.push({ channel: 'mark-price', instId: 'BTC-USDT-SWAP' });
      args.push({ channel: 'liquidation-orders', instType: 'SWAP' });

      ws.send(JSON.stringify({ op: 'subscribe', args }));

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
        }
      }, 20_000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      const text = raw.toString();
      if (text === 'pong') return;

      try {
        const msg = JSON.parse(text) as {
          event?: string;
          action?: 'snapshot' | 'update';
          arg?: { channel?: string; instId?: string };
          data?: unknown[];
        };
        if (msg.event || !msg.arg?.channel || !Array.isArray(msg.data)) return;

        const ch = msg.arg.channel;
        if (ch === 'books') {
          const book = this.books[msg.arg.instId as OkxInstId];
          if (!book) return;
          const entry = msg.data[0] as { bids?: string[][]; asks?: string[][] } | undefined;
          if (!entry) return;
          this.handleBookMessage(book, msg.action === 'snapshot', entry.bids || [], entry.asks || []);
        } else if (ch === 'trades') {
          const book = this.books[msg.arg.instId as OkxInstId];
          if (!book) return;
          this.handleTradesMessage(
            book,
            msg.data as { tradeId?: string; px?: string; sz?: string; side?: string; ts?: string }[]
          );
        } else if (ch === 'tickers') {
          const book = this.books[msg.arg.instId as OkxInstId];
          if (!book) return;
          const d = msg.data[0] as
            | { last?: string; open24h?: string; high24h?: string; low24h?: string; vol24h?: string; volCcy24h?: string }
            | undefined;
          if (d) this.handleTickerMessage(book, d);
        } else if (ch === 'mark-price') {
          const d = msg.data[0] as { markPx?: string } | undefined;
          const mp = parseFloat(d?.markPx || '0');
          if (mp > 0) this.ticker.markPrice = mp;
        } else if (ch === 'liquidation-orders') {
          this.handleLiquidationsMessage(
            msg.data as {
              instId?: string;
              details?: { side?: string; bkPx?: string; sz?: string; ts?: string }[];
            }[]
          );
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      for (const b of Object.values(this.books)) b.connected = false;
      this.ticker.connected = false;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connectWs(), 2000);
    });

    ws.on('error', () => {
      this.ticker.connected = false;
    });
  }

  private handleBookMessage(
    book: OkxBookState,
    isSnapshot: boolean,
    rawBids: string[][],
    rawAsks: string[][]
  ) {
    if (isSnapshot) {
      book.bids.clear();
      book.asks.clear();
      book.bestBid = 0;
      book.bestAsk = Infinity;
    }
    let rescanBid = false;
    let rescanAsk = false;
    for (let i = 0; i < rawBids.length; i++) {
      const p = parseFloat(rawBids[i][0]);
      const rawSz = parseFloat(rawBids[i][1]);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (rawSz <= 0) {
        if (book.bids.delete(p) && p === book.bestBid) rescanBid = true;
      } else {
        book.bids.set(p, convertOkxSizeToBtc(book, rawSz, p));
        if (p > book.bestBid) book.bestBid = p;
      }
    }
    for (let i = 0; i < rawAsks.length; i++) {
      const p = parseFloat(rawAsks[i][0]);
      const rawSz = parseFloat(rawAsks[i][1]);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (rawSz <= 0) {
        if (book.asks.delete(p) && p === book.bestAsk) rescanAsk = true;
      } else {
        book.asks.set(p, convertOkxSizeToBtc(book, rawSz, p));
        if (p < book.bestAsk) book.bestAsk = p;
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

    book.connected = true;
    this.ticker.connected = true;
    this.ticker.updateCount++;
    if (book.instId === 'BTC-USDT-SWAP') {
      this.syncFastPrimaryBounds(true);
    } else if (book.instId === 'BTC-USDT') {
      if (book.bestBid > 0 && book.bestAsk < Infinity) {
        this.ticker.spotPrice = +((book.bestBid + book.bestAsk) / 2).toFixed(2);
      }
    }
  }

  private handleTickerMessage(
    book: OkxBookState,
    d: {
      last?: string;
      open24h?: string;
      high24h?: string;
      low24h?: string;
      vol24h?: string;
      volCcy24h?: string;
    }
  ) {
    const last = parseFloat(d.last || '0');
    const open = parseFloat(d.open24h || '0');
    const high = parseFloat(d.high24h || '0');
    const low = parseFloat(d.low24h || '0');
    const volBtc = book.isPerp ? parseFloat(d.volCcy24h || '0') : parseFloat(d.vol24h || '0');

    if (last > 0) book.lastPrice = last;
    if (open > 0) book.open24h = open;
    if (high > 0) book.high24h = high;
    if (low > 0) book.low24h = low;
    if (volBtc > 0) book.volBtc24h = volBtc;

    const primary = this.books['BTC-USDT-SWAP'];
    const pLast = primary.lastPrice || last;
    if (pLast > 0) this.ticker.lastPrice = +pLast.toFixed(2);
    if (this.books['BTC-USDT'].lastPrice > 0) {
      this.ticker.spotPrice = +this.books['BTC-USDT'].lastPrice.toFixed(2);
    }
    if (primary.lastPrice > 0 && primary.open24h > 0) {
      this.ticker.price24hPcnt = +(
        ((primary.lastPrice - primary.open24h) / primary.open24h) *
        100
      ).toFixed(2);
    }

    const allBooks = Object.values(this.books);
    this.ticker.highPrice24h = Math.max(...allBooks.map((b) => b.high24h));
    const lows = allBooks.map((b) => b.low24h).filter((v) => v > 0);
    this.ticker.lowPrice24h = lows.length > 0 ? Math.min(...lows) : 0;
    const totalVol = allBooks.reduce((s, b) => s + b.volBtc24h, 0);
    this.ticker.volume24h = +totalVol.toFixed(2);
    if (pLast > 0) this.ticker.turnover24h = Math.round(totalVol * pLast);
  }

  private handleTradesMessage(
    book: OkxBookState,
    rows: { tradeId?: string; px?: string; sz?: string; side?: string; ts?: string }[]
  ) {
    const emitted: TradeEvent[] = [];
    for (const r of rows) {
      const p = parseFloat(r.px || '0');
      const rawSz = parseFloat(r.sz || '0');
      const v = convertOkxSizeToBtc(book, rawSz, p);
      if (p <= 0 || v <= 0) continue;

      const id = `okx-${book.instId}-${r.tradeId || `${r.ts}-${p}`}`;
      if (this.seenTradeIds.has(id)) continue;
      this.seenTradeIds.add(id);
      if (this.seenTradeIds.size > 3000) {
        const firstKey = this.seenTradeIds.values().next().value;
        if (firstKey) this.seenTradeIds.delete(firstKey);
      }

      const side: 'Buy' | 'Sell' = r.side === 'buy' ? 'Buy' : 'Sell';
      const ts = parseInt(r.ts || '0', 10) || Date.now();
      const trade: TradeEvent = {
        id,
        t: ts,
        p,
        v,
        s: side,
        exchange: 'OKX',
        market: book.isPerp ? 'PERP' : 'SPOT',
      };

      if (book.isPerp) {
        if (side === 'Buy') this.windowBuyVol += v;
        else this.windowSellVol += v;
        if (book.instId === 'BTC-USDT-SWAP') {
          this.ticker.lastPrice = p;
          this.updateWindowPrice(p);
        }
        appendTradeBuffers(this.recentTrades, this.whaleTrades, trade);
        this.pendingTrades.push(trade);
      } else {
        if (side === 'Buy') this.windowSpotBuyVol += v;
        else this.windowSpotSellVol += v;
        if (book.instId === 'BTC-USDT') this.ticker.spotPrice = p;
        if (v >= WHALE_TRADE_MIN_BTC) {
          appendTradeBuffers(this.recentTrades, this.whaleTrades, trade);
          this.pendingTrades.push(trade);
        }
      }
      emitted.push(trade);
    }

    if (emitted.length > 0) {
      this.onTradesCallback?.(emitted);
    }
  }

  private handleLiquidationsMessage(
    items: {
      instId?: string;
      details?: { side?: string; bkPx?: string; sz?: string; ts?: string }[];
    }[]
  ) {
    const emitted: LiquidationEvent[] = [];
    for (const item of items) {
      if (item.instId !== 'BTC-USDT-SWAP' && item.instId !== 'BTC-USD-SWAP') continue;
      const book = this.books[item.instId];
      for (const det of item.details || []) {
        const p = parseFloat(det.bkPx || '0');
        const rawSz = parseFloat(det.sz || '0');
        const v = convertOkxSizeToBtc(book, rawSz, p);
        if (p <= 0 || v <= 0) continue;

        const ts = parseInt(det.ts || '0', 10) || Date.now();
        const id = `okx-liq-${item.instId}-${ts}-${p}-${rawSz}`;
        if (this.seenTradeIds.has(id)) continue;
        this.seenTradeIds.add(id);

        const liq: LiquidationEvent = {
          id,
          t: ts,
          p,
          v: +v.toFixed(4),
          usd: Math.round(v * p),
          side: det.side === 'buy' ? 'Short' : 'Long',
          exchange: 'OKX',
        };
        appendLiquidationBuffer(this.recentLiquidations, liq);
        this.pendingLiquidations.push(liq);
        emitted.push(liq);
      }
    }
    if (emitted.length > 0) {
      this.onLiquidationsCallback?.(emitted);
    }
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
    const primary = this.books['BTC-USDT-SWAP'];
    const bestBid = primary.bestBid;
    const bestAsk = primary.bestAsk;

    if (bestBid > 0 && bestAsk < Infinity && bestAsk >= bestBid) {
      this.ticker.bestBid = bestBid;
      this.ticker.bestAsk = bestAsk;
      this.ticker.spread = +(bestAsk - bestBid).toFixed(2);
      const mid = (bestBid + bestAsk) / 2;
      if (this.ticker.lastPrice === 0) this.ticker.lastPrice = +mid.toFixed(2);
      this.updateWindowPrice(mid);
      if (notifyPulse) this.onPricePulseCallback?.();
    }
  }

  private getPrimaryMid(): number {
    if (this.ticker.bestBid > 0 && this.ticker.bestAsk > 0) {
      return (this.ticker.bestBid + this.ticker.bestAsk) / 2;
    }
    return this.ticker.lastPrice || this.books['BTC-USDT-SWAP'].lastPrice || 0;
  }

  private summarizeBooks(list: OkxBookState[], mid: number) {
    let bidBtc = 0;
    let askBtc = 0;
    let bidLevels = 0;
    let askLevels = 0;
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let connected = false;

    for (const book of list) {
      if (book.connected) connected = true;
      for (const [p, s] of book.bids.entries()) {
        if (mid > 0 && p >= mid) continue;
        bidBtc += s;
        bidLevels++;
        if (p < minPrice) minPrice = p;
      }
      for (const [p, s] of book.asks.entries()) {
        if (mid > 0 && p < mid) continue;
        askBtc += s;
        askLevels++;
        if (p > maxPrice) maxPrice = p;
      }
    }

    return {
      bidBtc: +bidBtc.toFixed(2),
      askBtc: +askBtc.toFixed(2),
      bidLevels,
      askLevels,
      minPrice: minPrice < Infinity ? +minPrice.toFixed(2) : 0,
      maxPrice: maxPrice > -Infinity ? +maxPrice.toFixed(2) : 0,
      connected,
    };
  }

  private recomputeAggregateBounds() {
    const mid = this.getPrimaryMid();
    const usdtStat = this.summarizeBooks([this.books['BTC-USDT-SWAP']], mid);
    const usdStat = this.summarizeBooks([this.books['BTC-USD-SWAP']], mid);
    const spotStat = this.summarizeBooks([this.books['BTC-USDT'], this.books['BTC-USDC']], mid);

    const totalBidBtc = +(usdtStat.bidBtc + usdStat.bidBtc + spotStat.bidBtc).toFixed(2);
    const totalAskBtc = +(usdtStat.askBtc + usdStat.askBtc + spotStat.askBtc).toFixed(2);
    const tot = totalBidBtc + totalAskBtc;

    this.ticker.totalBidBtc = totalBidBtc;
    this.ticker.totalAskBtc = totalAskBtc;
    this.ticker.imbalancePct =
      tot > 0 ? +(((totalBidBtc - totalAskBtc) / tot) * 100).toFixed(1) : 0;
    this.ticker.activeBidLevels = usdtStat.bidLevels + usdStat.bidLevels + spotStat.bidLevels;
    this.ticker.activeAskLevels = usdtStat.askLevels + usdStat.askLevels + spotStat.askLevels;

    const mins = [usdtStat.minPrice, usdStat.minPrice, spotStat.minPrice].filter((v) => v > 0);
    const maxs = [usdtStat.maxPrice, usdStat.maxPrice, spotStat.maxPrice].filter((v) => v > 0);
    this.ticker.minBookPrice = mins.length > 0 ? Math.min(...mins) : 0;
    this.ticker.maxBookPrice = maxs.length > 0 ? Math.max(...maxs) : 0;
    this.ticker.connected = usdtStat.connected || usdStat.connected || spotStat.connected;

    const cov: MarketCoverageItem[] = [
      {
        id: 'USDT',
        label: 'USDT-SWAP',
        badgeClass: 'tag-lin',
        bidBtc: usdtStat.bidBtc,
        askBtc: usdtStat.askBtc,
        bidLevels: usdtStat.bidLevels,
        askLevels: usdtStat.askLevels,
        minPrice: usdtStat.minPrice,
        maxPrice: usdtStat.maxPrice,
        connected: usdtStat.connected,
      },
      {
        id: 'USD',
        label: 'USD-SWAP',
        badgeClass: 'tag-inv',
        bidBtc: usdStat.bidBtc,
        askBtc: usdStat.askBtc,
        bidLevels: usdStat.bidLevels,
        askLevels: usdStat.askLevels,
        minPrice: usdStat.minPrice,
        maxPrice: usdStat.maxPrice,
        connected: usdStat.connected,
      },
      {
        id: 'SPOT',
        label: 'SPOT (2)',
        badgeClass: 'tag-spot',
        bidBtc: spotStat.bidBtc,
        askBtc: spotStat.askBtc,
        bidLevels: spotStat.bidLevels,
        askLevels: spotStat.askLevels,
        minPrice: spotStat.minPrice,
        maxPrice: spotStat.maxPrice,
        connected: spotStat.connected,
      },
    ];
    this.ticker.coverageItems = cov;
  }

  public getAggregatedBook(
    scope: OkxBookScope,
    priceStep: PriceStep,
    includeClusters = true
  ): AggregatedClusterResult {
    const mid = this.getPrimaryMid();
    const venueOrder = ['USDT', 'USD', 'SPOT'];

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
    scope: OkxBookScope,
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

    const selected: OkxBookState[] = [];
    if (scope === 'all' || scope === 'usdt_swap') selected.push(this.books['BTC-USDT-SWAP']);
    if (scope === 'all' || scope === 'usd_swap') selected.push(this.books['BTC-USD-SWAP']);
    if (scope === 'all' || scope === 'spot') {
      selected.push(this.books['BTC-USDT'], this.books['BTC-USDC']);
    }

    let totalBidBtc = 0;
    let totalAskBtc = 0;
    let activeBidLevels = 0;
    let activeAskLevels = 0;
    let minBookPrice = Infinity;
    let maxBookPrice = -Infinity;

    for (const book of selected) {
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
      ? buildClusterMetrics(bids, asks, bidBreakdowns, askBreakdowns, mid, ['USDT', 'USD', 'SPOT'])
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

  public async getKlines(timeframe: TimeframeId): Promise<RawKline[]> {
    const cfg = TIMEFRAME_CONFIG[timeframe];
    if (!cfg || !cfg.okxBar) return [];

    const cached = this.klineCache.get(timeframe);
    const cacheTtl = cfg.ms >= 60 * 60 * 1000 ? 60_000 : 15_000;
    if (cached && Date.now() - cached.fetchedAt < cacheTtl && cached.candles.length > 0) {
      return cached.candles;
    }

    try {
      const url = `${OKX_REST_BASE}/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=${encodeURIComponent(cfg.okxBar)}&limit=300`;
      const res = await fetch(url);
      if (!res.ok) return cached?.candles || [];
      const json = (await res.json()) as { data?: string[][] };
      const rows = json.data || [];
      const candles: RawKline[] = [];
      for (const r of rows) {
        if (!Array.isArray(r) || r.length < 7) continue;
        // OKX format: [ts, o, h, l, c, volContracts, volCcyBtc, ...]
        candles.push({
          t: parseInt(r[0], 10),
          o: parseFloat(r[1]),
          h: parseFloat(r[2]),
          l: parseFloat(r[3]),
          c: parseFloat(r[4]),
          vol: parseFloat(r[6]),
        });
      }
      candles.sort((a, b) => a.t - b.t);
      if (candles.length > 0) {
        this.klineCache.set(timeframe, { fetchedAt: Date.now(), candles });
      }
      return candles;
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

  public getRecentLiquidations(limit = MAX_LIQUIDATIONS): LiquidationEvent[] {
    return this.recentLiquidations.slice(0, limit);
  }

  public getVolumeBreakdown(): {
    spotBtc: number;
    spotUsd: number;
    derivBtc: number;
    derivUsd: number;
  } {
    let spotBtc = 0;
    let spotUsd = 0;
    let derivBtc = 0;
    let derivUsd = 0;
    const fallbackPx = this.ticker.lastPrice || this.books['BTC-USDT-SWAP'].lastPrice || 0;
    for (const b of Object.values(this.books)) {
      const px = b.lastPrice || fallbackPx;
      if (b.isPerp) {
        derivBtc += b.volBtc24h;
        derivUsd += b.volBtc24h * px;
      } else {
        spotBtc += b.volBtc24h;
        spotUsd += b.volBtc24h * px;
      }
    }
    return {
      spotBtc: +spotBtc.toFixed(2),
      spotUsd: Math.round(spotUsd),
      derivBtc: +derivBtc.toFixed(2),
      derivUsd: Math.round(derivUsd),
    };
  }

  public async getAggregatedHistory(
    priceStep: PriceStep,
    bookScope: OkxBookScope,
    timeframe: TimeframeId,
    maxColumns = 1200
  ): Promise<InitialHistoryResponse> {
    const cfg = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG['15m'];
    const isKlineTimeframe = Boolean(cfg.okxBar);
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
        exchange: 'okx',
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
      exchange: 'okx',
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
