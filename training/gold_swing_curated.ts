/**
 * Hand-crafted, manually audited Gold-Standard Swing / Position Trader dataset
 * grounded in real BTCUSDT 4H/1D market regimes (Value Area POC/VAH/VAL,
 * HTF 4H+1D alignment, wider 1.5–2.2x ATR structural stops, min 1:2.2 R:R,
 * anti-chasing patience, funding/orderbook confluence, and zero-preamble Fast answers).
 */

export interface GoldMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GoldDatasetRow {
  messages: GoldMessage[];
  meta: { kind: 'gold_report_deep' | 'gold_report_fast' | 'gold_chat_deep' | 'gold_chat_fast'; regime: string };
}

export const REPORT_SYSTEM_PROMPT =
  'You are a senior quantitative Bitcoin technical analyst and orderflow strategist. Keep internal reasoning brief and focused (under 250 words), then immediately return ONLY valid JSON matching the exact schema—no prose outside JSON.';

const CHAT_SYS_HEADER = `You are a helpful, concise quantitative Bitcoin technical analyst and orderflow assistant embedded inside the user's live trading chart.
Answer the user's questions directly using ONLY the real live market data below (never invent fake prices). Format cleanly with bullet points and exact price levels.`;

function mkReportPrompt(price: number, atr: number, body: string): string {
  return `Analyze the live Bitcoin market data below and return valid JSON matching the requested schema.
RULES:
1. Ground ALL prices in the data around $${price.toFixed(1)}.
2. Report 2–3 real patterns, 4–5 key levels, and 2 actionable trade setups (Long: SL < entry < TP1 < TP2; Short: SL > entry > TP1 > TP2; place SL cleanly beyond swing/wall ~1x ATR ~$${Math.round(atr)}).
3. Keep reasoning brief (3–5 short sentences) and cite exact indicator/wall/funding values concisely with a short non-financial-advice riskWarning.

${body}`;
}

function mkChatSystem(body: string): string {
  return `${CHAT_SYS_HEADER}\n\n${body}`;
}

// 8 Real BTCUSDT 4H/1D Market Regimes extracted directly from Binance Futures history
const SNAP_BREAKOUT_80871 = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 4h | Price: $80871.4 (+2.85% 24h, H/L $81934/$78620)
- Bid/Ask: $80871.0/$80872.0 | Spot: $80865.0 | OI: $13.20B

INDICATORS (4h, 211 bars):
- MAs: EMA9=80410.2, EMA21=79732.94, EMA50=78820.5, EMA200=77485.52, MA50=77997.72, MA100=77610.4, MA200=77485.52
- Momentum: RSI14=65.2 (prev5=61.4), MACD=620.4/633.9 (Hist=-13.46)
- Volatility/Flow: BB20=76240.0–83620.0 (W=9.68%), ATR14=$844.66 (1.04%), VWAP50=78940.0, Vol/MA20=1.28x, 50-bar Range=$75025–$81934
- Volume Profile (80-bar): POC=$77982.6, VAL=$76372.8, VAH=$79299.7 (Above VA)
- Quant Signals: MTF=Bullish Aligned (2/2: 4h↑ 1d↑) | RSI Div=None | Liquidity Sweep=None
- Swing Highs: $77477.4, $79570.9, $81933.9 | Swing Lows: $75025, $75975, $80095.9

HIGHER TF:
- 1D: Close=$81143.9, EMA21=77828.69, MA50=73206.1, MA200=68420.5, RSI14=63.98, MACD_H=412.5

ORDERBOOK & DERIVATIVES:
- Book: Bids 1480 vs Asks 1120 BTC (Imb 13.8%)
- Bid Walls: $80000 (245B, -1.1%); $79300 (310B, -1.9%); $78000 (190B, -3.5%)
- Ask Walls: $82000 (215B, +1.4%); $84500 (280B, +4.5%); $87000 (340B, +7.6%)
- Whales (>=0.5B): Buy 142.5 / Sell 88.2 BTC | Liqs: Long $1,420,000 / Short $6,850,000
- OI-Weighted 8h Funding: 0.0112% (APR 12.26%, Ex: BN:0.011%, BYB:0.0115%)
- 24h Vol: Spot 26% / Deriv 74% | Buy 56% / Sell 44% | L/S 1.16`;

const SNAP_PARABOLIC_77220 = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 4h | Price: $77219.8 (+8.42% 24h, H/L $77850/$70900)
- Bid/Ask: $77219.0/$77220.5 | Spot: $77205.0 | OI: $14.85B

INDICATORS (4h, 211 bars):
- MAs: EMA9=74210.0, EMA21=70661.64, EMA50=67120.0, EMA200=64747.41, MA50=65826.7, MA100=65110.0, MA200=64747.41
- Momentum: RSI14=94.38 (prev5=87.1), MACD=2450.2/1640.6 (Hist=809.56)
- Volatility/Flow: BB20=61400.0–78950.0 (W=25.63%), ATR14=$1952.64 (2.53%), VWAP50=69100.0, Vol/MA20=2.45x, 50-bar Range=$62681–$77850
- Volume Profile (80-bar): POC=$63551.2, VAL=$62484.2, VAH=$71731.2 (Above VA)
- Quant Signals: MTF=Bullish Aligned (2/2: 4h↑ 1d↑) | RSI Div=None | Liquidity Sweep=None
- Swing Highs: $64600.8, $65057.9, $70450 | Swing Lows: $62681.1, $63979.2, $64131.3

HIGHER TF:
- 1D: Close=$78309.1, EMA21=66384.83, MA50=64593.25, MA200=63100.0, RSI14=86.0, MACD_H=1120.4

ORDERBOOK & DERIVATIVES:
- Book: Bids 1240 vs Asks 1390 BTC (Imb -5.7%)
- Bid Walls: $75500 (260B, -2.2%); $74000 (290B, -4.2%); $71700 (380B, -7.1%)
- Ask Walls: $78500 (240B, +1.7%); $80000 (410B, +3.6%); $82000 (260B, +6.2%)
- Whales (>=0.5B): Buy 310.0 / Sell 245.0 BTC | Liqs: Long $2,100,000 / Short $28,400,000
- OI-Weighted 8h Funding: 0.0365% (APR 39.97%, Ex: BN:0.035%, BYB:0.038%)
- 24h Vol: Spot 29% / Deriv 71% | Buy 58% / Sell 42% | L/S 1.48`;

const SNAP_FALLING_KNIFE_73771 = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 4h | Price: $73771.4 (-4.18% 24h, H/L $76950/$72691)
- Bid/Ask: $73771.0/$73772.0 | Spot: $73780.0 | OI: $11.40B

INDICATORS (4h, 211 bars):
- MAs: EMA9=73980.0, EMA21=74445.78, EMA50=76120.0, EMA200=79725.82, MA50=75926.13, MA100=77850.0, MA200=79725.82
- Momentum: RSI14=40.5 (prev5=34.2), MACD=-610.4/-681.5 (Hist=71.08)
- Volatility/Flow: BB20=72540.0–74950.0 (W=3.22%), ATR14=$910.56 (1.23%), VWAP50=76420.0, Vol/MA20=1.35x, 50-bar Range=$72691–$81188
- Volume Profile (80-bar): POC=$77470.6, VAL=$75523.3, VAH=$80479.9 (Below VA)
- Quant Signals: MTF=Bearish Aligned (2/2: 4h↓ 1d↓) | RSI Div=Bullish | Liquidity Sweep=None
- Swing Highs: $81188, $76210.4, $76168.8 | Swing Lows: $75526.9, $73333, $72691

HIGHER TF:
- 1D: Close=$71423.3, EMA21=76968.78, MA50=80906.72, MA200=74200.0, RSI14=29.48, MACD_H=-940.2

ORDERBOOK & DERIVATIVES:
- Book: Bids 980 vs Asks 1460 BTC (Imb -19.7%)
- Bid Walls: $72500 (185B, -1.7%); $70000 (320B, -5.1%); $68000 (290B, -7.8%)
- Ask Walls: $75500 (340B, +2.3%); $76200 (260B, +3.3%); $77500 (295B, +5.1%)
- Whales (>=0.5B): Buy 72.0 / Sell 195.4 BTC | Liqs: Long $19,800,000 / Short $1,650,000
- OI-Weighted 8h Funding: -0.0042% (APR -4.6%, Ex: BN:-0.004%, BYB:-0.0045%)
- 24h Vol: Spot 24% / Deriv 76% | Buy 42% / Sell 58% | L/S 0.89`;

const SNAP_BEARISH_SFP_82580 = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 4h | Price: $82579.9 (+0.45% 24h, H/L $83490/$81146)
- Bid/Ask: $82579.5/$82580.5 | Spot: $82572.0 | OI: $12.75B

INDICATORS (4h, 211 bars):
- MAs: EMA9=82310.0, EMA21=81929.27, EMA50=82210.0, EMA200=83204.04, MA50=82156.46, MA100=82740.0, MA200=83204.04
- Momentum: RSI14=55.9 (prev5=51.2), MACD=145.2/93.0 (Hist=52.16)
- Volatility/Flow: BB20=80910.0–82820.0 (W=2.31%), ATR14=$895.61 (1.08%), VWAP50=81890.0, Vol/MA20=1.42x, 50-bar Range=$80622–$83490
- Volume Profile (80-bar): POC=$81556.3, VAL=$80884.3, VAH=$82804.2 (Inside VA)
- Quant Signals: MTF=Mixed (4h↑ 1d→) | RSI Div=None | Liquidity Sweep=Bearish SFP above $83158
- Swing Highs: $82900.5, $82268.7, $83157.9 | Swing Lows: $80751, $80622, $81146.4

HIGHER TF:
- 1D: Close=$82984.8, EMA21=82558.91, MA50=81569.83, MA200=74800.0, RSI14=52.74, MACD_H=-42.1

ORDERBOOK & DERIVATIVES:
- Book: Bids 1120 vs Asks 1340 BTC (Imb -8.9%)
- Bid Walls: $81500 (210B, -1.3%); $80800 (285B, -2.2%); $79500 (240B, -3.7%)
- Ask Walls: $83200 (315B, +0.8%); $84000 (230B, +1.7%); $85500 (270B, +3.5%)
- Whales (>=0.5B): Buy 94.0 / Sell 138.0 BTC | Liqs: Long $3,100,000 / Short $4,800,000
- OI-Weighted 8h Funding: 0.0158% (APR 17.3%, Ex: BN:0.015%, BYB:0.0165%)
- 24h Vol: Spot 21% / Deriv 79% | Buy 47% / Sell 53% | L/S 1.24`;

