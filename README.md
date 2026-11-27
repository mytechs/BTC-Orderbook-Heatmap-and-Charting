# BTC Orderbook Heatmap and Charting

A real-time, OLED-black Bookmap-style **orderbook liquidity heatmap**, **TradingView-style interactive charting & drawing suite**, **derivatives analytics**, **100% local 3-Layer Quant-ML + GPU Reasoning AI strategist**, and **persistent user workspace** for **Bitcoin across 5 major exchanges (24 unified BTC markets)**:

- **Bybit** (`4 Books + RPI`)
- **Binance** (`12 Pairs` — USD-M, COIN-M, Spot)
- **OKX** (`4 Pairs` — USDT Swap, USD Swap, Spot)
- **Coinbase** (`2 Spot` — unified `BTC-USD` + `BTC-USDT`)
- **Hyperliquid** (`2 Pairs` — `BTC` Perp + `UBTC/USDC` Spot)
- **Merged** (`All 5 • 24` unified orderbooks, trades, liquidations, OI, and multi-year K-lines)

Each exchange runs an independent Node.js/TypeScript collector connecting directly to public WebSocket & REST market streams (no API keys required), maintains `$1` base-cached orderbooks with rolling ring buffers and non-blocking disk checkpoints, evaluates a **pure-TypeScript walk-forward LightGBM Quant-ML ensemble (`< 1 ms`, `0 MB VRAM`)**, and streams live updates + local GPU AI synthesis (`btc-neon-lite-4b` on `:11435`) to a demand-driven HTML5 Canvas + React interface.

---

## Architecture

```mermaid
flowchart LR
  subgraph Exchanges["Public Exchange Streams (24 BTC Markets)"]
    BYB["Bybit V5 WS + REST\nLinear + RPI · Spot + RPI · Inverse · USDC · Multi-Year OI"]
    BIN["Binance WS + REST\nUSD-M (4) · COIN-M (1) · Spot (7) · Funding · Basis · Taker CVD"]
    OKX["OKX V5 WS + REST\nBTC-USDT-SWAP · BTC-USD-SWAP · Spot (2) · Liqs"]
    CB["Coinbase Exchange WS + REST\nBTC-USD (USD+USDC) · BTC-USDT Spot"]
    HL["Hyperliquid WS + REST\nBTC Perp ($1/$10/$100) · @142 UBTC Spot"]
  end

  subgraph Server["Node.js Multi-Exchange + Quant-ML Server (:3001)"]
    BCOL["BybitOrderbookCollector"]
    NCOL["BinanceOrderbookCollector"]
    OCOL["OkxOrderbookCollector"]
    CBCOL["CoinbaseOrderbookCollector"]
    HLCOL["HyperliquidOrderbookCollector"]
    CCOL["CombinedOrderbookAggregator (24 Markets)"]
    VTRK["VolumeDistributionTracker (Spot/Deriv, Buy/Sell, L/S)"]
    HIST["fullHistoryService (Multi-Year OHLCV Back to 2015)"]
    ML["Layer 2: Quant-ML v2 Engine (Pure TS)\n46-Feature Causal Extractor · 3-Seed LightGBM (<1ms)\nPre-Warmed Derivatives Feed · Live Self-Grader"]
    AI["Layer 1 + 3 Orchestrator (geminiAnalysisService)\nDeterministic TA + VP + SFP · SSE Stream · Feedback Log"]
    AUTH["AccountStore (scrypt Auth + Persistent Workspaces)"]
    HTTP["HTTP & WS Router (server/index.ts)\n/api/history · /api/candles · /api/ai/* · /api/auth/*\n/api/volume-distribution · /api/funding-rates · WS /ws"]

    BCOL --> CCOL
    NCOL --> CCOL
    OCOL --> CCOL
    CBCOL --> CCOL
    HLCOL --> CCOL
    CCOL --> HTTP
    VTRK --> HTTP
    HIST --> HTTP
    HIST --> ML
    ML --> AI
    ML --> HTTP
    AI --> HTTP
    AUTH --> HTTP
  end

  subgraph LocalGPU["Local GPU AI Daemon (:11435 / Ollama :11434)"]
    LLM["llama-server (100% GPU VRAM)\nQwen3-4B + btc-neon-lite-4b v4 LoRA\n~52 tok/s · Fast & Deep Think SSE"]
  end

  subgraph Client["OLED Black React + HTML5 Canvas UI"]
    APP["App.tsx (Heatmap | Chart Switcher, 6 Exchange Tabs, Accounts, Alerts)"]
    CANVAS["HeatmapCanvas.tsx (Heatmap, Candles, POC/VA, DOM, Δ30s, CVD)"]
    SIDE["Sidebar.tsx (Spot/Deriv Bars, Clusters, Trades/Whales/Liqs, Vol %, Funding)"]
    CHART["TradingChartPage.tsx (Full History, 13 Indicators, 14 Drawing Tools, 4-Mode Magnet)"]
    AIPANEL["GeminiAnalysisPanel.tsx (Local AI Drawer)\nInstant Quant-ML Card · Live Accuracy · SSE Thinking · Playbook"]
    MODAL["AuthModal.tsx (Sign In / Create Account)"]
    APP --> CANVAS
    APP --> SIDE
    APP --> CHART
    CHART --> AIPANEL
    APP --> MODAL
  end

  BYB --> BCOL
  BIN --> NCOL
  OKX --> OCOL
  CB --> CBCOL
  HL --> HLCOL
  AI <--> LLM
  HTTP <--> APP
```

