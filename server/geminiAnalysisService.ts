import type {
  AiChatMessage,
  AiChatResponse,
  AiDetectedPattern,
  AiKeyLevel,
  AiPerfMetrics,
  AiReasoningMode,
  AiStreamPhase,
  AiTradeIdea,
  ExchangeId,
  FundingRatesResponse,
  GeminiChartAnalysis,
  LiquidationEvent,
  MlQuantForecast,
  OllamaModelInfo,
  TickerStats,
  TimeframeId,
  TradeEvent,
  VolumeDistributionResponse,
  WallLevel,
} from '../shared/types.ts';
import type { RawKline } from './collectorUtils.ts';
import { runMlQuantForecast } from './mlQuantEngine.ts';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const RECOMMENDED_OLLAMA_MODELS = [
  'qwen3:4b',
  'qwen3:8b',
  'inkling-2-mini-hybrid',
  'qwen2.5:7b',
  'qwen2.5:14b',
  'llama3.1:8b',
  'deepseek-r1:8b',
  'gemma3:12b',
];

export function normalizeOllamaBaseUrl(raw?: string): string {
  const candidate = (raw || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).trim();
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return DEFAULT_OLLAMA_BASE_URL;
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return DEFAULT_OLLAMA_BASE_URL;
  }
}

export async function fetchOllamaStatus(rawBaseUrl?: string): Promise<{
  baseUrl: string;
  reachable: boolean;
  models: OllamaModelInfo[];
  defaultModel: string;
}> {
  const baseUrl = normalizeOllamaBaseUrl(rawBaseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    // 1. Try native Ollama /api/tags
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (res.ok) {
      const json = (await res.json()) as {
        models?: {
          name?: string;
          size?: number;
          details?: { parameter_size?: string };
        }[];
      };
      const models: OllamaModelInfo[] = Array.isArray(json.models)
        ? json.models
            .filter((m) => Boolean(m && typeof m.name === 'string' && m.name.trim()))
            .map((m) => ({
              name: m.name!.trim(),
              sizeGb: m.size ? +(m.size / 1e9).toFixed(1) : 0,
              parameterSize: m.details?.parameter_size,
            }))
        : [];
      const envModel = (process.env.OLLAMA_MODEL || '').trim();
      const preferred =
        (envModel && models.find((m) => m.name === envModel)?.name) ||
        RECOMMENDED_OLLAMA_MODELS.find((r) =>
          models.some((m) => m.name === r || m.name.startsWith(r.split(':')[0] + ':'))
        ) ||
        models[0]?.name ||
        envModel ||
        'qwen2.5:7b';
      const matchedInstalled =
        models.find((m) => m.name === preferred)?.name || models[0]?.name || preferred;
      return { baseUrl, reachable: true, models, defaultModel: matchedInstalled };
    }

    // 2. Fallback: OpenAI-compatible local llama-server (e.g. Hybrid GPU+CPU on :11435)
    const oaiRes = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    if (oaiRes.ok) {
      const json = (await oaiRes.json()) as { data?: { id?: string }[] };
      const models: OllamaModelInfo[] = Array.isArray(json.data)
        ? json.data
            .filter((m) => Boolean(m && typeof m.id === 'string' && m.id.trim()))
            .map((m) => ({ name: m.id!.trim(), sizeGb: 0 }))
        : [];
      return {
        baseUrl,
        reachable: true,
        models,
        defaultModel: models[0]?.name || 'inkling-2-mini-hybrid',
      };
    }

    return {
      baseUrl,
      reachable: false,
      models: [],
      defaultModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
    };
  } catch {
    return {
      baseUrl,
      reachable: false,
      models: [],
      defaultModel: (process.env.OLLAMA_MODEL || '').trim() || 'qwen2.5:7b',
    };
  } finally {
    clearTimeout(timer);
  }
}

function calcSmaLast(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return +(sum / period).toFixed(2);
}

function calcEmaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calcRsiSeries(values: number[], period = 14): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function calcAtrLast(candles: RawKline[], period = 14): number | null {
  if (candles.length <= period) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1].c;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prevC), Math.abs(c.l - prevC));
    sum += tr;
  }
  return +(sum / period).toFixed(2);
}

export interface TechnicalSummary {
  candleCount: number;
  lastClose: number;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  sma20: number | null;
  ma50: number | null;
  ma100: number | null;
  ma200: number | null;
  rsi14: number | null;
  rsiPrev5: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  bbUpper: number | null;
  bbMid: number | null;
  bbLower: number | null;
  bbWidthPct: number | null;
  vwapRecent: number | null;
  atr14: number | null;
  atrPct: number | null;
  volRatio20: number | null;
  swingHighs: { t: number; price: number }[];
  swingLows: { t: number; price: number }[];
  rangeHigh50: number;
  rangeLow50: number;
  pocPrice: number | null;
  vahPrice: number | null;
  valPrice: number | null;
  vaPosition: 'Above VA' | 'Inside VA' | 'Below VA' | null;
  rsiDivergence: 'Bullish' | 'Bearish' | 'None';
  liquiditySweep: string | null;
}

