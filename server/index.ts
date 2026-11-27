import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  AiReasoningMode,
  AiStreamEvent,
  BinanceBookScope,
  BookScope,
  BybitBookScope,
  CoinbaseBookScope,
  CombinedBookScope,
  ExchangeFundingRateItem,
  ExchangeId,
  FundingRatesResponse,
  HeatmapSlice,
  HyperliquidBookScope,
  LiquidationEvent,
  OkxBookScope,
  PriceStep,
  TickerStats,
  TimeframeId,
  TradeEvent,
  UserWorkspaceState,
  WsClientMessage,
  WsServerMessage,
} from '../shared/types.ts';
import { AiFeedbackStore } from './aiFeedbackStore.ts';
import { AccountStore, SESSION_COOKIE_NAME, parseCookieHeader } from './authStore.ts';
import { BinanceOrderbookCollector } from './binanceCollector.ts';
import { BybitOrderbookCollector } from './bybitCollector.ts';
import { CoinbaseOrderbookCollector } from './coinbaseCollector.ts';
import { TIMEFRAME_CONFIG, trimLevelsForWire } from './collectorUtils.ts';
import { CombinedOrderbookAggregator } from './combinedCollector.ts';
import { fetchFullExchangeCandles } from './fullHistoryService.ts';
import {
  analyzeChartWithOllama,
  chatWithLocalAi,
  fetchOllamaStatus,
} from './geminiAnalysisService.ts';
import {
  enrichCandlesWithLiveDerivatives,
  startMlDerivativesPrewarmLoop,
} from './mlDerivativesFeed.ts';
import { MlLiveEvaluator } from './mlLiveEvaluator.ts';
import { runMlQuantForecast } from './mlQuantEngine.ts';
import { HyperliquidOrderbookCollector } from './hyperliquidCollector.ts';
import { OkxOrderbookCollector } from './okxCollector.ts';
import { VolumeDistributionTracker } from './volumeTracker.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);
const VALID_STEPS = new Set<PriceStep>([0.5, 1, 2, 5, 10, 25, 50, 100]);
const VALID_BYBIT_SCOPES = new Set<BybitBookScope>([
  'all',
  'linear',
  'spot',
  'inverse',
  'usdc',
]);
const VALID_BINANCE_SCOPES = new Set<BinanceBookScope>([
  'all',
  'usdm',
  'coinm',
  'spot',
  'btcusdt_perp',
]);
const VALID_OKX_SCOPES = new Set<OkxBookScope>(['all', 'usdt_swap', 'usd_swap', 'spot']);
const VALID_CB_SCOPES = new Set<CoinbaseBookScope>(['all', 'usd', 'usdt']);
const VALID_HL_SCOPES = new Set<HyperliquidBookScope>(['all', 'perp', 'spot']);
const VALID_COMBINED_SCOPES = new Set<CombinedBookScope>([
  'all',
  'perps',
  'spot',
  'bybit',
  'binance',
  'okx',
  'coinbase',
  'hyperliquid',
]);

function normalizeExchange(rawEx?: string | null): ExchangeId {
  if (rawEx === 'binance') return 'binance';
  if (rawEx === 'okx') return 'okx';
  if (rawEx === 'coinbase') return 'coinbase';
  if (rawEx === 'hyperliquid') return 'hyperliquid';
  if (rawEx === 'combined') return 'combined';
  return 'bybit';
}

function normalizeScope(exchange: ExchangeId, rawScope?: string): BookScope {
  if (exchange === 'binance') {
    return VALID_BINANCE_SCOPES.has(rawScope as BinanceBookScope)
      ? (rawScope as BinanceBookScope)
      : 'all';
  }
  if (exchange === 'okx') {
    return VALID_OKX_SCOPES.has(rawScope as OkxBookScope) ? (rawScope as OkxBookScope) : 'all';
  }
  if (exchange === 'coinbase') {
    return VALID_CB_SCOPES.has(rawScope as CoinbaseBookScope)
      ? (rawScope as CoinbaseBookScope)
      : 'all';
  }
  if (exchange === 'hyperliquid') {
    return VALID_HL_SCOPES.has(rawScope as HyperliquidBookScope)
      ? (rawScope as HyperliquidBookScope)
      : 'all';
  }
  if (exchange === 'combined') {
    return VALID_COMBINED_SCOPES.has(rawScope as CombinedBookScope)
      ? (rawScope as CombinedBookScope)
      : 'all';
  }
  return VALID_BYBIT_SCOPES.has(rawScope as BybitBookScope)
    ? (rawScope as BybitBookScope)
    : 'all';
}

const bybitCollector = new BybitOrderbookCollector(DATA_DIR);
const binanceCollector = new BinanceOrderbookCollector(DATA_DIR);
const okxCollector = new OkxOrderbookCollector(DATA_DIR);
const coinbaseCollector = new CoinbaseOrderbookCollector(DATA_DIR);
const hyperliquidCollector = new HyperliquidOrderbookCollector(DATA_DIR);
const combinedCollector = new CombinedOrderbookAggregator(
  DATA_DIR,
  bybitCollector,
  binanceCollector,
  okxCollector,
  coinbaseCollector,
  hyperliquidCollector
);
const volumeTracker = new VolumeDistributionTracker(okxCollector, coinbaseCollector);
const accountStore = new AccountStore(DATA_DIR);
const aiFeedbackStore = new AiFeedbackStore(DATA_DIR);
const mlLiveEvaluator = new MlLiveEvaluator(DATA_DIR);

bybitCollector.start();
binanceCollector.start();
okxCollector.start();
coinbaseCollector.start();
hyperliquidCollector.start();
combinedCollector.start();
volumeTracker.start();

