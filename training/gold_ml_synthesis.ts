import type { GoldDatasetRow } from './gold_swing_curated.ts';
import { REPORT_SYSTEM_PROMPT } from './gold_swing_curated.ts';

const CHAT_SYS_HEADER = `You are a helpful, concise quantitative Bitcoin technical analyst and orderflow assistant embedded inside the user's live trading chart.
Answer the user's questions directly using ONLY the real live market data below (never invent fake prices). Format cleanly with bullet points and exact price levels.`;

function mkMlReportPrompt(price: number, atr: number, body: string): string {
  return `Analyze the live Bitcoin market data and calibrated LightGBM Quant-ML forecast below, then return valid JSON matching the requested schema.
RULES:
1. Synthesize the Quant-ML probabilities with live orderbook walls, 5-exchange funding, Value Area (POC/VAH/VAL), and HTF structure—explicitly note where orderflow confirms or contradicts the ML forecast.
2. Ground ALL prices in the data around $${price.toFixed(1)}.
3. Report 2–3 real patterns, 4–5 key levels, and 2 actionable trade setups (Long: SL < entry < TP1 < TP2; Short: SL > entry > TP1 > TP2; place SL cleanly beyond swing/wall ~1.5x ATR ~$${Math.round(atr * 1.5)}).
4. Keep reasoning brief (3–5 short sentences) and cite exact indicator/ML/wall/funding values concisely with a short non-financial-advice riskWarning.

${body}`;
}

function mkChatSystem(body: string): string {
  return `${CHAT_SYS_HEADER}\n\n${body}`;
}

// Scenario A: High-Conviction Confluence — Quant-ML Bullish + Spot Absorbing Perp Sells + Bid Wall at VAL
const ML_SNAP_CONFLUENCE_LONG = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 1h | Price: $61420.0 (+0.95% 24h, H/L $61880/$60120)
- Bid/Ask: $61419.5/$61420.5 | Spot: $61428.0 | OI: $11.40B

INDICATORS (1h, 240 bars):
- MAs: EMA9=61290.0, EMA21=61050.0, EMA50=60780.0, EMA200=60310.0, MA50=60810.0, MA100=60540.0, MA200=60290.0
- Momentum: RSI14=56.8 (prev5=49.2), MACD=185.4/142.0 (Hist=43.4)
- Volatility/Flow: BB20=60420.0–62150.0 (W=2.82%), ATR14=$440.0 (0.72%), VWAP50=61020.0, Vol/MA20=1.34x, 50-bar Range=$60120–$61880
- Volume Profile (80-bar): POC=$60950.0, VAL=$60480.0, VAH=$61620.0 (Inside VA)
- Quant Signals: MTF=Bullish Aligned (2/2: 4h↑ 1d↑) | RSI Div=Bullish | Liquidity Sweep=Bullish SFP below $60450
- Swing Highs: $61640, $61880 | Swing Lows: $60120, $60450, $60920

HIGHER TF:
- 4H: Close=$61420.0, EMA21=60890.0, MA50=60410.0, MA200=59820.0, RSI14=59.1, MACD_H=118.4
- 1D: Close=$61420.0, EMA21=60150.0, MA50=59240.0, MA200=58400.0, RSI14=57.4, MACD_H=210.0

ML QUANT MODEL FORECAST (Walk-Forward LightGBM 1H, 12h Triple-Barrier ±1.8x ATR, OOS AUC=0.629):
- Directional Probs: Up 58.4% / Chop 21.2% / Down 20.4% (Edge +38.0%, Bias: Bullish, Conviction: High)
- Regime Probs: Trending 61.5% | Mean-Reverting 24.0% | High-Vol Flush 14.5% (Dominant: Trending)
- Expected 12h Range Envelope: $60490 – $62350 (±1.51%)
- Top Numerical Drivers: Spot Absorbing Perp Sells (Div +11.4% (Spot 39%)); Bullish SFP Sweep (Liquidity reclaim); Negative/Short Funding (-0.0045% (-1.9σ))

