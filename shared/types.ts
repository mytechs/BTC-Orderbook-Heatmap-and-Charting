export type ExchangeId = 'bybit' | 'binance' | 'okx' | 'coinbase' | 'hyperliquid' | 'combined';

export type PriceStep = 0.5 | 1 | 2 | 5 | 10 | 25 | 50 | 100;

export type ClusterFilterBtc = 0 | 1 | 5 | 10 | 25 | 50 | 100 | 250 | 500;

export type BybitBookScope = 'all' | 'linear' | 'spot' | 'inverse' | 'usdc';
export type BinanceBookScope = 'all' | 'usdm' | 'coinm' | 'spot' | 'btcusdt_perp';
export type OkxBookScope = 'all' | 'usdt_swap' | 'usd_swap' | 'spot';
export type CoinbaseBookScope = 'all' | 'usd' | 'usdt';
export type HyperliquidBookScope = 'all' | 'perp' | 'spot';
export type CombinedBookScope =
  | 'all'
  | 'perps'
  | 'spot'
  | 'bybit'
  | 'binance'
  | 'okx'
  | 'coinbase'
  | 'hyperliquid';
export type BookScope =
  | BybitBookScope
  | BinanceBookScope
  | OkxBookScope
  | CoinbaseBookScope
  | HyperliquidBookScope
  | CombinedBookScope;

export type TimeframeId =
  | '100ms'
  | '250ms'
  | '500ms'
  | '1s'
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '6h'
  | '12h'
  | '1d'
  | '1w';

export type ColormapName = 'thermal' | 'viridis' | 'bidask';

export interface TradeEvent {
  id: string;
  t: number;
  p: number;
  v: number;
  s: 'Buy' | 'Sell';
  exchange?: 'BYB' | 'BN' | 'OKX' | 'CB' | 'HL';
  market?: 'PERP' | 'SPOT';
}

export interface LiquidationEvent {
  id: string;
  t: number;
  p: number;
  v: number; // BTC size
  usd: number; // Notional USD value
  side: 'Long' | 'Short'; // Long = forced Sell; Short = forced Buy
  exchange: 'BYB' | 'BN' | 'OKX' | 'CB' | 'HL';
}

export interface AggregatedTradeBubble {
  t: number;
  p: number;
  v: number;
  s: 'Buy' | 'Sell';
  count: number;
  maxSingle: number;
}

/**
 * A single time-slice column in the heatmap / candlestick chart.
 * bids and asks are arrays of [bucketFloorPrice, totalBtcVolume]
 */
export interface HeatmapSlice {
  t: number;
  bb: number;
  ba: number;
  mid: number;
  o: number;
  h: number;
  l: number;
  c: number;
  bv: number; // perp taker buy volume in BTC
  sv: number; // perp taker sell volume in BTC
  spotBv?: number; // spot taker buy volume in BTC
  spotSv?: number; // spot taker sell volume in BTC
  bids: [number, number][];
  asks: [number, number][];
  trades: AggregatedTradeBubble[];
  liquidations?: LiquidationEvent[];
}

export interface MarketCoverageItem {
  id: string;
  label: string;
  badgeClass: string;
  bidBtc: number;
  askBtc: number;
  bidLevels: number;
  askLevels: number;
  minPrice: number;
  maxPrice: number;
  extraNote?: string;
  connected: boolean;
}

export interface TickerStats {
  exchange: ExchangeId;
  symbol: string;
  lastPrice: number;
  spotPrice?: number;
  markPrice: number;
  indexPrice: number;
  price24hPcnt: number;
  highPrice24h: number;
  lowPrice24h: number;
  volume24h: number;
  turnover24h: number;
  openInterestValue: number;
  fundingRate: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  totalBidBtc: number;
  totalAskBtc: number;
  imbalancePct: number;
  activeBidLevels: number;
  activeAskLevels: number;
  minBookPrice: number;
  maxBookPrice: number;
  connected: boolean;
  updateCount: number;
  storedBaseSlices: number;
  coverageItems: MarketCoverageItem[];
}

export type VenueBreakdown = Record<string, number>;

export interface WallLevel {
  price: number;
  sizeBtc: number;
  distanceUsd: number;
  distancePct: number;
  side: 'Bid' | 'Ask';
  venues: string[];
  breakdown: VenueBreakdown;
}

export interface ClusterBucketSummary {
  label: string;
  minBtc: number;
  maxBtc: number | null;
  bidCount: number;
  bidBtc: number;
  askCount: number;
  askBtc: number;
}

export interface InitialHistoryResponse {
  exchange: ExchangeId;
  priceStep: PriceStep;
  bookScope: BookScope;
  timeframe: TimeframeId;
  timeframeMs: number;
  isKlineTimeframe: boolean;
  slices: HeatmapSlice[];
  currentBids: [number, number][];
  currentAsks: [number, number][];
  recentTrades: TradeEvent[];
  whaleTrades?: TradeEvent[];
  recentLiquidations?: LiquidationEvent[];
  bidClusters: WallLevel[];
  askClusters: WallLevel[];
  clusterSummary: ClusterBucketSummary[];
  ticker: TickerStats;
}

export interface WsServerMessage {
  type: 'tick';
  payload: {
    exchange: ExchangeId;
    slice: HeatmapSlice;
    currentBids?: [number, number][];
    currentAsks?: [number, number][];
    newTrades: TradeEvent[];
    newLiquidations?: LiquidationEvent[];
    bidClusters?: WallLevel[];
    askClusters?: WallLevel[];
    clusterSummary?: ClusterBucketSummary[];
    ticker: TickerStats;
    bookScope: BookScope;
    priceStep: PriceStep;
  };
}