export function computeTechnicalSummary(candles: RawKline[]): TechnicalSummary {
  const n = candles.length;
  const closes = candles.map((k) => k.c);
  const lastClose = n > 0 ? closes[n - 1] : 0;

  const ema9Arr = calcEmaSeries(closes, 9);
  const ema21Arr = calcEmaSeries(closes, 21);
  const ema50Arr = calcEmaSeries(closes, 50);
  const ema200Arr = calcEmaSeries(closes, 200);
  const ema12Arr = calcEmaSeries(closes, 12);
  const ema26Arr = calcEmaSeries(closes, 26);
  const rsiArr = calcRsiSeries(closes, 14);

  const macdVals: number[] = [];
  for (let i = 0; i < n; i++) {
    if (ema12Arr[i] !== null && ema26Arr[i] !== null) {
      macdVals.push((ema12Arr[i] as number) - (ema26Arr[i] as number));
    }
  }
  const macdSigArr = calcEmaSeries(macdVals, 9);
  const macdLine = macdVals.length > 0 ? +macdVals[macdVals.length - 1].toFixed(2) : null;
  const macdSignal =
    macdSigArr.length > 0 && macdSigArr[macdSigArr.length - 1] !== null
      ? +(macdSigArr[macdSigArr.length - 1] as number).toFixed(2)
      : null;
  const macdHist =
    macdLine !== null && macdSignal !== null ? +(macdLine - macdSignal).toFixed(2) : null;

  let bbUpper: number | null = null;
  let bbMid: number | null = null;
  let bbLower: number | null = null;
  let bbWidthPct: number | null = null;
  if (n >= 20) {
    let sum = 0;
    for (let i = n - 20; i < n; i++) sum += closes[i];
    const mean = sum / 20;
    let sq = 0;
    for (let i = n - 20; i < n; i++) {
      const d = closes[i] - mean;
      sq += d * d;
    }
    const std = Math.sqrt(sq / 20);
    bbMid = +mean.toFixed(2);
    bbUpper = +(mean + 2 * std).toFixed(2);
    bbLower = +(mean - 2 * std).toFixed(2);
    bbWidthPct = mean > 0 ? +(((bbUpper - bbLower) / mean) * 100).toFixed(2) : null;
  }

  const vwapStart = Math.max(0, n - 50);
  let cumPV = 0;
  let cumV = 0;
  let rangeHigh50 = -Infinity;
  let rangeLow50 = Infinity;
  for (let i = vwapStart; i < n; i++) {
    const k = candles[i];
    const tp = (k.h + k.l + k.c) / 3;
    const v = Math.max(k.vol, 0.0001);
    cumPV += tp * v;
    cumV += v;
    if (k.h > rangeHigh50) rangeHigh50 = k.h;
    if (k.l < rangeLow50) rangeLow50 = k.l;
  }
  const vwapRecent = cumV > 0 ? +(cumPV / cumV).toFixed(2) : null;

  // Session Volume Profile (POC / VAH / VAL across recent 80 bars)
  let pocPrice: number | null = null;
  let vahPrice: number | null = null;
  let valPrice: number | null = null;
  let vaPosition: 'Above VA' | 'Inside VA' | 'Below VA' | null = null;
  const vpStart = Math.max(0, n - 80);
  if (n - vpStart >= 10) {
    let vpLow = Infinity;
    let vpHigh = -Infinity;
    for (let i = vpStart; i < n; i++) {
      if (candles[i].l < vpLow) vpLow = candles[i].l;
      if (candles[i].h > vpHigh) vpHigh = candles[i].h;
    }
    const span = vpHigh - vpLow;
    if (span > 0) {
      const BINS = 24;
      const binSize = span / BINS;
      const bins = new Float64Array(BINS);
      let totalVol = 0;
      for (let i = vpStart; i < n; i++) {
        const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
        const idx = Math.max(0, Math.min(BINS - 1, Math.floor((tp - vpLow) / binSize)));
        const v = Math.max(0, candles[i].vol);
        bins[idx] += v;
        totalVol += v;
      }
      if (totalVol > 0) {
        let pocIdx = 0;
        for (let b = 1; b < BINS; b++) {
          if (bins[b] > bins[pocIdx]) pocIdx = b;
        }
        let acc = bins[pocIdx];
        let loIdx = pocIdx;
        let hiIdx = pocIdx;
        const target = totalVol * 0.7;
        while (acc < target && (loIdx > 0 || hiIdx < BINS - 1)) {
          const leftVol = loIdx > 0 ? bins[loIdx - 1] : -1;
          const rightVol = hiIdx < BINS - 1 ? bins[hiIdx + 1] : -1;
          if (rightVol >= leftVol && hiIdx < BINS - 1) {
            hiIdx++;
            acc += bins[hiIdx];
          } else if (loIdx > 0) {
            loIdx--;
            acc += bins[loIdx];
          } else {
            break;
          }
        }
        pocPrice = +(vpLow + (pocIdx + 0.5) * binSize).toFixed(1);
        valPrice = +(vpLow + loIdx * binSize).toFixed(1);
        vahPrice = +(vpLow + (hiIdx + 1) * binSize).toFixed(1);
        vaPosition =
          lastClose > vahPrice ? 'Above VA' : lastClose < valPrice ? 'Below VA' : 'Inside VA';
      }
    }
  }

  let volRatio20: number | null = null;
  if (n >= 20) {
    let vSum = 0;
    for (let i = n - 20; i < n; i++) vSum += candles[i].vol;
    const avgVol = vSum / 20;
    if (avgVol > 0) volRatio20 = +(candles[n - 1].vol / avgVol).toFixed(2);
  }

  const atr14 = calcAtrLast(candles, 14);
  const atrPct = atr14 && lastClose > 0 ? +((atr14 / lastClose) * 100).toFixed(2) : null;

  const swingHighs: { t: number; price: number; idx: number }[] = [];
  const swingLows: { t: number; price: number; idx: number }[] = [];
  const scanStart = Math.max(3, n - 120);
  for (let i = scanStart; i < n - 3; i++) {
    const h = candles[i].h;
    const l = candles[i].l;
    let isHigh = true;
    let isLow = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j === i) continue;
      if (candles[j].h >= h) isHigh = false;
      if (candles[j].l <= l) isLow = false;
    }
    if (isHigh) swingHighs.push({ t: candles[i].t, price: +h.toFixed(1), idx: i });
    if (isLow) swingLows.push({ t: candles[i].t, price: +l.toFixed(1), idx: i });
  }

  // RSI(14) Divergence detector across the 2 most recent fractal swings
  let rsiDivergence: 'Bullish' | 'Bearish' | 'None' = 'None';
  if (swingLows.length >= 2) {
    const prev = swingLows[swingLows.length - 2];
    const curr = swingLows[swingLows.length - 1];
    const prevRsi = rsiArr[prev.idx];
    const currRsi = rsiArr[curr.idx];
    if (
      prevRsi !== null &&
      currRsi !== null &&
      curr.price < prev.price &&
      currRsi > prevRsi + 2.5 &&
      n - 1 - curr.idx <= 25
    ) {
      rsiDivergence = 'Bullish';
    }
  }
  if (rsiDivergence === 'None' && swingHighs.length >= 2) {
    const prev = swingHighs[swingHighs.length - 2];
    const curr = swingHighs[swingHighs.length - 1];
    const prevRsi = rsiArr[prev.idx];
    const currRsi = rsiArr[curr.idx];
    if (
      prevRsi !== null &&
      currRsi !== null &&
      curr.price > prev.price &&
      currRsi < prevRsi - 2.5 &&
      n - 1 - curr.idx <= 25
    ) {
      rsiDivergence = 'Bearish';
    }
  }

  // Liquidity Sweep / Swing Failure Pattern (SFP) in the last 3 candles vs prior 25-bar range
  let liquiditySweep: string | null = null;
  if (n >= 28) {
    let priorHigh = -Infinity;
    let priorLow = Infinity;
    for (let i = n - 28; i < n - 3; i++) {
      if (candles[i].h > priorHigh) priorHigh = candles[i].h;
      if (candles[i].l < priorLow) priorLow = candles[i].l;
    }
    for (let i = n - 3; i < n; i++) {
      const k = candles[i];
      if (k.h > priorHigh && k.c < priorHigh) {
        liquiditySweep = `Bearish SFP above $${priorHigh.toFixed(0)}`;
      } else if (k.l < priorLow && k.c > priorLow) {
        liquiditySweep = `Bullish SFP below $${priorLow.toFixed(0)}`;
      }
    }
  }

  const lastVal = (arr: (number | null)[]) =>
    arr.length > 0 && arr[arr.length - 1] !== null
      ? +(arr[arr.length - 1] as number).toFixed(2)
      : null;

  const rsi14 = lastVal(rsiArr);
  const rsiPrev5 =
    n >= 6 && rsiArr[n - 6] !== null ? +(rsiArr[n - 6] as number).toFixed(2) : null;

  return {
    candleCount: n,
    lastClose: +lastClose.toFixed(2),
    ema9: lastVal(ema9Arr),
    ema21: lastVal(ema21Arr),
    ema50: lastVal(ema50Arr),
    ema200: lastVal(ema200Arr),
    sma20: calcSmaLast(closes, 20),
    ma50: calcSmaLast(closes, 50),
    ma100: calcSmaLast(closes, 100),
    ma200: calcSmaLast(closes, 200),
    rsi14,
    rsiPrev5,
    macdLine,
    macdSignal,
    macdHist,
    bbUpper,
    bbMid,
    bbLower,
    bbWidthPct,
    vwapRecent,
    atr14,
    atrPct,
    volRatio20,
    swingHighs: swingHighs.slice(-6).map(({ t, price }) => ({ t, price })),
    swingLows: swingLows.slice(-6).map(({ t, price }) => ({ t, price })),
    rangeHigh50: Number.isFinite(rangeHigh50) ? +rangeHigh50.toFixed(1) : lastClose,
    rangeLow50: Number.isFinite(rangeLow50) ? +rangeLow50.toFixed(1) : lastClose,
    pocPrice,
    vahPrice,
    valPrice,
    vaPosition,
    rsiDivergence,
    liquiditySweep,
  };
}

