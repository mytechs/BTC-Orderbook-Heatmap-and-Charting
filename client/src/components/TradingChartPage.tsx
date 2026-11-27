import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AiKeyLevel,
  AiTradeIdea,
  ChartIndicatorFlags,
  ChartPageSettings,
  ChartViewportState,
  ExchangeId,
  HeatmapSlice,
  MagnetMode,
  TickerStats,
  TimeframeId,
} from '../../../shared/types.ts';
import { GeminiAnalysisPanel } from './GeminiAnalysisPanel.tsx';
import {
  type ChartDrawing,
  type ChartPoint,
  type CoordMapper,
  DRAWING_COLORS,
  type DrawingToolId,
  hitTestDrawing,
  loadDrawings,
  renderDrawing,
  renderMeasureBox,
  saveDrawings,
} from '../chartDrawings.ts';
import {
  type OhlcBar,
  calcBollinger,
  calcEMA,
  calcMACD,
  calcRSI,
  calcSMA,
  calcVWAP,
  slicesToBars,
  toHeikinAshi,
} from '../chartIndicators.ts';

type ChartStyleId = ChartPageSettings['chartStyle'];
type ScaleMode = ChartPageSettings['scaleMode'];
type IndicatorFlags = ChartIndicatorFlags;

interface TradingChartPageProps {
  exchange: ExchangeId;
  timeframe: TimeframeId;
  timeframeMs: number;
  slices: HeatmapSlice[];
  ticker: TickerStats;
  onSelectTimeframe: (tf: TimeframeId) => void;
  savedChartSettings: ChartPageSettings;
  onChangeChartSettings: (next: ChartPageSettings) => void;
  savedDrawings?: ChartDrawing[];
  onChangeDrawings: (ex: ExchangeId, next: ChartDrawing[]) => void;
  savedViewport?: ChartViewportState;
  onChangeViewport?: (key: string, vp: ChartViewportState) => void;
  authUsername?: string | null;
  syncStatus?: 'idle' | 'saving' | 'saved' | 'error';
  totalSavedDrawings?: number;
  onSaveToAccount?: () => void;
  savedOllamaModel?: string;
  onChangeOllamaModel?: (model: string) => void;
  savedOllamaBaseUrl?: string;
  onChangeOllamaBaseUrl?: (url: string) => void;
}

const KLINE_TFS: TimeframeId[] = [
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

const TOOL_BUTTONS: { id: DrawingToolId; icon: string; label: string; key: string }[] = [
  { id: 'cursor', icon: '✛', label: 'Crosshair / Select', key: 'Esc' },
  { id: 'trendline', icon: '╱', label: 'Trendline', key: 'T' },
  { id: 'ray', icon: '↗', label: 'Extended Ray', key: 'Y' },
  { id: 'hline', icon: '━', label: 'Horizontal Line (S/R)', key: 'H' },
  { id: 'hray', icon: '↦', label: 'Horizontal Ray', key: 'J' },
  { id: 'vline', icon: '│', label: 'Vertical Line', key: 'I' },
  { id: 'rect', icon: '▭', label: 'Rectangle / Zone', key: 'G' },
  { id: 'channel', icon: '⫽', label: 'Parallel Channel', key: 'C' },
  { id: 'fib', icon: '☰', label: 'Fib Retracement', key: 'X' },
  { id: 'long', icon: '▲R', label: 'Long Position (R:R)', key: 'L' },
  { id: 'short', icon: '▼R', label: 'Short Position (R:R)', key: 'S' },
  { id: 'measure', icon: '📏', label: 'Price/Time Ruler (Shift+Drag)', key: 'U' },
  { id: 'brush', icon: '✎', label: 'Freehand Brush', key: 'P' },
  { id: 'text', icon: 'T+', label: 'Text Annotation', key: 'N' },
];

const PRICE_AXIS_W = 80;
const TIME_AXIS_H = 24;
const VOL_H = 74;
const RSI_H = 88;
const MACD_H = 92;

const FMT_DAY = new Intl.DateTimeFormat(undefined, {
  year: '2-digit',
  month: 'short',
  day: '2-digit',
});
const FMT_HOUR = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: '2-digit',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
});
const FMT_MIN = new Intl.DateTimeFormat(undefined, {
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
});

function formatBarTime(ts: number, tf: TimeframeId): string {
  if (tf === '1d' || tf === '1w') return FMT_DAY.format(ts);
  if (tf === '1h' || tf === '2h' || tf === '4h' || tf === '6h' || tf === '12h') {
    return FMT_HOUR.format(ts);
  }
  return FMT_MIN.format(ts);
}

