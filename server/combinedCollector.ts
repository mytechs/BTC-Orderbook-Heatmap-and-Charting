import fs from 'node:fs';
import path from 'node:path';
import type {
  AggregatedTradeBubble,
  CombinedBookScope,
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
import type { BinanceOrderbookCollector } from './binanceCollector.ts';
import type { BybitOrderbookCollector } from './bybitCollector.ts';
import type { CoinbaseOrderbookCollector } from './coinbaseCollector.ts';
import type { HyperliquidOrderbookCollector } from './hyperliquidCollector.ts';
import type { OkxOrderbookCollector } from './okxCollector.ts';
import {
  type AggregatedClusterResult,
  BASE_PRICE_STEP,
  LIVE_TICK_MS,
  MAX_LIQUIDATIONS,
  MAX_RECENT_TRADES,
  MAX_RING_SLICES,
  MAX_WHALE_TRADES,
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

export class CombinedOrderbookAggregator {
  private bybit: BybitOrderbookCollector;
  private binance: BinanceOrderbookCollector;
  private okx: OkxOrderbookCollector;
  private coinbase: CoinbaseOrderbookCollector;
  private hyperliquid: HyperliquidOrderbookCollector;

  private baseSlices: HeatmapSlice[] = [];
  private recentTrades: TradeEvent[] = [];
  private whaleTrades: TradeEvent[] = [];
  private recentLiquidations: LiquidationEvent[] = [];
  private seenTradeIds = new Set<string>();
  private baseAggCache = new Map<
    CombinedBookScope,
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

  public ticker: TickerStats = {
    exchange: 'combined',
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

  constructor(
    dataDir: string,
    bybit: BybitOrderbookCollector,
    binance: BinanceOrderbookCollector,
    okx: OkxOrderbookCollector,
    coinbase: CoinbaseOrderbookCollector,
    hyperliquid: HyperliquidOrderbookCollector
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.bybit = bybit;
    this.binance = binance;
    this.okx = okx;
    this.coinbase = coinbase;
    this.hyperliquid = hyperliquid;
    this.checkpointPath = path.join(dataDir, 'combined-checkpoint.json');
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

  public syncWindowFromBooks() {
    const mid = this.getCombinedAnchorMid();
    if (mid > 0) this.updateWindowPrice(mid);
  }

  public ingestTrades(trades: TradeEvent[]) {
    for (const tr of trades) {
      if (this.seenTradeIds.has(tr.id)) continue;
      this.seenTradeIds.add(tr.id);
      if (this.seenTradeIds.size > 3000) {
        const firstKey = this.seenTradeIds.values().next().value;
        if (firstKey) this.seenTradeIds.delete(firstKey);
      }

      if (tr.market === 'SPOT') {
        if (tr.s === 'Buy') this.windowSpotBuyVol += tr.v;
        else this.windowSpotSellVol += tr.v;
        if (tr.v >= WHALE_TRADE_MIN_BTC || (tr.exchange === 'CB' && tr.v >= 0.05)) {
          this.pendingTrades.push(tr);
          if (tr.exchange === 'CB') {
            this.recentTrades.unshift(tr);
            if (this.recentTrades.length > MAX_RECENT_TRADES) {
              this.recentTrades.length = MAX_RECENT_TRADES;
            }
          }
          appendTradeBuffers(this.recentTrades, this.whaleTrades, tr);
        }
      } else {
        if (tr.s === 'Buy') this.windowBuyVol += tr.v;
        else this.windowSellVol += tr.v;
        this.pendingTrades.push(tr);
        appendTradeBuffers(this.recentTrades, this.whaleTrades, tr);
      }
    }
    const mid = this.getCombinedAnchorMid();
    if (mid > 0) {
      this.updateWindowPrice(mid);
    } else if (trades.length > 0) {
      this.updateWindowPrice(trades[trades.length - 1].p);
    }
  }

  public ingestLiquidations(liqs: LiquidationEvent[]) {
    for (const liq of liqs) {
      if (this.seenTradeIds.has(liq.id)) continue;
      this.seenTradeIds.add(liq.id);
      appendLiquidationBuffer(this.recentLiquidations, liq);
      this.pendingLiquidations.push(liq);
    }
  }

  public setHasClientsFn(fn: () => boolean) {
    this.hasClientsFn = fn;
  }

  public start() {
    // Seed initial recent & whale trades from all five exchanges after startup
    setTimeout(() => {
      const mergedRecent = [
        ...this.recentTrades,
        ...this.bybit.getRecentTrades(60),
        ...this.binance.getRecentTrades(60),
        ...this.okx.getRecentTrades(60),
        ...this.coinbase.getRecentTrades(40).filter((t) => t.v >= 0.05),
        ...this.hyperliquid.getRecentTrades(60),
      ];
      const uniqueRecent = new Map<string, TradeEvent>();
      for (const tr of mergedRecent) {
        this.seenTradeIds.add(tr.id);
        if (!uniqueRecent.has(tr.id)) uniqueRecent.set(tr.id, tr);
      }
      this.recentTrades = Array.from(uniqueRecent.values())
        .sort((a, b) => b.t - a.t)
        .slice(0, MAX_RECENT_TRADES);

      const mergedWhales = [
        ...this.whaleTrades,
        ...this.bybit.getWhaleTrades(80),
        ...this.binance.getWhaleTrades(80),
        ...this.okx.getWhaleTrades(80),
        ...this.coinbase.getWhaleTrades(80),
        ...this.hyperliquid.getWhaleTrades(80),
      ];
      const uniqueWhales = new Map<string, TradeEvent>();
      for (const tr of mergedWhales) {
        if (!uniqueWhales.has(tr.id)) uniqueWhales.set(tr.id, tr);
      }
      this.whaleTrades = Array.from(uniqueWhales.values())
        .sort((a, b) => b.t - a.t)
        .slice(0, MAX_WHALE_TRADES);

      const mergedLiqs = [
        ...this.recentLiquidations,
        ...this.bybit.getRecentLiquidations(60),
        ...this.binance.getRecentLiquidations(60),
        ...this.okx.getRecentLiquidations(60),
        ...this.hyperliquid.getRecentLiquidations(60),
      ];
      const uniqueLiqs = new Map<string, LiquidationEvent>();
      for (const lq of mergedLiqs) {
        if (!uniqueLiqs.has(lq.id)) uniqueLiqs.set(lq.id, lq);
      }
      this.recentLiquidations = Array.from(uniqueLiqs.values())
        .sort((a, b) => b.t - a.t)
        .slice(0, MAX_LIQUIDATIONS);
    }, 2500);

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
    }, 89_000);
  }

  public stop() {
    if (this.sliceTimer) clearInterval(this.sliceTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    saveCollectorCheckpoint(
      this.checkpointPath,
      this.baseSlices,
      this.recentTrades,
      this.ticker,
      this.whaleTrades,
      this.recentLiquidations
    );
  }

  private getCombinedAnchorMid(): number {
    const tickers = [
      this.bybit.ticker,
      this.binance.ticker,
      this.okx.ticker,
      this.coinbase.ticker,
      this.hyperliquid.ticker,
    ];
    let sum = 0;
    let count = 0;
    for (const tk of tickers) {
      const m = tk.bestBid > 0 && tk.bestAsk > 0 ? (tk.bestBid + tk.bestAsk) / 2 : tk.lastPrice;
      if (m > 0) {
        sum += m;
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  public refreshTickerStats(aggAll?: AggregatedClusterResult, updateWindow = true) {
    const bt = this.bybit.ticker;
    const nt = this.binance.ticker;
    const ot = this.okx.ticker;
    const ct = this.coinbase.ticker;
    const ht = this.hyperliquid.ticker;

    const avgPos = (...vals: number[]) => {
      let sum = 0;
      let count = 0;
      for (const v of vals) {
        if (v > 0) {
          sum += v;
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    };
    const avgActive = (pairs: [number, boolean][]) => {
      let sum = 0;
      let count = 0;
      for (const [v, active] of pairs) {
        if (active) {
          sum += v;
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    };
    const mid = this.getCombinedAnchorMid();

    this.ticker.lastPrice = +avgPos(
      bt.lastPrice,
      nt.lastPrice,
      ot.lastPrice,
      ct.lastPrice,
      ht.lastPrice
    ).toFixed(2);
    const spotAvg = avgPos(
      bt.spotPrice || 0,
      nt.spotPrice || 0,
      ot.spotPrice || 0,
      ct.spotPrice || ct.lastPrice || 0,
      ht.spotPrice || 0
    );
    if (spotAvg > 0) this.ticker.spotPrice = +spotAvg.toFixed(2);
    this.ticker.markPrice = +avgPos(bt.markPrice, nt.markPrice, ot.markPrice, ht.markPrice).toFixed(
      2
    );
    this.ticker.indexPrice = +avgPos(
      bt.indexPrice,
      nt.indexPrice,
      ot.indexPrice,
      ct.indexPrice,
      ht.indexPrice
    ).toFixed(2);
    this.ticker.price24hPcnt = +avgActive([
      [bt.price24hPcnt, bt.lastPrice > 0],
      [nt.price24hPcnt, nt.lastPrice > 0],
      [ot.price24hPcnt, ot.lastPrice > 0],
      [ct.price24hPcnt, ct.lastPrice > 0],
      [ht.price24hPcnt, ht.lastPrice > 0],
    ]).toFixed(2);
    this.ticker.highPrice24h = Math.max(
      bt.highPrice24h || 0,
      nt.highPrice24h || 0,
      ot.highPrice24h || 0,
      ct.highPrice24h || 0,
      ht.highPrice24h || 0
    );
    const lows = [
      bt.lowPrice24h,
      nt.lowPrice24h,
      ot.lowPrice24h,
      ct.lowPrice24h,
      ht.lowPrice24h,
    ].filter((v) => v > 0);
    this.ticker.lowPrice24h = lows.length > 0 ? Math.min(...lows) : 0;
    this.ticker.volume24h = +(
      bt.volume24h +
      nt.volume24h +
      ot.volume24h +
      ct.volume24h +
      ht.volume24h
    ).toFixed(2);
    this.ticker.turnover24h = Math.round(
      bt.turnover24h + nt.turnover24h + ot.turnover24h + ct.turnover24h + ht.turnover24h
    );
    this.ticker.openInterestValue = Math.round(
      bt.openInterestValue + nt.openInterestValue + ot.openInterestValue + ht.openInterestValue
    );
    this.ticker.fundingRate = +avgActive([
      [bt.fundingRate, bt.lastPrice > 0],
      [nt.fundingRate, nt.lastPrice > 0],
      [ot.fundingRate, ot.lastPrice > 0],
      [ht.fundingRate, ht.lastPrice > 0],
    ]).toFixed(4);
    this.ticker.connected =
      bt.connected || nt.connected || ot.connected || ct.connected || ht.connected;
    this.ticker.updateCount =
      bt.updateCount + nt.updateCount + ot.updateCount + ct.updateCount + ht.updateCount;

    const agg = aggAll || this.getAggregatedBook('all', 1, false);
    this.ticker.totalBidBtc = agg.totalBidBtc;
    this.ticker.totalAskBtc = agg.totalAskBtc;
    const tot = agg.totalBidBtc + agg.totalAskBtc;
    this.ticker.imbalancePct =
      tot > 0 ? +(((agg.totalBidBtc - agg.totalAskBtc) / tot) * 100).toFixed(1) : 0;
    this.ticker.activeBidLevels = agg.activeBidLevels;
    this.ticker.activeAskLevels = agg.activeAskLevels;
    this.ticker.minBookPrice = agg.minBookPrice;
    this.ticker.maxBookPrice = agg.maxBookPrice;

    if (agg.bids.length > 0 && agg.asks.length > 0) {
      this.ticker.bestBid = agg.bids[0][0];
      this.ticker.bestAsk = agg.asks[0][0];
      this.ticker.spread = Math.max(
        0,
        +(this.ticker.bestAsk - this.ticker.bestBid).toFixed(2)
      );
    } else if (mid > 0) {
      this.ticker.bestBid = +(mid - 0.1).toFixed(2);
      this.ticker.bestAsk = +(mid + 0.1).toFixed(2);
      this.ticker.spread = 0.2;
    }

    const bybSpotCov = bt.coverageItems.find((c) => c.id === 'SPOT');
    const bnSpotCov = nt.coverageItems.find((c) => c.id === 'SPOT');
    const okxSpotCov = ot.coverageItems.find((c) => c.id === 'SPOT');
    const hlSpotCov = ht.coverageItems.find((c) => c.id === 'SPOT');

    const cov: MarketCoverageItem[] = [
      {
        id: 'BYB',
        label: 'BYBIT (4)',
        badgeClass: 'tag-lin',
        bidBtc: bt.totalBidBtc,
        askBtc: bt.totalAskBtc,
        bidLevels: bt.activeBidLevels,
        askLevels: bt.activeAskLevels,
        minPrice: bt.minBookPrice,
        maxPrice: bt.maxBookPrice,
        connected: bt.connected,
      },
      {
        id: 'BN',
        label: 'BINANCE (12)',
        badgeClass: 'tag-inv',
        bidBtc: nt.totalBidBtc,
        askBtc: nt.totalAskBtc,
        bidLevels: nt.activeBidLevels,
        askLevels: nt.activeAskLevels,
        minPrice: nt.minBookPrice,
        maxPrice: nt.maxBookPrice,
        connected: nt.connected,
      },
      {
        id: 'OKX',
        label: 'OKX (4)',
        badgeClass: 'tag-okx',
        bidBtc: ot.totalBidBtc,
        askBtc: ot.totalAskBtc,
        bidLevels: ot.activeBidLevels,
        askLevels: ot.activeAskLevels,
        minPrice: ot.minBookPrice,
        maxPrice: ot.maxBookPrice,
        connected: ot.connected,
      },
      {
        id: 'CB',
        label: 'COINBASE (2)',
        badgeClass: 'tag-cb',
        bidBtc: ct.totalBidBtc,
        askBtc: ct.totalAskBtc,
        bidLevels: ct.activeBidLevels,
        askLevels: ct.activeAskLevels,
        minPrice: ct.minBookPrice,
        maxPrice: ct.maxBookPrice,
        connected: ct.connected,
      },
      {
        id: 'HL',
        label: 'HL (2)',
        badgeClass: 'tag-hl',
        bidBtc: ht.totalBidBtc,
        askBtc: ht.totalAskBtc,
        bidLevels: ht.activeBidLevels,
        askLevels: ht.activeAskLevels,
        minPrice: ht.minBookPrice,
        maxPrice: ht.maxBookPrice,
        connected: ht.connected,
      },
      {
        id: 'SPOT',
        label: 'ALL SPOT',
        badgeClass: 'tag-spot',
        bidBtc: +(
          (bybSpotCov?.bidBtc || 0) +
          (bnSpotCov?.bidBtc || 0) +
          (okxSpotCov?.bidBtc || 0) +
          ct.totalBidBtc +
          (hlSpotCov?.bidBtc || 0)
        ).toFixed(2),
        askBtc: +(
          (bybSpotCov?.askBtc || 0) +
          (bnSpotCov?.askBtc || 0) +
          (okxSpotCov?.askBtc || 0) +
          ct.totalAskBtc +
          (hlSpotCov?.askBtc || 0)
        ).toFixed(2),
        bidLevels:
          (bybSpotCov?.bidLevels || 0) +
          (bnSpotCov?.bidLevels || 0) +
          (okxSpotCov?.bidLevels || 0) +
          ct.activeBidLevels +
          (hlSpotCov?.bidLevels || 0),
        askLevels:
          (bybSpotCov?.askLevels || 0) +
          (bnSpotCov?.askLevels || 0) +
          (okxSpotCov?.askLevels || 0) +
          ct.activeAskLevels +
          (hlSpotCov?.askLevels || 0),
        minPrice: 0,
        maxPrice: 0,
        connected: bt.connected || nt.connected || ot.connected || ct.connected || ht.connected,
      },
    ];
    this.ticker.coverageItems = cov;

    if (updateWindow && mid > 0) {
      this.updateWindowPrice(mid);
    }
  }

  public getAggregatedBook(
    scope: CombinedBookScope,
    priceStep: PriceStep,
    includeClusters = true
  ): AggregatedClusterResult {
    const mid = this.getCombinedAnchorMid();
    const venueOrder = ['BYB-P', 'BYB-S', 'BN-P', 'BN-S', 'OKX-P', 'OKX-S', 'HL-P', 'HL-S', 'CB-S'];

    if (priceStep >= 1) {
      const now = Date.now();
      const combinedUpdateCount =
        this.bybit.ticker.updateCount +
        this.binance.ticker.updateCount +
        this.okx.ticker.updateCount +
        this.coinbase.ticker.updateCount +
        this.hyperliquid.ticker.updateCount;
      const cached = this.baseAggCache.get(scope);
      if (
        cached &&
        cached.result.bids.length > 0 &&
        cached.result.asks.length > 0 &&
        (cached.updateCount === combinedUpdateCount || now - cached.computedAt < 180)
      ) {
        return reBucketAggregatedResult(cached.result, priceStep, includeClusters, mid, venueOrder);
      }
      const baseRes = this.computeRawAggregatedBook(scope, BASE_PRICE_STEP, false);
      this.baseAggCache.set(scope, {
        updateCount: combinedUpdateCount,
        computedAt: now,
        result: baseRes,
      });
      return reBucketAggregatedResult(baseRes, priceStep, includeClusters, mid, venueOrder);
    }

    return this.computeRawAggregatedBook(scope, priceStep, includeClusters);
  }

  private computeRawAggregatedBook(
    scope: CombinedBookScope,
    priceStep: PriceStep,
    includeClusters: boolean
  ): AggregatedClusterResult {
    const includeBybit = scope === 'all' || scope === 'perps' || scope === 'spot' || scope === 'bybit';
    const includeBinance = scope === 'all' || scope === 'perps' || scope === 'spot' || scope === 'binance';
    const includeOkx = scope === 'all' || scope === 'perps' || scope === 'spot' || scope === 'okx';
    const includeCoinbase = scope === 'all' || scope === 'spot' || scope === 'coinbase';
    const includeHl = scope === 'all' || scope === 'perps' || scope === 'spot' || scope === 'hyperliquid';

    const bybBooks = includeBybit
      ? scope === 'spot'
        ? [this.bybit.getAggregatedBook('spot', priceStep, false)]
        : scope === 'perps'
          ? [
              this.bybit.getAggregatedBook('linear', priceStep, false),
              this.bybit.getAggregatedBook('inverse', priceStep, false),
              this.bybit.getAggregatedBook('usdc', priceStep, false),
            ]
          : [this.bybit.getAggregatedBook('all', priceStep, false)]
      : [];

    const bnBooks = includeBinance
      ? scope === 'spot'
        ? [this.binance.getAggregatedBook('spot', priceStep, false)]
        : scope === 'perps'
          ? [
              this.binance.getAggregatedBook('usdm', priceStep, false),
              this.binance.getAggregatedBook('coinm', priceStep, false),
            ]
          : [this.binance.getAggregatedBook('all', priceStep, false)]
      : [];

    const okxBooks = includeOkx
      ? scope === 'spot'
        ? [this.okx.getAggregatedBook('spot', priceStep, false)]
        : scope === 'perps'
          ? [
              this.okx.getAggregatedBook('usdt_swap', priceStep, false),
              this.okx.getAggregatedBook('usd_swap', priceStep, false),
            ]
          : [this.okx.getAggregatedBook('all', priceStep, false)]
      : [];

    const cbBooks = includeCoinbase
      ? [this.coinbase.getAggregatedBook('all', priceStep, false)]
      : [];

    const hlBooks = includeHl
      ? [
          this.hyperliquid.getAggregatedBook(
            scope === 'spot' ? 'spot' : scope === 'perps' ? 'perp' : 'all',
            priceStep,
            false
          ),
        ]
      : [];

    const bidBreakdowns = new Map<number, VenueBreakdown>();
    const askBreakdowns = new Map<number, VenueBreakdown>();
    const mid = this.getCombinedAnchorMid();

    let totalBidBtc = 0;
    let totalAskBtc = 0;
    let activeBidLevels = 0;
    let activeAskLevels = 0;
    let minBookPrice = Infinity;
    let maxBookPrice = -Infinity;

    const addBucket = (
      target: Map<number, VenueBreakdown>,
      price: number,
      venueKey: string,
      size: number
    ) => {
      if (size <= 0) return;
      let bd = target.get(price);
      if (!bd) {
        bd = {};
        target.set(price, bd);
      }
      bd[venueKey] = (bd[venueKey] || 0) + size;
    };

    const mergeBybBreakdown = (
      target: Map<number, VenueBreakdown>,
      price: number,
      srcBd: VenueBreakdown
    ): number => {
      let added = 0;
      const perpAmt = (srcBd.LIN || 0) + (srcBd.RPI || 0) + (srcBd.INV || 0) + (srcBd.USDC || 0);
      const spotAmt = (srcBd.SPOT || 0);
      if (perpAmt > 0) {
        addBucket(target, price, 'BYB-P', perpAmt);
        added += perpAmt;
      }
      if (spotAmt > 0) {
        addBucket(target, price, 'BYB-S', spotAmt);
        added += spotAmt;
      }
      return added;
    };

    const mergeBnBreakdown = (
      target: Map<number, VenueBreakdown>,
      price: number,
      srcBd: VenueBreakdown
    ): number => {
      let added = 0;
      const perpAmt = (srcBd.USDM || 0) + (srcBd.COINM || 0);
      const spotAmt = srcBd.SPOT || 0;
      if (perpAmt > 0) {
        addBucket(target, price, 'BN-P', perpAmt);
        added += perpAmt;
      }
      if (spotAmt > 0) {
        addBucket(target, price, 'BN-S', spotAmt);
        added += spotAmt;
      }
      return added;
    };

    const mergeOkxBreakdown = (
      target: Map<number, VenueBreakdown>,
      price: number,
      srcBd: VenueBreakdown
    ): number => {
      let added = 0;
      const perpAmt = (srcBd.USDT || 0) + (srcBd.USD || 0);
      const spotAmt = srcBd.SPOT || 0;
      if (perpAmt > 0) {
        addBucket(target, price, 'OKX-P', perpAmt);
        added += perpAmt;
      }
      if (spotAmt > 0) {
        addBucket(target, price, 'OKX-S', spotAmt);
        added += spotAmt;
      }
      return added;
    };

    const mergeCbBreakdown = (
      target: Map<number, VenueBreakdown>,
      price: number,
      srcBd: VenueBreakdown
    ): number => {
      const spotAmt = (srcBd.USD || 0) + (srcBd.USDT || 0);
      if (spotAmt > 0) {
        addBucket(target, price, 'CB-S', spotAmt);
      }
      return spotAmt;
    };

    const mergeHlBreakdown = (
      target: Map<number, VenueBreakdown>,
      price: number,
      srcBd: VenueBreakdown
    ): number => {
      let added = 0;
      const perpAmt = srcBd.HLP || 0;
      const spotAmt = srcBd.HLS || 0;
      if (perpAmt > 0) {
        addBucket(target, price, 'HL-P', perpAmt);
        added += perpAmt;
      }
      if (spotAmt > 0) {
        addBucket(target, price, 'HL-S', spotAmt);
        added += spotAmt;
      }
      return added;
    };

    const mergeBookList = (
      list: AggregatedClusterResult[],
      mergeFn: (target: Map<number, VenueBreakdown>, price: number, srcBd: VenueBreakdown) => number
    ) => {
      for (const res of list) {
        activeBidLevels += res.activeBidLevels;
        activeAskLevels += res.activeAskLevels;
        if (res.minBookPrice > 0 && res.minBookPrice < minBookPrice) minBookPrice = res.minBookPrice;
        if (res.maxBookPrice > 0 && res.maxBookPrice > maxBookPrice) maxBookPrice = res.maxBookPrice;

        if (res.bidBreakdowns) {
          for (const [price, bd] of res.bidBreakdowns.entries()) {
            if (mid > 0 && price >= mid) continue;
            totalBidBtc += mergeFn(bidBreakdowns, price, bd);
          }
        }
        if (res.askBreakdowns) {
          for (const [price, bd] of res.askBreakdowns.entries()) {
            if (mid > 0 && price < mid) continue;
            totalAskBtc += mergeFn(askBreakdowns, price, bd);
          }
        }
      }
    };

    mergeBookList(bybBooks, mergeBybBreakdown);
    mergeBookList(bnBooks, mergeBnBreakdown);
    mergeBookList(okxBooks, mergeOkxBreakdown);
    mergeBookList(cbBooks, mergeCbBreakdown);
    mergeBookList(hlBooks, mergeHlBreakdown);

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
      ? buildClusterMetrics(bids, asks, bidBreakdowns, askBreakdowns, mid, [
          'BYB-P',
          'BYB-S',
          'BN-P',
          'BN-S',
          'OKX-P',
          'OKX-S',
          'HL-P',
          'HL-S',
          'CB-S',
        ])
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

    const mid = this.getCombinedAnchorMid();
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
      const aggAll = this.getAggregatedBook('all', BASE_PRICE_STEP, false);
      if (aggAll.bids.length === 0 || aggAll.asks.length === 0) return;
      this.refreshTickerStats(aggAll, false);
      compactBids = compactLevelsForHistory(aggAll.bids, mid);
      compactAsks = compactLevelsForHistory(aggAll.asks, mid);
    }

    const bb = this.ticker.bestBid || +(mid - 0.5).toFixed(2);
    const ba = this.ticker.bestAsk || +(mid + 0.5).toFixed(2);

    const slice: HeatmapSlice = {
      t: now,
      bb,
      ba,
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

  private async fetchMergedKlines(timeframe: TimeframeId): Promise<RawKline[]> {
    const klineSets = await Promise.all([
      this.bybit.getKlines(timeframe),
      this.binance.getKlines(timeframe),
      this.okx.getKlines(timeframe),
      this.coinbase.getKlines(timeframe),
      this.hyperliquid.getKlines(timeframe),
    ]);

    const maps = klineSets.map((list) => {
      const m = new Map<number, RawKline>();
      for (const k of list) m.set(k.t, k);
      return m;
    });

    const allTimestamps = new Set<number>();
    for (const m of maps) {
      for (const t of m.keys()) allTimestamps.add(t);
    }
    const sortedTs = Array.from(allTimestamps).sort((a, b) => a - b);

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
    return merged.slice(-400);
  }

  public async getAggregatedHistory(
    priceStep: PriceStep,
    bookScope: CombinedBookScope,
    timeframe: TimeframeId,
    maxColumns = 1200
  ): Promise<InitialHistoryResponse> {
    const cfg = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG['15m'];
    const isKlineTimeframe = Boolean(cfg.binanceInterval);
    const agg = this.getAggregatedBook(bookScope, priceStep, true);
    this.refreshTickerStats(bookScope === 'all' ? agg : undefined);

    if (isKlineTimeframe) {
      const klines = await this.fetchMergedKlines(timeframe);
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
        exchange: 'combined',
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
      exchange: 'combined',
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
