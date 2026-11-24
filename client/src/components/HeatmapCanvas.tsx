import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type {
  BookScope,
  ColormapName,
  ExchangeId,
  HeatmapSlice,
  PriceStep,
  TickerStats,
  TimeframeId,
  WallLevel,
} from '../../../shared/types.ts';
import { getColormapCssGradient, getLiquidityColor } from '../colormaps.ts';

interface HeatmapCanvasProps {
  exchange: ExchangeId;
  slices: HeatmapSlice[];
  currentBids: [number, number][];
  currentAsks: [number, number][];
  bidClusters: WallLevel[];
  askClusters: WallLevel[];
  ticker: TickerStats;
  priceStep: PriceStep;
  bookScope: BookScope;
  timeframe: TimeframeId;
  isKlineTimeframe: boolean;
  colormap: ColormapName;
  minFilterBtc: number;
  maxCeilingBtc: number;
  showBidAskLines: boolean;
  showTradeBubbles: boolean;
  showCandlesticks: boolean;
  showVolumePane: boolean;
  showVolumeProfile: boolean;
  showLiquidations: boolean;
  showSpoofDelta: boolean;
  isPaused: boolean;
  autoFollowPrice: boolean;
  onToggleAutoFollow: (follow: boolean) => void;
  highlightedPrice: number | null;
  priceAlertLevel: number | null;
  onSetPriceAlert: (price: number | null) => void;
  fitTrigger: number;
  hotkeyAction?: { id: number; type: 'fit' | 'recenter' | 'fullbook' } | null;
}

interface HoverInfo {
  x: number;
  y: number;
  priceFloor: number;
  priceCeil: number;
  timestamp: number | null;
  isLiveZone: boolean;
  restingBtc: number;
  restingSide: 'Bid' | 'Ask' | null;
  delta30sBtc?: number;
  clusterDetail?: WallLevel;
  bestBid: number;
  bestAsk: number;
  buyVolBtc: number;
  sellVolBtc: number;
  candleOpen?: number;
  candleHigh?: number;
  candleLow?: number;
  candleClose?: number;
}

const PRICE_AXIS_WIDTH = 82;
const DOM_PANEL_WIDTH = 204;
const TIME_AXIS_HEIGHT = 24;
const VOLUME_PANE_HEIGHT = 110;

// Binary-search visible [start, end) range in descending bids ([price, vol][])
function findVisibleDescRange(
  bids: [number, number][],
  minPrice: number,
  maxPrice: number,
  priceStep: number
): [number, number] {
  const n = bids.length;
  if (n === 0) return [0, 0];
  // First index where price <= maxPrice
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bids[mid][0] > maxPrice) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  // First index where price + priceStep < minPrice
  const minCutoff = minPrice - priceStep;
  lo = start;
  hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bids[mid][0] >= minCutoff) lo = mid + 1;
    else hi = mid;
  }
  return [start, lo];
}

// Binary-search visible [start, end) range in ascending asks ([price, vol][])
function findVisibleAscRange(
  asks: [number, number][],
  minPrice: number,
  maxPrice: number,
  priceStep: number
): [number, number] {
  const n = asks.length;
  if (n === 0) return [0, 0];
  const minCutoff = minPrice - priceStep;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (asks[mid][0] < minCutoff) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  lo = start;
  hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (asks[mid][0] <= maxPrice) lo = mid + 1;
    else hi = mid;
  }
  return [start, lo];
}