// Pre-warm default 15m K-line caches across all 5 exchanges so initial tab loads are instant
const prewarmDefaultKlines = (force = false) => {
  if (!force && wss.clients.size === 0) return;
  Promise.all([
    bybitCollector.getKlines('15m').catch(() => []),
    binanceCollector.getKlines('15m').catch(() => []),
    okxCollector.getKlines('15m').catch(() => []),
    coinbaseCollector.getKlines('15m').catch(() => []),
    hyperliquidCollector.getKlines('15m').catch(() => []),
  ]).catch(() => {});
};
const prewarmTimeout = setTimeout(() => prewarmDefaultKlines(true), 2500);
const prewarmTimer = setInterval(() => prewarmDefaultKlines(false), 45_000);

// Pre-warm Layer-2 Quant-ML derivatives + candles (1h/4h/1d) so cold latency drops from ~6s -> <5ms
// AND automatically log + self-grade live forecasts on every new bar close!
const prewarmMlTimeframes = async () => {
  const livePrice = combinedCollector.ticker.lastPrice;
  for (const tf of ['1h', '4h', '1d'] as const) {
    try {
      const raw = await fetchFullExchangeCandles('combined', tf, livePrice);
      const enriched = await enrichCandlesWithLiveDerivatives(raw, tf);
      const fc = runMlQuantForecast(enriched, tf, livePrice);
      if (fc) mlLiveEvaluator.recordAndGrade(enriched, fc);
    } catch {
      // non-fatal background pre-warm
    }
  }
};
const stopMlPrewarm = startMlDerivativesPrewarmLoop(() => {
  prewarmMlTimeframes().catch(() => {});
});
void stopMlPrewarm;

interface CachedStaticAsset {
  raw: Buffer;
  gzip: Buffer | null;
  contentType: string;
  etag: string;
  cacheControl: string;
}

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const staticAssetCache = new Map<string, CachedStaticAsset>();

function loadStaticAssetCache() {
  staticAssetCache.clear();
  if (!fs.existsSync(DIST_DIR)) return;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = '/' + path.relative(DIST_DIR, full).split(path.sep).join('/');
        const ext = path.extname(full);
        const raw = fs.readFileSync(full);
        const compressible =
          raw.length > 512 &&
          (ext === '.js' || ext === '.css' || ext === '.html' || ext === '.svg' || ext === '.json');
        const gzip = compressible
          ? zlib.gzipSync(raw, { level: zlib.constants.Z_DEFAULT_COMPRESSION })
          : null;
        const etag = `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16)}"`;
        const isHashedAsset = rel.startsWith('/assets/');
        staticAssetCache.set(rel, {
          raw,
          gzip,
          contentType: MIME_MAP[ext] || 'application/octet-stream',
          etag,
          cacheControl: isHashedAsset
            ? 'public, max-age=31536000, immutable'
            : 'no-cache, must-revalidate',
        });
      }
    }
  };
  walk(DIST_DIR);
}

loadStaticAssetCache();

function sendJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  payload: unknown
) {
  const json = JSON.stringify(payload);
  const acceptEnc = req.headers['accept-encoding'] || '';
  if (json.length > 1024 && typeof acceptEnc === 'string' && acceptEnc.includes('gzip')) {
    const buf = Buffer.from(json);
    if (buf.length > 16_384) {
      // Async gzip for large payloads (/api/history, /api/candles) so WS event loop never stalls
      zlib.gzip(buf, { level: zlib.constants.Z_BEST_SPEED }, (err, compressed) => {
        if (err || !compressed) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(buf);
          return;
        }
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Content-Length': compressed.length,
          Vary: 'Accept-Encoding',
        });
        res.end(compressed);
      });
      return;
    }
    const compressed = zlib.gzipSync(buf, {
      level: zlib.constants.Z_BEST_SPEED,
    });
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
      Vary: 'Accept-Encoding',
    });
    res.end(compressed);
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(json);
}