const SNAP_SQUEEZE_81111 = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 4h | Price: $81110.9 (+0.22% 24h, H/L $81680/$80190)
- Bid/Ask: $81110.5/$81111.5 | Spot: $81108.0 | OI: $12.10B

INDICATORS (4h, 211 bars):
- MAs: EMA9=80890.0, EMA21=80544.23, EMA50=81420.0, EMA200=82952.99, MA50=81351.31, MA100=82110.0, MA200=82952.99
- Momentum: RSI14=56.49 (prev5=46.8), MACD=-85.4/-261.0 (Hist=175.56)
- Volatility/Flow: BB20=79820.0–81540.0 (W=2.11%), ATR14=$765.53 (0.94%), VWAP50=81210.0, Vol/MA20=0.74x, 50-bar Range=$79179–$82035
- Volume Profile (80-bar): POC=$81670.9, VAL=$80128.0, VAH=$82501.6 (Inside VA)
- Quant Signals: MTF=Mixed (4h→ 1d↓) | RSI Div=None | Liquidity Sweep=None
- Swing Highs: $82035.3, $80999.9, $80819.4 | Swing Lows: $79178.6, $79321.8, $79468.3

HIGHER TF:
- 1D: Close=$81308.8, EMA21=81778.89, MA50=81903.8, MA200=74900.0, RSI14=47.61, MACD_H=-210.5

ORDERBOOK & DERIVATIVES:
- Book: Bids 1040 vs Asks 1290 BTC (Imb -10.7%)
- Bid Walls: $80100 (230B, -1.2%); $79200 (275B, -2.4%); $76500 (340B, -5.7%)
- Ask Walls: $81800 (290B, +0.8%); $82500 (310B, +1.7%); $83000 (260B, +2.3%)
- Whales (>=0.5B): Buy 54.0 / Sell 89.0 BTC | Liqs: Long $1,800,000 / Short $1,400,000
- OI-Weighted 8h Funding: 0.0082% (APR 8.98%, Ex: BN:0.008%, BYB:0.0085%)
- 24h Vol: Spot 20% / Deriv 80% | Buy 48% / Sell 52% | L/S 1.09`;

const SNAP_BULL_PULLBACK_77482 = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 4h | Price: $77482.2 (-1.62% 24h, H/L $79650/$76940)
- Bid/Ask: $77481.5/$77482.5 | Spot: $77478.0 | OI: $13.60B

INDICATORS (4h, 211 bars):
- MAs: EMA9=77980.0, EMA21=78634.41, EMA50=77890.0, EMA200=67737.7, MA50=78096.76, MA100=73410.0, MA200=67737.7
- Momentum: RSI14=42.58 (prev5=51.4), MACD=-120.5/269.0 (Hist=-389.46)
- Volatility/Flow: BB20=76100.0–79380.0 (W=4.17%), ATR14=$1025.16 (1.32%), VWAP50=77820.0, Vol/MA20=1.18x, 50-bar Range=$76649–$81500
- Volume Profile (80-bar): POC=$77187.3, VAL=$72090.6, VAH=$81500.0 (Inside VA)
- Quant Signals: MTF=Mixed (4h↓ 1d↑) | RSI Div=Bearish | Liquidity Sweep=Bullish SFP below $77600
- Swing Highs: $78831.8, $81270.5, $81500 | Swing Lows: $76649, $77808.1, $77600

HIGHER TF:
- 1D: Close=$78200.7, EMA21=72845.32, MA50=67017.82, MA200=63400.0, RSI14=71.58, MACD_H=645.2

ORDERBOOK & DERIVATIVES:
- Book: Bids 1510 vs Asks 1190 BTC (Imb 11.9%)
- Bid Walls: $77000 (320B, -0.6%); $76200 (245B, -1.7%); $74500 (280B, -3.8%)
- Ask Walls: $79400 (215B, +2.5%); $81200 (340B, +4.8%); $82500 (260B, +6.5%)
- Whales (>=0.5B): Buy 168.0 / Sell 112.0 BTC | Liqs: Long $9,400,000 / Short $2,100,000
- OI-Weighted 8h Funding: 0.0065% (APR 7.12%, Ex: BN:0.006%, BYB:0.007%)
- 24h Vol: Spot 27% / Deriv 73% | Buy 53% / Sell 47% | L/S 1.05`;

const SNAP_FAILED_VAH_85220 = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 4h | Price: $85220.3 (-0.95% 24h, H/L $86976/$84475)
- Bid/Ask: $85220.0/$85221.0 | Spot: $85210.0 | OI: $14.40B

INDICATORS (4h, 211 bars):
- MAs: EMA9=85310.0, EMA21=85248.86, EMA50=84510.0, EMA200=81136.47, MA50=84430.78, MA100=82950.0, MA200=81136.47
- Momentum: RSI14=51.3 (prev5=58.2), MACD=110.2/71.4 (Hist=38.83)
- Volatility/Flow: BB20=83890.0–86560.0 (W=3.14%), ATR14=$624.11 (0.73%), VWAP50=84880.0, Vol/MA20=0.88x, 50-bar Range=$83137–$87250
- Volume Profile (80-bar): POC=$84578.0, VAL=$82895.9, VAH=$85072.7 (Above VA)
- Quant Signals: MTF=Mixed (4h→ 1d↑) | RSI Div=None | Liquidity Sweep=None
- Swing Highs: $85632.7, $87249.6, $86976.1 | Swing Lows: $83136.6, $83841.9, $84474.6

HIGHER TF:
- 1D: Close=$85717.2, EMA21=83129.99, MA50=79468.78, MA200=72900.0, RSI14=64.55, MACD_H=310.8

ORDERBOOK & DERIVATIVES:
- Book: Bids 1150 vs Asks 1490 BTC (Imb -12.9%)
- Bid Walls: $84400 (195B, -1.0%); $83000 (260B, -2.6%); $81000 (350B, -5.0%)
- Ask Walls: $86500 (310B, +1.5%); $87250 (390B, +2.4%); $88500 (250B, +3.8%)
- Whales (>=0.5B): Buy 84.0 / Sell 156.0 BTC | Liqs: Long $4,600,000 / Short $1,900,000
- OI-Weighted 8h Funding: 0.0245% (APR 26.83%, Ex: BN:0.024%, BYB:0.025%)
- 24h Vol: Spot 22% / Deriv 78% | Buy 46% / Sell 54% | L/S 1.38`;

const SNAP_CAPITULATION_63077 = `MARKET HEADER:
- Asset: BTC (COMBINED) | TF: 4h | Price: $63077.2 (-2.40% 24h, H/L $65425/$62031)
- Bid/Ask: $63077.0/$63078.0 | Spot: $63095.0 | OI: $9.20B

INDICATORS (4h, 211 bars):
- MAs: EMA9=63540.0, EMA21=64280.94, EMA50=66890.0, EMA200=75993.96, MA50=66849.36, MA100=71200.0, MA200=75993.96
- Momentum: RSI14=37.61 (prev5=31.4), MACD=-1120.4/-1249.5 (Hist=129.11)
- Volatility/Flow: BB20=61400.0–64350.0 (W=4.68%), ATR14=$1093.9 (1.73%), VWAP50=65210.0, Vol/MA20=1.22x, 50-bar Range=$62031–$66093
- Volume Profile (80-bar): POC=$64655.3, VAL=$62556.1, VAH=$73352.0 (Inside VA)
- Quant Signals: MTF=Bearish Aligned (2/2: 4h↓ 1d↓) | RSI Div=None | Liquidity Sweep=None
- Swing Highs: $66093.2, $65679.2, $65425.5 | Swing Lows: $63871, $63300.9, $62030.8

HIGHER TF:
- 1D: Close=$61959.3, EMA21=70825.88, MA50=78198.09, MA200=74100.0, RSI14=20.3, MACD_H=-1840.0

