import type { RawKline } from './collectorUtils.ts';
import type { MlFeatureDriver } from '../shared/types.ts';

/**
 * Fixed 46-feature schema shared between offline Python LightGBM training
 * (`training/build_ml_features.ts` -> `training/train_ml_models.py`)
 * and live TypeScript tree inference (`server/mlQuantEngine.ts`).
 *
 * 28 OHLCV / Volume Profile + 11 Derivatives & Perp Taker Flow +
 * 4 Spot-vs-Perp Flow Divergence + 3 Higher-Timeframe (MTF) Regime features.
 *
 * STRICT ZERO LOOK-AHEAD GUARANTEE: every feature at index `t` uses ONLY `candles[0..t]`.
 */
export const ML_FEATURE_NAMES = [
  'ret_1',
  'ret_3',
  'ret_6',
  'ret_12',
  'ret_24',
  'atr14_pct',
  'atr_ratio_14_50',
  'bb_width_pct',
  'bb_pct_b',
  'dist_ema9_pct',
  'dist_ema21_pct',
  'dist_ema50_pct',
  'dist_ma50_pct',
  'dist_ma100_pct',
  'dist_ma200_pct',
  'ema21_slope5_pct',
  'rsi14',
  'rsi14_delta5',
  'macd_norm_atr',
  'macd_hist_norm_atr',
  'vol_ratio_20',
  'dist_poc_pct',
  'va_position_norm',
  'va_width_pct',
  'candle_body_ratio',
  'wick_asymmetry',
  'rsi_div_flag',
  'sfp_sweep_flag',
  // Derivatives & Perp Taker Orderflow (11)
  'taker_buy_ratio',
  'taker_buy_ratio_6',
  'taker_cvd_norm_6',
  'taker_cvd_norm_20',
  'funding_rate_bps',
  'funding_zscore_90',
  'funding_delta_6',
  'perp_basis_bps',
  'oi_chg_6_pct',
  'oi_chg_24_pct',
  'oi_zscore_50',
  // Spot vs Perp Microstructure Divergence (4)
  'spot_vol_share',
  'spot_taker_buy_ratio',
  'spot_perp_cvd_div_6',
  'spot_perp_cvd_div_20',
  // Higher-Timeframe Regime Context (3)
  'htf_dist_ma50_pct',
  'htf_rsi14',
  'htf_atr_ratio',
] as const;

export type MlFeatureName = (typeof ML_FEATURE_NAMES)[number];

function safePct(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b) < 1e-9) return 0;
  return ((a - b) / b) * 100;
}

