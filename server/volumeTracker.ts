import type {
  ExchangeVolumeShareItem,
  TradeEvent,
  VolumeDistributionResponse,
} from '../shared/types.ts';
import type { CoinbaseOrderbookCollector } from './coinbaseCollector.ts';
import type { OkxOrderbookCollector } from './okxCollector.ts';

type TrackedExchange = 'binance' | 'bybit' | 'okx' | 'coinbase' | 'hyperliquid';

interface RawExchangeVol {
  spotBtc: number;
  spotUsd: number;
  derivBtc: number;
  derivUsd: number;
}

interface RestBuySellRatio {
  spotBuyRatio: number | null; // 0..1
  derivBuyRatio: number | null; // 0..1
}

interface LongShortSnapshot {
  longPct: number;
  shortPct: number;
  ratio: number;
  source: 'accounts' | 'flow';
}

interface FlowMinuteBucket {
  minuteTs: number;
  spotBuy: number;
  spotSell: number;
  derivBuy: number;
  derivSell: number;
}

const BINANCE_SPOT_SYMBOLS = [
  'BTCUSDT',
  'BTCUSDC',
  'BTCFDUSD',
  'BTCUSD1',
  'BTCU',
  'BTCUSD',
  'BTCUSDS',
];
const BINANCE_USDM_SYMBOLS = ['BTCUSDT', 'BTCUSDC', 'BTCUSD1', 'BTCU'];
const FLOW_WINDOW_MS = 60 * 60 * 1000; // rolling 60-minute live trade window