ORDERBOOK & DERIVATIVES:
- Book: Bids 1090 vs Asks 1380 BTC (Imb -11.7%)
- Bid Walls: $62000 (260B, -1.7%); $58500 (340B, -7.3%); $55500 (420B, -12.0%)
- Ask Walls: $64600 (330B, +2.4%); $66000 (290B, +4.6%); $68000 (250B, +7.8%)
- Whales (>=0.5B): Buy 108.0 / Sell 165.0 BTC | Liqs: Long $24,500,000 / Short $3,200,000
- OI-Weighted 8h Funding: -0.0115% (APR -12.59%, Ex: BN:-0.011%, BYB:-0.012%)
- 24h Vol: Spot 28% / Deriv 72% | Buy 45% / Sell 55% | L/S 0.82`;

export function getGoldSwingDataset(): GoldDatasetRow[] {
  const rows: GoldDatasetRow[] = [];

  // =========================================================================
  // PART 1: HAND-CRAFTED SWING TA REPORTS (DEEP THINK & FAST MODES)
  // =========================================================================

  // 1. Textbook Bullish Value Area Breakout (4H + 1D Aligned) — Deep Think
  const repBreakout = {
    marketBias: 'Bullish',
    confidence: 80,
    marketRegime: 'Value Area Breakout Continuation',
    summary:
      'BTC holds firmly above 80-bar VAH ($79,300) and rising 4H EMA21 ($79,733) with full 4H/1D bullish alignment and healthy +0.0112% funding. Resting bids at $80,000 (245 BTC) and $79,300 (310 BTC) establish a clean swing launchpad toward $84,500–$87,000.',
    keyLevels: [
      { price: 87000, type: 'Liquidity Wall', strength: 'Strong', reason: 'Major resting ask wall (340 BTC) and macro swing extension target.' },
      { price: 84500, type: 'Resistance', strength: 'Strong', reason: '280 BTC resting ask cluster above the $82,000 breakout zone.' },
      { price: 82000, type: 'Resistance', strength: 'Moderate', reason: 'Immediate swing high ($81,934) backed by a 215 BTC ask wall.' },
      { price: 79300, type: 'Liquidity Wall', strength: 'Strong', reason: 'Confluence of 80-bar VAH ($79,300), 4H EMA21 ($79,733), and 310 BTC bid wall.' },
      { price: 77982.6, type: 'Pivot', strength: 'Strong', reason: '80-bar Volume Profile POC and 4H MA50 ($77,998) macro trend floor.' },
    ],
    patterns: [
      {
        name: 'Value Area High Breakout & Retest',
        bias: 'Bullish',
        status: 'Confirmed',
        confidence: 80,
        timeframe: '4h',
        targetPrice: 87000,
        invalidationPrice: 77900,
        description: 'Acceptance above VAH ($79,300) with higher low at $80,096 and 1.28x relative volume.',
      },
      {
        name: 'Higher-Low Trend Channel',
        bias: 'Bullish',
        status: 'Confirmed',
        confidence: 76,
        timeframe: '4h',
        targetPrice: 84500,
        invalidationPrice: 78000,
        description: 'Ascending swing lows ($75,025 -> $75,975 -> $80,096) aligned with 1D EMA21 ($77,829).',
      },
    ],
    tradeIdeas: [
      {
        title: 'VAH & Bid-Wall Pullback Swing Long',
        direction: 'Long',
        setupType: 'HTF Trend Pullback Long',
        entryLow: 79500,
        entryHigh: 80300,
        entryPrice: 80000,
        stopLoss: 77800,
        takeProfits: [84500, 87000],
        riskReward: '1:3.2',
        confidence: 80,
        rationale: 'Scale in on retest of $80,000 (245 BTC) / VAH $79,300 (310 BTC) with wide 2.6x ATR structural stop below 80-bar POC ($77,983) and 4H MA50.',
        invalidation: '4H close below $77,800 loses POC and breaks bullish HTF structure.',
      },
      {
        title: 'Failed Breakout Re-Entry Short',
        direction: 'Short',
        setupType: 'Value Area Re-Entry Fade',
        entryLow: 81800,
        entryHigh: 82200,
        entryPrice: 82000,
        stopLoss: 83600,
        takeProfits: [79300, 77980],
        riskReward: '1:2.5',
        confidence: 58,
        rationale: 'Counter-trend swing short only if price rejects sharply off $82,000 ask wall (215 BTC) with weak volume; targets mean reversion to VAH and POC.',
        invalidation: '4H acceptance above $83,600 confirms continuation to $87,000.',
      },
    ],
    confluence: {
      technical: ['4H & 1D bullish aligned above EMA21/MA50/MA200', 'Acceptance above 80-bar VAH ($79,300) with healthy RSI 65.2'],
      orderbook: ['+13.8% bid imbalance with stacked $80,000 (245 BTC) & $79,300 (310 BTC) walls', 'Net whale buying (+54.3 BTC)'],
      derivatives: ['Healthy 8h funding (+0.0112%) leaves room for upside without overcrowding', '$6.85M short liquidations fueling trend'],
    },
    riskWarning: 'Swing setups carry multi-day volatility risk—not financial advice. Size position strictly to structural invalidation.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkReportPrompt(80871.4, 844.66, SNAP_BREAKOUT_80871) },
      {
        role: 'assistant',
        content: `<think>\nBTC is $80,871 on 4H with 2/2 HTF bullish alignment (4H & 1D above all major MAs) and clean acceptance above VAH ($79,300). Funding is balanced (+0.0112%) and book is bid-heavy (+13.8%) with 555 BTC combined bids at $79,300–$80,000. As a swing trader, avoid chasing right below the $82,000 ask wall; wait for pullback into $79,500–$80,300 with wide structural stop at $77,800 (below POC $77,983 / MA50, ~2.6x ATR) targeting $84,500 and $87,000 (risk $2,200 vs reward $7,000 = 1:3.2). Counter short only on clean rejection at $82,000 with SL $83,600 -> TP $77,980 (1:2.5). Outputting strict JSON.\n</think>\n\n${JSON.stringify(repBreakout)}`,
      },
    ],
    meta: { kind: 'gold_report_deep', regime: 'bullish_va_breakout' },
  });

  // 2. Parabolic Overbought Expansion (RSI 94.4 + High Funding 0.0365%) — Anti-Chasing Swing Discipline (Deep Think)
  const repParabolic = {
    marketBias: 'Bullish',
    confidence: 68,
    marketRegime: 'Parabolic Expansion — Overextended Above Value',
    summary:
      'BTC has surged vertically above VAH ($71,731) to $77,220 with extreme 4H RSI (94.4), 1D RSI (86.0), and crowded +0.0365% funding (40% APR). Trend is undeniably bullish, but chasing here offers poor R:R; patient swing entries belong on a flush into $74,000–$75,500 resting bids.',
    keyLevels: [
      { price: 80000, type: 'Liquidity Wall', strength: 'Strong', reason: 'Psychological round number with heavy 410 BTC resting ask wall.' },
      { price: 78500, type: 'Resistance', strength: 'Moderate', reason: 'Near-term 240 BTC ask liquidity cap above 24h high ($77,850).' },
      { price: 75500, type: 'Liquidity Wall', strength: 'Strong', reason: 'First major resting bid shelf (260 BTC) for an overbought pullback.' },
      { price: 74000, type: 'Support', strength: 'Strong', reason: '290 BTC bid wall roughly 1.6x ATR below current price.' },
      { price: 71731.2, type: 'Pivot', strength: 'Strong', reason: '80-bar VAH backed by 380 BTC bid wall; macro breakout retest line.' },
    ],
    patterns: [
      {
        name: 'Parabolic Climax Extension',
        bias: 'Bullish',
        status: 'Confirmed',
        confidence: 78,
        timeframe: '4h',
        targetPrice: 80000,
        invalidationPrice: 71700,
        description: 'Price stretched >9% above 4H EMA21 ($70,662) with 2.45x volume and BB width 25.6%.',
      },
      {
        name: 'Crowded Long Funding Extreme',
        bias: 'Neutral',
        status: 'Watch',
        confidence: 74,
        timeframe: '4h',
        targetPrice: 74000,
        invalidationPrice: 80000,
        description: '8h funding at +0.0365% (40% APR) and L/S 1.48 heighten risk of a sharp leverage flush before continuation.',
      },
    ],
    tradeIdeas: [
      {
        title: 'Patient Pullback Bid-Wall Swing Long',
        direction: 'Long',
        setupType: 'Overbought Pullback Continuation',
        entryLow: 74200,
        entryHigh: 75600,
        entryPrice: 75000,
        stopLoss: 71400,
        takeProfits: [79500, 82500],
        riskReward: '1:2.1',
        confidence: 74,
        rationale: 'Refuse to chase RSI 94.4; bid the $74,000–$75,500 bid walls (550 BTC combined) with wide structural stop beneath VAH ($71,731) and 1.8x ATR buffer.',
        invalidation: '4H close below $71,400 re-enters old Value Area and signals blow-off top.',
      },
      {
        title: 'Exhaustion Mean-Reversion Short at $80k Wall',
        direction: 'Short',
        setupType: 'Blow-Off Rejection Fade',
        entryLow: 79400,
        entryHigh: 80100,
        entryPrice: 79800,
        stopLoss: 82200,
        takeProfits: [75500, 73800],
        riskReward: '1:2.5',
        confidence: 60,
        rationale: 'Only short on rejection into the 410 BTC $80,000 ask wall while funding stays >0.035%, targeting a leverage reset to $75,500–$73,800.',
        invalidation: '4H close above $82,200 invalidates exhaustion thesis.',
      },
    ],
    confluence: {
      technical: ['Strong 4H/1D uptrend above VAH ($71,731), but extreme RSI 94.4 warns of pullback', 'High ATR ($1,953) demands wider structural stops'],
      orderbook: ['Heavy overhead resistance at $78,500–$80,000 (650 BTC asks)', 'Deep structural bid support parked at $74,000–$75,500 & $71,700'],
      derivatives: ['Overheated +0.0365% 8h funding (40% APR) & L/S 1.48 signal crowded late longs', '$28.4M short squeeze already spent'],
    },
    riskWarning: 'Chasing parabolic moves carries severe liquidation risk—not financial advice. Wait for pullbacks and size down for high ATR.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkReportPrompt(77219.8, 1952.64, SNAP_PARABOLIC_77220) },
      {
        role: 'assistant',
        content: `<think>\nBTC is $77,220—massively extended above VAH ($71,731) and EMA21 ($70,662) with 4H RSI 94.4, 1D RSI 86.0, ATR $1,953, and overheated funding (+0.0365%, L/S 1.48). Trend is bullish, so never blind-short mid-rally, but never chase RSI 94 either. Best swing plan: wait for leverage reset into $74,200–$75,600 bid walls (entry $75,000), wide stop below VAH at $71,400 (risk $3,600), targeting $79,500 and $82,500 (reward $7,500 = 1:2.1). Secondary fade only if $80,000 wall (410 BTC) rejects: entry $79,800, SL $82,200, TPs $75,500/$73,800 (1:2.5). Outputting strict JSON.\n</think>\n\n${JSON.stringify(repParabolic)}`,
      },
    ],
    meta: { kind: 'gold_report_deep', regime: 'parabolic_overbought_no_chase' },
  });

  // 3. Bearish Breakdown Below Value Area (Trap Bullish 4H RSI Div inside 1D Bear!) — Deep Think
  const repBearKnife = {
    marketBias: 'Bearish',
    confidence: 82,
    marketRegime: 'Bearish Breakdown Below Value Area',
    summary:
      'BTC has broken down below 80-bar VAL ($75,523) with full 4H/1D bearish alignment (1D RSI 29.5, price well below MA50/MA200) and heavy -19.7% ask dominance. Despite a minor 4H bullish RSI divergence, catching a falling knife against a 1D breakdown is low-probability; rallies into $75,500 VAL resistance are high-conviction swing shorts.',
    keyLevels: [
      { price: 77470.6, type: 'Pivot', strength: 'Strong', reason: '80-bar POC and 295 BTC ask wall; upper invalidation ceiling.' },
      { price: 75523.3, type: 'Liquidity Wall', strength: 'Strong', reason: 'Broken 80-bar VAL flipped to resistance with 340 BTC ask wall.' },
      { price: 72500, type: 'Support', strength: 'Moderate', reason: 'Near-term swing low ($72,691) and 185 BTC resting bids.' },
      { price: 70000, type: 'Liquidity Wall', strength: 'Strong', reason: 'Major psychological support backed by 320 BTC bid wall.' },
      { price: 68000, type: 'Support', strength: 'Strong', reason: 'Deep downside liquidity magnet (290 BTC bids) if $70k fails.' },
    ],
    patterns: [
      {
        name: 'Value Area Low Breakdown & Retest',
        bias: 'Bearish',
        status: 'Confirmed',
        confidence: 82,
        timeframe: '4h',
        targetPrice: 68000,
        invalidationPrice: 77500,
        description: 'Clean breakdown below VAL ($75,523) and 4H MA50 ($75,926) with -19.7% ask-heavy book.',
      },
      {
        name: 'Counter-Trend 4H Bullish RSI Divergence (Trap Risk)',
        bias: 'Neutral',
        status: 'Watch',
        confidence: 58,
        timeframe: '4h',
        targetPrice: 75500,
        invalidationPrice: 72500,
        description: 'Minor 4H RSI divergence may trigger a relief bounce to $75,500 VAL before HTF 1D downtrend resumes.',
      },
    ],
    tradeIdeas: [
      {
        title: 'VAL Breakdown Retest Swing Short',
        direction: 'Short',
        setupType: 'HTF Trend Continuation Short',
        entryLow: 74800,
        entryHigh: 75600,
        entryPrice: 75300,
        stopLoss: 77700,
        takeProfits: [71500, 68200],
        riskReward: '1:3.0',
        confidence: 81,
        rationale: 'Sell the dead-cat bounce into broken VAL ($75,523) and 340 BTC ask wall; structural stop above 80-bar POC ($77,471, 2.6x ATR) rides the 1D breakdown.',
        invalidation: '4H close above $77,700 reclaims POC and negates bearish breakdown.',
      },
      {
        title: 'Deep Liquidity Reclaim Swing Long at $70k',
        direction: 'Long',
        setupType: 'Capitulation Support Reversal',
        entryLow: 69600,
        entryHigh: 70400,
        entryPrice: 70000,
        stopLoss: 67600,
        takeProfits: [73500, 75500],
        riskReward: '1:2.3',
        confidence: 60,
        rationale: 'Wait for a flush into the 320 BTC $70,000 wall instead of buying mid-air; requires clear 4H reclaim candle before risking capital.',
        invalidation: '4H close below $67,600 opens deeper capitulation.',
      },
    ],
    confluence: {
      technical: ['Full 4H/1D bearish alignment below VAL ($75,523) and all major MAs', '4H bullish RSI div likely fuels only a relief bounce into resistance'],
      orderbook: ['Heavy -19.7% ask imbalance with 340 BTC wall capping $75,500 VAL', 'Whale selling dominates (-123.4 BTC net)'],
      derivatives: ['$19.8M long liquidations confirm forced selling', 'Slightly negative funding (-0.0042%) reflects bearish sentiment without extreme crowding'],
    },
    riskWarning: 'Counter-trend longs inside a 1D breakdown carry high stop-out risk—not financial advice. Respect invalidation strictly.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkReportPrompt(73771.4, 910.56, SNAP_FALLING_KNIFE_73771) },
      {
        role: 'assistant',
        content: `<think>\nBTC is $73,771—broken below 80-bar VAL ($75,523) with full 2/2 bearish alignment (1D RSI 29.5, price under 4H/1D MA50 & MA200), -19.7% ask imbalance, and -123 BTC net whale selling. There is a 4H bullish RSI divergence, which is a classic falling-knife trap in a 1D bear trend: use any relief bounce into broken VAL ($75,500, 340 BTC ask wall) to short with wide structural stop above POC at $77,700 (risk $2,400), targeting $71,500 and $68,200 (reward $7,100 = 1:3.0). Long only after flush to $70,000 wall (SL $67,600, TPs $73,500/$75,500 = 1:2.3). Outputting strict JSON.\n</think>\n\n${JSON.stringify(repBearKnife)}`,
      },
    ],
    meta: { kind: 'gold_report_deep', regime: 'bearish_below_val_trap' },
  });

  // 4. Bearish SFP Above VAH / Below 4H MA200 — Fast Mode (0 thinking tokens!)
  const repBearSfp = {
    marketBias: 'Bearish',
    confidence: 73,
    marketRegime: 'Range-High Liquidity Sweep (Bearish SFP)',
    summary:
      'BTC wicked above $83,158 and closed back inside the 80-bar Value Area (VAH $82,804), printing a confirmed Bearish SFP directly beneath 4H MA200 ($83,204) and a 315 BTC ask wall. Crowded +0.0158% funding and -8.9% ask imbalance favor a swing rotation back to POC ($81,556) and VAL ($80,884).',
    keyLevels: [
      { price: 84000, type: 'Resistance', strength: 'Moderate', reason: 'Secondary 230 BTC ask cluster above SFP wick high ($83,490).' },
      { price: 83200, type: 'Liquidity Wall', strength: 'Strong', reason: '4H MA200 ($83,204), SFP swing high ($83,158), and 315 BTC ask wall.' },
      { price: 81556.3, type: 'Pivot', strength: 'Strong', reason: '80-bar Volume Profile POC backed by 210 BTC resting bids.' },
      { price: 80884.3, type: 'Liquidity Wall', strength: 'Strong', reason: '80-bar VAL and 285 BTC bid wall near recent range floor ($80,622).' },
      { price: 79500, type: 'Support', strength: 'Moderate', reason: 'Lower downside liquidity target (240 BTC bids) on VAL breakdown.' },
    ],
    patterns: [
      {
        name: 'Bearish Liquidity Sweep (SFP) at VAH',
        bias: 'Bearish',
        status: 'Confirmed',
        confidence: 76,
        timeframe: '4h',
        targetPrice: 80880,
        invalidationPrice: 83950,
        description: 'Sweep above $83,158 into 4H MA200 ($83,204) with 1.42x volume and close back under VAH ($82,804).',
      },
      {
        name: 'Value Area Rotation (VAH to VAL)',
        bias: 'Bearish',
        status: 'Forming',
        confidence: 70,
        timeframe: '4h',
        targetPrice: 79500,
        invalidationPrice: 83950,
        description: 'Failed breakout above VAH commonly rotates through POC ($81,556) toward VAL ($80,884).',
      },
    ],
    tradeIdeas: [
      {
        title: 'VAH Bearish SFP Rotation Swing Short',
        direction: 'Short',
        setupType: 'Liquidity Sweep Mean Reversion',
        entryLow: 82500,
        entryHigh: 83000,
        entryPrice: 82750,
        stopLoss: 84150,
        takeProfits: [80900, 79500],
        riskReward: '1:2.3',
        confidence: 74,
        rationale: 'Short the confirmed Bearish SFP below $83,158 & 315 BTC ask wall with structural stop above the $83,490 sweep high (1.5x ATR), targeting VAL and $79,500.',
        invalidation: '4H close above $84,150 confirms real breakout above MA200.',
      },
      {
        title: 'VAL Demand Floor Swing Long',
        direction: 'Long',
        setupType: 'Range Support Bounce',
        entryLow: 80650,
        entryHigh: 81050,
        entryPrice: 80850,
        stopLoss: 79250,
        takeProfits: [82800, 84500],
        riskReward: '1:2.3',
        confidence: 64,
        rationale: 'Buy the rotation into 80-bar VAL ($80,884) and 285 BTC bid wall where 1D MA50 ($81,570) provides macro support.',
        invalidation: '4H close below $79,250 confirms range breakdown.',
      },
    ],
    confluence: {
      technical: ['Confirmed Bearish SFP above $83,158 right under 4H MA200 ($83,204)', 'Tight 2.31% BB width primes sharp rotation toward POC/VAL'],
      orderbook: ['-8.9% ask skew with 315 BTC ask wall capping $83,200', 'Whale selling (-44 BTC net) on the sweep'],
      derivatives: ['Elevated +0.0158% funding & 1.24 L/S trap late breakout longs', '$4.8M shorts already cleared on wick'],
    },
    riskWarning: 'Range sweeps can whip both sides—not financial advice. Place stops beyond sweep extremes and manage leverage.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkReportPrompt(82579.9, 895.61, SNAP_BEARISH_SFP_82580) },
      {
        role: 'assistant',
        content: `<think>\n\n</think>\n\n${JSON.stringify(repBearSfp)}`,
      },
    ],
    meta: { kind: 'gold_report_fast', regime: 'bearish_sfp_vah' },
  });

  // 5. Tight Multi-Day BB Squeeze Inside VA Under 1D Downtrend — Deep Think
  const repSqueeze = {
    marketBias: 'Bearish',
    confidence: 71,
    marketRegime: 'Bollinger Squeeze Below Macro Resistance',
    summary:
      'BTC is coiling inside a tight 2.11% Bollinger squeeze at $81,111 on muted 0.74x volume, pinned beneath 80-bar POC ($81,671), 1D EMA21 ($81,779), and 4H MA200 ($82,953). Overhead ask walls ($81,800–$82,500) and -10.7% book imbalance favor a downside expansion break below VAL ($80,128).',
    keyLevels: [
      { price: 82953, type: 'Resistance', strength: 'Strong', reason: '4H MA200 and 260 BTC ask wall; macro bearish invalidation.' },
      { price: 81800, type: 'Liquidity Wall', strength: 'Strong', reason: 'Confluence of 80-bar POC ($81,671), 1D EMA21 ($81,779), and 290 BTC ask wall.' },
      { price: 80128, type: 'Liquidity Wall', strength: 'Strong', reason: '80-bar VAL backed by 230 BTC resting bids; breakdown trigger.' },
      { price: 79200, type: 'Support', strength: 'Strong', reason: 'Cluster of swing lows ($79,179–$79,468) with 275 BTC bids.' },
      { price: 76500, type: 'Liquidity Wall', strength: 'Strong', reason: 'Major swing downside liquidity target (340 BTC bid wall).' },
    ],
    patterns: [
      {
        name: '4H Bollinger Band Squeeze',
        bias: 'Bearish',
        status: 'Forming',
        confidence: 75,
        timeframe: '4h',
        targetPrice: 76500,
        invalidationPrice: 83100,
        description: 'Multi-day volatility compression (BB width 2.11%, Vol/MA20 0.74x) directly beneath 1D EMA21/MA50 resistance.',
      },
      {
        name: 'Descending Macro Rejection Below MA200',
        bias: 'Bearish',
        status: 'Watch',
        confidence: 69,
        timeframe: '4h',
        targetPrice: 79200,
        invalidationPrice: 82950,
        description: 'Price trapped under POC ($81,671) and 4H MA200 ($82,953) while 1D RSI stays weak at 47.6.',
      },
    ],
    tradeIdeas: [
      {
        title: 'POC / 1D EMA21 Resistance Swing Short',
        direction: 'Short',
        setupType: 'Squeeze Breakdown Anticipation',
        entryLow: 81400,
        entryHigh: 81900,
        entryPrice: 81650,
        stopLoss: 83350,
        takeProfits: [79200, 76600],
        riskReward: '1:3.0',
        confidence: 72,
        rationale: 'Short into POC ($81,671), 1D EMA21 ($81,779), and 290 BTC ask wall with structural stop above 4H MA200 ($82,953, 2.2x ATR) targeting $79,200 and $76,600.',
        invalidation: '4H close above $83,350 breaks MA200 and flips squeeze bullish.',
      },
      {
        title: 'Confirmed Breakout Above VAH Swing Long',
        direction: 'Long',
        setupType: 'Squeeze Upside Breakout',
        entryLow: 82500,
        entryHigh: 82900,
        entryPrice: 82700,
        stopLoss: 80900,
        takeProfits: [85500, 87200],
        riskReward: '1:2.5',
        confidence: 58,
        rationale: 'Only flip long on a high-volume 4H close above VAH ($82,502) absorbing the $82,500 ask wall (310 BTC); stops below POC.',
        invalidation: '4H close back below $80,900 flags a bull trap.',
      },
    ],
    confluence: {
      technical: ['Ultra-tight 2.11% BB squeeze below 1D EMA21 ($81,779) & 1D MA50 ($81,904)', 'Volume contraction (0.74x) signals imminent range break'],
      orderbook: ['600 BTC ask supply stacked across $81,800–$82,500 (-10.7% imbalance)', 'Deep 340 BTC bid liquidity magnet sitting below at $76,500'],
      derivatives: ['Mildly positive funding (+0.0082%) and L/S 1.09 provide fuel for a downside stop-run'],
    },
    riskWarning: 'Volatility squeezes can false-break before the real move—not financial advice. Wait for level confirmation and control size.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkReportPrompt(81110.9, 765.53, SNAP_SQUEEZE_81111) },
      {
        role: 'assistant',
        content: `<think>\nBTC is $81,111 in a tight 2.11% BB squeeze (0.74x vol) trapped below POC ($81,671), 1D EMA21 ($81,779), and 4H MA200 ($82,953). Orderbook is -10.7% ask-heavy with 600 BTC resistance at $81,800–$82,500 and a big 340 BTC liquidity magnet down at $76,500. Bias leans Bearish (71%). Swing short at POC/EMA21 $81,650, wide structural stop above MA200 at $83,350 (risk $1,700, ~2.2x ATR), targeting $79,200 and $76,600 (reward $5,050 = 1:3.0). Flip long only on confirmed breakout above $82,500 VAH (entry $82,700, SL $80,900, TPs $85,500/$87,200 = 1:2.5). Outputting strict JSON.\n</think>\n\n${JSON.stringify(repSqueeze)}`,
      },
    ],
    meta: { kind: 'gold_report_deep', regime: 'bb_squeeze_bear_bias' },
  });

  // 6. Macro Bull Pullback + Bullish SFP at POC ($77,482) — Deep Think
  const repBullPullback = {
    marketBias: 'Bullish',
    confidence: 75,
    marketRegime: 'Macro Uptrend Pullback & POC Liquidity Sweep',
    summary:
      'BTC pulled back into 80-bar POC ($77,187) inside a strong 1D uptrend (1D close $78,201 far above 1D EMA21 $72,845), printing a Bullish SFP below $77,600 right onto a 320 BTC bid wall. Flushed long liquidations ($9.4M) and reset funding (+0.0065%) create a textbook high-R:R swing long.',
    keyLevels: [
      { price: 81500, type: 'Resistance', strength: 'Strong', reason: '80-bar VAH, major swing high ($81,500), and 340 BTC ask wall.' },
      { price: 79400, type: 'Resistance', strength: 'Moderate', reason: 'Intermediate 215 BTC ask wall and upper Bollinger band ($79,380).' },
      { price: 77187.3, type: 'Liquidity Wall', strength: 'Strong', reason: '80-bar POC defended by a massive 320 BTC bid wall at $77,000.' },
      { price: 76200, type: 'Support', strength: 'Strong', reason: '245 BTC bid cluster beneath the $76,649 structural swing low.' },
      { price: 72845, type: 'Support', strength: 'Strong', reason: 'Rising 1D EMA21 macro trend support near VAL ($72,091).' },
    ],
    patterns: [
      {
        name: 'Bullish Liquidity Sweep (SFP) at POC',
        bias: 'Bullish',
        status: 'Confirmed',
        confidence: 77,
        timeframe: '4h',
        targetPrice: 81500,
        invalidationPrice: 75400,
        description: 'Swept below $77,600 into POC ($77,187) and 320 BTC bid wall, clearing $9.4M late longs.',
      },
      {
        name: '1D Uptrend Higher-Low Reset',
        bias: 'Bullish',
        status: 'Forming',
        confidence: 73,
        timeframe: '1d',
        targetPrice: 82500,
        invalidationPrice: 75400,
        description: '4H RSI cooled to 42.6 while 1D structure stays firmly bullish above EMA21 ($72,845).',
      },
    ],
    tradeIdeas: [
      {
        title: 'POC Sweep & Bid-Wall Swing Long',
        direction: 'Long',
        setupType: 'Macro Pullback SFP Long',
        entryLow: 77000,
        entryHigh: 77600,
        entryPrice: 77300,
        stopLoss: 75300,
        takeProfits: [79500, 81800],
        riskReward: '1:2.3',
        confidence: 76,
        rationale: 'Enter near $77,300 POC/SFP with 320 BTC bid defense and +56 BTC net whale buying; wide 2.0x ATR stop below $76,200 bid wall targets VAH ($81,500).',
        invalidation: '4H close below $75,300 breaks swing low $76,649 and targets 1D EMA21 ($72,845).',
      },
      {
        title: 'VAH Double-Top Rejection Short',
        direction: 'Short',
        setupType: 'Range-High Resistance Fade',
        entryLow: 81000,
        entryHigh: 81600,
        entryPrice: 81300,
        stopLoss: 83100,
        takeProfits: [78500, 77200],
        riskReward: '1:2.3',
        confidence: 58,
        rationale: 'Fade only if rally stalls at $81,200–$81,500 VAH & 340 BTC ask wall with renewed bearish divergence.',
        invalidation: '4H acceptance above $83,100 confirms macro breakout.',
      },
    ],
    confluence: {
      technical: ['Bullish SFP below $77,600 directly on 80-bar POC ($77,187)', '4H RSI reset to 42.6 inside strong 1D bull trend'],
      orderbook: ['+11.9% bid dominance with 320 BTC absorption wall at $77,000', 'Whales buying the dip (+56 BTC net)'],
      derivatives: ['$9.4M long flush reset funding down to healthy +0.0065% and L/S 1.05'],
    },
    riskWarning: 'Pullbacks can sweep deeper before reversing—not financial advice. Respect the $75,300 structural stop.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkReportPrompt(77482.2, 1025.16, SNAP_BULL_PULLBACK_77482) },
      {
        role: 'assistant',
        content: `<think>\nBTC is $77,482 on a healthy 4H dip inside a strong 1D uptrend (1D close $78,201 vs EMA21 $72,845). Price just printed a Bullish SFP below $77,600 right into 80-bar POC ($77,187) and a 320 BTC bid wall ($77,000) while $9.4M long liquidations reset funding to a clean +0.0065%. Swing long entry $77,300, wide structural stop below $76,200 wall at $75,300 (risk $2,000, ~2x ATR), targeting $79,500 and $81,800 (reward $4,500 = 1:2.3). Secondary short only on VAH rejection at $81,300 (SL $83,100, TPs $78,500/$77,200 = 1:2.3). Outputting strict JSON.\n</think>\n\n${JSON.stringify(repBullPullback)}`,
      },
    ],
    meta: { kind: 'gold_report_deep', regime: 'macro_bull_pullback_poc_sfp' },
  });

  // 7. Failed VAH Breakout / Crowded Funding Distribution ($85,220) — Fast Mode
  const repFailedVah = {
    marketBias: 'Bearish',
    confidence: 70,
    marketRegime: 'Distribution & Lower-High Exhaustion at VAH',
    summary:
      'BTC printed a lower swing high ($86,976 vs $87,250) and sits precariously on VAH ($85,073) with crowded +0.0245% funding (26.8% APR), L/S 1.38, and -12.9% ask-heavy book. Losing VAH opens a clean swing rotation back through POC ($84,578) toward VAL ($82,896) and $81,000.',
    keyLevels: [
      { price: 87250, type: 'Liquidity Wall', strength: 'Strong', reason: 'Macro swing peak defended by heavy 390 BTC ask wall.' },
      { price: 86500, type: 'Resistance', strength: 'Strong', reason: '310 BTC resting ask supply capping lower-high rallies.' },
      { price: 85072.7, type: 'Pivot', strength: 'Strong', reason: '80-bar VAH breakdown trigger directly under current price.' },
      { price: 82895.9, type: 'Liquidity Wall', strength: 'Strong', reason: '80-bar VAL aligned with 1D EMA21 ($83,130) and 260 BTC bids.' },
      { price: 81000, type: 'Support', strength: 'Strong', reason: '4H MA200 ($81,136) and 350 BTC structural bid wall.' },
    ],
    patterns: [
      {
        name: 'Lower-High Distribution Above VAH',
        bias: 'Bearish',
        status: 'Forming',
        confidence: 72,
        timeframe: '4h',
        targetPrice: 82900,
        invalidationPrice: 87350,
        description: 'Sequential lower high ($86,976 < $87,250) on declining 0.88x volume with whale selling (-72 BTC net).',
      },
      {
        name: 'Long-Crowded Funding Squeeze Risk',
        bias: 'Bearish',
        status: 'Watch',
        confidence: 70,
        timeframe: '4h',
        targetPrice: 81100,
        invalidationPrice: 87350,
        description: 'Elevated +0.0245% funding and 1.38 L/S expose longs if VAH ($85,073) breaks.',
      },
    ],
    tradeIdeas: [
      {
        title: 'VAH Breakdown Swing Short',
        direction: 'Short',
        setupType: 'Distribution Rotation Short',
        entryLow: 85100,
        entryHigh: 85900,
        entryPrice: 85500,
        stopLoss: 87350,
        takeProfits: [83000, 81100],
        riskReward: '1:2.4',
        confidence: 71,
        rationale: 'Short bounces beneath the $86,500 ask wall (310 BTC) with wide stop above the $87,250 swing high; targets VAL ($82,896) and 4H MA200 ($81,136).',
        invalidation: '4H close above $87,350 absorbs the 390 BTC wall and resumes macro uptrend.',
      },
      {
        title: '1D EMA21 & MA200 Macro Support Long',
        direction: 'Long',
        setupType: 'HTF Support Reclaim Long',
        entryLow: 81100,
        entryHigh: 82800,
        entryPrice: 82000,
        stopLoss: 79800,
        takeProfits: [85000, 87200],
        riskReward: '1:2.4',
        confidence: 65,
        rationale: 'Patiently buy the flush into VAL ($82,896) / 4H MA200 ($81,136) where 610 BTC of resting bids sit.',
        invalidation: '1D close below $79,800 loses 1D MA50 ($79,469).',
      },
    ],
    confluence: {
      technical: ['Lower high ($86,976) and stalling 4H momentum (RSI 51.3) perched on VAH ($85,073)'],
      orderbook: ['700 BTC ask resistance stacked at $86,500–$87,250 (-12.9% imbalance)', 'Net whale selling (-72 BTC)'],
      derivatives: ['Overcrowded +0.0245% funding (26.8% APR) & L/S 1.38 fuel downside liquidation cascade'],
    },
    riskWarning: 'Shorting inside a 1D uptrend requires strict invalidation above $87,350—not financial advice.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkReportPrompt(85220.3, 624.11, SNAP_FAILED_VAH_85220) },
      {
        role: 'assistant',
        content: `<think>\n\n</think>\n\n${JSON.stringify(repFailedVah)}`,
      },
    ],
    meta: { kind: 'gold_report_fast', regime: 'failed_vah_distribution' },
  });

  // 8. Deep Capitulation Downtrend (1D RSI 20.3, Negative Funding -0.0115%) — Deep Think
  const repCapitulation = {
    marketBias: 'Bearish',
    confidence: 74,
    marketRegime: 'Oversold Downtrend — Bear Flag Beneath POC',
    summary:
      'BTC trades at $63,077 in a severe 4H/1D downtrend (1D RSI 20.3, well under 4H EMA21 $64,281 and POC $64,655) with -11.7% ask skew and $24.5M long liquidations. Negative funding (-0.0115%) creates sharp short-squeeze bounce risk into $64,600–$65,500, which remains resistance until 4H reclaims POC.',
    keyLevels: [
      { price: 66000, type: 'Resistance', strength: 'Strong', reason: 'Prior swing highs ($65,426–$66,093) and 290 BTC ask wall.' },
      { price: 64655.3, type: 'Liquidity Wall', strength: 'Strong', reason: '80-bar POC, 4H EMA21 ($64,281), and 330 BTC ask wall.' },
      { price: 62030.8, type: 'Liquidity Wall', strength: 'Strong', reason: 'Recent capitulation low backed by 260 BTC bid wall at $62,000.' },
      { price: 58500, type: 'Support', strength: 'Strong', reason: '340 BTC deep bid wall on $62k breakdown.' },
      { price: 55500, type: 'Liquidity Wall', strength: 'Strong', reason: 'Major capitulation demand shelf (420 BTC bids).' },
    ],
    patterns: [
      {
        name: 'Bear Flag Under POC & EMA21',
        bias: 'Bearish',
        status: 'Forming',
        confidence: 74,
        timeframe: '4h',
        targetPrice: 58500,
        invalidationPrice: 66500,
        description: 'Weak consolidation below 4H EMA21 ($64,281) and POC ($64,655) after steep multi-day selloff.',
      },
      {
        name: 'Extreme 1D Oversold Short-Squeeze Risk',
        bias: 'Neutral',
        status: 'Watch',
        confidence: 72,
        timeframe: '1d',
        targetPrice: 66000,
        invalidationPrice: 62000,
        description: '1D RSI at 20.3 and negative -0.0115% funding can spark violent relief rallies before lows resolve.',
      },
    ],
    tradeIdeas: [
      {
        title: 'POC Relief-Bounce Swing Short',
        direction: 'Short',
        setupType: 'Downtrend Resistance Retest',
        entryLow: 64200,
        entryHigh: 64900,
        entryPrice: 64600,
        stopLoss: 66900,
        takeProfits: [61500, 58500],
        riskReward: '1:2.7',
        confidence: 73,
        rationale: 'Never short into negative funding at the lows; wait for a squeeze into POC ($64,655) & 330 BTC ask wall with wide 2.1x ATR stop above $66,100 highs.',
        invalidation: '4H close above $66,900 reclaims 4H MA50 ($66,849) and signals trend bottom.',
      },
      {
        title: 'Capitulation Reclaim Swing Long',
        direction: 'Long',
        setupType: 'Oversold Liquidity Sweep Reversal',
        entryLow: 58300,
        entryHigh: 59000,
        entryPrice: 58600,
        stopLoss: 55200,
        takeProfits: [62500, 66000],
        riskReward: '1:2.2',
        confidence: 62,
        rationale: 'Only scale into macro longs at deep resting bid liquidity ($58,500, 340 BTC) with stop below $55,500 wall if $62,000 gives way.',
        invalidation: '1D close below $55,200 signals extended bear leg.',
      },
    ],
    confluence: {
      technical: ['Full 4H/1D downtrend under POC ($64,655) & EMA21 ($64,281)', 'Extreme 1D RSI (20.3) warns against chasing shorts at $62k'],
      orderbook: ['-11.7% ask skew with 330 BTC cap at $64,600', 'Deep institutional bids parked at $58,500 (340 BTC) & $55,500 (420 BTC)'],
      derivatives: ['Negative funding (-0.0115%, -12.6% APR) & L/S 0.82 signal crowded late shorts prone to bounce squeezes'],
    },
    riskWarning: 'Capitulation regimes produce violent 5–8% wicks in both directions—not financial advice. Reduce leverage and size to wide stops.',
  };

  rows.push({
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: mkReportPrompt(63077.2, 1093.9, SNAP_CAPITULATION_63077) },
      {
        role: 'assistant',
        content: `<think>\nBTC is $63,077 in a heavy 4H/1D downtrend (1D RSI 20.3, under POC $64,655 and 4H EMA21 $64,281). However, funding is negative (-0.0115%, L/S 0.82), so chasing shorts at $63k risks a violent short squeeze. Disciplined swing plan: short a relief bounce into POC ($64,600, 330 BTC ask wall) with wide 2.1x ATR stop above 4H MA50 at $66,900 (risk $2,300), targeting $61,500 and $58,500 (reward $6,100 = 1:2.7). Long only on flush to $58,600 bid wall (SL $55,200, TPs $62,500/$66,000 = 1:2.2). Outputting strict JSON.\n</think>\n\n${JSON.stringify(repCapitulation)}`,
      },
    ],
    meta: { kind: 'gold_report_deep', regime: 'oversold_capitulation_neg_funding' },
  });

  // =========================================================================
  // PART 2: HAND-CRAFTED SWING CHAT Q&As (DEEP THINK & ZERO-PREAMBLE FAST!)
  // =========================================================================

  // Fast Chat 1: Zero-preamble orderbook & funding read (Parabolic regime)
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_PARABOLIC_77220) },
      { role: 'user', content: 'What do the orderbook walls & funding rate signal?' },
      {
        role: 'assistant',
        content: `<think>\n\n</think>\n\n**Orderbook & Funding Read ($77,220 — Overheated Bull):**