---

## Exchange Tabs & Liquidity Feeds

| Hotkey | Tab | Markets Included | Feed Scopes |
| :---: | :--- | :--- | :--- |
| **`1`** | **Bybit** (`4`) | Linear `BTCUSDT` + `RPI`, Spot `BTCUSDT` + `RPI`, Inverse `BTCUSD`, USDC `BTCPERP` + forced liquidations | `All Bybit Books`, `USDT Perp + RPI`, `Spot + RPI`, `Inverse BTCUSD`, `USDC BTCPERP` |
| **`2`** | **Binance** (`12`) | USD-M (`BTCUSDT`, `BTCUSDC`, `BTCUSD1`, `BTCU`), COIN-M (`BTCUSD_PERP`), Spot (`BTCUSDT`, `BTCUSDC`, `BTCFDUSD`, `BTCUSD1`, `BTCU`, `BTCUSD`, `BTCUSDS`) + `forceOrder` liquidations | `All Binance BTC (12)`, `USD-M (4)`, `COIN-M (Perp)`, `Spot (7)`, `BTCUSDT Perp` |
| **`3`** | **OKX** (`4`) | `BTC-USDT-SWAP` (`0.01 BTC/ct`), `BTC-USD-SWAP` (`$100/ct`), Spot `BTC-USDT` & `BTC-USDC` + `liquidation-orders` | `All OKX BTC (4)`, `USDT Swap`, `USD Swap`, `Spot (2)` |
| **`4`** | **Coinbase** (`2`) | `BTC-USD` (unified USD+USDC Spot book) & `BTC-USDT` Spot (maker-side flipped to taker aggressor side; resampled K-lines) | `All Coinbase (2)`, `BTC-USD`, `BTC-USDT` |
| **`5`** | **HL** (`2`) | Hyperliquid `BTC` Perp (`$1` WS inner + `$10`/`$100` non-overlapping REST layers) + `@142` `UBTC/USDC` Spot | `All HL BTC (Perp+Spot)`, `BTC Perp`, `UBTC Spot` |
| **`6`** | **Merged** (`5•24`) | All 24 markets combined with blended prices/K-lines, summed OI/volume, perp-weighted funding, and 9 venue tags (`BYB-P`, `BYB-S`, `BN-P`, `BN-S`, `OKX-P`, `OKX-S`, `HL-P`, `HL-S`, `CB-S`) | `All Merged (24)`, `Perps`, `Spot`, `Bybit`, `Binance`, `OKX`, `Coinbase`, `HL` |

---

## Core Features

### 1. Orderbook Heatmap Terminal (`/`) — [`HeatmapCanvas.tsx`](client/src/components/HeatmapCanvas.tsx)
- **True OLED Black (`#000000`)** theme across all UI panels, cards, toolbars, and canvas panes.
- **Full Timeframe Suite:**
  - **Tick Timeframes (ring buffer):** `100ms`, `250ms`, `500ms`, `1s`
  - **K-Line Timeframes:** `1m`, `3m`, `5m`, `15m` *(default)*, `30m`, `1h`, `2h`, `4h`, `6h`, `12h`, `1d`, `1w` (with automatic multi-candle resampling for unsupported native intervals like Coinbase `4h`/`12h` and Hyperliquid `6h`).