function formatCountdownMs(ms: number): string {
  if (ms <= 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function niceStep(span: number, targetTicks = 8): number {
  if (span <= 0 || !Number.isFinite(span)) return 10;
  const raw = span / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function normalizeMagnetMode(val: MagnetMode | boolean | undefined): MagnetMode {
  if (val === 'weak' || val === 'strong' || val === 'extra' || val === 'off') return val;
  return val ? 'weak' : 'off';
}

const MAGNET_OPTIONS: {
  id: MagnetMode;
  label: string;
  badge: string;
  desc: string;
  color: string;
}[] = [
  { id: 'off', label: 'Off', badge: '', desc: 'Free cursor placement', color: '#94a3b8' },
  { id: 'weak', label: 'Weak Magnet', badge: 'W', desc: 'Snaps within 38px of candle OHLC', color: '#38bdf8' },
  { id: 'strong', label: 'Strong Magnet', badge: 'S', desc: 'Always locks Y to hovered candle OHLC', color: '#f59e0b' },
  { id: 'extra', label: 'Extra Strong', badge: 'XS', desc: 'Wide 2D magnetic lock to nearest swing wick / OHLC', color: '#ec4899' },
];

const MAGNET_CYCLE: MagnetMode[] = ['off', 'weak', 'strong', 'extra'];

export const TradingChartPage: React.FC<TradingChartPageProps> = React.memo(({
  exchange,
  timeframe,
  timeframeMs,
  slices,
  ticker,
  onSelectTimeframe,
  savedChartSettings,
  onChangeChartSettings,
  savedDrawings,
  onChangeDrawings,
  savedViewport,
  onChangeViewport,
  authUsername,
  syncStatus,
  totalSavedDrawings,
  onSaveToAccount,
  savedOllamaModel,
  onChangeOllamaModel,
  savedOllamaBaseUrl,
  onChangeOllamaBaseUrl,
}) => {
  // Ensure we're on a K-line timeframe for normal charting
  useEffect(() => {
    if (!KLINE_TFS.includes(timeframe)) {
      onSelectTimeframe('15m');
    }
  }, [timeframe, onSelectTimeframe]);

  const [chartStyle, setChartStyle] = useState<ChartStyleId>(savedChartSettings.chartStyle);
  const [scaleMode, setScaleMode] = useState<ScaleMode>(savedChartSettings.scaleMode);
  const [autoScaleY, setAutoScaleY] = useState<boolean>(savedChartSettings.autoScaleY);
  const [indicators, setIndicators] = useState<IndicatorFlags>(savedChartSettings.indicators);

  // Drawing tool state
  const [activeTool, setActiveTool] = useState<DrawingToolId>('cursor');
  const [magnetMode, setMagnetMode] = useState<MagnetMode>(() =>
    normalizeMagnetMode(savedChartSettings.magnetMode)
  );
  const [magnetMenuPos, setMagnetMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [hideDrawings, setHideDrawings] = useState<boolean>(savedChartSettings.hideDrawings);
  const [drawColor, setDrawColor] = useState<string>(savedChartSettings.drawColor);
  const [drawWidth, setDrawWidth] = useState<number>(savedChartSettings.drawWidth);
  const [drawDashed, setDrawDashed] = useState<boolean>(savedChartSettings.drawDashed);
  const [drawingsState, setDrawingsState] = useState<{ owner: ExchangeId; list: ChartDrawing[] }>(
    () => ({
      owner: exchange,
      list: savedDrawings !== undefined ? savedDrawings : loadDrawings(exchange),
    })
  );
  const drawings =
    drawingsState.owner === exchange
      ? drawingsState.list
      : savedDrawings !== undefined
        ? savedDrawings
        : loadDrawings(exchange);

  const setDrawings = useCallback(
    (updater: ChartDrawing[] | ((prev: ChartDrawing[]) => ChartDrawing[])) => {
      const targetEx = stateRef.current.exchange;
      const baseList = stateRef.current.drawings;
      const nextList = typeof updater === 'function' ? updater(baseList) : updater;
      stateRef.current.drawings = nextList;
      setDrawingsState({ owner: targetEx, list: nextList });
      saveDrawings(targetEx, nextList);
      onChangeDrawings(targetEx, nextList);
    },
    [onChangeDrawings]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textModal, setTextModal] = useState<{
    point: ChartPoint;
    x: number;
    y: number;
    value: string;
  } | null>(null);
  const [isPannedBack, setIsPannedBack] = useState<boolean>(false);
  const [fullHistoryBars, setFullHistoryBars] = useState<OhlcBar[]>([]);
  const [loadingFullHistory, setLoadingFullHistory] = useState<boolean>(false);
  const [aiPanelOpen, setAiPanelOpen] = useState<boolean>(false);

  // Sync incoming savedChartSettings from account hydration
  const lastAppliedSettingsRef = useRef<string>(JSON.stringify(savedChartSettings));
  useEffect(() => {
    const serialized = JSON.stringify(savedChartSettings);
    if (serialized === lastAppliedSettingsRef.current) return;
    lastAppliedSettingsRef.current = serialized;
    setChartStyle(savedChartSettings.chartStyle);
    setScaleMode(savedChartSettings.scaleMode);
    setAutoScaleY(savedChartSettings.autoScaleY);
    setIndicators(savedChartSettings.indicators);
    setDrawColor(savedChartSettings.drawColor);
    setDrawWidth(savedChartSettings.drawWidth);
    setDrawDashed(savedChartSettings.drawDashed);
    setMagnetMode(normalizeMagnetMode(savedChartSettings.magnetMode));
    setHideDrawings(savedChartSettings.hideDrawings);
  }, [savedChartSettings]);

  // Propagate local chart settings changes up to App for server account persistence
  useEffect(() => {
    const next: ChartPageSettings = {
      chartStyle,
      scaleMode,
      autoScaleY,
      indicators,
      drawColor,
      drawWidth,
      drawDashed,
      magnetMode,
      hideDrawings,
    };
    const serialized = JSON.stringify(next);
    if (serialized !== lastAppliedSettingsRef.current) {
      lastAppliedSettingsRef.current = serialized;
      onChangeChartSettings(next);
    }
  }, [
    chartStyle,
    scaleMode,
    autoScaleY,
    indicators,
    drawColor,
    drawWidth,
    drawDashed,
    magnetMode,
    hideDrawings,
    onChangeChartSettings,
  ]);

  // Fetch complete paginated OHLCV history (up to 4,500 daily bars / multi-year history)
  useEffect(() => {
    if (!KLINE_TFS.includes(timeframe)) return;
    let active = true;
    setLoadingFullHistory(true);
    fetch(`/api/candles?exchange=${exchange}&timeframe=${timeframe}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { candles?: { t: number; o: number; h: number; l: number; c: number; vol: number }[] } | null) => {
        if (!active || !data || !Array.isArray(data.candles)) return;
        const bars: OhlcBar[] = data.candles.map((k) => {
          const isBull = k.c >= k.o;
          return {
            t: k.t,
            o: k.o,
            h: k.h,
            l: k.l,
            c: k.c,
            vol: k.vol,
            bv: isBull ? k.vol : 0,
            sv: isBull ? 0 : k.vol,
          };
        });
        setFullHistoryBars(bars);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingFullHistory(false);
      });
    return () => {
      active = false;
    };
  }, [exchange, timeframe]);

  // Sync drawings cleanly when switching exchange or hydrating from account (never overwrites across exchanges)
  useEffect(() => {
    const src = savedDrawings !== undefined ? savedDrawings : loadDrawings(exchange);
    setDrawingsState({ owner: exchange, list: src });
  }, [exchange, savedDrawings]);

  useEffect(() => {
    setSelectedId(null);
    setFullHistoryBars([]);
  }, [exchange]);

  // Blend full paginated historical bars with live streaming tail candles (O(1) tail scan)
  const rawBars = useMemo(() => {
    if (fullHistoryBars.length === 0) return slicesToBars(slices);
    if (slices.length === 0) return fullHistoryBars;

    const lastHist = fullHistoryBars[fullHistoryBars.length - 1];
    // Walk backward from the tail of slices to find only the few bars >= lastHist.t
    let startIdx = slices.length;
    while (startIdx > 0 && slices[startIdx - 1].t >= lastHist.t) {
      startIdx--;
    }
    if (startIdx >= slices.length) return fullHistoryBars;

    const merged = fullHistoryBars.slice();
    for (let i = startIdx; i < slices.length; i++) {
      const s = slices[i];
      const vol = Math.round((s.bv + s.sv) * 10000) / 10000;
      const tail = merged[merged.length - 1];
      if (s.t === tail.t) {
        merged[merged.length - 1] = {
          ...tail,
          h: Math.max(tail.h, s.h),
          l: Math.min(tail.l, s.l),
          c: s.c,
          vol: Math.max(tail.vol, vol),
          bv: s.bv,
          sv: s.sv,
        };
      } else if (s.t > tail.t) {
        merged.push({
          t: s.t,
          o: s.o,
          h: s.h,
          l: s.l,
          c: s.c,
          vol,
          bv: s.bv,
          sv: s.sv,
        });
      }
    }
    return merged;
  }, [fullHistoryBars, slices]);
  const displayBars = useMemo(
    () => (chartStyle === 'heikin' ? toHeikinAshi(rawBars) : rawBars),
    [rawBars, chartStyle]
  );

  // Precompute indicators when bars or flags change
  const computedInd = useMemo(() => {
    const closes = displayBars.map((b) => b.c);
    const vols = displayBars.map((b) => b.vol);
    return {
      ema9: indicators.ema9 ? calcEMA(closes, 9) : null,
      ema21: indicators.ema21 ? calcEMA(closes, 21) : null,
      ema50: indicators.ema50 ? calcEMA(closes, 50) : null,
      ema200: indicators.ema200 ? calcEMA(closes, 200) : null,
      sma20: indicators.sma20 ? calcSMA(closes, 20) : null,
      ma50: indicators.ma50 ? calcSMA(closes, 50) : null,
      ma100: indicators.ma100 ? calcSMA(closes, 100) : null,
      ma200: indicators.ma200 ? calcSMA(closes, 200) : null,
      vwap: indicators.vwap ? calcVWAP(displayBars) : null,
      bb: indicators.bb ? calcBollinger(closes, 20, 2) : null,
      volMa: indicators.volume ? calcSMA(vols, 20) : null,
      rsi: indicators.rsi ? calcRSI(closes, 14) : null,
      macd: indicators.macd ? calcMACD(closes, 12, 26, 9) : null,
    };
  }, [displayBars, indicators]);

  // Viewport refs (60fps canvas loop)
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasSizeRef = useRef<{ w: number; h: number }>({ w: 1000, h: 640 });
  const barWidthRef = useRef<number>(savedViewport?.barWidth || 9);
  const rightOffsetBarsRef = useRef<number>(savedViewport?.rightOffsetBars ?? 10); // positive = whitespace on right; negative = panned left
  const manualPriceRangeRef = useRef<{ min: number; max: number }>(
    savedViewport?.manualPriceRange && savedViewport.manualPriceRange.max > savedViewport.manualPriceRange.min
      ? { ...savedViewport.manualPriceRange }
      : { min: 0, max: 0 }
  );
  const activePriceRangeRef = useRef<{ min: number; max: number }>({ min: 0, max: 0 });
  const viewportSaveTimerRef = useRef<number | null>(null);
  const lastViewportSigRef = useRef<string>('');
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const requestRedrawRef = useRef<() => void>(() => {});
  const requestRedraw = useCallback(() => {
    requestRedrawRef.current();
  }, []);

  const scheduleViewportSave = useCallback(() => {
    if (!onChangeViewport) return;
    if (viewportSaveTimerRef.current) window.clearTimeout(viewportSaveTimerRef.current);
    viewportSaveTimerRef.current = window.setTimeout(() => {
      const key = `${stateRef.current.exchange}:${stateRef.current.timeframe}`;
      const manual =
        !stateRef.current.autoScaleY &&
        manualPriceRangeRef.current.max > manualPriceRangeRef.current.min
          ? {
              min: +manualPriceRangeRef.current.min.toFixed(2),
              max: +manualPriceRangeRef.current.max.toFixed(2),
            }
          : null;
      const vp: ChartViewportState = {
        barWidth: +barWidthRef.current.toFixed(2),
        rightOffsetBars: +rightOffsetBarsRef.current.toFixed(2),
        manualPriceRange: manual,
      };
      lastViewportSigRef.current = `${key}:${JSON.stringify(vp)}`;
      onChangeViewport(key, vp);
    }, 350);
  }, [onChangeViewport]);

  // Restore saved zoom, pan & manual Y-axis scale when switching exchange/timeframe or hydrating account
  useEffect(() => {
    const key = `${exchange}:${timeframe}`;
    const sig = `${key}:${JSON.stringify(savedViewport || null)}`;
    if (sig === lastViewportSigRef.current) return;
    lastViewportSigRef.current = sig;

    if (savedViewport) {
      barWidthRef.current = Math.max(0.5, Math.min(48, savedViewport.barWidth || 9));
      rightOffsetBarsRef.current = Number.isFinite(savedViewport.rightOffsetBars)
        ? savedViewport.rightOffsetBars
        : 10;
      if (
        savedViewport.manualPriceRange &&
        savedViewport.manualPriceRange.max > savedViewport.manualPriceRange.min
      ) {
        manualPriceRangeRef.current = { ...savedViewport.manualPriceRange };
      } else {
        manualPriceRangeRef.current = { min: 0, max: 0 };
      }
      setIsPannedBack(rightOffsetBarsRef.current < -3);
      requestRedraw();
    } else {
      barWidthRef.current = 9;
      rightOffsetBarsRef.current = 10;
      manualPriceRangeRef.current = { min: 0, max: 0 };
      setIsPannedBack(false);
      requestRedraw();
    }
  }, [exchange, timeframe, savedViewport, requestRedraw]);

  useEffect(() => {
    return () => {
      if (viewportSaveTimerRef.current) window.clearTimeout(viewportSaveTimerRef.current);
    };
  }, []);

  // Active interaction refs
  const draftDrawingRef = useRef<ChartDrawing | null>(null);
  const draggingDrawingRef = useRef<ChartDrawing | null>(null);
  const measureRef = useRef<{ p1: ChartPoint; p2: ChartPoint } | null>(null);
  const dragStateRef = useRef<
    | null
    | { mode: 'pan'; startX: number; startY: number; origRight: number; origMin: number; origMax: number }
    | { mode: 'scaleY'; startY: number; origMin: number; origMax: number }
    | { mode: 'anchor'; drawingId: string; anchorIndex: number }
    | {
        mode: 'moveDrawing';
        drawingId: string;
        startTime: number;
        startPrice: number;
        origPoints: ChartPoint[];
      }
    | { mode: 'brush'; drawing: ChartDrawing }
    | { mode: 'measure'; p1: ChartPoint }
  >(null);

  const stateRef = useRef({
    displayBars,
    rawBars,
    computedInd,
    chartStyle,
    scaleMode,
    autoScaleY,
    indicators,
    timeframe,
    timeframeMs,
    ticker,
    exchange,
    drawings,
    selectedId,
    hideDrawings,
    activeTool,
    magnetMode,
    drawColor,
    drawWidth,
    drawDashed,
  });

  stateRef.current = {
    displayBars,
    rawBars,
    computedInd,
    chartStyle,
    scaleMode,
    autoScaleY,
    indicators,
    timeframe,
    timeframeMs,
    ticker,
    exchange,
    drawings,
    selectedId,
    hideDrawings,
    activeTool,
    magnetMode,
    drawColor,
    drawWidth,
    drawDashed,
  };

  useEffect(() => {
    requestRedraw();
  }, [
    displayBars,
    computedInd,
    chartStyle,
    scaleMode,
    autoScaleY,
    indicators,
    timeframe,
    ticker,
    drawings,
    selectedId,
    hideDrawings,
    activeTool,
    magnetMode,
    requestRedraw,
  ]);

  // Helper: get layout pane heights
  const getLayout = useCallback(() => {
    const { w, h } = canvasSizeRef.current;
    const ind = stateRef.current.indicators;
    const chartW = Math.max(200, w - PRICE_AXIS_W);
    const volH = ind.volume ? VOL_H : 0;
    const rsiH = ind.rsi ? RSI_H : 0;
    const macdH = ind.macd ? MACD_H : 0;
    const mainH = Math.max(160, h - TIME_AXIS_H - volH - rsiH - macdH);
    const volTop = mainH;
    const rsiTop = volTop + volH;
    const macdTop = rsiTop + rsiH;
    const timeAxisTop = macdTop + macdH;
    return { w, h, chartW, mainH, volTop, volH, rsiTop, rsiH, macdTop, macdH, timeAxisTop };
  }, []);

  // Coordinate mapping helpers
  const buildMapper = useCallback((): CoordMapper & {
    xToIndex: (x: number) => number;
    indexToX: (idx: number) => number;
    xToTime: (x: number) => number;
    yToPrice: (y: number) => number;
    snapPoint: (x: number, y: number) => ChartPoint;
    snapPointDetailed: (
      x: number,
      y: number
    ) => {
      point: ChartPoint;
      snapped: boolean;
      snapX: number;
      snapY: number;
      kind?: 'O' | 'H' | 'L' | 'C';
    };
  } => {
    const { chartW, mainH } = getLayout();
    const bars = stateRef.current.displayBars;
    const tfMs = Math.max(1000, stateRef.current.timeframeMs || 900_000);
    const bw = barWidthRef.current;
    const rightOff = rightOffsetBarsRef.current;
    const n = bars.length;

    const indexToX = (idx: number) => chartW - (n - 1 - idx + rightOff + 0.5) * bw;
    const xToIndex = (x: number) => n - 1 + rightOff - (chartW - x) / bw + 0.5;

    const timeToX = (time: number) => {
      if (n === 0) return chartW / 2;
      const lastBar = bars[n - 1];
      if (time >= lastBar.t) {
        const diffBars = (time - lastBar.t) / tfMs;
        return indexToX(n - 1 + diffBars);
      }
      if (time <= bars[0].t) {
        const diffBars = (bars[0].t - time) / tfMs;
        return indexToX(-diffBars);
      }
      // Binary search bar index
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (bars[mid].t < time) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && bars[lo].t > time) {
        const t0 = bars[lo - 1].t;
        const t1 = bars[lo].t;
        const frac = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
        return indexToX(lo - 1 + frac);
      }
      return indexToX(lo);
    };

    const xToTime = (x: number) => {
      if (n === 0) return Date.now();
      const fIdx = xToIndex(x);
      if (fIdx <= 0) return bars[0].t + Math.round(fIdx * tfMs);
      if (fIdx >= n - 1) return bars[n - 1].t + Math.round((fIdx - (n - 1)) * tfMs);
      const i0 = Math.floor(fIdx);
      const frac = fIdx - i0;
      return Math.round(bars[i0].t + frac * (bars[i0 + 1].t - bars[i0].t));
    };

    const { min, max } = activePriceRangeRef.current;
    const safeMin = min > 0 ? min : 1;
    const safeMax = max > safeMin ? max : safeMin + 100;
    const isLog = stateRef.current.scaleMode === 'log';
    const logMin = Math.log(Math.max(1e-4, safeMin));
    const logMax = Math.log(Math.max(safeMin + 1e-4, safeMax));

    const priceToY = (price: number) => {
      if (isLog) {
        const lp = Math.log(Math.max(1e-4, price));
        return ((logMax - lp) / (logMax - logMin)) * mainH;
      }
      return ((safeMax - price) / (safeMax - safeMin)) * mainH;
    };

    const yToPrice = (y: number) => {
      const frac = y / Math.max(1, mainH);
      if (isLog) {
        return Math.exp(logMax - frac * (logMax - logMin));
      }
      return safeMax - frac * (safeMax - safeMin);
    };

    const snapPointDetailed = (x: number, y: number) => {
      const time = xToTime(x);
      const rawPrice = yToPrice(y);
      const mode = stateRef.current.magnetMode;
      if (mode === 'off' || n === 0) {
        return { point: { time, price: +rawPrice.toFixed(2) }, snapped: false, snapX: x, snapY: y };
      }

      const rawIdx = xToIndex(x);
      const centerIdx = Math.max(0, Math.min(n - 1, Math.round(rawIdx)));
      const KINDS: ('O' | 'H' | 'L' | 'C')[] = ['O', 'H', 'L', 'C'];

      if (mode === 'weak') {
        // Weak magnet: snap to nearest O/H/L/C within 38px across hovered & adjacent candles
        const minI = Math.max(0, centerIdx - 1);
        const maxI = Math.min(n - 1, centerIdx + 1);
        let bestDist = 38;
        let best: { time: number; price: number; snapX: number; snapY: number; kind: 'O' | 'H' | 'L' | 'C' } | null = null;
        for (let i = minI; i <= maxI; i++) {
          const b = bars[i];
          const bx = indexToX(i);
          const dx = Math.abs(bx - x);
          if (dx > Math.max(30, bw * 1.2)) continue;
          const vals = [b.o, b.h, b.l, b.c];
          for (let k = 0; k < 4; k++) {
            const py = priceToY(vals[k]);
            const dist = Math.hypot(dx, py - y);
            if (dist < bestDist) {
              bestDist = dist;
              best = { time: b.t, price: +vals[k].toFixed(2), snapX: bx, snapY: py, kind: KINDS[k] };
            }
          }
        }
        if (best) {
          return {
            point: { time: best.time, price: best.price },
            snapped: true,
            snapX: best.snapX,
            snapY: best.snapY,
            kind: best.kind,
          };
        }
        return { point: { time, price: +rawPrice.toFixed(2) }, snapped: false, snapX: x, snapY: y };
      }

      if (mode === 'strong') {
        // Strong magnet (TradingView-style): always locks vertically to nearest OHLC of the candle under cursor
        const b = bars[centerIdx];
        const bx = indexToX(centerIdx);
        // If cursor is far into empty future whitespace beyond the last bar, don't force X back unless close
        const inBarBand = Math.abs(bx - x) <= Math.max(40, bw * 1.5);
        const vals = [b.o, b.h, b.l, b.c];
        let bestDy = Infinity;
        let bestK = 0;
        let bestY = y;
        for (let k = 0; k < 4; k++) {
          const py = priceToY(vals[k]);
          const dy = Math.abs(py - y);
          if (dy < bestDy) {
            bestDy = dy;
            bestK = k;
            bestY = py;
          }
        }
        return {
          point: { time: inBarBand ? b.t : time, price: +vals[bestK].toFixed(2) },
          snapped: true,
          snapX: inBarBand ? bx : x,
          snapY: bestY,
          kind: KINDS[bestK],
        };
      }

      // Extra Strong magnet: wide 2D magnetic lock across ±90px of nearby candles,
      // prioritizing prominent swing highs/lows & wick extremes with unlimited vertical pull!
      const barRadius = Math.max(2, Math.min(45, Math.ceil(90 / Math.max(1, bw))));
      const minI = Math.max(0, centerIdx - barRadius);
      const maxI = Math.min(n - 1, centerIdx + barRadius);

      // Detect local highest high and lowest low within the magnetic search window
      let winHighIdx = centerIdx;
      let winLowIdx = centerIdx;
      for (let i = minI; i <= maxI; i++) {
        if (bars[i].h > bars[winHighIdx].h) winHighIdx = i;
        if (bars[i].l < bars[winLowIdx].l) winLowIdx = i;
      }

      let bestScore = Infinity;
      let best: { time: number; price: number; snapX: number; snapY: number; kind: 'O' | 'H' | 'L' | 'C' } | null = null;
      for (let i = minI; i <= maxI; i++) {
        const b = bars[i];
        const bx = indexToX(i);
        const dx = Math.abs(bx - x);
        if (dx > 96 && i !== centerIdx) continue;
        const vals = [b.o, b.h, b.l, b.c];
        for (let k = 0; k < 4; k++) {
          const py = priceToY(vals[k]);
          const dy = Math.abs(py - y);
          // Favor wick highs/lows and strongly pull toward local window swing high/low
          let weight = k === 1 || k === 2 ? 0.78 : 1.08;
          if ((k === 1 && i === winHighIdx) || (k === 2 && i === winLowIdx)) {
            weight = 0.45;
          }
          const score = Math.hypot(dx * 0.85, dy) * weight;
          if (score < bestScore) {
            bestScore = score;
            best = { time: b.t, price: +vals[k].toFixed(2), snapX: bx, snapY: py, kind: KINDS[k] };
          }
        }
      }

      if (best) {
        return {
          point: { time: best.time, price: best.price },
          snapped: true,
          snapX: best.snapX,
          snapY: best.snapY,
          kind: best.kind,
        };
      }
      return { point: { time, price: +rawPrice.toFixed(2) }, snapped: false, snapX: x, snapY: y };
    };

    const snapPoint = (x: number, y: number): ChartPoint => snapPointDetailed(x, y).point;

    return {
      chartW,
      chartH: mainH,
      timeToX,
      priceToY,
      xToIndex,
      indexToX,
      xToTime,
      yToPrice,
      snapPoint,
      snapPointDetailed,
    };
  }, [getLayout]);

  // Delete selected drawing / Undo / Hotkeys
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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        setDrawings((prev) => prev.slice(0, -1));
        setSelectedId(null);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'Escape') {
        draftDrawingRef.current = null;
        draggingDrawingRef.current = null;
        measureRef.current = null;
        setActiveTool('cursor');
        setSelectedId(null);
        setTextModal(null);
        setMagnetMenuPos(null);
        requestRedraw();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && stateRef.current.selectedId) {
        e.preventDefault();
        const delId = stateRef.current.selectedId;
        setDrawings((prev) => prev.filter((d) => d.id !== delId));
        setSelectedId(null);
      } else if (e.key.toUpperCase() === 'M') {
        setMagnetMode((prev) => MAGNET_CYCLE[(MAGNET_CYCLE.indexOf(prev) + 1) % MAGNET_CYCLE.length]);
      } else {
        const k = e.key.toUpperCase();
        const match = TOOL_BUTTONS.find((t) => t.key === k);
        if (match) {
          draftDrawingRef.current = null;
          setActiveTool(match.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Mouse & Wheel handlers
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const { chartW } = getLayout();

      if (mx > chartW) {
        // Zoom Y-axis directly when scrolling on price axis
        const cur = activePriceRangeRef.current;
        const mid = (cur.min + cur.max) / 2;
        const half = ((cur.max - cur.min) / 2) * (e.deltaY > 0 ? 1.12 : 0.89);
        setAutoScaleY(false);
        manualPriceRangeRef.current = { min: Math.max(1, mid - half), max: mid + half };
        requestRedraw();
        scheduleViewportSave();
        return;
      }

      // TradingView-style horizontal zoom anchored at cursor bar
      const mapper = buildMapper();
      const anchorIdx = mapper.xToIndex(mx);
      const factor = e.deltaY > 0 ? 0.88 : 1.14;
      const nextBw = Math.max(0.5, Math.min(48, barWidthRef.current * factor));
      barWidthRef.current = nextBw;

      const n = stateRef.current.displayBars.length;
      const nextRight = anchorIdx - (n - 1) + (chartW - mx) / nextBw - 0.5;
      rightOffsetBarsRef.current = Math.max(-n + 5, Math.min(80, nextRight));
      setIsPannedBack(rightOffsetBarsRef.current < -3);
      requestRedraw();
      scheduleViewportSave();
    },
    [buildMapper, getLayout, requestRedraw, scheduleViewportSave]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { chartW, mainH } = getLayout();
      const mapper = buildMapper();

      // Dragging on right price axis => manual Y zoom
      if (mx > chartW && my <= mainH) {
        const cur = activePriceRangeRef.current;
        setAutoScaleY(false);
        manualPriceRangeRef.current = { ...cur };
        dragStateRef.current = { mode: 'scaleY', startY: my, origMin: cur.min, origMax: cur.max };
        return;
      }

      if (my > mainH) {
        // Pan horizontally when dragging sub-panes or time axis
        const cur = activePriceRangeRef.current;
        dragStateRef.current = {
          mode: 'pan',
          startX: mx,
          startY: my,
          origRight: rightOffsetBarsRef.current,
          origMin: cur.min,
          origMax: cur.max,
        };
        return;
      }

      const tool = stateRef.current.activeTool;

      // Shift+Drag in cursor mode OR measure tool => Ruler
      if (tool === 'measure' || (tool === 'cursor' && e.shiftKey)) {
        const p1 = mapper.snapPoint(mx, my);
        measureRef.current = { p1, p2: p1 };
        dragStateRef.current = { mode: 'measure', p1 };
        requestRedraw();
        return;
      }

      // Cursor mode: check drawing hit -> drag anchor / move drawing -> else pan chart
      if (tool === 'cursor') {
        if (!stateRef.current.hideDrawings) {
          const list = stateRef.current.drawings;
          for (let i = list.length - 1; i >= 0; i--) {
            const d = list[i];
            const res = hitTestDrawing(d, mx, my, mapper);
            if (res.hit) {
              setSelectedId(d.id);
              draggingDrawingRef.current = { ...d, points: d.points.map((p) => ({ ...p })) };
              if (res.anchorIndex >= 0) {
                dragStateRef.current = {
                  mode: 'anchor',
                  drawingId: d.id,
                  anchorIndex: res.anchorIndex,
                };
              } else {
                dragStateRef.current = {
                  mode: 'moveDrawing',
                  drawingId: d.id,
                  startTime: mapper.xToTime(mx),
                  startPrice: mapper.yToPrice(my),
                  origPoints: d.points.map((p) => ({ ...p })),
                };
              }
              requestRedraw();
              return;
            }
          }
        }

        setSelectedId(null);
        measureRef.current = null;
        const cur = activePriceRangeRef.current;
        dragStateRef.current = {
          mode: 'pan',
          startX: mx,
          startY: my,
          origRight: rightOffsetBarsRef.current,
          origMin: cur.min,
          origMax: cur.max,
        };
        requestRedraw();
        return;
      }

      // Drawing placement
      const pt = mapper.snapPoint(mx, my);
      const id = `drw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const baseStyle = {
        color: stateRef.current.drawColor,
        lineWidth: stateRef.current.drawWidth,
        dashed: stateRef.current.drawDashed,
      };

      // 1-click tools
      if (tool === 'hline' || tool === 'hray' || tool === 'vline') {
        const newD: ChartDrawing = { id, type: tool, points: [pt], ...baseStyle };
        setDrawings((prev) => [...prev, newD]);
        setSelectedId(id);
        setActiveTool('cursor');
        return;
      }

      if (tool === 'text') {
        setTextModal({ point: pt, x: mx, y: my, value: '' });
        return;
      }

      if (tool === 'long' || tool === 'short') {
        const isLong = tool === 'long';
        const span = Math.max(50, (activePriceRangeRef.current.max - activePriceRangeRef.current.min) * 0.12);
        const tfMs = Math.max(60_000, stateRef.current.timeframeMs || 900_000);
        const endT = pt.time + tfMs * 16;
        const tpPt: ChartPoint = {
          time: endT,
          price: +(isLong ? pt.price + span * 1.4 : pt.price - span * 1.4).toFixed(2),
        };
        const slPt: ChartPoint = {
          time: endT,
          price: +(isLong ? pt.price - span * 0.7 : pt.price + span * 0.7).toFixed(2),
        };
        const newD: ChartDrawing = {
          id,
          type: tool,
          points: [pt, tpPt, slPt],
          color: isLong ? '#10b981' : '#f43f5e',
          lineWidth: 1.5,
        };
        setDrawings((prev) => [...prev, newD]);
        setSelectedId(id);
        setActiveTool('cursor');
        return;
      }

      if (tool === 'brush') {
        const newD: ChartDrawing = { id, type: 'brush', points: [pt], ...baseStyle };
        draftDrawingRef.current = newD;
        dragStateRef.current = { mode: 'brush', drawing: newD };
        requestRedraw();
        return;
      }

      // Multi-point tools: trendline, ray, rect, fib (2 pts), channel (3 pts)
      const draft = draftDrawingRef.current;
      if (!draft || draft.type !== tool) {
        draftDrawingRef.current = { id, type: tool, points: [pt, pt], ...baseStyle };
        requestRedraw();
        return;
      }

      if (tool === 'channel') {
        if (draft.points.length === 2) {
          draft.points = [draft.points[0], pt, pt];
          requestRedraw();
          return;
        }
        const finished: ChartDrawing = {
          ...draft,
          points: [draft.points[0], draft.points[1], pt],
        };
        draftDrawingRef.current = null;
        setDrawings((prev) => [...prev, finished]);
        setSelectedId(finished.id);
        setActiveTool('cursor');
        return;
      }

      // Complete 2-point drawing
      const finished: ChartDrawing = { ...draft, points: [draft.points[0], pt] };
      draftDrawingRef.current = null;
      setDrawings((prev) => [...prev, finished]);
      setSelectedId(finished.id);
      setActiveTool('cursor');
    },
    [buildMapper, getLayout, requestRedraw]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      mouseRef.current = { x: mx, y: my };
      requestRedraw();

      const mapper = buildMapper();
      const drag = dragStateRef.current;

      if (drag) {
        if (drag.mode === 'pan') {
          const dx = mx - drag.startX;
          const dy = my - drag.startY;
          const n = stateRef.current.displayBars.length;
          rightOffsetBarsRef.current = Math.max(
            -n + 5,
            Math.min(80, drag.origRight - dx / barWidthRef.current)
          );
          setIsPannedBack(rightOffsetBarsRef.current < -3);

          if (!stateRef.current.autoScaleY) {
            const { mainH } = getLayout();
            const span = drag.origMax - drag.origMin;
            const dPrice = (dy / Math.max(1, mainH)) * span;
            manualPriceRangeRef.current = {
              min: drag.origMin + dPrice,
              max: drag.origMax + dPrice,
            };
          }
          return;
        }

        if (drag.mode === 'scaleY') {
          const dy = my - drag.startY;
          const factor = Math.pow(1.006, dy);
          const mid = (drag.origMin + drag.origMax) / 2;
          const half = ((drag.origMax - drag.origMin) / 2) * factor;
          manualPriceRangeRef.current = { min: Math.max(1, mid - half), max: mid + half };
          return;
        }

        if (drag.mode === 'measure') {
          measureRef.current = { p1: drag.p1, p2: mapper.snapPoint(mx, my) };
          return;
        }

        if (drag.mode === 'brush') {
          const pt = { time: mapper.xToTime(mx), price: +mapper.yToPrice(my).toFixed(2) };
          const pts = drag.drawing.points;
          const last = pts[pts.length - 1];
          if (!last || Math.hypot(mapper.timeToX(last.time) - mx, mapper.priceToY(last.price) - my) >= 3) {
            pts.push(pt);
          }
          return;
        }

        if (drag.mode === 'anchor') {
          const pt = mapper.snapPoint(mx, my);
          const cur = draggingDrawingRef.current;
          if (cur && cur.id === drag.drawingId) {
            cur.points[drag.anchorIndex] = pt;
          }
          return;
        }

        if (drag.mode === 'moveDrawing') {
          const cur = draggingDrawingRef.current;
          if (cur && cur.id === drag.drawingId) {
            if (cur.points.length === 1 && stateRef.current.magnetMode !== 'off') {
              cur.points = [mapper.snapPoint(mx, my)];
            } else {
              const dt = mapper.xToTime(mx) - drag.startTime;
              const dp = mapper.yToPrice(my) - drag.startPrice;
              cur.points = drag.origPoints.map((p) => ({
                time: Math.round(p.time + dt),
                price: +(p.price + dp).toFixed(2),
              }));
            }
          }
          return;
        }
      }

      // Live preview for multi-point draft drawing
      const draft = draftDrawingRef.current;
      if (draft) {
        const pt = mapper.snapPoint(mx, my);
        draft.points[draft.points.length - 1] = pt;
      }
    },
    [buildMapper, getLayout, requestRedraw]
  );

  const handleMouseUp = useCallback(() => {
    const drag = dragStateRef.current;
    if (drag?.mode === 'brush') {
      const finished = drag.drawing;
      draftDrawingRef.current = null;
      if (finished.points.length >= 2) {
        setDrawings((prev) => [...prev, finished]);
      }
    } else if (drag?.mode === 'anchor' || drag?.mode === 'moveDrawing') {
      const committed = draggingDrawingRef.current;
      draggingDrawingRef.current = null;
      if (committed) {
        setDrawings((prev) =>
          prev.map((d) =>
            d.id === committed.id
              ? { ...committed, points: committed.points.map((p) => ({ ...p })) }
              : d
          )
        );
      }
    } else if (drag?.mode === 'pan' || drag?.mode === 'scaleY') {
      scheduleViewportSave();
    }
    dragStateRef.current = null;
  }, [setDrawings, scheduleViewportSave]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const { chartW } = getLayout();
      if (mx > chartW) {
        setAutoScaleY(true);
        manualPriceRangeRef.current = { min: 0, max: 0 };
        requestRedraw();
        scheduleViewportSave();
      } else {
        // Double-click chart resets view to auto-scale + latest candles
        setAutoScaleY(true);
        manualPriceRangeRef.current = { min: 0, max: 0 };
        rightOffsetBarsRef.current = 10;
        barWidthRef.current = 9;
        setIsPannedBack(false);
        requestRedraw();
        scheduleViewportSave();
      }
    },
    [getLayout, requestRedraw, scheduleViewportSave]
  );

  const handleExportPng = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `btc-${exchange}-${timeframe}-chart.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, [exchange, timeframe]);

  const handlePlotAiLevel = useCallback(
    (level: AiKeyLevel) => {
      const bars = stateRef.current.displayBars;
      const anchorTime = bars.length > 0 ? bars[bars.length - 1].t : Date.now();
      const color =
        level.type === 'Support'
          ? '#34d399'
          : level.type === 'Resistance'
            ? '#f43f5e'
            : level.type === 'Liquidity Wall'
              ? '#f59e0b'
              : '#38bdf8';
      const newD: ChartDrawing = {
        id: `ai-lvl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'hline',
        points: [{ time: anchorTime, price: +level.price.toFixed(1) }],
        color,
        lineWidth: level.strength === 'Strong' ? 2 : 1,
        dashed: level.strength !== 'Strong',
      };
      setDrawings((prev) => [...prev, newD]);
      setSelectedId(newD.id);
    },
    [setDrawings]
  );

  const handlePlotAllAiLevels = useCallback(
    (levels: AiKeyLevel[]) => {
      const bars = stateRef.current.displayBars;
      const anchorTime = bars.length > 0 ? bars[bars.length - 1].t : Date.now();
      const stamp = Date.now();
      setDrawings((prev) => {
        const filtered = prev.filter((d) => !d.id.startsWith('ai-lvl-'));
        const added: ChartDrawing[] = levels.map((lv, idx) => ({
          id: `ai-lvl-${stamp}-${idx}`,
          type: 'hline',
          points: [{ time: anchorTime, price: +lv.price.toFixed(1) }],
          color:
            lv.type === 'Support'
              ? '#34d399'
              : lv.type === 'Resistance'
                ? '#f43f5e'
                : lv.type === 'Liquidity Wall'
                  ? '#f59e0b'
                  : '#38bdf8',
          lineWidth: lv.strength === 'Strong' ? 2 : 1,
          dashed: lv.strength !== 'Strong',
        }));
        return [...filtered, ...added];
      });
    },
    [setDrawings]
  );

  const handlePlotAiTradeIdea = useCallback(
    (idea: AiTradeIdea) => {
      const bars = stateRef.current.displayBars;
      const tfMs = Math.max(60_000, stateRef.current.timeframeMs || 900_000);
      const startTime = bars.length > 0 ? bars[bars.length - 1].t : Date.now();
      const endTime = startTime + tfMs * 22;
      const primaryTp = idea.takeProfits[idea.takeProfits.length > 1 ? 1 : 0] || idea.entryPrice;
      const stamp = Date.now();
      const posDrawing: ChartDrawing = {
        id: `ai-trade-${stamp}`,
        type: idea.direction === 'Long' ? 'long' : 'short',
        points: [
          { time: startTime, price: +idea.entryPrice.toFixed(1) },
          { time: endTime, price: +primaryTp.toFixed(1) },
          { time: endTime, price: +idea.stopLoss.toFixed(1) },
        ],
        color: idea.direction === 'Long' ? '#10b981' : '#f43f5e',
        lineWidth: 1.5,
      };
      const extraTps: ChartDrawing[] = idea.takeProfits
        .filter((tp) => Math.abs(tp - primaryTp) > 0.5)
        .map((tp, idx) => ({
          id: `ai-tp-${stamp}-${idx}`,
          type: 'hray',
          points: [{ time: startTime, price: +tp.toFixed(1) }],
          color: '#34d399',
          lineWidth: 1,
          dashed: true,
        }));
      setDrawings((prev) => [...prev, posDrawing, ...extraTps]);
      setSelectedId(posDrawing.id);
    },
    [setDrawings]
  );

  const handleClearAiPlots = useCallback(() => {
    setDrawings((prev) => prev.filter((d) => !d.id.startsWith('ai-')));
    setSelectedId(null);
  }, [setDrawings]);

  const handleApplyColor = useCallback((color: string) => {
    setDrawColor(color);
    const sel = stateRef.current.selectedId;
    if (sel) {
      setDrawings((prev) => prev.map((d) => (d.id === sel ? { ...d, color } : d)));
    }
  }, []);

  const handleApplyWidth = useCallback((lineWidth: number) => {
    setDrawWidth(lineWidth);
    const sel = stateRef.current.selectedId;
    if (sel) {
      setDrawings((prev) => prev.map((d) => (d.id === sel ? { ...d, lineWidth } : d)));
    }
  }, []);

  const handleToggleDashed = useCallback(() => {
    setDrawDashed((prev) => {
      const next = !prev;
      const sel = stateRef.current.selectedId;
      if (sel) {
        setDrawings((list) => list.map((d) => (d.id === sel ? { ...d, dashed: next } : d)));
      }
      return next;
    });
  }, []);

  // Demand-driven Canvas Render Loop (0% idle CPU, coalesces high-frequency events to 1 rAF)
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let rafId = 0;

    const scheduleRender = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        render();
      });
    };
    requestRedrawRef.current = scheduleRender;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(300, Math.floor(rect.width));
      const h = Math.max(260, Math.floor(rect.height));
      canvasSizeRef.current = { w, h };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      scheduleRender();
    };

    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(container);

    // 1s heartbeat for live candle close countdown clock (paused while tab is hidden)
    const clockTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') scheduleRender();
    }, 1000);

    const render = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const layout = getLayout();
      const { w, h, chartW, mainH, volTop, volH, rsiTop, rsiH, macdTop, macdH, timeAxisTop } =
        layout;
      const st = stateRef.current;
      const bars = st.displayBars;
      const n = bars.length;

      ctx.save();
      ctx.scale(dpr, dpr);

      // 1. Pure OLED Black Background
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);

      if (n === 0) {
        ctx.fillStyle = '#64748b';
        ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`Loading ${st.exchange.toUpperCase()} ${st.timeframe} candles...`, chartW / 2, mainH / 2);
        ctx.restore();
        return;
      }

      const bw = barWidthRef.current;
      const rightOff = rightOffsetBarsRef.current;
      const indexToX = (idx: number) => chartW - (n - 1 - idx + rightOff + 0.5) * bw;
      const xToIndex = (x: number) => n - 1 + rightOff - (chartW - x) / bw + 0.5;

      const firstVis = Math.max(0, Math.floor(xToIndex(0)) - 1);
      const lastVis = Math.min(n - 1, Math.ceil(xToIndex(chartW)) + 1);

      // 2. Compute Y price bounds (Auto-scale or Manual)
      if (st.autoScaleY || manualPriceRangeRef.current.max <= manualPriceRangeRef.current.min) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = firstVis; i <= lastVis; i++) {
          const b = bars[i];
          if (b.l < lo) lo = b.l;
          if (b.h > hi) hi = b.h;
          if (st.computedInd.bb) {
            const u = st.computedInd.bb.upper[i];
            const lw = st.computedInd.bb.lower[i];
            if (u !== null && u > hi) hi = u;
            if (lw !== null && lw < lo) lo = lw;
          }
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
          lo = bars[n - 1].l;
          hi = bars[n - 1].h;
        }
        const pad = Math.max(10, (hi - lo) * 0.1);
        activePriceRangeRef.current = { min: Math.max(1, lo - pad), max: hi + pad };
      } else {
        activePriceRangeRef.current = { ...manualPriceRangeRef.current };
      }

      const mapper = buildMapper();
      const { min: minP, max: maxP } = activePriceRangeRef.current;
      const pctBasePrice = bars[Math.max(0, firstVis)]?.c || bars[0].c || 1;

      // 3. Main Chart Grid
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, chartW, mainH);
      ctx.clip();

      const yStep = niceStep(maxP - minP, 8);
      const firstGridP = Math.ceil(minP / yStep) * yStep;
      const xLabelStepPx = 115;
      const barsPerXGrid = Math.max(1, Math.round(xLabelStepPx / bw));

      // Single batched stroke for all horizontal + vertical grid lines
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let p = firstGridP; p <= maxP; p += yStep) {
        const y = Math.round(mapper.priceToY(p)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(chartW, y);
      }
      for (let i = lastVis; i >= firstVis; i -= barsPerXGrid) {
        const x = Math.round(indexToX(i)) + 0.5;
        if (x < 0 || x > chartW) continue;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, mainH);
      }
      ctx.stroke();

      // 4. Bollinger Bands (shaded behind candles)
      if (st.computedInd.bb) {
        const { upper, middle, lower } = st.computedInd.bb;
        ctx.fillStyle = 'rgba(56, 189, 248, 0.06)';
        ctx.beginPath();
        let started = false;
        for (let i = firstVis; i <= lastVis; i++) {
          if (upper[i] === null) continue;
          const x = indexToX(i);
          const y = mapper.priceToY(upper[i] as number);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        for (let i = lastVis; i >= firstVis; i--) {
          if (lower[i] === null) continue;
          ctx.lineTo(indexToX(i), mapper.priceToY(lower[i] as number));
        }
        ctx.closePath();
        ctx.fill();

        const drawBand = (arr: (number | null)[], col: string, dash: number[] = []) => {
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.setLineDash(dash);
          ctx.beginPath();
          let s = false;
          for (let i = firstVis; i <= lastVis; i++) {
            if (arr[i] === null) continue;
            const x = indexToX(i);
            const y = mapper.priceToY(arr[i] as number);
            if (!s) {
              ctx.moveTo(x, y);
              s = true;
            } else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
        };
        drawBand(upper, 'rgba(56, 189, 248, 0.55)');
        drawBand(middle, 'rgba(148, 163, 184, 0.5)', [4, 3]);
        drawBand(lower, 'rgba(56, 189, 248, 0.55)');
      }

      // 5. Price Series (Candles / Hollow / Heikin Ashi / Line / Area)
      if (st.chartStyle === 'line' || st.chartStyle === 'area') {
        ctx.beginPath();
        let firstX = 0;
        let lastX = 0;
        for (let i = firstVis; i <= lastVis; i++) {
          const x = indexToX(i);
          const y = mapper.priceToY(bars[i].c);
          if (i === firstVis) {
            firstX = x;
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
          lastX = x;
        }
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.stroke();

        if (st.chartStyle === 'area') {
          ctx.lineTo(lastX, mainH);
          ctx.lineTo(firstX, mainH);
          ctx.closePath();
          const grad = ctx.createLinearGradient(0, 0, 0, mainH);
          grad.addColorStop(0, 'rgba(56, 189, 248, 0.28)');
          grad.addColorStop(1, 'rgba(56, 189, 248, 0.01)');
          ctx.fillStyle = grad;
          ctx.fill();
        }
      } else {
        // Batched candlesticks: 2 wick strokes + grouped fillStyle passes (fast even with 4,500 bars)
        const candleW = Math.max(1.5, Math.min(bw - 1.5, bw * 0.72));
        const halfW = candleW * 0.5;
        const isHollow = st.chartStyle === 'hollow';

        // Bull wicks
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = firstVis; i <= lastVis; i++) {
          const b = bars[i];
          if (b.c < b.o) continue;
          const cx = Math.round(indexToX(i)) + 0.5;
          ctx.moveTo(cx, mapper.priceToY(b.h));
          ctx.lineTo(cx, mapper.priceToY(b.l));
        }
        ctx.stroke();

        // Bear wicks
        ctx.strokeStyle = '#f43f5e';
        ctx.beginPath();
        for (let i = firstVis; i <= lastVis; i++) {
          const b = bars[i];
          if (b.c >= b.o) continue;
          const cx = Math.round(indexToX(i)) + 0.5;
          ctx.moveTo(cx, mapper.priceToY(b.h));
          ctx.lineTo(cx, mapper.priceToY(b.l));
        }
        ctx.stroke();

        // Bull bodies
        ctx.fillStyle = isHollow ? '#000000' : '#10b981';
        if (isHollow) {
          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 1.2;
        }
        for (let i = firstVis; i <= lastVis; i++) {
          const b = bars[i];
          if (b.c < b.o) continue;
          const cx = Math.round(indexToX(i)) + 0.5;
          const yO = mapper.priceToY(b.o);
          const yC = mapper.priceToY(b.c);
          const top = yO < yC ? yO : yC;
          const bodyH = Math.max(1.2, Math.abs(yC - yO));
          ctx.fillRect(cx - halfW, top, candleW, bodyH);
          if (isHollow) ctx.strokeRect(cx - halfW, top, candleW, bodyH);
        }

        // Bear bodies
        ctx.fillStyle = '#f43f5e';
        for (let i = firstVis; i <= lastVis; i++) {
          const b = bars[i];
          if (b.c >= b.o) continue;
          const cx = Math.round(indexToX(i)) + 0.5;
          const yO = mapper.priceToY(b.o);
          const yC = mapper.priceToY(b.c);
          const top = yO < yC ? yO : yC;
          const bodyH = Math.max(1.2, Math.abs(yC - yO));
          ctx.fillRect(cx - halfW, top, candleW, bodyH);
        }
      }

      // 6. Overlay Line Indicators (EMAs, SMA, VWAP)
      const drawOverlayLine = (arr: (number | null)[] | null, color: string, width = 1.4) => {
        if (!arr) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        let started = false;
        for (let i = firstVis; i <= lastVis; i++) {
          const v = arr[i];
          if (v === null) continue;
          const x = indexToX(i);
          const y = mapper.priceToY(v);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      };

      drawOverlayLine(st.computedInd.ema9, '#38bdf8', 1.4);
      drawOverlayLine(st.computedInd.ema21, '#facc15', 1.4);
      drawOverlayLine(st.computedInd.ema50, '#fb923c', 1.5);
      drawOverlayLine(st.computedInd.ema200, '#a855f7', 1.7);
      drawOverlayLine(st.computedInd.sma20, '#e2e8f0', 1.3);
      drawOverlayLine(st.computedInd.ma50, '#2dd4bf', 1.5);
      drawOverlayLine(st.computedInd.ma100, '#60a5fa', 1.6);
      drawOverlayLine(st.computedInd.ma200, '#f43f5e', 1.8);
      drawOverlayLine(st.computedInd.vwap, '#ec4899', 1.6);

      // 7. Live Last Price Dashed Line
      const lastBar = bars[n - 1];
      const livePrice = st.ticker.lastPrice || lastBar.c;
      const liveY = Math.round(mapper.priceToY(livePrice)) + 0.5;
      const lastBull = lastBar.c >= lastBar.o;
      const liveAccent = lastBull ? '#10b981' : '#f43f5e';
      if (liveY >= 0 && liveY <= mainH) {
        ctx.save();
        ctx.strokeStyle = liveAccent;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, liveY);
        ctx.lineTo(chartW, liveY);
        ctx.stroke();
        ctx.restore();
      }

      // 8. Render User Drawings + Active Drag/Draft + Measure Box
      if (!st.hideDrawings) {
        const dragged = draggingDrawingRef.current;
        for (const d of st.drawings) {
          const item = dragged && dragged.id === d.id ? dragged : d;
          renderDrawing(ctx, item, mapper, item.id === st.selectedId, false);
        }
      }
      if (draftDrawingRef.current) {
        renderDrawing(ctx, draftDrawingRef.current, mapper, false, true);
      }
      if (measureRef.current) {
        const m = measureRef.current;
        const barDelta = Math.round(
          (mapper.timeToX(m.p2.time) - mapper.timeToX(m.p1.time)) / Math.max(1, bw)
        );
        renderMeasureBox(ctx, m.p1, m.p2, barDelta, mapper);
      }

      ctx.restore(); // end main chart clip

      // 9. Volume Sub-Pane
      if (volH > 0) {
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, volTop + 0.5);
        ctx.lineTo(w, volTop + 0.5);
        ctx.stroke();

        let maxVol = 0.01;
        for (let i = firstVis; i <= lastVis; i++) {
          if (bars[i].vol > maxVol) maxVol = bars[i].vol;
        }
        const barW = Math.max(1.5, bw * 0.7);
        const halfBarW = barW * 0.5;
        const volScale = (volH - 18) / maxVol;
        const volBottom = volTop + volH - 2;
        ctx.fillStyle = 'rgba(16, 185, 129, 0.55)';
        for (let i = firstVis; i <= lastVis; i++) {
          const b = bars[i];
          if (b.c < b.o) continue;
          const bh = b.vol * volScale;
          ctx.fillRect(indexToX(i) - halfBarW, volBottom - bh, barW, bh);
        }
        ctx.fillStyle = 'rgba(244, 63, 94, 0.55)';
        for (let i = firstVis; i <= lastVis; i++) {
          const b = bars[i];
          if (b.c >= b.o) continue;
          const bh = b.vol * volScale;
          ctx.fillRect(indexToX(i) - halfBarW, volBottom - bh, barW, bh);
        }
        if (st.computedInd.volMa) {
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          let s = false;
          for (let i = firstVis; i <= lastVis; i++) {
            const vm = st.computedInd.volMa[i];
            if (vm === null) continue;
            const x = indexToX(i);
            const y = volTop + volH - (vm / maxVol) * (volH - 18) - 2;
            if (!s) {
              ctx.moveTo(x, y);
              s = true;
            } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.fillStyle = '#94a3b8';
        ctx.font = 'bold 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`VOL (${bars[n - 1].vol.toFixed(2)} BTC)`, 8, volTop + 4);
      }

      // 10. RSI (14) Sub-Pane
      if (rsiH > 0 && st.computedInd.rsi) {
        const rsi = st.computedInd.rsi;
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, rsiTop + 0.5);
        ctx.lineTo(w, rsiTop + 0.5);
        ctx.stroke();

        const rsiToY = (v: number) => rsiTop + 14 + ((100 - v) / 100) * (rsiH - 20);
        const y70 = rsiToY(70);
        const y30 = rsiToY(30);
        ctx.fillStyle = 'rgba(168, 85, 247, 0.08)';
        ctx.fillRect(0, y70, chartW, y30 - y70);

        ctx.save();
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
        ctx.setLineDash([3, 3]);
        for (const lv of [70, 50, 30]) {
          const ly = Math.round(rsiToY(lv)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, ly);
          ctx.lineTo(chartW, ly);
          ctx.stroke();
        }
        ctx.restore();

        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let s = false;
        for (let i = firstVis; i <= lastVis; i++) {
          const v = rsi[i];
          if (v === null) continue;
          const x = indexToX(i);
          const y = rsiToY(v);
          if (!s) {
            ctx.moveTo(x, y);
            s = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();

        const lastRsi = rsi[n - 1];
        ctx.fillStyle = '#c084fc';
        ctx.font = 'bold 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`RSI(14): ${lastRsi !== null ? lastRsi.toFixed(1) : '—'}`, 8, rsiTop + 3);

        // Axis 70/30 labels
        ctx.fillStyle = '#64748b';
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText('70', chartW + 8, y70 - 4);
        ctx.fillText('30', chartW + 8, y30 - 4);
      }

      // 11. MACD (12, 26, 9) Sub-Pane
      if (macdH > 0 && st.computedInd.macd) {
        const { macd, signal, hist } = st.computedInd.macd;
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, macdTop + 0.5);
        ctx.lineTo(w, macdTop + 0.5);
        ctx.stroke();

        let maxAbs = 1;
        for (let i = firstVis; i <= lastVis; i++) {
          if (macd[i] !== null) maxAbs = Math.max(maxAbs, Math.abs(macd[i] as number));
          if (signal[i] !== null) maxAbs = Math.max(maxAbs, Math.abs(signal[i] as number));
          if (hist[i] !== null) maxAbs = Math.max(maxAbs, Math.abs(hist[i] as number));
        }
        const midY = macdTop + 14 + (macdH - 20) / 2;
        const scale = (macdH - 24) / (2 * maxAbs);

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(chartW, midY);
        ctx.stroke();

        const barW = Math.max(1.5, bw * 0.65);
        const halfBarW = barW * 0.5;
        ctx.fillStyle = 'rgba(16, 185, 129, 0.65)';
        for (let i = firstVis; i <= lastVis; i++) {
          const hv = hist[i];
          if (hv === null || hv < 0) continue;
          const bh = hv * scale;
          ctx.fillRect(indexToX(i) - halfBarW, midY - bh, barW, bh);
        }
        ctx.fillStyle = 'rgba(244, 63, 94, 0.65)';
        for (let i = firstVis; i <= lastVis; i++) {
          const hv = hist[i];
          if (hv === null || hv >= 0) continue;
          const bh = -hv * scale;
          ctx.fillRect(indexToX(i) - halfBarW, midY, barW, bh);
        }

        const drawMacdLine = (arr: (number | null)[], color: string) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          let s = false;
          for (let i = firstVis; i <= lastVis; i++) {
            const v = arr[i];
            if (v === null) continue;
            const x = indexToX(i);
            const y = midY - v * scale;
            if (!s) {
              ctx.moveTo(x, y);
              s = true;
            } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        };
        drawMacdLine(macd, '#38bdf8');
        drawMacdLine(signal, '#fb923c');

        const lm = macd[n - 1];
        const ls = signal[n - 1];
        ctx.font = 'bold 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#38bdf8';
        ctx.fillText(
          `MACD(12,26,9): ${lm !== null ? lm.toFixed(1) : '—'} / ${ls !== null ? ls.toFixed(1) : '—'}`,
          8,
          macdTop + 3
        );
      }

      // 12. Right Price Axis (Y-Axis)
      ctx.fillStyle = '#000000';
      ctx.fillRect(chartW, 0, PRICE_AXIS_W, h);
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(chartW + 0.5, 0);
      ctx.lineTo(chartW + 0.5, h);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let p = firstGridP; p <= maxP; p += yStep) {
        const y = mapper.priceToY(p);
        if (y < 12 || y > mainH - 12) continue;
        const txt =
          st.scaleMode === 'pct'
            ? `${(((p - pctBasePrice) / pctBasePrice) * 100).toFixed(1)}%`
            : p.toFixed(1);
        ctx.fillText(txt, chartW + 8, y);
      }

      // Live Price Tag + Candle Close Countdown on Y-Axis
      if (liveY >= 10 && liveY <= mainH - 10) {
        const remainMs = lastBar.t + st.timeframeMs - Date.now();
        ctx.fillStyle = liveAccent;
        ctx.fillRect(chartW + 1, liveY - 14, PRICE_AXIS_W - 2, 28);
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(livePrice.toFixed(1), chartW + 7, liveY - 4);
        ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(formatCountdownMs(remainMs), chartW + 7, liveY + 7);
      }

      // 13. Bottom Time Axis (X-Axis)
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, timeAxisTop, w, TIME_AXIS_H);
      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(0, timeAxisTop + 0.5);
      ctx.lineTo(w, timeAxisTop + 0.5);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = lastVis; i >= firstVis; i -= barsPerXGrid) {
        const x = indexToX(i);
        if (x < 45 || x > chartW - 35) continue;
        ctx.fillText(formatBarTime(bars[i].t, st.timeframe), x, timeAxisTop + TIME_AXIS_H / 2);
      }

      // 14. Crosshair + Magnet Snap Indicator + Axis Badges + Top-Left OHLCV HUD
      const mouse = mouseRef.current;
      let inspectIdx = n - 1;
      if (mouse && mouse.x >= 0 && mouse.x <= chartW && mouse.y >= 0 && mouse.y <= timeAxisTop) {
        const snap =
          st.magnetMode !== 'off' && mouse.y <= mainH
            ? mapper.snapPointDetailed(mouse.x, mouse.y)
            : null;
        const useSnap = Boolean(snap && snap.snapped);
        const cx = useSnap ? snap!.snapX : mouse.x;
        const cy = useSnap ? snap!.snapY : mouse.y;
        inspectIdx = Math.max(0, Math.min(n - 1, Math.round(xToIndex(cx))));

        const magnetColor =
          st.magnetMode === 'extra'
            ? '#ec4899'
            : st.magnetMode === 'strong'
              ? '#f59e0b'
              : '#38bdf8';

        ctx.save();
        ctx.strokeStyle = useSnap ? `${magnetColor}99` : 'rgba(148, 163, 184, 0.42)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(Math.round(cx) + 0.5, 0);
        ctx.lineTo(Math.round(cx) + 0.5, timeAxisTop);
        ctx.moveTo(0, Math.round(cy) + 0.5);
        ctx.lineTo(chartW, Math.round(cy) + 0.5);
        ctx.stroke();
        ctx.restore();

        // Draw magnetic lock ring + OHLC tag right on the snapped candle point
        if (useSnap && snap) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, st.magnetMode === 'extra' ? 6.5 : 5, 0, Math.PI * 2);
          ctx.fillStyle = `${magnetColor}33`;
          ctx.fill();
          ctx.strokeStyle = magnetColor;
          ctx.lineWidth = 1.8;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(cx, cy, 2, 0, Math.PI * 2);
          ctx.fillStyle = magnetColor;
          ctx.fill();

          if (snap.kind) {
            const tagTxt = `${snap.kind} ${snap.point.price.toFixed(1)}`;
            ctx.font = 'bold 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
            const tagW = ctx.measureText(tagTxt).width + 10;
            const tagX = cx + 10 + tagW > chartW ? cx - tagW - 10 : cx + 10;
            const tagY = Math.max(10, Math.min(mainH - 18, cy - 9));
            ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
            ctx.fillRect(tagX, tagY, tagW, 16);
            ctx.strokeStyle = magnetColor;
            ctx.lineWidth = 1;
            ctx.strokeRect(tagX + 0.5, tagY + 0.5, tagW - 1, 15);
            ctx.fillStyle = magnetColor;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(tagTxt, tagX + 5, tagY + 8);
          }
          ctx.restore();
        }

        // Hovered / Snapped Price badge on Y-axis
        if (cy <= mainH) {
          const hp = useSnap && snap ? snap.point.price : mapper.yToPrice(cy);
          ctx.fillStyle = useSnap ? magnetColor : '#334155';
          ctx.fillRect(chartW + 1, cy - 9, PRICE_AXIS_W - 2, 18);
          ctx.fillStyle = useSnap ? '#000000' : '#f8fafc';
          ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const lbl =
            st.scaleMode === 'pct'
              ? `${(((hp - pctBasePrice) / pctBasePrice) * 100).toFixed(2)}%`
              : hp.toFixed(1);
          ctx.fillText(lbl, chartW + 7, cy);
        }

        // Hovered / Snapped Time badge on X-axis
        const ht = useSnap && snap ? snap.point.time : mapper.xToTime(cx);
        const tLbl = formatBarTime(ht, st.timeframe);
        ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        const tw = ctx.measureText(tLbl).width + 12;
        const tx = Math.max(tw / 2, Math.min(chartW - tw / 2, cx));
        ctx.fillStyle = useSnap ? magnetColor : '#334155';
        ctx.fillRect(tx - tw / 2, timeAxisTop + 2, tw, TIME_AXIS_H - 4);
        ctx.fillStyle = useSnap ? '#000000' : '#f8fafc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tLbl, tx, timeAxisTop + TIME_AXIS_H / 2);
      }

      // Top-left TradingView OHLCV & Indicator Legend HUD
      const ib = bars[inspectIdx] || lastBar;
      const chg = ib.c - ib.o;
      const chgPct = ib.o > 0 ? (chg / ib.o) * 100 : 0;
      const hudBull = chg >= 0;

      ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#f1f5f9';
      const titleStr = `${st.exchange.toUpperCase()} BTC • ${st.timeframe.toUpperCase()}`;
      ctx.fillText(titleStr, 10, 8);

      const titleW = ctx.measureText(titleStr).width + 18;
      ctx.fillStyle = hudBull ? '#34d399' : '#fb7185';
      ctx.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(
        `O ${ib.o.toFixed(1)}  H ${ib.h.toFixed(1)}  L ${ib.l.toFixed(1)}  C ${ib.c.toFixed(1)}  ${chg >= 0 ? '+' : ''}${chg.toFixed(1)} (${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)  V ${ib.vol.toFixed(2)}`,
        titleW,
        8
      );

      // Indicator live readout row
      const indParts: { txt: string; col: string }[] = [];
      if (st.computedInd.ema9?.[inspectIdx] != null)
        indParts.push({ txt: `EMA9 ${st.computedInd.ema9[inspectIdx]!.toFixed(1)}`, col: '#38bdf8' });
      if (st.computedInd.ema21?.[inspectIdx] != null)
        indParts.push({ txt: `EMA21 ${st.computedInd.ema21[inspectIdx]!.toFixed(1)}`, col: '#facc15' });
      if (st.computedInd.ema50?.[inspectIdx] != null)
        indParts.push({ txt: `EMA50 ${st.computedInd.ema50[inspectIdx]!.toFixed(1)}`, col: '#fb923c' });
      if (st.computedInd.ema200?.[inspectIdx] != null)
        indParts.push({ txt: `EMA200 ${st.computedInd.ema200[inspectIdx]!.toFixed(1)}`, col: '#a855f7' });
      if (st.computedInd.sma20?.[inspectIdx] != null)
        indParts.push({ txt: `SMA20 ${st.computedInd.sma20[inspectIdx]!.toFixed(1)}`, col: '#e2e8f0' });
      if (st.computedInd.ma50?.[inspectIdx] != null)
        indParts.push({ txt: `MA50 ${st.computedInd.ma50[inspectIdx]!.toFixed(1)}`, col: '#2dd4bf' });
      if (st.computedInd.ma100?.[inspectIdx] != null)
        indParts.push({ txt: `MA100 ${st.computedInd.ma100[inspectIdx]!.toFixed(1)}`, col: '#60a5fa' });
      if (st.computedInd.ma200?.[inspectIdx] != null)
        indParts.push({ txt: `MA200 ${st.computedInd.ma200[inspectIdx]!.toFixed(1)}`, col: '#f43f5e' });
      if (st.computedInd.vwap?.[inspectIdx] != null)
        indParts.push({ txt: `VWAP ${st.computedInd.vwap[inspectIdx]!.toFixed(1)}`, col: '#ec4899' });

      if (indParts.length > 0) {
        ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        let lx = 10;
        for (const p of indParts) {
          ctx.fillStyle = p.col;
          ctx.fillText(p.txt, lx, 24);
          lx += ctx.measureText(p.txt).width + 12;
        }
      }

      ctx.restore();
    };

    scheduleRender();

    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      requestRedrawRef.current = () => {};
      clearInterval(clockTimer);
      obs.disconnect();
    };
  }, [buildMapper, getLayout]);

  const toggleInd = (key: keyof IndicatorFlags) => {
    setIndicators((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const commitTextAnnotation = () => {
    if (!textModal) return;
    const trimmed = textModal.value.trim();
    if (trimmed) {
      const id = `drw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setDrawings((prev) => [
        ...prev,
        {
          id,
          type: 'text',
          points: [textModal.point],
          color: drawColor,
          lineWidth: 1,
          text: trimmed,
        },
      ]);
      setSelectedId(id);
    }
    setTextModal(null);
    setActiveTool('cursor');
  };

  return (
    <div className="tv-page-shell">
      {/* Top TradingView Chart Controls Bar */}
      <div className="control-toolbar tv-top-toolbar">
        <div className="control-group">
          <span className="group-label">TF:</span>
          <div className="segmented-btns">
            {KLINE_TFS.map((tf) => (
              <button
                key={tf}
                className={timeframe === tf ? 'active' : ''}
                onClick={() => onSelectTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="group-label">Style:</span>
          <div className="segmented-btns">
            {(
              [
                ['candles', 'Candles'],
                ['hollow', 'Hollow'],
                ['heikin', 'Heikin'],
                ['line', 'Line'],
                ['area', 'Area'],
              ] as const
            ).map(([id, lbl]) => (
              <button
                key={id}
                className={chartStyle === id ? 'active' : ''}
                onClick={() => setChartStyle(id)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="group-label">Indicators:</span>
          <div className="segmented-btns">
            <button className={indicators.ema9 ? 'active' : ''} onClick={() => toggleInd('ema9')}>
              EMA9
            </button>
            <button className={indicators.ema21 ? 'active' : ''} onClick={() => toggleInd('ema21')}>
              EMA21
            </button>
            <button className={indicators.ema50 ? 'active' : ''} onClick={() => toggleInd('ema50')}>
              EMA50
            </button>
            <button className={indicators.ema200 ? 'active' : ''} onClick={() => toggleInd('ema200')}>
              EMA200
            </button>
            <button className={indicators.sma20 ? 'active' : ''} onClick={() => toggleInd('sma20')}>
              SMA20
            </button>
            <button
              className={indicators.ma50 ? 'active' : ''}
              onClick={() => toggleInd('ma50')}
              title="50-period Simple Moving Average"
            >
              MA50
            </button>
            <button
              className={indicators.ma100 ? 'active' : ''}
              onClick={() => toggleInd('ma100')}
              title="100-period Simple Moving Average"
            >
              MA100
            </button>
            <button
              className={indicators.ma200 ? 'active' : ''}
              onClick={() => toggleInd('ma200')}
              title="200-period Simple Moving Average"
            >
              MA200
            </button>
            <button className={indicators.vwap ? 'active' : ''} onClick={() => toggleInd('vwap')}>
              VWAP
            </button>
            <button className={indicators.bb ? 'active' : ''} onClick={() => toggleInd('bb')}>
              BB
            </button>
            <button className={indicators.volume ? 'active' : ''} onClick={() => toggleInd('volume')}>
              Vol
            </button>
            <button className={indicators.rsi ? 'active' : ''} onClick={() => toggleInd('rsi')}>
              RSI
            </button>
            <button className={indicators.macd ? 'active' : ''} onClick={() => toggleInd('macd')}>
              MACD
            </button>
          </div>
        </div>

        <div className="control-group right-actions">
          <div className="segmented-btns">
            <button
              onClick={() => {
                const n = stateRef.current.displayBars.length;
                if (n > 0) {
                  const { chartW } = getLayout();
                  barWidthRef.current = Math.max(0.8, Math.min(18, (chartW - 30) / n));
                  rightOffsetBarsRef.current = 4;
                  setAutoScaleY(true);
                  manualPriceRangeRef.current = { min: 0, max: 0 };
                  setIsPannedBack(false);
                  requestRedraw();
                  scheduleViewportSave();
                }
              }}
              title={`Fit all ${displayBars.length.toLocaleString()} historical candles in view`}
            >
              All ({loadingFullHistory ? '…' : displayBars.length})
            </button>
            <button
              className={autoScaleY ? 'active' : ''}
              onClick={() => {
                setAutoScaleY((v) => !v);
                scheduleViewportSave();
              }}
              title="Toggle Y-axis Auto-Scale (Double-click price axis)"
            >
              Auto
            </button>
            <button
              className={scaleMode === 'log' ? 'active' : ''}
              onClick={() => setScaleMode((m) => (m === 'log' ? 'normal' : 'log'))}
              title="Logarithmic Price Scale"
            >
              Log
            </button>
            <button
              className={scaleMode === 'pct' ? 'active' : ''}
              onClick={() => setScaleMode((m) => (m === 'pct' ? 'normal' : 'pct'))}
              title="Percentage Scale"
            >
              %
            </button>
          </div>
          {onSaveToAccount && (
            <button
              type="button"
              className={`action-btn ${authUsername && syncStatus === 'saved' ? 'active' : ''}`}
              onClick={onSaveToAccount}
              title={
                authUsername
                  ? `All chart drawings (${totalSavedDrawings ?? drawings.length}), indicators, zoom/pan, and settings auto-save to @${authUsername}. Click to save immediately.`
                  : 'Sign in or create an account to save all chart drawings & settings to the server'
              }
            >
              {authUsername
                ? syncStatus === 'saving'
                  ? '💾 Saving…'
                  : syncStatus === 'error'
                    ? '⚠ Retry Save'
                    : `✓ Saved (${totalSavedDrawings ?? drawings.length})`
                : '💾 Save to Account'}
            </button>
          )}
          <button
            type="button"
            className={`action-btn ai-toolbar-btn ${aiPanelOpen ? 'active' : ''}`}
            onClick={() => setAiPanelOpen((v) => !v)}
            title="Open Local AI Technical Analysis & Chat (Ollama / Hybrid GPU+CPU)"
          >
            🖥 Local AI
          </button>
          <button className="action-btn" onClick={handleExportPng} title="Download chart snapshot as PNG">
            📷 PNG
          </button>
        </div>
      </div>

      {/* Main Split: Left Drawing Tool Rail + Interactive Chart Canvas */}
      <div className="tv-workspace">
        <aside className="tv-tool-rail" aria-label="Drawing Tools">
          <div className="tv-tool-group">
            {TOOL_BUTTONS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tv-tool-btn ${activeTool === t.id ? 'active' : ''}`}
                onClick={() => {
                  draftDrawingRef.current = null;
                  setActiveTool(t.id);
                }}
                title={`${t.label} (${t.key})`}
              >
                {t.icon}
              </button>
            ))}
          </div>

          <div className="tv-tool-divider" />

          <div className="tv-tool-group">
            <button
              type="button"
              className={`tv-tool-btn tv-magnet-btn ${
                magnetMode !== 'off' ? `active magnet-${magnetMode}` : ''
              }`}
              onClick={(e) => {
                if (magnetMenuPos) {
                  setMagnetMenuPos(null);
                } else {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMagnetMenuPos({
                    top: Math.max(12, Math.min(window.innerHeight - 190, rect.top - 10)),
                    left: rect.right + 8,
                  });
                }
              }}
              title={`Magnet Mode: ${MAGNET_OPTIONS.find((o) => o.id === magnetMode)?.label || 'Off'} (Hotkey: M to cycle)`}
            >
              <span>🧲</span>
              {magnetMode !== 'off' && (
                <span className={`tv-magnet-badge badge-${magnetMode}`}>
                  {magnetMode === 'extra' ? 'XS' : magnetMode === 'strong' ? 'S' : 'W'}
                </span>
              )}
            </button>
            <button
              type="button"
              className={`tv-tool-btn ${hideDrawings ? 'active' : ''}`}
              onClick={() => setHideDrawings((v) => !v)}
              title={hideDrawings ? 'Show All Drawings' : 'Hide All Drawings'}
            >
              {hideDrawings ? '🙈' : '👁'}
            </button>
            <button
              type="button"
              className="tv-tool-btn"
              onClick={() => {
                setDrawings((prev) => prev.slice(0, -1));
                setSelectedId(null);
              }}
              disabled={drawings.length === 0}
              title="Undo Last Drawing (Ctrl+Z)"
            >
              ↩
            </button>
            <button
              type="button"
              className="tv-tool-btn tv-tool-danger"
              onClick={() => {
                if (selectedId) {
                  setDrawings((prev) => prev.filter((d) => d.id !== selectedId));
                  setSelectedId(null);
                } else {
                  setDrawings([]);
                }
              }}
              disabled={drawings.length === 0}
              title={selectedId ? 'Delete Selected Drawing (Del)' : 'Clear All Drawings'}
            >
              🗑
            </button>
          </div>
        </aside>

        {/* Chart Canvas Container */}
        <div className="tv-canvas-stage" ref={containerRef}>
          <canvas
            ref={canvasRef}
            className={`tv-canvas ${activeTool !== 'cursor' ? 'tv-canvas-drawing' : ''}`}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onDoubleClick={handleDoubleClick}
            onMouseLeave={() => {
              handleMouseUp();
              mouseRef.current = null;
              requestRedraw();
            }}
          />

          {/* Floating Drawing Style Properties Strip (when drawing or a drawing is selected) */}
          {(activeTool !== 'cursor' || selectedId) && (
            <div className="tv-style-bar">
              <span className="tv-style-label">
                {selectedId
                  ? 'Selected:'
                  : TOOL_BUTTONS.find((t) => t.id === activeTool)?.label || 'Draw'}
              </span>
              <div className="tv-swatch-row">
                {DRAWING_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`tv-swatch ${drawColor === c ? 'active' : ''}`}
                    style={{ backgroundColor: c }}
                    onClick={() => handleApplyColor(c)}
                    title={`Color ${c}`}
                  />
                ))}
              </div>
              <div className="segmented-btns">
                {[1, 2, 3].map((lw) => (
                  <button
                    key={lw}
                    className={drawWidth === lw ? 'active' : ''}
                    onClick={() => handleApplyWidth(lw)}
                  >
                    {lw}px
                  </button>
                ))}
                <button className={drawDashed ? 'active' : ''} onClick={handleToggleDashed}>
                  {drawDashed ? 'Dash' : 'Solid'}
                </button>
              </div>
              {selectedId && (
                <button
                  type="button"
                  className="mini-reset-btn"
                  onClick={() => {
                    setDrawings((prev) => prev.filter((d) => d.id !== selectedId));
                    setSelectedId(null);
                  }}
                >
                  Delete
                </button>
              )}
              <span className="text-muted">({drawings.length})</span>
            </div>
          )}

          {/* Go to Latest Candles Floating Button */}
          {isPannedBack && (
            <button
              type="button"
              className="floating-btn primary tv-goto-latest"
              onClick={() => {
                rightOffsetBarsRef.current = 10;
                setIsPannedBack(false);
                requestRedraw();
                scheduleViewportSave();
              }}
              title="Jump back to latest live candle"
            >
              Latest →
            </button>
          )}

          {/* Inline Text Annotation Input */}
          {textModal && (
            <div
              className="tv-text-popover"
              style={{
                left: Math.min(textModal.x, Math.max(20, canvasSizeRef.current.w - 260)),
                top: Math.max(12, textModal.y - 20),
              }}
            >
              <input
                type="text"
                autoFocus
                placeholder="Type note & press Enter..."
                value={textModal.value}
                onChange={(e) => setTextModal({ ...textModal, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTextAnnotation();
                  if (e.key === 'Escape') {
                    setTextModal(null);
                    setActiveTool('cursor');
                  }
                }}
              />
              <button type="button" className="mini-reset-btn" onClick={commitTextAnnotation}>
                Add
              </button>
            </div>
          )}
        </div>

        {/* Collapsible Gemini AI Technical Analysis Right Drawer */}
        {aiPanelOpen && (
          <GeminiAnalysisPanel
            exchange={exchange}
            timeframe={timeframe}
            drawings={drawings}
            savedOllamaModel={savedOllamaModel}
            onChangeOllamaModel={onChangeOllamaModel}
            savedOllamaBaseUrl={savedOllamaBaseUrl}
            onChangeOllamaBaseUrl={onChangeOllamaBaseUrl}
            onPlotLevel={handlePlotAiLevel}
            onPlotAllLevels={handlePlotAllAiLevels}
            onPlotTradeIdea={handlePlotAiTradeIdea}
            onClearAiPlots={handleClearAiPlots}
            hasAiPlots={drawings.some((d) => d.id.startsWith('ai-'))}
            onClose={() => setAiPanelOpen(false)}
          />
        )}
      </div>

      {/* Magnet Strength Flyout Menu */}
      {magnetMenuPos && (
        <>
          <div
            className="tv-magnet-backdrop"
            onClick={() => setMagnetMenuPos(null)}
          />
          <div
            className="tv-magnet-popover"
            style={{ top: magnetMenuPos.top, left: magnetMenuPos.left }}
          >
            <div className="tv-magnet-pop-head">
              <span>🧲 Magnet Mode</span>
              <span className="text-muted">Hotkey: M</span>
            </div>
            {MAGNET_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`tv-magnet-opt ${magnetMode === opt.id ? 'active' : ''}`}
                onClick={() => {
                  setMagnetMode(opt.id);
                  setMagnetMenuPos(null);
                }}
              >
                <div className="tv-magnet-opt-row">
                  <span
                    className="tv-magnet-dot"
                    style={{ backgroundColor: opt.color }}
                  />
                  <strong>{opt.label}</strong>
                  {opt.badge && (
                    <span
                      className="tv-magnet-opt-tag"
                      style={{ color: opt.color, borderColor: `${opt.color}66` }}
                    >
                      {opt.badge}
                    </span>
                  )}
                </div>
                <span className="tv-magnet-opt-desc">{opt.desc}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
});