export interface GeminiMarketContextInput {
  exchange: ExchangeId;
  timeframe: TimeframeId;
  candles: RawKline[];
  higherTf4h?: RawKline[];
  higherTf1d?: RawKline[];
  ticker: TickerStats;
  bidClusters: WallLevel[];
  askClusters: WallLevel[];
  fundingRates: FundingRatesResponse;
  volumeDistribution: VolumeDistributionResponse;
  whaleTrades: TradeEvent[];
  recentLiquidations: LiquidationEvent[];
  userDrawings?: {
    type: string;
    points: { time: number; price: number }[];
    text?: string;
  }[];
  includeOrderbookAndDerivs?: boolean;
  customPrompt?: string;
  tradingPlaybook?: string;
}

const OLLAMA_JSON_SCHEMA = {
  type: 'object',
  properties: {
    marketBias: {
      type: 'string',
      enum: ['Bullish', 'Bearish', 'Neutral', 'Range-Bound'],
    },
    confidence: { type: 'integer' },
    marketRegime: { type: 'string' },
    summary: { type: 'string' },
    keyLevels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          price: { type: 'number' },
          type: {
            type: 'string',
            enum: ['Support', 'Resistance', 'Liquidity Wall', 'Pivot'],
          },
          strength: { type: 'string', enum: ['Strong', 'Moderate'] },
          reason: { type: 'string' },
        },
        required: ['price', 'type', 'strength', 'reason'],
      },
    },
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bias: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral'] },
          status: { type: 'string', enum: ['Confirmed', 'Forming', 'Watch'] },
          confidence: { type: 'integer' },
          timeframe: { type: 'string' },
          targetPrice: { type: ['number', 'null'] },
          invalidationPrice: { type: ['number', 'null'] },
          description: { type: 'string' },
        },
        required: ['name', 'bias', 'status', 'confidence', 'timeframe', 'description'],
      },
    },
    tradeIdeas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          direction: { type: 'string', enum: ['Long', 'Short'] },
          setupType: { type: 'string' },
          entryLow: { type: 'number' },
          entryHigh: { type: 'number' },
          entryPrice: { type: 'number' },
          stopLoss: { type: 'number' },
          takeProfits: { type: 'array', items: { type: 'number' } },
          riskReward: { type: 'string' },
          confidence: { type: 'integer' },
          rationale: { type: 'string' },
          invalidation: { type: 'string' },
        },
        required: [
          'title',
          'direction',
          'setupType',
          'entryLow',
          'entryHigh',
          'entryPrice',
          'stopLoss',
          'takeProfits',
          'riskReward',
          'confidence',
          'rationale',
          'invalidation',
        ],
      },
    },
    confluence: {
      type: 'object',
      properties: {
        technical: { type: 'array', items: { type: 'string' } },
        orderbook: { type: 'array', items: { type: 'string' } },
        derivatives: { type: 'array', items: { type: 'string' } },
      },
      required: ['technical', 'orderbook', 'derivatives'],
    },
    riskWarning: { type: 'string' },
  },
  required: [
    'marketBias',
    'confidence',
    'marketRegime',
    'summary',
    'keyLevels',
    'patterns',
    'tradeIdeas',
    'confluence',
    'riskWarning',
  ],
};