async function safeFetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export class VolumeDistributionTracker {
  private okx: OkxOrderbookCollector;
  private coinbase: CoinbaseOrderbookCollector;
  private timer: NodeJS.Timeout | null = null;

  private raw: Record<TrackedExchange, RawExchangeVol> = {
    binance: { spotBtc: 0, spotUsd: 0, derivBtc: 0, derivUsd: 0 },
    bybit: { spotBtc: 0, spotUsd: 0, derivBtc: 0, derivUsd: 0 },
    okx: { spotBtc: 0, spotUsd: 0, derivBtc: 0, derivUsd: 0 },
    coinbase: { spotBtc: 0, spotUsd: 0, derivBtc: 0, derivUsd: 0 },
    hyperliquid: { spotBtc: 0, spotUsd: 0, derivBtc: 0, derivUsd: 0 },
  };

  private restBuyRatios: Record<TrackedExchange, RestBuySellRatio> = {
    binance: { spotBuyRatio: null, derivBuyRatio: null },
    bybit: { spotBuyRatio: null, derivBuyRatio: null },
    okx: { spotBuyRatio: null, derivBuyRatio: null },
    coinbase: { spotBuyRatio: null, derivBuyRatio: null },
    hyperliquid: { spotBuyRatio: null, derivBuyRatio: null },
  };

  private restLongShort: Partial<Record<TrackedExchange, LongShortSnapshot>> = {};

  private liveFlowBuckets: Record<TrackedExchange, FlowMinuteBucket[]> = {
    binance: [],
    bybit: [],
    okx: [],
    coinbase: [],
    hyperliquid: [],
  };

  private updatedAt = 0;

  constructor(okx: OkxOrderbookCollector, coinbase: CoinbaseOrderbookCollector) {
    this.okx = okx;
    this.coinbase = coinbase;
  }

  public start() {
    this.pollAll().catch(() => {});
    this.timer = setInterval(() => {
      this.pollAll().catch(() => {});
    }, 30_000);
  }

  public stop() {
    if (this.timer) clearInterval(this.timer);
  }

  public ingestTrades(trades: TradeEvent[]) {
    for (let i = 0; i < trades.length; i++) {
      const tr = trades[i];
      if (!tr || tr.v <= 0) continue;

      let key: TrackedExchange | null = null;
      if (tr.exchange === 'BN') key = 'binance';
      else if (tr.exchange === 'BYB') key = 'bybit';
      else if (tr.exchange === 'OKX') key = 'okx';
      else if (tr.exchange === 'CB') key = 'coinbase';
      else if (tr.exchange === 'HL') key = 'hyperliquid';
      if (!key) continue;

      const minuteTs = Math.floor((tr.t || Date.now()) / 60_000) * 60_000;
      const list = this.liveFlowBuckets[key];
      let bucket = list.length > 0 ? list[list.length - 1] : null;
      if (!bucket || bucket.minuteTs !== minuteTs) {
        bucket = { minuteTs, spotBuy: 0, spotSell: 0, derivBuy: 0, derivSell: 0 };
        list.push(bucket);
        if (list.length > 65) {
          list.splice(0, list.length - 60);
        }
      }

      const isSpot = tr.market === 'SPOT' || key === 'coinbase';
      if (isSpot) {
        if (tr.s === 'Buy') bucket.spotBuy += tr.v;
        else bucket.spotSell += tr.v;
      } else {
        if (tr.s === 'Buy') bucket.derivBuy += tr.v;
        else bucket.derivSell += tr.v;
      }
    }
  }

  private getLiveFlowTotals(key: TrackedExchange) {
    const cutoff = Date.now() - FLOW_WINDOW_MS;
    const list = this.liveFlowBuckets[key];
    while (list.length > 0 && list[0].minuteTs < cutoff) {
      list.shift();
    }
    let spotBuy = 0;
    let spotSell = 0;
    let derivBuy = 0;
    let derivSell = 0;
    for (let i = 0; i < list.length; i++) {
      spotBuy += list[i].spotBuy;
      spotSell += list[i].spotSell;
      derivBuy += list[i].derivBuy;
      derivSell += list[i].derivSell;
    }
    return { spotBuy, spotSell, derivBuy, derivSell };
  }

  private async pollBinance(): Promise<RawExchangeVol | null> {
    const spotUrl = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(
      JSON.stringify(BINANCE_SPOT_SYMBOLS)
    )}`;
    const [spotList, coinmList, spotKlines, futKlines, lsRes, ...usdmItems] = await Promise.all([
      safeFetchJson<{ volume?: string; quoteVolume?: string }[]>(spotUrl),
      safeFetchJson<{ baseVolume?: string; volume?: string }[]>(
        'https://dapi.binance.com/dapi/v1/ticker/24hr?symbol=BTCUSD_PERP'
      ),
      safeFetchJson<unknown[][]>(
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=24'
      ),
      safeFetchJson<unknown[][]>(
        'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=24'
      ),
      safeFetchJson<{ longAccount?: string; shortAccount?: string; longShortRatio?: string }[]>(
        'https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1'
      ),
      ...BINANCE_USDM_SYMBOLS.map((sym) =>
        safeFetchJson<{ volume?: string; quoteVolume?: string }>(
          `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${sym}`
        )
      ),
    ]);

    let spotBtc = 0;
    let spotUsd = 0;
    if (Array.isArray(spotList)) {
      for (const s of spotList) {
        spotBtc += parseFloat(s.volume || '0') || 0;
        spotUsd += parseFloat(s.quoteVolume || '0') || 0;
      }
    }

    let derivBtc = 0;
    let derivUsd = 0;
    for (const u of usdmItems) {
      if (!u) continue;
      derivBtc += parseFloat(u.volume || '0') || 0;
      derivUsd += parseFloat(u.quoteVolume || '0') || 0;
    }
    if (Array.isArray(coinmList) && coinmList[0]) {
      derivBtc += parseFloat(coinmList[0].baseVolume || '0') || 0;
      derivUsd += (parseFloat(coinmList[0].volume || '0') || 0) * 100;
    }

    // 24h Taker Buy ratio from Binance Spot & Futures 1h klines (index 5 = vol, index 9 = takerBuyBase)
    const calcKlineBuyRatio = (rows: unknown[][] | null): number | null => {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      let totalV = 0;
      let buyV = 0;
      for (const r of rows) {
        if (!Array.isArray(r) || r.length < 10) continue;
        totalV += parseFloat(String(r[5])) || 0;
        buyV += parseFloat(String(r[9])) || 0;
      }
      if (totalV <= 0) return null;
      return Math.min(1, Math.max(0, buyV / totalV));
    };

    const sRatio = calcKlineBuyRatio(spotKlines);
    const dRatio = calcKlineBuyRatio(futKlines);
    if (sRatio !== null) this.restBuyRatios.binance.spotBuyRatio = sRatio;
    if (dRatio !== null) this.restBuyRatios.binance.derivBuyRatio = dRatio;

    if (Array.isArray(lsRes) && lsRes[0]) {
      const longAcc = parseFloat(lsRes[0].longAccount || '0');
      const shortAcc = parseFloat(lsRes[0].shortAccount || '0');
      const ratio = parseFloat(lsRes[0].longShortRatio || '0');
      if (longAcc > 0 && shortAcc > 0) {
        this.restLongShort.binance = {
          longPct: +(longAcc * 100).toFixed(2),
          shortPct: +(shortAcc * 100).toFixed(2),
          ratio: +(ratio || longAcc / shortAcc).toFixed(2),
          source: 'accounts',
        };
      }
    }

    if (spotBtc === 0 && derivBtc === 0) return null;
    return {
      spotBtc: +spotBtc.toFixed(2),
      spotUsd: Math.round(spotUsd),
      derivBtc: +derivBtc.toFixed(2),
      derivUsd: Math.round(derivUsd),
    };
  }

  private async pollBybit(): Promise<RawExchangeVol | null> {
    const [linUsdt, linUsdc, invUsd, spotUsdt, spotUsdc, lsRes] = await Promise.all([
      safeFetchJson<{ result?: { list?: { volume24h?: string; turnover24h?: string }[] } }>(
        'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT'
      ),
      safeFetchJson<{ result?: { list?: { volume24h?: string; turnover24h?: string }[] } }>(
        'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCPERP'
      ),
      safeFetchJson<{ result?: { list?: { volume24h?: string; turnover24h?: string }[] } }>(
        'https://api.bybit.com/v5/market/tickers?category=inverse&symbol=BTCUSD'
      ),
      safeFetchJson<{ result?: { list?: { volume24h?: string; turnover24h?: string }[] } }>(
        'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT'
      ),
      safeFetchJson<{ result?: { list?: { volume24h?: string; turnover24h?: string }[] } }>(
        'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDC'
      ),
      safeFetchJson<{ result?: { list?: { buyRatio?: string; sellRatio?: string }[] } }>(
        'https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=BTCUSDT&period=5min&limit=1'
      ),
    ]);

    let derivBtc = 0;
    let derivUsd = 0;
    for (const res of [linUsdt, linUsdc]) {
      const item = res?.result?.list?.[0];
      if (!item) continue;
      derivBtc += parseFloat(item.volume24h || '0') || 0;
      derivUsd += parseFloat(item.turnover24h || '0') || 0;
    }
    const invItem = invUsd?.result?.list?.[0];
    if (invItem) {
      derivBtc += parseFloat(invItem.turnover24h || '0') || 0;
      derivUsd += parseFloat(invItem.volume24h || '0') || 0;
    }

    let spotBtc = 0;
    let spotUsd = 0;
    for (const res of [spotUsdt, spotUsdc]) {
      const item = res?.result?.list?.[0];
      if (!item) continue;
      spotBtc += parseFloat(item.volume24h || '0') || 0;
      spotUsd += parseFloat(item.turnover24h || '0') || 0;
    }

    const lsItem = lsRes?.result?.list?.[0];
    if (lsItem) {
      const buyR = parseFloat(lsItem.buyRatio || '0');
      const sellR = parseFloat(lsItem.sellRatio || '0');
      if (buyR > 0 && sellR > 0) {
        this.restLongShort.bybit = {
          longPct: +(buyR * 100).toFixed(2),
          shortPct: +(sellR * 100).toFixed(2),
          ratio: +(buyR / sellR).toFixed(2),
          source: 'accounts',
        };
      }
    }

    if (spotBtc === 0 && derivBtc === 0) return null;
    return {
      spotBtc: +spotBtc.toFixed(2),
      spotUsd: Math.round(spotUsd),
      derivBtc: +derivBtc.toFixed(2),
      derivUsd: Math.round(derivUsd),
    };
  }

  private async pollOkxSentiment() {
    const [lsRes, takerDeriv, takerSpot] = await Promise.all([
      safeFetchJson<{ data?: string[][] }>(
        'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=5m'
      ),
      safeFetchJson<{ data?: string[][] }>(
        'https://www.okx.com/api/v5/rubik/stat/taker-volume?ccy=BTC&instType=CONTRACTS&period=1H'
      ),
      safeFetchJson<{ data?: string[][] }>(
        'https://www.okx.com/api/v5/rubik/stat/taker-volume?ccy=BTC&instType=SPOT&period=1H'
      ),
    ]);

    const ratioStr = lsRes?.data?.[0]?.[1];
    const ratio = parseFloat(ratioStr || '0');
    if (ratio > 0) {
      const longPct = (ratio / (1 + ratio)) * 100;
      this.restLongShort.okx = {
        longPct: +longPct.toFixed(2),
        shortPct: +(100 - longPct).toFixed(2),
        ratio: +ratio.toFixed(2),
        source: 'accounts',
      };
    }

    // OKX taker-volume row: [ts, sellVol, buyVol]
    const calcOkxBuyRatio = (rows: string[][] | undefined): number | null => {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      let sellSum = 0;
      let buySum = 0;
      const limit = Math.min(24, rows.length);
      for (let i = 0; i < limit; i++) {
        sellSum += parseFloat(rows[i]?.[1] || '0') || 0;
        buySum += parseFloat(rows[i]?.[2] || '0') || 0;
      }
      if (sellSum + buySum <= 0) return null;
      return Math.min(1, Math.max(0, buySum / (sellSum + buySum)));
    };

    const dRatio = calcOkxBuyRatio(takerDeriv?.data);
    const sRatio = calcOkxBuyRatio(takerSpot?.data);
    if (dRatio !== null) this.restBuyRatios.okx.derivBuyRatio = dRatio;
    if (sRatio !== null) this.restBuyRatios.okx.spotBuyRatio = sRatio;
  }

  private async pollHyperliquid(): Promise<RawExchangeVol | null> {
    const [perpRes, spotRes] = await Promise.all([
      safeFetchJson<[{ universe: { name: string }[] }, Record<string, string>[]]>(
        'https://api.hyperliquid.xyz/info',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
        }
      ),
      safeFetchJson<[unknown, { coin?: string; dayBaseVlm?: string; dayNtlVlm?: string }[]]>(
        'https://api.hyperliquid.xyz/info',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'spotMetaAndAssetCtxs' }),
        }
      ),
    ]);

    let derivBtc = 0;
    let derivUsd = 0;
    if (Array.isArray(perpRes) && perpRes.length >= 2) {
      const idx = perpRes[0]?.universe?.findIndex((u) => u.name === 'BTC');
      if (idx !== undefined && idx >= 0 && perpRes[1][idx]) {
        derivBtc = parseFloat(perpRes[1][idx].dayBaseVlm || '0') || 0;
        derivUsd = parseFloat(perpRes[1][idx].dayNtlVlm || '0') || 0;
      }
    }

    let spotBtc = 0;
    let spotUsd = 0;
    if (Array.isArray(spotRes) && Array.isArray(spotRes[1])) {
      const ubtc = spotRes[1].find((c) => c.coin === '@142');
      if (ubtc) {
        spotBtc = parseFloat(ubtc.dayBaseVlm || '0') || 0;
        spotUsd = parseFloat(ubtc.dayNtlVlm || '0') || 0;
      }
    }

    if (spotBtc === 0 && derivBtc === 0) return null;
    return {
      spotBtc: +spotBtc.toFixed(2),
      spotUsd: Math.round(spotUsd),
      derivBtc: +derivBtc.toFixed(2),
      derivUsd: Math.round(derivUsd),
    };
  }

  private async pollAll() {
    const [bn, byb, hl] = await Promise.all([
      this.pollBinance(),
      this.pollBybit(),
      this.pollHyperliquid(),
      this.pollOkxSentiment(),
    ]);
    if (bn) this.raw.binance = bn;
    if (byb) this.raw.bybit = byb;
    if (hl) this.raw.hyperliquid = hl;
    this.syncLiveCollectors();
    this.updatedAt = Date.now();
  }

  private syncLiveCollectors() {
    const okxVol = this.okx.getVolumeBreakdown();
    if (okxVol.spotBtc > 0 || okxVol.derivBtc > 0) {
      this.raw.okx = okxVol;
    }
    const cbVol = this.coinbase.getVolumeBreakdown();
    if (cbVol.spotBtc > 0) {
      this.raw.coinbase = cbVol;
    }
  }

  public getDistribution(): VolumeDistributionResponse {
    this.syncLiveCollectors();

    const meta: {
      key: TrackedExchange;
      code: 'BN' | 'BYB' | 'OKX' | 'CB' | 'HL';
      label: string;
    }[] = [
      { key: 'binance', code: 'BN', label: 'Binance' },
      { key: 'bybit', code: 'BYB', label: 'Bybit' },
      { key: 'okx', code: 'OKX', label: 'OKX' },
      { key: 'hyperliquid', code: 'HL', label: 'Hyperliquid' },
      { key: 'coinbase', code: 'CB', label: 'Coinbase' },
    ];

    let totalSpotBtc = 0;
    let totalSpotUsd = 0;
    let totalDerivBtc = 0;
    let totalDerivUsd = 0;

    for (const m of meta) {
      const r = this.raw[m.key];
      totalSpotBtc += r.spotBtc;
      totalSpotUsd += r.spotUsd;
      totalDerivBtc += r.derivBtc;
      totalDerivUsd += r.derivUsd;
    }

    const totalBtc = totalSpotBtc + totalDerivBtc;
    const totalUsd = totalSpotUsd + totalDerivUsd;

    let aggSpotBuyBtc = 0;
    let aggSpotSellBtc = 0;
    let aggDerivBuyBtc = 0;
    let aggDerivSellBtc = 0;
    let weightedLongSum = 0;
    let weightedLongWeight = 0;

    const exchanges: ExchangeVolumeShareItem[] = meta.map((m) => {
      const r = this.raw[m.key];
      const flow = this.getLiveFlowTotals(m.key);
      const restRatio = this.restBuyRatios[m.key];

      const liveSpotTot = flow.spotBuy + flow.spotSell;
      const liveDerivTot = flow.derivBuy + flow.derivSell;

      // Resolve authoritative 24h Buy ratio (REST 24h klines/taker when available, else live WS flow)
      const spotBuyRatio =
        restRatio.spotBuyRatio !== null
          ? restRatio.spotBuyRatio
          : liveSpotTot > 0.001
            ? flow.spotBuy / liveSpotTot
            : 0.5;

      const derivBuyRatio =
        restRatio.derivBuyRatio !== null
          ? restRatio.derivBuyRatio
          : liveDerivTot > 0.001
            ? flow.derivBuy / liveDerivTot
            : 0.5;

      const spotBuyBtc = +(r.spotBtc * spotBuyRatio).toFixed(2);
      const spotSellBtc = +(r.spotBtc - spotBuyBtc).toFixed(2);
      const derivBuyBtc = +(r.derivBtc * derivBuyRatio).toFixed(2);
      const derivSellBtc = +(r.derivBtc - derivBuyBtc).toFixed(2);

      const exTotalBtc = r.spotBtc + r.derivBtc;
      const exTotalUsd = r.spotUsd + r.derivUsd;
      const buyBtc = +(spotBuyBtc + derivBuyBtc).toFixed(2);
      const sellBtc = +(spotSellBtc + derivSellBtc).toFixed(2);
      const buyPct = exTotalBtc > 0 ? +((buyBtc / exTotalBtc) * 100).toFixed(1) : 50;

      aggSpotBuyBtc += spotBuyBtc;
      aggSpotSellBtc += spotSellBtc;
      aggDerivBuyBtc += derivBuyBtc;
      aggDerivSellBtc += derivSellBtc;

      // Long vs Short positioning (official account ratio for BN/BYB/OKX, live perp flow for HL, null for CB spot)
      let longPct: number | null = null;
      let shortPct: number | null = null;
      let longShortRatio: number | null = null;
      let lsSource: 'accounts' | 'flow' | undefined;

      const ls = this.restLongShort[m.key];
      if (ls) {
        longPct = ls.longPct;
        shortPct = ls.shortPct;
        longShortRatio = ls.ratio;
        lsSource = ls.source;
      } else if (m.key === 'hyperliquid' && r.derivBtc > 0) {
        const lp = +(derivBuyRatio * 100).toFixed(1);
        const sp = +(100 - lp).toFixed(1);
        longPct = lp;
        shortPct = sp;
        longShortRatio = sp > 0 ? +(lp / sp).toFixed(2) : 1;
        lsSource = 'flow';
      }

      if (longPct !== null && r.derivBtc > 0) {
        weightedLongSum += longPct * r.derivBtc;
        weightedLongWeight += r.derivBtc;
      }

      return {
        exchange: m.key,
        code: m.code,
        label: m.label,
        spotBtc: +r.spotBtc.toFixed(2),
        spotUsd: Math.round(r.spotUsd),
        derivBtc: +r.derivBtc.toFixed(2),
        derivUsd: Math.round(r.derivUsd),
        totalBtc: +exTotalBtc.toFixed(2),
        totalUsd: Math.round(exTotalUsd),
        spotPct: totalSpotBtc > 0 ? +((r.spotBtc / totalSpotBtc) * 100).toFixed(2) : 0,
        derivPct: totalDerivBtc > 0 ? +((r.derivBtc / totalDerivBtc) * 100).toFixed(2) : 0,
        totalPct: totalBtc > 0 ? +((exTotalBtc / totalBtc) * 100).toFixed(2) : 0,
        spotBuyBtc,
        spotSellBtc,
        spotBuyPct: r.spotBtc > 0 ? +(spotBuyRatio * 100).toFixed(1) : 0,
        spotSellPct: r.spotBtc > 0 ? +((1 - spotBuyRatio) * 100).toFixed(1) : 0,
        derivBuyBtc,
        derivSellBtc,
        derivBuyPct: r.derivBtc > 0 ? +(derivBuyRatio * 100).toFixed(1) : 0,
        derivSellPct: r.derivBtc > 0 ? +((1 - derivBuyRatio) * 100).toFixed(1) : 0,
        buyBtc,
        sellBtc,
        buyPct,
        sellPct: +(100 - buyPct).toFixed(1),
        longPct,
        shortPct,
        longShortRatio,
        lsSource,
      };
    });

    const totalBuyBtc = +(aggSpotBuyBtc + aggDerivBuyBtc).toFixed(2);
    const totalSellBtc = +(aggSpotSellBtc + aggDerivSellBtc).toFixed(2);
    const buySharePct = totalBtc > 0 ? +((totalBuyBtc / totalBtc) * 100).toFixed(1) : 50;
    const spotBuyPct = totalSpotBtc > 0 ? +((aggSpotBuyBtc / totalSpotBtc) * 100).toFixed(1) : 50;
    const derivBuyPct =
      totalDerivBtc > 0 ? +((aggDerivBuyBtc / totalDerivBtc) * 100).toFixed(1) : 50;

    const avgLongPct =
      weightedLongWeight > 0 ? +(weightedLongSum / weightedLongWeight).toFixed(1) : 50;
    const avgShortPct = +(100 - avgLongPct).toFixed(1);
    const avgLongShortRatio = avgShortPct > 0 ? +(avgLongPct / avgShortPct).toFixed(2) : 1;

    return {
      updatedAt: this.updatedAt || Date.now(),
      totalSpotBtc: +totalSpotBtc.toFixed(2),
      totalSpotUsd: Math.round(totalSpotUsd),
      totalDerivBtc: +totalDerivBtc.toFixed(2),
      totalDerivUsd: Math.round(totalDerivUsd),
      totalBtc: +totalBtc.toFixed(2),
      totalUsd: Math.round(totalUsd),
      spotSharePct: totalBtc > 0 ? +((totalSpotBtc / totalBtc) * 100).toFixed(2) : 0,
      derivSharePct: totalBtc > 0 ? +((totalDerivBtc / totalBtc) * 100).toFixed(2) : 0,
      totalBuyBtc,
      totalSellBtc,
      buySharePct,
      sellSharePct: +(100 - buySharePct).toFixed(1),
      spotBuyBtc: +aggSpotBuyBtc.toFixed(2),
      spotSellBtc: +aggSpotSellBtc.toFixed(2),
      spotBuyPct,
      spotSellPct: +(100 - spotBuyPct).toFixed(1),
      derivBuyBtc: +aggDerivBuyBtc.toFixed(2),
      derivSellBtc: +aggDerivSellBtc.toFixed(2),
      derivBuyPct,
      derivSellPct: +(100 - derivBuyPct).toFixed(1),
      avgLongPct,
      avgShortPct,
      avgLongShortRatio,
      exchanges,
    };
  }
}
