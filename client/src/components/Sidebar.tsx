import React, { useMemo, useState } from 'react';
import type {
  BookScope,
  ClusterBucketSummary,
  ClusterFilterBtc,
  ExchangeId,
  FundingRatesResponse,
  LiquidationEvent,
  TickerStats,
  TradeEvent,
  VolumeDistributionResponse,
  WallLevel,
} from '../../../shared/types.ts';

interface SidebarProps {
  exchange: ExchangeId;
  ticker: TickerStats;
  bookScope: BookScope;
  clusterFilterBtc: ClusterFilterBtc;
  onSelectClusterFilter: (val: ClusterFilterBtc) => void;
  bidClusters: WallLevel[];
  askClusters: WallLevel[];
  clusterSummary: ClusterBucketSummary[];
  recentTrades: TradeEvent[];
  whaleTrades: TradeEvent[];
  recentLiquidations: LiquidationEvent[];
  volumeDistribution: VolumeDistributionResponse | null;
  fundingRates: FundingRatesResponse | null;
  onSelectWallPrice: (price: number) => void;
  onSwitchExchange: (ex: ExchangeId) => void;
}

const WHALE_THRESHOLD_OPTIONS = [0.5, 1, 2, 5, 10] as const;

const EXCHANGE_BAR_COLORS: Record<string, string> = {
  binance: '#facc15',
  bybit: '#f59e0b',
  okx: '#a3e635',
  hyperliquid: '#2dd4bf',
  coinbase: '#3b82f6',
};

function formatCompactBtc(btc: number): string {
  if (btc >= 1_000_000) return `${(btc / 1_000_000).toFixed(2)}M BTC`;
  if (btc >= 1_000) return `${(btc / 1_000).toFixed(1)}k BTC`;
  return `${btc.toFixed(1)} BTC`;
}