function fmtTimeIso(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

function classifyTrendDir(t: TechnicalSummary): { dir: '↑' | '↓' | '→'; score: number } {
  let score = 0;
  if (t.ema21 !== null) score += t.lastClose > t.ema21 ? 1 : -1;
  if (t.ma50 !== null) score += t.lastClose > t.ma50 ? 1 : -1;
  if (t.macdHist !== null) score += t.macdHist > 0 ? 1 : -1;
  return score >= 2 ? { dir: '↑', score: 1 } : score <= -2 ? { dir: '↓', score: -1 } : { dir: '→', score: 0 };
}

export function buildMarketContextPrompt(
  input: GeminiMarketContextInput,
  maxRecentCandles = 20
): {
  prompt: string;
  tech: TechnicalSummary;
  topBidWall: { price: number; btc: number } | null;
  topAskWall: { price: number; btc: number } | null;
  htfAlignment: string;
  mlForecast: MlQuantForecast | null;
} {
  const tech = computeTechnicalSummary(input.candles);
  const htf4h =
    input.higherTf4h && input.higherTf4h.length >= 20
      ? computeTechnicalSummary(input.higherTf4h)
      : null;
  const htf1d =
    input.higherTf1d && input.higherTf1d.length >= 20
      ? computeTechnicalSummary(input.higherTf1d)
      : null;
  const currentPrice = input.ticker.lastPrice || tech.lastClose;
  const mlForecast = runMlQuantForecast(input.candles, input.timeframe, currentPrice);

  const tfScores: { label: string; dir: '↑' | '↓' | '→'; score: number }[] = [
    { label: input.timeframe, ...classifyTrendDir(tech) },
  ];
  if (htf4h) tfScores.push({ label: '4h', ...classifyTrendDir(htf4h) });
  if (htf1d) tfScores.push({ label: '1d', ...classifyTrendDir(htf1d) });
  const bullCount = tfScores.filter((x) => x.score > 0).length;
  const bearCount = tfScores.filter((x) => x.score < 0).length;
  const tfTag = tfScores.map((x) => `${x.label}${x.dir}`).join(' ');
  const htfAlignment =
    bullCount === tfScores.length
      ? `Bullish Aligned (${bullCount}/${tfScores.length}: ${tfTag})`
      : bearCount === tfScores.length
        ? `Bearish Aligned (${bearCount}/${tfScores.length}: ${tfTag})`
        : `Mixed (${tfTag})`;

  const sortedBids = [...input.bidClusters].sort((a, b) => b.sizeBtc - a.sizeBtc);
  const sortedAsks = [...input.askClusters].sort((a, b) => b.sizeBtc - a.sizeBtc);
  const topBidWall = sortedBids[0]
    ? { price: sortedBids[0].price, btc: +sortedBids[0].sizeBtc.toFixed(1) }
    : null;
  const topAskWall = sortedAsks[0]
    ? { price: sortedAsks[0].price, btc: +sortedAsks[0].sizeBtc.toFixed(1) }
    : null;

  // Compact candle rows (~3x fewer tokens than verbose JSON arrays) for fast local prompt eval
  const recentCandlesText = input.candles
    .slice(-maxRecentCandles)
    .map((k) => {
      const hm = new Date(k.t).toISOString().slice(11, 16);
      return `${hm} ${Math.round(k.o)}/${Math.round(k.h)}/${Math.round(k.l)}/${Math.round(k.c)} v${Math.round(k.vol)}`;
    })
    .join('\n');

  let whaleBuyBtc = 0;
  let whaleSellBtc = 0;
  for (const tr of input.whaleTrades.slice(0, 80)) {
    if (tr.s === 'Buy') whaleBuyBtc += tr.v;
    else whaleSellBtc += tr.v;
  }

  let longLiqUsd = 0;
  let shortLiqUsd = 0;
  for (const lq of input.recentLiquidations.slice(0, 80)) {
    if (lq.side === 'Long') longLiqUsd += lq.usd;
    else shortLiqUsd += lq.usd;
  }

  const sections: string[] = [];
  sections.push(
    `MARKET HEADER:
- Asset: BTC (${input.exchange.toUpperCase()}) | TF: ${input.timeframe} | Price: $${currentPrice.toFixed(1)} (${input.ticker.price24hPcnt.toFixed(2)}% 24h, H/L $${input.ticker.highPrice24h.toFixed(0)}/$${input.ticker.lowPrice24h.toFixed(0)})
- Bid/Ask: $${input.ticker.bestBid.toFixed(1)}/$${input.ticker.bestAsk.toFixed(1)} | Spot: $${(input.ticker.spotPrice || 0).toFixed(1)} | OI: $${(input.ticker.openInterestValue / 1e9).toFixed(2)}B`
  );

  const vpLine =
    tech.pocPrice !== null
      ? `- Volume Profile (80-bar): POC=$${tech.pocPrice}, VAL=$${tech.valPrice}, VAH=$${tech.vahPrice} (${tech.vaPosition})`
      : '';
  const quantSignalsLine = `- Quant Signals: MTF=${htfAlignment} | RSI Div=${tech.rsiDivergence} | Liquidity Sweep=${tech.liquiditySweep ?? 'None'}`;

  sections.push(
    `INDICATORS (${input.timeframe}, ${tech.candleCount} bars):
- MAs: EMA9=${tech.ema9 ?? 'n/a'}, EMA21=${tech.ema21 ?? 'n/a'}, EMA50=${tech.ema50 ?? 'n/a'}, EMA200=${tech.ema200 ?? 'n/a'}, MA50=${tech.ma50 ?? 'n/a'}, MA100=${tech.ma100 ?? 'n/a'}, MA200=${tech.ma200 ?? 'n/a'}
- Momentum: RSI14=${tech.rsi14 ?? 'n/a'} (prev5=${tech.rsiPrev5 ?? 'n/a'}), MACD=${tech.macdLine ?? 'n/a'}/${tech.macdSignal ?? 'n/a'} (Hist=${tech.macdHist ?? 'n/a'})
- Volatility/Flow: BB20=${tech.bbLower ?? 'n/a'}–${tech.bbUpper ?? 'n/a'} (W=${tech.bbWidthPct ?? 'n/a'}%), ATR14=$${tech.atr14 ?? 'n/a'} (${tech.atrPct ?? 'n/a'}%), VWAP50=${tech.vwapRecent ?? 'n/a'}, Vol/MA20=${tech.volRatio20 ?? 'n/a'}x, 50-bar Range=$${tech.rangeLow50}–$${tech.rangeHigh50}
${vpLine ? vpLine + '\n' : ''}${quantSignalsLine}
- Swing Highs: ${tech.swingHighs.map((s) => `$${s.price}`).join(', ') || 'none'} | Swing Lows: ${tech.swingLows.map((s) => `$${s.price}`).join(', ') || 'none'}`
  );

  if (htf4h || htf1d) {
    const htfLines: string[] = [];
    if (htf4h) {
      htfLines.push(
        `- 4H: Close=$${htf4h.lastClose}, EMA21=${htf4h.ema21}, MA50=${htf4h.ma50}, MA200=${htf4h.ma200}, RSI14=${htf4h.rsi14}, MACD_H=${htf4h.macdHist}`
      );
    }
    if (htf1d) {
      htfLines.push(
        `- 1D: Close=$${htf1d.lastClose}, EMA21=${htf1d.ema21}, MA50=${htf1d.ma50}, MA200=${htf1d.ma200}, RSI14=${htf1d.rsi14}, MACD_H=${htf1d.macdHist}`
      );
    }
    sections.push(`HIGHER TF:\n${htfLines.join('\n')}`);
  }

  if (mlForecast) {
    const driversText = mlForecast.topDrivers
      .map((d) => `${d.label} (${d.valueText})`)
      .join('; ');
    sections.push(
      `ML QUANT MODEL FORECAST (Walk-Forward LightGBM ${mlForecast.modelTimeframe.toUpperCase()}, ${mlForecast.horizonLabel} Triple-Barrier ±${mlForecast.barrierAtrMult}x ATR, OOS AUC=${mlForecast.modelMeta.oosDirectionAuc}):
- Directional Probs: Up ${mlForecast.probUp}% / Chop ${mlForecast.probChop}% / Down ${mlForecast.probDown}% (Edge ${mlForecast.directionalEdgePct >= 0 ? '+' : ''}${mlForecast.directionalEdgePct}%, Bias: ${mlForecast.directionalBias}, Conviction: ${mlForecast.conviction})
- Regime Probs: Trending ${mlForecast.regimeProbs.trending}% | Mean-Reverting ${mlForecast.regimeProbs.meanReverting}% | High-Vol Flush ${mlForecast.regimeProbs.highVolFlush}% (Dominant: ${mlForecast.dominantRegime})
- Expected ${mlForecast.horizonLabel} Range Envelope: $${mlForecast.expectedLow.toFixed(0)} – $${mlForecast.expectedHigh.toFixed(0)} (±${(mlForecast.expectedRangePct / 2).toFixed(2)}%)
- Top Numerical Drivers: ${driversText}`
    );
  }

  if (input.includeOrderbookAndDerivs !== false) {
    const topBidsText = sortedBids
      .slice(0, 5)
      .map((w) => `$${w.price} (${w.sizeBtc.toFixed(0)}B, ${w.distancePct.toFixed(1)}%)`)
      .join('; ');
    const topAsksText = sortedAsks
      .slice(0, 5)
      .map((w) => `$${w.price} (${w.sizeBtc.toFixed(0)}B, +${Math.abs(w.distancePct).toFixed(1)}%)`)
      .join('; ');
    const vd = input.volumeDistribution;
    const fr = input.fundingRates;
    const frList = fr.exchanges
      .filter((e) => e.supported)
      .map((e) => `${e.code}:${e.normalized8hPct}%`)
      .join(', ');

    sections.push(
      `ORDERBOOK & DERIVATIVES:
- Book: Bids ${input.ticker.totalBidBtc.toFixed(0)} vs Asks ${input.ticker.totalAskBtc.toFixed(0)} BTC (Imb ${input.ticker.imbalancePct.toFixed(1)}%)
- Bid Walls: ${topBidsText || 'none'}
- Ask Walls: ${topAsksText || 'none'}
- Whales (>=0.5B): Buy ${whaleBuyBtc.toFixed(1)} / Sell ${whaleSellBtc.toFixed(1)} BTC | Liqs: Long $${Math.round(longLiqUsd).toLocaleString()} / Short $${Math.round(shortLiqUsd).toLocaleString()}
- OI-Weighted 8h Funding: ${fr.oiWeighted8hPct}% (APR ${fr.oiWeightedAprPct}%, Ex: ${frList || 'n/a'})
- 24h Vol: Spot ${vd.spotSharePct.toFixed(0)}% / Deriv ${vd.derivSharePct.toFixed(0)}% | Buy ${vd.buySharePct.toFixed(0)}% / Sell ${vd.sellSharePct.toFixed(0)}% | L/S ${vd.avgLongShortRatio.toFixed(2)}`
    );
  }

  if (input.userDrawings && input.userDrawings.length > 0) {
    const drawingLines = input.userDrawings.slice(-15).map((d) => {
      const pts = d.points.map((p) => `$${p.price.toFixed(1)}@${fmtTimeIso(p.time)}`).join('->');
      return `- ${d.type}${d.text ? ` ("${d.text}")` : ''}: ${pts}`;
    });
    sections.push(`USER DRAWINGS:\n${drawingLines.join('\n')}`);
  }

  sections.push(
    `RECENT ${Math.min(maxRecentCandles, input.candles.length)} CANDLES (${input.timeframe}) [UTC O/H/L/C vVol]:\n${recentCandlesText}`
  );

  if (input.tradingPlaybook && input.tradingPlaybook.trim()) {
    sections.push(`USER TRADING PLAYBOOK (FOLLOW THESE RULES):\n${input.tradingPlaybook.trim().slice(0, 800)}`);
  }

  if (input.customPrompt && input.customPrompt.trim()) {
    sections.push(`USER FOCUS:\n${input.customPrompt.trim()}`);
  }

  const prompt = `Analyze the live Bitcoin market data and calibrated LightGBM Quant-ML forecast below, then return valid JSON matching the requested schema.
RULES:
1. Synthesize the Quant-ML probabilities with live orderbook walls, 5-exchange funding, Value Area (POC/VAH/VAL), and HTF structure—explicitly note where orderflow confirms or contradicts the ML forecast.
2. Ground ALL prices in the data around $${currentPrice.toFixed(1)}.
3. Report 2–3 real patterns, 4–5 key levels, and 2 actionable trade setups (Long: SL < entry < TP1 < TP2; Short: SL > entry > TP1 > TP2; place SL cleanly beyond swing/wall ~1.5x ATR ~$${Math.round(tech.atr14 ?? 250)}).
4. Keep reasoning brief (3–5 short sentences) and cite exact indicator/ML/wall/funding values concisely with a short non-financial-advice riskWarning.

${sections.join('\n\n')}`;

  return { prompt, tech, topBidWall, topAskWall, htfAlignment, mlForecast };
}

export function extractPerfMetrics(
  json: {
    eval_count?: number;
    eval_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    timings?: {
      predicted_n?: number;
      predicted_ms?: number;
      predicted_per_second?: number;
      prompt_per_second?: number;
    };
    usage?: { completion_tokens?: number };
  },
  elapsedMs: number,
  fallbackText = ''
): AiPerfMetrics {
  const durationSec = +(Math.max(0.05, elapsedMs / 1000)).toFixed(2);

  // 1. llama-server OpenAI-compatible timings object
  if (json.timings && typeof json.timings.predicted_per_second === 'number') {
    return {
      tokensPerSec: +json.timings.predicted_per_second.toFixed(1),
      promptTokensPerSec:
        typeof json.timings.prompt_per_second === 'number'
          ? +json.timings.prompt_per_second.toFixed(1)
          : null,
      evalTokens: json.timings.predicted_n ?? json.usage?.completion_tokens,
      durationSec,
    };
  }

  // 2. Native Ollama nanosecond timings
  if (json.eval_count && json.eval_duration && json.eval_duration > 0) {
    const tps = json.eval_count / (json.eval_duration / 1e9);
    const promptTps =
      json.prompt_eval_count && json.prompt_eval_duration && json.prompt_eval_duration > 0
        ? +(json.prompt_eval_count / (json.prompt_eval_duration / 1e9)).toFixed(1)
        : null;
    return {
      tokensPerSec: +tps.toFixed(1),
      promptTokensPerSec: promptTps,
      evalTokens: json.eval_count,
      durationSec,
    };
  }

  // 3. Fallback estimate
  const estTokens = json.usage?.completion_tokens || Math.max(1, Math.round(fallbackText.length / 4));
  return {
    tokensPerSec: +(estTokens / durationSec).toFixed(1),
    promptTokensPerSec: null,
    evalTokens: estTokens,
    durationSec,
  };
}

function sanitizeAnalysis(
  raw: Record<string, unknown>,
  meta: {
    model: string;
    exchange: ExchangeId;
    timeframe: TimeframeId;
    currentPrice: number;
    tech: TechnicalSummary;
    oiWeightedFunding8h: number;
    bookImbalancePct: number;
    topBidWall: { price: number; btc: number } | null;
    topAskWall: { price: number; btc: number } | null;
    htfAlignment: string;
    mlForecast?: MlQuantForecast | null;
    promptSnapshot?: string;
    perf: AiPerfMetrics;
    thinking?: string;
  }
): GeminiChartAnalysis {
  const validBias = new Set(['Bullish', 'Bearish', 'Neutral', 'Range-Bound']);
  const marketBias = (
    typeof raw.marketBias === 'string' && validBias.has(raw.marketBias)
      ? raw.marketBias
      : 'Neutral'
  ) as GeminiChartAnalysis['marketBias'];

  const clampPct = (v: unknown, fallback = 50) =>
    Math.max(0, Math.min(100, Math.round(Number(v) || fallback)));

  const keyLevels: AiKeyLevel[] = Array.isArray(raw.keyLevels)
    ? raw.keyLevels
        .filter((l): l is Record<string, unknown> => Boolean(l && typeof l === 'object'))
        .map((l) => ({
          price: +Number(l.price || 0).toFixed(1),
          type: (['Support', 'Resistance', 'Liquidity Wall', 'Pivot'].includes(String(l.type))
            ? String(l.type)
            : 'Pivot') as AiKeyLevel['type'],
          strength: (l.strength === 'Strong' ? 'Strong' : 'Moderate') as AiKeyLevel['strength'],
          reason: String(l.reason || '').slice(0, 180),
        }))
        .filter((l) => Number.isFinite(l.price) && l.price > 0)
        .slice(0, 8)
    : [];

  const patterns: AiDetectedPattern[] = Array.isArray(raw.patterns)
    ? raw.patterns
        .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
        .map((p) => ({
          name: String(p.name || 'Pattern').slice(0, 80),
          bias: (['Bullish', 'Bearish', 'Neutral'].includes(String(p.bias))
            ? String(p.bias)
            : 'Neutral') as AiDetectedPattern['bias'],
          status: (['Confirmed', 'Forming', 'Watch'].includes(String(p.status))
            ? String(p.status)
            : 'Forming') as AiDetectedPattern['status'],
          confidence: clampPct(p.confidence, 60),
          timeframe: String(p.timeframe || meta.timeframe),
          targetPrice:
            p.targetPrice !== null && p.targetPrice !== undefined && Number(p.targetPrice) > 0
              ? +Number(p.targetPrice).toFixed(1)
              : null,
          invalidationPrice:
            p.invalidationPrice !== null &&
            p.invalidationPrice !== undefined &&
            Number(p.invalidationPrice) > 0
              ? +Number(p.invalidationPrice).toFixed(1)
              : null,
          description: String(p.description || '').slice(0, 280),
        }))
        .slice(0, 6)
    : [];

  const tradeIdeas: AiTradeIdea[] = Array.isArray(raw.tradeIdeas)
    ? raw.tradeIdeas
        .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
        .map((t) => {
          const direction = (t.direction === 'Short' ? 'Short' : 'Long') as 'Long' | 'Short';
          const entryPrice = +Number(t.entryPrice || meta.currentPrice).toFixed(1);
          const entryLow = +Number(t.entryLow || entryPrice).toFixed(1);
          const entryHigh = +Number(t.entryHigh || entryPrice).toFixed(1);
          const atrFallback = Math.max(50, Math.round(meta.tech.atr14 || meta.currentPrice * 0.005));
          let stopLoss = +Number(t.stopLoss || 0).toFixed(1);
          // Enforce directional SL guardrails so SL is always on the valid side of entry
          if (direction === 'Long' && (stopLoss <= 0 || stopLoss >= entryPrice)) {
            stopLoss = +(entryPrice - atrFallback).toFixed(1);
          } else if (direction === 'Short' && (stopLoss <= 0 || stopLoss <= entryPrice)) {
            stopLoss = +(entryPrice + atrFallback).toFixed(1);
          }

          let takeProfits = Array.isArray(t.takeProfits)
            ? t.takeProfits
                .map((x) => +Number(x).toFixed(1))
                .filter((x) =>
                  Number.isFinite(x) &&
                  (direction === 'Long' ? x > entryPrice : x > 0 && x < entryPrice)
                )
            : [];
          takeProfits.sort((a, b) => (direction === 'Long' ? a - b : b - a));
          if (takeProfits.length === 0) {
            const risk = Math.abs(entryPrice - stopLoss);
            takeProfits =
              direction === 'Long'
                ? [+(entryPrice + risk * 1.8).toFixed(1), +(entryPrice + risk * 3).toFixed(1)]
                : [+(entryPrice - risk * 1.8).toFixed(1), +(entryPrice - risk * 3).toFixed(1)];
          }
          takeProfits = takeProfits.slice(0, 3);

          // Deterministically verify & compute Risk:Reward ratio (no hallucinated R:R math!)
          const risk = Math.abs(entryPrice - stopLoss);
          const primaryTp = takeProfits[takeProfits.length - 1] ?? takeProfits[0];
          const reward = Math.abs(primaryTp - entryPrice);
          const computedRR =
            risk > 0 && reward > 0 ? `1:${(reward / risk).toFixed(1)}` : String(t.riskReward || '1:2.0').slice(0, 24);

          return {
            title: String(t.title || `${direction} Setup`).slice(0, 90),
            direction,
            setupType: String(t.setupType || 'Technical Setup').slice(0, 60),
            entryLow: Math.min(entryLow, entryHigh),
            entryHigh: Math.max(entryLow, entryHigh),
            entryPrice,
            stopLoss,
            takeProfits,
            riskReward: computedRR,
            confidence: clampPct(t.confidence, 60),
            rationale: String(t.rationale || '').slice(0, 360),
            invalidation: String(t.invalidation || '').slice(0, 200),
          };
        })
        .filter((t) => t.entryPrice > 0 && t.stopLoss > 0 && t.takeProfits.length > 0)
        .slice(0, 4)
    : [];

  const confRaw = (raw.confluence && typeof raw.confluence === 'object'
    ? raw.confluence
    : {}) as Record<string, unknown>;
  const toStrArr = (v: unknown) =>
    Array.isArray(v) ? v.map((s) => String(s).slice(0, 200)).slice(0, 5) : [];

  return {
    generatedAt: Date.now(),
    model: meta.model,
    exchange: meta.exchange,
    timeframe: meta.timeframe,
    currentPrice: +meta.currentPrice.toFixed(1),
    marketBias,
    confidence: clampPct(raw.confidence, 55),
    marketRegime: String(raw.marketRegime || 'Active Structure').slice(0, 80),
    summary: String(raw.summary || 'Analysis generated from live market data.').slice(0, 700),
    keyLevels,
    patterns,
    tradeIdeas,
    confluence: {
      technical: toStrArr(confRaw.technical),
      orderbook: toStrArr(confRaw.orderbook),
      derivatives: toStrArr(confRaw.derivatives),
    },
    riskWarning: String(
      raw.riskWarning ||
        'AI technical analysis is for informational and educational purposes only—not financial advice. Always manage position sizing and risk.'
    ).slice(0, 280),
    ...(meta.thinking ? { thinking: meta.thinking } : {}),
    perf: meta.perf,
    ...(meta.mlForecast ? { mlForecast: meta.mlForecast } : {}),
    dataSnapshot: {
      candleCount: meta.tech.candleCount,
      rsi14: meta.tech.rsi14,
      atr14: meta.tech.atr14,
      ma50: meta.tech.ma50,
      ma200: meta.tech.ma200,
      oiWeightedFunding8h: meta.oiWeightedFunding8h,
      bookImbalancePct: +meta.bookImbalancePct.toFixed(1),
      topBidWall: meta.topBidWall,
      topAskWall: meta.topAskWall,
      pocPrice: meta.tech.pocPrice,
      rsiDivergence: meta.tech.rsiDivergence,
      liquiditySweep: meta.tech.liquiditySweep,
      htfAlignment: meta.htfAlignment,
    },
    ...(meta.promptSnapshot ? { promptSnapshot: meta.promptSnapshot } : {}),
  };
}

function extractJsonObject(rawText: string): Record<string, unknown> {
  const withoutThink = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const stripped = withoutThink
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error('Invalid JSON');
  }
}