function readJsonBody(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function setSessionCookie(res: http.ServerResponse, token: string) {
  const maxAgeSec = 30 * 24 * 60 * 60;
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`
  );
}

function clearSessionCookie(res: http.ServerResponse) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

function buildFundingRatesPayload(): FundingRatesResponse {
  const now = Date.now();
  const next8h = Math.ceil(now / (8 * 3600_000)) * 8 * 3600_000;
  const next1h = Math.ceil(now / 3600_000) * 3600_000;

  const specs: {
    exchange: 'binance' | 'bybit' | 'okx' | 'hyperliquid' | 'coinbase';
    code: 'BN' | 'BYB' | 'OKX' | 'HL' | 'CB';
    label: string;
    supported: boolean;
    intervalHours: number;
    nextFundingTime: number;
    ticker: TickerStats;
  }[] = [
    {
      exchange: 'binance',
      code: 'BN',
      label: 'Binance',
      supported: true,
      intervalHours: 8,
      nextFundingTime: next8h,
      ticker: binanceCollector.ticker,
    },
    {
      exchange: 'bybit',
      code: 'BYB',
      label: 'Bybit',
      supported: true,
      intervalHours: 8,
      nextFundingTime: next8h,
      ticker: bybitCollector.ticker,
    },
    {
      exchange: 'okx',
      code: 'OKX',
      label: 'OKX',
      supported: true,
      intervalHours: 8,
      nextFundingTime: next8h,
      ticker: okxCollector.ticker,
    },
    {
      exchange: 'hyperliquid',
      code: 'HL',
      label: 'Hyperliquid',
      supported: true,
      intervalHours: 1,
      nextFundingTime: next1h,
      ticker: hyperliquidCollector.ticker,
    },
    {
      exchange: 'coinbase',
      code: 'CB',
      label: 'Coinbase',
      supported: false,
      intervalHours: 0,
      nextFundingTime: 0,
      ticker: coinbaseCollector.ticker,
    },
  ];

  let totalOi = 0;
  let weighted8hSum = 0;
  let min8h = Infinity;
  let max8h = -Infinity;

  const exchanges: ExchangeFundingRateItem[] = specs.map((s) => {
    const rate = s.supported ? Number(s.ticker.fundingRate || 0) : 0;
    const norm8h = s.supported && s.intervalHours > 0 ? rate * (8 / s.intervalHours) : 0;
    const apr = s.supported && s.intervalHours > 0 ? rate * (24 / s.intervalHours) * 365 : 0;
    const oi = s.supported ? Math.round(s.ticker.openInterestValue || 0) : 0;
    const mark = s.ticker.markPrice || s.ticker.lastPrice || 0;
    const idx = s.ticker.indexPrice || s.ticker.spotPrice || mark;
    const basisBps = idx > 0 && mark > 0 ? +(((mark - idx) / idx) * 10_000).toFixed(2) : 0;

    if (s.supported) {
      if (norm8h < min8h) min8h = norm8h;
      if (norm8h > max8h) max8h = norm8h;
      if (oi > 0) {
        totalOi += oi;
        weighted8hSum += norm8h * oi;
      }
    }

    return {
      exchange: s.exchange,
      code: s.code,
      label: s.label,
      supported: s.supported,
      intervalHours: s.intervalHours,
      fundingRatePct: +rate.toFixed(4),
      normalized8hPct: +norm8h.toFixed(4),
      annualizedAprPct: +apr.toFixed(2),
      openInterestUsd: oi,
      markPrice: +mark.toFixed(2),
      indexPrice: +idx.toFixed(2),
      basisBps,
      nextFundingTime: s.nextFundingTime,
    };
  });

  const oiWeighted8hPct = totalOi > 0 ? +(weighted8hSum / totalOi).toFixed(4) : 0;
  const oiWeightedAprPct = +(oiWeighted8hPct * 3 * 365).toFixed(2);
  const maxSpread8hPct =
    min8h < Infinity && max8h > -Infinity ? +(max8h - min8h).toFixed(4) : 0;

  return {
    updatedAt: now,
    oiWeighted8hPct,
    oiWeightedAprPct,
    maxSpread8hPct,
    totalOpenInterestUsd: totalOi,
    exchanges,
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionToken = cookies[SESSION_COOKIE_NAME];

  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const found = accountStore.getSessionUser(sessionToken);
    if (!found) {
      sendJson(req, res, 200, { authenticated: false });
      return;
    }
    sendJson(req, res, 200, { authenticated: true, user: found.user, state: found.state });
    return;
  }

  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    try {
      const body = (await readJsonBody(req)) as {
        username?: string;
        password?: string;
        initialState?: UserWorkspaceState;
      };
      const result = accountStore.register(
        body.username || '',
        body.password || '',
        body.initialState
      );
      if (!result.ok) {
        sendJson(req, res, 400, { error: result.error });
        return;
      }
      setSessionCookie(res, result.token);
      sendJson(req, res, 200, {
        authenticated: true,
        user: result.user,
        state: result.state,
      });
    } catch (err) {
      sendJson(req, res, 400, { error: String(err) });
    }
    return;
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = (await readJsonBody(req)) as { username?: string; password?: string };
      const result = accountStore.login(body.username || '', body.password || '');
      if (!result.ok) {
        sendJson(req, res, 401, { error: result.error });
        return;
      }
      setSessionCookie(res, result.token);
      sendJson(req, res, 200, {
        authenticated: true,
        user: result.user,
        state: result.state,
      });
    } catch (err) {
      sendJson(req, res, 400, { error: String(err) });
    }
    return;
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    accountStore.logout(sessionToken);
    clearSessionCookie(res);
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/user/state' && req.method === 'PUT') {
    try {
      const body = (await readJsonBody(req)) as { state?: UserWorkspaceState };
      if (!body || typeof body.state !== 'object' || body.state === null) {
        sendJson(req, res, 400, { error: 'Missing state object.' });
        return;
      }
      const saved = accountStore.saveUserState(sessionToken, body.state);
      if (!saved.ok) {
        sendJson(req, res, 401, { error: saved.error });
        return;
      }
      sendJson(req, res, 200, { ok: true, updatedAt: saved.updatedAt });
    } catch (err) {
      sendJson(req, res, 400, { error: String(err) });
    }
    return;
  }

  if (url.pathname === '/api/history') {
    const exchange = normalizeExchange(url.searchParams.get('exchange'));
    const rawTf = (url.searchParams.get('timeframe') || '15m') as TimeframeId;
    const timeframe: TimeframeId = rawTf in TIMEFRAME_CONFIG ? rawTf : '15m';
    const defaultStep = TIMEFRAME_CONFIG[timeframe].defaultPriceStep;

    const rawStep = Number(url.searchParams.get('priceStep') || defaultStep) as PriceStep;
    const priceStep: PriceStep = VALID_STEPS.has(rawStep) ? rawStep : defaultStep;
    const bookScope = normalizeScope(exchange, url.searchParams.get('bookScope') || 'all');

    try {
      const history =
        exchange === 'combined'
          ? await combinedCollector.getAggregatedHistory(
              priceStep,
              bookScope as CombinedBookScope,
              timeframe,
              1200
            )
          : exchange === 'hyperliquid'
            ? await hyperliquidCollector.getAggregatedHistory(
                priceStep,
                bookScope as HyperliquidBookScope,
                timeframe,
                1200
              )
            : exchange === 'coinbase'
              ? await coinbaseCollector.getAggregatedHistory(
                  priceStep,
                  bookScope as CoinbaseBookScope,
                  timeframe,
                  1200
                )
              : exchange === 'okx'
                ? await okxCollector.getAggregatedHistory(
                    priceStep,
                    bookScope as OkxBookScope,
                    timeframe,
                    1200
                  )
                : exchange === 'binance'
                  ? await binanceCollector.getAggregatedHistory(
                      priceStep,
                      bookScope as BinanceBookScope,
                      timeframe,
                      1200
                    )
                  : await bybitCollector.getAggregatedHistory(
                      priceStep,
                      bookScope as BybitBookScope,
                      timeframe,
                      1200
                    );

      const histMid =
        history.ticker.bestBid > 0 && history.ticker.bestAsk > 0
          ? (history.ticker.bestBid + history.ticker.bestAsk) / 2
          : history.ticker.lastPrice;
      history.currentBids = trimLevelsForWire(history.currentBids, histMid, 600);
      history.currentAsks = trimLevelsForWire(history.currentAsks, histMid, 600);

      sendJson(req, res, 200, history);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (url.pathname === '/api/candles') {
    const exchange = normalizeExchange(url.searchParams.get('exchange'));
    const rawTf = (url.searchParams.get('timeframe') || '15m') as TimeframeId;
    const timeframe: TimeframeId =
      rawTf in TIMEFRAME_CONFIG && TIMEFRAME_CONFIG[rawTf].binanceInterval ? rawTf : '15m';
    const liveLastPrice =
      exchange === 'combined'
        ? combinedCollector.ticker.lastPrice
        : exchange === 'hyperliquid'
          ? hyperliquidCollector.ticker.lastPrice
          : exchange === 'coinbase'
            ? coinbaseCollector.ticker.lastPrice
            : exchange === 'okx'
              ? okxCollector.ticker.lastPrice
              : exchange === 'binance'
                ? binanceCollector.ticker.lastPrice
                : bybitCollector.ticker.lastPrice;
    try {
      const candles = await fetchFullExchangeCandles(exchange, timeframe, liveLastPrice);
      sendJson(req, res, 200, {
        exchange,
        timeframe,
        timeframeMs: TIMEFRAME_CONFIG[timeframe].ms,
        candles,
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (url.pathname === '/api/volume-distribution') {
    sendJson(req, res, 200, volumeTracker.getDistribution());
    return;
  }

  if (url.pathname === '/api/ai/status' && req.method === 'GET') {
    const requestedOllamaUrl = url.searchParams.get('ollamaUrl') || undefined;
    const ollama = await fetchOllamaStatus(requestedOllamaUrl);
    sendJson(req, res, 200, {
      ollamaBaseUrl: ollama.baseUrl,
      ollamaReachable: ollama.reachable,
      ollamaModels: ollama.models,
      defaultOllamaModel: ollama.defaultModel,
    });
    return;
  }

  if (url.pathname === '/api/ai/ml-forecast' && req.method === 'GET') {
    try {
      const exchange = normalizeExchange(url.searchParams.get('exchange') || undefined);
      const rawTf = (url.searchParams.get('timeframe') || '4h') as TimeframeId;
      const timeframe: TimeframeId =
        rawTf in TIMEFRAME_CONFIG && TIMEFRAME_CONFIG[rawTf].binanceInterval ? rawTf : '4h';
      const collector =
        exchange === 'combined'
          ? combinedCollector
          : exchange === 'hyperliquid'
            ? hyperliquidCollector
            : exchange === 'coinbase'
              ? coinbaseCollector
              : exchange === 'okx'
                ? okxCollector
                : exchange === 'binance'
                  ? binanceCollector
                  : bybitCollector;
      const liveLastPrice = collector.ticker.lastPrice;
      const rawCandles = await fetchFullExchangeCandles(exchange, timeframe, liveLastPrice);
      const candles = await enrichCandlesWithLiveDerivatives(rawCandles, timeframe);
      const forecast = runMlQuantForecast(candles, timeframe, liveLastPrice);
      if (forecast) {
        forecast.liveEval = mlLiveEvaluator.recordAndGrade(candles, forecast);
      }
      sendJson(req, res, 200, { available: Boolean(forecast), forecast });
    } catch (err) {
      sendJson(req, res, 500, { error: (err as Error)?.message || String(err) });
    }
    return;
  }

  if (url.pathname === '/api/ai/ml-eval-stats' && req.method === 'GET') {
    const rawTf = url.searchParams.get('timeframe');
    const tf = rawTf === '1h' || rawTf === '4h' || rawTf === '1d' ? rawTf : undefined;
    sendJson(req, res, 200, mlLiveEvaluator.getStats(tf));
    return;
  }

  if (url.pathname === '/api/ai/feedback/stats' && req.method === 'GET') {
    sendJson(req, res, 200, aiFeedbackStore.getStats());
    return;
  }

  if (url.pathname === '/api/ai/feedback' && req.method === 'POST') {
    try {
      const body = (await readJsonBody(req)) as {
        kind?: 'report' | 'chat';
        rating?: 'up' | 'down';
        note?: string;
        model?: string;
        exchange?: string;
        timeframe?: string;
        priceAtGeneration?: number;
        prompt?: string;
        thinking?: string;
        response?: string;
      };
      if (body.rating !== 'up' && body.rating !== 'down') {
        sendJson(req, res, 400, { error: 'rating must be "up" or "down"' });
        return;
      }
      const stats = aiFeedbackStore.append({
        kind: body.kind === 'report' ? 'report' : 'chat',
        rating: body.rating,
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : undefined,
        model: String(body.model || 'local').slice(0, 80),
        exchange: normalizeExchange(body.exchange),
        timeframe: ((body.timeframe || '15m') as TimeframeId),
        priceAtGeneration:
          typeof body.priceAtGeneration === 'number' && Number.isFinite(body.priceAtGeneration)
            ? body.priceAtGeneration
            : undefined,
        prompt: String(body.prompt || '').slice(0, 12000),
        thinking: typeof body.thinking === 'string' && body.thinking.trim() ? body.thinking.slice(0, 8000) : undefined,
        response: String(body.response || '').slice(0, 16000),
      });
      sendJson(req, res, 200, { ok: true, ...stats });
    } catch (err) {
      sendJson(req, res, 500, { error: (err as Error)?.message || String(err) });
    }
    return;
  }

  if (url.pathname === '/api/ai/analyze' && req.method === 'POST') {
    let isSse = false;
    const writeSse = (ev: AiStreamEvent) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    };
    try {
      const body = (await readJsonBody(req)) as {
        exchange?: string;
        timeframe?: string;
        model?: string;
        ollamaBaseUrl?: string;
        customPrompt?: string;
        tradingPlaybook?: string;
        reasoningMode?: AiReasoningMode;
        includeOrderbookAndDerivs?: boolean;
        stream?: boolean;
        userDrawings?: {
          type: string;
          points: { time: number; price: number }[];
          text?: string;
        }[];
      };
      const reasoningMode: AiReasoningMode = body.reasoningMode === 'fast' ? 'fast' : 'deep';

      isSse =
        body.stream === true ||
        (typeof req.headers.accept === 'string' && req.headers.accept.includes('text/event-stream'));

      const clientAbort = new AbortController();
      if (isSse) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        req.on('close', () => {
          if (!res.writableEnded) clientAbort.abort();
        });
        writeSse({ type: 'status', phase: 'loading_context' });
      }

      const exchange = normalizeExchange(body.exchange);
      const rawTf = (body.timeframe || '15m') as TimeframeId;
      const timeframe: TimeframeId =
        rawTf in TIMEFRAME_CONFIG && TIMEFRAME_CONFIG[rawTf].binanceInterval ? rawTf : '15m';

      const collector =
        exchange === 'combined'
          ? combinedCollector
          : exchange === 'hyperliquid'
            ? hyperliquidCollector
            : exchange === 'coinbase'
              ? coinbaseCollector
              : exchange === 'okx'
                ? okxCollector
                : exchange === 'binance'
                  ? binanceCollector
                  : bybitCollector;

      const liveLastPrice = collector.ticker.lastPrice;
      const [rawCandles, higherTf4h, higherTf1d, snap] = await Promise.all([
        fetchFullExchangeCandles(exchange, timeframe, liveLastPrice),
        timeframe === '4h'
          ? Promise.resolve(undefined)
          : fetchFullExchangeCandles(exchange, '4h', liveLastPrice).catch(() => undefined),
        timeframe === '1d'
          ? Promise.resolve(undefined)
          : fetchFullExchangeCandles(exchange, '1d', liveLastPrice).catch(() => undefined),
        exchange === 'combined'
          ? combinedCollector.getAggregatedHistory(10, 'all', '15m', 1)
          : exchange === 'hyperliquid'
            ? hyperliquidCollector.getAggregatedHistory(10, 'all', '15m', 1)
            : exchange === 'coinbase'
              ? coinbaseCollector.getAggregatedHistory(10, 'all', '15m', 1)
              : exchange === 'okx'
                ? okxCollector.getAggregatedHistory(10, 'all', '15m', 1)
                : exchange === 'binance'
                  ? binanceCollector.getAggregatedHistory(10, 'all', '15m', 1)
                  : bybitCollector.getAggregatedHistory(10, 'all', '15m', 1),
      ]);
      const candles = await enrichCandlesWithLiveDerivatives(rawCandles, timeframe);

      const context = {
        exchange,
        timeframe,
        candles,
        higherTf4h,
        higherTf1d,
        ticker: snap.ticker,
        bidClusters: snap.bidClusters,
        askClusters: snap.askClusters,
        fundingRates: buildFundingRatesPayload(),
        volumeDistribution: volumeTracker.getDistribution(),
        whaleTrades: snap.whaleTrades || [],
        recentLiquidations: snap.recentLiquidations || [],
        userDrawings: Array.isArray(body.userDrawings) ? body.userDrawings : undefined,
        includeOrderbookAndDerivs: body.includeOrderbookAndDerivs !== false,
        customPrompt: body.customPrompt,
        tradingPlaybook: body.tradingPlaybook,
      };

      if (isSse) {
        const instantMl = runMlQuantForecast(candles, timeframe, liveLastPrice);
        if (instantMl) {
          instantMl.liveEval = mlLiveEvaluator.recordAndGrade(candles, instantMl);
          writeSse({ type: 'ml_forecast', forecast: instantMl });
        }
        writeSse({ type: 'status', phase: 'prompt_eval' });
        const analysis = await analyzeChartWithOllama(
          body.ollamaBaseUrl,
          body.model,
          context,
          {
            signal: clientAbort.signal,
            onPhase: (phase) => writeSse({ type: 'status', phase }),
            onThinking: (delta, livePerf) => writeSse({ type: 'thinking', delta, livePerf }),
            onContent: (delta, livePerf) => writeSse({ type: 'content', delta, livePerf }),
          },
          reasoningMode
        );
        writeSse({ type: 'done', result: analysis });
        res.end();
      } else {
        const analysis = await analyzeChartWithOllama(
          body.ollamaBaseUrl,
          body.model,
          context,
          undefined,
          reasoningMode
        );
        sendJson(req, res, 200, analysis);
      }
    } catch (err) {
      if (isSse) {
        if (!res.writableEnded) {
          writeSse({ type: 'error', error: (err as Error)?.message || String(err) });
          res.end();
        }
      } else {
        sendJson(req, res, 500, { error: (err as Error)?.message || String(err) });
      }
    }
    return;
  }

  if (url.pathname === '/api/ai/chat' && req.method === 'POST') {
    let isSse = false;
    const writeSse = (ev: AiStreamEvent) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    };
    try {
      const body = (await readJsonBody(req)) as {
        exchange?: string;
        timeframe?: string;
        model?: string;
        ollamaBaseUrl?: string;
        includeLiveContext?: boolean;
        includeOrderbookAndDerivs?: boolean;
        tradingPlaybook?: string;
        reasoningMode?: AiReasoningMode;
        stream?: boolean;
        userDrawings?: {
          type: string;
          points: { time: number; price: number }[];
          text?: string;
        }[];
        messages?: { role: 'user' | 'assistant'; content: string }[];
      };
      const reasoningMode: AiReasoningMode = body.reasoningMode === 'fast' ? 'fast' : 'deep';

      const rawMsgs = Array.isArray(body.messages)
        ? body.messages.filter(
            (m) =>
              m &&
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string' &&
              m.content.trim().length > 0
          )
        : [];
      if (rawMsgs.length === 0) {
        sendJson(req, res, 400, { error: 'Message cannot be empty.' });
        return;
      }

      isSse =
        body.stream === true ||
        (typeof req.headers.accept === 'string' && req.headers.accept.includes('text/event-stream'));

      const clientAbort = new AbortController();
      if (isSse) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        req.on('close', () => {
          if (!res.writableEnded) clientAbort.abort();
        });
        if (body.includeLiveContext !== false) {
          writeSse({ type: 'status', phase: 'loading_context' });
        }
      }

      let context;
      if (body.includeLiveContext !== false) {
        const exchange = normalizeExchange(body.exchange);
        const rawTf = (body.timeframe || '15m') as TimeframeId;
        const timeframe: TimeframeId =
          rawTf in TIMEFRAME_CONFIG && TIMEFRAME_CONFIG[rawTf].binanceInterval ? rawTf : '15m';
        const collector =
          exchange === 'combined'
            ? combinedCollector
            : exchange === 'hyperliquid'
              ? hyperliquidCollector
              : exchange === 'coinbase'
                ? coinbaseCollector
                : exchange === 'okx'
                  ? okxCollector
                  : exchange === 'binance'
                    ? binanceCollector
                    : bybitCollector;
        const liveLastPrice = collector.ticker.lastPrice;
        const [rawCandles, snap] = await Promise.all([
          fetchFullExchangeCandles(exchange, timeframe, liveLastPrice),
          exchange === 'combined'
            ? combinedCollector.getAggregatedHistory(10, 'all', '15m', 1)
            : exchange === 'hyperliquid'
              ? hyperliquidCollector.getAggregatedHistory(10, 'all', '15m', 1)
              : exchange === 'coinbase'
                ? coinbaseCollector.getAggregatedHistory(10, 'all', '15m', 1)
                : exchange === 'okx'
                  ? okxCollector.getAggregatedHistory(10, 'all', '15m', 1)
                  : exchange === 'binance'
                    ? binanceCollector.getAggregatedHistory(10, 'all', '15m', 1)
                    : bybitCollector.getAggregatedHistory(10, 'all', '15m', 1),
        ]);
        const candles = await enrichCandlesWithLiveDerivatives(rawCandles, timeframe);
        context = {
          exchange,
          timeframe,
          candles,
          ticker: snap.ticker,
          bidClusters: snap.bidClusters,
          askClusters: snap.askClusters,
          fundingRates: buildFundingRatesPayload(),
          volumeDistribution: volumeTracker.getDistribution(),
          whaleTrades: snap.whaleTrades || [],
          recentLiquidations: snap.recentLiquidations || [],
          userDrawings: Array.isArray(body.userDrawings) ? body.userDrawings : undefined,
          includeOrderbookAndDerivs: body.includeOrderbookAndDerivs !== false,
          tradingPlaybook: body.tradingPlaybook,
        };
      }

      if (isSse) {
        const instantMl = context
          ? runMlQuantForecast(context.candles, context.timeframe, context.ticker.lastPrice)
          : null;
        if (instantMl && context) {
          instantMl.liveEval = mlLiveEvaluator.recordAndGrade(context.candles, instantMl);
          writeSse({ type: 'ml_forecast', forecast: instantMl });
        }
        writeSse({ type: 'status', phase: 'prompt_eval' });
        const result = await chatWithLocalAi(
          body.ollamaBaseUrl,
          body.model,
          rawMsgs,
          context,
          {
            signal: clientAbort.signal,
            onPhase: (phase) => writeSse({ type: 'status', phase }),
            onThinking: (delta, livePerf) => writeSse({ type: 'thinking', delta, livePerf }),
            onContent: (delta, livePerf) => writeSse({ type: 'content', delta, livePerf }),
          },
          reasoningMode
        );
        writeSse({ type: 'done', result });
        res.end();
      } else {
        const result = await chatWithLocalAi(
          body.ollamaBaseUrl,
          body.model,
          rawMsgs,
          context,
          undefined,
          reasoningMode
        );
        sendJson(req, res, 200, result);
      }
    } catch (err) {
      if (isSse) {
        if (!res.writableEnded) {
          writeSse({ type: 'error', error: (err as Error)?.message || String(err) });
          res.end();
        }
      } else {
        sendJson(req, res, 500, { error: (err as Error)?.message || String(err) });
      }
    }
    return;
  }

  if (url.pathname === '/api/funding-rates') {
    sendJson(req, res, 200, buildFundingRatesPayload());
    return;
  }

  if (url.pathname === '/api/health') {
    combinedCollector.refreshTickerStats();
    const mem = process.memoryUsage();
    sendJson(req, res, 200, {
      ok: true,
      memoryMb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      bybit: bybitCollector.ticker,
      binance: binanceCollector.ticker,
      okx: okxCollector.ticker,
      coinbase: coinbaseCollector.ticker,
      hyperliquid: hyperliquidCollector.ticker,
      combined: combinedCollector.ticker,
    });
    return;
  }

  if (staticAssetCache.size > 0) {
    const cleanPath =
      url.pathname === '/' || url.pathname === '/chart' ? '/index.html' : url.pathname;
    const asset = staticAssetCache.get(cleanPath);
    if (asset) {
      if (req.headers['if-none-match'] === asset.etag) {
        res.writeHead(304, {
          ETag: asset.etag,
          'Cache-Control': asset.cacheControl,
        });
        res.end();
        return;
      }
      const acceptEnc = req.headers['accept-encoding'] || '';
      const useGzip = Boolean(
        asset.gzip && typeof acceptEnc === 'string' && acceptEnc.includes('gzip')
      );
      const body = useGzip ? asset.gzip! : asset.raw;
      res.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Length': body.length,
        ETag: asset.etag,
        'Cache-Control': asset.cacheControl,
        ...(useGzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
      });
      res.end(body);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

interface ClientConfig {
  exchange: ExchangeId;
  bookScope: BookScope;
  priceStep: PriceStep;
  mode: 'heatmap' | 'chart';
  needsFullClusters: boolean;
}

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: true });
const clientConfigs = new WeakMap<WebSocket, ClientConfig>();
const exchangeTickSeq: Record<ExchangeId, number> = {
  bybit: 0,
  binance: 0,
  okx: 0,
  coinbase: 0,
  hyperliquid: 0,
  combined: 0,
};

function hasExchangeSubscribers(exchange: ExchangeId): boolean {
  if (wss.clients.size === 0) return false;
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN && clientConfigs.get(c)?.exchange === exchange) {
      return true;
    }
  }
  return false;
}

bybitCollector.setHasClientsFn(() => hasExchangeSubscribers('bybit'));
binanceCollector.setHasClientsFn(() => hasExchangeSubscribers('binance'));
okxCollector.setHasClientsFn(() => hasExchangeSubscribers('okx'));
coinbaseCollector.setHasClientsFn(() => hasExchangeSubscribers('coinbase'));
hyperliquidCollector.setHasClientsFn(() => hasExchangeSubscribers('hyperliquid'));
combinedCollector.setHasClientsFn(() => hasExchangeSubscribers('combined'));

wss.on('connection', (ws) => {
  clientConfigs.set(ws, {
    exchange: 'bybit',
    bookScope: 'all',
    priceStep: 10,
    mode: 'heatmap',
    needsFullClusters: true,
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as WsClientMessage;
      if (msg.type === 'config') {
        const cur = clientConfigs.get(ws) || {
          exchange: 'bybit',
          bookScope: 'all',
          priceStep: 10,
          mode: 'heatmap' as const,
          needsFullClusters: true,
        };
        if (
          msg.exchange === 'bybit' ||
          msg.exchange === 'binance' ||
          msg.exchange === 'okx' ||
          msg.exchange === 'coinbase' ||
          msg.exchange === 'hyperliquid' ||
          msg.exchange === 'combined'
        ) {
          cur.exchange = msg.exchange;
        }
        cur.bookScope = normalizeScope(cur.exchange, msg.bookScope || cur.bookScope);
        if (msg.priceStep && VALID_STEPS.has(msg.priceStep)) {
          cur.priceStep = msg.priceStep;
        }
        if (msg.mode === 'heatmap' || msg.mode === 'chart') {
          cur.mode = msg.mode;
        }
        cur.needsFullClusters = cur.mode === 'heatmap';
        clientConfigs.set(ws, cur);
      }
    } catch {
      // Ignore invalid client msg
    }
  });
});

function broadcastExchangeTick(
  exchange: ExchangeId,
  collector:
    | BybitOrderbookCollector
    | BinanceOrderbookCollector
    | OkxOrderbookCollector
    | CoinbaseOrderbookCollector
    | HyperliquidOrderbookCollector
    | CombinedOrderbookAggregator,
  baseSlice: HeatmapSlice,
  newTrades: TradeEvent[],
  newLiquidations: LiquidationEvent[],
  ticker: TickerStats
) {
  if (wss.clients.size === 0) return;

  exchangeTickSeq[exchange]++;
  const isClusterBeat = exchangeTickSeq[exchange] % 4 === 0; // send 500-row cluster table every 1s
  const cache = new Map<string, string>();

  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    const cfg = clientConfigs.get(client);
    if (!cfg || cfg.exchange !== exchange) continue;

    const scope = normalizeScope(exchange, cfg.bookScope);

    // Ultra-lite Chart mode: skip 800-level orderbook & cluster aggregation completely (~95% less bandwidth)
    if (cfg.mode === 'chart') {
      const chartKey = `chart:${scope}:${cfg.priceStep}`;
      let serialized = cache.get(chartKey);
      if (!serialized) {
        const message: WsServerMessage = {
          type: 'tick',
          payload: {
            exchange,
            slice: {
              ...baseSlice,
              bids: [],
              asks: [],
              trades: [],
              liquidations: undefined,
            },
            newTrades: [],
            ticker,
            bookScope: scope,
            priceStep: cfg.priceStep,
          },
        };
        serialized = JSON.stringify(message);
        cache.set(chartKey, serialized);
      }
      client.send(serialized);
      continue;
    }

    const includeClusters = isClusterBeat || cfg.needsFullClusters;
    const key = `${scope}:${cfg.priceStep}:${includeClusters ? 'full' : 'lite'}`;

    let serialized = cache.get(key);
    if (!serialized) {
      const agg =
        exchange === 'combined'
          ? (collector as CombinedOrderbookAggregator).getAggregatedBook(
              scope as CombinedBookScope,
              cfg.priceStep,
              includeClusters
            )
          : exchange === 'hyperliquid'
            ? (collector as HyperliquidOrderbookCollector).getAggregatedBook(
                scope as HyperliquidBookScope,
                cfg.priceStep,
                includeClusters
              )
            : exchange === 'coinbase'
              ? (collector as CoinbaseOrderbookCollector).getAggregatedBook(
                  scope as CoinbaseBookScope,
                  cfg.priceStep,
                  includeClusters
                )
              : exchange === 'okx'
                ? (collector as OkxOrderbookCollector).getAggregatedBook(
                    scope as OkxBookScope,
                    cfg.priceStep,
                    includeClusters
                  )
                : exchange === 'binance'
                  ? (collector as BinanceOrderbookCollector).getAggregatedBook(
                      scope as BinanceBookScope,
                      cfg.priceStep,
                      includeClusters
                    )
                  : (collector as BybitOrderbookCollector).getAggregatedBook(
                      scope as BybitBookScope,
                      cfg.priceStep,
                      includeClusters
                    );

      const wireMid =
        ticker.bestBid > 0 && ticker.bestAsk > 0
          ? (ticker.bestBid + ticker.bestAsk) / 2
          : ticker.lastPrice;
      const wireBids = trimLevelsForWire(agg.bids, wireMid, 400);
      const wireAsks = trimLevelsForWire(agg.asks, wireMid, 400);

      const message: WsServerMessage = {
        type: 'tick',
        payload: {
          exchange,
          slice: {
            ...baseSlice,
            bids: [],
            asks: [],
          },
          currentBids: wireBids,
          currentAsks: wireAsks,
          newTrades,
          newLiquidations: newLiquidations.length > 0 ? newLiquidations : undefined,
          ...(includeClusters
            ? {
                bidClusters: agg.bidClusters,
                askClusters: agg.askClusters,
                clusterSummary: agg.clusterSummary,
              }
            : {}),
          ticker,
          bookScope: scope,
          priceStep: cfg.priceStep,
        },
      };
      serialized = JSON.stringify(message);
      cache.set(key, serialized);
    }

    if (includeClusters) cfg.needsFullClusters = false;
    client.send(serialized);
  }
}

bybitCollector.onTrades((trades) => {
  combinedCollector.ingestTrades(trades);
  volumeTracker.ingestTrades(trades);
});

binanceCollector.onTrades((trades) => {
  combinedCollector.ingestTrades(trades);
  volumeTracker.ingestTrades(trades);
});

okxCollector.onTrades((trades) => {
  combinedCollector.ingestTrades(trades);
  volumeTracker.ingestTrades(trades);
});

coinbaseCollector.onTrades((trades) => {
  combinedCollector.ingestTrades(trades);
  volumeTracker.ingestTrades(trades);
});

hyperliquidCollector.onTrades((trades) => {
  combinedCollector.ingestTrades(trades);
  volumeTracker.ingestTrades(trades);
});

bybitCollector.onLiquidations((liqs) => {
  combinedCollector.ingestLiquidations(liqs);
});

binanceCollector.onLiquidations((liqs) => {
  combinedCollector.ingestLiquidations(liqs);
});

okxCollector.onLiquidations((liqs) => {
  combinedCollector.ingestLiquidations(liqs);
});

bybitCollector.onPricePulse(() => {
  combinedCollector.syncWindowFromBooks();
});

binanceCollector.onPricePulse(() => {
  combinedCollector.syncWindowFromBooks();
});

okxCollector.onPricePulse(() => {
  combinedCollector.syncWindowFromBooks();
});

coinbaseCollector.onPricePulse(() => {
  combinedCollector.syncWindowFromBooks();
});

hyperliquidCollector.onPricePulse(() => {
  combinedCollector.syncWindowFromBooks();
});

bybitCollector.onTick(({ baseSlice, newTrades, newLiquidations, ticker }) => {
  broadcastExchangeTick('bybit', bybitCollector, baseSlice, newTrades, newLiquidations, ticker);
});

binanceCollector.onTick(({ baseSlice, newTrades, newLiquidations, ticker }) => {
  broadcastExchangeTick('binance', binanceCollector, baseSlice, newTrades, newLiquidations, ticker);
});

okxCollector.onTick(({ baseSlice, newTrades, newLiquidations, ticker }) => {
  broadcastExchangeTick('okx', okxCollector, baseSlice, newTrades, newLiquidations, ticker);
});

coinbaseCollector.onTick(({ baseSlice, newTrades, newLiquidations, ticker }) => {
  broadcastExchangeTick('coinbase', coinbaseCollector, baseSlice, newTrades, newLiquidations, ticker);
});

hyperliquidCollector.onTick(({ baseSlice, newTrades, newLiquidations, ticker }) => {
  broadcastExchangeTick(
    'hyperliquid',
    hyperliquidCollector,
    baseSlice,
    newTrades,
    newLiquidations,
    ticker
  );
});

combinedCollector.onTick(({ baseSlice, newTrades, newLiquidations, ticker }) => {
  broadcastExchangeTick(
    'combined',
    combinedCollector,
    baseSlice,
    newTrades,
    newLiquidations,
    ticker
  );
});

server.listen(PORT, HOST, () => {
  console.log(`[Multi-Exchange Orderbook Heatmap Server] Listening on http://${HOST}:${PORT}`);
});

const shutdown = () => {
  console.log('\n[Orderbook Heatmap Server] Saving checkpoints and shutting down...');
  clearTimeout(prewarmTimeout);
  clearInterval(prewarmTimer);
  accountStore.flushSync();
  bybitCollector.stop();
  binanceCollector.stop();
  okxCollector.stop();
  coinbaseCollector.stop();
  hyperliquidCollector.stop();
  combinedCollector.stop();
  volumeTracker.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