- **Candlesticks & Overlays:**
  - High-visibility black-bordered candlesticks with live OHLC tick updates.
  - **Colormaps** ([`colormaps.ts`](client/src/colormaps.ts)): `Thermal`, `Viridis`, `Bid/Ask` with throttled Auto-Contrast and manual Min/Max BTC sliders.
  - **Session Volume Profile (`Profile`):** Cached buy/sell volume distribution along the left edge with **POC**, **VAH**, and **VAL** (70% value area).
  - **Dual CVD (`Vol/CVD`):** Separate **Perp CVD** and **Spot CVD** lines in the lower volume pane, plus **Perp-Spot Basis** in the header.
  - **Forced Liquidations (`⚡Liqs`):** Real-time liquidation diamonds plotted on-chart (Bybit, Binance, OKX).
  - **DOM & 30s Spoof Delta (`Δ30s`):** 1:1 synchronized DOM depth histogram with live 30-second resting liquidity Pull/Stack delta (`+` stacked / `-` pulled).
  - **Alerts & Sound** ([`alerts.ts`](client/src/alerts.ts)): Clickable in-app toasts + Web Audio chimes for configurable whale fills (`≥ 1–25 BTC`), large liquidations (`≥ $50k`), and custom price-level alerts.

### 2. TradingView-Style Chart & Drawing Page (`/chart`) — [`TradingChartPage.tsx`](client/src/components/TradingChartPage.tsx)
Switch anytime via the **`Heatmap | Chart`** tabs in the top-left header.
- **Complete Multi-Year Historical Data** ([`fullHistoryService.ts`](server/fullHistoryService.ts)):
  - Paginated OHLCV fetcher (`GET /api/candles`) loading full Bitcoin history back to **2015** on Daily (`4,100+` bars on Merged & Coinbase) and Weekly (`590+` bars), plus deep intraday history across all 5 exchanges blended with live streaming tail candles.
- **Chart Styles & Scales:**
  - **5 Series Styles:** `Candles`, `Hollow`, `Heikin Ashi`, `Line`, `Area`.
  - **Scale Modes:** `Normal` (linear), `Log` (logarithmic), `%` (percentage), plus `Auto` Y-scale, `All (N)` full-history fit, live candle close countdown clock, and **📷 PNG** snapshot export.
- **13 Built-In Technical Indicators** ([`chartIndicators.ts`](client/src/chartIndicators.ts)):
  - **Moving Averages:** `EMA 9`, `EMA 21`, `EMA 50`, `EMA 200`, `SMA 20`, **`MA 50`**, **`MA 100`**, **`MA 200`**.
  - **Overlays & Oscillators:** `VWAP`, `Bollinger Bands (20, 2)`, `Volume` + `Vol MA(20)` sub-pane, `RSI(14)` sub-pane, and `MACD(12, 26, 9)` sub-pane with live OHLCV + indicator HUD readout.
- **14 Interactive Drawing Tools** ([`chartDrawings.ts`](client/src/chartDrawings.ts)):
  - Crosshair/Select (`Esc`), Trendline (`T`), Extended Ray (`Y`), Horizontal Line (`H`), Horizontal Ray (`J`), Vertical Line (`I`), Rectangle/Zone (`G`), Parallel Channel (`C`), Fibonacci Retracement (`X`), Long R:R Position (`L`), Short R:R Position (`S`), Price/Time Ruler (`U` or `Shift+Drag`), Freehand Brush (`P`), and Text Annotation (`N`).
  - Full anchor dragging, move drawing, 8-color swatches, `1px`/`2px`/`3px` stroke widths, solid/dashed toggle, hide/show all, undo (`Ctrl+Z`), and delete (`Del`).
- **4-Mode Magnet Snapping (`🧲` or hotkey `M`):**
  - **Off:** Free cursor placement.
  - **Weak (`W`):** Snaps within `38px` to nearby candle `O/H/L/C`.
  - **Strong (`S`):** Always locks vertically to the hovered candle's nearest `O/H/L/C`.
  - **Extra Strong (`XS`):** Wide 2D magnetic lock across `±90px` of nearby candles, prioritizing prominent swing highs/lows and wick extremes—with live crosshair snap, glowing target ring, and `O/H/L/C + price` badge right on the wick.

### 3. Local 3-Layer Quant-ML + GPU Reasoning AI Strategist — [`GeminiAnalysisPanel.tsx`](client/src/components/GeminiAnalysisPanel.tsx)
100% local, zero cloud APIs — splits quantitative market math from LLM strategic reasoning across three dedicated layers:

- **Layer 1 — Deterministic Quant Engine ([`geminiAnalysisService.ts`](server/geminiAnalysisService.ts)):**
  - Exact server-side computation of `EMA 9/21/50/200`, `MA 50/100/200`, `RSI(14)`, `MACD`, `Bollinger(20,2)`, `ATR(14)`, `VWAP(50)`, **80-bar Volume Profile (`POC`/`VAH`/`VAL`)**, fractal **RSI Divergence**, **SFP Liquidity Sweeps**, multi-timeframe (`4H`/`1D`) trend alignment, live 5-exchange walls/funding/whales/liquidations, and mathematical R:R guardrails.
- **Layer 2 — Walk-Forward LightGBM Quant-ML v2 in Pure TypeScript ([`mlFeatures.ts`](server/mlFeatures.ts), [`mlQuantEngine.ts`](server/mlQuantEngine.ts), [`mlDerivativesFeed.ts`](server/mlDerivativesFeed.ts), [`mlLiveEvaluator.ts`](server/mlLiveEvaluator.ts)):**
  - **46 strictly causal features (zero look-ahead):**
    - `28` OHLCV, Volatility, Momentum, Volume Profile & SFP/Divergence features
    - `11` Derivatives & Perp Taker Orderflow features (Binance USD-M taker buy/sell ratio & 6/20-bar CVD, Binance 8h funding rate/z-score/delta, Binance perp-vs-spot premium basis, and multi-year BTCUSDT perpetual Open Interest changes & 50-bar z-score)
    - `4` Binance Spot vs. Perp flow divergence features (`spot_vol_share`, `spot_taker_buy_ratio`, 6/20-bar Spot-minus-Perp CVD divergence)
    - `3` Strictly causal closed Higher-Timeframe (`4H`/`1D`) trend, RSI, and volatility ratio features
  - **3-Seed LightGBM Ensemble (`[42, 137, 2026]`):** Trained chronologically with horizon purge gaps (`70% Train → purge → 15% Calibration & Feature Pruning → purge → 15% Out-of-Sample Test`), exponential recency weighting, post-hoc temperature calibration, and an automatic `< 0.51` OOS AUC safety guardrail (suppresses low-edge timeframes like `1D` to `Neutral`).
  - **Pure TypeScript Inference (`0.5–1.1 ms`, `0 MB VRAM`, zero Python in production):** Exported to [`server/data/ml-btc-models.json`](server/data/ml-btc-models.json) with hot-reload by file `mtime`, `< 1e-5` exact numerical parity with Python LightGBM, and background `50s` pre-warming (`1.5–10.6 ms` end-to-end latency).
  - **Live Self-Grading Tracker:** Automatically logs every new `1H/4H/1D` forecast to `server/data/ml-live-eval.jsonl`, grades resolved predictions after `12` bars (`10` bars on `1D`) against actual `±1.8× ATR` triple-barrier outcomes, and displays live accuracy right in the **Instant Quant-ML Probability Card**.

  **Real Walk-Forward Out-of-Sample Benchmarks (`17,336` bars, 2023–2026):**

  | Timeframe | Horizon | OOS Dir AUC | Brier | Regime Acc | Range MAE | Guardrail |
  | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
  | **1H** (`9,778` bars) | `12h` | **0.628** | 0.239 | **58.1%** | **0.88%** | Active |
  | **4H** (`6,278` bars) | `48h` | **0.539** | 0.251 | **54.8%** | **1.66%** | Active |
  | **1D** (`1,280` bars) | `10d` | 0.417 | 0.257 | **55.5%** | 5.14% | Suppressed to `Neutral` (`AUC < 0.51`) |

- **Layer 3 — Local GPU Reasoning LLM (`btc-neon-lite-4b` v4 LoRA on `:11435`):**
  - Custom fine-tuned **Qwen3-4B QLoRA** (`66.1 MB` F16 GGUF LoRA, `95.7%` completion accuracy) trained on `712` mathematically audited Swing Trader & **3-Layer ML + Orderflow Synthesis** examples (teaching when to align with ML confluence vs. override ML into massive orderbook walls or crowded funding).
  - Runs 100% on GPU (`~52 tok/s` on RTX 3060 6GB via [`scripts/start-hybrid-ai.sh`](scripts/start-hybrid-ai.sh)) with `⚡ Fast (Instant)` (0 thinking tokens via official Qwen3 Jinja template) vs. `🧠 Deep Think` (live streamed `<think>` reasoning), `⏹ Stop` button, live `⚡ tok/s` speed badges, editable **📋 Trading Playbook** rules, one-click plotting of AI levels/setups directly onto the chart, and `👍 / 👎` feedback capture (`server/data/ai-training-log.jsonl`).

