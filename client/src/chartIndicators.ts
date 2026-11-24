import type { HeatmapSlice } from '../../shared/types.ts';

export interface OhlcBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  bv: number;
  sv: number;
}

export function slicesToBars(slices: HeatmapSlice[]): OhlcBar[] {
  const n = slices.length;
  const out = new Array<OhlcBar>(n);
  for (let i = 0; i < n; i++) {
    const s = slices[i];
    out[i] = {
      t: s.t,
      o: s.o,
      h: s.h,
      l: s.l,
      c: s.c,
      vol: Math.round((s.bv + s.sv) * 10000) / 10000,
      bv: s.bv,
      sv: s.sv,
    };
  }
  return out;
}

export function toHeikinAshi(bars: OhlcBar[]): OhlcBar[] {
  const n = bars.length;
  if (n === 0) return [];
  const out = new Array<OhlcBar>(n);
  let prevO = 0;
  let prevC = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const haClose = (b.o + b.h + b.l + b.c) * 0.25;
    const haOpen = i === 0 ? (b.o + b.c) * 0.5 : (prevO + prevC) * 0.5;
    const haHigh = Math.max(b.h, haOpen, haClose);
    const haLow = Math.min(b.l, haOpen, haClose);
    prevO = Math.round(haOpen * 100) / 100;
    prevC = Math.round(haClose * 100) / 100;
    out[i] = {
      t: b.t,
      vol: b.vol,
      bv: b.bv,
      sv: b.sv,
      o: prevO,
      h: Math.round(haHigh * 100) / 100,
      l: Math.round(haLow * 100) / 100,
      c: prevC,
    };
  }
  return out;
}

export function calcSMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function calcEMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
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

export function calcVWAP(bars: OhlcBar[]): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tp = (b.h + b.l + b.c) / 3;
    const v = Math.max(b.vol, 0.0001);
    cumPV += tp * v;
    cumV += v;
    out[i] = cumPV / cumV;
  }
  return out;
}

export interface BollingerResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

export function calcBollinger(
  values: number[],
  period = 20,
  mult = 2
): BollingerResult {
  const n = values.length;
  const upper: (number | null)[] = new Array(n).fill(null);
  const middle: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  if (period <= 0 || n < period) return { upper, middle, lower };

  // O(N) sliding-window mean & variance
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    sum += v;
    sumSq += v * v;
    if (i >= period) {
      const old = values[i - period];
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= period - 1) {
      const mean = sum / period;
      const variance = Math.max(0, sumSq / period - mean * mean);
      const std = Math.sqrt(variance);
      middle[i] = mean;
      upper[i] = mean + mult * std;
      lower[i] = mean - mult * std;
    }
  }
  return { upper, middle, lower };
}

export function calcRSI(values: number[], period = 14): (number | null)[] {
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

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
}

export function calcMACD(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): MacdResult {
  const n = values.length;
  const emaFast = calcEMA(values, fast);
  const emaSlow = calcEMA(values, slow);
  const macd: (number | null)[] = new Array(n).fill(null);
  const validMacdVals: number[] = [];
  const validMacdIndices: number[] = [];

  for (let i = 0; i < n; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      const m = (emaFast[i] as number) - (emaSlow[i] as number);
      macd[i] = m;
      validMacdVals.push(m);
      validMacdIndices.push(i);
    }
  }

  const sigCompact = calcEMA(validMacdVals, signalPeriod);
  const signal: (number | null)[] = new Array(n).fill(null);
  const hist: (number | null)[] = new Array(n).fill(null);

  for (let k = 0; k < validMacdIndices.length; k++) {
    const idx = validMacdIndices[k];
    const sVal = sigCompact[k];
    if (sVal !== null && macd[idx] !== null) {
      signal[idx] = sVal;
      hist[idx] = (macd[idx] as number) - sVal;
    }
  }

  return { macd, signal, hist };
}