function formatCompactUsd(usd: number): string {
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(0)}k`;
  return `$${usd.toFixed(0)}`;
}

function formatCountdown(targetMs: number): string {
  if (!targetMs) return '—';
  const diff = Math.max(0, targetMs - Date.now());
  const totalMin = Math.floor(diff / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export const Sidebar: React.FC<SidebarProps> = React.memo(({
  exchange,
  ticker,
  bookScope,
  clusterFilterBtc,
  onSelectClusterFilter,
  bidClusters,
  askClusters,
  clusterSummary,
  recentTrades,
  whaleTrades,
  recentLiquidations,
  volumeDistribution,
  fundingRates,
  onSelectWallPrice,
  onSwitchExchange,
}) => {
  const [activeTab, setActiveTab] = useState<'clusters' | 'trades' | 'volume' | 'funding'>('clusters');
  const [tradesSubTab, setTradesSubTab] = useState<'all' | 'whales' | 'liqs'>('all');
  const [volSubTab, setVolSubTab] = useState<'all' | 'spot' | 'deriv'>('all');
  const [whaleMinBtc, setWhaleMinBtc] = useState<number>(0.5);
  const [whaleSideFilter, setWhaleSideFilter] = useState<'all' | 'Buy' | 'Sell'>('all');
  const [sortBy, setSortBy] = useState<'size' | 'price'>('size');

  const liquiditySplit = useMemo(() => {
    const calc = (bid: number, ask: number) => {
      const tot = bid + ask;
      const bidPct = tot > 0 ? Math.round((bid / tot) * 100) : 50;
      const askPct = 100 - bidPct;
      const imbalPct = tot > 0 ? +(((bid - ask) / tot) * 100).toFixed(1) : 0;
      return { bid: +bid.toFixed(1), ask: +ask.toFixed(1), tot, bidPct, askPct, imbalPct };
    };

    if (exchange === 'coinbase') {
      return {
        deriv: calc(0, 0),
        spot: calc(ticker.totalBidBtc, ticker.totalAskBtc),
      };
    }

    const spotCov = ticker.coverageItems.find((c) => c.id === 'SPOT');
    const spotBid = spotCov?.bidBtc || 0;
    const spotAsk = spotCov?.askBtc || 0;

    if (exchange === 'combined') {
      const exItems = ticker.coverageItems.filter((c) => c.id !== 'SPOT');
      const allBid = exItems.reduce((s, c) => s + c.bidBtc, 0);
      const allAsk = exItems.reduce((s, c) => s + c.askBtc, 0);
      return {
        deriv: calc(Math.max(0, allBid - spotBid), Math.max(0, allAsk - spotAsk)),
        spot: calc(spotBid, spotAsk),
      };
    }

    const derivItems = ticker.coverageItems.filter((c) => c.id !== 'SPOT');
    const derivBid = derivItems.reduce((s, c) => s + c.bidBtc, 0);
    const derivAsk = derivItems.reduce((s, c) => s + c.askBtc, 0);
    return {
      deriv: calc(derivBid, derivAsk),
      spot: calc(spotBid, spotAsk),
    };
  }, [exchange, ticker.coverageItems, ticker.totalBidBtc, ticker.totalAskBtc]);

  const filteredAsks = useMemo(() => {
    const minReq = clusterFilterBtc > 0 ? clusterFilterBtc : 0.5;
    const list = askClusters.filter((w) => w.sizeBtc >= minReq);
    if (sortBy === 'price') {
      return [...list].sort((a, b) => a.price - b.price);
    }
    return [...list].sort((a, b) => b.sizeBtc - a.sizeBtc);
  }, [askClusters, clusterFilterBtc, sortBy]);

  const filteredBids = useMemo(() => {
    const minReq = clusterFilterBtc > 0 ? clusterFilterBtc : 0.5;
    const list = bidClusters.filter((w) => w.sizeBtc >= minReq);
    if (sortBy === 'price') {
      return [...list].sort((a, b) => b.price - a.price);
    }
    return [...list].sort((a, b) => b.sizeBtc - a.sizeBtc);
  }, [bidClusters, clusterFilterBtc, sortBy]);

  const maxWallBtc = useMemo(
    () =>
      Math.max(
        1,
        ...filteredBids.slice(0, 20).map((w) => w.sizeBtc),
        ...filteredAsks.slice(0, 20).map((w) => w.sizeBtc)
      ),
    [filteredBids, filteredAsks]
  );

  const filteredWhales = useMemo(
    () =>
      whaleTrades.filter(
        (tr) =>
          tr.v >= whaleMinBtc && (whaleSideFilter === 'all' || tr.s === whaleSideFilter)
      ),
    [whaleTrades, whaleMinBtc, whaleSideFilter]
  );

  const whaleFlowStats = useMemo(() => {
    let buyBtc = 0;
    let sellBtc = 0;
    for (const tr of filteredWhales) {
      if (tr.s === 'Buy') buyBtc += tr.v;
      else sellBtc += tr.v;
    }
    return { buyBtc, sellBtc, netBtc: buyBtc - sellBtc };
  }, [filteredWhales]);

  const liqStats = useMemo(() => {
    let longUsd = 0;
    let shortUsd = 0;
    for (const lq of recentLiquidations) {
      if (lq.side === 'Long') longUsd += lq.usd;
      else shortUsd += lq.usd;
    }
    return { longUsd, shortUsd };
  }, [recentLiquidations]);

  const exchangeTitle =
    exchange === 'combined'
      ? 'ALL 5 EXCHANGES'
      : exchange === 'hyperliquid'
        ? 'HYPERLIQUID'
        : exchange === 'coinbase'
          ? 'COINBASE'
          : exchange === 'okx'
            ? 'OKX'
            : exchange === 'binance'
              ? 'BINANCE'
              : 'BYBIT';

  const getExchangeBadgeClass = (ex?: string) => {
    if (ex === 'BYB') return 'v-byb-p';
    if (ex === 'OKX') return 'v-okx-p';
    if (ex === 'CB') return 'v-cb-s';
    if (ex === 'HL') return 'v-hl-p';
    return 'v-bn-p';
  };

  const formatBreakdownTitle = (w: WallLevel) =>
    Object.entries(w.breakdown)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');

  return (
    <aside className="right-sidebar">
      {/* 1. Multi-Market Liquidity Coverage & Imbalance */}
      <section className="sidebar-card">
        <div className="card-header">
          <span>
            {exchangeTitle} LIQUIDITY ({bookScope.toUpperCase()})
          </span>
          <span
            className={
              ticker.imbalancePct > 5
                ? 'text-bid'
                : ticker.imbalancePct < -5
                  ? 'text-ask'
                  : 'text-muted'
            }
          >
            {ticker.imbalancePct >= 0 ? '+' : ''}
            {ticker.imbalancePct.toFixed(1)}% Imbal
          </span>
        </div>
        <div className="imbalance-split-group">
          <div className="imbalance-split-row">
            <div className="imbalance-stats">
              <span className="imbalance-row-label">
                <span className="cov-tag tag-lin">DERIVS</span>
                {liquiditySplit.deriv.tot > 0 ? (
                  <span className="text-bid">
                    {liquiditySplit.deriv.bid.toFixed(1)}B ({liquiditySplit.deriv.bidPct}%)
                  </span>
                ) : (
                  <span className="text-muted">Spot only</span>
                )}
              </span>
              {liquiditySplit.deriv.tot > 0 && (
                <span className="text-ask">
                  {liquiditySplit.deriv.ask.toFixed(1)}A ({liquiditySplit.deriv.askPct}%)
                </span>
              )}
            </div>
            <div
              className="imbalance-bar-track"
              title={`Derivatives Liquidity — Bids: ${liquiditySplit.deriv.bid.toFixed(1)} BTC (${liquiditySplit.deriv.bidPct}%) vs Asks: ${liquiditySplit.deriv.ask.toFixed(1)} BTC (${liquiditySplit.deriv.askPct}%) • Imbal: ${liquiditySplit.deriv.imbalPct >= 0 ? '+' : ''}${liquiditySplit.deriv.imbalPct}%`}
            >
              {liquiditySplit.deriv.tot > 0 && (
                <>
                  <div
                    className="imbalance-bid-fill"
                    style={{ width: `${liquiditySplit.deriv.bidPct}%` }}
                  />
                  <div
                    className="imbalance-ask-fill"
                    style={{ width: `${liquiditySplit.deriv.askPct}%` }}
                  />
                </>
              )}
            </div>
          </div>

          <div className="imbalance-split-row">
            <div className="imbalance-stats">
              <span className="imbalance-row-label">
                <span className="cov-tag tag-spot">SPOT</span>
                <span className="text-bid">
                  {liquiditySplit.spot.bid.toFixed(1)}B ({liquiditySplit.spot.bidPct}%)
                </span>
              </span>
              <span className="text-ask">
                {liquiditySplit.spot.ask.toFixed(1)}A ({liquiditySplit.spot.askPct}%)
              </span>
            </div>
            <div
              className="imbalance-bar-track"
              title={`Spot Liquidity — Bids: ${liquiditySplit.spot.bid.toFixed(1)} BTC (${liquiditySplit.spot.bidPct}%) vs Asks: ${liquiditySplit.spot.ask.toFixed(1)} BTC (${liquiditySplit.spot.askPct}%) • Imbal: ${liquiditySplit.spot.imbalPct >= 0 ? '+' : ''}${liquiditySplit.spot.imbalPct}%`}
            >
              {liquiditySplit.spot.tot > 0 && (
                <>
                  <div
                    className="imbalance-bid-fill"
                    style={{ width: `${liquiditySplit.spot.bidPct}%` }}
                  />
                  <div
                    className="imbalance-ask-fill"
                    style={{ width: `${liquiditySplit.spot.askPct}%` }}
                  />
                </>
              )}
            </div>
          </div>
        </div>

        <div
          className={`coverage-grid ${
            ticker.coverageItems.length === 3 ? 'cov-grid-3' : ''
          }`}
        >
          {ticker.coverageItems.map((item) => (
            <div
              key={item.id}
              className="cov-pill"
              title={`${item.label}: ${item.bidBtc} Bids / ${item.askBtc} Asks (${item.bidLevels + item.askLevels} lvls) ${item.extraNote || ''}`}
            >
              <span className={`cov-tag ${item.badgeClass}`}>{item.label}</span>
              <span>{(item.bidBtc + item.askBtc).toFixed(0)} BTC</span>
            </div>
          ))}
        </div>
      </section>

      {/* 2. BTC Cluster Tier Distribution */}
      <section className="sidebar-card tier-matrix-card">
        <div className="card-header">
          <span>BTC CLUSTER BUCKETS (CLICK TO FILTER)</span>
          {clusterFilterBtc > 0 && (
            <button className="mini-reset-btn" onClick={() => onSelectClusterFilter(0)}>
              Show All
            </button>
          )}
        </div>
        <div className="tier-grid">
          {clusterSummary.map((tier) => {
            const isActive = clusterFilterBtc === tier.minBtc;
            return (
              <button
                key={tier.label}
                className={`tier-row ${isActive ? 'tier-active' : ''}`}
                onClick={() =>
                  onSelectClusterFilter(isActive ? 0 : (tier.minBtc as ClusterFilterBtc))
                }
                title={`Filter clusters >= ${tier.minBtc} BTC`}
              >
                <span className="tier-name">{tier.label}</span>
                <span className="text-bid">
                  {tier.bidCount} ({tier.bidBtc.toFixed(0)}B)
                </span>
                <span className="text-ask">
                  {tier.askCount} ({tier.askBtc.toFixed(0)}A)
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 3. Tabbed Full Explorer: Orderbook Clusters vs Live Trades vs Vol % vs Funding Rates */}
      <section className="sidebar-card explorer-card">
        <div className="explorer-tabs explorer-tabs-4">
          <button
            className={activeTab === 'clusters' ? 'active' : ''}
            onClick={() => setActiveTab('clusters')}
            title="All resting orderbook Bid/Ask clusters"
          >
            Clusters ({filteredBids.length + filteredAsks.length})
          </button>
          <button
            className={activeTab === 'trades' ? 'active' : ''}
            onClick={() => setActiveTab('trades')}
            title="Live market trades, whale fills, and liquidations"
          >
            Trades ({recentTrades.length})
          </button>
          <button
            className={activeTab === 'volume' ? 'active' : ''}
            onClick={() => setActiveTab('volume')}
            title="24h BTC volume distribution across all 5 exchanges (Spot vs Derivatives)"
          >
            Vol %
          </button>
          <button
            className={activeTab === 'funding' ? 'active' : ''}
            onClick={() => setActiveTab('funding')}
            title="Live perpetual funding rates & APR across all exchanges"
          >
            Funding
          </button>
        </div>

        {activeTab === 'clusters' ? (
          <div className="clusters-explorer">
            <div className="cluster-controls-row">
              <span className="text-muted">
                Filter: {clusterFilterBtc === 0 ? '≥ 0.5 BTC' : `≥ ${clusterFilterBtc} BTC`}
              </span>
              <div className="sort-toggle">
                <button
                  className={sortBy === 'size' ? 'active' : ''}
                  onClick={() => setSortBy('size')}
                >
                  Sort: BTC Size
                </button>
                <button
                  className={sortBy === 'price' ? 'active' : ''}
                  onClick={() => setSortBy('price')}
                >
                  Sort: Price
                </button>
              </div>
            </div>

            <div className="clusters-scroll">
              <div className="walls-subhead text-ask">
                ASK CLUSTERS ({filteredAsks.length})
              </div>
              <div className="walls-list">
                {filteredAsks.slice(0, 120).map((w) => (
                  <button
                    key={`ask-${w.price}`}
                    className="wall-row ask-wall-row"
                    onClick={() => onSelectWallPrice(w.price)}
                    title={formatBreakdownTitle(w)}
                  >
                    <div
                      className="wall-bg-bar ask-bg"
                      style={{ width: `${Math.min(100, (w.sizeBtc / maxWallBtc) * 100)}%` }}
                    />
                    <span className="wall-price text-ask">{w.price.toFixed(1)}</span>
                    <span className="wall-btc">
                      <strong>{w.sizeBtc.toFixed(2)} BTC</strong>
                    </span>
                    <span className="wall-venues">
                      {w.venues.map((v) => (
                        <em key={v} className={`v-badge v-${v.toLowerCase()}`}>
                          {v}
                        </em>
                      ))}
                    </span>
                    <span className="wall-dist">+{w.distancePct.toFixed(2)}%</span>
                  </button>
                ))}
              </div>

              <div className="spread-divider">
                <span>SPREAD: ${ticker.spread.toFixed(1)}</span>
                <span>
                  MID: ${((ticker.bestBid + ticker.bestAsk) / 2 || ticker.lastPrice).toFixed(1)}
                </span>
              </div>

              <div className="walls-subhead text-bid">
                BID CLUSTERS ({filteredBids.length})
              </div>
              <div className="walls-list">
                {filteredBids.slice(0, 120).map((w) => (
                  <button
                    key={`bid-${w.price}`}
                    className="wall-row bid-wall-row"
                    onClick={() => onSelectWallPrice(w.price)}
                    title={formatBreakdownTitle(w)}
                  >
                    <div
                      className="wall-bg-bar bid-bg"
                      style={{ width: `${Math.min(100, (w.sizeBtc / maxWallBtc) * 100)}%` }}
                    />
                    <span className="wall-price text-bid">{w.price.toFixed(1)}</span>
                    <span className="wall-btc">
                      <strong>{w.sizeBtc.toFixed(2)} BTC</strong>
                    </span>
                    <span className="wall-venues">
                      {w.venues.map((v) => (
                        <em key={v} className={`v-badge v-${v.toLowerCase()}`}>
                          {v}
                        </em>
                      ))}
                    </span>
                    <span className="wall-dist">{w.distancePct.toFixed(2)}%</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : activeTab === 'volume' ? (
          <div className="vol-share-wrap">
            <div className="trades-subtabs trades-subtabs-3" role="tablist">
              <button
                role="tab"
                aria-selected={volSubTab === 'all'}
                className={volSubTab === 'all' ? 'active' : ''}
                onClick={() => setVolSubTab('all')}
              >
                All (5)
              </button>
              <button
                role="tab"
                aria-selected={volSubTab === 'spot'}
                className={`vol-spot-subtab ${volSubTab === 'spot' ? 'active' : ''}`}
                onClick={() => setVolSubTab('spot')}
              >
                Spot
              </button>
              <button
                role="tab"
                aria-selected={volSubTab === 'deriv'}
                className={`vol-deriv-subtab ${volSubTab === 'deriv' ? 'active' : ''}`}
                onClick={() => setVolSubTab('deriv')}
              >
                Derivatives
              </button>
            </div>

            {!volumeDistribution || volumeDistribution.totalBtc === 0 ? (
              <div className="trades-empty">Loading 24h volume distribution across 5 exchanges...</div>
            ) : (
              (() => {
                const activeTotalBtc =
                  volSubTab === 'spot'
                    ? volumeDistribution.totalSpotBtc
                    : volSubTab === 'deriv'
                      ? volumeDistribution.totalDerivBtc
                      : volumeDistribution.totalBtc;
                const activeTotalUsd =
                  volSubTab === 'spot'
                    ? volumeDistribution.totalSpotUsd
                    : volSubTab === 'deriv'
                      ? volumeDistribution.totalDerivUsd
                      : volumeDistribution.totalUsd;
                const activeBuyBtc =
                  volSubTab === 'spot'
                    ? volumeDistribution.spotBuyBtc
                    : volSubTab === 'deriv'
                      ? volumeDistribution.derivBuyBtc
                      : volumeDistribution.totalBuyBtc;
                const activeSellBtc =
                  volSubTab === 'spot'
                    ? volumeDistribution.spotSellBtc
                    : volSubTab === 'deriv'
                      ? volumeDistribution.derivSellBtc
                      : volumeDistribution.totalSellBtc;
                const activeBuyPct =
                  volSubTab === 'spot'
                    ? volumeDistribution.spotBuyPct
                    : volSubTab === 'deriv'
                      ? volumeDistribution.derivBuyPct
                      : volumeDistribution.buySharePct;
                const activeSellPct =
                  volSubTab === 'spot'
                    ? volumeDistribution.spotSellPct
                    : volSubTab === 'deriv'
                      ? volumeDistribution.derivSellPct
                      : volumeDistribution.sellSharePct;

                const sorted = [...volumeDistribution.exchanges].sort((a, b) => {
                  const pa =
                    volSubTab === 'spot' ? a.spotPct : volSubTab === 'deriv' ? a.derivPct : a.totalPct;
                  const pb =
                    volSubTab === 'spot' ? b.spotPct : volSubTab === 'deriv' ? b.derivPct : b.totalPct;
                  return pb - pa;
                });

                return (
                  <div className="vol-share-body">
                    <div className="vol-summary-box">
                      <div className="vol-summary-top">
                        <span className="text-muted">
                          {volSubTab === 'spot'
                            ? '24H SPOT VOL'
                            : volSubTab === 'deriv'
                              ? '24H DERIVS VOL'
                              : '24H TOTAL VOL'}
                        </span>
                        <strong>
                          {formatCompactBtc(activeTotalBtc)} • {formatCompactUsd(activeTotalUsd)}
                        </strong>
                      </div>

                      {/* Aggregate Buy vs Sell Volume Split */}
                      <div className="vol-metric-block">
                        <div className="vol-macro-labels">
                          <span className="text-bid">
                            ▲ Buy {activeBuyPct.toFixed(1)}% ({formatCompactBtc(activeBuyBtc)})
                          </span>
                          <span className="text-ask">
                            ▼ Sell {activeSellPct.toFixed(1)}% ({formatCompactBtc(activeSellBtc)})
                          </span>
                        </div>
                        <div className="vol-bs-track">
                          <div className="vol-bs-buy" style={{ width: `${activeBuyPct}%` }} />
                          <div className="vol-bs-sell" style={{ width: `${activeSellPct}%` }} />
                        </div>
                      </div>

                      {/* Aggregate Long vs Short Ratio (Derivatives) */}
                      {volSubTab !== 'spot' && (
                        <div className="vol-metric-block">
                          <div className="vol-macro-labels">
                            <span className="vol-long-text">
                              Long {volumeDistribution.avgLongPct.toFixed(1)}%
                            </span>
                            <span className="vol-ls-ratio-pill">
                              L/S {volumeDistribution.avgLongShortRatio.toFixed(2)}
                            </span>
                            <span className="vol-short-text">
                              Short {volumeDistribution.avgShortPct.toFixed(1)}%
                            </span>
                          </div>
                          <div className="vol-ls-track">
                            <div
                              className="vol-ls-long"
                              style={{ width: `${volumeDistribution.avgLongPct}%` }}
                            />
                            <div
                              className="vol-ls-short"
                              style={{ width: `${volumeDistribution.avgShortPct}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Spot vs Derivatives Market Split */}
                      {volSubTab === 'all' && (
                        <div className="vol-metric-block">
                          <div className="vol-macro-labels">
                            <span className="text-bid">
                              Spot {volumeDistribution.spotSharePct.toFixed(1)}%
                            </span>
                            <span className="vol-deriv-text">
                              Derivs {volumeDistribution.derivSharePct.toFixed(1)}%
                            </span>
                          </div>
                          <div className="vol-macro-split-track">
                            <div
                              className="vol-macro-spot"
                              style={{ width: `${volumeDistribution.spotSharePct}%` }}
                            />
                            <div
                              className="vol-macro-deriv"
                              style={{ width: `${volumeDistribution.derivSharePct}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="vol-stacked-bar" title="5-Exchange Volume Share">
                      {sorted.map((item) => {
                        const pct =
                          volSubTab === 'spot'
                            ? item.spotPct
                            : volSubTab === 'deriv'
                              ? item.derivPct
                              : item.totalPct;
                        if (pct <= 0) return null;
                        return (
                          <div
                            key={item.exchange}
                            className="vol-stacked-seg"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: EXCHANGE_BAR_COLORS[item.exchange] || '#38bdf8',
                            }}
                            title={`${item.label}: ${pct.toFixed(1)}%`}
                          />
                        );
                      })}
                    </div>

                    <div className="vol-exchange-list">
                      {sorted.map((item) => {
                        const pct =
                          volSubTab === 'spot'
                            ? item.spotPct
                            : volSubTab === 'deriv'
                              ? item.derivPct
                              : item.totalPct;
                        const btc =
                          volSubTab === 'spot'
                            ? item.spotBtc
                            : volSubTab === 'deriv'
                              ? item.derivBtc
                              : item.totalBtc;
                        const usd =
                          volSubTab === 'spot'
                            ? item.spotUsd
                            : volSubTab === 'deriv'
                              ? item.derivUsd
                              : item.totalUsd;
                        const exBuyPct =
                          volSubTab === 'spot'
                            ? item.spotBuyPct
                            : volSubTab === 'deriv'
                              ? item.derivBuyPct
                              : item.buyPct;
                        const exSellPct =
                          volSubTab === 'spot'
                            ? item.spotSellPct
                            : volSubTab === 'deriv'
                              ? item.derivSellPct
                              : item.sellPct;
                        const exBuyBtc =
                          volSubTab === 'spot'
                            ? item.spotBuyBtc
                            : volSubTab === 'deriv'
                              ? item.derivBuyBtc
                              : item.buyBtc;
                        const exSellBtc =
                          volSubTab === 'spot'
                            ? item.spotSellBtc
                            : volSubTab === 'deriv'
                              ? item.derivSellBtc
                              : item.sellBtc;
                        const color = EXCHANGE_BAR_COLORS[item.exchange] || '#38bdf8';
                        const exSpotRatio =
                          item.totalBtc > 0 ? Math.round((item.spotBtc / item.totalBtc) * 100) : 0;
                        const exDerivRatio = item.totalBtc > 0 ? 100 - exSpotRatio : 0;
                        const isSelected = exchange === item.exchange;

                        return (
                          <button
                            key={item.exchange}
                            type="button"
                            className={`vol-ex-row ${isSelected ? 'vol-ex-row-active' : ''}`}
                            onClick={() => onSwitchExchange(item.exchange)}
                            title={`Click to switch chart to ${item.label} • Buy: ${formatCompactBtc(exBuyBtc)} / Sell: ${formatCompactBtc(exSellBtc)}`}
                          >
                            <div className="vol-ex-head">
                              <span className="vol-ex-name">
                                <span
                                  className="vol-ex-dot"
                                  style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
                                />
                                <em className={`v-badge ${getExchangeBadgeClass(item.code)}`}>
                                  {item.code}
                                </em>
                                <strong>{item.label}</strong>
                              </span>
                              <strong className="vol-ex-pct" style={{ color }}>
                                {pct.toFixed(1)}%
                              </strong>
                            </div>
                            <div className="vol-ex-bar-track">
                              <div
                                className="vol-ex-bar-fill"
                                style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }}
                              />
                            </div>
                            <div className="vol-ex-meta">
                              <span>
                                {btc > 0
                                  ? `${formatCompactBtc(btc)} • ${formatCompactUsd(usd)}`
                                  : volSubTab === 'deriv'
                                    ? 'Spot only (no public perp)'
                                    : '0 BTC'}
                              </span>
                              {volSubTab === 'all' && item.totalBtc > 0 && (
                                <span className="vol-ex-split">
                                  {exDerivRatio === 0
                                    ? '100% Spot'
                                    : `S ${exSpotRatio}% / D ${exDerivRatio}%`}
                                </span>
                              )}
                            </div>

                            {/* Per-Exchange Buy vs Sell Bar */}
                            {btc > 0 && (
                              <div className="vol-ex-submetric">
                                <div className="vol-ex-sublabels">
                                  <span className="text-bid">
                                    B {exBuyPct.toFixed(1)}% ({formatCompactBtc(exBuyBtc).replace(' BTC', '')})
                                  </span>
                                  <span className="text-ask">
                                    S {exSellPct.toFixed(1)}% ({formatCompactBtc(exSellBtc).replace(' BTC', '')})
                                  </span>
                                </div>
                                <div className="vol-bs-track vol-mini-track">
                                  <div className="vol-bs-buy" style={{ width: `${exBuyPct}%` }} />
                                  <div className="vol-bs-sell" style={{ width: `${exSellPct}%` }} />
                                </div>
                              </div>
                            )}

                            {/* Per-Exchange Long vs Short Bar (Derivatives) */}
                            {volSubTab !== 'spot' && item.longPct !== null && item.shortPct !== null && (
                              <div className="vol-ex-submetric">
                                <div className="vol-ex-sublabels">
                                  <span className="vol-long-text">
                                    L {item.longPct.toFixed(1)}%
                                  </span>
                                  <span className="vol-ls-mini-tag">
                                    L/S {item.longShortRatio?.toFixed(2)}{' '}
                                    {item.lsSource === 'flow' ? '(Flow)' : '(Accts)'}
                                  </span>
                                  <span className="vol-short-text">
                                    S {item.shortPct.toFixed(1)}%
                                  </span>
                                </div>
                                <div className="vol-ls-track vol-mini-track">
                                  <div
                                    className="vol-ls-long"
                                    style={{ width: `${item.longPct}%` }}
                                  />
                                  <div
                                    className="vol-ls-short"
                                    style={{ width: `${item.shortPct}%` }}
                                  />
                                </div>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()
            )}
          </div>
        ) : activeTab === 'funding' ? (
          <div className="vol-share-wrap">
            {!fundingRates ? (
              <div className="trades-empty">Loading live funding rates across exchanges...</div>
            ) : (
              (() => {
                const sortedFunding = [...fundingRates.exchanges].sort((a, b) => {
                  if (a.supported !== b.supported) return a.supported ? -1 : 1;
                  return b.normalized8hPct - a.normalized8hPct;
                });
                const maxAbs8h = Math.max(
                  0.01,
                  ...fundingRates.exchanges
                    .filter((x) => x.supported)
                    .map((x) => Math.abs(x.normalized8hPct))
                );
                const wRate = fundingRates.oiWeighted8hPct;
                const wApr = fundingRates.oiWeightedAprPct;

                return (
                  <div className="vol-share-body">
                    <div className="vol-summary-box">
                      <div className="vol-summary-top">
                        <span className="text-muted">OI-WEIGHTED (8H)</span>
                        <strong className={wRate >= 0 ? 'text-bid' : 'text-ask'}>
                          {wRate >= 0 ? '+' : ''}
                          {wRate.toFixed(4)}% ({wApr >= 0 ? '+' : ''}
                          {wApr.toFixed(1)}% APR)
                        </strong>
                      </div>
                      <div className="vol-macro-labels">
                        <span className={wRate >= 0 ? 'text-bid' : 'text-ask'}>
                          {wRate > 0.0005
                            ? 'Longs Pay Shorts'
                            : wRate < -0.0005
                              ? 'Shorts Pay Longs'
                              : 'Neutral Funding'}
                        </span>
                        <span className="text-muted">
                          Arb Spread: {fundingRates.maxSpread8hPct.toFixed(4)}%/8h
                        </span>
                      </div>
                      <div className="vol-macro-labels">
                        <span className="text-muted">
                          Total Perp OI: {formatCompactUsd(fundingRates.totalOpenInterestUsd)}
                        </span>
                        <span className="text-muted">HL 1h normalized ×8</span>
                      </div>
                    </div>

                    <div className="vol-exchange-list">
                      {sortedFunding.map((item) => {
                        const color = EXCHANGE_BAR_COLORS[item.exchange] || '#38bdf8';
                        const isSelected = exchange === item.exchange;
                        const isPos = item.fundingRatePct >= 0;
                        const barPct = item.supported
                          ? Math.min(50, (Math.abs(item.normalized8hPct) / maxAbs8h) * 50)
                          : 0;

                        return (
                          <button
                            key={item.exchange}
                            type="button"
                            className={`vol-ex-row ${isSelected ? 'vol-ex-row-active' : ''}`}
                            onClick={() => onSwitchExchange(item.exchange)}
                            title={
                              item.supported
                                ? `${item.label} • Current (${item.intervalHours}h): ${item.fundingRatePct >= 0 ? '+' : ''}${item.fundingRatePct.toFixed(4)}% • 8h Norm: ${item.normalized8hPct >= 0 ? '+' : ''}${item.normalized8hPct.toFixed(4)}% • APR: ${item.annualizedAprPct >= 0 ? '+' : ''}${item.annualizedAprPct.toFixed(2)}%`
                                : `${item.label} is Spot-only (no public perp funding)`
                            }
                          >
                            <div className="vol-ex-head">
                              <span className="vol-ex-name">
                                <span
                                  className="vol-ex-dot"
                                  style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
                                />
                                <em className={`v-badge ${getExchangeBadgeClass(item.code)}`}>
                                  {item.code}
                                </em>
                                <strong>{item.label}</strong>
                                <span className="fund-interval-pill">
                                  {item.supported ? `${item.intervalHours}h` : 'Spot'}
                                </span>
                              </span>
                              {item.supported ? (
                                <strong
                                  className={`vol-ex-pct ${isPos ? 'text-bid' : 'text-ask'}`}
                                >
                                  {isPos ? '+' : ''}
                                  {item.fundingRatePct.toFixed(4)}%
                                </strong>
                              ) : (
                                <span className="text-muted">—</span>
                              )}
                            </div>

                            {item.supported ? (
                              <>
                                <div className="fund-diverge-track">
                                  <div className="fund-zero-line" />
                                  {item.normalized8hPct >= 0 ? (
                                    <div
                                      className="fund-bar-pos"
                                      style={{ left: '50%', width: `${barPct}%` }}
                                    />
                                  ) : (
                                    <div
                                      className="fund-bar-neg"
                                      style={{ left: `${50 - barPct}%`, width: `${barPct}%` }}
                                    />
                                  )}
                                </div>

                                <div className="vol-ex-meta">
                                  <span className={item.annualizedAprPct >= 0 ? 'text-bid' : 'text-ask'}>
                                    APR {item.annualizedAprPct >= 0 ? '+' : ''}
                                    {item.annualizedAprPct.toFixed(1)}%
                                    {item.intervalHours !== 8
                                      ? ` • 8h: ${item.normalized8hPct >= 0 ? '+' : ''}${item.normalized8hPct.toFixed(4)}%`
                                      : ''}
                                  </span>
                                  <span className="vol-ex-split">
                                    OI {formatCompactUsd(item.openInterestUsd)} •{' '}
                                    {formatCountdown(item.nextFundingTime)}
                                  </span>
                                </div>
                              </>
                            ) : (
                              <div className="vol-ex-meta">
                                <span>Spot only (no perpetual funding)</span>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()
            )}
          </div>
        ) : (
          <div className="trades-tab-wrap">
            <div className="trades-subtabs trades-subtabs-3" role="tablist">
              <button
                role="tab"
                aria-selected={tradesSubTab === 'all'}
                className={tradesSubTab === 'all' ? 'active' : ''}
                onClick={() => setTradesSubTab('all')}
              >
                All ({recentTrades.length})
              </button>
              <button
                role="tab"
                aria-selected={tradesSubTab === 'whales'}
                className={`whale-subtab-btn ${tradesSubTab === 'whales' ? 'active' : ''}`}
                onClick={() => setTradesSubTab('whales')}
              >
                🐋 Whales ({filteredWhales.length})
              </button>
              <button
                role="tab"
                aria-selected={tradesSubTab === 'liqs'}
                className={`liq-subtab-btn ${tradesSubTab === 'liqs' ? 'active' : ''}`}
                onClick={() => setTradesSubTab('liqs')}
              >
                ⚡ Liqs ({recentLiquidations.length})
              </button>
            </div>

            {tradesSubTab === 'whales' && (
              <div className="whale-controls-col">
                <div className="cluster-controls-row">
                  <div className="sort-toggle">
                    {WHALE_THRESHOLD_OPTIONS.map((min) => (
                      <button
                        key={min}
                        className={whaleMinBtc === min ? 'active' : ''}
                        onClick={() => setWhaleMinBtc(min)}
                        title={`Show trades >= ${min} BTC`}
                      >
                        ≥{min}
                      </button>
                    ))}
                  </div>
                  <div className="sort-toggle">
                    {(['all', 'Buy', 'Sell'] as const).map((side) => (
                      <button
                        key={side}
                        className={whaleSideFilter === side ? 'active' : ''}
                        onClick={() => setWhaleSideFilter(side)}
                      >
                        {side === 'all' ? 'All' : side}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="whale-summary-bar">
                  <span className="text-bid">+{whaleFlowStats.buyBtc.toFixed(1)}B</span>
                  <span className="text-ask">-{whaleFlowStats.sellBtc.toFixed(1)}S</span>
                  <span
                    className={
                      whaleFlowStats.netBtc >= 0 ? 'text-bid' : 'text-ask'
                    }
                  >
                    Net: {whaleFlowStats.netBtc >= 0 ? '+' : ''}
                    {whaleFlowStats.netBtc.toFixed(1)} BTC
                  </span>
                </div>
              </div>
            )}

            {tradesSubTab === 'liqs' && (
              <div className="whale-controls-col">
                <div className="whale-summary-bar">
                  <span className="text-ask">
                    Longs Liqd: ${(liqStats.longUsd / 1000).toFixed(1)}k
                  </span>
                  <span className="text-bid">
                    Shorts Liqd: ${(liqStats.shortUsd / 1000).toFixed(1)}k
                  </span>
                </div>
              </div>
            )}

            <div className="trades-table-head">
              <span>PRICE</span>
              <span>{tradesSubTab === 'liqs' ? 'LIQ SIZE' : 'SIZE (BTC)'}</span>
              <span>{tradesSubTab === 'liqs' ? 'LIQ' : 'SIDE'}</span>
              <span>TIME</span>
            </div>
            <div className="trades-list">
              {tradesSubTab === 'liqs' ? (
                recentLiquidations.length === 0 ? (
                  <div className="trades-empty">
                    No forced BTC liquidations captured yet — listening on {exchangeTitle}...
                  </div>
                ) : (
                  recentLiquidations.slice(0, 100).map((lq) => {
                    const isShortLiq = lq.side === 'Short';
                    const isBigLiq = lq.usd >= 50_000;
                    return (
                      <button
                        key={lq.id}
                        type="button"
                        className={`trade-row trade-row-clickable ${
                          isBigLiq ? 'trade-mega-whale' : 'trade-whale'
                        }`}
                        onClick={() => onSelectWallPrice(lq.p)}
                        title={`${lq.exchange} ${lq.side} liquidation: ${lq.v.toFixed(3)} BTC ($${lq.usd.toLocaleString()}) — Click to highlight $${lq.p.toFixed(1)}`}
                      >
                        <span className={isShortLiq ? 'text-bid' : 'text-ask'}>
                          ⚡ {lq.p.toFixed(1)}
                        </span>
                        <span className="trade-size">
                          ${lq.usd >= 1000 ? `${(lq.usd / 1000).toFixed(1)}k` : lq.usd}{' '}
                          <span className="text-muted">({lq.v.toFixed(2)})</span>
                        </span>
                        <span className="trade-venue-cell">
                          <span className={isShortLiq ? 'text-bid' : 'text-ask'}>
                            {lq.side === 'Long' ? 'LNG' : 'SHT'}
                          </span>
                          <em className={`v-badge ${getExchangeBadgeClass(lq.exchange)}`}>
                            {lq.exchange}
                          </em>
                        </span>
                        <span className="trade-time">
                          {new Date(lq.t).toLocaleTimeString([], {
                            hour12: false,
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                      </button>
                    );
                  })
                )
              ) : tradesSubTab === 'whales' && filteredWhales.length === 0 ? (
                <div className="trades-empty">
                  No whale trades ≥ {whaleMinBtc} BTC yet — listening on {exchangeTitle}...
                </div>
              ) : (
                (tradesSubTab === 'whales'
                  ? filteredWhales.slice(0, 120)
                  : recentTrades.slice(0, 80)
                ).map((tr) => {
                  const isBuy = tr.s === 'Buy';
                  const isWhale = tr.v >= 0.5;
                  const isMegaWhale = tr.v >= 5;
                  const venueTag = tr.exchange;
                  const isSpot = tr.market === 'SPOT';
                  const rowContent = (
                    <>
                      <span className={isBuy ? 'text-bid' : 'text-ask'}>
                        {isBuy ? '▲' : '▼'} {tr.p.toFixed(1)}
                      </span>
                      <span className="trade-size">
                        {tr.v.toFixed(3)} BTC {isMegaWhale ? '🐋🐋' : isWhale ? '🐋' : ''}
                      </span>
                      <span className="trade-venue-cell">
                        {venueTag ? (
                          <em className={`v-badge ${getExchangeBadgeClass(venueTag)}`}>
                            {venueTag}
                          </em>
                        ) : (
                          <span className={isBuy ? 'text-bid' : 'text-ask'}>
                            {tr.s.toUpperCase()}
                          </span>
                        )}
                        {isSpot && <em className="v-badge v-spot">S</em>}
                      </span>
                      <span className="trade-time">
                        {new Date(tr.t).toLocaleTimeString([], {
                          hour12: false,
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                    </>
                  );

                  if (tradesSubTab === 'whales') {
                    return (
                      <button
                        key={tr.id}
                        type="button"
                        className={`trade-row trade-row-clickable ${
                          isBuy ? 'trade-buy' : 'trade-sell'
                        } ${isMegaWhale ? 'trade-mega-whale' : 'trade-whale'}`}
                        onClick={() => onSelectWallPrice(tr.p)}
                        title={`~$${Math.round(tr.p * tr.v).toLocaleString()} notional (${venueTag || exchangeTitle} ${tr.market || 'PERP'}) — Click to highlight $${tr.p.toFixed(1)} on chart`}
                      >
                        {rowContent}
                      </button>
                    );
                  }

                  return (
                    <div
                      key={tr.id}
                      className={`trade-row ${isBuy ? 'trade-buy' : 'trade-sell'} ${
                        isMegaWhale ? 'trade-mega-whale' : isWhale ? 'trade-whale' : ''
                      }`}
                    >
                      {rowContent}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </section>
    </aside>
  );
});
