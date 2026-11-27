import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import type { RawKline } from '../server/collectorUtils.ts';
import {
  analyzeChartWithOllama,
  buildMarketContextPrompt,
  chatWithLocalAi,
  computeTechnicalSummary,
  createThinkTagSplitter,
  extractPerfMetrics,
  fetchOllamaStatus,
  normalizeOllamaBaseUrl,
} from '../server/geminiAnalysisService.ts';
import type { FundingRatesResponse, TickerStats, VolumeDistributionResponse } from '../shared/types.ts';

function makeSyntheticCandles(count: number): RawKline[] {
  const out: RawKline[] = [];
  const start = 1700000000000;
  for (let i = 0; i < count; i++) {
    const base = 90000 + i * 25 + Math.sin(i * 0.35) * 600;
    const o = base - 50;
    const c = base + 60;
    const h = Math.max(o, c) + 180;
    const l = Math.min(o, c) - 160;
    out.push({
      t: start + i * 3600_000,
      o,
      h,
      l,
      c,
      vol: 120 + (i % 15) * 10,
    });
  }
  return out;
}

describe('geminiAnalysisService', () => {
  it('computes accurate indicators, ATR, and fractal swings on 250 candles', () => {
    const candles = makeSyntheticCandles(250);
    const summary = computeTechnicalSummary(candles);

    assert.equal(summary.candleCount, 250);
    assert.ok(summary.ema9 !== null && summary.ema21 !== null);
    assert.ok(summary.ma50 !== null && summary.ma100 !== null && summary.ma200 !== null);
    assert.ok(summary.ma50! > summary.ma200!, 'uptrend should have MA50 > MA200');
    assert.ok(summary.rsi14 !== null && summary.rsi14 > 0 && summary.rsi14 <= 100);
    assert.ok(summary.macdLine !== null && summary.macdSignal !== null && summary.macdHist !== null);
    assert.ok(summary.bbUpper !== null && summary.bbLower !== null && summary.bbUpper > summary.bbLower);
    assert.ok(summary.atr14 !== null && summary.atr14 > 0);
    assert.ok(summary.swingHighs.length > 0 && summary.swingLows.length > 0);
    assert.ok(summary.pocPrice !== null && summary.vahPrice !== null && summary.valPrice !== null);
    assert.ok(summary.vahPrice! >= summary.pocPrice! && summary.pocPrice! >= summary.valPrice!);
    assert.ok(['Bullish', 'Bearish', 'None'].includes(summary.rsiDivergence));
  });

  it('builds a full multi-factor prompt with indicators, walls, funding, and drawings', () => {
    const candles = makeSyntheticCandles(120);
    const ticker: TickerStats = {
      exchange: 'combined',
      symbol: 'BTCUSDT',
      lastPrice: 93000,
      markPrice: 93010,
      indexPrice: 92990,
      spotPrice: 92980,
      price24hPcnt: 2.35,
      highPrice24h: 93500,
      lowPrice24h: 90500,
      volume24h: 42000,
      turnover24h: 3.9e9,
      openInterestValue: 12.5e9,
      fundingRate: 0.01,
      bestBid: 92999,
      bestAsk: 93001,
      spread: 2,
      totalBidBtc: 1450,
      totalAskBtc: 1120,
      imbalancePct: 12.8,
      activeBidLevels: 5000,
      activeAskLevels: 4800,
      minBookPrice: 80000,
      maxBookPrice: 105000,
      connected: true,
      updateCount: 100,
      storedBaseSlices: 200,
      coverageItems: [],
    };
    const funding: FundingRatesResponse = {
      updatedAt: Date.now(),
      oiWeighted8hPct: 0.0105,
      oiWeightedAprPct: 11.5,
      maxSpread8hPct: 0.004,
      totalOpenInterestUsd: 12.5e9,
      exchanges: [],
    };
    const volDist: VolumeDistributionResponse = {
      updatedAt: Date.now(),
      totalSpotBtc: 25000,
      totalSpotUsd: 2.3e9,
      totalDerivBtc: 85000,
      totalDerivUsd: 7.9e9,
      totalBtc: 110000,
      totalUsd: 10.2e9,
      spotSharePct: 22.7,
      derivSharePct: 77.3,
      totalBuyBtc: 58000,
      totalSellBtc: 52000,
      buySharePct: 52.7,
      sellSharePct: 47.3,
      spotBuyBtc: 13000,
      spotSellBtc: 12000,
      spotBuyPct: 52,
      spotSellPct: 48,
      derivBuyBtc: 45000,
      derivSellBtc: 40000,
      derivBuyPct: 52.9,
      derivSellPct: 47.1,
      avgLongPct: 54.2,
      avgShortPct: 45.8,
      avgLongShortRatio: 1.18,
      exchanges: [],
    };

    const { prompt, topBidWall, topAskWall } = buildMarketContextPrompt({
      exchange: 'combined',
      timeframe: '1h',
      candles,
      ticker,
      bidClusters: [
        {
          price: 92000,
          sizeBtc: 245.5,
          distanceUsd: -1000,
          distancePct: -1.07,
          side: 'Bid',
          venues: ['BN-P', 'BYB-P'],
          breakdown: { 'BN-P': 150, 'BYB-P': 95.5 },
        },
      ],
      askClusters: [
        {
          price: 95000,
          sizeBtc: 310.2,
          distanceUsd: 2000,
          distancePct: 2.15,
          side: 'Ask',
          venues: ['CB-S'],
          breakdown: { 'CB-S': 310.2 },
        },
      ],
      fundingRates: funding,
      volumeDistribution: volDist,
      whaleTrades: [],
      recentLiquidations: [],
      userDrawings: [{ type: 'hline', points: [{ time: 1700000000000, price: 91500 }], text: 'Key Support' }],
      customPrompt: 'Look for breakout setups',
    });

    assert.equal(topBidWall?.price, 92000);
    assert.equal(topAskWall?.price, 95000);
    assert.ok(prompt.includes('$92000'));
    assert.ok(prompt.includes('$95000'));
    assert.ok(prompt.includes('Key Support'));
    assert.ok(prompt.includes('Look for breakout setups'));
    assert.ok(prompt.includes('OI-Weighted 8h Funding: 0.0105%'));
  });

  it('computes accurate tokens/sec metrics for both llama-server and Ollama timings', () => {
    const llamaPerf = extractPerfMetrics(
      {
        timings: {
          predicted_n: 120,
          predicted_per_second: 10.42,
          prompt_per_second: 22.8,
        },
      },
      14_200
    );
    assert.equal(llamaPerf.tokensPerSec, 10.4);
    assert.equal(llamaPerf.promptTokensPerSec, 22.8);
    assert.equal(llamaPerf.evalTokens, 120);

    const ollamaPerf = extractPerfMetrics(
      {
        eval_count: 150,
        eval_duration: 3_000_000_000,
        prompt_eval_count: 400,
        prompt_eval_duration: 2_000_000_000,
      },
      5_100
    );
    assert.equal(ollamaPerf.tokensPerSec, 50);
    assert.equal(ollamaPerf.promptTokensPerSec, 200);
    assert.equal(ollamaPerf.evalTokens, 150);
  });

  it('normalizes Ollama URLs and runs end-to-end model discovery + structured analysis + chat with tok/s', async () => {
    assert.equal(normalizeOllamaBaseUrl('http://127.0.0.1:11434///'), 'http://127.0.0.1:11434');
    assert.equal(normalizeOllamaBaseUrl('ftp://invalid'), 'http://127.0.0.1:11434');

    const mockOllama = http.createServer((req, res) => {
      if (req.url === '/api/tags' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              { name: 'qwen2.5:7b', size: 4_700_000_000, details: { parameter_size: '7B' } },
              { name: 'llama3.1:8b', size: 4_900_000_000, details: { parameter_size: '8B' } },
            ],
          })
        );
        return;
      }
      if (req.url === '/api/chat' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            model: string;
            format?: Record<string, unknown>;
          };
          assert.equal(payload.model, 'qwen2.5:7b');
          if (payload.format) {
            assert.equal(payload.format.type, 'object');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              eval_count: 180,
              eval_duration: 12_000_000_000,
              message: {
                role: 'assistant',
                content: payload.format
                  ? `<think>checking MA50/MA200 trend</think>${JSON.stringify({
                  marketBias: 'Bullish',
                  confidence: 74,
                  marketRegime: 'Uptrend Continuation',
                  summary: 'Price holds above MA50 and bid walls support pullbacks.',
                  keyLevels: [
                    { price: 92000, type: 'Liquidity Wall', strength: 'Strong', reason: '245 BTC bid wall' },
                    { price: 95000, type: 'Resistance', strength: 'Strong', reason: '310 BTC ask wall' },
                  ],
                  patterns: [
                    {
                      name: 'Bull Flag',
                      bias: 'Bullish',
                      status: 'Forming',
                      confidence: 72,
                      timeframe: '1h',
                      targetPrice: 96000,
                      invalidationPrice: 91800,
                      description: 'Tight consolidation above rising EMA21.',
                    },
                  ],
                  tradeIdeas: [
                    {
                      title: 'Pullback Long at Bid Wall',
                      direction: 'Long',
                      setupType: 'Orderbook Support Bounce',
                      entryLow: 92100,
                      entryHigh: 92400,
                      entryPrice: 92250,
                      stopLoss: 91600,
                      takeProfits: [94000, 95000],
                      riskReward: '1:2.7',
                      confidence: 75,
                      rationale: 'Confluence of EMA21 and 245 BTC resting bid wall.',
                      invalidation: '1h close below $91,600.',
                    },
                  ],
                  confluence: {
                    technical: ['MA50 > MA200 bullish alignment'],
                    orderbook: ['Strong resting bid wall at $92,000'],
                    derivatives: ['Healthy funding at +0.01%'],
                  },
                  riskWarning: 'Not financial advice.',
                })}`
                  : 'BTC trend is bullish above $92,000 support.',
              },
            })
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockOllama.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockOllama.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const status = await fetchOllamaStatus(baseUrl);
      assert.equal(status.reachable, true);
      assert.equal(status.models.length, 2);
      assert.equal(status.defaultModel, 'qwen2.5:7b');

      const candles = makeSyntheticCandles(80);
      const ticker: TickerStats = {
        exchange: 'combined',
        symbol: 'BTCUSDT',
        lastPrice: 93000,
        markPrice: 93000,
        indexPrice: 93000,
        price24hPcnt: 1.5,
        highPrice24h: 93500,
        lowPrice24h: 91000,
        volume24h: 25000,
        turnover24h: 2.3e9,
        openInterestValue: 10e9,
        fundingRate: 0.01,
        bestBid: 92999,
        bestAsk: 93001,
        spread: 2,
        totalBidBtc: 1200,
        totalAskBtc: 1000,
        imbalancePct: 9.1,
        activeBidLevels: 2000,
        activeAskLevels: 2000,
        minBookPrice: 80000,
        maxBookPrice: 105000,
        connected: true,
        updateCount: 50,
        storedBaseSlices: 100,
        coverageItems: [],
      };
      const funding: FundingRatesResponse = {
        updatedAt: Date.now(),
        oiWeighted8hPct: 0.01,
        oiWeightedAprPct: 10.95,
        maxSpread8hPct: 0.002,
        totalOpenInterestUsd: 10e9,
        exchanges: [],
      };
      const volDist: VolumeDistributionResponse = {
        updatedAt: Date.now(),
        totalSpotBtc: 10000,
        totalSpotUsd: 9e8,
        totalDerivBtc: 40000,
        totalDerivUsd: 3.7e9,
        totalBtc: 50000,
        totalUsd: 4.6e9,
        spotSharePct: 20,
        derivSharePct: 80,
        totalBuyBtc: 26000,
        totalSellBtc: 24000,
        buySharePct: 52,
        sellSharePct: 48,
        spotBuyBtc: 5200,
        spotSellBtc: 4800,
        spotBuyPct: 52,
        spotSellPct: 48,
        derivBuyBtc: 20800,
        derivSellBtc: 19200,
        derivBuyPct: 52,
        derivSellPct: 48,
        avgLongPct: 53,
        avgShortPct: 47,
        avgLongShortRatio: 1.13,
        exchanges: [],
      };

      const analysis = await analyzeChartWithOllama(baseUrl, 'qwen2.5:7b', {
        exchange: 'combined',
        timeframe: '1h',
        candles,
        ticker,
        bidClusters: [],
        askClusters: [],
        fundingRates: funding,
        volumeDistribution: volDist,
        whaleTrades: [],
        recentLiquidations: [],
      });

      assert.equal(analysis.model, 'qwen2.5:7b');
      assert.equal(analysis.marketBias, 'Bullish');
      assert.equal(analysis.tradeIdeas.length, 1);
      assert.equal(analysis.patterns[0].name, 'Bull Flag');
      assert.equal(analysis.keyLevels.length, 2);
      assert.equal(analysis.perf?.tokensPerSec, 15);

      const chatRes = await chatWithLocalAi(baseUrl, 'qwen2.5:7b', [
        { role: 'user', content: 'Trend?' },
      ]);
      assert.equal(chatRes.reply, 'BTC trend is bullish above $92,000 support.');
      assert.equal(chatRes.perf?.tokensPerSec, 15);
    } finally {
      mockOllama.close();
    }
  });

  it('splits inline <think> tags cleanly across partial streaming chunk boundaries', () => {
    let thinking = '';
    let content = '';
    const splitter = createThinkTagSplitter(
      (d) => (thinking += d),
      (d) => (content += d)
    );
    for (const part of ['<thi', 'nk>step 1 ', 'and step 2</th', 'ink>Final ', 'answer!']) {
      splitter.push(part);
    }
    splitter.flush();
    assert.equal(thinking, 'step 1 and step 2');
    assert.equal(content, 'Final answer!');
  });

  it('streams real-time reasoning_content, content, phases, and tok/s from OpenAI-compatible llama-server', async () => {
    const mockLlama = http.createServer((req, res) => {
      if (req.url === '/api/chat') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frames = [
          { choices: [{ delta: { reasoning_content: 'Checking RSI ' } }] },
          { choices: [{ delta: { reasoning_content: 'and walls.' } }] },
          { choices: [{ delta: { content: 'BTC looks ' } }] },
          {
            choices: [{ delta: { content: 'bullish.' }, finish_reason: 'stop' }],
            timings: { predicted_n: 48, predicted_per_second: 11.4, prompt_per_second: 22.1 },
          },
        ];
        for (const f of frames) {
          res.write(`data: ${JSON.stringify(f)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockLlama.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockLlama.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const phases: string[] = [];
      const thinkingDeltas: string[] = [];
      const contentDeltas: string[] = [];

      const res = await chatWithLocalAi(
        baseUrl,
        'inkling-2-mini-hybrid',
        [{ role: 'user', content: 'Outlook?' }],
        undefined,
        {
          onPhase: (p) => phases.push(p),
          onThinking: (d) => thinkingDeltas.push(d),
          onContent: (d) => contentDeltas.push(d),
        }
      );

      assert.deepEqual(phases, ['thinking', 'generating']);
      assert.equal(thinkingDeltas.join(''), 'Checking RSI and walls.');
      assert.equal(contentDeltas.join(''), 'BTC looks bullish.');
      assert.equal(res.thinking, 'Checking RSI and walls.');
      assert.equal(res.reply, 'BTC looks bullish.');
      assert.equal(res.perf?.tokensPerSec, 11.4);
      assert.equal(res.perf?.promptTokensPerSec, 22.1);
    } finally {
      mockLlama.close();
    }
  });
});