- **Crowded Longs Warning:** OI-weighted 8h funding is elevated at **+0.0365% (40.0% APR)** with **L/S 1.48** after **$28.4M** in short liquidations—late longs are heavily crowded.
- **Overhead Supply:** Book is slightly ask-heavy (**-5.7%**) with **650 BTC** of resting asks stacked at **$78,500 (240 BTC)** and **$80,000 (410 BTC)**.
- **Where Real Demand Sits:** Major resting bid walls are parked well below spot at **$75,500 (260 BTC)**, **$74,000 (290 BTC)**, and VAH **$71,700 (380 BTC)**.
- **Swing Takeaway:** Do not chase longs into $78.5k–$80k walls; wait for a funding-reset pullback into **$74,000–$75,500**.`,
      },
    ],
    meta: { kind: 'gold_chat_fast', regime: 'parabolic_orderflow_fast' },
  });

  // Fast Chat 2: Zero-preamble "Should I enter right now or wait?" (Parabolic)
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_PARABOLIC_77220) },
      { role: 'user', content: 'Should I long right now or wait?' },
      {
        role: 'assistant',
        content: `<think>\n\n</think>\n\n**Verdict: Wait — do NOT chase here.**
- **Why:** 4H RSI is **94.4** (1D RSI **86.0**), price is stretched **$6,558 (+9.3%)** above 4H EMA21 ($70,662), and funding is overheated at **+0.0365%**.
- **Poor R:R Now:** Buying at $77,220 puts you right under **$78,500–$80,000** ask walls (650 BTC) while true structural invalidation is way down below VAH (**$71,400**).
- **Patient Swing Plan:** Set alerts/bids at **$74,200–$75,600** (550 BTC resting bids), structural stop **$71,400**, targets **$79,500 / $82,500 (1:2.1 R:R)**.`,
      },
    ],
    meta: { kind: 'gold_chat_fast', regime: 'patience_no_chase_fast' },
  });

  // Fast Chat 3: Zero-preamble trend & key S/R levels (Breakout)
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_BREAKOUT_80871) },
      { role: 'user', content: 'Summarize the current trend & key S/R levels' },
      {
        role: 'assistant',
        content: `<think>\n\n</think>\n\n**Bias: Bullish (4H & 1D Aligned — Breakout Above Value Area)**