export interface LocalAiStreamCallbacks {
  signal?: AbortSignal;
  onPhase?: (phase: AiStreamPhase) => void;
  onThinking?: (delta: string, livePerf?: AiPerfMetrics) => void;
  onContent?: (delta: string, livePerf?: AiPerfMetrics) => void;
}

/**
 * Stateful splitter for models that stream inline `<think>...</think>` blocks inside `content`.
 * Buffers partial tag prefixes so `<thi` or `</th` never leaks into output.
 */
export function createThinkTagSplitter(
  onThinking: (delta: string) => void,
  onContent: (delta: string) => void
): { push: (chunk: string) => void; flush: () => void } {
  const OPEN_TAG = '<think>';
  const CLOSE_TAG = '</think>';
  let inThink = false;
  let pending = '';

  const longestTagPrefix = (text: string, tag: string): number => {
    const lower = text.toLowerCase();
    const maxLen = Math.min(text.length, tag.length - 1);
    for (let len = maxLen; len > 0; len--) {
      if (lower.endsWith(tag.slice(0, len))) return len;
    }
    return 0;
  };

  const push = (chunk: string) => {
    if (!chunk) return;
    pending += chunk;

    while (pending.length > 0) {
      const targetTag = inThink ? CLOSE_TAG : OPEN_TAG;
      const idx = pending.toLowerCase().indexOf(targetTag);
      if (idx >= 0) {
        const before = pending.slice(0, idx);
        if (before) {
          if (inThink) onThinking(before);
          else onContent(before);
        }
        pending = pending.slice(idx + targetTag.length);
        inThink = !inThink;
        continue;
      }

      const holdLen = longestTagPrefix(pending, targetTag);
      const emitLen = pending.length - holdLen;
      if (emitLen > 0) {
        const emit = pending.slice(0, emitLen);
        pending = pending.slice(emitLen);
        if (inThink) onThinking(emit);
        else onContent(emit);
      }
      break;
    }
  };

  const flush = () => {
    if (!pending) return;
    if (inThink) onThinking(pending);
    else onContent(pending);
    pending = '';
  };

  return { push, flush };
}

