import fs from 'node:fs';
import path from 'node:path';
import type { RawKline } from '../server/collectorUtils.ts';
import {
  buildMarketContextPrompt,
  computeTechnicalSummary,
} from '../server/geminiAnalysisService.ts';
import type {
  FundingRatesResponse,
  TickerStats,
  TimeframeId,
  VolumeDistributionResponse,
  WallLevel,
} from '../shared/types.ts';
import { getGoldMlSynthesisDataset } from './gold_ml_synthesis.ts';
import { getGoldSwingDataset } from './gold_swing_curated.ts';

interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DatasetRow {
  messages: ChatTurn[];
  meta?: { kind: string; tf: string; bias?: string };
}

const OUT_DIR = path.resolve('training/data');
const FEEDBACK_LOG = path.resolve('server/data/ai-training-log.jsonl');

const REPORT_SYSTEM_PROMPT =
  'You are a senior quantitative Bitcoin technical analyst and orderflow strategist. Keep internal reasoning brief and focused (under 250 words), then immediately return ONLY valid JSON matching the exact schema—no prose outside JSON.';

async function fetchBinanceKlines(interval: string, totalBars: number): Promise<RawKline[]> {
  const out: RawKline[] = [];
  let endTime: number | undefined;
  while (out.length < totalBars) {
    const limit = Math.min(1000, totalBars - out.length);
    const url = new URL('https://fapi.binance.com/fapi/v1/klines');
    url.searchParams.set('symbol', 'BTCUSDT');
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(limit));
    if (endTime !== undefined) url.searchParams.set('endTime', String(endTime));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Binance klines ${interval} failed (${res.status})`);
    const rows = (await res.json()) as [number, string, string, string, string, string][];
    if (!Array.isArray(rows) || rows.length === 0) break;
    const mapped: RawKline[] = rows.map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      vol: Number(r[5]),
    }));
    out.unshift(...mapped);
    endTime = mapped[0].t - 1;
    if (rows.length < limit) break;
  }
  return out.slice(-totalBars);
}

function deterministicHash(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function makeSyntheticOrderflow(
  price: number,
  atr: number,
  swingLows: { price: number }[],
  swingHighs: { price: number }[],
  futureMovePct: number,
  seed: number
): {
  ticker: TickerStats;
  bidClusters: WallLevel[];
  askClusters: WallLevel[];
  fundingRates: FundingRatesResponse;
  volumeDistribution: VolumeDistributionResponse;
} {
  const r1 = deterministicHash(seed);
  const r2 = deterministicHash(seed + 17);
  const r3 = deterministicHash(seed + 41);

  const bidBase = swingLows.length > 0 ? swingLows[swingLows.length - 1].price : price - atr * 1.4;
  const askBase = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1].price : price + atr * 1.4;

  const bidWall1 = Math.round(Math.min(price - atr * 0.4, bidBase) / 10) * 10;
  const bidWall2 = Math.round((bidWall1 - atr * 1.2) / 10) * 10;
  const bidWall3 = Math.round((bidWall2 - atr * 1.5) / 10) * 10;

  const askWall1 = Math.round(Math.max(price + atr * 0.4, askBase) / 10) * 10;
  const askWall2 = Math.round((askWall1 + atr * 1.2) / 10) * 10;
  const askWall3 = Math.round((askWall2 + atr * 1.5) / 10) * 10;

  // Correlate orderbook/funding slightly with regime so the model learns realistic orderflow confluence
  const bullTilt = futureMovePct > 0.35 ? 1 : futureMovePct < -0.35 ? -1 : 0;
  const bidSize1 = +(120 + r1 * 180 + (bullTilt > 0 ? 90 : 0)).toFixed(1);
  const askSize1 = +(120 + r2 * 180 + (bullTilt < 0 ? 90 : 0)).toFixed(1);
  const totalBidBtc = +(950 + r1 * 550 + bullTilt * 180).toFixed(1);
  const totalAskBtc = +(950 + r2 * 550 - bullTilt * 180).toFixed(1);
  const imbalancePct = +(((totalBidBtc - totalAskBtc) / (totalBidBtc + totalAskBtc)) * 100).toFixed(1);

  const funding8h = +(0.004 + (r3 - 0.38) * 0.02 + bullTilt * 0.002).toFixed(4);
  const fundingApr = +(funding8h * 3 * 365).toFixed(2);
  const buyPct = +(50 + bullTilt * 4.2 + (r1 - 0.5) * 6).toFixed(1);
  const sellPct = +(100 - buyPct).toFixed(1);
  const lsRatio = +(1 + (r2 - 0.45) * 0.45).toFixed(2);
  const longPct = +((lsRatio / (1 + lsRatio)) * 100).toFixed(1);

  const mkWall = (p: number, sz: number, side: 'Bid' | 'Ask'): WallLevel => ({
    price: p,
    sizeBtc: sz,
    distanceUsd: +(p - price).toFixed(1),
    distancePct: +(((p - price) / price) * 100).toFixed(2),
    side,
    venues: ['BN-P', 'BYB-P'],
    breakdown: { 'BN-P': +(sz * 0.6).toFixed(1), 'BYB-P': +(sz * 0.4).toFixed(1) },
  });

  const bidClusters = [
    mkWall(bidWall1, bidSize1, 'Bid'),
    mkWall(bidWall2, +(bidSize1 * 0.72).toFixed(1), 'Bid'),
    mkWall(bidWall3, +(bidSize1 * 0.58).toFixed(1), 'Bid'),
  ];
  const askClusters = [
    mkWall(askWall1, askSize1, 'Ask'),
    mkWall(askWall2, +(askSize1 * 0.74).toFixed(1), 'Ask'),
    mkWall(askWall3, +(askSize1 * 0.55).toFixed(1), 'Ask'),
  ];

  const ticker: TickerStats = {
    exchange: 'combined',
    symbol: 'BTCUSDT',
    lastPrice: +price.toFixed(1),
    markPrice: +price.toFixed(1),
    indexPrice: +(price - 2).toFixed(1),
    spotPrice: +(price - 5).toFixed(1),
    price24hPcnt: +((r1 - 0.48) * 5.2 + bullTilt * 1.1).toFixed(2),
    highPrice24h: +(price + atr * 3.4).toFixed(1),
    lowPrice24h: +(price - atr * 3.2).toFixed(1),
    volume24h: +(24000 + r2 * 22000).toFixed(0),
    turnover24h: +(price * (24000 + r2 * 22000)),
    openInterestValue: +(9.5e9 + r3 * 4.5e9),
    fundingRate: funding8h,
    bestBid: +(price - 0.5).toFixed(1),
    bestAsk: +(price + 0.5).toFixed(1),
    spread: 1,
    totalBidBtc,
    totalAskBtc,
    imbalancePct,
    activeBidLevels: 4200,
    activeAskLevels: 4100,
    minBookPrice: price - 10000,
    maxBookPrice: price + 10000,
    connected: true,
    updateCount: 500,
    storedBaseSlices: 300,
    coverageItems: [],
  };

  const fundingRates: FundingRatesResponse = {
    updatedAt: Date.now(),
    oiWeighted8hPct: funding8h,
    oiWeightedAprPct: fundingApr,
    maxSpread8hPct: 0.003,
    totalOpenInterestUsd: ticker.openInterestValue,
    exchanges: [
      {
        exchange: 'binance',
        code: 'BN',
        label: 'Binance',
        supported: true,
        intervalHours: 8,
        fundingRatePct: funding8h,
        normalized8hPct: funding8h,
        annualizedAprPct: fundingApr,
        openInterestUsd: ticker.openInterestValue * 0.45,
        markPrice: price,
        indexPrice: price - 2,
        basisBps: 2.1,
        nextFundingTime: Date.now() + 3600_000,
      },
      {
        exchange: 'bybit',
        code: 'BYB',
        label: 'Bybit',
        supported: true,
        intervalHours: 8,
        fundingRatePct: +(funding8h + 0.0005).toFixed(4),
        normalized8hPct: +(funding8h + 0.0005).toFixed(4),
        annualizedAprPct: fundingApr,
        openInterestUsd: ticker.openInterestValue * 0.3,
        markPrice: price,
        indexPrice: price - 2,
        basisBps: 2.4,
        nextFundingTime: Date.now() + 3600_000,
      },
    ],
  };

  const volumeDistribution: VolumeDistributionResponse = {
    updatedAt: Date.now(),
    totalSpotBtc: 22000,
    totalSpotUsd: 22000 * price,
    totalDerivBtc: 78000,
    totalDerivUsd: 78000 * price,
    totalBtc: 100000,
    totalUsd: 100000 * price,
    spotSharePct: 22,
    derivSharePct: 78,
    totalBuyBtc: buyPct * 1000,
    totalSellBtc: sellPct * 1000,
    buySharePct: buyPct,
    sellSharePct: sellPct,
    spotBuyBtc: buyPct * 220,
    spotSellBtc: sellPct * 220,
    spotBuyPct: buyPct,
    spotSellPct: sellPct,
    derivBuyBtc: buyPct * 780,
    derivSellBtc: sellPct * 780,
    derivBuyPct: buyPct,
    derivSellPct: sellPct,
    avgLongPct: longPct,
    avgShortPct: +(100 - longPct).toFixed(1),
    avgLongShortRatio: lsRatio,
    exchanges: [],
  };

  return { ticker, bidClusters, askClusters, fundingRates, volumeDistribution };
}

function buildOutcomeGroundedTarget(opts: {
  timeframe: TimeframeId;
  candles: RawKline[];
  futureCandles: RawKline[];
  higherTf4h?: RawKline[];
  higherTf1d?: RawKline[];
  seed: number;
}): { prompt: string; thinking: string; reportJson: Record<string, unknown>; bias: string } {
  const { timeframe, candles, futureCandles, higherTf4h, higherTf1d, seed } = opts;
  const tech = computeTechnicalSummary(candles);
  const price = tech.lastClose;
  const atr = Math.max(price * 0.003, tech.atr14 || price * 0.005);

  // Measure real forward outcome over next 12 bars
  const fwdEnd = futureCandles[futureCandles.length - 1]?.c ?? price;
  let fwdMax = price;
  let fwdMin = price;
  for (const fk of futureCandles) {
    if (fk.h > fwdMax) fwdMax = fk.h;
    if (fk.l < fwdMin) fwdMin = fk.l;
  }
  const fwdMovePct = ((fwdEnd - price) / price) * 100;
  const upExcursion = fwdMax - price;
  const dnExcursion = price - fwdMin;

  const { ticker, bidClusters, askClusters, fundingRates, volumeDistribution } =
    makeSyntheticOrderflow(price, atr, tech.swingLows, tech.swingHighs, fwdMovePct, seed);

  const { prompt, topBidWall, topAskWall, htfAlignment } = buildMarketContextPrompt(
    {
      exchange: 'combined',
      timeframe,
      candles,
      higherTf4h,
      higherTf1d,
      ticker,
      bidClusters,
      askClusters,
      fundingRates,
      volumeDistribution,
      whaleTrades: [],
      recentLiquidations: [],
      includeOrderbookAndDerivs: true,
    },
    20
  );

  // Determine grounded market bias combining current technical structure + realized forward outcome
  let trendScore = 0;
  if (tech.ema21 !== null) trendScore += price > tech.ema21 ? 1 : -1;
  if (tech.ma50 !== null) trendScore += price > tech.ma50 ? 1 : -1;
  if (tech.macdHist !== null) trendScore += tech.macdHist > 0 ? 1 : -1;
  if (tech.rsi14 !== null) trendScore += tech.rsi14 > 54 ? 1 : tech.rsi14 < 46 ? -1 : 0;
  if (fwdMovePct > 0.45) trendScore += 2;
  else if (fwdMovePct < -0.45) trendScore -= 2;

  const bbSqueeze = (tech.bbWidthPct ?? 2.5) < 1.35;
  const marketBias: 'Bullish' | 'Bearish' | 'Neutral' | 'Range-Bound' =
    bbSqueeze && Math.abs(fwdMovePct) < 0.65
      ? 'Range-Bound'
      : trendScore >= 2
        ? 'Bullish'
        : trendScore <= -2
          ? 'Bearish'
          : Math.abs(upExcursion - dnExcursion) < atr * 0.5
            ? 'Range-Bound'
            : 'Neutral';

  const marketRegime =
    marketBias === 'Bullish'
      ? tech.vaPosition === 'Above VA'
        ? 'Bullish Breakout Above Value Area'
        : 'Uptrend Continuation'
      : marketBias === 'Bearish'
        ? tech.vaPosition === 'Below VA'
          ? 'Bearish Breakdown Below Value Area'
          : 'Downtrend Continuation'
        : bbSqueeze
          ? 'Bollinger Compression / Coiling Range'
          : 'Mean-Reverting Balance';

  const confidence = Math.min(
    84,
    Math.max(54, 58 + Math.abs(trendScore) * 4 + (tech.rsiDivergence !== 'None' ? 4 : 0))
  );

  const support1 = +(topBidWall?.price ?? Math.round(price - atr * 1.1)).toFixed(1);
  const support2 = +(bidClusters[1]?.price ?? Math.round(support1 - atr * 1.3)).toFixed(1);
  const resist1 = +(topAskWall?.price ?? Math.round(price + atr * 1.1)).toFixed(1);
  const resist2 = +(askClusters[1]?.price ?? Math.round(resist1 + atr * 1.3)).toFixed(1);
  const poc = +(tech.pocPrice ?? tech.vwapRecent ?? price).toFixed(1);

  const keyLevels = [
    {
      price: resist2,
      type: 'Resistance',
      strength: 'Moderate',
      reason: `Upper ask liquidity cluster (${askClusters[1]?.sizeBtc ?? 110} BTC) and extended range cap.`,
    },
    {
      price: resist1,
      type: 'Liquidity Wall',
      strength: 'Strong',
      reason: `Top resting ask wall (${topAskWall?.btc ?? 160} BTC) near recent swing resistance.`,
    },
    {
      price: poc,
      type: 'Pivot',
      strength: 'Strong',
      reason: `80-bar Volume Profile POC ($${poc}) acting as intraday fair-value magnet.`,
    },
    {
      price: support1,
      type: 'Liquidity Wall',
      strength: 'Strong',
      reason: `Primary resting bid wall (${topBidWall?.btc ?? 160} BTC) defending structural support.`,
    },
    {
      price: support2,
      type: 'Support',
      strength: 'Moderate',
      reason: `Secondary demand zone below prior swing low and lower Bollinger band.`,
    },
  ];

  // Grounded patterns based on actual computed quant signals
  const patterns: Record<string, unknown>[] = [];
  if (tech.liquiditySweep) {
    const isBull = tech.liquiditySweep.startsWith('Bullish');
    patterns.push({
      name: isBull ? 'Bullish Liquidity Sweep (SFP)' : 'Bearish Liquidity Sweep (SFP)',
      bias: isBull ? 'Bullish' : 'Bearish',
      status: 'Confirmed',
      confidence: 74,
      timeframe,
      targetPrice: isBull ? resist1 : support1,
      invalidationPrice: isBull ? support2 : resist2,
      description: `${tech.liquiditySweep} with immediate reclaim back inside range.`,
    });
  }
  if (tech.rsiDivergence !== 'None') {
    const isBull = tech.rsiDivergence === 'Bullish';
    patterns.push({
      name: `${tech.rsiDivergence} RSI(14) Divergence`,
      bias: isBull ? 'Bullish' : 'Bearish',
      status: 'Forming',
      confidence: 70,
      timeframe,
      targetPrice: isBull ? resist1 : support1,
      invalidationPrice: isBull ? support2 : resist2,
      description: `Momentum divergence on RSI(14)=${tech.rsi14} across recent fractal swings.`,
    });
  }
  if (bbSqueeze) {
    patterns.push({
      name: 'Bollinger Band Squeeze',
      bias: marketBias === 'Bullish' ? 'Bullish' : marketBias === 'Bearish' ? 'Bearish' : 'Neutral',
      status: 'Forming',
      confidence: 72,
      timeframe,
      targetPrice: marketBias === 'Bearish' ? support1 : resist1,
      invalidationPrice: marketBias === 'Bearish' ? resist1 : support1,
      description: `Tight BB(20,2) width at ${tech.bbWidthPct}% signals imminent volatility expansion.`,
    });
  }
  if (patterns.length < 2) {
    const bullStruct = marketBias === 'Bullish';
    patterns.push({
      name: bullStruct ? 'EMA21 Trend Continuation Flag' : marketBias === 'Bearish' ? 'Descending Channel Breakdown' : 'Value Area Mean Reversion',
      bias: bullStruct ? 'Bullish' : marketBias === 'Bearish' ? 'Bearish' : 'Neutral',
      status: 'Forming',
      confidence: 68,
      timeframe,
      targetPrice: bullStruct ? resist1 : support1,
      invalidationPrice: bullStruct ? support1 : resist1,
      description: `Price ($${price.toFixed(1)}) trading ${tech.vaPosition || 'near POC'} with EMA21=$${tech.ema21 ?? price} and MACD hist=${tech.macdHist ?? 0}.`,
    });
  }
  if (patterns.length < 2) {
    patterns.push({
      name: 'Orderbook Wall Absorption',
      bias: ticker.imbalancePct >= 0 ? 'Bullish' : 'Bearish',
      status: 'Watch',
      confidence: 66,
      timeframe,
      targetPrice: ticker.imbalancePct >= 0 ? resist1 : support1,
      invalidationPrice: ticker.imbalancePct >= 0 ? support2 : resist2,
      description: `Resting book imbalance at ${ticker.imbalancePct}% between $${support1} bid wall and $${resist1} ask wall.`,
    });
  }

  // Build 2 Swing / Position math-verified setups (wider 1.5–2.1x ATR structural stops, min 1:2.2 R:R)
  const longEntry = +(Math.min(price, Math.max(support1 + atr * 0.25, price - atr * 0.3))).toFixed(1);
  const longSl = +(Math.min(support1 - atr * 0.75, longEntry - atr * 1.65)).toFixed(1);
  const longRisk = Math.max(80, longEntry - longSl);
  const longTp1 = +(Math.max(resist1, longEntry + longRisk * 1.5)).toFixed(1);
  const longTp2 = +(Math.max(resist2, longTp1 + longRisk * 1.1)).toFixed(1);
  const longRR = `1:${((longTp2 - longEntry) / longRisk).toFixed(1)}`;

  const shortEntry = +(Math.max(price, Math.min(resist1 - atr * 0.25, price + atr * 0.3))).toFixed(1);
  const shortSl = +(Math.max(resist1 + atr * 0.75, shortEntry + atr * 1.65)).toFixed(1);
  const shortRisk = Math.max(80, shortSl - shortEntry);
  const shortTp1 = +(Math.min(support1, shortEntry - shortRisk * 1.5)).toFixed(1);
  const shortTp2 = +(Math.min(support2, shortTp1 - shortRisk * 1.1)).toFixed(1);
  const shortRR = `1:${((shortEntry - shortTp2) / shortRisk).toFixed(1)}`;

  const longIdea = {
    title: 'Value Area & Bid-Wall Swing Long',
    direction: 'Long',
    setupType: marketBias === 'Bullish' ? 'HTF Trend Pullback Swing Long' : 'Structural Support Reclaim Long',
    entryLow: +(longEntry - atr * 0.2).toFixed(1),
    entryHigh: +(longEntry + atr * 0.2).toFixed(1),
    entryPrice: longEntry,
    stopLoss: longSl,
    takeProfits: [longTp1, longTp2],
    riskReward: longRR,
    confidence: marketBias === 'Bullish' ? Math.min(82, confidence + 3) : 60,
    rationale: `Swing entry near $${support1} bid wall (${topBidWall?.btc ?? 150} BTC) & POC $${poc} with wide structural stop (~1.7x ATR) beneath demand; ${htfAlignment}.`,
    invalidation: `${timeframe} close below $${longSl} breaks structural support.`,
  };

  const shortIdea = {
    title: 'Value Area & Ask-Wall Swing Short',
    direction: 'Short',
    setupType: marketBias === 'Bearish' ? 'HTF Breakdown Retest Short' : 'Resistance Rotation Swing Short',
    entryLow: +(shortEntry - atr * 0.2).toFixed(1),
    entryHigh: +(shortEntry + atr * 0.2).toFixed(1),
    entryPrice: shortEntry,
    stopLoss: shortSl,
    takeProfits: [shortTp1, shortTp2],
    riskReward: shortRR,
    confidence: marketBias === 'Bearish' ? Math.min(82, confidence + 3) : 58,
    rationale: `Fade rallies into $${resist1} ask wall (${topAskWall?.btc ?? 150} BTC) with funding ${fundingRates.oiWeighted8hPct}% and wide structural stop (~1.7x ATR) above swing high.`,
    invalidation: `${timeframe} close above $${shortSl} invalidates bearish structure.`,
  };

  const tradeIdeas = marketBias === 'Bearish' ? [shortIdea, longIdea] : [longIdea, shortIdea];

  const reportJson = {
    marketBias,
    confidence,
    marketRegime,
    summary: `BTC (${timeframe}) trades at $${price.toFixed(1)} (${tech.vaPosition || 'near VA'}, POC $${poc}) with ${htfAlignment}. RSI(14)=${tech.rsi14 ?? 'n/a'} and MACD hist=${tech.macdHist ?? 'n/a'}, framed by $${support1} bid wall (${topBidWall?.btc ?? 150} BTC) and $${resist1} ask wall (${topAskWall?.btc ?? 150} BTC).`,
    keyLevels,
    patterns: patterns.slice(0, 3),
    tradeIdeas,
    confluence: {
      technical: [
        `MTF alignment: ${htfAlignment}; EMA21=$${tech.ema21 ?? 'n/a'}, MA50=$${tech.ma50 ?? 'n/a'}`,
        `RSI(14)=${tech.rsi14 ?? 'n/a'} (div: ${tech.rsiDivergence}), ATR(14)=$${Math.round(atr)}`,
        `80-bar Volume Profile POC=$${poc} (${tech.vaPosition ?? 'balanced'})`,
      ],
      orderbook: [
        `Resting book imbalance: ${ticker.imbalancePct}% (Bids ${ticker.totalBidBtc} vs Asks ${ticker.totalAskBtc} BTC)`,
        `Key walls: Bid $${support1} (${topBidWall?.btc ?? 150} BTC) vs Ask $${resist1} (${topAskWall?.btc ?? 150} BTC)`,
      ],
      derivatives: [
        `OI-weighted 8h funding: ${fundingRates.oiWeighted8hPct}% (APR ${fundingRates.oiWeightedAprPct}%)`,
        `24h flow: Buy ${volumeDistribution.buySharePct}% / Sell ${volumeDistribution.sellSharePct}% (L/S ${volumeDistribution.avgLongShortRatio})`,
      ],
    },
    riskWarning: 'Informational technical analysis only—not financial advice. Size risk strictly per invalidation.',
  };

  // Concise, sharp reasoning trace (teaches btc-neon-lite-4b to think cleanly in ~80 words, zero looping!)
  const thinking = `Price is $${price.toFixed(1)} on ${timeframe} (${htfAlignment}). Key structure: POC=$${poc} (${tech.vaPosition || 'VA'}), EMA21=$${tech.ema21 ?? 'n/a'}, RSI14=${tech.rsi14 ?? 'n/a'} (div=${tech.rsiDivergence}), sweep=${tech.liquiditySweep ?? 'none'}. Orderbook shows ${ticker.imbalancePct}% imbalance with $${support1} bid wall and $${resist1} ask wall; 8h funding=${fundingRates.oiWeighted8hPct}%. Bias=${marketBias} (${confidence}%). Verified Long SL $${longSl} < entry $${longEntry} < TPs $${longTp1}/$${longTp2} (${longRR}) and Short SL $${shortSl} > entry $${shortEntry} > TPs $${shortTp1}/$${shortTp2} (${shortRR}). Outputting strict JSON.`;

  return { prompt, thinking, reportJson, bias: marketBias };
}

function buildChatExample(
  prompt: string,
  reportJson: Record<string, unknown>,
  thinking: string,
  variant: number
): DatasetRow {
  const headerIdx = prompt.indexOf('MARKET HEADER:');
  const marketBlock = headerIdx >= 0 ? prompt.slice(headerIdx) : prompt;
  const sys = `You are a helpful, concise quantitative Bitcoin technical analyst and orderflow assistant embedded inside the user's live trading chart.\nAnswer the user's questions directly using ONLY the real live market data below (never invent fake prices). Format cleanly with bullet points and exact price levels.\n\n${marketBlock}`;

  const ideas = reportJson.tradeIdeas as {
    title: string;
    direction: string;
    entryLow: number;
    entryHigh: number;
    stopLoss: number;
    takeProfits: number[];
    riskReward: string;
    rationale: string;
    invalidation: string;
  }[];
  const levels = reportJson.keyLevels as { price: number; type: string; reason: string }[];
  const conf = reportJson.confluence as {
    technical: string[];
    orderbook: string[];
    derivatives: string[];
  };

  if (variant % 3 === 0) {
    const answer = `**Bias:** ${reportJson.marketBias} (${reportJson.confidence}% — ${reportJson.marketRegime})\n\n- **Summary:** ${reportJson.summary}\n- **Key Resistance:** $${levels[1]?.price} (${levels[1]?.reason})\n- **Fair Value Pivot:** $${levels[2]?.price} (${levels[2]?.reason})\n- **Key Support:** $${levels[3]?.price} (${levels[3]?.reason})`;
    return {
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: 'Summarize the current trend & key S/R levels' },
        { role: 'assistant', content: `<think>\n${thinking}\n</think>\n\n${answer}` },
      ],
      meta: { kind: 'chat_deep', tf: 'mixed' },
    };
  }

  if (variant % 3 === 1) {
    const best = ideas[0];
    const alt = ideas[1];
    const answer = `**Primary Setup (${best.direction} — ${best.riskReward} R:R):** ${best.title}\n- **Entry Zone:** $${best.entryLow} – $${best.entryHigh}\n- **Stop Loss:** $${best.stopLoss} (${best.invalidation})\n- **Targets:** TP1 $${best.takeProfits[0]} · TP2 $${best.takeProfits[1]}\n- **Why:** ${best.rationale}\n\n**Counter / Hedge (${alt.direction} — ${alt.riskReward} R:R):** Entry $${alt.entryLow}–$${alt.entryHigh}, SL $${alt.stopLoss}, TP1 $${alt.takeProfits[0]}.\n\n*Not financial advice—manage position size to invalidation.*`;
    return {
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: 'What is the best Long/Short R:R setup right now?' },
        { role: 'assistant', content: `<think>\n${thinking}\n</think>\n\n${answer}` },
      ],
      meta: { kind: 'chat_deep', tf: 'mixed' },
    };
  }

  // Fast-style direct answer (empty think block so Fast mode stays super crisp!)
  const answer = `**Orderbook & Funding Signal:**\n- ${conf.orderbook[0]}\n- ${conf.orderbook[1]}\n- ${conf.derivatives[0]}\n- ${conf.derivatives[1]}\n- **Read:** ${reportJson.marketBias} tilt (${reportJson.marketRegime}); watch $${levels[3]?.price} bids vs $${levels[1]?.price} asks for breakout confirmation.`;
  return {
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: 'What do the orderbook walls & funding rate signal?' },
      { role: 'assistant', content: `<think>\n\n</think>\n\n${answer}` },
    ],
    meta: { kind: 'chat_fast', tf: 'mixed' },
  };
}

async function main() {
  console.log('[Dataset Builder] Fetching real historical BTCUSDT Swing multi-TF candles from Binance Futures...');
  const [k1h, k4h, k1d] = await Promise.all([
    fetchBinanceKlines('1h', 1600),
    fetchBinanceKlines('4h', 1200),
    fetchBinanceKlines('1d', 520),
  ]);
  console.log(
    `[Dataset Builder] Loaded candles: 1h=${k1h.length}, 4h=${k4h.length}, 1d=${k1d.length}`
  );

  const sliceBefore = (arr: RawKline[], ts: number, maxBars: number) => {
    let end = arr.length;
    while (end > 0 && arr[end - 1].t > ts) end--;
    return arr.slice(Math.max(0, end - maxBars), end);
  };

  const rows: DatasetRow[] = [];
  let seed = 101;

  const generateFromSeries = (tf: TimeframeId, series: RawKline[], step: number) => {
    for (let i = 220; i < series.length - 16; i += step) {
      const windowCandles = series.slice(i - 210, i + 1);
      const futureCandles = series.slice(i + 1, i + 15);
      const ts = windowCandles[windowCandles.length - 1].t;
      const h4 = tf === '4h' || tf === '1d' ? undefined : sliceBefore(k4h, ts, 120);
      const h1d = tf === '1d' ? undefined : sliceBefore(k1d, ts, 120);

      const built = buildOutcomeGroundedTarget({
        timeframe: tf,
        candles: windowCandles,
        futureCandles,
        higherTf4h: h4 && h4.length >= 25 ? h4 : undefined,
        higherTf1d: h1d && h1d.length >= 25 ? h1d : undefined,
        seed: seed++,
      });

      // 1. TA Report example (70% Deep Think, 30% Fast direct JSON)
      const isFastReport = seed % 10 < 3;
      rows.push({
        messages: [
          { role: 'system', content: REPORT_SYSTEM_PROMPT },
          { role: 'user', content: built.prompt },
          {
            role: 'assistant',
            content: isFastReport
              ? `<think>\n\n</think>\n\n${JSON.stringify(built.reportJson)}`
              : `<think>\n${built.thinking}\n</think>\n\n${JSON.stringify(built.reportJson)}`,
          },
        ],
        meta: { kind: isFastReport ? 'report_fast' : 'report_deep', tf, bias: built.bias },
      });

      // 2. Paired interactive Chat example on 70% of windows
      if (seed % 10 < 7) {
        rows.push(buildChatExample(built.prompt, built.reportJson, built.thinking, seed));
      }
    }
  };

  // Heavily weighted toward Swing / Position Trader timeframes (4H & 1D + 1H HTF-aligned)
  generateFromSeries('4h', k4h, 6);
  generateFromSeries('1d', k1d, 4);
  generateFromSeries('1h', k1h, 14);

  // Merge any positive user-rated feedback samples from server/data/ai-training-log.jsonl
  let userSamples = 0;
  if (fs.existsSync(FEEDBACK_LOG)) {
    for (const line of fs.readFileSync(FEEDBACK_LOG, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const fb = JSON.parse(trimmed) as {
          kind: 'report' | 'chat';
          rating: 'up' | 'down';
          prompt: string;
          thinking?: string;
          response: string;
        };
        if (fb.rating === 'up' && fb.prompt && fb.response) {
          const thinkWrap = fb.thinking ? `<think>\n${fb.thinking}\n</think>\n\n` : '<think>\n\n</think>\n\n';
          rows.push({
            messages: [
              {
                role: 'system',
                content:
                  fb.kind === 'report'
                    ? REPORT_SYSTEM_PROMPT
                    : 'You are a helpful, concise quantitative Bitcoin technical analyst and orderflow assistant.',
              },
              { role: 'user', content: fb.prompt },
              { role: 'assistant', content: `${thinkWrap}${fb.response}` },
            ],
            meta: { kind: `user_${fb.kind}`, tf: 'live' },
          });
          userSamples++;
        }
      } catch {
        // skip
      }
    }
  }

  // Deterministic shuffle of historical rows, then split honest held-out eval set BEFORE adding upsampled Gold rows
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(deterministicHash(i + 999) * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }

  const evalCount = Math.max(30, Math.round(rows.length * 0.08));
  const evalRows = rows.slice(0, evalCount);
  const trainRows = rows.slice(evalCount);

  // Inject manually hand-crafted Gold Swing + ML-Synthesis Datasets (upsampled cleanly so
  // btc-neon-lite-4b v4 absorbs both institutional swing R:R discipline AND 3-layer ML + orderflow synthesis!)
  const goldRows = getGoldSwingDataset();
  const mlGoldRows = getGoldMlSynthesisDataset();
  for (let rep = 0; rep < 5; rep++) {
    for (const g of goldRows) {
      trainRows.push({ messages: g.messages, meta: { kind: g.meta.kind, tf: '4h' } });
    }
  }
  for (let rep = 0; rep < 8; rep++) {
    for (const g of mlGoldRows) {
      trainRows.push({ messages: g.messages, meta: { kind: g.meta.kind, tf: '4h' } });
    }
  }

  // Reshuffle final train set cleanly
  for (let i = trainRows.length - 1; i > 0; i--) {
    const j = Math.floor(deterministicHash(i + 7777) * (i + 1));
    [trainRows[i], trainRows[j]] = [trainRows[j], trainRows[i]];
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'gold_swing_curated.jsonl'),
    goldRows.map((r) => JSON.stringify({ messages: r.messages })).join('\n') + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'train.jsonl'),
    trainRows.map((r) => JSON.stringify({ messages: r.messages })).join('\n') + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'eval.jsonl'),
    evalRows.map((r) => JSON.stringify({ messages: r.messages })).join('\n') + '\n',
    'utf8'
  );

  console.log(
    `[Dataset Builder] Done! train=${trainRows.length} (incl. ${goldRows.length}x6=${goldRows.length * 6} hand-crafted Gold Swing rows), eval=${evalRows.length}, userFeedback=${userSamples} -> ${OUT_DIR}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