function calcEmaLast(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(values[0] || 0);
  if (n === 0) return out;
  const k = 2 / (period + 1);
  let ema = values[0];
  out[0] = ema;
  for (let i = 1; i < n; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calcSmaAt(values: number[], endIdx: number, period: number): number {
  const start = Math.max(0, endIdx - period + 1);
  let sum = 0;
  for (let i = start; i <= endIdx; i++) sum += values[i];
  return sum / Math.max(1, endIdx - start + 1);
}

function calcAtrAt(candles: RawKline[], endIdx: number, period: number): number {
  const start = Math.max(1, endIdx - period + 1);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= endIdx; i++) {
    const c = candles[i];
    const prevC = candles[i - 1].c;
    sum += Math.max(c.h - c.l, Math.abs(c.h - prevC), Math.abs(c.l - prevC));
    count++;
  }
  return count > 0 ? sum / count : Math.max(1, candles[endIdx].h - candles[endIdx].l);
}

function calcRsiSeriesFast(closes: number[], period = 14): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(50);
  if (n <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface PrecomputedSeries {
  closes: number[];
  ema9: number[];
  ema21: number[];
  ema50: number[];
  macdLine: number[];
  macdSignal: number[];
  rsi14: number[];
}

export function precomputeSeries(candles: RawKline[]): PrecomputedSeries {
  const closes = candles.map((k) => k.c);
  const ema9 = calcEmaLast(closes, 9);
  const ema21 = calcEmaLast(closes, 21);
  const ema50 = calcEmaLast(closes, 50);
  const ema12 = calcEmaLast(closes, 12);
  const ema26 = calcEmaLast(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const macdSignal = calcEmaLast(macdLine, 9);
  const rsi14 = calcRsiSeriesFast(closes, 14);
  return { closes, ema9, ema21, ema50, macdLine, macdSignal, rsi14 };
}

/**
 * Extract the exact 28-element feature vector at bar index `endIdx` using ONLY `candles[0..endIdx]`.
 */
export function extractMlFeaturesAt(
  candles: RawKline[],
  endIdx: number,
  pre?: PrecomputedSeries
): number[] {
  const s = pre ?? precomputeSeries(candles.slice(0, endIdx + 1));
  const idx = pre ? endIdx : s.closes.length - 1;
  const k = candles[endIdx];
  const price = k.c;

  const ret = (lb: number) => {
    const pIdx = Math.max(0, endIdx - lb);
    return safePct(price, candles[pIdx].c);
  };

  const atr14 = calcAtrAt(candles, endIdx, 14);
  const atr50 = calcAtrAt(candles, endIdx, 50);
  const atr14Pct = price > 0 ? (atr14 / price) * 100 : 0;
  const atrRatio = atr50 > 1e-6 ? atr14 / atr50 : 1;

  // Bollinger Bands (20, 2)
  const bbStart = Math.max(0, endIdx - 19);
  const bbLen = endIdx - bbStart + 1;
  let bbSum = 0;
  for (let i = bbStart; i <= endIdx; i++) bbSum += candles[i].c;
  const bbMid = bbSum / bbLen;
  let bbSq = 0;
  for (let i = bbStart; i <= endIdx; i++) {
    const d = candles[i].c - bbMid;
    bbSq += d * d;
  }
  const bbStd = Math.sqrt(bbSq / bbLen);
  const bbUp = bbMid + 2 * bbStd;
  const bbLo = bbMid - 2 * bbStd;
  const bbWidthPct = bbMid > 0 ? ((bbUp - bbLo) / bbMid) * 100 : 0;
  const bbPctB = bbUp - bbLo > 1e-6 ? (price - bbLo) / (bbUp - bbLo) : 0.5;

  const ma50 = calcSmaAt(s.closes, idx, 50);
  const ma100 = calcSmaAt(s.closes, idx, 100);
  const ma200 = calcSmaAt(s.closes, idx, 200);
  const ema21Prev5 = s.ema21[Math.max(0, idx - 5)];
  const ema21Slope5Pct = safePct(s.ema21[idx], ema21Prev5);

  const rsiNow = s.rsi14[idx];
  const rsiPrev5 = s.rsi14[Math.max(0, idx - 5)];
  const macdNormAtr = atr14 > 1e-6 ? s.macdLine[idx] / atr14 : 0;
  const macdHistNormAtr = atr14 > 1e-6 ? (s.macdLine[idx] - s.macdSignal[idx]) / atr14 : 0;

  // Volume ratio vs 20-bar MA
  const vStart = Math.max(0, endIdx - 19);
  let vSum = 0;
  for (let i = vStart; i <= endIdx; i++) vSum += candles[i].vol;
  const vAvg = vSum / Math.max(1, endIdx - vStart + 1);
  const volRatio20 = vAvg > 1e-6 ? Math.min(8, k.vol / vAvg) : 1;

  // 80-bar Volume Profile (POC / VAL / VAH)
  const vpStart = Math.max(0, endIdx - 79);
  let vpLow = Infinity;
  let vpHigh = -Infinity;
  for (let i = vpStart; i <= endIdx; i++) {
    if (candles[i].l < vpLow) vpLow = candles[i].l;
    if (candles[i].h > vpHigh) vpHigh = candles[i].h;
  }
  let distPocPct = 0;
  let vaPosNorm = 0.5;
  let vaWidthPct = 0;
  if (vpHigh > vpLow) {
    const BINS = 24;
    const binSize = (vpHigh - vpLow) / BINS;
    const bins = new Float64Array(BINS);
    let totalVol = 0;
    for (let i = vpStart; i <= endIdx; i++) {
      const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
      const b = Math.max(0, Math.min(BINS - 1, Math.floor((tp - vpLow) / binSize)));
      const v = Math.max(0, candles[i].vol);
      bins[b] += v;
      totalVol += v;
    }
    if (totalVol > 0) {
      let pocIdx = 0;
      for (let b = 1; b < BINS; b++) if (bins[b] > bins[pocIdx]) pocIdx = b;
      let acc = bins[pocIdx];
      let loIdx = pocIdx;
      let hiIdx = pocIdx;
      const target = totalVol * 0.7;
      while (acc < target && (loIdx > 0 || hiIdx < BINS - 1)) {
        const lVol = loIdx > 0 ? bins[loIdx - 1] : -1;
        const rVol = hiIdx < BINS - 1 ? bins[hiIdx + 1] : -1;
        if (rVol >= lVol && hiIdx < BINS - 1) {
          hiIdx++;
          acc += bins[hiIdx];
        } else if (loIdx > 0) {
          loIdx--;
          acc += bins[loIdx];
        } else break;
      }
      const poc = vpLow + (pocIdx + 0.5) * binSize;
      const val = vpLow + loIdx * binSize;
      const vah = vpLow + (hiIdx + 1) * binSize;
      distPocPct = safePct(price, poc);
      vaPosNorm = vah - val > 1e-6 ? Math.max(-1.5, Math.min(2.5, (price - val) / (vah - val))) : 0.5;
      vaWidthPct = price > 0 ? ((vah - val) / price) * 100 : 0;
    }
  }

  // Candle microstructure
  const barRange = Math.max(1e-6, k.h - k.l);
  const bodyRatio = (k.c - k.o) / barRange; // signed [-1, +1]
  const upperWick = k.h - Math.max(k.o, k.c);
  const lowerWick = Math.min(k.o, k.c) - k.l;
  const wickAsym = (lowerWick - upperWick) / barRange; // positive = buying tail

  // Fractal RSI divergence flag (-1 bearish, 0 none, +1 bullish)
  let rsiDivFlag = 0;
  const swLows: number[] = [];
  const swHighs: number[] = [];
  const scanFrom = Math.max(3, endIdx - 60);
  for (let i = scanFrom; i <= endIdx - 3; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isH = false;
      if (candles[j].l <= candles[i].l) isL = false;
    }
    if (isH) swHighs.push(i);
    if (isL) swLows.push(i);
  }
  if (swLows.length >= 2) {
    const p = swLows[swLows.length - 2];
    const c = swLows[swLows.length - 1];
    if (endIdx - c <= 20 && candles[c].l < candles[p].l && s.rsi14[c] > s.rsi14[p] + 2.5) {
      rsiDivFlag = 1;
    }
  }
  if (rsiDivFlag === 0 && swHighs.length >= 2) {
    const p = swHighs[swHighs.length - 2];
    const c = swHighs[swHighs.length - 1];
    if (endIdx - c <= 20 && candles[c].h > candles[p].h && s.rsi14[c] < s.rsi14[p] - 2.5) {
      rsiDivFlag = -1;
    }
  }

  // Liquidity sweep SFP in last 3 bars vs prior 25-bar range (-1 bearish, 0 none, +1 bullish)
  let sfpFlag = 0;
  if (endIdx >= 28) {
    let priorH = -Infinity;
    let priorL = Infinity;
    for (let i = endIdx - 28; i < endIdx - 3; i++) {
      if (candles[i].h > priorH) priorH = candles[i].h;
      if (candles[i].l < priorL) priorL = candles[i].l;
    }
    for (let i = endIdx - 2; i <= endIdx; i++) {
      if (candles[i].h > priorH && candles[i].c < priorH) sfpFlag = -1;
      else if (candles[i].l < priorL && candles[i].c > priorL) sfpFlag = 1;
    }
  }

  // Derivatives & Taker Orderflow (11 features, strictly causal on candles[0..endIdx])
  const getTbv = (c: RawKline): number => {
    if (typeof c.tbv === 'number' && Number.isFinite(c.tbv) && c.vol > 0) {
      return Math.max(0, Math.min(c.vol, c.tbv));
    }
    return c.vol * 0.5;
  };
  const takerBuyRatio = k.vol > 1e-6 ? getTbv(k) / k.vol : 0.5;

  const t6Start = Math.max(0, endIdx - 5);
  let sumVol6 = 0;
  let sumTbv6 = 0;
  let sumDelta6 = 0;
  for (let i = t6Start; i <= endIdx; i++) {
    const ci = candles[i];
    const tb = getTbv(ci);
    sumVol6 += ci.vol;
    sumTbv6 += tb;
    sumDelta6 += 2 * tb - ci.vol;
  }
  const takerBuyRatio6 = sumVol6 > 1e-6 ? sumTbv6 / sumVol6 : 0.5;
  const takerCvdNorm6 =
    vAvg > 1e-6 ? Math.max(-4, Math.min(4, sumDelta6 / (6 * vAvg))) : 0;

  const t20Start = Math.max(0, endIdx - 19);
  let sumDelta20 = 0;
  for (let i = t20Start; i <= endIdx; i++) {
    const ci = candles[i];
    sumDelta20 += 2 * getTbv(ci) - ci.vol;
  }
  const takerCvdNorm20 =
    vAvg > 1e-6 ? Math.max(-4, Math.min(4, sumDelta20 / (20 * vAvg))) : 0;

  const fundingNow =
    typeof k.fundingBps === 'number' && Number.isFinite(k.fundingBps) ? k.fundingBps : 0;
  const fPrev6 = candles[Math.max(0, endIdx - 6)].fundingBps;
  const fundingDelta6 =
    typeof fPrev6 === 'number' && Number.isFinite(fPrev6)
      ? Math.max(-15, Math.min(15, fundingNow - fPrev6))
      : 0;

  let fundingZscore90 = 0;
  const fStart = Math.max(0, endIdx - 89);
  let fSum = 0;
  let fCnt = 0;
  for (let i = fStart; i <= endIdx; i++) {
    const fv = candles[i].fundingBps;
    if (typeof fv === 'number' && Number.isFinite(fv)) {
      fSum += fv;
      fCnt++;
    }
  }
  if (fCnt >= 10 && typeof k.fundingBps === 'number' && Number.isFinite(k.fundingBps)) {
    const fMean = fSum / fCnt;
    let fSq = 0;
    for (let i = fStart; i <= endIdx; i++) {
      const fv = candles[i].fundingBps;
      if (typeof fv === 'number' && Number.isFinite(fv)) {
        const d = fv - fMean;
        fSq += d * d;
      }
    }
    const fStd = Math.sqrt(fSq / fCnt);
    if (fStd > 1e-4) {
      fundingZscore90 = Math.max(-5, Math.min(5, (fundingNow - fMean) / fStd));
    }
  }

  const perpBasisBps =
    typeof k.basisBps === 'number' && Number.isFinite(k.basisBps)
      ? Math.max(-100, Math.min(100, k.basisBps))
      : 0;

  const oiNow = typeof k.oiBtc === 'number' && Number.isFinite(k.oiBtc) && k.oiBtc > 0 ? k.oiBtc : 0;
  const oiPrev6 = candles[Math.max(0, endIdx - 6)].oiBtc;
  const oiPrev24 = candles[Math.max(0, endIdx - 24)].oiBtc;
  const oiChg6Pct =
    oiNow > 0 && typeof oiPrev6 === 'number' && oiPrev6 > 0
      ? Math.max(-40, Math.min(40, safePct(oiNow, oiPrev6)))
      : 0;
  const oiChg24Pct =
    oiNow > 0 && typeof oiPrev24 === 'number' && oiPrev24 > 0
      ? Math.max(-60, Math.min(60, safePct(oiNow, oiPrev24)))
      : 0;

  let oiZscore50 = 0;
  if (oiNow > 0) {
    const oiStart = Math.max(0, endIdx - 49);
    let oiSum = 0;
    let oiCnt = 0;
    for (let i = oiStart; i <= endIdx; i++) {
      const ov = candles[i].oiBtc;
      if (typeof ov === 'number' && Number.isFinite(ov) && ov > 0) {
        oiSum += ov;
        oiCnt++;
      }
    }
    if (oiCnt >= 10) {
      const oiMean = oiSum / oiCnt;
      let oiSq = 0;
      for (let i = oiStart; i <= endIdx; i++) {
        const ov = candles[i].oiBtc;
        if (typeof ov === 'number' && Number.isFinite(ov) && ov > 0) {
          const d = ov - oiMean;
          oiSq += d * d;
        }
      }
      const oiStd = Math.sqrt(oiSq / oiCnt);
      if (oiStd > 1e-4) {
        oiZscore50 = Math.max(-5, Math.min(5, (oiNow - oiMean) / oiStd));
      }
    }
  }

  // Spot vs Perp Microstructure Divergence (4 features)
  const getSpotVol = (c: RawKline): number =>
    typeof c.spotVol === 'number' && Number.isFinite(c.spotVol) && c.spotVol > 0 ? c.spotVol : 0;
  const getSpotTbv = (c: RawKline): number => {
    const sv = getSpotVol(c);
    if (sv <= 0) return 0;
    if (typeof c.spotTbv === 'number' && Number.isFinite(c.spotTbv)) {
      return Math.max(0, Math.min(sv, c.spotTbv));
    }
    return sv * 0.5;
  };
  const spotVolNow = getSpotVol(k);
  const spotVolShare =
    spotVolNow > 0 && k.vol > 0 ? spotVolNow / (spotVolNow + k.vol) : 0.25;
  const spotTakerBuyRatio = spotVolNow > 1e-6 ? getSpotTbv(k) / spotVolNow : 0.5;

  let spotVol6 = 0;
  let spotDelta6 = 0;
  let perpDeltaRatio6 = 0;
  for (let i = t6Start; i <= endIdx; i++) {
    const sv = getSpotVol(candles[i]);
    if (sv > 0) {
      spotVol6 += sv;
      spotDelta6 += 2 * getSpotTbv(candles[i]) - sv;
    }
  }
  perpDeltaRatio6 = sumVol6 > 1e-6 ? sumDelta6 / sumVol6 : 0;
  const spotDeltaRatio6 = spotVol6 > 1e-6 ? spotDelta6 / spotVol6 : perpDeltaRatio6;
  const spotPerpCvdDiv6 = Math.max(-1, Math.min(1, spotDeltaRatio6 - perpDeltaRatio6));

  let spotVol20 = 0;
  let spotDelta20 = 0;
  let sumVol20 = 0;
  for (let i = t20Start; i <= endIdx; i++) {
    sumVol20 += candles[i].vol;
    const sv = getSpotVol(candles[i]);
    if (sv > 0) {
      spotVol20 += sv;
      spotDelta20 += 2 * getSpotTbv(candles[i]) - sv;
    }
  }
  const perpDeltaRatio20 = sumVol20 > 1e-6 ? sumDelta20 / sumVol20 : 0;
  const spotDeltaRatio20 = spotVol20 > 1e-6 ? spotDelta20 / spotVol20 : perpDeltaRatio20;
  const spotPerpCvdDiv20 = Math.max(-1, Math.min(1, spotDeltaRatio20 - perpDeltaRatio20));

  // Higher-Timeframe (MTF) Context (3 features — strictly causal closed HTF bars)
  const htfDistMa50 =
    typeof k.htfDistMa50 === 'number' && Number.isFinite(k.htfDistMa50)
      ? Math.max(-60, Math.min(60, k.htfDistMa50))
      : safePct(price, ma200);
  const htfRsi14 =
    typeof k.htfRsi14 === 'number' && Number.isFinite(k.htfRsi14)
      ? Math.max(0, Math.min(100, k.htfRsi14))
      : rsiNow;
  const htfAtrRatio =
    typeof k.htfAtrRatio === 'number' && Number.isFinite(k.htfAtrRatio)
      ? Math.max(0.2, Math.min(4, k.htfAtrRatio))
      : atrRatio;

  const vec = [
    ret(1),
    ret(3),
    ret(6),
    ret(12),
    ret(24),
    atr14Pct,
    atrRatio,
    bbWidthPct,
    bbPctB,
    safePct(price, s.ema9[idx]),
    safePct(price, s.ema21[idx]),
    safePct(price, s.ema50[idx]),
    safePct(price, ma50),
    safePct(price, ma100),
    safePct(price, ma200),
    ema21Slope5Pct,
    rsiNow,
    rsiNow - rsiPrev5,
    macdNormAtr,
    macdHistNormAtr,
    volRatio20,
    distPocPct,
    vaPosNorm,
    vaWidthPct,
    bodyRatio,
    wickAsym,
    rsiDivFlag,
    sfpFlag,
    takerBuyRatio,
    takerBuyRatio6,
    takerCvdNorm6,
    takerCvdNorm20,
    fundingNow,
    fundingZscore90,
    fundingDelta6,
    perpBasisBps,
    oiChg6Pct,
    oiChg24Pct,
    oiZscore50,
    spotVolShare,
    spotTakerBuyRatio,
    spotPerpCvdDiv6,
    spotPerpCvdDiv20,
    htfDistMa50,
    htfRsi14,
    htfAtrRatio,
  ];

  return vec.map((v) => (Number.isFinite(v) ? +v.toFixed(5) : 0));
}

export function summarizeTopDrivers(features: number[]): MlFeatureDriver[] {
  const byName = (name: MlFeatureName) => features[ML_FEATURE_NAMES.indexOf(name)] ?? 0;
  const drivers: { score: number; driver: MlFeatureDriver }[] = [];

  const vaPos = byName('va_position_norm');
  const distPoc = byName('dist_poc_pct');
  if (vaPos > 1.0) {
    drivers.push({
      score: Math.abs(distPoc) + 2,
      driver: {
        name: 'va_position_norm',
        label: 'Above Value Area (VAH)',
        valueText: `+${distPoc.toFixed(1)}% vs POC`,
        direction: 'bullish',
      },
    });
  } else if (vaPos < 0.0) {
    drivers.push({
      score: Math.abs(distPoc) + 2,
      driver: {
        name: 'va_position_norm',
        label: 'Below Value Area (VAL)',
        valueText: `${distPoc.toFixed(1)}% vs POC`,
        direction: 'bearish',
      },
    });
  }

  const distMa50 = byName('dist_ma50_pct');
  const distMa200 = byName('dist_ma200_pct');
  if (Math.abs(distMa50) >= 0.8) {
    drivers.push({
      score: Math.abs(distMa50),
      driver: {
        name: 'dist_ma50_pct',
        label: distMa50 > 0 ? 'Above MA50 Trend' : 'Below MA50 Trend',
        valueText: `${distMa50 >= 0 ? '+' : ''}${distMa50.toFixed(1)}% (MA200 ${distMa200 >= 0 ? '+' : ''}${distMa200.toFixed(1)}%)`,
        direction: distMa50 > 0 ? 'bullish' : 'bearish',
      },
    });
  }

  const rsi = byName('rsi14');
  if (rsi >= 68 || rsi <= 34) {
    drivers.push({
      score: Math.abs(rsi - 50) / 8,
      driver: {
        name: 'rsi14',
        label: rsi >= 68 ? 'Extended RSI Momentum' : 'Oversold RSI Stretch',
        valueText: `RSI ${rsi.toFixed(1)}`,
        direction: rsi >= 68 ? 'bearish' : 'bullish',
      },
    });
  }

  const atrRatio = byName('atr_ratio_14_50');
  const bbW = byName('bb_width_pct');
  if (bbW < 2.2) {
    drivers.push({
      score: 2.5,
      driver: {
        name: 'bb_width_pct',
        label: 'Volatility Squeeze',
        valueText: `BB ${bbW.toFixed(1)}%`,
        direction: 'neutral',
      },
    });
  } else if (atrRatio > 1.35) {
    drivers.push({
      score: atrRatio * 1.6,
      driver: {
        name: 'atr_ratio_14_50',
        label: 'Expanding Volatility',
        valueText: `ATR ${atrRatio.toFixed(2)}x`,
        direction: 'neutral',
      },
    });
  }

  const div = byName('rsi_div_flag');
  if (div !== 0) {
    drivers.push({
      score: 3.2,
      driver: {
        name: 'rsi_div_flag',
        label: div > 0 ? 'Bullish RSI Divergence' : 'Bearish RSI Divergence',
        valueText: 'Fractal swing div',
        direction: div > 0 ? 'bullish' : 'bearish',
      },
    });
  }

  const sfp = byName('sfp_sweep_flag');
  if (sfp !== 0) {
    drivers.push({
      score: 3.4,
      driver: {
        name: 'sfp_sweep_flag',
        label: sfp > 0 ? 'Bullish SFP Sweep' : 'Bearish SFP Sweep',
        valueText: 'Liquidity reclaim',
        direction: sfp > 0 ? 'bullish' : 'bearish',
      },
    });
  }

  const takerCvd6 = byName('taker_cvd_norm_6');
  const takerRatio6 = byName('taker_buy_ratio_6');
  if (Math.abs(takerCvd6) >= 0.1) {
    drivers.push({
      score: Math.abs(takerCvd6) * 14 + 1.4,
      driver: {
        name: 'taker_cvd_norm_6',
        label: takerCvd6 > 0 ? 'Aggressive Taker Buying' : 'Aggressive Taker Selling',
        valueText: `${(takerRatio6 * 100).toFixed(0)}% buy (CVD ${takerCvd6 >= 0 ? '+' : ''}${takerCvd6.toFixed(2)})`,
        direction: takerCvd6 > 0 ? 'bullish' : 'bearish',
      },
    });
  }

  const fundBps = byName('funding_rate_bps');
  const fundZ = byName('funding_zscore_90');
  if (Math.abs(fundZ) >= 1.5 || Math.abs(fundBps) >= 2.0) {
    const crowdedLong = fundBps > 0 && fundZ > 0;
    const crowdedShort = fundBps < 0 || fundZ <= -1.5;
    drivers.push({
      score: Math.max(Math.abs(fundZ) * 1.4, Math.abs(fundBps)) + 1.2,
      driver: {
        name: 'funding_rate_bps',
        label: crowdedLong ? 'Crowded Long Funding' : crowdedShort ? 'Negative/Short Funding' : 'Funding Extreme',
        valueText: `${(fundBps / 100).toFixed(4)}% (${fundZ >= 0 ? '+' : ''}${fundZ.toFixed(1)}σ)`,
        direction: crowdedLong ? 'bearish' : 'bullish',
      },
    });
  }

  const oiChg6 = byName('oi_chg_6_pct');
  const oiZ = byName('oi_zscore_50');
  if (Math.abs(oiChg6) >= 2.5 || Math.abs(oiZ) >= 1.8) {
    drivers.push({
      score: Math.max(Math.abs(oiChg6) * 0.7, Math.abs(oiZ) * 1.2) + 1.0,
      driver: {
        name: 'oi_chg_6_pct',
        label: oiChg6 >= 2.5 ? 'OI Leverage Buildup' : oiChg6 <= -2.5 ? 'OI Deleverage Flush' : 'OI Positioning Extreme',
        valueText: `OI ${oiChg6 >= 0 ? '+' : ''}${oiChg6.toFixed(1)}% (z ${oiZ >= 0 ? '+' : ''}${oiZ.toFixed(1)})`,
        direction: 'neutral',
      },
    });
  }

  const basisBps = byName('perp_basis_bps');
  if (Math.abs(basisBps) >= 8) {
    drivers.push({
      score: Math.abs(basisBps) * 0.25 + 1.0,
      driver: {
        name: 'perp_basis_bps',
        label: basisBps > 0 ? 'Perp Premium vs Spot' : 'Perp Discount vs Spot',
        valueText: `${basisBps >= 0 ? '+' : ''}${basisBps.toFixed(1)} bps`,
        direction: basisBps > 0 ? 'bullish' : 'bearish',
      },
    });
  }

  const spotDiv6 = byName('spot_perp_cvd_div_6');
  const spotShare = byName('spot_vol_share');
  if (Math.abs(spotDiv6) >= 0.06) {
    drivers.push({
      score: Math.abs(spotDiv6) * 28 + 1.6,
      driver: {
        name: 'spot_perp_cvd_div_6',
        label: spotDiv6 > 0 ? 'Spot Absorbing Perp Sells' : 'Perp Chasing vs Spot',
        valueText: `Div ${spotDiv6 >= 0 ? '+' : ''}${(spotDiv6 * 100).toFixed(1)}% (Spot ${(spotShare * 100).toFixed(0)}%)`,
        direction: spotDiv6 > 0 ? 'bullish' : 'bearish',
      },
    });
  }

  if (drivers.length === 0) {
    drivers.push({
      score: 1,
      driver: {
        name: 'dist_poc_pct',
        label: 'Balanced Inside Value Area',
        valueText: `${distPoc >= 0 ? '+' : ''}${distPoc.toFixed(1)}% vs POC`,
        direction: 'neutral',
      },
    });
  }

  return drivers
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((d) => d.driver);
}