export interface WsClientMessage {
  type: 'config';
  exchange?: ExchangeId;
  bookScope?: BookScope;
  priceStep?: PriceStep;
  mode?: 'heatmap' | 'chart';
}

export interface ExchangeVolumeShareItem {
  exchange: 'bybit' | 'binance' | 'okx' | 'coinbase' | 'hyperliquid';
  code: 'BYB' | 'BN' | 'OKX' | 'CB' | 'HL';
  label: string;
  spotBtc: number;
  spotUsd: number;
  derivBtc: number;
  derivUsd: number;
  totalBtc: number;
  totalUsd: number;
  spotPct: number;
  derivPct: number;
  totalPct: number;
  // Buy vs Sell volume breakdown (BTC & %)
  spotBuyBtc: number;
  spotSellBtc: number;
  spotBuyPct: number;
  spotSellPct: number;
  derivBuyBtc: number;
  derivSellBtc: number;
  derivBuyPct: number;
  derivSellPct: number;
  buyBtc: number;
  sellBtc: number;
  buyPct: number;
  sellPct: number;
  // Long vs Short positioning / flow (derivatives)
  longPct: number | null;
  shortPct: number | null;
  longShortRatio: number | null;
  lsSource?: 'accounts' | 'flow';
}

export interface VolumeDistributionResponse {
  updatedAt: number;
  totalSpotBtc: number;
  totalSpotUsd: number;
  totalDerivBtc: number;
  totalDerivUsd: number;
  totalBtc: number;
  totalUsd: number;
  spotSharePct: number;
  derivSharePct: number;
  // Aggregate Buy vs Sell splits
  totalBuyBtc: number;
  totalSellBtc: number;
  buySharePct: number;
  sellSharePct: number;
  spotBuyBtc: number;
  spotSellBtc: number;
  spotBuyPct: number;
  spotSellPct: number;
  derivBuyBtc: number;
  derivSellBtc: number;
  derivBuyPct: number;
  derivSellPct: number;
  // Volume-weighted Long vs Short across derivatives exchanges
  avgLongPct: number;
  avgShortPct: number;
  avgLongShortRatio: number;
  exchanges: ExchangeVolumeShareItem[];
}

export interface ExchangeFundingRateItem {
  exchange: 'bybit' | 'binance' | 'okx' | 'coinbase' | 'hyperliquid';
  code: 'BYB' | 'BN' | 'OKX' | 'CB' | 'HL';
  label: string;
  supported: boolean;
  intervalHours: number;
  fundingRatePct: number;
  normalized8hPct: number;
  annualizedAprPct: number;
  openInterestUsd: number;
  markPrice: number;
  indexPrice: number;
  basisBps: number;
  nextFundingTime: number;
}

export interface FundingRatesResponse {
  updatedAt: number;
  oiWeighted8hPct: number;
  oiWeightedAprPct: number;
  maxSpread8hPct: number;
  totalOpenInterestUsd: number;
  exchanges: ExchangeFundingRateItem[];
}

export interface ChartIndicatorFlags {
  ema9: boolean;
  ema21: boolean;
  ema50: boolean;
  ema200: boolean;
  sma20: boolean;
  ma50: boolean;
  ma100: boolean;
  ma200: boolean;
  vwap: boolean;
  bb: boolean;
  volume: boolean;
  rsi: boolean;
  macd: boolean;
}

export type MagnetMode = 'off' | 'weak' | 'strong' | 'extra';

export interface ChartViewportState {
  barWidth: number;
  rightOffsetBars: number;
  manualPriceRange?: { min: number; max: number } | null;
}

export interface ChartPageSettings {
  chartStyle: 'candles' | 'hollow' | 'heikin' | 'line' | 'area';
  scaleMode: 'normal' | 'log' | 'pct';
  autoScaleY: boolean;
  indicators: ChartIndicatorFlags;
  drawColor: string;
  drawWidth: number;
  drawDashed: boolean;
  magnetMode: MagnetMode | boolean;
  hideDrawings: boolean;
}

export interface UserWorkspaceState {
  activePage?: 'heatmap' | 'chart';
  exchange?: ExchangeId;
  bybitScope?: BybitBookScope;
  binanceScope?: BinanceBookScope;
  okxScope?: OkxBookScope;
  coinbaseScope?: CoinbaseBookScope;
  hlScope?: HyperliquidBookScope;
  combinedScope?: CombinedBookScope;
  timeframe?: TimeframeId;
  chartTimeframe?: TimeframeId;
  priceStep?: PriceStep;
  colormap?: ColormapName;
  clusterFilterBtc?: ClusterFilterBtc;
  autoContrast?: boolean;
  minFilterBtc?: number;
  maxCeilingBtc?: number;
  showBidAskLines?: boolean;
  showTradeBubbles?: boolean;
  showCandlesticks?: boolean;
  showVolumePane?: boolean;
  showVolumeProfile?: boolean;
  showLiquidations?: boolean;
  showSpoofDelta?: boolean;
  soundMuted?: boolean;
  whaleAlertBtc?: number;
  priceAlertLevel?: number | null;
  chartSettings?: ChartPageSettings;
  chartViewports?: Record<string, ChartViewportState>;
  drawingsByExchange?: Partial<Record<ExchangeId, unknown[]>>;
}

export interface AuthUserInfo {
  username: string;
  createdAt: number;
  updatedAt: number;
}