### 4. Right Sidebar Analytics — [`Sidebar.tsx`](client/src/components/Sidebar.tsx)
1. **Split Liquidity Imbalance Card:** Separate **DERIVS** and **SPOT** Bid vs. Ask imbalance bars (BTC, `%`, and hover imbalance tooltips) plus per-market coverage pills.
2. **BTC Cluster Buckets Matrix:** Clickable size tiers (`1–5`, `5–10`, `10–25`, `25–50`, `50–100`, `100+ BTC`) that filter the heatmap, DOM, and wall list.
3. **4-Tab Explorer:**
   - **`Clusters`:** Resting Bid/Ask walls with per-venue breakdown badges, sortable by BTC size or price (click to highlight on chart).
   - **`Trades`:** **`All`**, **`🐋 Whales`** (`≥ 0.5–10 BTC` & Buy/Sell filters, net whale flow), and **`⚡ Liqs`** (Long/Short liquidation USD totals).
   - **`Vol %`:** 5-exchange 24h BTC volume distribution (`All (5)`, `Spot`, `Derivatives`), **Buy vs. Sell volume bars**, and **Long vs. Short** positioning (`Accounts` ratios for Binance/Bybit/OKX, live perp `Flow` for Hyperliquid).
   - **`Funding`:** Live perpetual funding rates with **OI-Weighted 8h rate & APR**, cross-exchange arb spread, Hyperliquid `1h` → `8h` normalization (`×8`), OI, and next UTC settlement countdown.

### 5. Accounts & Persistent Workspace — [`authStore.ts`](server/authStore.ts), [`AuthModal.tsx`](client/src/components/AuthModal.tsx)
Click **Sign In** in the top-right header (or **💾 Save to Account** in the Chart toolbar) to create a local server account and keep your entire setup across browser reloads and server/Docker restarts:
- **Zero-Dependency Security:** Salted `crypto.scryptSync` password hashing (`timingSafeEqual`), 30-day `HttpOnly; SameSite=Lax` session cookies, atomic `0600` persistence to `DATA_DIR/accounts.json` (`server/data/accounts.json` locally; `/app/server/data/accounts.json` on the `heatmap_data` volume in Docker).
- **Everything Saved Automatically (with tab-close `keepalive` flush):**
  - Active page (`Heatmap` / `Chart`), selected exchange, all 6 exchange feed scopes, Heatmap timeframe, dedicated Chart timeframe, price step, colormap, cluster filter, contrast settings, all 7 heatmap layer toggles, sound & whale/price alert thresholds.
  - All Chart settings (candle style, scale mode, Auto-Scale Y, all 13 indicators, drawing color/width/dashed, 4-mode magnet, hide drawings), local AI endpoint/model/playbook preferences, **Chart zoom/pan/manual Y-axis viewports per exchange & timeframe**, and up to **500 drawings per exchange** across all 6 exchanges.

---

## Performance Optimizations

- **Backend CPU, Memory & I/O:**
  - `$1` base aggregation caching + zero-allocation `reBucketAggregatedResult()` fast path on lite ticks (skipping per-level `VenueBreakdown` objects on 3 of 4 ticks/sec).
  - **O(1) incremental Best Bid/Ask tracking** across Bybit, Binance, OKX, and Coinbase, `±18%` orderbook retention cap, and `< 0.005 BTC` dust pruning.
  - Background `50s` Quant-ML pre-warming for `1h`/`4h`/`1d` Spot + Perp + Funding + Basis + OI + MTF caches (`1.5–10.6 ms` instant responses, `< 1 ms` pure-TS tree inference).
  - Pre-loaded & pre-gzipped in-memory static asset cache (`ETag`, `304 Not Modified`, `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`).
  - Non-blocking async `zlib.gzip` for large JSON responses (`> 16 KB`), async write-coalesced account saves (`flushSync()` on shutdown), staggered async checkpoints, idle kline pre-warm pause when no clients are connected, and bounded LRU cache (`24` entries) in `fullHistoryService.ts`.
