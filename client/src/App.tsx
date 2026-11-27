import React, { Suspense, lazy, useEffect, useState, useRef, useCallback } from 'react';
import type {
  AuthUserInfo,
  BinanceBookScope,
  BookScope,
  BybitBookScope,
  ChartPageSettings,
  ChartViewportState,
  ClusterBucketSummary,
  ClusterFilterBtc,
  CoinbaseBookScope,
  ColormapName,
  CombinedBookScope,
  ExchangeId,
  FundingRatesResponse,
  HeatmapSlice,
  HyperliquidBookScope,
  InitialHistoryResponse,
  LiquidationEvent,
  OkxBookScope,
  PriceStep,
  TickerStats,
  TimeframeId,
  TradeEvent,
  UserWorkspaceState,
  VolumeDistributionResponse,
  WallLevel,
  WsClientMessage,
  WsServerMessage,
} from '../../shared/types.ts';
import { type AlertToastItem, playAlertChime } from './alerts.ts';
import { type ChartDrawing, DRAWING_COLORS, loadDrawings, saveDrawings } from './chartDrawings.ts';
import { HeatmapCanvas } from './components/HeatmapCanvas.tsx';
import { Sidebar } from './components/Sidebar.tsx';

const AuthModal = lazy(() =>
  import('./components/AuthModal.tsx').then((m) => ({ default: m.AuthModal }))
);
const TradingChartPage = lazy(() =>
  import('./components/TradingChartPage.tsx').then((m) => ({ default: m.TradingChartPage }))
);

const PREFS_STORAGE_KEY = 'orderbook-heatmap-prefs-v1';
const ALL_EXCHANGES: ExchangeId[] = ['bybit', 'binance', 'okx', 'coinbase', 'hyperliquid', 'combined'];

const DEFAULT_CHART_SETTINGS: ChartPageSettings = {
  chartStyle: 'candles',
  scaleMode: 'normal',
  autoScaleY: true,
  indicators: {
    ema9: true,
    ema21: true,
    ema50: false,
    ema200: false,
    sma20: false,
    ma50: false,
    ma100: false,
    ma200: false,
    vwap: false,
    bb: false,
    volume: true,
    rsi: true,
    macd: false,
  },
  drawColor: DRAWING_COLORS[0],
  drawWidth: 2,
  drawDashed: false,
  magnetMode: 'off',
  hideDrawings: false,
};

function loadAllLocalDrawings(): Partial<Record<ExchangeId, ChartDrawing[]>> {
  const out: Partial<Record<ExchangeId, ChartDrawing[]>> = {};
  for (const ex of ALL_EXCHANGES) {
    const list = loadDrawings(ex);
    if (list.length > 0) out[ex] = list;
  }
  return out;
}

interface SavedPrefs {
  exchange?: ExchangeId;
  timeframe?: TimeframeId;
  priceStep?: PriceStep;
  colormap?: ColormapName;
  clusterFilterBtc?: ClusterFilterBtc;
  autoContrast?: boolean;
  showBidAskLines?: boolean;
  showTradeBubbles?: boolean;
  showCandlesticks?: boolean;
  showVolumePane?: boolean;
  showVolumeProfile?: boolean;
  showLiquidations?: boolean;
  showSpoofDelta?: boolean;
  soundMuted?: boolean;
  whaleAlertBtc?: number;
}

function loadSavedPrefs(): SavedPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SavedPrefs;
  } catch {
    return {};
  }
}

const PRICE_STEP_OPTIONS: PriceStep[] = [0.5, 1, 2, 5, 10, 25, 50, 100];

const BTC_CLUSTER_BUCKETS: ClusterFilterBtc[] = [
  0,
  1,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
];

const BYBIT_SCOPE_OPTIONS: { id: BybitBookScope; label: string }[] = [
  { id: 'all', label: 'All Bybit Books' },
  { id: 'linear', label: 'USDT Perp + RPI' },
  { id: 'spot', label: 'Spot + RPI' },
  { id: 'inverse', label: 'Inverse BTCUSD' },
  { id: 'usdc', label: 'USDC BTCPERP' },
];

const BINANCE_SCOPE_OPTIONS: { id: BinanceBookScope; label: string }[] = [
  { id: 'all', label: 'All Binance BTC (12)' },
  { id: 'usdm', label: 'USD-M (4)' },
  { id: 'coinm', label: 'COIN-M (Perp)' },
  { id: 'spot', label: 'Spot (7)' },
  { id: 'btcusdt_perp', label: 'BTCUSDT Perp' },
];

const OKX_SCOPE_OPTIONS: { id: OkxBookScope; label: string }[] = [
  { id: 'all', label: 'All OKX BTC (4)' },
  { id: 'usdt_swap', label: 'USDT Swap' },
  { id: 'usd_swap', label: 'USD Swap' },
  { id: 'spot', label: 'Spot (2)' },
];

const COINBASE_SCOPE_OPTIONS: { id: CoinbaseBookScope; label: string }[] = [
  { id: 'all', label: 'All Coinbase (2)' },
  { id: 'usd', label: 'BTC-USD' },
  { id: 'usdt', label: 'BTC-USDT' },
];

const HL_SCOPE_OPTIONS: { id: HyperliquidBookScope; label: string }[] = [
  { id: 'all', label: 'All HL BTC (Perp+Spot)' },
  { id: 'perp', label: 'BTC Perp' },
  { id: 'spot', label: 'UBTC Spot' },
];

const COMBINED_SCOPE_OPTIONS: { id: CombinedBookScope; label: string }[] = [
  { id: 'all', label: 'All Merged (24)' },
  { id: 'perps', label: 'Perps' },
  { id: 'spot', label: 'Spot' },
  { id: 'bybit', label: 'Bybit' },
  { id: 'binance', label: 'Binance' },
  { id: 'okx', label: 'OKX' },
  { id: 'coinbase', label: 'Coinbase' },
  { id: 'hyperliquid', label: 'HL' },
];

const TICK_TIMEFRAMES: TimeframeId[] = ['100ms', '250ms', '500ms', '1s'];
const KLINE_TIMEFRAMES: TimeframeId[] = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '12h',
  '1d',
  '1w',
];

