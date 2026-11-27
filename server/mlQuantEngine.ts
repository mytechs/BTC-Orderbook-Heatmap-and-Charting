import fs from 'node:fs';
import path from 'node:path';
import type { MlQuantForecast, TimeframeId } from '../shared/types.ts';
import type { RawKline } from './collectorUtils.ts';
import { extractMlFeaturesAt, summarizeTopDrivers } from './mlFeatures.ts';

/**
 * Compact JSON tree node exported from LightGBM `booster.dump_model()`.
 * Evaluated directly in pure TypeScript (<1ms, 0 MB VRAM, zero Python runtime).
 */
export interface LgbmTreeNode {
  // Internal split node
  f?: number; // split_feature index
  t?: number; // threshold
  dl?: boolean; // default_left
  l?: LgbmTreeNode; // left_child (<= threshold)
  r?: LgbmTreeNode; // right_child (> threshold)
  // Leaf node
  v?: number; // leaf_value
}

export interface LgbmModelBundle {
  numClass: number; // 1 for regression, 3 for multiclass softmax
  trees: LgbmTreeNode[];
  tempScale?: number; // optional post-hoc temperature calibration on logits
}

export interface TimeframeMlBundle {
  timeframe: '1h' | '4h' | '1d';
  horizonBars: number;
  horizonLabel: string;
  barrierAtrMult: number;
  directionModel: LgbmModelBundle; // classes: [0=Down, 1=Chop, 2=Up]
  regimeModel: LgbmModelBundle; // classes: [0=Mean-Reverting, 1=Trending, 2=High-Vol Flush]
  rangeModel: LgbmModelBundle; // regression: predicted 12-bar forward range %
  meta: {
    trainedAt: string;
    trainSamples: number;
    oosDirectionAuc: number;
    oosBrierScore: number;
    oosHighConvWinRate?: number;
  };
}

export interface MlModelArtifact {
  version: number;
  featureNames: string[];
  models: Partial<Record<'1h' | '4h' | '1d', TimeframeMlBundle>>;
}

export function evalLgbmTree(node: LgbmTreeNode, features: number[]): number {
  let cur: LgbmTreeNode = node;
  while (cur.v === undefined) {
    const val = features[cur.f ?? 0];
    const goLeft = Number.isNaN(val) ? Boolean(cur.dl) : val <= (cur.t ?? 0);
    cur = (goLeft ? cur.l : cur.r) ?? { v: 0 };
  }
  return cur.v;
}

export function evalLgbmMulticlass(model: LgbmModelBundle, features: number[]): number[] {
  const k = Math.max(2, model.numClass);
  const logits = new Array<number>(k).fill(0);
  // LightGBM stores multiclass trees interleaved: tree i belongs to class (i % numClass)
  for (let i = 0; i < model.trees.length; i++) {
    logits[i % k] += evalLgbmTree(model.trees[i], features);
  }
  const temp = model.tempScale && model.tempScale > 0 ? model.tempScale : 1.0;
  let maxL = -Infinity;
  for (let c = 0; c < k; c++) {
    logits[c] /= temp;
    if (logits[c] > maxL) maxL = logits[c];
  }
  let sumExp = 0;
  const probs = new Array<number>(k);
  for (let c = 0; c < k; c++) {
    probs[c] = Math.exp(logits[c] - maxL);
    sumExp += probs[c];
  }
  for (let c = 0; c < k; c++) {
    probs[c] = sumExp > 0 ? probs[c] / sumExp : 1 / k;
  }
  return probs;
}

export function evalLgbmRegression(model: LgbmModelBundle, features: number[]): number {
  let sum = 0;
  for (let i = 0; i < model.trees.length; i++) {
    sum += evalLgbmTree(model.trees[i], features);
  }
  return sum;
}

let cachedArtifact: MlModelArtifact | null = null;
let cachedMtimeMs = 0;
let defaultModelPath = path.resolve('server/data/ml-btc-models.json');

export function setMlModelPathForTests(p: string) {
  defaultModelPath = p;
  cachedArtifact = null;
  cachedMtimeMs = 0;
}