- **Network & Frontend Rendering:**
  - Ultra-lite **`mode: 'chart'`** WebSocket streaming cuts Chart-page WS bandwidth by **~97%** (`~62 KB → ~1.9 KB/tick`) and pauses heatmap-only API polling while on `/chart`.
  - Code-split production bundle (`react-vendor`, `index`, lazy-loaded `TradingChartPage` & `AuthModal`) cutting initial wire transfer by **-73%** (`383 KB → 104 KB` gzipped).
  - **Demand-driven `requestAnimationFrame`** (`0%` idle CPU) on both Heatmap and Chart canvases, batched Canvas 2D paths for grids/candles/volume/MACD, cached Session Volume Profile (`POC`/`VAH`/`VAL`), cached `Intl.DateTimeFormat` formatters, `O(N)` sliding-window Bollinger Bands, `O(1)` live-tail candle merging, zero-re-render drawing drags, `React.memo` on heavy panels, and `visibilitychange` background throttling.

---

## Navigation & Keyboard Shortcuts

### Global & Heatmap (`/`)
| Input | Action |
| :--- | :--- |
| **`1` – `6`** | Switch exchange tabs (`1` Bybit, `2` Binance, `3` OKX, `4` Coinbase, `5` HL, `6` Merged) |
| **`Space`** | Pause / Resume live stream |
| **`F`** | Auto-fit visible candlesticks |
| **`R`** | Recenter tightly on live Best Bid / Best Ask spread |
| **`B`** | Zoom out to full exchange orderbook |
| **`M`** | Mute / Unmute alert audio chimes |
| **`Esc`** | Clear highlighted price line |
| **Mouse Wheel / `Shift+Wheel` / `Ctrl+Wheel`** | Zoom price (Y), zoom time (X), or zoom both simultaneously |
| **Drag Chart / Price Axis / Time Axis** | 2D pan, vertical scale zoom, or horizontal scale zoom |

### TradingView Chart (`/chart`)
| Input | Action |
| :--- | :--- |
| **`T` / `Y` / `H` / `J` / `I`** | Trendline / Extended Ray / Horizontal Line / Horizontal Ray / Vertical Line |
| **`G` / `C` / `X`** | Rectangle / Parallel Channel / Fibonacci Retracement |
| **`L` / `S` / `U` / `P` / `N`** | Long R:R / Short R:R / Price-Time Ruler (`Shift+Drag`) / Brush / Text Note |
| **`M`** | Cycle Magnet Mode (`Off` → `Weak` → `Strong` → `Extra Strong`) |
| **`Ctrl+Z` / `Del` / `Esc`** | Undo last drawing / Delete selected drawing / Return to crosshair |
| **Double-Click Chart / Price Axis** | Reset viewport & auto-scale Y / Reset Y-axis auto-scale |

---

## Running with Docker (Recommended)