ORDERBOOK & DERIVATIVES:
- Book: Bids 1620 vs Asks 1090 BTC (Imb +19.6%)
- Bid Walls: $61000 (285B, -0.7%); $60500 (340B, -1.5%); $60000 (410B, -2.3%)
- Ask Walls: $61900 (145B, +0.8%); $62500 (230B, +1.8%); $63200 (310B, +2.9%)
- Whales (>=0.5B): Buy 118.4 / Sell 61.2 BTC | Liqs: Long $840,000 / Short $4,920,000
- OI-Weighted 8h Funding: -0.0045% (APR -4.93%, Ex: BN:-0.0045%, BYB:-0.0041%)
- 24h Vol: Spot 39% / Deriv 61% | Buy 57% / Sell 43% | L/S 0.94`;

// Scenario B: ML vs Orderbook Conflict — ML says Moderate Bullish, BUT huge Ask Wall + Crowded +2.4σ Long Funding
const ML_SNAP_CONFLICT_OVERRIDE = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 4h | Price: $71680.0 (+3.90% 24h, H/L $71950/$68820)
- Bid/Ask: $71679.5/$71680.5 | Spot: $71625.0 | OI: $15.60B

INDICATORS (4h, 240 bars):
- MAs: EMA9=70840.0, EMA21=69750.0, EMA50=68420.0, EMA200=66890.0, MA50=68510.0, MA100=67600.0, MA200=66920.0
- Momentum: RSI14=74.6 (prev5=66.1), MACD=920.0/710.0 (Hist=210.0)
- Volatility/Flow: BB20=66800.0–72100.0 (W=7.63%), ATR14=$1150.0 (1.60%), VWAP50=69180.0, Vol/MA20=1.62x, 50-bar Range=$66400–$71950
- Volume Profile (80-bar): POC=$68600.0, VAL=$67200.0, VAH=$70450.0 (Above VA)
- Quant Signals: MTF=Bullish Aligned (2/2: 4h↑ 1d↑) | RSI Div=Bearish | Liquidity Sweep=None
- Swing Highs: $70500, $71950 | Swing Lows: $66400, $68150, $69400

HIGHER TF:
- 1D: Close=$71680.0, EMA21=68200.0, MA50=66100.0, MA200=63400.0, RSI14=71.2, MACD_H=520.0

ML QUANT MODEL FORECAST (Walk-Forward LightGBM 4H, 48h Triple-Barrier ±1.8x ATR, OOS AUC=0.541):
- Directional Probs: Up 46.2% / Chop 22.8% / Down 31.0% (Edge +15.2%, Bias: Bullish, Conviction: Moderate)
- Regime Probs: Trending 44.0% | Mean-Reverting 36.5% | High-Vol Flush 19.5% (Dominant: Trending)
- Expected 48h Range Envelope: $69420 – $73940 (±3.15%)
- Top Numerical Drivers: Perp Chasing vs Spot (Div -9.8% (Spot 21%)); Crowded Long Funding (0.0380% (+2.4σ)); OI Leverage Buildup (OI +6.2% (z +2.1))

ORDERBOOK & DERIVATIVES:
- Book: Bids 980 vs Asks 1740 BTC (Imb -27.9%)
- Bid Walls: $70400 (260B, -1.8%); $69500 (310B, -3.0%); $68600 (390B, -4.3%)
- Ask Walls: $72000 (485B, +0.4%); $72500 (340B, +1.1%); $73500 (290B, +2.5%)
- Whales (>=0.5B): Buy 74.0 / Sell 158.5 BTC | Liqs: Long $2,150,000 / Short $3,400,000
- OI-Weighted 8h Funding: 0.0380% (APR 41.61%, Ex: BN:0.038%, BYB:0.039%)
- 24h Vol: Spot 21% / Deriv 79% | Buy 52% / Sell 48% | L/S 1.54`;

// Scenario C: Guardrailed Neutral 1D / Chop Regime — Value Area Mean-Reversion Discipline
const ML_SNAP_NEUTRAL_CHOP = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 4h | Price: $65400.0 (-0.25% 24h, H/L $66100/$64750)
- Bid/Ask: $65399.0/$65400.5 | Spot: $65402.0 | OI: $10.85B

INDICATORS (4h, 240 bars):
- MAs: EMA9=65380.0, EMA21=65440.0, EMA50=65510.0, EMA200=65220.0, MA50=65490.0, MA100=65310.0, MA200=65190.0
- Momentum: RSI14=49.4 (prev5=50.8), MACD=-18.0/-12.0 (Hist=-6.0)
- Volatility/Flow: BB20=64620.0–66240.0 (W=2.48%), ATR14=$720.0 (1.10%), VWAP50=65420.0, Vol/MA20=0.72x, 50-bar Range=$64100–$66850
- Volume Profile (80-bar): POC=$65450.0, VAL=$64400.0, VAH=$66500.0 (Inside VA)
- Quant Signals: MTF=Mixed (1/2: 4h→ 1d→) | RSI Div=None | Liquidity Sweep=None
- Swing Highs: $66550, $66850 | Swing Lows: $64100, $64450

HIGHER TF:
- 1D: Close=$65400.0, EMA21=65310.0, MA50=65120.0, MA200=64200.0, RSI14=51.0, MACD_H=15.0

ML QUANT MODEL FORECAST (Walk-Forward LightGBM 4H, 48h Triple-Barrier ±1.8x ATR, OOS AUC=0.541):
- Directional Probs: Up 26.8% / Chop 48.5% / Down 24.7% (Edge +2.1%, Bias: Neutral, Conviction: Low)
- Regime Probs: Trending 18.2% | Mean-Reverting 69.4% | High-Vol Flush 12.4% (Dominant: Mean-Reverting)
- Expected 48h Range Envelope: $64150 – $66650 (±1.91%)
- Top Numerical Drivers: Volatility Squeeze (BB 2.48%); Balanced Inside Value Area (-0.1% vs POC)

