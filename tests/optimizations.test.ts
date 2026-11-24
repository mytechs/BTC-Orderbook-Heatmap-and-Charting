import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calcBollinger } from '../client/src/chartIndicators.ts';
import { type AggregatedClusterResult, reBucketAggregatedResult } from '../server/collectorUtils.ts';
import type { VenueBreakdown } from '../shared/types.ts';

describe('optimizations', () => {
  it('reBucketAggregatedResult fast-path (includeClusters=false) matches full path totals exactly', () => {
    const bidBreakdowns = new Map<number, VenueBreakdown>([
      [59991, { LIN: 3.5, SPOT: 1.5 }],
      [59995, { LIN: 2.0 }],
      [59988, { INV: 12.0 }],
    ]);
    const askBreakdowns = new Map<number, VenueBreakdown>([
      [60002, { LIN: 4.0 }],
      [60008, { SPOT: 6.5 }],
      [60012, { LIN: 30.0 }],
    ]);
    const base: AggregatedClusterResult = {
      bids: [
        [59995, 2],
        [59991, 5],
        [59988, 12],
      ],
      asks: [
        [60002, 4],
        [60008, 6.5],
        [60012, 30],
      ],
      bidBreakdowns,
      askBreakdowns,
      bidClusters: [],
      askClusters: [],
      clusterSummary: [],
      totalBidBtc: 19,
      totalAskBtc: 40.5,
      activeBidLevels: 3,
      activeAskLevels: 3,
      minBookPrice: 59988,
      maxBookPrice: 60012,
    };

    const full = reBucketAggregatedResult(base, 10, true, 60000, ['LIN', 'SPOT', 'INV']);
    const lite = reBucketAggregatedResult(base, 10, false, 60000, ['LIN', 'SPOT', 'INV']);

    assert.deepEqual(lite.bids, full.bids);
    assert.deepEqual(lite.asks, full.asks);
    assert.equal(lite.bidClusters.length, 0);
    assert.equal(lite.askClusters.length, 0);
  });

  it('O(N) sliding-window calcBollinger matches exact reference mean and stddev', () => {
    const vals = [100, 102, 101, 105, 110, 108, 107, 115, 120, 118, 118, 118, 118, 118];
    const period = 5;
    const mult = 2;
    const bb = calcBollinger(vals, period, mult);

    for (let i = 0; i < period - 1; i++) {
      assert.equal(bb.middle[i], null);
      assert.equal(bb.upper[i], null);
      assert.equal(bb.lower[i], null);
    }

    for (let i = period - 1; i < vals.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += vals[j];
      const mean = sum / period;
      let sq = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const d = vals[j] - mean;
        sq += d * d;
      }
      const std = Math.sqrt(sq / period);
      assert.ok(Math.abs((bb.middle[i] as number) - mean) < 1e-6);
      assert.ok(Math.abs((bb.upper[i] as number) - (mean + mult * std)) < 1e-6);
      assert.ok(Math.abs((bb.lower[i] as number) - (mean - mult * std)) < 1e-6);
    }
  });
});