interface RawLocalTimings {
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  timings?: {
    predicted_n?: number;
    predicted_ms?: number;
    predicted_per_second?: number;
    prompt_per_second?: number;
  };
  usage?: { completion_tokens?: number };
}

async function runLocalAiCompletion(opts: {
  baseUrl: string;
  model: string;
  messages: { role: string; content: string }[];
  temperature: number;
  maxTokens: number;
  jsonSchema?: Record<string, unknown>;
  reasoningMode?: AiReasoningMode;
  timeoutMs: number;
  streamCallbacks?: LocalAiStreamCallbacks;
}): Promise<{ content: string; thinking?: string; perf: AiPerfMetrics }> {
  const {
    baseUrl,
    model,
    messages,
    temperature,
    maxTokens,
    jsonSchema,
    reasoningMode = 'deep',
    timeoutMs,
    streamCallbacks,
  } = opts;
  const isFastMode = reasoningMode === 'fast';
  const useStream = Boolean(streamCallbacks);
  const t0 = Date.now();
  const controller = new AbortController();
  let abortReason: 'prompt_timeout' | 'stall' | 'max_duration' | null = null;
  // Idle/stall timeout that resets on every streamed token so active generation never times out mid-reply
  let idleTimer = setTimeout(() => {
    abortReason = 'prompt_timeout';
    controller.abort();
  }, timeoutMs);
  const hardCapTimer = setTimeout(() => {
    abortReason = 'max_duration';
    controller.abort();
  }, 600_000);
  const bumpIdleTimer = (ms = 90_000) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortReason = 'stall';
      controller.abort();
    }, ms);
  };

  const onExternalAbort = () => controller.abort();
  if (streamCallbacks?.signal) {
    if (streamCallbacks.signal.aborted) {
      clearTimeout(idleTimer);
      clearTimeout(hardCapTimer);
      throw new Error('Request cancelled.');
    }
    streamCallbacks.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const cleanupSignals = () => {
    clearTimeout(idleTimer);
    clearTimeout(hardCapTimer);
    if (streamCallbacks?.signal) {
      streamCallbacks.signal.removeEventListener('abort', onExternalAbort);
    }
  };

  const callNativeOllama = (forceCpu = false) =>
    fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: useStream,
        ...(isFastMode ? { think: false } : {}),
        ...(jsonSchema ? { format: jsonSchema } : {}),
        options: {
          temperature,
          top_p: 0.95,
          num_ctx: 8192,
          num_predict: maxTokens,
          ...(forceCpu ? { num_gpu: 0 } : {}),
        },
        messages,
      }),
      signal: controller.signal,
    });

  const callOpenAiCompat = () =>
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: useStream,
        ...(useStream ? { stream_options: { include_usage: true } } : {}),
        ...(isFastMode ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        temperature,
        max_tokens: maxTokens,
        ...(jsonSchema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'btc_chart_analysis',
                  strict: true,
                  schema: jsonSchema,
                },
              },
            }
          : {}),
        messages,
      }),
      signal: controller.signal,
    });

  let res: Response;
  let usedOpenAiCompat = false;
  try {
    res = await callNativeOllama(false);
    if (res.status === 404) {
      const text404 = await res.text();
      if (!text404.toLowerCase().includes('model')) {
        usedOpenAiCompat = true;
        res = await callOpenAiCompat();
      } else {
        throw new Error(
          `Model "${model}" is not installed locally. Pull it first with: ollama pull ${model}`
        );
      }
    }
  } catch (err) {
    cleanupSignals();
    if (streamCallbacks?.signal?.aborted) {
      throw new Error('Generation stopped.');
    }
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(
        `Local AI timed out after ${Math.round(timeoutMs / 1000)}s on "${model}". Try a faster local model like qwen2.5:7b.`
      );
    }
    if ((err as Error)?.message?.includes('not installed locally')) throw err;
    throw new Error(
      `Cannot connect to local AI at ${baseUrl}. Start Ollama (:11434) or Hybrid GPU+CPU ("npm run start:hybrid-ai").`
    );
  }

  // Handle non-OK responses (including automatic CPU fallback on native Ollama CUDA OOM)
  if (!res.ok) {
    let rawBody = await res.text();
    if (
      !usedOpenAiCompat &&
      (rawBody.includes('cudaMalloc failed') || rawBody.includes('out of memory'))
    ) {
      try {
        res = await callNativeOllama(true);
        if (!res.ok) {
          rawBody = await res.text();
        }
      } catch {
        // fall through with previous error
      }
    }
    if (!res.ok) {
      cleanupSignals();
      let errMsg = `Local AI error (${res.status})`;
      try {
        const errJson = JSON.parse(rawBody) as { error?: string | { message?: string } };
        if (typeof errJson.error === 'string') errMsg = errJson.error;
        else if (errJson.error?.message) errMsg = errJson.error.message;
      } catch {
        // ignore
      }
      if (res.status === 404 || errMsg.toLowerCase().includes('not found')) {
        throw new Error(
          `Model "${model}" is not installed locally. Pull it first with: ollama pull ${model}`
        );
      }
      throw new Error(errMsg);
    }
  }

  // Non-streaming JSON path
  if (!useStream || !res.body) {
    const rawBody = await res.text();
    cleanupSignals();
    const elapsedMs = Date.now() - t0;

    let json: RawLocalTimings & {
      message?: { content?: string; thinking?: string };
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      response?: string;
    };
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new Error('Local AI returned an unreadable response payload.');
    }

    let rawContent = json.choices?.[0]?.message?.content || json.message?.content || json.response || '';
    let thinking =
      json.choices?.[0]?.message?.reasoning_content || json.message?.thinking || undefined;

    const thinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
      thinking = thinking || thinkMatch[1].trim();
      rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    }

    const perf = extractPerfMetrics(json, elapsedMs, `${thinking || ''} ${rawContent}`);
    return {
      content: rawContent,
      ...(thinking ? { thinking: thinking.trim() } : {}),
      perf,
    };
  }

  // Real-time streaming path (SSE for OpenAI-compatible llama-server, NDJSON for native Ollama)
  let accThinking = '';
  let accContent = '';
  let streamTokens = 0;
  let firstTokenAt = 0;
  let currentPhase: AiStreamPhase = 'prompt_eval';
  let finalMeta: RawLocalTimings = {};

  const buildLivePerf = (): AiPerfMetrics => {
    const now = Date.now();
    const genSec = firstTokenAt > 0 ? Math.max(0.12, (now - firstTokenAt) / 1000) : 0.12;
    const totalSec = +(Math.max(0.05, (now - t0) / 1000)).toFixed(1);
    return {
      tokensPerSec: streamTokens >= 2 ? +(streamTokens / genSec).toFixed(1) : null,
      evalTokens: streamTokens,
      durationSec: totalSec,
    };
  };

  const emitThinking = (delta: string) => {
    if (!delta) return;
    bumpIdleTimer(90_000);
    if (firstTokenAt === 0) firstTokenAt = Date.now();
    streamTokens++;
    accThinking += delta;
    if (currentPhase !== 'thinking') {
      currentPhase = 'thinking';
      streamCallbacks?.onPhase?.('thinking');
    }
    streamCallbacks?.onThinking?.(delta, buildLivePerf());
  };

  const emitContent = (delta: string) => {
    if (!delta) return;
    bumpIdleTimer(90_000);
    if (firstTokenAt === 0) firstTokenAt = Date.now();
    streamTokens++;
    accContent += delta;
    if (currentPhase !== 'generating') {
      currentPhase = 'generating';
      streamCallbacks?.onPhase?.('generating');
    }
    streamCallbacks?.onContent?.(delta, buildLivePerf());
  };

  const splitter = createThinkTagSplitter(emitThinking, emitContent);

  const processLine = (rawLine: string) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    let payloadText = trimmed;
    if (usedOpenAiCompat) {
      if (!trimmed.startsWith('data:')) return;
      payloadText = trimmed.slice(5).trim();
      if (!payloadText || payloadText === '[DONE]') return;
    }

    let chunk: RawLocalTimings & {
      choices?: {
        delta?: { content?: string; reasoning_content?: string };
        finish_reason?: string | null;
      }[];
      message?: { content?: string; thinking?: string };
      done?: boolean;
      error?: string | { message?: string };
    };
    try {
      chunk = JSON.parse(payloadText);
    } catch {
      return;
    }

    if (chunk.error) {
      const msg = typeof chunk.error === 'string' ? chunk.error : chunk.error.message || 'Stream error';
      throw new Error(msg);
    }

    if (chunk.timings) finalMeta.timings = chunk.timings;
    if (chunk.usage) finalMeta.usage = chunk.usage;
    if (chunk.eval_count) finalMeta.eval_count = chunk.eval_count;
    if (chunk.eval_duration) finalMeta.eval_duration = chunk.eval_duration;
    if (chunk.prompt_eval_count) finalMeta.prompt_eval_count = chunk.prompt_eval_count;
    if (chunk.prompt_eval_duration) finalMeta.prompt_eval_duration = chunk.prompt_eval_duration;

    const deltaReasoning = chunk.choices?.[0]?.delta?.reasoning_content ?? chunk.message?.thinking;
    if (deltaReasoning) {
      emitThinking(deltaReasoning);
    }

    const deltaContent = chunk.choices?.[0]?.delta?.content ?? chunk.message?.content;
    if (deltaContent) {
      splitter.push(deltaContent);
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    }
    lineBuf += decoder.decode();
    if (lineBuf.trim()) {
      processLine(lineBuf);
    }
    splitter.flush();
  } catch (err) {
    cleanupSignals();
    if (streamCallbacks?.signal?.aborted) {
      throw new Error('Generation stopped.');
    }
    if ((err as Error)?.name === 'AbortError') {
      if (abortReason === 'stall') {
        throw new Error(`Local AI "${model}" stalled for 90s without sending new tokens.`);
      }
      if (abortReason === 'max_duration') {
        throw new Error(
          `Local AI "${model}" hit the 10-minute safety limit. Use ⚡ Fast GPU (:11435) with qwen3-4b-local for ~20s TA reports.`
        );
      }
      throw new Error(`Local AI timed out after ${Math.round(timeoutMs / 1000)}s on "${model}".`);
    }
    throw err;
  } finally {
    cleanupSignals();
    reader.releaseLock();
  }

  const elapsedMs = Date.now() - t0;
  // If no explicit timings arrived from upstream, use our observed streaming token speed
  const hasExplicitTimings =
    typeof finalMeta.timings?.predicted_per_second === 'number' ||
    Boolean(finalMeta.eval_count && finalMeta.eval_duration);
  let perf = extractPerfMetrics(finalMeta, elapsedMs, `${accThinking} ${accContent}`);
  if (!hasExplicitTimings && streamTokens >= 2 && firstTokenAt > 0) {
    const genSec = Math.max(0.1, (Date.now() - firstTokenAt) / 1000);
    perf = {
      ...perf,
      tokensPerSec: +(streamTokens / genSec).toFixed(1),
      evalTokens: finalMeta.usage?.completion_tokens ?? streamTokens,
    };
  }

  return {
    content: accContent,
    ...(accThinking.trim() ? { thinking: accThinking.trim() } : {}),
    perf,
  };
}