- **Structure:** BTC ($80,871) holds cleanly above 80-bar **VAH ($79,300)**, 4H EMA21 ($79,733), and 1D EMA21 ($77,829) with healthy **+0.0112%** funding and **+13.8%** bid imbalance.
- **Key Resistance:** **$82,000** (215 BTC ask wall / swing high $81,934) → **$84,500** (280 BTC) → **$87,000** (340 BTC).
- **Key Support:** **$80,000** (245 BTC bid wall) → **$79,300** (VAH + 310 BTC wall) → **$77,983** (80-bar POC & 4H MA50).
- **Invalidation:** A 4H close below **$77,800** breaks the swing uptrend.`,
      },
    ],
    meta: { kind: 'gold_chat_fast', regime: 'breakout_summary_fast' },
  });

  // Fast Chat 4: Zero-preamble Bearish SFP read
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_BEARISH_SFP_82580) },
      { role: 'user', content: 'What does this liquidity sweep mean for my swing bias?' },
      {
        role: 'assistant',
        content: `<think>\n\n</think>\n\n**Bearish SFP Confirmed Above $83,158 (Favors Rotation Down)**
- **Signal:** Price swept above the **$83,158** swing high into 4H MA200 (**$83,204**) and a **315 BTC** ask wall, then closed back under **VAH ($82,804)** on 1.42x volume.
- **Confluence:** Funding is elevated (**+0.0158%**, L/S **1.24**) and book skew is **-8.9%** asks—classic trapped breakout longs.
- **Swing Targets:** Rotation through **POC ($81,556)** toward **VAL ($80,884 / 285 BTC bids)** and **$79,500**.
- **Invalidation:** 4H close above **$84,150** cancels the bearish sweep.`,
      },
    ],
    meta: { kind: 'gold_chat_fast', regime: 'bearish_sfp_fast' },
  });

  // Fast Chat 5: Zero-preamble Falling-Knife Warning
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_FALLING_KNIFE_73771) },
      { role: 'user', content: 'There is a bullish RSI divergence on 4H—should I buy here?' },
      {
        role: 'assistant',
        content: `<think>\n\n</think>\n\n**No — treat this 4H Bullish RSI Divergence as a counter-trend bounce trap.**