export function loadMlArtifact(): MlModelArtifact | null {
  try {
    if (!fs.existsSync(defaultModelPath)) return null;
    const stat = fs.statSync(defaultModelPath);
    if (cachedArtifact && stat.mtimeMs === cachedMtimeMs) {
      return cachedArtifact;
    }
    const raw = fs.readFileSync(defaultModelPath, 'utf8');
    cachedArtifact = JSON.parse(raw) as MlModelArtifact;
    cachedMtimeMs = stat.mtimeMs;
    return cachedArtifact;
  } catch {
    return null;
  }
}

function mapToSupportedMlTf(tf: TimeframeId): '1h' | '4h' | '1d' {
  if (tf === '1d') return '1d';
  if (tf === '4h') return '4h';
  return '1h';
}

export function runMlQuantForecast(
  candles: RawKline[],
  timeframe: TimeframeId,
  livePrice?: number
): MlQuantForecast | null {
  if (!candles || candles.length < 35) return null;
  const artifact = loadMlArtifact();
  if (!artifact) return null;

  const targetTf = mapToSupportedMlTf(timeframe);
  const bundle =
    artifact.models[targetTf] ||
    artifact.models['4h'] ||
    artifact.models['1h'] ||
    artifact.models['1d'];
  if (!bundle) return null;

  const t0 = performance.now();
  const features = extractMlFeaturesAt(candles, candles.length - 1);
  const dirProbs = evalLgbmMulticlass(bundle.directionModel, features);
  const regProbs = evalLgbmMulticlass(bundle.regimeModel, features);
  const rawRangePct = evalLgbmRegression(bundle.rangeModel, features);
  const inferenceMs = +(performance.now() - t0).toFixed(2);

  // classes: [0=Down, 1=Chop, 2=Up]
  const probDown = +(dirProbs[0] * 100).toFixed(1);
  const probChop = +(dirProbs[1] * 100).toFixed(1);
  const probUp = +(Math.max(0, 100 - probDown - probChop)).toFixed(1);
  const directionalEdgePct = +(probUp - probDown).toFixed(1);

  const absEdge = Math.abs(directionalEdgePct);
  // Quant safety guardrail: suppress directional conviction if out-of-sample AUC < 0.51 (low-sample / regime-shifted TF)
  const hasValidatedEdge = bundle.meta.oosDirectionAuc >= 0.51;
  const directionalBias: 'Bullish' | 'Bearish' | 'Neutral' =
    !hasValidatedEdge || probChop >= 46 || absEdge < 6
      ? 'Neutral'
      : directionalEdgePct > 0
        ? 'Bullish'
        : 'Bearish';
  const conviction: 'High' | 'Moderate' | 'Low' =
    directionalBias === 'Neutral'
      ? 'Low'
      : absEdge >= 18 && Math.max(probUp, probDown) >= 48
        ? 'High'
        : absEdge >= 10
          ? 'Moderate'
          : 'Low';

  // regime classes: [0=Mean-Reverting, 1=Trending, 2=High-Vol Flush]
  const meanReverting = +(regProbs[0] * 100).toFixed(1);
  const trending = +(regProbs[1] * 100).toFixed(1);
  const highVolFlush = +(Math.max(0, 100 - meanReverting - trending)).toFixed(1);
  const dominantRegime: 'Trending' | 'Mean-Reverting' | 'High-Vol Flush' =
    highVolFlush >= trending && highVolFlush >= meanReverting
      ? 'High-Vol Flush'
      : trending >= meanReverting
        ? 'Trending'
        : 'Mean-Reverting';

  const price = livePrice && livePrice > 0 ? livePrice : candles[candles.length - 1].c;
  const expectedRangePct = +Math.max(0.8, Math.min(25, rawRangePct)).toFixed(2);
  const halfMove = price * (expectedRangePct / 200);
  const expectedLow = +(price - halfMove).toFixed(1);
  const expectedHigh = +(price + halfMove).toFixed(1);

  return {
    modelTimeframe: bundle.timeframe,
    horizonBars: bundle.horizonBars,
    horizonLabel: bundle.horizonLabel,
    barrierAtrMult: bundle.barrierAtrMult,
    probUp,
    probDown,
    probChop,
    directionalEdgePct,
    directionalBias,
    conviction,
    regimeProbs: { trending, meanReverting, highVolFlush },
    dominantRegime,
    expectedRangePct,
    expectedLow,
    expectedHigh,
    topDrivers: summarizeTopDrivers(features),
    modelMeta: bundle.meta,
    inferenceMs,
  };
}