export async function analyzeChartWithOllama(
  rawBaseUrl: string | undefined,
  modelRaw: string | undefined,
  input: GeminiMarketContextInput,
  streamCallbacks?: LocalAiStreamCallbacks,
  reasoningMode: AiReasoningMode = 'deep'
): Promise<GeminiChartAnalysis> {
  const baseUrl = normalizeOllamaBaseUrl(rawBaseUrl);
  const model = (modelRaw || process.env.OLLAMA_MODEL || '').trim();
  if (!model) {
    throw new Error(
      'No local model selected. Pull a model (e.g. `ollama pull qwen3:4b`) or connect Fast GPU (:11435).'
    );
  }
  if (!input.candles || input.candles.length < 15) {
    throw new Error('Not enough candle data loaded yet to run technical analysis.');
  }

  const { prompt, tech, topBidWall, topAskWall, htfAlignment, mlForecast } = buildMarketContextPrompt(input, 20);
  const currentPrice = input.ticker.lastPrice || tech.lastClose;
  const systemMsg =
    'You are a senior quantitative Bitcoin regime strategist and orderflow synthesizer. Combine the calibrated LightGBM Quant-ML probabilities with live orderbook walls, 5-exchange funding, and Value Area structure. Keep internal reasoning brief (under 200 words), then immediately return ONLY valid JSON matching the exact schema—no prose outside JSON.';

  const { content, thinking, perf } = await runLocalAiCompletion({
    baseUrl,
    model,
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user', content: prompt },
    ],
    temperature: 0.6,
    maxTokens: 4096,
    jsonSchema: OLLAMA_JSON_SCHEMA,
    reasoningMode,
    timeoutMs: 300_000,
    streamCallbacks,
  });

  const effectiveContent = content.trim() ? content : thinking || '';
  if (!content.trim()) {
    // Some reasoning models exhaust output budget inside thinking or emit JSON inside thinking
    let recovered: Record<string, unknown> | null = null;
    if (effectiveContent.includes('{') && effectiveContent.includes('marketBias')) {
      try {
        recovered = extractJsonObject(effectiveContent);
      } catch {
        recovered = null;
      }
    }
    if (!recovered) {
      throw new Error(
        thinking
          ? `Model "${model}" spent its entire token budget on reasoning before outputting the JSON report. Use ⚡ Fast GPU (:11435) or retry.`
          : `Model "${model}" returned an empty response. Please retry.`
      );
    }
    return sanitizeAnalysis(recovered, {
      model,
      exchange: input.exchange,
      timeframe: input.timeframe,
      currentPrice,
      tech,
      oiWeightedFunding8h: input.fundingRates.oiWeighted8hPct,
      bookImbalancePct: input.ticker.imbalancePct,
      topBidWall,
      topAskWall,
      htfAlignment,
      mlForecast,
      promptSnapshot: prompt,
      perf,
      thinking,
    });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJsonObject(content);
  } catch {
    throw new Error(
      `Model "${model}" did not return valid structured JSON. Recommended: qwen3-4b-local, qwen3:4b, qwen2.5:7b.`
    );
  }

  return sanitizeAnalysis(parsed, {
    model,
    exchange: input.exchange,
    timeframe: input.timeframe,
    currentPrice,
    tech,
    oiWeightedFunding8h: input.fundingRates.oiWeighted8hPct,
    bookImbalancePct: input.ticker.imbalancePct,
    topBidWall,
    topAskWall,
    htfAlignment,
    mlForecast,
    promptSnapshot: prompt,
    perf,
    thinking,
  });
}