const TIMEFRAME_MS_MAP: Record<TimeframeId, number> = {
  '100ms': 100,
  '250ms': 250,
  '500ms': 500,
  '1s': 1000,
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

const RECOMMENDED_STEP_FOR_TF: Record<TimeframeId, PriceStep> = {
  '100ms': 1,
  '250ms': 2,
  '500ms': 2,
  '1s': 5,
  '1m': 5,
  '3m': 5,
  '5m': 10,
  '15m': 10,
  '30m': 25,
  '1h': 25,
  '2h': 25,
  '4h': 50,
  '6h': 50,
  '12h': 50,
  '1d': 100,
  '1w': 100,
};

function makeEmptyTicker(exchange: ExchangeId): TickerStats {
  return {
    exchange,
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
}

export const App: React.FC = () => {
  const initialPrefs = useRef<SavedPrefs | null>(null);
  if (initialPrefs.current === null) {
    initialPrefs.current = loadSavedPrefs();
  }
  const prefs = initialPrefs.current;

  const [activePage, setActivePage] = useState<'heatmap' | 'chart'>(() =>
    window.location.pathname === '/chart' ? 'chart' : 'heatmap'
  );
  const [exchange, setExchange] = useState<ExchangeId>(prefs.exchange || 'bybit');
  const [bybitScope, setBybitScope] = useState<BybitBookScope>('all');
  const [binanceScope, setBinanceScope] = useState<BinanceBookScope>('all');
  const [okxScope, setOkxScope] = useState<OkxBookScope>('all');
  const [coinbaseScope, setCoinbaseScope] = useState<CoinbaseBookScope>('all');
  const [hlScope, setHlScope] = useState<HyperliquidBookScope>('all');
  const [combinedScope, setCombinedScope] = useState<CombinedBookScope>('all');

  const bookScope: BookScope =
    exchange === 'combined'
      ? combinedScope
      : exchange === 'hyperliquid'
        ? hlScope
        : exchange === 'coinbase'
          ? coinbaseScope
          : exchange === 'okx'
            ? okxScope
            : exchange === 'binance'
              ? binanceScope
              : bybitScope;

  const [timeframe, setTimeframe] = useState<TimeframeId>(prefs.timeframe || '15m');
  const [chartTimeframe, setChartTimeframe] = useState<TimeframeId>(() =>
    prefs.timeframe && KLINE_TIMEFRAMES.includes(prefs.timeframe) ? prefs.timeframe : '15m'
  );
  const [priceStep, setPriceStep] = useState<PriceStep>(prefs.priceStep || 10);
  const [clusterFilterBtc, setClusterFilterBtc] = useState<ClusterFilterBtc>(
    prefs.clusterFilterBtc ?? 0
  );
  const [isKlineTimeframe, setIsKlineTimeframe] = useState<boolean>(
    KLINE_TIMEFRAMES.includes(prefs.timeframe || '15m')
  );
  const [timeframeMs, setTimeframeMs] = useState<number>(
    TIMEFRAME_MS_MAP[prefs.timeframe || '15m'] || 15 * 60 * 1000
  );
  const [colormap, setColormap] = useState<ColormapName>(prefs.colormap || 'thermal');

  // Contrast & liquidity threshold controls
  const [autoContrast, setAutoContrast] = useState<boolean>(prefs.autoContrast ?? true);
  const [minFilterBtc, setMinFilterBtc] = useState<number>(0.2);
  const [maxCeilingBtc, setMaxCeilingBtc] = useState<number>(35);

  // Layer toggles
  const [showBidAskLines, setShowBidAskLines] = useState<boolean>(prefs.showBidAskLines ?? true);
  const [showTradeBubbles, setShowTradeBubbles] = useState<boolean>(prefs.showTradeBubbles ?? true);
  const [showCandlesticks, setShowCandlesticks] = useState<boolean>(prefs.showCandlesticks ?? true);
  const [showVolumePane, setShowVolumePane] = useState<boolean>(prefs.showVolumePane ?? true);
  const [showVolumeProfile, setShowVolumeProfile] = useState<boolean>(
    prefs.showVolumeProfile ?? true
  );
  const [showLiquidations, setShowLiquidations] = useState<boolean>(prefs.showLiquidations ?? true);
  const [showSpoofDelta, setShowSpoofDelta] = useState<boolean>(prefs.showSpoofDelta ?? true);

  // Alerts & hotkeys state
  const [soundMuted, setSoundMuted] = useState<boolean>(prefs.soundMuted ?? false);
  const [whaleAlertBtc, setWhaleAlertBtc] = useState<number>(prefs.whaleAlertBtc ?? 5);
  const [priceAlertLevel, setPriceAlertLevel] = useState<number | null>(null);
  const [toasts, setToasts] = useState<AlertToastItem[]>([]);
  const [hotkeyAction, setHotkeyAction] = useState<{
    id: number;
    type: 'fit' | 'recenter' | 'fullbook';
  } | null>(null);

  // Playback & viewport controls
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [autoFollowPrice, setAutoFollowPrice] = useState<boolean>(true);
  const [highlightedPrice, setHighlightedPrice] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [fitTrigger, setFitTrigger] = useState<number>(0);

  // Live data state
  const [slices, setSlices] = useState<HeatmapSlice[]>([]);
  const [currentBids, setCurrentBids] = useState<[number, number][]>([]);
  const [currentAsks, setCurrentAsks] = useState<[number, number][]>([]);
  const [recentTrades, setRecentTrades] = useState<TradeEvent[]>([]);
  const [whaleTrades, setWhaleTrades] = useState<TradeEvent[]>([]);
  const [recentLiquidations, setRecentLiquidations] = useState<LiquidationEvent[]>([]);
  const [bidClusters, setBidClusters] = useState<WallLevel[]>([]);
  const [askClusters, setAskClusters] = useState<WallLevel[]>([]);
  const [clusterSummary, setClusterSummary] = useState<ClusterBucketSummary[]>([]);
  const [ticker, setTicker] = useState<TickerStats>(() => makeEmptyTicker(prefs.exchange || 'bybit'));
  const [volumeDistribution, setVolumeDistribution] = useState<VolumeDistributionResponse | null>(
    null
  );
  const [fundingRates, setFundingRates] = useState<FundingRatesResponse | null>(null);

  // Account & persistent server workspace state
  const [authUser, setAuthUser] = useState<AuthUserInfo | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [chartSettings, setChartSettings] = useState<ChartPageSettings>(DEFAULT_CHART_SETTINGS);
  const [chartViewports, setChartViewports] = useState<Record<string, ChartViewportState>>({});
  const [ollamaModel, setOllamaModel] = useState<string>('inkling-2-mini-hybrid');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState<string>('http://127.0.0.1:11435');
  const [drawingsByExchange, setDrawingsByExchange] = useState<
    Partial<Record<ExchangeId, ChartDrawing[]>>
  >(() => loadAllLocalDrawings());
  const accountHydratedRef = useRef<boolean>(false);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSavePayloadRef = useRef<UserWorkspaceState | null>(null);
  const lastSavedWorkspaceJsonRef = useRef<string>('');

  const wsRef = useRef<WebSocket | null>(null);
  const fetchSeqRef = useRef<number>(0);
  const pendingBaseSlicesRef = useRef<HeatmapSlice[]>([]);
  const activePageRef = useRef<'heatmap' | 'chart'>(activePage);
  const exchangeRef = useRef<ExchangeId>(exchange);
  const priceStepRef = useRef<PriceStep>(priceStep);
  const bookScopeRef = useRef<BookScope>(bookScope);
  const timeframeMsRef = useRef<number>(timeframeMs);
  const chartTimeframeRef = useRef<TimeframeId>(chartTimeframe);
  const isKlineTimeframeRef = useRef<boolean>(isKlineTimeframe);
  const isPausedRef = useRef<boolean>(isPaused);
  const soundMutedRef = useRef<boolean>(soundMuted);
  const whaleAlertBtcRef = useRef<number>(whaleAlertBtc);
  const priceAlertLevelRef = useRef<number | null>(priceAlertLevel);
  const prevLastPriceRef = useRef<number>(0);

  activePageRef.current = activePage;
  exchangeRef.current = exchange;
  priceStepRef.current = priceStep;
  bookScopeRef.current = bookScope;
  timeframeMsRef.current = timeframeMs;
  chartTimeframeRef.current = chartTimeframe;
  isKlineTimeframeRef.current = isKlineTimeframe;
  isPausedRef.current = isPaused;
  soundMutedRef.current = soundMuted;
  whaleAlertBtcRef.current = whaleAlertBtc;
  priceAlertLevelRef.current = priceAlertLevel;

  const pushToast = useCallback(
    (item: Omit<AlertToastItem, 'id' | 'ts'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const full: AlertToastItem = { ...item, id, ts: Date.now() };
      setToasts((prev) => [full, ...prev].slice(0, 4));
      if (!soundMutedRef.current) {
        playAlertChime(item.kind, item.tone);
      }
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4500);
    },
    []
  );

  // Persist user preferences in localStorage
  useEffect(() => {
    try {
      const toSave: SavedPrefs = {
        exchange,
        timeframe,
        priceStep,
        colormap,
        clusterFilterBtc,
        autoContrast,
        showBidAskLines,
        showTradeBubbles,
        showCandlesticks,
        showVolumePane,
        showVolumeProfile,
        showLiquidations,
        showSpoofDelta,
        soundMuted,
        whaleAlertBtc,
      };
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(toSave));
    } catch {
      // Ignore storage quota errors
    }
  }, [
    exchange,
    timeframe,
    priceStep,
    colormap,
    clusterFilterBtc,
    autoContrast,
    showBidAskLines,
    showTradeBubbles,
    showCandlesticks,
    showVolumePane,
    showVolumeProfile,
    showLiquidations,
    showSpoofDelta,
    soundMuted,
    whaleAlertBtc,
  ]);

  const buildWorkspaceState = useCallback((): UserWorkspaceState => {
    return {
      activePage,
      exchange,
      bybitScope,
      binanceScope,
      okxScope,
      coinbaseScope,
      hlScope,
      combinedScope,
      timeframe,
      chartTimeframe,
      priceStep,
      colormap,
      clusterFilterBtc,
      autoContrast,
      // Only persist manual contrast bounds when Auto-Contrast is off (prevents 2s auto-save churn)
      ...(autoContrast ? {} : { minFilterBtc, maxCeilingBtc }),
      showBidAskLines,
      showTradeBubbles,
      showCandlesticks,
      showVolumePane,
      showVolumeProfile,
      showLiquidations,
      showSpoofDelta,
      soundMuted,
      whaleAlertBtc,
      priceAlertLevel,
      chartSettings,
      chartViewports,
      drawingsByExchange,
      ollamaModel,
      ollamaBaseUrl,
    };
  }, [
    activePage,
    exchange,
    bybitScope,
    binanceScope,
    okxScope,
    coinbaseScope,
    hlScope,
    combinedScope,
    timeframe,
    chartTimeframe,
    priceStep,
    colormap,
    clusterFilterBtc,
    autoContrast,
    autoContrast ? 0 : minFilterBtc,
    autoContrast ? 0 : maxCeilingBtc,
    showBidAskLines,
    showTradeBubbles,
    showCandlesticks,
    showVolumePane,
    showVolumeProfile,
    showLiquidations,
    showSpoofDelta,
    soundMuted,
    whaleAlertBtc,
    priceAlertLevel,
    chartSettings,
    chartViewports,
    drawingsByExchange,
    ollamaModel,
    ollamaBaseUrl,
  ]);

  const applySavedWorkspaceState = useCallback((st: UserWorkspaceState) => {
    if (!st || typeof st !== 'object') return;
    if (st.activePage === 'chart' || st.activePage === 'heatmap') {
      setActivePage(st.activePage);
      const targetPath = st.activePage === 'chart' ? '/chart' : '/';
      if (window.location.pathname !== targetPath) {
        window.history.replaceState({}, '', targetPath);
      }
    }
    if (st.exchange) setExchange(st.exchange);
    if (st.bybitScope) setBybitScope(st.bybitScope);
    if (st.binanceScope) setBinanceScope(st.binanceScope);
    if (st.okxScope) setOkxScope(st.okxScope);
    if (st.coinbaseScope) setCoinbaseScope(st.coinbaseScope);
    if (st.hlScope) setHlScope(st.hlScope);
    if (st.combinedScope) setCombinedScope(st.combinedScope);
    if (st.timeframe) {
      setTimeframe(st.timeframe);
      setIsKlineTimeframe(KLINE_TIMEFRAMES.includes(st.timeframe));
      setTimeframeMs(TIMEFRAME_MS_MAP[st.timeframe] || 15 * 60_000);
    }
    if (st.chartTimeframe && KLINE_TIMEFRAMES.includes(st.chartTimeframe)) {
      setChartTimeframe(st.chartTimeframe);
    } else if (st.timeframe && KLINE_TIMEFRAMES.includes(st.timeframe)) {
      setChartTimeframe(st.timeframe);
    }
    if (st.priceStep) setPriceStep(st.priceStep);
    if (st.colormap) setColormap(st.colormap);
    if (st.clusterFilterBtc !== undefined) setClusterFilterBtc(st.clusterFilterBtc);
    if (st.autoContrast !== undefined) setAutoContrast(st.autoContrast);
    if (st.minFilterBtc !== undefined) setMinFilterBtc(st.minFilterBtc);
    if (st.maxCeilingBtc !== undefined) setMaxCeilingBtc(st.maxCeilingBtc);
    if (st.showBidAskLines !== undefined) setShowBidAskLines(st.showBidAskLines);
    if (st.showTradeBubbles !== undefined) setShowTradeBubbles(st.showTradeBubbles);
    if (st.showCandlesticks !== undefined) setShowCandlesticks(st.showCandlesticks);
    if (st.showVolumePane !== undefined) setShowVolumePane(st.showVolumePane);
    if (st.showVolumeProfile !== undefined) setShowVolumeProfile(st.showVolumeProfile);
    if (st.showLiquidations !== undefined) setShowLiquidations(st.showLiquidations);
    if (st.showSpoofDelta !== undefined) setShowSpoofDelta(st.showSpoofDelta);
    if (st.soundMuted !== undefined) setSoundMuted(st.soundMuted);
    if (st.whaleAlertBtc !== undefined) setWhaleAlertBtc(st.whaleAlertBtc);
    if (st.priceAlertLevel !== undefined) setPriceAlertLevel(st.priceAlertLevel);
    if (st.chartSettings) {
      setChartSettings({
        ...DEFAULT_CHART_SETTINGS,
        ...st.chartSettings,
        indicators: {
          ...DEFAULT_CHART_SETTINGS.indicators,
          ...(st.chartSettings.indicators || {}),
        },
      });
    }
    if (st.chartViewports && typeof st.chartViewports === 'object') {
      setChartViewports(st.chartViewports);
    }
    if (st.ollamaModel) {
      setOllamaModel(st.ollamaModel);
    }
    if (st.ollamaBaseUrl) {
      setOllamaBaseUrl(st.ollamaBaseUrl);
    }
    if (st.drawingsByExchange && typeof st.drawingsByExchange === 'object') {
      const nextMap: Partial<Record<ExchangeId, ChartDrawing[]>> = {};
      for (const ex of ALL_EXCHANGES) {
        const arr = st.drawingsByExchange[ex];
        const clean = Array.isArray(arr) ? (arr as ChartDrawing[]) : [];
        nextMap[ex] = clean;
        saveDrawings(ex, clean);
      }
      setDrawingsByExchange(nextMap);
    }
  }, []);

  // Auto-restore authenticated session & saved workspace state on page load / server restart
  useEffect(() => {
    let active = true;
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { authenticated?: boolean; user?: AuthUserInfo; state?: UserWorkspaceState } | null) => {
        if (!active) return;
        if (data?.authenticated && data.user) {
          setAuthUser(data.user);
          if (data.state && Object.keys(data.state).length > 0) {
            applySavedWorkspaceState(data.state);
          }
          setSyncStatus('saved');
        }
        window.setTimeout(() => {
          accountHydratedRef.current = true;
        }, 200);
      })
      .catch(() => {
        accountHydratedRef.current = true;
      });
    return () => {
      active = false;
    };
  }, [applySavedWorkspaceState]);

  const persistWorkspaceToServer = useCallback(
    async (stateSnapshot: UserWorkspaceState) => {
      setSyncStatus('saving');
      try {
        const res = await fetch('/api/user/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ state: stateSnapshot }),
        });
        if (res.ok) {
          const data = (await res.json()) as { updatedAt?: number };
          setSyncStatus('saved');
          if (data.updatedAt) {
            setAuthUser((prev) => (prev ? { ...prev, updatedAt: data.updatedAt! } : prev));
          }
        } else {
          setSyncStatus('error');
        }
      } catch {
        setSyncStatus('error');
      }
    },
    []
  );

  // Debounced auto-save to server whenever any setting, drawing, or chart viewport changes while signed in
  useEffect(() => {
    if (!authUser || !accountHydratedRef.current) return;
    const snapshot = buildWorkspaceState();
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSavedWorkspaceJsonRef.current) return;
    pendingSavePayloadRef.current = snapshot;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      pendingSavePayloadRef.current = null;
      lastSavedWorkspaceJsonRef.current = serialized;
      persistWorkspaceToServer(snapshot);
    }, 500);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [authUser, buildWorkspaceState, persistWorkspaceToServer]);

  // Flush any pending unsaved drawings/settings immediately if user refreshes or closes the tab
  useEffect(() => {
    const flushPending = () => {
      const pending = pendingSavePayloadRef.current;
      if (!pending) return;
      pendingSavePayloadRef.current = null;
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      try {
        fetch('/api/user/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          keepalive: true,
          body: JSON.stringify({ state: pending }),
        });
      } catch {
        // ignore unload fetch errors
      }
    };
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') flushPending();
    };
    window.addEventListener('beforeunload', flushPending);
    window.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      window.removeEventListener('beforeunload', flushPending);
      window.removeEventListener('pagehide', flushPending);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, []);

  const handleChangeDrawings = useCallback((ex: ExchangeId, next: ChartDrawing[]) => {
    setDrawingsByExchange((prev) => ({ ...prev, [ex]: next }));
  }, []);

  const handleChangeChartViewport = useCallback((key: string, vp: ChartViewportState) => {
    setChartViewports((prev) => {
      const cur = prev[key];
      if (
        cur &&
        Math.abs(cur.barWidth - vp.barWidth) < 0.05 &&
        Math.abs(cur.rightOffsetBars - vp.rightOffsetBars) < 0.05 &&
        JSON.stringify(cur.manualPriceRange || null) === JSON.stringify(vp.manualPriceRange || null)
      ) {
        return prev;
      }
      return { ...prev, [key]: vp };
    });
  }, []);

  const handleSelectChartTimeframe = useCallback((tf: TimeframeId) => {
    if (!KLINE_TIMEFRAMES.includes(tf)) return;
    setChartTimeframe(tf);
    setTimeframe(tf);
    setTimeframeMs(TIMEFRAME_MS_MAP[tf] || 15 * 60_000);
    setIsKlineTimeframe(true);
    setPriceStep(RECOMMENDED_STEP_FOR_TF[tf]);
  }, []);

  const handleManualSaveWorkspace = useCallback(() => {
    if (!authUser) {
      setAuthModalOpen(true);
      return;
    }
    const snapshot = buildWorkspaceState();
    pendingSavePayloadRef.current = null;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    lastSavedWorkspaceJsonRef.current = JSON.stringify(snapshot);
    persistWorkspaceToServer(snapshot);
  }, [authUser, buildWorkspaceState, persistWorkspaceToServer]);

  const handleLogout = useCallback(async () => {
    setAccountMenuOpen(false);
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // ignore
    }
    setAuthUser(null);
    setSyncStatus('idle');
  }, []);

  useEffect(() => {
    const exName =
      exchange === 'combined'
        ? 'Merged (All 5)'
        : exchange === 'hyperliquid'
          ? 'Hyperliquid'
          : exchange === 'coinbase'
            ? 'Coinbase'
            : exchange === 'okx'
              ? 'OKX'
              : exchange === 'binance'
                ? 'Binance'
                : 'Bybit';
    document.title = `BTC Orderbook Heatmap Chart — ${exName}`;
  }, [exchange]);

  const handleSelectTimeframe = useCallback((tf: TimeframeId) => {
    setTimeframe(tf);
    setTimeframeMs(TIMEFRAME_MS_MAP[tf] || 15 * 60_000);
    const isKline = KLINE_TIMEFRAMES.includes(tf);
    setIsKlineTimeframe(isKline);
    const recStep = RECOMMENDED_STEP_FOR_TF[tf];
    setPriceStep(recStep);
    if (isKline) {
      setShowCandlesticks(true);
    }
  }, []);

  const handleSelectClusterFilter = useCallback((val: ClusterFilterBtc) => {
    setClusterFilterBtc(val);
    if (val === 0) {
      setAutoContrast(true);
    } else {
      setAutoContrast(false);
      setMinFilterBtc(val);
      setMaxCeilingBtc(Math.max(val * 3, 25));
    }
  }, []);

  const handleSwitchExchange = useCallback((nextEx: ExchangeId) => {
    setExchange(nextEx);
    setHighlightedPrice(null);
    setPriceAlertLevel(null);
    prevLastPriceRef.current = 0;
    setSlices([]);
    setCurrentBids([]);
    setCurrentAsks([]);
    setBidClusters([]);
    setAskClusters([]);
    setRecentTrades([]);
    setWhaleTrades([]);
    setRecentLiquidations([]);
    setTicker(makeEmptyTicker(nextEx));
  }, []);

  const handleSelectWallPrice = useCallback((price: number) => {
    setHighlightedPrice(price);
    setAutoFollowPrice(false);
  }, []);

  const handleSwitchPage = useCallback((nextPage: 'heatmap' | 'chart') => {
    setActivePage(nextPage);
    const targetPath = nextPage === 'chart' ? '/chart' : '/';
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
  }, []);

  useEffect(() => {
    const onPop = () => {
      setActivePage(window.location.pathname === '/chart' ? 'chart' : 'heatmap');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Keyboard shortcuts: 1-6 (Exchange Tabs); on Heatmap: Space (Pause), F (Auto-Fit), R (Live Spread), B (Full Book), M (Mute), Esc (Clear)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '1') {
        handleSwitchExchange('bybit');
      } else if (e.key === '2') {
        handleSwitchExchange('binance');
      } else if (e.key === '3') {
        handleSwitchExchange('okx');
      } else if (e.key === '4') {
        handleSwitchExchange('coinbase');
      } else if (e.key === '5') {
        handleSwitchExchange('hyperliquid');
      } else if (e.key === '6') {
        handleSwitchExchange('combined');
      } else if (activePage === 'heatmap') {
        if (e.code === 'Space') {
          e.preventDefault();
          setIsPaused((p) => !p);
        } else if (e.key === 'f' || e.key === 'F') {
          setHotkeyAction({ id: Date.now(), type: 'fit' });
        } else if (e.key === 'r' || e.key === 'R') {
          setHotkeyAction({ id: Date.now(), type: 'recenter' });
        } else if (e.key === 'b' || e.key === 'B') {
          setHotkeyAction({ id: Date.now(), type: 'fullbook' });
        } else if (e.key === 'm' || e.key === 'M') {
          setSoundMuted((m) => !m);
        } else if (e.key === 'Escape') {
          setHighlightedPrice(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSwitchExchange, activePage]);

  const handleSelectBookScope = useCallback(
    (nextScope: BookScope) => {
      if (exchange === 'combined') {
        setCombinedScope(nextScope as CombinedBookScope);
      } else if (exchange === 'hyperliquid') {
        setHlScope(nextScope as HyperliquidBookScope);
      } else if (exchange === 'coinbase') {
        setCoinbaseScope(nextScope as CoinbaseBookScope);
      } else if (exchange === 'okx') {
        setOkxScope(nextScope as OkxBookScope);
      } else if (exchange === 'binance') {
        setBinanceScope(nextScope as BinanceBookScope);
      } else {
        setBybitScope(nextScope as BybitBookScope);
      }
    },
    [exchange]
  );

  const lastContrastCalcRef = useRef<{ key: string; ts: number }>({ key: '', ts: 0 });

  // Auto-contrast calibration (throttled & skipped while on Chart page)
  useEffect(() => {
    if (activePage !== 'heatmap' || !autoContrast) return;
    if (currentBids.length === 0 && currentAsks.length === 0) return;

    const scopeKey = `${exchange}:${bookScope}:${priceStep}:${autoContrast}`;
    const now = Date.now();
    if (
      lastContrastCalcRef.current.key === scopeKey &&
      now - lastContrastCalcRef.current.ts < 2000
    ) {
      return;
    }

    const sizes: number[] = [];
    for (const [, v] of currentBids) if (v > 0.05) sizes.push(v);
    for (const [, v] of currentAsks) if (v > 0.05) sizes.push(v);
    if (sizes.length < 3) return;

    lastContrastCalcRef.current = { key: scopeKey, ts: now };
    sizes.sort((a, b) => a - b);
    const p15 = sizes[Math.floor(sizes.length * 0.15)] || 0.1;
    const p97 = sizes[Math.floor(sizes.length * 0.97)] || 25;

    const nextMin = +(Math.max(0.05, p15 * 0.5)).toFixed(2);
    const nextMax = +(Math.max(2.0, p97 * 1.15)).toFixed(1);

    setMinFilterBtc((prev) => (Math.abs(nextMin - prev) > 0.02 ? nextMin : prev));
    setMaxCeilingBtc((prev) => (Math.abs(nextMax - prev) > 0.5 ? nextMax : prev));
  }, [activePage, autoContrast, currentBids, currentAsks, priceStep, bookScope, exchange]);

  // Send updated subscription config over WS when exchange, bookScope, priceStep, or activePage changes
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const cfgMsg: WsClientMessage = {
        type: 'config',
        exchange,
        bookScope,
        priceStep,
        mode: activePage,
      };
      ws.send(JSON.stringify(cfgMsg));
    }
  }, [exchange, bookScope, priceStep, activePage]);

  // Fetch history whenever exchange, priceStep, bookScope, or timeframe changes
  const fetchHistory = useCallback(
    async (ex: ExchangeId, pStep: PriceStep, scope: BookScope, tf: TimeframeId) => {
      const seq = ++fetchSeqRef.current;
      try {
        const res = await fetch(
          `/api/history?exchange=${ex}&priceStep=${pStep}&bookScope=${scope}&timeframe=${tf}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as InitialHistoryResponse;
        if (seq !== fetchSeqRef.current || data.exchange !== exchangeRef.current) return;

        pendingBaseSlicesRef.current = [];
        setSlices(data.slices);
        setIsKlineTimeframe(data.isKlineTimeframe);
        setTimeframeMs(data.timeframeMs);
        setCurrentBids(data.currentBids);
        setCurrentAsks(data.currentAsks);
        setRecentTrades(data.recentTrades);
        setWhaleTrades(
          data.whaleTrades || data.recentTrades.filter((t) => t.v >= 0.5)
        );
        setRecentLiquidations(data.recentLiquidations || []);
        setBidClusters(data.bidClusters);
        setAskClusters(data.askClusters);
        setClusterSummary(data.clusterSummary);
        setTicker(data.ticker);
        setFitTrigger((n) => n + 1);
      } catch {
        // Ignore transient fetch failure
      }
    },
    []
  );

  useEffect(() => {
    if (activePage !== 'heatmap') return;
    fetchHistory(exchange, priceStep, bookScope, timeframe);
  }, [activePage, exchange, priceStep, bookScope, timeframe, fetchHistory]);

  // Poll 5-exchange 24h Spot & Derivatives volume distribution + live funding rates (only on Heatmap & when visible)
  useEffect(() => {
    if (activePage !== 'heatmap') return;
    let active = true;
    const fetchMarketStats = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const [volRes, fundRes] = await Promise.all([
          fetch('/api/volume-distribution'),
          fetch('/api/funding-rates'),
        ]);
        if (volRes.ok) {
          const data = (await volRes.json()) as VolumeDistributionResponse;
          if (active && data && Array.isArray(data.exchanges)) {
            setVolumeDistribution(data);
          }
        }
        if (fundRes.ok) {
          const fData = (await fundRes.json()) as FundingRatesResponse;
          if (active && fData && Array.isArray(fData.exchanges)) {
            setFundingRates(fData);
          }
        }
      } catch {
        // Ignore transient poll failure
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchMarketStats();
    };
    fetchMarketStats();
    const warmup = window.setTimeout(fetchMarketStats, 2500);
    const timer = window.setInterval(fetchMarketStats, 15_000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      clearTimeout(warmup);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activePage]);

  // WebSocket live connection
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws?.close();
          return;
        }
        setWsConnected(true);
        const cfgMsg: WsClientMessage = {
          type: 'config',
          exchange: exchangeRef.current,
          bookScope: bookScopeRef.current,
          priceStep: priceStepRef.current,
          mode: activePageRef.current,
        };
        ws?.send(JSON.stringify(cfgMsg));
      };

      ws.onmessage = (event) => {
        if (disposed || isPausedRef.current) return;

        try {
          const msg = JSON.parse(event.data) as WsServerMessage;
          if (msg.type !== 'tick' || !msg.payload.slice) return;

          if (
            msg.payload.exchange !== exchangeRef.current ||
            msg.payload.bookScope !== bookScopeRef.current ||
            msg.payload.priceStep !== priceStepRef.current
          ) {
            return;
          }

          const isHidden = document.visibilityState === 'hidden';
          const isChartMode = activePageRef.current === 'chart';
          const tfMs = isChartMode
            ? TIMEFRAME_MS_MAP[chartTimeframeRef.current] || 15 * 60_000
            : timeframeMsRef.current;
          const isKline = isChartMode ? true : isKlineTimeframeRef.current;
          const baseSlice = msg.payload.slice;

          if (msg.payload.ticker) {
            if (!isHidden) setTicker(msg.payload.ticker);
            const nextPrice = msg.payload.ticker.lastPrice;
            const prevPrice = prevLastPriceRef.current;
            const alertTarget = priceAlertLevelRef.current;
            if (
              alertTarget &&
              prevPrice > 0 &&
              nextPrice > 0 &&
              ((prevPrice < alertTarget && nextPrice >= alertTarget) ||
                (prevPrice > alertTarget && nextPrice <= alertTarget))
            ) {
              setPriceAlertLevel(null);
              pushToast({
                kind: 'price',
                title: `🔔 Price Alert Hit: $${alertTarget.toFixed(1)}`,
                detail: `${msg.payload.exchange.toUpperCase()} crossed target (Last: $${nextPrice.toFixed(1)})`,
                price: alertTarget,
                tone: 'info',
              });
            }
            if (nextPrice > 0) prevLastPriceRef.current = nextPrice;
          }

          if (isHidden) return;

          if (msg.payload.currentBids) setCurrentBids(msg.payload.currentBids);
          if (msg.payload.currentAsks) setCurrentAsks(msg.payload.currentAsks);
          if (msg.payload.bidClusters) setBidClusters(msg.payload.bidClusters);
          if (msg.payload.askClusters) setAskClusters(msg.payload.askClusters);
          if (msg.payload.clusterSummary) setClusterSummary(msg.payload.clusterSummary);

          if (msg.payload.newLiquidations && msg.payload.newLiquidations.length > 0) {
            const incomingLiqs = [...msg.payload.newLiquidations].reverse();
            setRecentLiquidations((prev) => {
              const seen = new Set(prev.slice(0, 40).map((l) => l.id));
              const fresh = incomingLiqs.filter((l) => !seen.has(l.id));
              return fresh.length > 0 ? [...fresh, ...prev].slice(0, 100) : prev;
            });
            for (const lq of incomingLiqs) {
              if (lq.usd >= 50_000) {
                pushToast({
                  kind: 'liquidation',
                  title: `⚡ ${lq.side.toUpperCase()} LIQ $${(lq.usd / 1000).toFixed(0)}k (${lq.exchange})`,
                  detail: `${lq.v.toFixed(2)} BTC @ $${lq.p.toFixed(1)}`,
                  price: lq.p,
                  tone: lq.side === 'Short' ? 'bid' : 'ask',
                });
                break;
              }
            }
          }

          if (msg.payload.newTrades && msg.payload.newTrades.length > 0) {
            const incomingNewestFirst = [...msg.payload.newTrades].reverse();
            const tapeTrades = incomingNewestFirst.filter(
              (tr) =>
                tr.market !== 'SPOT' ||
                msg.payload.exchange === 'coinbase' ||
                (tr.exchange === 'CB' && tr.v >= 0.05)
            );
            if (tapeTrades.length > 0) {
              setRecentTrades((prev) => {
                const seen = new Set(prev.slice(0, 60).map((t) => t.id));
                const fresh = tapeTrades.filter((t) => !seen.has(t.id));
                return fresh.length > 0 ? [...fresh, ...prev].slice(0, 120) : prev;
              });
            }
            const incomingWhales = incomingNewestFirst.filter((tr) => tr.v >= 0.5);
            if (incomingWhales.length > 0) {
              setWhaleTrades((prev) => {
                const seen = new Set(prev.slice(0, 60).map((t) => t.id));
                const fresh = incomingWhales.filter((t) => !seen.has(t.id));
                return fresh.length > 0 ? [...fresh, ...prev].slice(0, 150) : prev;
              });
              const biggest = incomingWhales.find((w) => w.v >= whaleAlertBtcRef.current);
              if (biggest) {
                pushToast({
                  kind: 'whale',
                  title: `🐋 Whale ${biggest.s} ${biggest.v.toFixed(2)} BTC (${biggest.exchange || 'BTC'}${biggest.market === 'SPOT' ? ' SPOT' : ''})`,
                  detail: `Filled @ $${biggest.p.toFixed(1)} (~$${Math.round(biggest.p * biggest.v).toLocaleString()})`,
                  price: biggest.p,
                  tone: biggest.s === 'Buy' ? 'bid' : 'ask',
                });
              }
            }
          }

          const reBids = msg.payload.currentBids || baseSlice.bids;
          const reAsks = msg.payload.currentAsks || baseSlice.asks;

          if (isKline) {
            setSlices((prev) => {
              if (prev.length === 0) {
                const bucketStart = Math.floor(baseSlice.t / tfMs) * tfMs;
                return [
                  {
                    ...baseSlice,
                    t: bucketStart,
                    bids: reBids,
                    asks: reAsks,
                  },
                ];
              }
              const lastIdx = prev.length - 1;
              const last = prev[lastIdx];

              if (baseSlice.t < last.t + tfMs) {
                const updatedTrades =
                  baseSlice.trades.length > 0
                    ? [...last.trades, ...baseSlice.trades].slice(-60)
                    : last.trades;
                const updatedLiqs =
                  baseSlice.liquidations && baseSlice.liquidations.length > 0
                    ? [...(last.liquidations || []), ...baseSlice.liquidations].slice(-20)
                    : last.liquidations;
                const updated: HeatmapSlice = {
                  ...last,
                  bb: baseSlice.bb,
                  ba: baseSlice.ba,
                  mid: baseSlice.mid,
                  h: Math.max(last.h, baseSlice.h),
                  l: Math.min(last.l, baseSlice.l),
                  c: baseSlice.c,
                  bv: +(last.bv + baseSlice.bv).toFixed(4),
                  sv: +(last.sv + baseSlice.sv).toFixed(4),
                  spotBv: +((last.spotBv || 0) + (baseSlice.spotBv || 0)).toFixed(4),
                  spotSv: +((last.spotSv || 0) + (baseSlice.spotSv || 0)).toFixed(4),
                  bids: reBids.length > 0 ? reBids : last.bids,
                  asks: reAsks.length > 0 ? reAsks : last.asks,
                  trades: updatedTrades,
                  liquidations: updatedLiqs,
                };
                const copy = prev.slice();
                copy[lastIdx] = updated;
                return copy;
              } else {
                const candleBucketStart =
                  last.t + Math.floor((baseSlice.t - last.t) / tfMs) * tfMs;
                const newCandle: HeatmapSlice = {
                  t: candleBucketStart,
                  bb: baseSlice.bb,
                  ba: baseSlice.ba,
                  mid: baseSlice.mid,
                  o: last.c,
                  h: Math.max(last.c, baseSlice.h),
                  l: Math.min(last.c, baseSlice.l),
                  c: baseSlice.c,
                  bv: baseSlice.bv,
                  sv: baseSlice.sv,
                  spotBv: baseSlice.spotBv || 0,
                  spotSv: baseSlice.spotSv || 0,
                  bids: reBids,
                  asks: reAsks,
                  trades: baseSlice.trades,
                  liquidations: baseSlice.liquidations,
                };
                return [...prev.slice(-1199), newCandle];
              }
            });
            return;
          }

          const groupCount = Math.max(1, Math.round(tfMs / 250));
          pendingBaseSlicesRef.current.push(baseSlice);
          if (pendingBaseSlicesRef.current.length >= groupCount) {
            const batch = pendingBaseSlicesRef.current;
            pendingBaseSlicesRef.current = [];

            const first = batch[0];
            const last = batch[batch.length - 1];
            let h = first.h;
            let l = first.l;
            let bv = 0;
            let sv = 0;
            let spotBv = 0;
            let spotSv = 0;
            const trades = [];
            const liquidations: LiquidationEvent[] = [];

            for (const s of batch) {
              if (s.h > h) h = s.h;
              if (s.l < l) l = s.l;
              bv += s.bv;
              sv += s.sv;
              spotBv += s.spotBv || 0;
              spotSv += s.spotSv || 0;
              for (const tr of s.trades) trades.push(tr);
              if (s.liquidations) {
                for (const lq of s.liquidations) liquidations.push(lq);
              }
            }

            const aggSlice: HeatmapSlice = {
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
              bids: reBids,
              asks: reAsks,
              trades,
              liquidations: liquidations.length > 0 ? liquidations : undefined,
            };

            setSlices((prev) => {
              const next = [...prev, aggSlice];
              if (next.length > 1200) next.splice(0, next.length - 1200);
              return next;
            });
          }
        } catch {
          // Ignore malformed WS message
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        reconnectTimer = window.setTimeout(connect, 1500);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);

  const isPositive24h = ticker.price24hPcnt >= 0;
  const scopeOptions =
    exchange === 'combined'
      ? COMBINED_SCOPE_OPTIONS
      : exchange === 'hyperliquid'
        ? HL_SCOPE_OPTIONS
        : exchange === 'coinbase'
          ? COINBASE_SCOPE_OPTIONS
          : exchange === 'okx'
            ? OKX_SCOPE_OPTIONS
            : exchange === 'binance'
              ? BINANCE_SCOPE_OPTIONS
              : BYBIT_SCOPE_OPTIONS;
  const exchangeUrl =
    exchange === 'hyperliquid'
      ? 'https://app.hyperliquid.xyz/trade/BTC'
      : exchange === 'coinbase'
        ? 'https://www.coinbase.com/advanced-trade/spot/BTC-USD'
        : exchange === 'okx'
          ? 'https://www.okx.com/trade-swap/btc-usdt-swap'
          : exchange === 'binance'
            ? 'https://www.binance.com/en/futures/BTCUSDT?_from=markets'
            : 'https://www.bybit.com/en/trade/usdt/BTCUSDT';

  return (
    <div className="app-shell">
      {/* 1. Top Institutional Header with Page Switcher & Exchange Tabs */}
      <header className="top-header">
        <div className="brand-block">
          <div className="page-switcher" role="tablist" aria-label="Workspace Page">
            <button
              role="tab"
              aria-selected={activePage === 'heatmap'}
              className={`page-tab ${activePage === 'heatmap' ? 'active' : ''}`}
              onClick={() => handleSwitchPage('heatmap')}
              title="Orderbook Liquidity Heatmap Terminal (/)"
            >
              Heatmap
            </button>
            <button
              role="tab"
              aria-selected={activePage === 'chart'}
              className={`page-tab ${activePage === 'chart' ? 'active' : ''}`}
              onClick={() => handleSwitchPage('chart')}
              title="TradingView-style Charting & Drawing Page (/chart)"
            >
              Chart
            </button>
          </div>

          <div className="exchange-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={exchange === 'bybit'}
              className={`exchange-tab ${exchange === 'bybit' ? 'active tab-bybit' : ''}`}
              onClick={() => handleSwitchExchange('bybit')}
              title="Bybit (Hotkey: 1)"
            >
              <span className="ex-dot dot-bybit" />
              <strong>Bybit</strong>
              <span className="ex-sub">4</span>
            </button>
            <button
              role="tab"
              aria-selected={exchange === 'binance'}
              className={`exchange-tab ${exchange === 'binance' ? 'active tab-binance' : ''}`}
              onClick={() => handleSwitchExchange('binance')}
              title="Binance (Hotkey: 2)"
            >
              <span className="ex-dot dot-binance" />
              <strong>Binance</strong>
              <span className="ex-sub">12</span>
            </button>
            <button
              role="tab"
              aria-selected={exchange === 'okx'}
              className={`exchange-tab ${exchange === 'okx' ? 'active tab-okx' : ''}`}
              onClick={() => handleSwitchExchange('okx')}
              title="OKX BTC (Hotkey: 3)"
            >
              <span className="ex-dot dot-okx" />
              <strong>OKX</strong>
              <span className="ex-sub">4</span>
            </button>
            <button
              role="tab"
              aria-selected={exchange === 'coinbase'}
              className={`exchange-tab ${exchange === 'coinbase' ? 'active tab-coinbase' : ''}`}
              onClick={() => handleSwitchExchange('coinbase')}
              title="Coinbase BTC Spot (Hotkey: 4)"
            >
              <span className="ex-dot dot-coinbase" />
              <strong>Coinbase</strong>
              <span className="ex-sub">2</span>
            </button>
            <button
              role="tab"
              aria-selected={exchange === 'hyperliquid'}
              className={`exchange-tab ${exchange === 'hyperliquid' ? 'active tab-hyperliquid' : ''}`}
              onClick={() => handleSwitchExchange('hyperliquid')}
              title="Hyperliquid BTC (Hotkey: 5)"
            >
              <span className="ex-dot dot-hyperliquid" />
              <strong>HL</strong>
              <span className="ex-sub">2</span>
            </button>
            <button
              role="tab"
              aria-selected={exchange === 'combined'}
              className={`exchange-tab ${exchange === 'combined' ? 'active tab-combined' : ''}`}
              onClick={() => handleSwitchExchange('combined')}
              title="Merged All 5 Exchanges (Hotkey: 6)"
            >
              <span className="ex-dot dot-combined" />
              <strong>Merged</strong>
              <span className="ex-sub">5•24</span>
            </button>
          </div>

          {exchange !== 'combined' && (
            <a href={exchangeUrl} target="_blank" rel="noreferrer" className="bybit-link">
              {exchange === 'hyperliquid'
                ? 'Hyperliquid ↗'
                : exchange === 'coinbase'
                  ? 'Coinbase ↗'
                  : exchange === 'okx'
                    ? 'OKX ↗'
                    : exchange === 'binance'
                      ? 'Binance ↗'
                      : 'Bybit ↗'}
            </a>
          )}
        </div>

        <div className="ticker-metrics">
          <div className="metric-item primary-price">
            <span className="metric-label">Last Price</span>
            <strong className={isPositive24h ? 'text-bid' : 'text-ask'}>
              $
              {ticker.lastPrice
                ? ticker.lastPrice.toLocaleString(undefined, {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  })
                : '—'}
            </strong>
          </div>

          <div className="metric-item">
            <span className="metric-label">24h Change</span>
            <span className={isPositive24h ? 'text-bid' : 'text-ask'}>
              {isPositive24h ? '+' : ''}
              {ticker.price24hPcnt.toFixed(2)}%
            </span>
          </div>

          <div className="metric-item">
            <span className="metric-label">Total Book Depth</span>
            <span>
              <strong className="text-bid">{ticker.totalBidBtc.toFixed(0)}</strong> /{' '}
              <strong className="text-ask">{ticker.totalAskBtc.toFixed(0)} BTC</strong>
            </span>
          </div>

          <div className="metric-item">
            <span className="metric-label">Active Levels</span>
            <span>{(ticker.activeBidLevels + ticker.activeAskLevels).toLocaleString()} lvls</span>
          </div>

          <div className="metric-item">
            <span className="metric-label">Open Interest</span>
            <span>
              ${ticker.openInterestValue ? `${(ticker.openInterestValue / 1e9).toFixed(2)}B` : '—'}
            </span>
          </div>

          <div className="metric-item">
            <span className="metric-label">Funding Rate</span>
            <span className={ticker.fundingRate >= 0 ? 'text-bid' : 'text-ask'}>
              {ticker.fundingRate >= 0 ? '+' : ''}
              {ticker.fundingRate.toFixed(4)}%
            </span>
          </div>

          {exchange !== 'coinbase' &&
            ticker.spotPrice &&
            ticker.spotPrice > 0 &&
            ticker.lastPrice > 0 && (
              <div className="metric-item" title={`Spot: $${ticker.spotPrice.toFixed(1)} vs Perp: $${ticker.lastPrice.toFixed(1)}`}>
                <span className="metric-label">Perp-Spot Basis</span>
                <span className={ticker.lastPrice - ticker.spotPrice >= 0 ? 'text-bid' : 'text-ask'}>
                  {ticker.lastPrice - ticker.spotPrice >= 0 ? '+' : ''}$
                  {(ticker.lastPrice - ticker.spotPrice).toFixed(1)}
                </span>
              </div>
            )}
        </div>

        <div className="connection-status">
          <span
            className={`status-pill ${
              wsConnected && ticker.connected ? 'status-live' : 'status-warn'
            }`}
          >
            ●{' '}
            {wsConnected && ticker.connected
              ? exchange === 'combined'
                ? '5-EXCHANGE 24-PAIR LIVE'
                : exchange === 'hyperliquid'
                  ? 'HYPERLIQUID LIVE'
                  : exchange === 'coinbase'
                    ? 'COINBASE SPOT LIVE'
                    : exchange === 'okx'
                      ? 'OKX 4-PAIR LIVE'
                      : exchange === 'binance'
                        ? 'BINANCE 12-PAIR LIVE'
                        : 'BYBIT 4-MARKET LIVE'
              : 'CONNECTING...'}
          </span>
          <span className="buffer-count" title="Recorded snapshots in ring buffer">
            Buf: {ticker.storedBaseSlices.toLocaleString()}
          </span>

          {authUser ? (
            <div className="auth-menu-anchor">
              <button
                type="button"
                className="auth-user-pill"
                onClick={() => setAccountMenuOpen((o) => !o)}
                title={`Signed in as ${authUser.username} (${syncStatus === 'saving' ? 'Saving…' : 'Auto-saved to server'})`}
              >
                <span className="auth-dot" />
                <strong>{authUser.username}</strong>
                <span className="auth-sync-tag">
                  {syncStatus === 'saving' ? '…' : syncStatus === 'error' ? '!' : '✓'}
                </span>
              </button>
              {accountMenuOpen && (
                <div className="auth-popover">
                  <div className="auth-pop-head">
                    <strong>{authUser.username}</strong>
                    <span className="text-muted">
                      {syncStatus === 'saving'
                        ? 'Saving…'
                        : authUser.updatedAt
                          ? `Saved ${new Date(authUser.updatedAt).toLocaleTimeString([], {
                              hour12: false,
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}`
                          : 'Synced'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="auth-pop-btn"
                    onClick={() => {
                      persistWorkspaceToServer(buildWorkspaceState());
                      setAccountMenuOpen(false);
                    }}
                  >
                    Save Workspace Now
                  </button>
                  <button
                    type="button"
                    className="auth-pop-btn auth-pop-danger"
                    onClick={handleLogout}
                  >
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="auth-signin-btn"
              onClick={() => setAuthModalOpen(true)}
              title="Sign in or create an account to save all settings & chart drawings across server restarts"
            >
              Sign In
            </button>
          )}
        </div>
      </header>

      {authModalOpen && (
        <Suspense fallback={null}>
          <AuthModal
            getCurrentWorkspaceState={buildWorkspaceState}
            onClose={() => setAuthModalOpen(false)}
            onAuthenticated={(user, state, isNewAccount) => {
              setAuthUser(user);
              if (!isNewAccount && state && Object.keys(state).length > 0) {
                accountHydratedRef.current = false;
                applySavedWorkspaceState(state);
                window.setTimeout(() => {
                  accountHydratedRef.current = true;
                }, 200);
              }
              setSyncStatus('saved');
            }}
          />
        </Suspense>
      )}

      {activePage === 'chart' ? (
        <Suspense
          fallback={
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#64748b',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 13,
              }}
            >
              Loading chart workspace...
            </div>
          }
        >
          <TradingChartPage
            exchange={exchange}
            timeframe={chartTimeframe}
            timeframeMs={TIMEFRAME_MS_MAP[chartTimeframe] || 15 * 60_000}
            slices={slices}
            ticker={ticker}
            onSelectTimeframe={handleSelectChartTimeframe}
            savedChartSettings={chartSettings}
            onChangeChartSettings={setChartSettings}
            savedDrawings={drawingsByExchange[exchange]}
            onChangeDrawings={handleChangeDrawings}
            savedViewport={chartViewports[`${exchange}:${chartTimeframe}`]}
            onChangeViewport={handleChangeChartViewport}
            authUsername={authUser?.username || null}
            syncStatus={syncStatus}
            totalSavedDrawings={ALL_EXCHANGES.reduce(
              (sum, ex) => sum + (drawingsByExchange[ex]?.length || 0),
              0
            )}
            onSaveToAccount={handleManualSaveWorkspace}
            savedOllamaModel={ollamaModel}
            onChangeOllamaModel={setOllamaModel}
            savedOllamaBaseUrl={ollamaBaseUrl}
            onChangeOllamaBaseUrl={setOllamaBaseUrl}
          />
        </Suspense>
      ) : (
        <>
          {/* 2. Row 1 Toolbar: Full Timeframes (Tick + K-Line History) & Active Exchange Feeds */}
          <div className="control-toolbar">
        <div className="control-group">
          <span className="group-label">Tick:</span>
          <div className="segmented-btns">
            {TICK_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                className={timeframe === tf ? 'active' : ''}
                onClick={() => handleSelectTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="group-label">K-Line TF:</span>
          <div className="segmented-btns">
            {KLINE_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                className={timeframe === tf ? 'active' : ''}
                onClick={() => handleSelectTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="group-label">
            {exchange === 'combined'
              ? 'Merged:'
              : exchange === 'hyperliquid'
                ? 'HL Feeds:'
                : exchange === 'coinbase'
                  ? 'Coinbase:'
                  : exchange === 'okx'
                    ? 'OKX Feeds:'
                    : exchange === 'binance'
                      ? 'Binance:'
                      : 'Bybit:'}
          </span>
          <div className="segmented-btns">
            {scopeOptions.map((opt) => (
              <button
                key={opt.id}
                className={bookScope === opt.id ? 'active' : ''}
                onClick={() => handleSelectBookScope(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 3. Row 2 Toolbar: BTC Cluster Buckets, Price Step Grouping, Colormap & Layer Toggles */}
      <div className="control-toolbar secondary-toolbar">
        <div className="control-group">
          <span className="group-label">BTC Clusters:</span>
          <div className="segmented-btns">
            {BTC_CLUSTER_BUCKETS.map((b) => (
              <button
                key={b}
                className={clusterFilterBtc === b ? 'active' : ''}
                onClick={() => handleSelectClusterFilter(b)}
              >
                {b === 0 ? 'All' : `${b} BTC`}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="group-label">Step:</span>
          <select
            className="toolbar-select"
            value={priceStep}
            onChange={(e) => setPriceStep(Number(e.target.value) as PriceStep)}
            title="Price tick grouping interval"
          >
            {PRICE_STEP_OPTIONS.map((s) => (
              <option key={s} value={s}>
                ${s}
              </option>
            ))}
          </select>

          <select
            className="toolbar-select"
            value={colormap}
            onChange={(e) => setColormap(e.target.value as ColormapName)}
          >
            <option value="thermal">Thermal</option>
            <option value="viridis">Viridis</option>
            <option value="bidask">Bid/Ask</option>
          </select>
        </div>

        <div className="control-group contrast-group">
          <label className="checkbox-pill">
            <input
              type="checkbox"
              checked={autoContrast}
              onChange={(e) => setAutoContrast(e.target.checked)}
            />
            <span>Auto</span>
          </label>

          <div className="slider-item">
            <span>Min:{minFilterBtc}</span>
            <input
              type="range"
              min="0"
              max="50"
              step="0.5"
              value={minFilterBtc}
              onChange={(e) => {
                setAutoContrast(false);
                setMinFilterBtc(parseFloat(e.target.value));
              }}
            />
          </div>

          <div className="slider-item">
            <span>Max:{maxCeilingBtc}</span>
            <input
              type="range"
              min="1"
              max="250"
              step="1"
              value={maxCeilingBtc}
              onChange={(e) => {
                setAutoContrast(false);
                setMaxCeilingBtc(parseFloat(e.target.value));
              }}
            />
          </div>
        </div>

        <div className="control-group">
          <div className="segmented-btns">
            <button
              className={showCandlesticks ? 'active' : ''}
              onClick={() => setShowCandlesticks((v) => !v)}
            >
              Candles
            </button>
            <button
              className={showBidAskLines ? 'active' : ''}
              onClick={() => setShowBidAskLines((v) => !v)}
            >
              Bid/Ask
            </button>
            <button
              className={showTradeBubbles ? 'active' : ''}
              onClick={() => setShowTradeBubbles((v) => !v)}
            >
              Bubbles
            </button>
            <button
              className={showVolumePane ? 'active' : ''}
              onClick={() => setShowVolumePane((v) => !v)}
            >
              Vol/CVD
            </button>
            <button
              className={showVolumeProfile ? 'active' : ''}
              onClick={() => setShowVolumeProfile((v) => !v)}
              title="Toggle Session Volume Profile (POC / VAH / VAL)"
            >
              Profile
            </button>
            <button
              className={showLiquidations ? 'active' : ''}
              onClick={() => setShowLiquidations((v) => !v)}
              title="Toggle Forced Liquidation markers"
            >
              ⚡Liqs
            </button>
            <button
              className={showSpoofDelta ? 'active' : ''}
              onClick={() => setShowSpoofDelta((v) => !v)}
              title="Toggle 30s DOM Pull/Stack Spoof Delta column"
            >
              Δ30s
            </button>
          </div>
        </div>

        <div className="control-group right-actions">
          <select
            className="toolbar-select"
            value={whaleAlertBtc}
            onChange={(e) => setWhaleAlertBtc(Number(e.target.value))}
            title="Whale trade toast/sound alert threshold"
          >
            <option value={1}>Alert ≥1B</option>
            <option value={2}>Alert ≥2B</option>
            <option value={5}>Alert ≥5B</option>
            <option value={10}>Alert ≥10B</option>
            <option value={25}>Alert ≥25B</option>
          </select>
          <button
            className={`action-btn ${soundMuted ? '' : 'active'}`}
            onClick={() => setSoundMuted((m) => !m)}
            title="Toggle alert chime (M)"
          >
            {soundMuted ? '🔇' : '🔊'}
          </button>
          <button
            className={`action-btn ${isPaused ? 'btn-paused' : ''}`}
            onClick={() => setIsPaused((p) => !p)}
            title="Pause / Resume live stream (Space)"
          >
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
        </div>
      </div>

      {toasts.length > 0 && (
        <div className="alert-toast-stack">
          {toasts.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`alert-toast toast-${t.tone}`}
              onClick={() => {
                handleSelectWallPrice(t.price);
                setToasts((prev) => prev.filter((x) => x.id !== t.id));
              }}
            >
              <span className="alert-toast-title">{t.title}</span>
              <span className="alert-toast-detail">{t.detail}</span>
            </button>
          ))}
        </div>
      )}

      {/* 4. Main Split Workspace */}
      <main className="workspace-grid">
        <HeatmapCanvas
          exchange={exchange}
          slices={slices}
          currentBids={currentBids}
          currentAsks={currentAsks}
          bidClusters={bidClusters}
          askClusters={askClusters}
          ticker={ticker}
          priceStep={priceStep}
          bookScope={bookScope}
          timeframe={timeframe}
          isKlineTimeframe={isKlineTimeframe}
          colormap={colormap}
          minFilterBtc={minFilterBtc}
          maxCeilingBtc={maxCeilingBtc}
          showBidAskLines={showBidAskLines}
          showTradeBubbles={showTradeBubbles}
          showCandlesticks={showCandlesticks}
          showVolumePane={showVolumePane}
          showVolumeProfile={showVolumeProfile}
          showLiquidations={showLiquidations}
          showSpoofDelta={showSpoofDelta}
          isPaused={isPaused}
          autoFollowPrice={autoFollowPrice}
          onToggleAutoFollow={setAutoFollowPrice}
          highlightedPrice={highlightedPrice}
          priceAlertLevel={priceAlertLevel}
          onSetPriceAlert={setPriceAlertLevel}
          fitTrigger={fitTrigger}
          hotkeyAction={hotkeyAction}
        />

        <Sidebar
          exchange={exchange}
          ticker={ticker}
          bookScope={bookScope}
          clusterFilterBtc={clusterFilterBtc}
          onSelectClusterFilter={handleSelectClusterFilter}
          bidClusters={bidClusters}
          askClusters={askClusters}
          clusterSummary={clusterSummary}
          recentTrades={recentTrades}
          whaleTrades={whaleTrades}
          recentLiquidations={recentLiquidations}
          volumeDistribution={volumeDistribution}
          fundingRates={fundingRates}
          onSelectWallPrice={handleSelectWallPrice}
          onSwitchExchange={handleSwitchExchange}
        />
      </main>
        </>
      )}
    </div>
  );
};