Requires Docker + Docker Compose ([`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml)):

```bash
docker compose up -d --build
```

The multi-stage `node:24-alpine` container builds the split frontend bundle, installs production dependencies only, runs as non-root user `node`, binds `HOST=0.0.0.0` on port `3001`, persists accounts and checkpoints to the `heatmap_data` Docker volume (`/app/server/data`), and monitors `/api/health` via a built-in `HEALTHCHECK`.

Open **[http://127.0.0.1:3001](http://127.0.0.1:3001)** (or **[http://127.0.0.1:3001/chart](http://127.0.0.1:3001/chart)**) in your browser.

Useful commands:
```bash
docker ps                                          # verify (healthy) & 0.0.0.0:3001->3001/tcp
docker logs -f btc-orderbook-heatmap-and-charting  # stream live WS connection logs
docker compose down                                # stop container (keeps accounts & checkpoints volume)
```

---

## Local Setup, GPU AI & Training Pipeline

### Prerequisites
- **Node.js `22.6+` / `24.x` / `26.x`** (native `--experimental-strip-types`).
- *(Optional, for Layer-3 local GPU LLM)* `llama-server` (`llama.cpp`) or Ollama (`:11434`).
- *(Optional, for retraining LightGBM or QLoRA)* Python 3.12 virtualenv at `training/.venv` (`lightgbm`, `scikit-learn`, `torch+cu124`, `transformers`, `peft`, `bitsandbytes`, `trl`, `gguf`).

```bash
npm install
```

### Production Mode (App `:3001` + Local GPU AI `:11435`)
```bash
# Terminal 1 — Build & Start Multi-Exchange + Quant-ML App Server (:3001)
npm run build
npm start

# Terminal 2 — Start Local GPU AI Server with btc-neon-lite-4b v4 LoRA (:11435)
npm run start:hybrid-ai
```
Open **[http://127.0.0.1:3001](http://127.0.0.1:3001)** (or **[http://127.0.0.1:3001/chart](http://127.0.0.1:3001/chart)** and open the **Local AI** drawer).

### Development Mode (Hot Reload)
```bash
# Terminal 1 — Backend Collectors, Quant-ML & API (:3001)
npm run dev:server

# Terminal 2 — Vite Frontend (:5173, proxies /api and /ws to :3001)
npm run dev:client
```

### Retraining & Benchmarking
```bash
# Retrain Layer-2 Quant-ML v2 (46 features, 3-seed walk-forward LightGBM -> hot-reloads with zero downtime!)
npm run train:ml

# Rebuild & audit Layer-3 LLM dataset (historical + Gold Swing + Gold ML-Synthesis + 👍 user feedback)
npm run train:dataset
npm run train:audit

# Benchmark local AI model speed, JSON validity, swing stop discipline & R:R
npm run benchmark:ai
```

### Typecheck & Unit Tests (`19` tests across `5` suites)
```bash
npx tsc --noEmit
npm test
```

---

## HTTP & WebSocket API

- **`GET /api/health`** — Memory stats (`rss`, `heapUsed`, `heapTotal`) + live `TickerStats` for all 5 exchanges and `combined`.
- **`GET /api/history`** — Heatmap history & live book (`exchange`, `timeframe`, `priceStep`, `bookScope`).
- **`GET /api/candles`** — Complete multi-year paginated OHLCV candle history (`exchange`, `timeframe`) back to 2015.
- **`GET /api/volume-distribution`** — 5-exchange 24h Spot & Derivatives BTC/USD volumes, percentage shares, Buy vs. Sell splits, and Long vs. Short ratios.
- **`GET /api/funding-rates`** — Live perpetual funding rates, 8h-normalized rates, annualized APR, OI-weighted aggregate rate, arb spread, mark/index basis (bps), and next UTC settlement timestamps.
- **`GET /api/ai/status`** — Discovers local `llama-server` (`:11435`) or Ollama (`:11434`) models and reachability.
- **`GET /api/ai/ml-forecast`** — Instant pure-TypeScript 46-feature LightGBM v2 forecast (`exchange`, `timeframe`) returning calibrated Up/Chop/Down probabilities, regime probabilities, expected range envelope, top drivers, and `liveEval` accuracy.
- **`GET /api/ai/ml-eval-stats`** — Returns live self-graded directional win rate, range hit rate, and pending/graded counts (`timeframe=1h|4h|1d` optional).
- **`POST /api/ai/analyze`** — Runs full 3-layer TA synthesis over SSE (`ml_forecast` → `status` → `thinking` → `content` → `done`) with `reasoningMode: 'fast' | 'deep'`, drawings, and custom trading playbook.
- **`POST /api/ai/chat`** — Interactive local AI orderflow chat with live chart context and SSE streaming.
- **`POST /api/ai/feedback` · `GET /api/ai/feedback/stats`** — Logs `👍 / 👎` user ratings into `server/data/ai-training-log.jsonl` for future LoRA distillation rounds.
- **`POST /api/auth/register` · `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`** — Cookie-authenticated account management.
- **`PUT /api/user/state`** — Persist full authenticated user workspace (heatmap settings, chart settings, chart viewports, AI config, and drawings across all exchanges).
- **`WS /ws`** — Send `{ "type": "config", "exchange": "...", "bookScope": "...", "priceStep": 10, "mode": "heatmap" | "chart" }` to stream `250ms` live `tick` frames.

---

## Project Structure

```text
BTC-Orderbook-Heatmap-and-Charting/
├── Dockerfile                           # Multi-stage node:24-alpine production image
├── docker-compose.yml                   # Compose service with port 3001 & persistent data volume
├── .dockerignore
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts                       # Code-split production build (react-vendor + lazy routes)
├── scripts/
│   ├── start-hybrid-ai.sh               # Launches local GPU llama-server (:11435) + btc-neon-lite-4b LoRA
│   ├── chat-hybrid-ai.mjs               # CLI smoke-test client for :11435
│   └── qwen3-chat-template.jinja        # Official Qwen3 Jinja template enabling true 0-think Fast mode
├── shared/
│   └── types.ts                         # Shared types for exchanges, Quant-ML, live eval, AI SSE & auth
├── server/
│   ├── index.ts                         # HTTP/WS router, pre-warm loop, AI SSE & candles/auth APIs
│   ├── authStore.ts                     # Salted scrypt auth, 30-day sessions & async workspace persistence
│   ├── aiFeedbackStore.ts               # 👍/👎 AI rating logger (ai-training-log.jsonl)
│   ├── geminiAnalysisService.ts         # Layer-1 Quant Engine + Layer-3 local LLM SSE orchestrator
│   ├── mlFeatures.ts                    # Strictly causal 46-feature extractor (OHLCV + Derivs + Spot + MTF)
│   ├── mlQuantEngine.ts                 # <1ms pure-TS LightGBM 3-seed ensemble evaluator + AUC guardrail
│   ├── mlDerivativesFeed.ts             # Live 50s pre-warmed Binance Spot/Perp/Funding/Basis/MTF + OI feed
│   ├── mlLiveEvaluator.ts               # Self-grading live forecast tracker (ml-live-eval.jsonl)
│   ├── fullHistoryService.ts            # Paginated multi-year OHLCV history service (back to 2015)
│   ├── collectorUtils.ts                # Bucketing, fast-path re-bucketing, cluster tiers & async checkpoints
│   ├── bybitCollector.ts                # Bybit 4-market + RPI + liquidations collector
│   ├── binanceCollector.ts              # Binance 12-pair (USD-M, COIN-M, Spot) + forceOrder collector
│   ├── okxCollector.ts                  # OKX 4-pair (USDT/USD Swaps, Spot) + liquidations collector
│   ├── coinbaseCollector.ts             # Coinbase Spot (BTC-USD + BTC-USDT) collector
│   ├── hyperliquidCollector.ts          # Hyperliquid BTC Perp ($1/$10/$100) + @142 UBTC Spot collector
│   ├── combinedCollector.ts             # Unified 5-exchange (24-market) aggregator & K-line blender
│   ├── volumeTracker.ts                 # 5-exchange Spot/Deriv volume, Buy/Sell & Long/Short tracker
│   └── data/                            # ml-btc-models.json, ml-live-eval.jsonl, checkpoints & accounts.json
├── training/
│   ├── build_ml_features.ts             # Multi-year 46-feature causal dataset builder (17,336 BTC bars)
│   ├── train_ml_models.py               # Walk-forward 3-seed LightGBM v2 trainer & pure-TS JSON exporter
│   ├── gold_swing_curated.ts            # 20 hand-crafted Swing/Position Trader Gold examples
│   ├── gold_ml_synthesis.ts             # 12 hand-crafted 3-Layer ML + Orderflow Synthesis Gold examples
│   ├── build_btc_dataset.ts             # Combines historical regimes, Gold sets & user 👍 logs -> JSONL
│   ├── audit_dataset.ts                 # Automated JSON, price-grounding, ordering & exact R:R auditor
│   ├── train_neon_lite.py               # 4-bit NF4 QLoRA trainer for Qwen3-4B (RTX 3060 6GB optimized)
│   └── benchmark_model.ts               # Head-to-head local model benchmark (speed, JSON, stops, R:R)
├── tests/
│   ├── authStore.test.ts                # Account registration, login, session & disk reload tests
│   ├── collectorUtils.test.ts           # Core collector bucketing, cluster & trade buffer tests
│   ├── geminiAnalysisService.test.ts    # Quant indicators, prompt builder, tok/s & SSE stream tests
│   ├── mlQuantEngine.test.ts            # 46-feature zero look-ahead, <1e-5 Py/TS parity & live grader tests
│   └── optimizations.test.ts            # Fast-path re-bucketing & O(N) Bollinger Band tests
└── client/
    └── src/
        ├── main.tsx
        ├── App.tsx                      # Heatmap/Chart switcher, 6 exchange tabs, auth sync & WS client
        ├── alerts.ts                    # Web Audio alert chimes & toast types
        ├── colormaps.ts                 # Precomputed 256-level LUTs (Thermal, Viridis, Bid/Ask)
        ├── chartIndicators.ts           # O(N) EMAs, SMAs, MAs (50/100/200), VWAP, BB, RSI & MACD
        ├── chartDrawings.ts             # 14 interactive drawing tools, hit-testing & canvas rendering
        ├── styles.css                   # True OLED black (#000000) terminal styling
        └── components/
            ├── HeatmapCanvas.tsx        # Demand-driven Canvas heatmap, candles, POC/VA, DOM, Δ30s, CVD
            ├── TradingChartPage.tsx     # Interactive chart canvas, 4-mode magnet, viewport & drawing sync
            ├── GeminiAnalysisPanel.tsx  # Local AI drawer: Quant-ML card, live accuracy, SSE thinking & chat
            ├── Sidebar.tsx              # Dual Spot/Deriv bars, Clusters, Trades/Whales/Liqs, Vol %, Funding
            └── AuthModal.tsx            # OLED Sign In / Create Account modal
```