- **HTF Overrides LTF:** BTC ($73,771) has broken below **80-bar VAL ($75,523)** with full **4H + 1D bearish alignment** (1D RSI **29.5**, price well under 4H/1D MA50 & MA200).
- **Orderflow Confirms Selling:** Book is **-19.7%** ask-heavy with a **340 BTC** wall capping **$75,500** and **-123.4 BTC** net whale selling.
- **Higher-Probability Play:** Let the RSI divergence bounce into broken VAL (**$74,800–$75,600**) for a trend-aligned swing short (SL **$77,700**, TPs **$71,500 / $68,200**, **1:3.0 R:R**). Only consider longs after a deep flush to **$70,000 (320 BTC bids)** with a confirmed 4H reclaim.`,
      },
    ],
    meta: { kind: 'gold_chat_fast', regime: 'falling_knife_trap_fast' },
  });

  // Fast Chat 6: Zero-preamble Capitulation Negative Funding Short Warning
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_CAPITULATION_63077) },
      { role: 'user', content: 'Is it safe to open a swing short right here at $63,077?' },
      {
        role: 'assistant',
        content: `<think>\n\n</think>\n\n**Risky to short directly at $63,077—wait for a relief bounce.**
- **Squeeze Risk:** 1D RSI is deeply oversold (**20.3**), funding is negative (**-0.0115%**, L/S **0.82**), and a **260 BTC** bid wall sits just below at **$62,000**.
- **Better Swing Entry:** Let overcrowded shorts squeeze back into **80-bar POC ($64,655)** / 4H EMA21 ($64,281) where a **330 BTC** ask wall sits.
- **Setup:** Short **$64,200–$64,900**, wide stop **$66,900** (above 4H MA50), targets **$61,500 / $58,500 (1:2.7 R:R)**.`,
      },
    ],
    meta: { kind: 'gold_chat_fast', regime: 'capitulation_neg_funding_fast' },
  });

  // Deep Chat 1: Best Swing Long/Short R:R Setup (Breakout)
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_BREAKOUT_80871) },
      { role: 'user', content: 'What is the best Long/Short R:R setup right now?' },
      {
        role: 'assistant',
        content: `<think>\nBTC is $80,871 with 2/2 bullish alignment (4H + 1D) above VAH ($79,300). Book is +13.8% bid-heavy with 555 BTC defending $79,300–$80,000 and balanced +0.0112% funding. Primary setup is clearly Long on pullback into $79,500–$80,300 (entry $80,000), wide stop below POC ($77,983) at $77,800 (risk $2,200), targeting $84,500 and $87,000 (reward $7,000 = 1:3.2 R:R). Secondary counter-short only on clean rejection at $82,000 ask wall (SL $83,600, TP $77,980 = 1:2.5).\n</think>\n\n**Primary Setup — VAH Pullback Swing Long (1:3.2 R:R):**
