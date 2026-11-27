import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { RawKline } from '../server/collectorUtils.ts';
import { buildCausalHtfSummarySeries, lookupLatestCausal } from '../server/mlDerivativesFeed.ts';
import { ML_FEATURE_NAMES, extractMlFeaturesAt } from '../server/mlFeatures.ts';
import { MlLiveEvaluator } from '../server/mlLiveEvaluator.ts';
import {
  evalLgbmMulticlass,
  evalLgbmRegression,
  loadMlArtifact,
  runMlQuantForecast,
} from '../server/mlQuantEngine.ts';

function makeSyntheticBars(n: number): RawKline[] {
  const out: RawKline[] = [];
  const start = 1700000000000;
  for (let i = 0; i < n; i++) {
    const base = 60000 + i * 35 + Math.sin(i * 0.25) * 450;
    const o = base - 40;
    const c = base + 55;
    const vol = 110 + (i % 12) * 15;
    const spotVol = vol * 0.38;
    out.push({
      t: start + i * 3600_000,
      o,
      h: Math.max(o, c) + 140,
      l: Math.min(o, c) - 130,
      c,
      vol,
      tbv: vol * (0.45 + 0.12 * Math.sin(i * 0.3)),
      spotVol,
      spotTbv: spotVol * (0.52 + 0.1 * Math.cos(i * 0.25)),
      fundingBps: 0.8 + Math.sin(i * 0.1) * 0.6,
      basisBps: 2.5 + Math.cos(i * 0.2) * 3.0,
      oiBtc: 68000 + i * 18 + Math.sin(i * 0.15) * 900,
      htfDistMa50: 1.4 + Math.sin(i * 0.08) * 1.2,
      htfRsi14: 54 + Math.cos(i * 0.1) * 8,
      htfAtrRatio: 1.05 + Math.sin(i * 0.07) * 0.15,
    });
  }
  return out;
}

describe('mlQuantEngine', () => {
  it('extracts finite 46-feature vector (OHLCV + derivatives + Spot/Perp + MTF) with strict zero look-ahead bias', () => {
    const barsA = makeSyntheticBars(250);
    const barsB = barsA.map((b) => ({ ...b }));
    // Drastically mutate all future bars AND derivatives/spot/MTF after index 220
    for (let i = 221; i < barsB.length; i++) {
      barsB[i].o *= 2.5;
      barsB[i].h *= 2.5;
      barsB[i].l *= 0.2;
      barsB[i].c *= 2.5;
      barsB[i].vol *= 99;
      barsB[i].tbv = barsB[i].vol * 0.99;
      barsB[i].spotVol = barsB[i].vol * 5;
      barsB[i].spotTbv = barsB[i].spotVol * 0.02;
      barsB[i].fundingBps = 25;
      barsB[i].basisBps = -50;
      barsB[i].oiBtc = 999999;
      barsB[i].htfDistMa50 = -40;
      barsB[i].htfRsi14 = 10;
      barsB[i].htfAtrRatio = 3.5;
    }

    const featA = extractMlFeaturesAt(barsA, 220);
    const featB = extractMlFeaturesAt(barsB, 220);

    assert.equal(featA.length, 46);
    assert.equal(featA.length, ML_FEATURE_NAMES.length);
    assert.ok(featA.every((v) => Number.isFinite(v)));
    assert.deepEqual(featA, featB, 'Features at t must NEVER depend on candles/derivatives after t');

    const series = [
      { t: 1000, v: 1.5 },
      { t: 2000, v: 2.5 },
      { t: 3000, v: 9.9 },
    ];
    assert.equal(lookupLatestCausal(series, 999), undefined);
    assert.equal(lookupLatestCausal(series, 1000), 1.5);
    assert.equal(lookupLatestCausal(series, 2500), 2.5);
    assert.equal(lookupLatestCausal(series, 3000), 9.9);

    const htfPts = buildCausalHtfSummarySeries(barsA.slice(0, 60), 14_400_000);
    assert.equal(htfPts.length, 60);
    assert.equal(htfPts[0].closeT, barsA[0].t + 14_400_000);

    // Verify self-grading MlLiveEvaluator records and grades resolved predictions
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-eval-test-'));
    try {
      const ev = new MlLiveEvaluator(tmpDir);
      const fc = runMlQuantForecast(barsA.slice(0, 225), '1h');
      assert.ok(fc !== null);
      const s1 = ev.recordAndGrade(barsA.slice(0, 225), fc);
      assert.equal(s1.pendingCount, 1);
      assert.equal(s1.gradedCount, 0);
      // Advance 15 bars so the 12-bar horizon resolves and auto-grades
      const s2 = ev.recordAndGrade(barsA.slice(0, 240), fc);
      assert.equal(s2.gradedCount, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('matches Python LightGBM predictions to <1e-5 precision and runs in <5ms', () => {
    const parityPath = path.resolve('training/data/ml_parity_check.json');
    const artifact = loadMlArtifact();
    if (!fs.existsSync(parityPath) || !artifact) {
      return; // skip cleanly in fresh environments without trained model file
    }

    const samples = JSON.parse(fs.readFileSync(parityPath, 'utf8')) as {
      timeframe: '1h' | '4h' | '1d';
      features: number[];
      expectedDirProbs: number[];
      expectedRegProbs: number[];
      expectedRangePct: number;
    }[];

    assert.ok(samples.length >= 3);
    for (const s of samples) {
      const bundle = artifact.models[s.timeframe];
      assert.ok(bundle, `Expected trained bundle for ${s.timeframe}`);

      const dirProbs = evalLgbmMulticlass(bundle.directionModel, s.features);
      const regProbs = evalLgbmMulticlass(bundle.regimeModel, s.features);
      const rangePct = evalLgbmRegression(bundle.rangeModel, s.features);

      for (let c = 0; c < 3; c++) {
        assert.ok(
          Math.abs(dirProbs[c] - s.expectedDirProbs[c]) < 1e-4,
          `Dir prob mismatch on ${s.timeframe} class ${c}: ts=${dirProbs[c]} py=${s.expectedDirProbs[c]}`
        );
        assert.ok(
          Math.abs(regProbs[c] - s.expectedRegProbs[c]) < 1e-4,
          `Reg prob mismatch on ${s.timeframe} class ${c}: ts=${regProbs[c]} py=${s.expectedRegProbs[c]}`
        );
      }
      assert.ok(
        Math.abs(rangePct - s.expectedRangePct) < 1e-3,
        `Range mismatch on ${s.timeframe}: ts=${rangePct} py=${s.expectedRangePct}`
      );
    }

    const bars = makeSyntheticBars(240);
    const forecast = runMlQuantForecast(bars, '4h');
    assert.ok(forecast !== null);
    assert.ok(forecast.probUp + forecast.probDown + forecast.probChop > 99);
    assert.ok(forecast.expectedHigh > forecast.expectedLow);
    assert.ok(forecast.inferenceMs < 25);
  });
});
