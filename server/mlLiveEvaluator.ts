import fs from 'node:fs';
import path from 'node:path';
import type { MlLiveEvalStats, MlQuantForecast } from '../shared/types.ts';
import type { RawKline } from './collectorUtils.ts';

export interface MlLiveLogEntry {
  id: string; // `${tf}:${barTime}`
  timeframe: '1h' | '4h' | '1d';
  barTime: number;
  loggedAt: number;
  entryPrice: number;
  atr14: number;
  horizonBars: number;
  barrierAtrMult: number;
  directionalBias: 'Bullish' | 'Bearish' | 'Neutral';
  conviction: 'High' | 'Moderate' | 'Low';
  probUp: number;
  probDown: number;
  probChop: number;
  expectedLow: number;
  expectedHigh: number;
  // Graded fields once horizon elapses
  gradedAt?: number;
  actualOutcome?: 'Up' | 'Down' | 'Chop';
  directionCorrect?: boolean | null; // null if Neutral or unresolved Chop
  rangeHit?: boolean;
  actualHigh?: number;
  actualLow?: number;
  actualClose?: number;
}

const TF_MS: Record<'1h' | '4h' | '1d', number> = {
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

const MAX_RECORDS = 1500;

function calcAtr14(candles: RawKline[]): number {
  const n = candles.length;
  if (n < 2) return 0;
  const start = Math.max(1, n - 14);
  let sum = 0;
  let cnt = 0;
  for (let i = start; i < n; i++) {
    const c = candles[i];
    const pc = candles[i - 1].c;
    sum += Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    cnt++;
  }
  return cnt > 0 ? sum / cnt : Math.max(1, candles[n - 1].h - candles[n - 1].l);
}

/**
 * Self-grading live forecast store (`server/data/ml-live-eval.jsonl`).
 * Records one snapshot per (timeframe, barTime) and automatically grades resolved predictions
 * after `horizonBars` using the exact same ±1.8x ATR triple-barrier and range-envelope rules.
 */
export class MlLiveEvaluator {
  private readonly filePath: string;
  private entries = new Map<string, MlLiveLogEntry>();
  private dirty = false;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'ml-live-eval.jsonl');
    this.load();
  }

  private load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const lines = fs.readFileSync(this.filePath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const item = JSON.parse(trimmed) as MlLiveLogEntry;
          if (item && item.id) this.entries.set(item.id, item);
        } catch {
          // ignore malformed line
        }
      }
    } catch {
      // ignore read failure
    }
  }

  private flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const ordered = Array.from(this.entries.values())
        .sort((a, b) => a.barTime - b.barTime)
        .slice(-MAX_RECORDS);
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, ordered.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch {
      // ignore transient write error
    }
  }

  /**
   * Logs the current bar's forecast (deduplicated per timeframe + closed/current bar timestamp)
   * AND grades any previously logged predictions whose forward horizon has elapsed.
   */
  recordAndGrade(candles: RawKline[], forecast: MlQuantForecast): MlLiveEvalStats {
    if (candles.length >= 20) {
      const tf = forecast.modelTimeframe;
      const lastBar = candles[candles.length - 1];
      const id = `${tf}:${lastBar.t}`;
      if (!this.entries.has(id)) {
        const atr = calcAtr14(candles);
        this.entries.set(id, {
          id,
          timeframe: tf,
          barTime: lastBar.t,
          loggedAt: Date.now(),
          entryPrice: lastBar.c,
          atr14: +atr.toFixed(2),
          horizonBars: forecast.horizonBars,
          barrierAtrMult: forecast.barrierAtrMult,
          directionalBias: forecast.directionalBias,
          conviction: forecast.conviction,
          probUp: forecast.probUp,
          probDown: forecast.probDown,
          probChop: forecast.probChop,
          expectedLow: forecast.expectedLow,
          expectedHigh: forecast.expectedHigh,
        });
        this.dirty = true;
      }

      // Grade any ungraded entries for this timeframe whose horizon window is now present in `candles`
      const tfMs = TF_MS[tf];
      const newestT = lastBar.t;
      for (const entry of this.entries.values()) {
        if (entry.timeframe !== tf || entry.gradedAt !== undefined) continue;
        const targetEndT = entry.barTime + entry.horizonBars * tfMs;
        if (newestT < targetEndT) continue;

        const fwdBars = candles.filter((c) => c.t > entry.barTime && c.t <= targetEndT);
        if (fwdBars.length < Math.max(3, Math.floor(entry.horizonBars * 0.7))) continue;

        const upBarrier = entry.entryPrice + entry.atr14 * entry.barrierAtrMult;
        const dnBarrier = entry.entryPrice - entry.atr14 * entry.barrierAtrMult;
        let outcome: 'Up' | 'Down' | 'Chop' = 'Chop';
        let fwdHigh = entry.entryPrice;
        let fwdLow = entry.entryPrice;
        let resolved = false;

        for (const fb of fwdBars) {
          if (fb.h > fwdHigh) fwdHigh = fb.h;
          if (fb.l < fwdLow) fwdLow = fb.l;
          if (!resolved) {
            const hitUp = fb.h >= upBarrier;
            const hitDn = fb.l <= dnBarrier;
            if (hitUp && !hitDn) {
              outcome = 'Up';
              resolved = true;
            } else if (hitDn && !hitUp) {
              outcome = 'Down';
              resolved = true;
            } else if (hitUp && hitDn) {
              outcome = fb.c >= entry.entryPrice ? 'Up' : 'Down';
              resolved = true;
            }
          }
        }

        const actualClose = fwdBars[fwdBars.length - 1].c;
        const rangeHit = actualClose >= entry.expectedLow && actualClose <= entry.expectedHigh;
        let directionCorrect: boolean | null = null;
        if (entry.directionalBias !== 'Neutral' && outcome !== 'Chop') {
          directionCorrect =
            (entry.directionalBias === 'Bullish' && outcome === 'Up') ||
            (entry.directionalBias === 'Bearish' && outcome === 'Down');
        }

        entry.gradedAt = Date.now();
        entry.actualOutcome = outcome;
        entry.directionCorrect = directionCorrect;
        entry.rangeHit = rangeHit;
        entry.actualHigh = +fwdHigh.toFixed(1);
        entry.actualLow = +fwdLow.toFixed(1);
        entry.actualClose = +actualClose.toFixed(1);
        this.dirty = true;
      }

      this.flush();
    }

    return this.getStats(forecast.modelTimeframe);
  }

  getStats(timeframe?: '1h' | '4h' | '1d'): MlLiveEvalStats {
    let pending = 0;
    let graded = 0;
    let directionalGraded = 0;
    let directionalWins = 0;
    let rangeHits = 0;

    for (const e of this.entries.values()) {
      if (timeframe && e.timeframe !== timeframe) continue;
      if (e.gradedAt === undefined) {
        pending++;
      } else {
        graded++;
        if (e.rangeHit) rangeHits++;
        if (e.directionCorrect !== null && e.directionCorrect !== undefined) {
          directionalGraded++;
          if (e.directionCorrect) directionalWins++;
        }
      }
    }

    return {
      timeframe: timeframe ?? 'all',
      pendingCount: pending,
      gradedCount: graded,
      directionalGraded,
      directionalWinRatePct:
        directionalGraded > 0 ? +((directionalWins / directionalGraded) * 100).toFixed(1) : null,
      rangeHitRatePct: graded > 0 ? +((rangeHits / graded) * 100).toFixed(1) : null,
    };
  }
}