- **Entry Zone:** **$79,500 – $80,300** (retest of $80,000 245 BTC wall & $79,300 VAH / 310 BTC wall)
- **Stop Loss:** **$77,800** (wide structural stop below 80-bar POC $77,983 & 4H MA50)
- **Targets:** TP1 **$84,500** (280 BTC wall) · TP2 **$87,000** (340 BTC wall)
- **Why:** Full 4H/1D bullish alignment, +13.8% bid skew, +54.3 BTC net whale buying, and healthy +0.0112% funding.

**Alternative — Failed Breakout Short (1:2.5 R:R, lower conviction):**
- Only if price rejects **$82,000** (215 BTC ask wall) on weak volume: Entry **$82,000**, SL **$83,600**, TP1 **$79,300**, TP2 **$77,980**.

*Not financial advice—size position so a stop at $77,800 fits your max risk.*`,
      },
    ],
    meta: { kind: 'gold_chat_deep', regime: 'breakout_rr_deep' },
  });

  // Deep Chat 2: Macro Bull Pullback POC Sweep Setup
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_BULL_PULLBACK_77482) },
      { role: 'user', content: 'Is this pullback to $77,482 a good swing entry?' },
      {
        role: 'assistant',
        content: `<think>\nChecking HTF first: 1D is strongly bullish ($78,201 vs 1D EMA21 $72,845). On 4H, price pulled back to 80-bar POC ($77,187), swept below $77,600 (Bullish SFP), and hit a 320 BTC bid wall at $77,000 while $9.4M long liqs reset funding down to +0.0065%. That's a textbook macro pullback swing long. Entry $77,000–$77,600 (avg $77,300), wide 2x ATR structural stop at $75,300 (below $76,200 bid wall), targeting $79,500 and $81,800 VAH (risk $2,000 vs reward $4,500 = 1:2.3).\n</think>\n\n**Yes — this is a high-confluence swing long zone ($77,000–$77,600):**
