import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AggregatedClusterResult,
  appendLiquidationBuffer,
  appendTradeBuffers,
  buildClusterMetrics,
  buildKlineHeatmapSlices,
  groupTickSlices,
  reBucketAggregatedResult,
} from '../server/collectorUtils.ts';
import type { HeatmapSlice, LiquidationEvent, TradeEvent, VenueBreakdown } from '../shared/types.ts';

describe('collectorUtils', () => {
  it('reBucketAggregatedResult groups $1 breakdowns into $10 buckets accurately', () => {
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

    const grouped = reBucketAggregatedResult(base, 10, true, 60000, ['LIN', 'SPOT', 'INV']);
    assert.deepEqual(grouped.bids, [
      [59990, 7],
      [59980, 12],
    ]);
    assert.deepEqual(grouped.asks, [
      [60000, 10.5],
      [60010, 30],
    ]);
    assert.equal(grouped.bidClusters.length, 2);
    assert.equal(grouped.askClusters.length, 2);
    assert.equal(grouped.askClusters[0].price, 60010);
    assert.equal(grouped.askClusters[0].sizeBtc, 30);
    assert.deepEqual(grouped.askClusters[1].venues, ['LIN', 'SPOT']);
  });

  it('appendTradeBuffers keeps perp trades in recentTrades and >=0.5 BTC in whaleTrades', () => {
    const recent: TradeEvent[] = [];
    const whales: TradeEvent[] = [];

    appendTradeBuffers(recent, whales, {
      id: '1',
      t: 1000,
      p: 60000,
      v: 0.1,
      s: 'Buy',
      exchange: 'BYB',
      market: 'PERP',
    });
    appendTradeBuffers(recent, whales, {
      id: '2',
      t: 1001,
      p: 60001,
      v: 2.5,
      s: 'Sell',
      exchange: 'BN',
      market: 'PERP',
    });
    appendTradeBuffers(recent, whales, {
      id: '3',
      t: 1002,
      p: 60002,
      v: 0.05,
      s: 'Buy',
      exchange: 'BN',
      market: 'SPOT',
    });
    appendTradeBuffers(recent, whales, {
      id: '4',
      t: 1003,
      p: 60003,
      v: 4.0,
      s: 'Buy',
      exchange: 'BYB',
      market: 'SPOT',
    });

    assert.equal(recent.length, 2); // Only perp trades in main recentTrades tape
    assert.equal(whales.length, 2); // Both perp whale and spot whale >= 0.5 BTC captured
    assert.equal(whales[0].id, '4');
    assert.equal(whales[1].id, '2');
  });

  it('appendLiquidationBuffer prepends newest liquidation and caps length', () => {
    const liqs: LiquidationEvent[] = [];
    for (let i = 0; i < 110; i++) {
      appendLiquidationBuffer(liqs, {
        id: `liq-${i}`,
        t: 1000 + i,
        p: 60000,
        v: 1,
        usd: 60000,
        side: i % 2 === 0 ? 'Long' : 'Short',
        exchange: 'BN',
      });
    }
    assert.equal(liqs.length, 100);
    assert.equal(liqs[0].id, 'liq-109');
  });

  it('groupTickSlices aggregates OHLC, perp+spot volume, and liquidations', () => {
    const liq: LiquidationEvent = {
      id: 'lq-1',
      t: 1500,
      p: 59990,
      v: 2,
      usd: 119980,
      side: 'Long',
      exchange: 'BYB',
    };
    const baseSlices: HeatmapSlice[] = [
      {
        t: 1000,
        bb: 59999,
        ba: 60001,
        mid: 60000,
        o: 60000,
        h: 60010,
        l: 59995,
        c: 60005,
        bv: 3,
        sv: 1,
        spotBv: 2,
        spotSv: 0.5,
        bids: [[59990, 10]],
        asks: [[60010, 8]],
        trades: [],
      },
      {
        t: 1500,
        bb: 59994,
        ba: 59996,
        mid: 59995,
        o: 60005,
        h: 60005,
        l: 59985,
        c: 59990,
        bv: 1,
        sv: 4,
        spotBv: 0.5,
        spotSv: 3,
        bids: [[59980, 15]],
        asks: [[60000, 12]],
        trades: [],
        liquidations: [liq],
      },
    ];

    const grouped = groupTickSlices(baseSlices, 1000, 10, true, [], [], 100);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].o, 60000);
    assert.equal(grouped[0].h, 60010);
    assert.equal(grouped[0].l, 59985);
    assert.equal(grouped[0].c, 59990);
    assert.equal(grouped[0].bv, 4);
    assert.equal(grouped[0].sv, 5);
    assert.equal(grouped[0].spotBv, 2.5);
    assert.equal(grouped[0].spotSv, 3.5);
    assert.equal(grouped[0].liquidations?.length, 1);
  });

  it('buildClusterMetrics classifies BTC cluster tiers accurately', () => {
    const bids: [number, number][] = [
      [59990, 2.5],
      [59950, 15],
      [59900, 120],
    ];
    const asks: [number, number][] = [[60050, 35]];
    const bidMap = new Map<number, VenueBreakdown>([
      [59990, { LIN: 2.5 }],
      [59950, { LIN: 15 }],
      [59900, { LIN: 120 }],
    ]);
    const askMap = new Map<number, VenueBreakdown>([[60050, { SPOT: 35 }]]);

    const res = buildClusterMetrics(bids, asks, bidMap, askMap, 60000, ['LIN', 'SPOT']);
    const tier1 = res.clusterSummary.find((t) => t.minBtc === 1);
    const tier10 = res.clusterSummary.find((t) => t.minBtc === 10);
    const tier25 = res.clusterSummary.find((t) => t.minBtc === 25);
    const tier100 = res.clusterSummary.find((t) => t.minBtc === 100);

    assert.equal(tier1?.bidCount, 1);
    assert.equal(tier10?.bidCount, 1);
    assert.equal(tier25?.askCount, 1);
    assert.equal(tier100?.bidCount, 1);
    assert.equal(res.bidClusters[0].sizeBtc, 120);
  });

  it('buildKlineHeatmapSlices caps levels per historical candle', () => {
    const klines = Array.from({ length: 10 }, (_, idx) => ({
      t: 1_700_000_000_000 + idx * 60_000,
      o: 60000 + idx * 10,
      h: 60020 + idx * 10,
      l: 59980 + idx * 10,
      c: 60010 + idx * 10,
      vol: 25,
    }));
    const currentBids: [number, number][] = Array.from({ length: 400 }, (_, i) => [
      60000 - i * 10,
      5,
    ]);
    const currentAsks: [number, number][] = Array.from({ length: 400 }, (_, i) => [
      60010 + i * 10,
      5,
    ]);

    const slices = buildKlineHeatmapSlices(
      klines,
      60_000,
      10,
      true,
      [],
      60100,
      1,
      currentBids,
      currentAsks
    );
    assert.equal(slices.length, 10);
    for (const s of slices) {
      assert.ok(s.bids.length <= 180);
      assert.ok(s.asks.length <= 180);
    }
  });
});