function buildLiveChatSystemPrompt(
  input?: GeminiMarketContextInput,
  reasoningMode: AiReasoningMode = 'deep'
): { systemText: string; liveContextBlock?: string } {
  const fastNote =
    reasoningMode === 'fast'
      ? ' Be ultra-concise (max 5 short bullets, zero preamble, start directly with bold heading/numbers).'
      : '';
  const pb = input?.tradingPlaybook?.trim()
    ? `\n\nUSER TRADING PLAYBOOK (FOLLOW THESE RULES):\n${input.tradingPlaybook.trim().slice(0, 800)}`
    : '';
  const staticSys = `You are a helpful, concise quantitative Bitcoin technical analyst and orderflow assistant embedded inside the user's live trading chart.
Answer the user's questions directly using ONLY the real live market data provided (never invent fake prices). Format cleanly with bullet points and exact price levels.${fastNote}${pb}`;

  if (!input || input.candles.length === 0) {
    return { systemText: staticSys };
  }
  const { prompt } = buildMarketContextPrompt(input, 12);
  const headerIdx = prompt.indexOf('MARKET HEADER:');
  const marketBlock = headerIdx >= 0 ? prompt.slice(headerIdx) : prompt;
  return { systemText: staticSys, liveContextBlock: marketBlock };
}

export async function chatWithLocalAi(
  rawBaseUrl: string | undefined,
  modelRaw: string | undefined,
  messages: AiChatMessage[],
  context?: GeminiMarketContextInput,
  streamCallbacks?: LocalAiStreamCallbacks,
  reasoningMode: AiReasoningMode = 'deep'
): Promise<AiChatResponse> {
  const baseUrl = normalizeOllamaBaseUrl(rawBaseUrl);
  const model = (modelRaw || process.env.OLLAMA_MODEL || '').trim();
  if (!model) {
    throw new Error('No local AI model selected.');
  }

  const { systemText, liveContextBlock } = buildLiveChatSystemPrompt(context, reasoningMode);
  const history = messages.slice(-16).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  // Pin static system prompt + Playbook at index 0 for KV-cache reuse across multi-turn chats,
  // and attach the fresh live market snapshot to the latest user turn!
  if (liveContextBlock && history.length > 0) {
    const lastIdx = history.length - 1;
    history[lastIdx] = {
      role: history[lastIdx].role,
      content: `[LIVE CHART SNAPSHOT]\n${liveContextBlock}\n\n[USER QUESTION]\n${history[lastIdx].content}`,
    };
  }
  const chatMessages = [{ role: 'system', content: systemText }, ...history];

  const { content, thinking: rawThinking, perf } = await runLocalAiCompletion({
    baseUrl,
    model,
    messages: chatMessages,
    temperature: 0.6,
    maxTokens: reasoningMode === 'fast' ? 600 : 2400,
    reasoningMode,
    timeoutMs: 300_000,
    streamCallbacks,
  });

  let rawReply = content;
  let thinking = rawThinking;
  if (!rawReply.trim() && thinking) {
    rawReply = thinking;
    thinking = undefined;
  }
  if (!rawReply.trim()) {
    throw new Error(`Model "${model}" returned an empty reply.`);
  }

  return {
    model,
    reply: rawReply.trim(),
    ...(thinking ? { thinking: thinking.trim() } : {}),
    perf,
    generatedAt: Date.now(),
  };
}