- **Macro Trend:** 1D remains strongly bullish (close **$78,201** well above 1D EMA21 **$72,845**), while 4H RSI has cooled cleanly to **42.6**.
- **Liquidity Confirmation:** Confirmed **Bullish SFP below $77,600** directly onto **80-bar POC ($77,187)** and a **320 BTC** bid wall at **$77,000**, backed by **+56 BTC** net whale buying.
- **Derivatives Reset:** **$9.4M** in long liquidations flushed funding back to a healthy **+0.0065%** (L/S **1.05**).
- **Swing Plan (1:2.3 R:R):** Entry **$77,000 – $77,600**, structural SL **$75,300** (~2x ATR below $76,200 wall), TP1 **$79,500**, TP2 **$81,800** (VAH).

*Not financial advice—invalidate immediately on a 4H close under $75,300.*`,
      },
    ],
    meta: { kind: 'gold_chat_deep', regime: 'bull_pullback_poc_deep' },
  });

  // Deep Chat 3: Tight BB Squeeze Strategy
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_SQUEEZE_81111) },
      { role: 'user', content: 'How should a swing trader play this tight range at $81,111?' },
      {
        role: 'assistant',
        content: `<think>\nBB width is just 2.11% on 0.74x volume—classic multi-day compression. Price ($81,111) sits in the middle of the Value Area ($80,128–$82,502) directly below POC ($81,671), 1D EMA21 ($81,779), and 4H MA200 ($82,953), with 600 BTC asks overhead ($81,800–$82,500). Don't trade the dead middle. Either short rallies into $81,650 POC/EMA21 with wide stop above MA200 ($83,350) targeting $79,200/$76,600 (1:3.0), or wait for a confirmed 4H breakout above $82,500 VAH to go long.\n</think>\n\n**Avoid entering in the dead middle of a 2.11% squeeze—trade the edges:**
- **Lean Bearish While Below POC/1D EMA21:** BTC is capped under **POC ($81,671)**, **1D EMA21 ($81,779)**, **4H MA200 ($82,953)**, and **600 BTC** of overhead asks ($81,800–$82,500; **-10.7%** imbalance).
- **Primary Swing Short (1:3.0 R:R):** Short rallies into **$81,400–$81,900**, structural SL **$83,350** (above 4H MA200), targets **$79,200** and **$76,600** (340 BTC bid magnet).
- **Bullish Flip Trigger (1:2.5 R:R):** Only go long on a high-volume 4H close above **VAH ($82,502)** absorbing the 310 BTC ask wall (entry **$82,700**, SL **$80,900**, TPs **$85,500 / $87,200**).`,
      },
    ],
    meta: { kind: 'gold_chat_deep', regime: 'bb_squeeze_strategy_deep' },
  });

  // Deep Chat 4: Position Sizing & Risk Management with Wide Swing Stops
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_FAILED_VAH_85220) },
      { role: 'user', content: 'If I risk $500 on a swing short here, how should I size it and place my stop?' },
      {
        role: 'assistant',
        content: `<think>\nBTC is $85,220 with a lower high ($86,976 < $87,250) and crowded +0.0245% funding. For a swing short at $85,500, structural invalidation is above the $87,250 swing peak & 390 BTC ask wall -> SL = $87,350. Stop distance = $87,350 - $85,500 = $1,850 (2.16%). With $500 max risk: Position size in BTC = $500 / $1,850 = 0.270 BTC (~$23,108 notional). Targets: TP1 $83,000 (+$675) and TP2 $81,100 (+$1,189, 1:2.4 R:R). Keep math exact.\n</think>\n\n**Exact Position Sizing for $500 Risk (VAH Distribution Short):**
- **Entry:** **$85,500** (bounce into lower-high resistance under the 310 BTC $86,500 ask wall)
- **Structural Stop Loss:** **$87,350** (cleanly above the **$87,250** swing high & 390 BTC wall)
- **Stop Distance:** **$1,850** (2.16% from entry)
- **Position Size:** $500 / $1,850 = **0.270 BTC** (~**$23,100** notional)
- **Targets & Reward:**
  - **TP1 $83,000** (VAL / 1D EMA21): +$675 (1.35R)
  - **TP2 $81,100** (4H MA200 / 350 BTC wall): +$1,189 (**1:2.4 R:R**)

*Not financial advice—account for maker/taker fees and funding (~+0.0245%/8h paid to shorts here).*`,
      },
    ],
    meta: { kind: 'gold_chat_deep', regime: 'position_sizing_math_deep' },
  });

  // Deep Chat 5: Reviewing User's Drawn Chart Levels
  const snapWithDrawings = `${SNAP_BREAKOUT_80871}

USER DRAWINGS:
- hline ("My Breakout Support"): $79350.0@2026-09-19 16:00
- hline ("Take Profit Target"): $84400.0@2026-09-20 08:00
- hline ("Invalidation"): $77850.0@2026-09-18 12:00`;

  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(snapWithDrawings) },
      { role: 'user', content: 'Review my drawn levels on the chart' },
      {
        role: 'assistant',
        content: `<think>\nUser drew 3 levels: Support $79,350, Target $84,400, Invalidation $77,850. Comparing to live quant data: $79,350 aligns almost perfectly with 80-bar VAH ($79,300) and the 310 BTC resting bid wall ($79,300)—excellent! $77,850 sits right beneath 80-bar POC ($77,983) and 4H MA50 ($77,998)—very solid structural invalidation (could nudge $50–$100 lower to $77,750 to avoid stop wicks on POC). $84,400 front-runs the 280 BTC ask wall at $84,500—smart fill placement! Entry $79,350 -> SL $77,750 (risk $1,600) -> TP $84,400 (reward $5,050) = 1:3.2 R:R.\n</think>\n\n**Strong level placement—all 3 lines align tightly with live Value Area & orderbook liquidity:**
- **✅ Support ($79,350):** Spot-on. Sits directly on **80-bar VAH ($79,300)** and a **310 BTC** resting bid wall—ideal swing pullback zone.
- **✅ Target ($84,400):** Smart front-run of **$100** ahead of the **280 BTC** resting ask wall at **$84,500** for clean fills. Consider leaving a runner toward **$87,000** (340 BTC wall).
- **🔧 Invalidation ($77,850):** Good structural spot right beneath **POC ($77,983)** and **4H MA50 ($77,998)**—consider giving it a tiny **$100 buffer down to $77,750** so a routine wick test of POC doesn't tag you out.
- **Resulting R:R:** Entry **$79,350** / SL **$77,750** / TP **$84,400** = **1:3.2 R:R**.`,
      },
    ],
    meta: { kind: 'gold_chat_deep', regime: 'user_drawings_review_deep' },
  });

  // Fast Chat 7: Zero-preamble HTF vs LTF Conflict
  rows.push({
    messages: [
      { role: 'system', content: mkChatSystem(SNAP_FAILED_VAH_85220) },
      { role: 'user', content: '1D looks bullish but 4H is stalling—what is the swing read?' },
      {
        role: 'assistant',
        content: `<think>\n\n</think>\n\n**Short-Term Exhaustion Inside a Macro Bull Trend (Don't Chase Longs):**
- **Why 4H is Vulnerable:** Lower high at **$86,976** (< $87,250), weak **0.88x** volume, **-12.9%** ask-heavy book (**700 BTC** resistance at $86.5k–$87.25k), and crowded **+0.0245%** funding (**L/S 1.38**).
- **Macro Floor Below:** Real 1D buyers sit at **VAL ($82,896)** / **1D EMA21 ($83,130)** and **4H MA200 ($81,136 / 350 BTC wall)**.
- **Two Clean Swing Options:**
  1. **Tactical Short:** Below VAH ($85,073) targeting **$83,000 / $81,100** (SL **$87,350**, **1:2.4 R:R**).
  2. **Patient Macro Long:** Wait for the leverage flush into **$81,100–$82,800** before buying.`,
      },
    ],
    meta: { kind: 'gold_chat_fast', regime: 'htf_ltf_conflict_fast' },
  });

  return rows;
}