const HM_FMT_DAY = new Intl.DateTimeFormat(undefined, {
  year: '2-digit',
  month: 'short',
  day: '2-digit',
});
const HM_FMT_HOUR = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: '2-digit',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
});
const HM_FMT_MIN = new Intl.DateTimeFormat(undefined, {
  month: '2-digit',
  day: '2-digit',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
});
const HM_FMT_SEC = new Intl.DateTimeFormat(undefined, {
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function formatTimeAxisLabel(ts: number, timeframe: TimeframeId): string {
  if (timeframe === '1d' || timeframe === '1w') return HM_FMT_DAY.format(ts);
  if (
    timeframe === '1h' ||
    timeframe === '2h' ||
    timeframe === '4h' ||
    timeframe === '6h' ||
    timeframe === '12h'
  ) {
    return HM_FMT_HOUR.format(ts);
  }
  if (
    timeframe === '1m' ||
    timeframe === '3m' ||
    timeframe === '5m' ||
    timeframe === '15m' ||
    timeframe === '30m'
  ) {
    return HM_FMT_MIN.format(ts);
  }
  return HM_FMT_SEC.format(ts);
}

export const HeatmapCanvas: React.FC<HeatmapCanvasProps> = React.memo(({
  exchange,
  slices,
  currentBids,
  currentAsks,
  bidClusters,
  askClusters,
  ticker,
  priceStep,
  bookScope,
  timeframe,
  isKlineTimeframe,
  colormap,
  minFilterBtc,
  maxCeilingBtc,
  showBidAskLines,
  showTradeBubbles,
  showCandlesticks,
  showVolumePane,
  showVolumeProfile,
  showLiquidations,
  showSpoofDelta,
  isPaused,
  autoFollowPrice,
  onToggleAutoFollow,
  highlightedPrice,
  priceAlertLevel,
  onSetPriceAlert,
  fitTrigger,
  hotkeyAction,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const priceSpanRef = useRef<number>(priceStep * 48);
  const colWidthRef = useRef<number>(isKlineTimeframe ? 8 : 4);
  const centerPriceRef = useRef<number>(0);
  const panOffsetColsRef = useRef<number>(0);

  const slicesRef = useRef<HeatmapSlice[]>(slices);
  const currentBidsRef = useRef<[number, number][]>(currentBids);
  const currentAsksRef = useRef<[number, number][]>(currentAsks);
  const tickerRef = useRef<TickerStats>(ticker);
  const priceStepRef = useRef<PriceStep>(priceStep);
  const isKlineRef = useRef<boolean>(isKlineTimeframe);
  const showVolumePaneRef = useRef<boolean>(showVolumePane);

  slicesRef.current = slices;
  currentBidsRef.current = currentBids;
  currentAsksRef.current = currentAsks;
  tickerRef.current = ticker;
  priceStepRef.current = priceStep;
  isKlineRef.current = isKlineTimeframe;
  showVolumePaneRef.current = showVolumePane;

  const dragModeRef = useRef<'none' | 'pan2d' | 'zoomPriceAxis' | 'zoomTimeAxis'>('none');
  const dragStartXRef = useRef<number>(0);
  const dragStartYRef = useRef<number>(0);
  const dragStartCenterRef = useRef<number>(0);
  const dragStartPanColsRef = useRef<number>(0);
  const dragStartPriceSpanRef = useRef<number>(0);
  const dragStartColWidthRef = useRef<number>(0);

  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);

  const clusterDetailMap = useMemo(() => {
    const map = new Map<number, WallLevel>();
    for (const c of bidClusters) map.set(c.price, c);
    for (const c of askClusters) map.set(c.price, c);
    return map;
  }, [bidClusters, askClusters]);

  const liveBookData = useMemo(() => {
    const liveBidMap = new Map<number, number>();
    const liveAskMap = new Map<number, number>();
    let maxLiveLevelBtc = 0.1;
    for (const [b, v] of currentBids) {
      liveBidMap.set(b, v);
      if (v > maxLiveLevelBtc) maxLiveLevelBtc = v;
    }
    for (const [b, v] of currentAsks) {
      liveAskMap.set(b, v);
      if (v > maxLiveLevelBtc) maxLiveLevelBtc = v;
    }
    return { liveBidMap, liveAskMap, maxLiveLevelBtc };
  }, [currentBids, currentAsks]);

  const scheduleRenderRef = useRef<() => void>(() => {});
  const needsRedrawStateRef = useRef<boolean>(true);
  const needsRedrawRef = useMemo(
    () => ({
      get current() {
        return needsRedrawStateRef.current;
      },
      set current(val: boolean) {
        needsRedrawStateRef.current = val;
        if (val) scheduleRenderRef.current();
      },
    }),
    []
  );
  const lastHoverKeyRef = useRef<string>('');
  const vpCacheRef = useRef<{
    key: string;
    entries: [number, { buy: number; sell: number; total: number }][];
    maxBucketVol: number;
    pocPrice: number;
    valPrice: number;
    vahPrice: number;
  } | null>(null);
  const slicesVersionRef = useRef<number>(0);
  const lastSlicesRef = useRef<HeatmapSlice[]>(slices);
  if (lastSlicesRef.current !== slices) {
    lastSlicesRef.current = slices;
    slicesVersionRef.current++;
  }

  // Rolling 30s DOM snapshot ring for Pull/Stack Spoofing Delta
  const domHistoryRef = useRef<
    { ts: number; scopeKey: string; bids: Map<number, number>; asks: Map<number, number> }[]
  >([]);
  const domDeltaMaps = useMemo(() => {
    const now = Date.now();
    const scopeKey = `${exchange}:${bookScope}:${priceStep}`;
    const hist = domHistoryRef.current;
    if (hist.length > 0 && hist[0].scopeKey !== scopeKey) {
      hist.length = 0;
    }
    if (
      (liveBookData.liveBidMap.size > 0 || liveBookData.liveAskMap.size > 0) &&
      (hist.length === 0 || now - hist[hist.length - 1].ts >= 1000)
    ) {
      hist.push({
        ts: now,
        scopeKey,
        bids: liveBookData.liveBidMap,
        asks: liveBookData.liveAskMap,
      });
      while (hist.length > 1 && now - hist[0].ts > 32_000) {
        hist.shift();
      }
    }
    const refSnap = hist[0];
    const bidDelta = new Map<number, number>();
    const askDelta = new Map<number, number>();
    if (refSnap) {
      for (const [p, v] of liveBookData.liveBidMap.entries()) {
        const d = v - (refSnap.bids.get(p) || 0);
        if (Math.abs(d) >= 0.05) bidDelta.set(p, d);
      }
      for (const [p, v] of liveBookData.liveAskMap.entries()) {
        const d = v - (refSnap.asks.get(p) || 0);
        if (Math.abs(d) >= 0.05) askDelta.set(p, d);
      }
    }
    return { bidDelta, askDelta };
  }, [exchange, bookScope, priceStep, liveBookData]);

  const heatmapCacheCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const heatmapCacheKeyRef = useRef<string>('');

  const renderParamsRef = useRef({
    clusterDetailMap,
    liveBookData,
    domDeltaMaps,
    bookScope,
    timeframe,
    colormap,
    minFilterBtc,
    maxCeilingBtc,
    showBidAskLines,
    showTradeBubbles,
    showCandlesticks,
    showVolumeProfile,
    showLiquidations,
    showSpoofDelta,
    highlightedPrice,
    priceAlertLevel,
  });
  renderParamsRef.current = {
    clusterDetailMap,
    liveBookData,
    domDeltaMaps,
    bookScope,
    timeframe,
    colormap,
    minFilterBtc,
    maxCeilingBtc,
    showBidAskLines,
    showTradeBubbles,
    showCandlesticks,
    showVolumeProfile,
    showLiquidations,
    showSpoofDelta,
    highlightedPrice,
    priceAlertLevel,
  };

  useEffect(() => {
    needsRedrawRef.current = true;
  }, [
    slices,
    currentBids,
    currentAsks,
    bidClusters,
    askClusters,
    ticker,
    priceStep,
    bookScope,
    timeframe,
    isKlineTimeframe,
    colormap,
    minFilterBtc,
    maxCeilingBtc,
    showBidAskLines,
    showTradeBubbles,
    showCandlesticks,
    showVolumePane,
    showVolumeProfile,
    showLiquidations,
    showSpoofDelta,
    highlightedPrice,
    priceAlertLevel,
    fitTrigger,
  ]);

  const autoFitViewport = useCallback(() => {
    const curSlices = slicesRef.current;
    const curTicker = tickerRef.current;
    const pStep = priceStepRef.current;
    const isKline = isKlineRef.current;

    if (curSlices.length === 0) return;

    const visibleCount = Math.min(curSlices.length, isKline ? 110 : 200);
    const endIdx = Math.max(1, curSlices.length - Math.floor(panOffsetColsRef.current));
    const startIdx = Math.max(0, endIdx - visibleCount);
    const windowSlices = curSlices.slice(startIdx, endIdx);

    let minP = Infinity;
    let maxP = -Infinity;
    for (const s of windowSlices) {
      if (s.l > 0 && s.l < minP) minP = s.l;
      if (s.h > 0 && s.h > maxP) maxP = s.h;
    }

    if (panOffsetColsRef.current < 5 && curTicker.lastPrice > 0) {
      if (curTicker.lastPrice < minP) minP = curTicker.lastPrice;
      if (curTicker.lastPrice > maxP) maxP = curTicker.lastPrice;
    }

    if (!Number.isFinite(minP) || !Number.isFinite(maxP)) return;

    const minAllowedSpan = Math.max(20, pStep * 18);
    const rawSpan = Math.max(minAllowedSpan, (maxP - minP) * 1.35);
    priceSpanRef.current = rawSpan;
    centerPriceRef.current = +((minP + maxP) / 2).toFixed(2);
    needsRedrawRef.current = true;
  }, []);

  const fitFullOrderbook = useCallback(() => {
    const curTicker = tickerRef.current;
    const mid = curTicker.lastPrice || 60700;
    let minP = mid - 500;
    let maxP = mid + 500;

    const loBound = mid * 0.88;
    const hiBound = mid * 1.12;
    let foundMin = Infinity;
    let foundMax = -Infinity;

    for (const [b] of currentBidsRef.current) {
      if (b >= loBound && b < foundMin) foundMin = b;
    }
    for (const [a] of currentAsksRef.current) {
      if (a <= hiBound && a > foundMax) foundMax = a;
    }
    if (Number.isFinite(foundMin)) minP = foundMin;
    if (Number.isFinite(foundMax)) maxP = foundMax;

    const span = Math.max(100, (maxP - minP) * 1.12);
    priceSpanRef.current = span;
    centerPriceRef.current = +((minP + maxP) / 2).toFixed(2);
    needsRedrawRef.current = true;
    onToggleAutoFollow(false);
  }, [onToggleAutoFollow]);

  const lastFitTriggerRef = useRef<number>(0);
  useEffect(() => {
    if (fitTrigger > 0 && fitTrigger !== lastFitTriggerRef.current) {
      lastFitTriggerRef.current = fitTrigger;
      panOffsetColsRef.current = 0;
      autoFitViewport();
    }
  }, [fitTrigger, autoFitViewport]);

  useEffect(() => {
    colWidthRef.current = isKlineTimeframe ? 8 : 4;
    panOffsetColsRef.current = 0;
    needsRedrawRef.current = true;
  }, [timeframe, isKlineTimeframe, exchange]);

  useEffect(() => {
    const mid =
      ticker.bestBid > 0 && ticker.bestAsk > 0
        ? (ticker.bestBid + ticker.bestAsk) / 2
        : ticker.lastPrice;
    if (mid <= 0) return;

    if (centerPriceRef.current === 0) {
      centerPriceRef.current = Math.round(mid / priceStep) * priceStep;
      needsRedrawRef.current = true;
    } else if (
      autoFollowPrice &&
      dragModeRef.current === 'none' &&
      !isKlineTimeframe &&
      panOffsetColsRef.current === 0
    ) {
      const spanUsd = priceSpanRef.current;
      const drift = mid - centerPriceRef.current;
      if (Math.abs(drift) > spanUsd * 0.22) {
        centerPriceRef.current += drift * 0.25;
        needsRedrawRef.current = true;
      }
    }
  }, [ticker.bestBid, ticker.bestAsk, ticker.lastPrice, priceStep, autoFollowPrice, isKlineTimeframe]);

  useEffect(() => {
    if (highlightedPrice && highlightedPrice > 0) {
      centerPriceRef.current = highlightedPrice;
      needsRedrawRef.current = true;
    }
  }, [highlightedPrice]);

  const handleRecenterLiveSpread = useCallback(() => {
    const curTicker = tickerRef.current;
    const mid =
      curTicker.bestBid > 0 && curTicker.bestAsk > 0
        ? (curTicker.bestBid + curTicker.bestAsk) / 2
        : curTicker.lastPrice;
    if (mid > 0) {
      centerPriceRef.current = mid;
      panOffsetColsRef.current = 0;
      priceSpanRef.current = Math.max(40, priceStepRef.current * 45);
      needsRedrawRef.current = true;
    }
    onToggleAutoFollow(true);
  }, [onToggleAutoFollow]);

  const lastHotkeyIdRef = useRef<number>(0);
  useEffect(() => {
    if (!hotkeyAction || hotkeyAction.id === lastHotkeyIdRef.current) return;
    lastHotkeyIdRef.current = hotkeyAction.id;
    if (hotkeyAction.type === 'fit') {
      panOffsetColsRef.current = 0;
      autoFitViewport();
    } else if (hotkeyAction.type === 'recenter') {
      handleRecenterLiveSpread();
    } else if (hotkeyAction.type === 'fullbook') {
      fitFullOrderbook();
    }
  }, [hotkeyAction, autoFitViewport, handleRecenterLiveSpread, fitFullOrderbook]);

  const zoomPrice = useCallback(
    (factor: number) => {
      const minSpan = Math.max(8, priceStepRef.current * 3);
      priceSpanRef.current = Math.max(minSpan, Math.min(120000, priceSpanRef.current * factor));
      needsRedrawRef.current = true;
      onToggleAutoFollow(false);
    },
    [onToggleAutoFollow]
  );

  const zoomTime = useCallback((factor: number) => {
    colWidthRef.current = Math.max(1.5, Math.min(42, colWidthRef.current * factor));
    needsRedrawRef.current = true;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const volPaneH = showVolumePaneRef.current ? VOLUME_PANE_HEIGHT : 0;
      const mainChartW = Math.max(200, rect.width - DOM_PANEL_WIDTH - PRICE_AXIS_WIDTH);
      const mainChartH = Math.max(120, rect.height - TIME_AXIS_HEIGHT - volPaneH);

      const dir = Math.sign(e.deltaY);
      if (dir === 0) return;

      const isOverPriceOrDom = x > mainChartW;
      const isOverTimeAxis = y > mainChartH + volPaneH;

      if (e.shiftKey || isOverTimeAxis) {
        const timeFactor = dir < 0 ? 1.16 : 0.86;
        colWidthRef.current = Math.max(1.5, Math.min(42, colWidthRef.current * timeFactor));
        needsRedrawRef.current = true;
        return;
      }

      const priceFactor = dir > 0 ? 1.15 : 0.87;
      const minSpan = Math.max(8, priceStepRef.current * 3);
      const oldSpan = priceSpanRef.current;
      const newSpan = Math.max(minSpan, Math.min(120000, oldSpan * priceFactor));

      if (!isOverPriceOrDom && y >= 0 && y <= mainChartH) {
        const normY = 1 - y / mainChartH;
        const oldMin = centerPriceRef.current - oldSpan / 2;
        const hoveredPrice = oldMin + normY * oldSpan;
        const newMin = hoveredPrice - normY * newSpan;
        centerPriceRef.current = newMin + newSpan / 2;
      }

      priceSpanRef.current = newSpan;
      onToggleAutoFollow(false);

      if (e.ctrlKey || e.metaKey) {
        const timeFactor = dir < 0 ? 1.14 : 0.88;
        colWidthRef.current = Math.max(1.5, Math.min(42, colWidthRef.current * timeFactor));
      }
      needsRedrawRef.current = true;
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [onToggleAutoFollow]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const volPaneH = showVolumePane ? VOLUME_PANE_HEIGHT : 0;
      const mainChartW = Math.max(200, rect.width - DOM_PANEL_WIDTH - PRICE_AXIS_WIDTH);
      const mainChartH = Math.max(120, rect.height - TIME_AXIS_HEIGHT - volPaneH);

      dragStartXRef.current = e.clientX;
      dragStartYRef.current = e.clientY;
      dragStartCenterRef.current = centerPriceRef.current;
      dragStartPanColsRef.current = panOffsetColsRef.current;
      dragStartPriceSpanRef.current = priceSpanRef.current;
      dragStartColWidthRef.current = colWidthRef.current;

      if (x >= mainChartW + DOM_PANEL_WIDTH) {
        dragModeRef.current = 'zoomPriceAxis';
      } else if (y >= mainChartH + volPaneH) {
        dragModeRef.current = 'zoomTimeAxis';
      } else {
        dragModeRef.current = 'pan2d';
      }

      onToggleAutoFollow(false);
      needsRedrawRef.current = true;
    },
    [onToggleAutoFollow, showVolumePane]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      mousePosRef.current = { x, y };
      needsRedrawRef.current = true;

      const mode = dragModeRef.current;
      if (mode === 'none') return;

      const dx = e.clientX - dragStartXRef.current;
      const dy = e.clientY - dragStartYRef.current;

      if (mode === 'zoomPriceAxis') {
        const factor = Math.pow(1.006, dy);
        const minSpan = Math.max(8, priceStepRef.current * 3);
        priceSpanRef.current = Math.max(
          minSpan,
          Math.min(120000, dragStartPriceSpanRef.current * factor)
        );
      } else if (mode === 'zoomTimeAxis') {
        const factor = Math.pow(1.006, -dx);
        colWidthRef.current = Math.max(
          1.5,
          Math.min(42, dragStartColWidthRef.current * factor)
        );
      } else if (mode === 'pan2d') {
        const volH = showVolumePane ? VOLUME_PANE_HEIGHT : 0;
        const chartH = Math.max(100, rect.height - TIME_AXIS_HEIGHT - volH);
        const spanUsd = priceSpanRef.current;
        const priceDelta = (dy / chartH) * spanUsd;
        centerPriceRef.current = dragStartCenterRef.current + priceDelta;

        const dCols = dx / colWidthRef.current;
        const maxPan = Math.max(0, slicesRef.current.length - 10);
        panOffsetColsRef.current = Math.max(0, Math.min(maxPan, dragStartPanColsRef.current + dCols));
      }
    },
    [showVolumePane]
  );

  const handleMouseUpOrLeave = useCallback(() => {
    dragModeRef.current = 'none';
    needsRedrawRef.current = true;
  }, []);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const mainChartW = Math.max(200, rect.width - DOM_PANEL_WIDTH - PRICE_AXIS_WIDTH);
      if (x >= mainChartW) {
        fitFullOrderbook();
      } else {
        panOffsetColsRef.current = 0;
        autoFitViewport();
      }
      needsRedrawRef.current = true;
    },
    [autoFitViewport, fitFullOrderbook]
  );

  useEffect(() => {
    let animId = 0;
    const containerEl = containerRef.current;
    const resizeObs =
      containerEl && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            needsRedrawRef.current = true;
          })
        : null;
    if (resizeObs && containerEl) {
      resizeObs.observe(containerEl);
    }

    const render = () => {
      if (!needsRedrawRef.current) return;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      needsRedrawRef.current = false;

      const slices = slicesRef.current;
      const currentBids = currentBidsRef.current;
      const currentAsks = currentAsksRef.current;
      const ticker = tickerRef.current;
      const priceStep = priceStepRef.current;
      const isKlineTimeframe = isKlineRef.current;
      const showVolumePane = showVolumePaneRef.current;
      const {
        clusterDetailMap,
        liveBookData,
        domDeltaMaps,
        bookScope,
        timeframe,
        colormap,
        minFilterBtc,
        maxCeilingBtc,
        showBidAskLines,
        showTradeBubbles,
        showCandlesticks,
        showVolumeProfile,
        showLiquidations,
        showSpoofDelta,
        highlightedPrice,
        priceAlertLevel,
      } = renderParamsRef.current;
      const { liveBidMap, liveAskMap, maxLiveLevelBtc } = liveBookData;
      const { bidDelta, askDelta } = domDeltaMaps;

      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);

      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.save();
      ctx.scale(dpr, dpr);

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);

      const volPaneH = showVolumePane ? VOLUME_PANE_HEIGHT : 0;
      const mainChartW = Math.max(200, width - DOM_PANEL_WIDTH - PRICE_AXIS_WIDTH);
      const mainChartH = Math.max(120, height - TIME_AXIS_HEIGHT - volPaneH);

      const nowLineX = Math.floor(mainChartW * 0.86);
      const liveProjectionW = mainChartW - nowLineX;

      const colWidth = colWidthRef.current;
      const priceSpan = Math.max(8, priceSpanRef.current);

      const mid =
        ticker.bestBid > 0 && ticker.bestAsk > 0
          ? (ticker.bestBid + ticker.bestAsk) / 2
          : ticker.lastPrice || 60700;
      const centerPrice = centerPriceRef.current || mid;
      const minPrice = centerPrice - priceSpan / 2;
      const maxPrice = centerPrice + priceSpan / 2;
      const pxPerUsd = mainChartH / priceSpan;
      const rowHeight = Math.max(1.4, priceStep * pxPerUsd);

      const priceToY = (p: number) => mainChartH - ((p - minPrice) / priceSpan) * mainChartH;
      const yToPrice = (y: number) => maxPrice - (y / mainChartH) * priceSpan;

      const maxVisibleCols = Math.ceil(nowLineX / colWidth);
      const panCols = Math.floor(panOffsetColsRef.current);
      const endIdx = Math.max(0, slices.length - panCols);
      const startIdx = Math.max(0, endIdx - maxVisibleCols);
      const visibleSlices = slices.slice(startIdx, endIdx);

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, mainChartW, mainChartH);
      ctx.clip();

      // Offscreen cache for historical heatmap layer (skips re-drawing rects on crosshair moves)
      const hmCacheKey = [
        mainChartW,
        mainChartH,
        dpr,
        slicesVersionRef.current,
        startIdx,
        endIdx,
        minPrice.toFixed(2),
        maxPrice.toFixed(2),
        colWidth.toFixed(3),
        priceStep,
        colormap,
        minFilterBtc,
        maxCeilingBtc,
      ].join('|');

      let hmCanvas = heatmapCacheCanvasRef.current;
      if (!hmCanvas) {
        hmCanvas = document.createElement('canvas');
        heatmapCacheCanvasRef.current = hmCanvas;
      }

      if (heatmapCacheKeyRef.current !== hmCacheKey) {
        heatmapCacheKeyRef.current = hmCacheKey;
        const targetW = Math.max(1, Math.floor(mainChartW * dpr));
        const targetH = Math.max(1, Math.floor(mainChartH * dpr));
        if (hmCanvas.width !== targetW || hmCanvas.height !== targetH) {
          hmCanvas.width = targetW;
          hmCanvas.height = targetH;
        }
        const hctx = hmCanvas.getContext('2d');
        if (hctx) {
          hctx.save();
          hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          hctx.clearRect(0, 0, mainChartW, mainChartH);

          const drawH = Math.ceil(rowHeight + 0.4);
          let lastFill = '';
          for (let i = 0; i < visibleSlices.length; i++) {
            const s = visibleSlices[i];
            const colIndexFromRight = visibleSlices.length - 1 - i;
            const x = nowLineX - (colIndexFromRight + 1) * colWidth;
            if (x + colWidth < 0) continue;

            const drawW = Math.ceil(colWidth + 0.5);

            for (let j = 0; j < s.bids.length; j++) {
              const [bucketFloor, vol] = s.bids[j];
              if (vol < minFilterBtc || bucketFloor + priceStep < minPrice || bucketFloor > maxPrice)
                continue;
              const color = getLiquidityColor(vol, minFilterBtc, maxCeilingBtc, colormap, 'Bid');
              if (!color) continue;
              if (color !== lastFill) {
                hctx.fillStyle = color;
                lastFill = color;
              }
              hctx.fillRect(x, priceToY(bucketFloor + priceStep), drawW, drawH);
            }

            for (let j = 0; j < s.asks.length; j++) {
              const [bucketFloor, vol] = s.asks[j];
              if (vol < minFilterBtc || bucketFloor + priceStep < minPrice || bucketFloor > maxPrice)
                continue;
              const color = getLiquidityColor(vol, minFilterBtc, maxCeilingBtc, colormap, 'Ask');
              if (!color) continue;
              if (color !== lastFill) {
                hctx.fillStyle = color;
                lastFill = color;
              }
              hctx.fillRect(x, priceToY(bucketFloor + priceStep), drawW, drawH);
            }
          }
          hctx.restore();
        }
      }

      ctx.drawImage(hmCanvas, 0, 0, mainChartW, mainChartH);

      // Optional Session Volume Profile (POC / VAH / VAL) on left edge — cached across crosshair moves
      if (showVolumeProfile && visibleSlices.length > 0) {
        const vpKey = `${slicesVersionRef.current}:${startIdx}:${endIdx}:${priceStep}`;
        let vpData = vpCacheRef.current;
        if (!vpData || vpData.key !== vpKey) {
          const vpMap = new Map<number, { buy: number; sell: number; total: number }>();
          const invStep = 1 / priceStep;
          let maxBucketVol = 0;
          let totalSessionVol = 0;

          for (let i = 0; i < visibleSlices.length; i++) {
            const s = visibleSlices[i];
            const tot = s.bv + s.sv;
            if (tot <= 0) continue;
            const loB = Math.floor(s.l * invStep) * priceStep;
            const hiB = Math.floor(s.h * invStep) * priceStep;
            const steps = Math.max(1, Math.min(40, Math.round((hiB - loB) / priceStep) + 1));
            const buyPart = s.bv / steps;
            const sellPart = s.sv / steps;
            for (let k = 0; k < steps; k++) {
              const b = Math.round((loB + k * priceStep) * 100) / 100;
              let cur = vpMap.get(b);
              if (!cur) {
                cur = { buy: 0, sell: 0, total: 0 };
                vpMap.set(b, cur);
              }
              cur.buy += buyPart;
              cur.sell += sellPart;
              cur.total += buyPart + sellPart;
              if (cur.total > maxBucketVol) maxBucketVol = cur.total;
            }
            totalSessionVol += tot;
          }

          if (maxBucketVol > 0 && vpMap.size > 0) {
            const vpEntries = Array.from(vpMap.entries()).sort((a, b) => a[0] - b[0]);
            let pocIdx = 0;
            for (let i = 1; i < vpEntries.length; i++) {
              if (vpEntries[i][1].total > vpEntries[pocIdx][1].total) pocIdx = i;
            }
            const pocPrice = vpEntries[pocIdx][0];

            let accVol = vpEntries[pocIdx][1].total;
            let loIdx = pocIdx;
            let hiIdx = pocIdx;
            const targetVol = totalSessionVol * 0.7;
            while (accVol < targetVol && (loIdx > 0 || hiIdx < vpEntries.length - 1)) {
              const leftVol = loIdx > 0 ? vpEntries[loIdx - 1][1].total : -1;
              const rightVol = hiIdx < vpEntries.length - 1 ? vpEntries[hiIdx + 1][1].total : -1;
              if (rightVol >= leftVol) {
                hiIdx++;
                accVol += vpEntries[hiIdx][1].total;
              } else {
                loIdx--;
                accVol += vpEntries[loIdx][1].total;
              }
            }
            vpData = {
              key: vpKey,
              entries: vpEntries,
              maxBucketVol,
              pocPrice,
              valPrice: vpEntries[loIdx][0],
              vahPrice: vpEntries[hiIdx][0],
            };
          } else {
            vpData = {
              key: vpKey,
              entries: [],
              maxBucketVol: 0,
              pocPrice: 0,
              valPrice: 0,
              vahPrice: 0,
            };
          }
          vpCacheRef.current = vpData;
        }

        if (vpData.maxBucketVol > 0 && vpData.entries.length > 0) {
          const { entries: vpEntries, maxBucketVol, pocPrice, valPrice, vahPrice } = vpData;
          const maxVpW = Math.min(96, Math.floor(mainChartW * 0.13));

          for (const [b, stats] of vpEntries) {
            if (b + priceStep < minPrice || b > maxPrice) continue;
            const yTop = priceToY(b + priceStep);
            const totalW = (stats.total / maxBucketVol) * maxVpW;
            const buyW = (stats.buy / stats.total) * totalW;
            const sellW = totalW - buyW;
            const barH = Math.max(1.2, rowHeight - 0.5);
            const isInVa = b >= valPrice && b <= vahPrice;

            ctx.fillStyle = isInVa ? 'rgba(16, 185, 129, 0.32)' : 'rgba(16, 185, 129, 0.15)';
            ctx.fillRect(0, yTop, buyW, barH);
            ctx.fillStyle = isInVa ? 'rgba(244, 63, 94, 0.32)' : 'rgba(244, 63, 94, 0.15)';
            ctx.fillRect(buyW, yTop, sellW, barH);
          }

          const drawVpLine = (price: number, label: string, color: string, dash: number[]) => {
            if (price < minPrice || price > maxPrice) return;
            const y = Math.round(priceToY(price + priceStep / 2)) + 0.5;
            ctx.strokeStyle = color;
            ctx.lineWidth = label === 'POC' ? 1.4 : 1;
            ctx.setLineDash(dash);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(nowLineX, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = color;
            ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`${label} $${price.toFixed(0)}`, 4, y - 2);
          };

          drawVpLine(pocPrice, 'POC', 'rgba(250, 204, 21, 0.85)', [5, 3]);
          drawVpLine(vahPrice, 'VAH', 'rgba(148, 163, 184, 0.65)', [2, 3]);
          drawVpLine(valPrice, 'VAL', 'rgba(148, 163, 184, 0.65)', [2, 3]);
        }
      }

      const [visBidStart, visBidEnd] = findVisibleDescRange(
        currentBids,
        minPrice,
        maxPrice,
        priceStep
      );
      const [visAskStart, visAskEnd] = findVisibleAscRange(
        currentAsks,
        minPrice,
        maxPrice,
        priceStep
      );

      for (let idx = visBidStart; idx < visBidEnd; idx++) {
        const [bucketFloor, vol] = currentBids[idx];
        const color = getLiquidityColor(vol, minFilterBtc, maxCeilingBtc, colormap, 'Bid');
        if (!color) continue;
        const yTop = priceToY(bucketFloor + priceStep);
        ctx.fillStyle = color;
        ctx.fillRect(nowLineX, yTop, liveProjectionW, Math.ceil(rowHeight + 0.3));
      }

      for (let idx = visAskStart; idx < visAskEnd; idx++) {
        const [bucketFloor, vol] = currentAsks[idx];
        const color = getLiquidityColor(vol, minFilterBtc, maxCeilingBtc, colormap, 'Ask');
        if (!color) continue;
        const yTop = priceToY(bucketFloor + priceStep);
        ctx.fillStyle = color;
        ctx.fillRect(nowLineX, yTop, liveProjectionW, Math.ceil(rowHeight + 0.3));
      }

      const gridStep =
        priceSpan <= 30
          ? 2
          : priceSpan <= 80
            ? 5
            : priceSpan <= 200
              ? 10
              : priceSpan <= 500
                ? 25
                : priceSpan <= 1200
                  ? 50
                  : priceSpan <= 3000
                    ? 100
                    : priceSpan <= 8000
                      ? 250
                      : priceSpan <= 20000
                        ? 500
                        : 1000;
      const firstGridPrice = Math.ceil(minPrice / gridStep) * gridStep;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      for (let p = firstGridPrice; p <= maxPrice; p += gridStep) {
        const y = Math.round(priceToY(p)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(mainChartW, y);
        ctx.stroke();
      }

      if (highlightedPrice && highlightedPrice >= minPrice && highlightedPrice <= maxPrice) {
        const hy = priceToY(highlightedPrice + priceStep / 2);
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, hy);
        ctx.lineTo(mainChartW, hy);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (priceAlertLevel && priceAlertLevel >= minPrice && priceAlertLevel <= maxPrice) {
        const ay = priceToY(priceAlertLevel);
        ctx.strokeStyle = 'rgba(232, 121, 249, 0.95)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(0, ay);
        ctx.lineTo(mainChartW, ay);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(232, 121, 249, 0.95)';
        ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`🔔 ALERT $${priceAlertLevel.toFixed(1)}`, nowLineX - 6, ay - 3);
      }

      if (showCandlesticks && visibleSlices.length > 0) {
        const candleW = Math.max(2, colWidth * 0.72);
        let highestPrice = -Infinity;
        let highestX = 0;
        let lowestPrice = Infinity;
        let lowestX = 0;

        for (let i = 0; i < visibleSlices.length; i++) {
          const s = visibleSlices[i];
          const colIndexFromRight = visibleSlices.length - 1 - i;
          const cx = nowLineX - (colIndexFromRight + 0.5) * colWidth;
          if (cx < 0) continue;

          if (s.h > highestPrice) {
            highestPrice = s.h;
            highestX = cx;
          }
          if (s.l < lowestPrice) {
            lowestPrice = s.l;
            lowestX = cx;
          }

          const isBull = s.c >= s.o;
          const bodyColor = isBull ? '#10b981' : '#f43f5e';
          const wickColor = isBull ? '#34d399' : '#fb7185';
          const yHigh = priceToY(s.h);
          const yLow = priceToY(s.l);
          const yOpen = priceToY(s.o);
          const yClose = priceToY(s.c);
          const wickW = Math.max(1, colWidth >= 6 ? 1.3 : 1);

          ctx.strokeStyle = '#000000';
          ctx.lineWidth = wickW + 1.4;
          ctx.beginPath();
          ctx.moveTo(cx, yHigh);
          ctx.lineTo(cx, yLow);
          ctx.stroke();

          ctx.strokeStyle = wickColor;
          ctx.lineWidth = wickW;
          ctx.beginPath();
          ctx.moveTo(cx, yHigh);
          ctx.lineTo(cx, yLow);
          ctx.stroke();

          const bodyTop = Math.min(yOpen, yClose);
          const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
          ctx.fillStyle = bodyColor;
          ctx.fillRect(cx - candleW / 2, bodyTop, candleW, bodyH);

          if (colWidth >= 2.5) {
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.strokeRect(cx - candleW / 2, bodyTop, candleW, bodyH);
          }
        }

        if (isKlineTimeframe && Number.isFinite(highestPrice) && Number.isFinite(lowestPrice)) {
          ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
          const hy = priceToY(highestPrice);
          if (hy > 12 && hy < mainChartH - 12) {
            ctx.fillStyle = '#34d399';
            ctx.textAlign = highestX > mainChartW - 90 ? 'right' : 'left';
            ctx.fillText(
              `H: $${highestPrice.toFixed(1)}`,
              highestX + (highestX > mainChartW - 90 ? -6 : 6),
              hy - 6
            );
          }
          const ly = priceToY(lowestPrice);
          if (ly > 12 && ly < mainChartH - 12) {
            ctx.fillStyle = '#fb7185';
            ctx.textAlign = lowestX > mainChartW - 90 ? 'right' : 'left';
            ctx.fillText(
              `L: $${lowestPrice.toFixed(1)}`,
              lowestX + (lowestX > mainChartW - 90 ? -6 : 6),
              ly + 11
            );
          }
        }
      }

      if (showBidAskLines && visibleSlices.length > 0) {
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < visibleSlices.length; i++) {
          const s = visibleSlices[i];
          const colIndexFromRight = visibleSlices.length - 1 - i;
          const x = nowLineX - (colIndexFromRight + 0.5) * colWidth;
          const y = priceToY(s.bb);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        if (panCols === 0 && ticker.bestBid > 0) {
          ctx.lineTo(mainChartW, priceToY(ticker.bestBid));
        }
        ctx.stroke();

        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < visibleSlices.length; i++) {
          const s = visibleSlices[i];
          const colIndexFromRight = visibleSlices.length - 1 - i;
          const x = nowLineX - (colIndexFromRight + 0.5) * colWidth;
          const y = priceToY(s.ba);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        if (panCols === 0 && ticker.bestAsk > 0) {
          ctx.lineTo(mainChartW, priceToY(ticker.bestAsk));
        }
        ctx.stroke();
      }

      if (showTradeBubbles && visibleSlices.length > 0) {
        let maxBubbleVol = 1;
        for (const s of visibleSlices) {
          for (const tr of s.trades) {
            if (tr.v > maxBubbleVol) maxBubbleVol = tr.v;
          }
        }

        for (let i = 0; i < visibleSlices.length; i++) {
          const s = visibleSlices[i];
          if (!s.trades || s.trades.length === 0) continue;
          const colIndexFromRight = visibleSlices.length - 1 - i;
          const cx = nowLineX - (colIndexFromRight + 0.5) * colWidth;
          if (cx < -20) continue;

          for (const tr of s.trades) {
            if (tr.p < minPrice || tr.p > maxPrice) continue;
            const cy = priceToY(tr.p);
            const radius = isKlineTimeframe
              ? Math.max(2.2, Math.min(18, 2.2 + Math.sqrt(tr.v / maxBubbleVol) * 14))
              : Math.max(2.2, Math.min(26, 2.2 + Math.sqrt(tr.v) * 6.8));
            const isBuy = tr.s === 'Buy';

            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fillStyle = isBuy
              ? 'rgba(16, 185, 129, 0.46)'
              : 'rgba(244, 63, 94, 0.46)';
            ctx.fill();

            ctx.lineWidth = radius >= 8 ? 1.6 : 1;
            ctx.strokeStyle = isBuy ? '#34d399' : '#fb7185';
            ctx.stroke();

            if (!isKlineTimeframe && tr.v >= 0.8 && radius >= 8) {
              ctx.fillStyle = '#f8fafc';
              ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(tr.v.toFixed(1), cx, cy);
            }
          }
        }
      }

      if (showLiquidations && visibleSlices.length > 0) {
        for (let i = 0; i < visibleSlices.length; i++) {
          const s = visibleSlices[i];
          if (!s.liquidations || s.liquidations.length === 0) continue;
          const colIndexFromRight = visibleSlices.length - 1 - i;
          const cx = nowLineX - (colIndexFromRight + 0.5) * colWidth;
          if (cx < -20) continue;

          for (const liq of s.liquidations) {
            if (liq.p < minPrice || liq.p > maxPrice) continue;
            const cy = priceToY(liq.p);
            const r = Math.max(4.5, Math.min(11, 4 + Math.sqrt(liq.usd / 25_000) * 3));
            const isShortLiq = liq.side === 'Short';

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(cx, cy - r);
            ctx.lineTo(cx + r, cy);
            ctx.lineTo(cx, cy + r);
            ctx.lineTo(cx - r, cy);
            ctx.closePath();
            ctx.fillStyle = isShortLiq
              ? 'rgba(56, 189, 248, 0.88)'
              : 'rgba(251, 191, 36, 0.92)';
            ctx.fill();
            ctx.lineWidth = 1.2;
            ctx.strokeStyle = '#000000';
            ctx.stroke();

            if (liq.usd >= 20_000) {
              ctx.fillStyle = isShortLiq ? '#bae6fd' : '#fef08a';
              ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(
                `⚡${liq.side === 'Long' ? 'L' : 'S'} $${Math.round(liq.usd / 1000)}k`,
                cx + r + 3,
                cy
              );
            }
            ctx.restore();
          }
        }
      }

      if (ticker.lastPrice >= minPrice && ticker.lastPrice <= maxPrice) {
        const curY = Math.round(priceToY(ticker.lastPrice)) + 0.5;
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(0, curY);
        ctx.lineTo(mainChartW, curY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(nowLineX + 0.5, 0);
      ctx.lineTo(nowLineX + 0.5, mainChartH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
      ctx.fillRect(nowLineX + 4, 6, Math.max(46, liveProjectionW - 8), 18);
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('LIVE BOOK', nowLineX + 8, 15);

      ctx.restore();

      if (showVolumePane) {
        const volTop = mainChartH;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, volTop, mainChartW, volPaneH);

        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, volTop + 0.5);
        ctx.lineTo(width, volTop + 0.5);
        ctx.stroke();

        let maxSliceVol = 0.05;
        let runningCvd = 0;
        let minCvd = 0;
        let maxCvd = 0;
        let runningSpotCvd = 0;
        let minSpotCvd = 0;
        let maxSpotCvd = 0;
        let hasSpotVol = false;
        const cvdPoints: { x: number; cvd: number; spotCvd: number }[] = [];

        for (let i = 0; i < visibleSlices.length; i++) {
          const s = visibleSlices[i];
          const tot = s.bv + s.sv;
          if (tot > maxSliceVol) maxSliceVol = tot;
          runningCvd += s.bv - s.sv;
          if (runningCvd < minCvd) minCvd = runningCvd;
          if (runningCvd > maxCvd) maxCvd = runningCvd;

          const sBv = s.spotBv || 0;
          const sSv = s.spotSv || 0;
          if (sBv > 0 || sSv > 0) hasSpotVol = true;
          runningSpotCvd += sBv - sSv;
          if (runningSpotCvd < minSpotCvd) minSpotCvd = runningSpotCvd;
          if (runningSpotCvd > maxSpotCvd) maxSpotCvd = runningSpotCvd;

          const colIndexFromRight = visibleSlices.length - 1 - i;
          const x = nowLineX - (colIndexFromRight + 0.5) * colWidth;
          cvdPoints.push({ x, cvd: runningCvd, spotCvd: runningSpotCvd });
        }

        const innerH = volPaneH - 18;
        const barBaseY = volTop + volPaneH - 6;
        const barW = Math.max(1, colWidth - 0.8);

        for (let i = 0; i < visibleSlices.length; i++) {
          const s = visibleSlices[i];
          const colIndexFromRight = visibleSlices.length - 1 - i;
          const x = nowLineX - (colIndexFromRight + 1) * colWidth;
          if (x + colWidth < 0) continue;

          const buyH = (s.bv / maxSliceVol) * innerH;
          const sellH = (s.sv / maxSliceVol) * innerH;

          if (buyH > 0.5) {
            ctx.fillStyle = 'rgba(16, 185, 129, 0.72)';
            ctx.fillRect(x, barBaseY - buyH, barW, buyH);
          }
          if (sellH > 0.5) {
            ctx.fillStyle = 'rgba(244, 63, 94, 0.72)';
            ctx.fillRect(x, barBaseY - buyH - sellH, barW, sellH);
          }
        }

        if (cvdPoints.length > 1) {
          const cvdRange = Math.max(0.1, maxCvd - minCvd);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          for (let i = 0; i < cvdPoints.length; i++) {
            const pt = cvdPoints[i];
            const cy =
              volTop + 14 + (1 - (pt.cvd - minCvd) / cvdRange) * (volPaneH - 22);
            if (i === 0) ctx.moveTo(pt.x, cy);
            else ctx.lineTo(pt.x, cy);
          }
          ctx.stroke();

          if (hasSpotVol) {
            const spotRange = Math.max(0.1, maxSpotCvd - minSpotCvd);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            for (let i = 0; i < cvdPoints.length; i++) {
              const pt = cvdPoints[i];
              const cy =
                volTop + 14 + (1 - (pt.spotCvd - minSpotCvd) / spotRange) * (volPaneH - 22);
              if (i === 0) ctx.moveTo(pt.x, cy);
              else ctx.lineTo(pt.x, cy);
            }
            ctx.stroke();
          }
        }

        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const cvdSign = runningCvd >= 0 ? '+' : '';
        ctx.fillStyle = '#38bdf8';
        ctx.fillText(
          `PERP CVD (${timeframe.toUpperCase()}): ${cvdSign}${runningCvd.toFixed(1)} BTC`,
          8,
          volTop + 5
        );
        if (hasSpotVol) {
          const spotSign = runningSpotCvd >= 0 ? '+' : '';
          ctx.fillStyle = '#f59e0b';
          ctx.fillText(
            `SPOT CVD: ${spotSign}${runningSpotCvd.toFixed(1)} BTC`,
            225,
            volTop + 5
          );
        }
      }

      const timeAxisTop = mainChartH + volPaneH;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, timeAxisTop, width, TIME_AXIS_HEIGHT);
      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(0, timeAxisTop + 0.5);
      ctx.lineTo(width, timeAxisTop + 0.5);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const pixelStep = 135;
      const colsPerLabel = Math.max(1, Math.round(pixelStep / colWidth));
      for (let i = visibleSlices.length - 1; i >= 0; i -= colsPerLabel) {
        const s = visibleSlices[i];
        const colIndexFromRight = visibleSlices.length - 1 - i;
        const x = nowLineX - (colIndexFromRight + 0.5) * colWidth;
        if (x < 55) break;
        const label = formatTimeAxisLabel(s.t, timeframe);
        ctx.fillText(label, x, timeAxisTop + TIME_AXIS_HEIGHT / 2);
      }

      const domLeft = mainChartW;
      ctx.fillStyle = '#000000';
      ctx.fillRect(domLeft, 0, DOM_PANEL_WIDTH, mainChartH + volPaneH);

      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(domLeft + 0.5, 0);
      ctx.lineTo(domLeft + 0.5, height);
      ctx.stroke();

      const domBarMaxW = DOM_PANEL_WIDTH - 12;
      const domNormalizer = Math.max(maxCeilingBtc, maxLiveLevelBtc);

      const visibleAsks: [number, number][] = [];
      for (let idx = visAskStart; idx < visAskEnd; idx++) {
        const row = currentAsks[idx];
        if (row[1] >= minFilterBtc) visibleAsks.push(row);
      }
      const sortedAskView = [...visibleAsks].sort((a, b) => b[1] - a[1]);
      const topAskSet = new Set(sortedAskView.slice(0, 6).map((x) => x[0]));

      const visibleBids: [number, number][] = [];
      for (let idx = visBidStart; idx < visBidEnd; idx++) {
        const row = currentBids[idx];
        if (row[1] >= minFilterBtc) visibleBids.push(row);
      }
      const sortedBidView = [...visibleBids].sort((a, b) => b[1] - a[1]);
      const topBidSet = new Set(sortedBidView.slice(0, 6).map((x) => x[0]));

      for (let idx = 0; idx < visibleAsks.length; idx++) {
        const [bucketFloor, vol] = visibleAsks[idx];
        const yTop = priceToY(bucketFloor + priceStep);
        const barW = Math.min(domBarMaxW, (vol / domNormalizer) * domBarMaxW);
        const isWhale = topAskSet.has(bucketFloor) && vol >= 1;

        ctx.fillStyle = isWhale
          ? 'rgba(244, 63, 94, 0.88)'
          : 'rgba(244, 63, 94, 0.42)';
        ctx.fillRect(domLeft + 2, yTop + 0.5, Math.max(2, barW), Math.max(1.5, rowHeight - 1));

        if ((rowHeight >= 10 && vol >= Math.max(0.2, minFilterBtc)) || (isWhale && vol >= 5)) {
          ctx.fillStyle = isWhale ? '#fff1f2' : '#fda4af';
          ctx.font = `${isWhale ? 'bold ' : ''}9px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            `${vol >= 10 ? vol.toFixed(1) : vol.toFixed(2)} BTC`,
            domLeft + 6,
            yTop + rowHeight / 2
          );
          if (showSpoofDelta) {
            const d30 = askDelta.get(bucketFloor) || 0;
            if (Math.abs(d30) >= Math.max(0.5, minFilterBtc)) {
              ctx.fillStyle = d30 > 0 ? '#38bdf8' : '#f59e0b';
              ctx.textAlign = 'right';
              ctx.fillText(
                `${d30 > 0 ? '+' : ''}${d30.toFixed(1)}`,
                domLeft + DOM_PANEL_WIDTH - 5,
                yTop + rowHeight / 2
              );
            }
          }
        }
      }

      for (let idx = 0; idx < visibleBids.length; idx++) {
        const [bucketFloor, vol] = visibleBids[idx];
        const yTop = priceToY(bucketFloor + priceStep);
        const barW = Math.min(domBarMaxW, (vol / domNormalizer) * domBarMaxW);
        const isWhale = topBidSet.has(bucketFloor) && vol >= 1;

        ctx.fillStyle = isWhale
          ? 'rgba(16, 185, 129, 0.88)'
          : 'rgba(16, 185, 129, 0.42)';
        ctx.fillRect(domLeft + 2, yTop + 0.5, Math.max(2, barW), Math.max(1.5, rowHeight - 1));

        if ((rowHeight >= 10 && vol >= Math.max(0.2, minFilterBtc)) || (isWhale && vol >= 5)) {
          ctx.fillStyle = isWhale ? '#ecfdf5' : '#6ee7b7';
          ctx.font = `${isWhale ? 'bold ' : ''}9px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            `${vol >= 10 ? vol.toFixed(1) : vol.toFixed(2)} BTC`,
            domLeft + 6,
            yTop + rowHeight / 2
          );
          if (showSpoofDelta) {
            const d30 = bidDelta.get(bucketFloor) || 0;
            if (Math.abs(d30) >= Math.max(0.5, minFilterBtc)) {
              ctx.fillStyle = d30 > 0 ? '#38bdf8' : '#f59e0b';
              ctx.textAlign = 'right';
              ctx.fillText(
                `${d30 > 0 ? '+' : ''}${d30.toFixed(1)}`,
                domLeft + DOM_PANEL_WIDTH - 5,
                yTop + rowHeight / 2
              );
            }
          }
        }
      }

      ctx.fillStyle = 'rgba(0, 0, 0, 0.94)';
      ctx.fillRect(domLeft + 1, 0, DOM_PANEL_WIDTH - 2, 22);
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`DOM (${bookScope.toUpperCase()})`, domLeft + 6, 11);
      if (showSpoofDelta) {
        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'right';
        ctx.fillText('Δ30s', domLeft + DOM_PANEL_WIDTH - 5, 11);
      }

      const axisLeft = mainChartW + DOM_PANEL_WIDTH;
      ctx.fillStyle = '#000000';
      ctx.fillRect(axisLeft, 0, PRICE_AXIS_WIDTH, height);

      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(axisLeft + 0.5, 0);
      ctx.lineTo(axisLeft + 0.5, height);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      for (let p = firstGridPrice; p <= maxPrice; p += gridStep) {
        const y = priceToY(p);
        if (y < 10 || y > mainChartH - 10) continue;
        ctx.fillText(p.toFixed(priceStep < 1 ? 1 : 0), axisLeft + 6, y);
      }

      if (ticker.bestAsk >= minPrice && ticker.bestAsk <= maxPrice) {
        const ay = priceToY(ticker.bestAsk);
        ctx.fillStyle = '#e11d48';
        ctx.fillRect(axisLeft + 1, ay - 9, PRICE_AXIS_WIDTH - 2, 18);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(ticker.bestAsk.toFixed(1), axisLeft + 5, ay);
      }

      if (ticker.bestBid >= minPrice && ticker.bestBid <= maxPrice) {
        const by = priceToY(ticker.bestBid);
        ctx.fillStyle = '#059669';
        ctx.fillRect(axisLeft + 1, by - 9, PRICE_AXIS_WIDTH - 2, 18);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(ticker.bestBid.toFixed(1), axisLeft + 5, by);
      }

      const m = mousePosRef.current;
      if (m && m.x >= 0 && m.x <= mainChartW + DOM_PANEL_WIDTH && m.y >= 0 && m.y <= mainChartH) {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);

        ctx.beginPath();
        ctx.moveTo(0, m.y);
        ctx.lineTo(mainChartW + DOM_PANEL_WIDTH, m.y);
        ctx.stroke();

        if (m.x <= mainChartW) {
          ctx.beginPath();
          ctx.moveTo(m.x, 0);
          ctx.lineTo(m.x, mainChartH + volPaneH);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        const hoveredPrice = yToPrice(m.y);
        const bucketFloor = +(Math.floor(hoveredPrice / priceStep) * priceStep).toFixed(2);
        const bucketCeil = +(bucketFloor + priceStep).toFixed(2);

        ctx.fillStyle = '#334155';
        ctx.fillRect(axisLeft + 1, m.y - 9, PRICE_AXIS_WIDTH - 2, 18);
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(hoveredPrice.toFixed(1), axisLeft + 5, m.y);

        let restingBtc = 0;
        let restingSide: 'Bid' | 'Ask' | null = null;
        let delta30sBtc: number | undefined;
        let ts: number | null = null;
        let bb = ticker.bestBid;
        let ba = ticker.bestAsk;
        let buyVolBtc = 0;
        let sellVolBtc = 0;
        let candleOpen: number | undefined;
        let candleHigh: number | undefined;
        let candleLow: number | undefined;
        let candleClose: number | undefined;
        const isLiveZone = m.x >= nowLineX;
        const clusterDetail = clusterDetailMap.get(bucketFloor);

        if (isLiveZone) {
          if (liveBidMap.has(bucketFloor)) {
            restingBtc = liveBidMap.get(bucketFloor) || 0;
            restingSide = 'Bid';
            delta30sBtc = bidDelta.get(bucketFloor);
          } else if (liveAskMap.has(bucketFloor)) {
            restingBtc = liveAskMap.get(bucketFloor) || 0;
            restingSide = 'Ask';
            delta30sBtc = askDelta.get(bucketFloor);
          }
        } else {
          const colsFromNow = Math.floor((nowLineX - m.x) / colWidth);
          const sliceIdx = visibleSlices.length - 1 - colsFromNow;
          if (sliceIdx >= 0 && sliceIdx < visibleSlices.length) {
            const sl = visibleSlices[sliceIdx];
            ts = sl.t;
            bb = sl.bb;
            ba = sl.ba;
            buyVolBtc = sl.bv;
            sellVolBtc = sl.sv;
            candleOpen = sl.o;
            candleHigh = sl.h;
            candleLow = sl.l;
            candleClose = sl.c;

            for (const [b, v] of sl.bids) {
              if (Math.abs(b - bucketFloor) < 1e-4) {
                restingBtc = v;
                restingSide = 'Bid';
                break;
              }
            }
            if (!restingSide) {
              for (const [b, v] of sl.asks) {
                if (Math.abs(b - bucketFloor) < 1e-4) {
                  restingBtc = v;
                  restingSide = 'Ask';
                  break;
                }
              }
            }
          }
        }

        const hoverKey = `${Math.round(m.x)}:${Math.round(m.y)}:${bucketFloor}:${restingBtc}:${delta30sBtc ?? ''}:${ts ?? 0}`;
        if (lastHoverKeyRef.current !== hoverKey) {
          lastHoverKeyRef.current = hoverKey;
          setHoverInfo({
            x: m.x,
            y: m.y,
            priceFloor: bucketFloor,
            priceCeil: bucketCeil,
            timestamp: ts,
            isLiveZone,
            restingBtc,
            restingSide,
            delta30sBtc,
            clusterDetail,
            bestBid: bb,
            bestAsk: ba,
            buyVolBtc,
            sellVolBtc,
            candleOpen,
            candleHigh,
            candleLow,
            candleClose,
          });
        }
      } else {
        if (lastHoverKeyRef.current !== '') {
          lastHoverKeyRef.current = '';
          setHoverInfo(null);
        }
      }

      ctx.restore();
    };

    const scheduleRender = () => {
      if (animId !== 0) return;
      animId = requestAnimationFrame(() => {
        animId = 0;
        render();
      });
    };
    scheduleRenderRef.current = scheduleRender;
    scheduleRender();

    return () => {
      if (animId !== 0) cancelAnimationFrame(animId);
      scheduleRenderRef.current = () => {};
      if (resizeObs) resizeObs.disconnect();
    };
  }, []);

  const exchangeLabel =
    exchange === 'combined'
      ? 'Merged'
      : exchange === 'hyperliquid'
        ? 'Hyperliquid'
        : exchange === 'coinbase'
          ? 'Coinbase'
          : exchange === 'okx'
            ? 'OKX'
            : exchange === 'binance'
              ? 'Binance'
              : 'Bybit';

  return (
    <div className="heatmap-stage" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="heatmap-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUpOrLeave}
        onDoubleClick={handleDoubleClick}
        onMouseLeave={() => {
          handleMouseUpOrLeave();
          mousePosRef.current = null;
          lastHoverKeyRef.current = '';
          needsRedrawRef.current = true;
          setHoverInfo(null);
        }}
      />

      <div className="heatmap-overlay-legend">
        <div className="legend-row">
          <span className="legend-label">{minFilterBtc.toFixed(1)} BTC</span>
          <div
            className="legend-gradient-bar"
            style={{ background: getColormapCssGradient(colormap) }}
          />
          <span className="legend-label">{maxCeilingBtc.toFixed(1)}+ BTC</span>
        </div>
        <div className="legend-meta">
          <span>{exchangeLabel}</span>
          <span>•</span>
          <span>TF: {timeframe.toUpperCase()}</span>
          <span>•</span>
          <span>Step: ${priceStep}</span>
          <span>•</span>
          <span>Wheel: Zoom | Shift+Wheel: Time | Drag: Pan</span>
          {isPaused && <span className="paused-pill">PAUSED</span>}
        </div>
      </div>

      <div className="viewport-floating-btns">
        <div className="zoom-btn-group">
          <button
            className="floating-btn"
            onClick={() => zoomPrice(0.75)}
            title="Zoom In Price (Y-Axis)"
          >
            Price +
          </button>
          <button
            className="floating-btn"
            onClick={() => zoomPrice(1.33)}
            title="Zoom Out Price (Y-Axis)"
          >
            Price −
          </button>
        </div>

        <div className="zoom-btn-group">
          <button
            className="floating-btn"
            onClick={() => zoomTime(1.25)}
            title="Widen Candles / Time (X-Axis)"
          >
            Time +
          </button>
          <button
            className="floating-btn"
            onClick={() => zoomTime(0.8)}
            title="Narrow Candles / Time (X-Axis)"
          >
            Time −
          </button>
        </div>

        <button
          className="floating-btn"
          onClick={fitFullOrderbook}
          title={`Zoom out to inspect all ${exchangeLabel} bid & ask clusters`}
        >
          ⤢ Full {exchangeLabel} Book
        </button>
        <button
          className="floating-btn"
          onClick={() => {
            panOffsetColsRef.current = 0;
            autoFitViewport();
          }}
          title="Fit visible historical candlesticks in view"
        >
          ⤢ Auto-Fit Candles
        </button>
        <button
          className="floating-btn primary"
          onClick={handleRecenterLiveSpread}
          title="Zoom & center onto live Best Bid / Ask orderbook spread (R)"
        >
          ⌖ Live Spread
        </button>

        {highlightedPrice && (
          <button
            className={`floating-btn ${priceAlertLevel === highlightedPrice ? 'btn-alert-active' : ''}`}
            onClick={() =>
              onSetPriceAlert(priceAlertLevel === highlightedPrice ? null : highlightedPrice)
            }
            title="Toggle price alert at highlighted level"
          >
            {priceAlertLevel === highlightedPrice
              ? `🔔 Alert $${highlightedPrice.toFixed(0)} ×`
              : `🔔 Alert $${highlightedPrice.toFixed(0)}`}
          </button>
        )}
      </div>

      {hoverInfo && (
        <div
          className="crosshair-tooltip"
          style={{
            left: Math.min(hoverInfo.x + 16, 480),
            top: Math.max(12, hoverInfo.y - 120),
          }}
        >
          <div className="tt-header">
            <span className="tt-price">
              ${hoverInfo.priceFloor.toFixed(1)} – ${hoverInfo.priceCeil.toFixed(1)}
            </span>
            <span className="tt-time">
              {hoverInfo.isLiveZone
                ? 'LIVE ORDERBOOK'
                : hoverInfo.timestamp
                  ? formatTimeAxisLabel(hoverInfo.timestamp, timeframe)
                  : '—'}
            </span>
          </div>
          <div className="tt-body">
            <div className="tt-row">
              <span>Cluster Size:</span>
              <strong
                className={
                  hoverInfo.restingSide === 'Bid'
                    ? 'text-bid'
                    : hoverInfo.restingSide === 'Ask'
                      ? 'text-ask'
                      : ''
                }
              >
                {hoverInfo.restingBtc > 0
                  ? `${hoverInfo.restingBtc.toFixed(3)} BTC [${hoverInfo.restingSide}]`
                  : '0.000 BTC'}
              </strong>
            </div>

            {hoverInfo.delta30sBtc !== undefined && Math.abs(hoverInfo.delta30sBtc) >= 0.05 && (
              <div className="tt-row">
                <span>30s Pull/Stack Δ:</span>
                <strong className={hoverInfo.delta30sBtc > 0 ? 'text-bid' : 'text-ask'}>
                  {hoverInfo.delta30sBtc > 0 ? '+' : ''}
                  {hoverInfo.delta30sBtc.toFixed(2)} BTC ({hoverInfo.delta30sBtc > 0 ? 'STACK' : 'PULL'})
                </strong>
              </div>
            )}

            {hoverInfo.clusterDetail && hoverInfo.clusterDetail.venues.length > 0 && (
              <div className="tt-row tt-venues">
                <span>{exchangeLabel} Sources:</span>
                <span>
                  {Object.entries(hoverInfo.clusterDetail.breakdown)
                    .filter(([, val]) => val > 0.01)
                    .map(([k, val]) => `${k}:${val >= 1 ? val.toFixed(1) : val.toFixed(2)}`)
                    .join(' ')}
                </span>
              </div>
            )}

            {hoverInfo.candleOpen !== undefined &&
              hoverInfo.candleHigh !== undefined &&
              hoverInfo.candleLow !== undefined &&
              hoverInfo.candleClose !== undefined && (
                <div className="tt-row">
                  <span>Candle OHLC:</span>
                  <span
                    className={
                      hoverInfo.candleClose >= hoverInfo.candleOpen ? 'text-bid' : 'text-ask'
                    }
                  >
                    O:{hoverInfo.candleOpen.toFixed(1)} H:{hoverInfo.candleHigh.toFixed(1)} L:
                    {hoverInfo.candleLow.toFixed(1)} C:{hoverInfo.candleClose.toFixed(1)}
                  </span>
                </div>
              )}

            {(hoverInfo.buyVolBtc > 0 || hoverInfo.sellVolBtc > 0) && (
              <div className="tt-row">
                <span>Volume Delta:</span>
                <span>
                  <span className="text-bid">+{hoverInfo.buyVolBtc.toFixed(2)}B</span>
                  {' / '}
                  <span className="text-ask">-{hoverInfo.sellVolBtc.toFixed(2)}S</span>
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
