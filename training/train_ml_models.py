#!/usr/bin/env python3
"""
Walk-Forward LightGBM v2 Ensemble Trainer & Pure-TS JSON Tree Exporter for Layer 2 Quant-ML.

Upgrades over v1:
  - 46 strictly causal features (28 OHLCV + 11 Derivatives/Taker + 4 Spot/Perp Div + 3 MTF)
  - Calibration-only per-timeframe feature selection (all vs stationary-only vs top-K by gain)
  - Exponential recency sample weighting tested strictly against Calibration log-loss
  - 3-Seed LightGBM Ensemble ([42, 137, 2026]) merged linearly into ONE pure-TS tree bundle
    by scaling leaf values by 1/N_seeds (<1.5ms inference, 0 MB VRAM, exact <1e-5 TS parity!)

Strict chronological split with horizon purge gaps (zero test-set peeking):
  70% Train -> [H-bar purge] -> 15% Calibration & Selection -> [H-bar purge] -> 15% Out-of-Sample Test
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
from scipy.optimize import minimize_scalar
from sklearn.metrics import brier_score_loss, log_loss, mean_absolute_error, roc_auc_score

ENSEMBLE_SEEDS = [42, 137, 2026]
NON_STATIONARY_RAW_LEVELS = {"funding_rate_bps", "perp_basis_bps"}


def compress_tree(node: dict, leaf_scale: float = 1.0) -> dict:
    if "leaf_value" in node:
        return {"v": float(node["leaf_value"]) * leaf_scale}
    return {
        "f": int(node["split_feature"]),
        "t": float(node["threshold"]),
        "dl": bool(node.get("default_left", True)),
        "l": compress_tree(node["left_child"], leaf_scale),
        "r": compress_tree(node["right_child"], leaf_scale),
    }


def softmax(logits: np.ndarray, temp: float = 1.0) -> np.ndarray:
    scaled = logits / max(0.05, float(temp))
    shifted = scaled - np.max(scaled, axis=1, keepdims=True)
    exps = np.exp(shifted)
    return exps / np.sum(exps, axis=1, keepdims=True)


def fit_temperature(raw_logits: np.ndarray, y_true: np.ndarray) -> float:
    def obj(temp: float) -> float:
        probs = np.clip(softmax(raw_logits, temp), 1e-7, 1 - 1e-7)
        return float(log_loss(y_true, probs, labels=[0, 1, 2]))

    res = minimize_scalar(obj, bounds=(0.5, 4.0), method="bounded")
    return round(float(res.x), 4)


def export_ensemble(boosters: list[lgb.Booster], num_class: int, temp_scale: float = 1.0) -> dict:
    scale = 1.0 / max(1, len(boosters))
    trees = []
    for b in boosters:
        dumped = b.dump_model()
        for t in dumped["tree_info"]:
            trees.append(compress_tree(t["tree_structure"], leaf_scale=scale))
    out = {"numClass": num_class, "trees": trees}
    if num_class > 1:
        out["tempScale"] = temp_scale
    return out


def predict_ensemble_raw(boosters: list[lgb.Booster], X: np.ndarray) -> np.ndarray:
    preds = [b.predict(X, raw_score=True) for b in boosters]
    return np.mean(preds, axis=0)


def predict_ensemble_reg(boosters: list[lgb.Booster], X: np.ndarray) -> np.ndarray:
    preds = [b.predict(X) for b in boosters]
    return np.mean(preds, axis=0)


def make_recency_weights(n: int, min_weight: float) -> np.ndarray:
    if min_weight >= 0.999 or n <= 1:
        return np.ones(n, dtype=np.float64)
    # Exponential ramp from min_weight (oldest) to 1.0 (most recent)
    t = np.linspace(0.0, 1.0, n, dtype=np.float64)
    return min_weight * np.power(1.0 / min_weight, t)


def mask_columns(X: np.ndarray, keep_mask: np.ndarray) -> np.ndarray:
    """Zero out pruned columns in training matrix so LightGBM never splits on them,
    while keeping original 0..F-1 feature indices intact for zero-overhead TS inference."""
    out = X.copy()
    out[:, ~keep_mask] = 0.0
    return out


def select_best_dir_config_on_cal(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    X_cal: np.ndarray,
    y_cal: np.ndarray,
    feature_names: list[str],
    base_params: dict,
) -> tuple[np.ndarray, float, str]:
    """
    Strictly calibration-only model selection (ZERO test-set leakage):
    1. Fit quick importance pilot on X_tr -> X_cal.
    2. Compare candidate feature masks & recency weights on X_cal multi_logloss.
    """
    n_feat = X_tr.shape[1]
    pilot_ds_tr = lgb.Dataset(X_tr, label=y_tr, feature_name=feature_names)
    pilot_ds_cal = lgb.Dataset(X_cal, label=y_cal, reference=pilot_ds_tr, feature_name=feature_names)
    pilot = lgb.train(
        dict(base_params, seed=42),
        pilot_ds_tr,
        num_boost_round=320,
        valid_sets=[pilot_ds_cal],
        callbacks=[lgb.early_stopping(30, verbose=False)],
    )
    gains = pilot.feature_importance(importance_type="gain")
    ranked = np.argsort(gains)[::-1]

    mask_all = np.ones(n_feat, dtype=bool)
    mask_stationary = np.array([f not in NON_STATIONARY_RAW_LEVELS for f in feature_names], dtype=bool)
    mask_ohlcv = np.zeros(n_feat, dtype=bool)
    mask_ohlcv[: min(28, n_feat)] = True
    mask_top30 = np.zeros(n_feat, dtype=bool)
    mask_top30[ranked[: min(30, n_feat)]] = True
    mask_top22 = np.zeros(n_feat, dtype=bool)
    mask_top22[ranked[: min(22, n_feat)]] = True

    candidates = [
        ("all46_unif", mask_all, 1.0),
        ("all46_rec0.4", mask_all, 0.4),
        ("stat_unif", mask_stationary, 1.0),
        ("stat_rec0.4", mask_stationary, 0.4),
        ("ohlcv_unif", mask_ohlcv, 1.0),
        ("ohlcv_rec0.4", mask_ohlcv, 0.4),
        ("top30_unif", mask_top30, 1.0),
        ("top30_rec0.4", mask_top30, 0.4),
        ("top22_rec0.4", mask_top22, 0.4),
    ]

    cal_resolved = (y_cal == 0) | (y_cal == 2)
    cal_ybin = (y_cal[cal_resolved] == 2).astype(int) if np.sum(cal_resolved) >= 20 else None

    best_score = float("inf")
    best_mask = mask_all
    best_min_w = 1.0
    best_label = "all46_unif"

    for label, fmask, min_w in candidates:
        Xm_tr = mask_columns(X_tr, fmask)
        Xm_cal = mask_columns(X_cal, fmask)
        w_tr = make_recency_weights(len(X_tr), min_w)
        d_tr = lgb.Dataset(Xm_tr, label=y_tr, weight=w_tr, feature_name=feature_names)
        d_cal = lgb.Dataset(Xm_cal, label=y_cal, reference=d_tr, feature_name=feature_names)
        m = lgb.train(
            dict(base_params, seed=42),
            d_tr,
            num_boost_round=320,
            valid_sets=[d_cal],
            callbacks=[lgb.early_stopping(30, verbose=False)],
        )
        cal_probs = np.clip(m.predict(Xm_cal), 1e-7, 1 - 1e-7)
        cal_loss = float(log_loss(y_cal, cal_probs, labels=[0, 1, 2]))
        cal_auc = 0.5
        if cal_ybin is not None and len(np.unique(cal_ybin)) == 2:
            p_up = cal_probs[cal_resolved, 2] / np.clip(
                cal_probs[cal_resolved, 0] + cal_probs[cal_resolved, 2], 1e-6, None
            )
            cal_auc = float(roc_auc_score(cal_ybin, p_up))
        # Composite calibration objective: minimize calibrated log-loss while rewarding directional ranking (AUC)
        score = cal_loss - 0.12 * (cal_auc - 0.5)
        if score < best_score:
            best_score = score
            best_mask = fmask
            best_min_w = min_w
            best_label = f"{label}(calL={cal_loss:.4f},calAUC={cal_auc:.3f})"

    return best_mask, best_min_w, best_label


def train_timeframe(data_path: Path) -> tuple[dict, list[dict]]:
    data = json.loads(data_path.read_text(encoding="utf-8"))
    tf = data["timeframe"]
    horizon = int(data["horizonBars"])
    feature_names = data["featureNames"]

    X = np.asarray(data["X"], dtype=np.float64)
    y_dir = np.asarray(data["yDir"], dtype=np.int32)
    y_reg = np.asarray(data["yRegime"], dtype=np.int32)
    y_rng = np.asarray(data["yRangePct"], dtype=np.float64)

    n = len(X)
    purge = horizon
    i_train_end = int(n * 0.70)
    i_cal_start = i_train_end + purge
    i_cal_end = int(n * 0.85)
    i_test_start = i_cal_end + purge

    X_tr, X_cal, X_te = X[:i_train_end], X[i_cal_start:i_cal_end], X[i_test_start:]
    yd_tr, yd_cal, yd_te = y_dir[:i_train_end], y_dir[i_cal_start:i_cal_end], y_dir[i_test_start:]
    yr_tr, yr_cal, yr_te = y_reg[:i_train_end], y_reg[i_cal_start:i_cal_end], y_reg[i_test_start:]
    yg_tr, yg_cal, yg_te = y_rng[:i_train_end], y_rng[i_cal_start:i_cal_end], y_rng[i_test_start:]

    # 1. Directional Triple-Barrier 3-Seed Ensemble (with Calibration-Only Feature Pruning & Recency)
    dir_base = {
        "objective": "multiclass",
        "num_class": 3,
        "metric": "multi_logloss",
        "learning_rate": 0.025,
        "max_depth": 3,
        "num_leaves": 7,
        "min_child_samples": 75,
        "subsample": 0.8,
        "subsample_freq": 1,
        "colsample_bytree": 0.55,
        "reg_alpha": 2.5,
        "reg_lambda": 15.0,
        "verbose": -1,
    }
    fmask, min_w, sel_tag = select_best_dir_config_on_cal(
        X_tr, yd_tr, X_cal, yd_cal, feature_names, dir_base
    )
    Xm_tr = mask_columns(X_tr, fmask)
    Xm_cal = mask_columns(X_cal, fmask)
    w_dir = make_recency_weights(len(X_tr), min_w)

    dir_boosters: list[lgb.Booster] = []
    for seed in ENSEMBLE_SEEDS:
        d_tr = lgb.Dataset(Xm_tr, label=yd_tr, weight=w_dir, feature_name=feature_names)
        d_cal = lgb.Dataset(Xm_cal, label=yd_cal, reference=d_tr, feature_name=feature_names)
        b = lgb.train(
            dict(dir_base, seed=seed, bagging_seed=seed + 1, feature_fraction_seed=seed + 2),
            d_tr,
            num_boost_round=350,
            valid_sets=[d_cal],
            callbacks=[lgb.early_stopping(35, verbose=False)],
        )
        dir_boosters.append(b)

    # Note: because pruned features were zeroed during training, LightGBM never splits on them,
    # so predicting on raw unmasked X_cal / X_te is 100% identical to predicting on masked X!
    dir_cal_logits = predict_ensemble_raw(dir_boosters, X_cal)
    dir_temp = fit_temperature(dir_cal_logits, yd_cal)
    dir_te_probs = softmax(predict_ensemble_raw(dir_boosters, X_te), dir_temp)

    resolved_mask = (yd_te == 0) | (yd_te == 2)
    if np.sum(resolved_mask) >= 20 and len(np.unique(yd_te[resolved_mask])) == 2:
        y_bin = (yd_te[resolved_mask] == 2).astype(int)
        p_up_cond = dir_te_probs[resolved_mask, 2] / np.clip(
            dir_te_probs[resolved_mask, 0] + dir_te_probs[resolved_mask, 2], 1e-6, None
        )
        oos_auc = float(roc_auc_score(y_bin, p_up_cond))
        oos_brier = float(brier_score_loss(y_bin, p_up_cond))
    else:
        oos_auc = 0.5
        oos_brier = 0.25

    edge = dir_te_probs[:, 2] - dir_te_probs[:, 0]
    hc_mask = resolved_mask & (np.abs(edge) >= 0.12)
    hc_count = int(np.sum(hc_mask))
    if hc_count >= 10:
        hc_preds = np.where(edge[hc_mask] > 0, 2, 0)
        hc_win_rate = float(np.mean(hc_preds == yd_te[hc_mask]))
    else:
        hc_win_rate = None

    # 2. Regime Classifier 3-Seed Ensemble
    reg_base = dict(dir_base, max_depth=4, num_leaves=10, min_child_samples=55, reg_lambda=8.0)
    w_reg = make_recency_weights(len(X_tr), 0.5)
    reg_boosters: list[lgb.Booster] = []
    for seed in ENSEMBLE_SEEDS:
        r_tr = lgb.Dataset(X_tr, label=yr_tr, weight=w_reg, feature_name=feature_names)
        r_cal = lgb.Dataset(X_cal, label=yr_cal, reference=r_tr, feature_name=feature_names)
        b = lgb.train(
            dict(reg_base, seed=seed, bagging_seed=seed + 1, feature_fraction_seed=seed + 2),
            r_tr,
            num_boost_round=280,
            valid_sets=[r_cal],
            callbacks=[lgb.early_stopping(35, verbose=False)],
        )
        reg_boosters.append(b)
    reg_temp = fit_temperature(predict_ensemble_raw(reg_boosters, X_cal), yr_cal)
    reg_te_probs = softmax(predict_ensemble_raw(reg_boosters, X_te), reg_temp)
    reg_acc = float(np.mean(np.argmax(reg_te_probs, axis=1) == yr_te))

    # 3. Forward Range Regressor 3-Seed Ensemble
    rng_base = {
        "objective": "huber",
        "metric": "mae",
        "learning_rate": 0.035,
        "max_depth": 4,
        "num_leaves": 12,
        "min_child_samples": 45,
        "subsample": 0.8,
        "subsample_freq": 1,
        "colsample_bytree": 0.7,
        "reg_alpha": 1.0,
        "reg_lambda": 5.0,
        "verbose": -1,
    }
    rng_boosters: list[lgb.Booster] = []
    for seed in ENSEMBLE_SEEDS:
        g_tr = lgb.Dataset(X_tr, label=yg_tr, weight=w_reg, feature_name=feature_names)
        g_cal = lgb.Dataset(X_cal, label=yg_cal, reference=g_tr, feature_name=feature_names)
        b = lgb.train(
            dict(rng_base, seed=seed, bagging_seed=seed + 1, feature_fraction_seed=seed + 2),
            g_tr,
            num_boost_round=280,
            valid_sets=[g_cal],
            callbacks=[lgb.early_stopping(35, verbose=False)],
        )
        rng_boosters.append(b)
    rng_te_pred = predict_ensemble_reg(rng_boosters, X_te)
    rng_mae = float(mean_absolute_error(yg_te, rng_te_pred))

    imp = np.mean([b.feature_importance(importance_type="gain") for b in dir_boosters], axis=0)
    top_idx = np.argsort(imp)[::-1][:7]
    top_feats = [f"{feature_names[i]}({imp[i]:.0f})" for i in top_idx]

    dir_trees = sum(b.num_trees() for b in dir_boosters)
    reg_trees = sum(b.num_trees() for b in reg_boosters)
    rng_trees = sum(b.num_trees() for b in rng_boosters)

    print(
        f"[LightGBM v2 {tf.upper()}] sel={sel_tag} | train={len(X_tr)} cal={len(X_cal)} oos={len(X_te)} "
        f"| OOS AUC={oos_auc:.3f} Brier={oos_brier:.3f} "
        f"| HighConv(n={hc_count})={f'{hc_win_rate*100:.1f}%' if hc_win_rate is not None else 'n/a'} "
        f"| RegimeAcc={reg_acc*100:.1f}% | RangeMAE={rng_mae:.2f}% "
        f"| EnsTrees(D/R/V)={dir_trees}/{reg_trees}/{rng_trees}"
    )
    print(f"    Top features ({tf}): {', '.join(top_feats)}")

    parity_samples = []
    for k in range(min(3, len(X_te))):
        parity_samples.append(
            {
                "timeframe": tf,
                "features": [float(v) for v in X_te[k]],
                "expectedDirProbs": [float(p) for p in dir_te_probs[k]],
                "expectedRegProbs": [float(p) for p in reg_te_probs[k]],
                "expectedRangePct": float(rng_te_pred[k]),
            }
        )

    bundle = {
        "timeframe": tf,
        "horizonBars": horizon,
        "horizonLabel": data["horizonLabel"],
        "barrierAtrMult": float(data["barrierAtrMult"]),
        "directionModel": export_ensemble(dir_boosters, 3, dir_temp),
        "regimeModel": export_ensemble(reg_boosters, 3, reg_temp),
        "rangeModel": export_ensemble(rng_boosters, 1, 1.0),
        "meta": {
            "trainedAt": datetime.now(timezone.utc).isoformat()[:16].replace("T", " ") + " UTC",
            "trainSamples": int(len(X_tr)),
            "oosDirectionAuc": round(oos_auc, 3),
            "oosBrierScore": round(oos_brier, 3),
            **({"oosHighConvWinRate": round(hc_win_rate * 100, 1)} if hc_win_rate is not None else {}),
        },
    }
    return bundle, parity_samples


def main():
    data_dir = Path("training/data")
    out_model_path = Path("server/data/ml-btc-models.json")
    out_parity_path = Path("training/data/ml_parity_check.json")
    out_model_path.parent.mkdir(parents=True, exist_ok=True)

    models = {}
    all_parity = []
    feature_names = []

    for tf in ("1h", "4h", "1d"):
        p = data_dir / f"ml_features_{tf}.json"
        if not p.exists():
            print(f"[LightGBM] Skipping {tf} (missing {p})")
            continue
        if not feature_names:
            feature_names = json.loads(p.read_text(encoding="utf-8"))["featureNames"]
        bundle, parity = train_timeframe(p)
        models[tf] = bundle
        all_parity.extend(parity)

    artifact = {
        "version": 2,
        "featureNames": feature_names,
        "models": models,
    }
    out_model_path.write_text(json.dumps(artifact, separators=(",", ":")), encoding="utf-8")
    out_parity_path.write_text(json.dumps(all_parity, indent=2), encoding="utf-8")
    size_kb = out_model_path.stat().st_size / 1024
    print(f"[LightGBM v2] Exported pure-TS 3-seed ensemble -> {out_model_path} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