ORDERBOOK & DERIVATIVES:
- Book: Bids 1290 vs Asks 1260 BTC (Imb +1.2%)
- Bid Walls: $64400 (320B, -1.5%); $64000 (410B, -2.1%); $63200 (280B, -3.4%)
- Ask Walls: $66500 (335B, +1.7%); $67000 (390B, +2.4%); $68000 (260B, +4.0%)
- Whales (>=0.5B): Buy 42.0 / Sell 45.5 BTC | Liqs: Long $610,000 / Short $540,000
- OI-Weighted 8h Funding: 0.0085% (APR 9.31%, Ex: BN:0.0085%, BYB:0.0082%)
- 24h Vol: Spot 31% / Deriv 69% | Buy 50% / Sell 50% | L/S 1.03`;

// Scenario D: High-Vol Flush + Bearish Breakdown + OI Wipeout
const ML_SNAP_HIGHVOL_FLUSH = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 1h | Price: $58920.0 (-5.80% 24h, H/L $62550/$58400)
- Bid/Ask: $58918.0/$58921.0 | Spot: $58960.0 | OI: $9.45B

INDICATORS (1h, 240 bars):
- MAs: EMA9=59480.0, EMA21=60210.0, EMA50=61140.0, EMA200=62180.0, MA50=61190.0, MA100=61680.0, MA200=62210.0
- Momentum: RSI14=26.4 (prev5=33.1), MACD=-580.0/-420.0 (Hist=-160.0)
- Volatility/Flow: BB20=58200.0–62650.0 (W=7.36%), ATR14=$780.0 (1.32%), VWAP50=60650.0, Vol/MA20=2.48x, 50-bar Range=$58400–$62900
- Volume Profile (80-bar): POC=$61400.0, VAL=$60200.0, VAH=$62300.0 (Below VA)
- Quant Signals: MTF=Bearish Aligned (2/2: 4h↓ 1d↓) | RSI Div=None | Liquidity Sweep=None
- Swing Highs: $60500, $61800, $62900 | Swing Lows: $58400

HIGHER TF:
- 4H: Close=$58920.0, EMA21=60900.0, MA50=61850.0, MA200=63100.0, RSI14=29.8, MACD_H=-310.0
- 1D: Close=$58920.0, EMA21=62400.0, MA50=63800.0, MA200=61500.0, RSI14=34.2, MACD_H=-440.0

ML QUANT MODEL FORECAST (Walk-Forward LightGBM 1H, 12h Triple-Barrier ±1.8x ATR, OOS AUC=0.629):
- Directional Probs: Up 22.1% / Chop 18.4% / Down 59.5% (Edge -37.4%, Bias: Bearish, Conviction: High)
- Regime Probs: Trending 28.5% | Mean-Reverting 12.0% | High-Vol Flush 59.5% (Dominant: High-Vol Flush)
- Expected 12h Range Envelope: $57250 – $60590 (±2.83%)
- Top Numerical Drivers: OI Deleverage Flush (OI -6.8% (z -2.2)); Aggressive Taker Selling (39% buy (CVD -0.34)); Expanding Volatility (ATR 1.82x)

ORDERBOOK & DERIVATIVES:
- Book: Bids 1120 vs Asks 1690 BTC (Imb -20.3%)
- Bid Walls: $58000 (290B, -1.6%); $57200 (380B, -2.9%); $56000 (460B, -5.0%)
- Ask Walls: $59600 (245B, +1.2%); $60200 (360B, +2.2%); $61400 (310B, +4.2%)
- Whales (>=0.5B): Buy 68.0 / Sell 214.0 BTC | Liqs: Long $19,400,000 / Short $1,120,000
- OI-Weighted 8h Funding: -0.0092% (APR -10.07%, Ex: BN:-0.0095%, BYB:-0.0088%)
- 24h Vol: Spot 36% / Deriv 64% | Buy 41% / Sell 59% | L/S 0.86`;

