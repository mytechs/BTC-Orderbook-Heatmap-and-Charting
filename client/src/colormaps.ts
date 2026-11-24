import type { ColormapName } from '../../shared/types.ts';

type RGB = [number, number, number];

// Bookmap-inspired Thermal gradient stops (0.0 -> 1.0)
const THERMAL_STOPS: [number, RGB][] = [
  [0.0, [8, 12, 26]],
  [0.12, [15, 38, 92]],
  [0.28, [16, 105, 175]],
  [0.45, [18, 184, 166]],
  [0.62, [120, 214, 62]],
  [0.78, [245, 196, 24]],
  [0.91, [249, 93, 22]],
  [1.0, [255, 240, 245]],
];

// Viridis / Plasma hybrid gradient stops
const VIRIDIS_STOPS: [number, RGB][] = [
  [0.0, [14, 11, 34]],
  [0.18, [59, 15, 112]],
  [0.36, [44, 114, 142]],
  [0.56, [33, 165, 133]],
  [0.76, [115, 208, 85]],
  [0.92, [253, 231, 37]],
  [1.0, [255, 252, 190]],
];

const BID_STOPS: [number, RGB][] = [
  [0.0, [7, 22, 20]],
  [0.25, [10, 75, 62]],
  [0.55, [16, 158, 116]],
  [0.82, [52, 211, 153]],
  [1.0, [195, 255, 230]],
];

const ASK_STOPS: [number, RGB][] = [
  [0.0, [26, 10, 16]],
  [0.25, [95, 20, 38]],
  [0.55, [185, 38, 64]],
  [0.82, [244, 63, 94]],
  [1.0, [255, 210, 218]],
];

function interpolateStops(stops: [number, RGB][], t: number): RGB {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (clamped >= t0 && clamped <= t1) {
      const local = t1 === t0 ? 0 : (clamped - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * local),
        Math.round(c0[1] + (c1[1] - c0[1]) * local),
        Math.round(c0[2] + (c1[2] - c0[2]) * local),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

// Precompute 256-level LUTs for fast 60fps canvas rendering
const LUT_THERMAL: string[] = [];
const LUT_VIRIDIS: string[] = [];
const LUT_BID: string[] = [];
const LUT_ASK: string[] = [];

for (let i = 0; i < 256; i++) {
  const t = i / 255;
  // Slightly non-linear gamma curve (t^0.78) brings out mid-sized resting orders clearly
  const gammaT = Math.pow(t, 0.78);
  const alpha = (0.18 + 0.8 * gammaT).toFixed(3);

  const th = interpolateStops(THERMAL_STOPS, gammaT);
  LUT_THERMAL.push(`rgba(${th[0]},${th[1]},${th[2]},${alpha})`);

  const vi = interpolateStops(VIRIDIS_STOPS, gammaT);
  LUT_VIRIDIS.push(`rgba(${vi[0]},${vi[1]},${vi[2]},${alpha})`);

  const bi = interpolateStops(BID_STOPS, gammaT);
  LUT_BID.push(`rgba(${bi[0]},${bi[1]},${bi[2]},${alpha})`);

  const ak = interpolateStops(ASK_STOPS, gammaT);
  LUT_ASK.push(`rgba(${ak[0]},${ak[1]},${ak[2]},${alpha})`);
}

export function getLiquidityColor(
  sizeBtc: number,
  minFilterBtc: number,
  maxCeilingBtc: number,
  colormap: ColormapName,
  side: 'Bid' | 'Ask'
): string | null {
  if (sizeBtc <= minFilterBtc || sizeBtc <= 0.001) return null;

  const span = Math.max(0.05, maxCeilingBtc - minFilterBtc);
  const norm = Math.max(0, Math.min(1, (sizeBtc - minFilterBtc) / span));
  const idx = Math.min(255, Math.max(1, Math.floor(norm * 255)));

  if (colormap === 'thermal') return LUT_THERMAL[idx];
  if (colormap === 'viridis') return LUT_VIRIDIS[idx];
  return side === 'Bid' ? LUT_BID[idx] : LUT_ASK[idx];
}

export function getColormapCssGradient(colormap: ColormapName): string {
  if (colormap === 'thermal') {
    return 'linear-gradient(90deg, #080c1a 0%, #0f265c 18%, #1069af 36%, #12b8a6 52%, #78d63e 68%, #f5c418 82%, #f95d16 94%, #fff0f5 100%)';
  }
  if (colormap === 'viridis') {
    return 'linear-gradient(90deg, #0e0b22 0%, #3b0f70 22%, #2c728e 45%, #21a585 66%, #73d055 84%, #fde725 100%)';
  }
  return 'linear-gradient(90deg, #f43f5e 0%, #5f1426 45%, #0a4b3e 55%, #34d399 100%)';
}