export function getGoldMlSynthesisDataset(): GoldDatasetRow[] {
  const rows: GoldDatasetRow[] = [];

  // 1. Deep Report — Full Confluence Long (ML + Spot Absorption + Bid Wall + Bullish SFP)
  const reportConfluence = {
    marketBias: 'Bullish',
    confidence: 78,
    marketRegime: 'Trending Breakout (ML + Spot Absorption Aligned)',
    summary:
      'High-conviction bullish alignment: LightGBM 1H forecasts 58.4% Up (+38.0% edge, Trending 61.5%) and live orderflow confirms it via +11.4% Spot-vs-Perp CVD absorption, +19.6% bid-heavy book, and negative funding (-0.0045%, -1.9σ) fueling a squeeze. Price reclaimed $60,450 via a bullish SFP and holds above POC ($60,950) with thick 285–340 BTC bid walls below.',
    keyLevels: [
      { price: 61900, type: 'Resistance', strength: 'Moderate', reason: '24h high & 145 BTC ask wall before VAH breakout' },
      { price: 62500, type: 'Liquidity Wall', strength: 'Strong', reason: '230 BTC resting ask wall near ML upper envelope ($62,350)' },
      { price: 60950, type: 'Pivot', strength: 'Strong', reason: '80-bar POC & 285 BTC bid wall at $61,000' },
      { price: 60480, type: 'Support', strength: 'Strong', reason: 'Value Area Low (VAL), bullish SFP reclaim & 340 BTC bid wall' },
    ],
    patterns: [
      {
        name: 'Bullish SFP Reclaim + Spot Absorption',
        bias: 'Bullish',
        status: 'Confirmed',
        confidence: 80,
        timeframe: '1h',
        targetPrice: 63200,
        invalidationPrice: 60250,
        description: 'Sweep below $60,450 reclaimed on +11.4% spot taker buying divergence while perp shorts pay negative funding.',
      },
      {
        name: 'MTF Trend Continuation (4H + 1D Aligned)',
        bias: 'Bullish',
        status: 'Forming',
        confidence: 74,
        timeframe: '4h',
        targetPrice: 62500,
        invalidationPrice: 60400,
        description: 'Both 4H and 1D trade cleanly above EMA21/MA50 with bullish MACD histogram expansion.',
      },
    ],
    tradeIdeas: [
      {
        title: 'POC / Bid-Wall Pullback Long (ML + Spot Confluence)',
        direction: 'Long',
        setupType: 'Pullback Continuation',
        entryLow: 60950,
        entryHigh: 61250,
        entryPrice: 61100,
        stopLoss: 60250,
        takeProfits: [62350, 63200],
        riskReward: '1:2.5',
        confidence: 78,
        rationale: 'Aligned with 58.4% Up ML edge, 285 BTC bid wall at $61,000, and Spot CVD absorption; SL sits ~1.9x ATR ($850) below VAL/SFP low.',
        invalidation: '1H close below $60,250 breaks the 340 BTC VAL bid wall and invalidates the SFP.',
      },
      {
        title: 'VAH Breakout Continuation Long',
        direction: 'Long',
        setupType: 'Breakout Retest',
        entryLow: 61650,
        entryHigh: 61900,
        entryPrice: 61800,
        stopLoss: 60900,
        takeProfits: [63150, 64050],
        riskReward: '1:2.5',
        confidence: 68,
        rationale: 'Thin 145 BTC ask wall at $61,900 invites a squeeze of -0.0045% shorts once VAH ($61,620) flips to support.',
        invalidation: 'Failed breakout back below POC ($60,950).',
      },
    ],
    confluence: {
      technical: ['1H/4H/1D bullish aligned above EMA21 & MA50', 'Confirmed bullish SFP below $60,450 + bullish RSI divergence'],
      orderbook: ['+19.6% bid imbalance with 285B ($61,000) & 340B ($60,500) support walls', 'Whale buyers 118.4 vs 61.2 BTC sellers'],
      derivatives: ['Quant-ML 1H: 58.4% Up (+38% edge, AUC 0.629)', 'Spot CVD +11.4% above Perp + negative funding (-0.0045%, -1.9σ)'],
    },
    riskWarning: 'Not financial advice. Confirm $61,000 bid wall holds on pullback; avoid market-chasing if 1H RSI spikes >70.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkMlReportPrompt(61420, 440, ML_SNAP_CONFLUENCE_LONG) },
      {
        role: 'assistant',
        content: `<think>Quant-ML 1H is strongly bullish (58.4% Up vs 20.4% Down, +38% edge, Trending 61.5%). Checking live orderflow for confirmation or conflict: Spot is absorbing perp sells (+11.4% CVD div, 39% spot share), funding is negative (-0.0045%, -1.9σ), and 285B/340B bid walls defend $61,000–$60,500. Full 3-layer confluence. Primary swing entry at POC $61,100 with 1.9x ATR stop at $60,250 (risk $850) targeting $62,350/$63,200 (reward $2,100 = 1:2.5 R:R). Secondary VAH breakout at $61,800, SL $60,900 (risk $900), TP2 $64,050 (reward $2,250 = 1:2.5 R:R).</think>\n${JSON.stringify(reportConfluence)}`,
      },
    ],
    meta: { kind: 'gold_report_deep', regime: 'ml_confluence_long' },
  });

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkMlReportPrompt(61420, 440, ML_SNAP_CONFLUENCE_LONG) },
      { role: 'assistant', content: `<think></think>\n${JSON.stringify(reportConfluence)}` },
    ],
    meta: { kind: 'gold_report_fast', regime: 'ml_confluence_long' },
  });

  // 2. Deep & Fast Report — ML vs Orderbook Conflict (Explicitly Override Chasing ML!)
  const reportConflict = {
    marketBias: 'Neutral',
    confidence: 64,
    marketRegime: 'Overheated Perp Extension (ML vs Orderbook Conflict)',
    summary:
      'Key conflict between statistical ML and live microstructure: LightGBM 4H leans Bullish (46.2% Up, +15.2% edge), but live orderflow flashes exhaustion—a massive 485 BTC ask wall caps $72,000 (+0.4%), book imbalance is -27.9%, funding is crowded at +0.0380% (+2.4σ, 41.6% APR), and Perps are chasing without Spot (-9.8% CVD div, 21% spot share). Do NOT chase longs into $72,000; wait for either a pullback to VAH ($70,450) or a liquidity-sweep fade.',
    keyLevels: [
      { price: 72000, type: 'Liquidity Wall', strength: 'Strong', reason: '485 BTC overhead ask wall + 24h high rejection zone' },
      { price: 72500, type: 'Resistance', strength: 'Strong', reason: '340 BTC secondary ask wall; squeeze ceiling if $72,000 sweeps' },
      { price: 70450, type: 'Support', strength: 'Strong', reason: 'Value Area High (VAH) + 260 BTC resting bid wall' },
      { price: 68600, type: 'Pivot', strength: 'Strong', reason: '80-bar POC + 390 BTC bid wall; deep flush target' },
    ],
    patterns: [
      {
        name: 'Bearish RSI Divergence into 485 BTC Ask Wall',
        bias: 'Bearish',
        status: 'Forming',
        confidence: 70,
        timeframe: '4h',
        targetPrice: 68600,
        invalidationPrice: 73400,
        description: '4H RSI (74.6) prints bearish divergence while OI surges +6.2% (+2.1σ) on perp-only chasing.',
      },
      {
        name: 'HTF Bull Trend Pullback Setup',
        bias: 'Bullish',
        status: 'Watch',
        confidence: 66,
        timeframe: '4h',
        targetPrice: 74400,
        invalidationPrice: 68600,
        description: '4H/1D macro trend and ML 46.2% Up bias favor dip-buying once crowded funding resets at VAH ($70,450).',
      },
    ],
    tradeIdeas: [
      {
        title: 'Patient VAH Retest Long (Wait for Funding Reset)',
        direction: 'Long',
        setupType: 'Pullback Reclaim',
        entryLow: 69900,
        entryHigh: 70500,
        entryPrice: 70200,
        stopLoss: 68400,
        takeProfits: [72400, 74520],
        riskReward: '1:2.4',
        confidence: 68,
        rationale: 'Respects HTF trend and ML bullish skew without buying into the 485B $72,000 ask wall; anchored by 260B/310B bid walls and ~1.6x ATR SL.',
        invalidation: '4H close below $68,400 loses POC ($68,600) and flips structure bearish.',
      },
      {
        title: 'Tactical $72,000 Wall Rejection Short (Crowded Long Fade)',
        direction: 'Short',
        setupType: 'Liquidity Wall Fade',
        entryLow: 71800,
        entryHigh: 72250,
        entryPrice: 72000,
        stopLoss: 73600,
        takeProfits: [70450, 68160],
        riskReward: '1:2.4',
        confidence: 62,
        rationale: 'Fades +0.038% (+2.4σ) crowded longs and -9.8% Spot/Perp divergence against the 485B–340B ask wall cluster; SL clears $73,500 wall.',
        invalidation: '4H close above $73,600 signals full short squeeze through resting ask liquidity.',
      },
    ],
    confluence: {
      technical: ['4H RSI overbought (74.6) with bearish divergence; price stretched above VAH ($70,450)'],
      orderbook: ['Heavy -27.9% ask skew led by 485B ask wall at $72,000', 'Whale selling 158.5 vs 74.0 BTC buying'],
      derivatives: ['Conflict: ML 4H says 46.2% Up, but Funding +0.038% (+2.4σ), OI +6.2%, and Spot share only 21% warn of flush first'],
    },
    riskWarning: 'Not financial advice. High squeeze/flush risk near $72,000 due to +2.4σ funding and +6.2% OI buildup—avoid chasing breakout candles.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkMlReportPrompt(71680, 1150, ML_SNAP_CONFLICT_OVERRIDE) },
      {
        role: 'assistant',
        content: `<think>Quant-ML 4H leans Bullish (46.2% Up vs 31.0% Down), BUT live microstructure strongly contradicts chasing here: 485B ask wall sits at $72,000 (+0.4%), book is -27.9% ask-heavy, funding is +0.038% (+2.4σ), OI jumped +6.2%, and Spot share is only 21% (-9.8% CVD div). Override immediate breakout long -> Neutral bias until reset. Setup 1: patient VAH retest Long at $70,200, SL $68,400 (risk $1,800 ~1.57x ATR), TP2 $74,520 (reward $4,320 = 1:2.4 R:R). Setup 2: tactical fade Short at $72,000 wall, SL $73,600 (risk $1,600), TP2 $68,160 (reward $3,840 = 1:2.4 R:R).</think>\n${JSON.stringify(reportConflict)}`,
      },
    ],
    meta: { kind: 'gold_report_deep', regime: 'ml_orderbook_conflict' },
  });

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkMlReportPrompt(71680, 1150, ML_SNAP_CONFLICT_OVERRIDE) },
      { role: 'assistant', content: `<think></think>\n${JSON.stringify(reportConflict)}` },
    ],
    meta: { kind: 'gold_report_fast', regime: 'ml_orderbook_conflict' },
  });

  // 3. Deep & Fast Report — High-Chop / Neutral ML (Value Area Mean-Reversion Discipline)
  const reportChop = {
    marketBias: 'Range-Bound',
    confidence: 74,
    marketRegime: 'Volatility Squeeze / Mean-Reverting Chop',
    summary:
      'Strong agreement on range-bound chop: LightGBM 4H assigns 48.5% Chop and 69.4% Mean-Reverting regime (+2.1% edge = Neutral) with an expected 48h envelope of $64,150–$66,650. Price is pinned to POC ($65,450) inside a tight 2.48% Bollinger squeeze on muted 0.72x volume with balanced funding (0.0085%) and symmetrical 320B/335B walls at VAL ($64,400) and VAH ($66,500). Avoid mid-range entries; fade the VA edges only.',
    keyLevels: [
      { price: 66500, type: 'Resistance', strength: 'Strong', reason: 'VAH + 335 BTC ask wall & ML upper range ($66,650)' },
      { price: 67000, type: 'Liquidity Wall', strength: 'Strong', reason: '390 BTC resting ask wall above range high ($66,850)' },
      { price: 65450, type: 'Pivot', strength: 'Moderate', reason: '80-bar POC & flat EMA21/MA50 equilibrium (no-trade zone)' },
      { price: 64400, type: 'Support', strength: 'Strong', reason: 'VAL + 320 BTC bid wall & ML lower range ($64,150)' },
    ],
    patterns: [
      {
        name: 'Bollinger Volatility Squeeze (2.48% Width)',
        bias: 'Neutral',
        status: 'Confirmed',
        confidence: 78,
        timeframe: '4h',
        targetPrice: 66500,
        invalidationPrice: 64100,
        description: 'Compressed range centered on POC ($65,450) with 0.72x volume; favors mean reversion until a high-volume VA break.',
      },
      {
        name: 'Symmetrical Value Area Range ($64.4K–$66.5K)',
        bias: 'Neutral',
        status: 'Confirmed',
        confidence: 75,
        timeframe: '4h',
        targetPrice: 64400,
        invalidationPrice: 67000,
        description: '320B VAL bid wall and 335B VAH ask wall align tightly with the ML 69.4% Mean-Reverting forecast.',
      },
    ],
    tradeIdeas: [
      {
        title: 'VAL Mean-Reversion Long (Edge Fade)',
        direction: 'Long',
        setupType: 'Range Support Fade',
        entryLow: 64200,
        entryHigh: 64550,
        entryPrice: 64400,
        stopLoss: 63300,
        takeProfits: [65450, 66820],
        riskReward: '1:2.2',
        confidence: 70,
        rationale: 'Buys VAL + 320B/410B bid walls aligned with ML 69.4% Mean-Reverting regime; SL sits 1.5x ATR ($1,100) below $64,000 wall.',
        invalidation: '4H close below $63,300 resolves the squeeze downward.',
      },
      {
        title: 'VAH Mean-Reversion Short (Edge Fade)',
        direction: 'Short',
        setupType: 'Range Resistance Fade',
        entryLow: 66400,
        entryHigh: 66750,
        entryPrice: 66550,
        stopLoss: 67650,
        takeProfits: [65450, 64130],
        riskReward: '1:2.2',
        confidence: 68,
        rationale: 'Fades VAH + 335B/390B ask walls right at the ML upper envelope ($66,650) with 1.5x ATR structural stop above $67,000.',
        invalidation: '4H close above $67,650 confirms bullish range expansion.',
      },
    ],
    confluence: {
      technical: ['Flat MAs, RSI 49.4, BB width 2.48% squeeze, 0.72x low volume'],
      orderbook: ['Balanced book (+1.2% imb); strong 320B ($64,400) and 335B ($66,500) range walls'],
      derivatives: ['Quant-ML 4H: Neutral (Chop 48.5%, Mean-Reverting 69.4%) + neutral 0.0085% funding'],
    },
    riskWarning: 'Not financial advice. Mid-range entries near POC ($65,450) have poor R:R in high-chop regimes; wait for VA boundaries.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkMlReportPrompt(65400, 720, ML_SNAP_NEUTRAL_CHOP) },
      {
        role: 'assistant',
        content: `<think>Quant-ML 4H is Neutral (Chop 48.5%, Mean-Reverting 69.4%, edge only +2.1%) and matches the 2.48% BB squeeze at POC $65,450 with 0.72x volume and symmetrical 320B/335B walls at VAL/VAH. Stay disciplined—no mid-range chasing. Fade edges only: VAL Long at $64,400, SL $63,300 (risk $1,100 ~1.5x ATR), TP2 $66,820 (reward $2,420 = 1:2.2 R:R); VAH Short at $66,550, SL $67,650 (risk $1,100), TP2 $64,130 (reward $2,420 = 1:2.2 R:R).</think>\n${JSON.stringify(reportChop)}`,
      },
    ],
    meta: { kind: 'gold_report_deep', regime: 'ml_neutral_chop' },
  });

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkMlReportPrompt(65400, 720, ML_SNAP_NEUTRAL_CHOP) },
      { role: 'assistant', content: `<think></think>\n${JSON.stringify(reportChop)}` },
    ],
    meta: { kind: 'gold_report_fast', regime: 'ml_neutral_chop' },
  });

  // 4. Deep & Fast Report — High-Vol Flush Bearish Breakdown + OI Wipeout
  const reportFlush = {
    marketBias: 'Bearish',
    confidence: 76,
    marketRegime: 'High-Vol Flush / Breakdown Cascade',
    summary:
      'High-conviction bearish continuation: LightGBM 1H projects 59.5% Down (-37.4% edge) and 59.5% High-Vol Flush regime, confirmed by -6.8% OI deleveraging (-2.2σ), aggressive taker selling (39% buy, CVD -0.34), $19.4M long liquidations, and -20.3% ask-heavy book. Price sits below VAL ($60,200) across bearish 1H/4H/1D structure; widen stops (~1.7–2.0x ATR) and sell weak bounces into $59,600–$60,200 rather than shorting oversold 1H RSI (26.4) at the lows.',
    keyLevels: [
      { price: 60200, type: 'Resistance', strength: 'Strong', reason: 'Broken VAL + 360 BTC ask wall + 1H EMA21 ($60,210)' },
      { price: 59600, type: 'Liquidity Wall', strength: 'Moderate', reason: '245 BTC ask wall & 1H EMA9 ($59,480) bounce cap' },
      { price: 58000, type: 'Support', strength: 'Moderate', reason: '290 BTC resting bid wall below intraday low ($58,400)' },
      { price: 57200, type: 'Liquidity Wall', strength: 'Strong', reason: '380 BTC bid wall aligned with ML 12h lower envelope ($57,250)' },
    ],
    patterns: [
      {
        name: 'High-Vol Value Area Breakdown + Long Liquidation Cascade',
        bias: 'Bearish',
        status: 'Confirmed',
        confidence: 80,
        timeframe: '1h',
        targetPrice: 57200,
        invalidationPrice: 61200,
        description: '2.48x volume break below VAL ($60,200) with $19.4M long liquidations and -6.8% OI flush.',
      },
      {
        name: 'Oversold Reflex Bounce Risk (1H RSI 26.4)',
        bias: 'Neutral',
        status: 'Watch',
        confidence: 65,
        timeframe: '1h',
        targetPrice: 59800,
        invalidationPrice: 58000,
        description: 'Negative funding (-0.0092%) and stretched RSI can trigger sharp dead-cat bounces into $59,600–$60,200.',
      },
    ],
    tradeIdeas: [
      {
        title: 'Broken VAL / EMA21 Relief-Bounce Short',
        direction: 'Short',
        setupType: 'Breakdown Retest',
        entryLow: 59600,
        entryHigh: 60200,
        entryPrice: 59900,
        stopLoss: 61300,
        takeProfits: [58000, 56540],
        riskReward: '1:2.4',
        confidence: 76,
        rationale: 'Sells into 245B/360B ask walls at broken VAL aligned with 59.5% Down ML edge; wide 1.8x ATR SL ($1,400) absorbs High-Vol Flush wicks.',
        invalidation: '1H close above $61,300 reclaims POC ($61,400) and traps late shorts.',
      },
      {
        title: 'Capitulation Sweep Reclaim Long (Counter-Trend Only at $57.2K)',
        direction: 'Long',
        setupType: 'Liquidity Sweep Reclaim',
        entryLow: 57100,
        entryHigh: 57500,
        entryPrice: 57300,
        stopLoss: 55800,
        takeProfits: [59200, 60600],
        riskReward: '1:2.2',
        confidence: 56,
        rationale: 'Only valid if $57,200 (380B bid wall + ML lower envelope) prints a confirmed SFP reclaim after -0.0092% negative funding squeeze.',
        invalidation: '1H close below $55,800 breaks the 460B $56,000 support floor.',
      },
    ],
    confluence: {
      technical: ['1H/4H/1D bearish aligned below all MAs; 2.48x volume breakdown below VAL ($60,200)'],
      orderbook: ['-20.3% ask imbalance; 245B ($59,600) & 360B ($60,200) overhead ask walls; whale sells 214 vs 68 BTC'],
      derivatives: ['Quant-ML 1H: 59.5% Down & 59.5% High-Vol Flush', 'OI flush -6.8%, taker buy only 39% (CVD -0.34), $19.4M long liqs'],
    },
    riskWarning: 'Not financial advice. High-Vol Flush regime (ATR 1.82x normal) produces violent short-covering wicks; reduce position size and avoid chasing lows.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkMlReportPrompt(58920, 780, ML_SNAP_HIGHVOL_FLUSH) },
      {
        role: 'assistant',
        content: `<think>Quant-ML 1H is strongly bearish (59.5% Down, -37.4% edge) AND flags High-Vol Flush (59.5%), fully backed by -6.8% OI flush, 39% taker buying, -20.3% ask skew, and $19.4M long liquidations. However, 1H RSI is 26.4 and funding is -0.0092%, so shorting right at $58,920 risks a violent dead-cat bounce. Best risk-adjusted plan: short bounce into broken VAL/EMA21 at $59,900, wide 1.8x ATR SL at $61,300 (risk $1,400), TP2 $56,540 (reward $3,360 = 1:2.4 R:R). Secondary counter-trend sweep long only at $57,300 wall/ML envelope, SL $55,800 (risk $1,500), TP2 $60,600 (reward $3,300 = 1:2.2 R:R).</think>\n${JSON.stringify(reportFlush)}`,
      },
    ],
    meta: { kind: 'gold_report_deep', regime: 'ml_highvol_flush' },
  });

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkMlReportPrompt(58920, 780, ML_SNAP_HIGHVOL_FLUSH) },
      { role: 'assistant', content: `<think></think>\n${JSON.stringify(reportFlush)}` },
    ],
    meta: { kind: 'gold_report_fast', regime: 'ml_highvol_flush' },
  });

  // 5–8. Chat Gold Examples (Fast & Deep) — Direct ML + Orderflow Synthesis Q&A
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(ML_SNAP_CONFLICT_OVERRIDE) },
      { role: 'user', content: 'Quant-ML says Bullish (46.2% Up)—should I market long right now at $71,680?' },
      {
        role: 'assistant',
        content: `<think></think>\n**No—do not market long at $71,680.** Even though 4H Quant-ML leans Bullish (46.2% Up vs 31.0% Down), live orderflow strongly contradicts chasing here:\n- **Massive overhead wall:** 485 BTC ask wall sits just +0.4% higher at **$72,000** (followed by 340 BTC at $72,500), driving a **-27.9% ask-heavy book**.\n- **Perp-only crowding:** Funding is stretched at **+0.0380% (+2.4σ, 41.6% APR)** with **OI up +6.2%** while Spot volume share is only **21%** (Spot-vs-Perp CVD **-9.8%**).\n- **Better plan:** Wait for a pullback into **VAH ($69,900–$70,500)** where 260–310 BTC bid walls sit (SL **$68,400**, targeting **$72,400 / $74,520**), or only consider breakout longs after **$72,000** is cleanly absorbed on rising spot volume.`,
      },
    ],
    meta: { kind: 'gold_chat_fast', regime: 'ml_orderbook_conflict' },
  });

  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(ML_SNAP_CONFLICT_OVERRIDE) },
      { role: 'user', content: 'Why do the ML probabilities and the orderbook disagree right now?' },
      {
        role: 'assistant',
        content: `<think>Compare Layer-2 LightGBM 4H (46.2% Up, Trending 44%, driven by 4H/1D trend momentum above VAH) against real-time microstructure: 485B ask wall at $72,000, -27.9% book imbalance, +0.038% (+2.4σ) funding, +6.2% OI surge, and -9.8% Spot-vs-Perp CVD divergence. Explain cleanly why ML sees 48h trend persistence while orderflow warns of near-term flush first.</think>\nThey are measuring two different horizons:\n- **Why Quant-ML leans Bullish (46.2% Up, 48h horizon):** Higher-timeframe structure (4H + 1D cleanly above EMA21/MA50 and VAH $70,450) historically favors trend continuation over the next 48h.\n- **Why Orderflow flashes caution right now:** Resting liquidity at **$72,000 (485 BTC ask wall)**, **-27.9% book imbalance**, whale selling (**158.5 vs 74.0 BTC**), and **+0.0380% (+2.4σ) funding** on **21% spot share** show over-leveraged perp longs crowding directly into supply.\n- **Actionable synthesis:** Treat ML as your 48h directional bias (buy dips, not tops), and use the orderflow conflict to wait for a flush/reset into **$69,900–$70,500** before entering.`,
      },
    ],
    meta: { kind: 'gold_chat_deep', regime: 'ml_orderbook_conflict' },
  });

  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(ML_SNAP_CONFLUENCE_LONG) },
      { role: 'user', content: 'Does orderflow confirm the bullish Quant-ML signal here? Give me exact entry and SL.' },
      {
        role: 'assistant',
        content: `<think></think>\n**Yes—full 3-layer confirmation.**\n- **Quant-ML (1H, AUC 0.629):** **58.4% Up** (+38.0% edge, High conviction, Trending 61.5%, expected 12h range **$60,490–$62,350**).\n- **Orderflow & Derivatives:** **Spot is absorbing perp sells (+11.4% CVD div, 39% spot share)**, funding is negative (**-0.0045%, -1.9σ**), book is **+19.6% bid-heavy** (285B at $61,000, 340B at $60,500), and price confirmed a **bullish SFP** below $60,450.\n- **Trade Setup (Long):**\n  - **Entry Zone:** **$60,950 – $61,250** (POC + $61,000 bid wall)\n  - **Stop Loss:** **$60,250** (~1.9x ATR below VAL & SFP low)\n  - **Targets:** TP1 **$62,350** / TP2 **$63,200** (**1:2.5 R:R**)`,
      },
    ],
    meta: { kind: 'gold_chat_fast', regime: 'ml_confluence_long' },
  });

  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(ML_SNAP_HIGHVOL_FLUSH) },
      { role: 'user', content: 'How should I adjust risk management for this High-Vol Flush regime?' },
      {
        role: 'assistant',
        content: `<think></think>\nQuant-ML flags **59.5% High-Vol Flush** and **59.5% Down** alongside **ATR 1.82x normal ($780)**, **-6.8% OI deleveraging**, and **$19.4M long liquidations**—adjust risk immediately:\n- **Cut size by ~40–50%:** Wider stops are mandatory to survive liquidation wicks.\n- **Widen SL to 1.8–2.0x ATR (~$1,400):** Tight stops get wicked out on dead-cat bounces when 1H RSI is **26.4** and funding is **-0.0092%**.\n- **Do not short the low ($58,920):** Wait for a relief bounce into broken **VAL / EMA21 ($59,600–$60,200, 245B–360B ask walls)** with SL **$61,300**, targeting **$58,000 / $56,540** (**1:2.4 R:R**).`,
      },
    ],
    meta: { kind: 'gold_chat_fast', regime: 'ml_highvol_flush' },
  });

  return rows;
}
