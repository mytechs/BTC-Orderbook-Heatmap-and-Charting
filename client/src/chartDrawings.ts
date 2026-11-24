export type DrawingToolId =
  | 'cursor'
  | 'trendline'
  | 'ray'
  | 'hline'
  | 'hray'
  | 'vline'
  | 'rect'
  | 'channel'
  | 'fib'
  | 'long'
  | 'short'
  | 'measure'
  | 'brush'
  | 'text';

export interface ChartPoint {
  time: number; // timestamp in ms
  price: number;
}

export interface ChartDrawing {
  id: string;
  type: Exclude<DrawingToolId, 'cursor' | 'measure'>;
  points: ChartPoint[];
  color: string;
  lineWidth: number;
  dashed?: boolean;
  text?: string;
}

export interface CoordMapper {
  timeToX: (time: number) => number;
  priceToY: (price: number) => number;
  chartW: number;
  chartH: number;
}

const FIB_LEVELS: { ratio: number; color: string }[] = [
  { ratio: 0, color: '#94a3b8' },
  { ratio: 0.236, color: '#f43f5e' },
  { ratio: 0.382, color: '#fb923c' },
  { ratio: 0.5, color: '#34d399' },
  { ratio: 0.618, color: '#38bdf8' },
  { ratio: 0.786, color: '#a855f7' },
  { ratio: 1, color: '#94a3b8' },
  { ratio: 1.272, color: '#facc15' },
  { ratio: 1.618, color: '#facc15' },
];

export const DRAWING_COLORS = [
  '#38bdf8', // cyan
  '#facc15', // yellow
  '#34d399', // emerald
  '#f43f5e', // rose
  '#a855f7', // violet
  '#fb923c', // orange
  '#f8fafc', // white
  '#3b82f6', // blue
];

function storageKey(exchange: string): string {
  return `tv-chart-drawings-v1-${exchange}`;
}

export function loadDrawings(exchange: string): ChartDrawing[] {
  try {
    const raw = window.localStorage.getItem(storageKey(exchange));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChartDrawing[]) : [];
  } catch {
    return [];
  }
}

export function saveDrawings(exchange: string, drawings: ChartDrawing[]) {
  try {
    window.localStorage.setItem(storageKey(exchange), JSON.stringify(drawings.slice(-500)));
  } catch {
    // ignore quota errors
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `rgba(56, 189, 248, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function drawAnchorHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  active = false
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, active ? 5.5 : 4.5, 0, Math.PI * 2);
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

export function hitTestDrawing(
  drawing: ChartDrawing,
  mx: number,
  my: number,
  mapper: CoordMapper
): { hit: boolean; anchorIndex: number } {
  const pts = drawing.points.map((p) => ({
    x: mapper.timeToX(p.time),
    y: mapper.priceToY(p.price),
  }));

  // First test explicit control anchor handles (except brush which has many points)
  if (drawing.type !== 'brush') {
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(mx - pts[i].x, my - pts[i].y) <= 9) {
        return { hit: true, anchorIndex: i };
      }
    }
  }

  const tol = 7;
  if (drawing.type === 'hline' && pts[0]) {
    return { hit: Math.abs(my - pts[0].y) <= tol, anchorIndex: -1 };
  }
  if (drawing.type === 'hray' && pts[0]) {
    return { hit: mx >= pts[0].x - tol && Math.abs(my - pts[0].y) <= tol, anchorIndex: -1 };
  }
  if (drawing.type === 'vline' && pts[0]) {
    return { hit: Math.abs(mx - pts[0].x) <= tol, anchorIndex: -1 };
  }
  if (drawing.type === 'trendline' && pts.length >= 2) {
    return {
      hit: distToSegment(mx, my, pts[0].x, pts[0].y, pts[1].x, pts[1].y) <= tol,
      anchorIndex: -1,
    };
  }
  if (drawing.type === 'ray' && pts.length >= 2) {
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    const len = Math.hypot(dx, dy) || 1;
    const extX = pts[0].x + (dx / len) * 5000;
    const extY = pts[0].y + (dy / len) * 5000;
    return {
      hit: distToSegment(mx, my, pts[0].x, pts[0].y, extX, extY) <= tol,
      anchorIndex: -1,
    };
  }
  if (drawing.type === 'rect' && pts.length >= 2) {
    const minX = Math.min(pts[0].x, pts[1].x);
    const maxX = Math.max(pts[0].x, pts[1].x);
    const minY = Math.min(pts[0].y, pts[1].y);
    const maxY = Math.max(pts[0].y, pts[1].y);
    const inside = mx >= minX - tol && mx <= maxX + tol && my >= minY - tol && my <= maxY + tol;
    return { hit: inside, anchorIndex: -1 };
  }
  if (drawing.type === 'channel' && pts.length >= 3) {
    const [p1, p2, p3] = pts;
    const d1 = distToSegment(mx, my, p1.x, p1.y, p2.x, p2.y);
    const offX = p3.x - p2.x;
    const offY = p3.y - p2.y;
    const d2 = distToSegment(mx, my, p1.x + offX, p1.y + offY, p2.x + offX, p2.y + offY);
    return { hit: Math.min(d1, d2) <= tol, anchorIndex: -1 };
  }
  if (drawing.type === 'fib' && pts.length >= 2) {
    const minX = Math.min(pts[0].x, pts[1].x);
    const maxX = Math.max(pts[0].x, pts[1].x);
    const minY = Math.min(pts[0].y, pts[1].y);
    const maxY = Math.max(pts[0].y, pts[1].y);
    return {
      hit: mx >= minX - tol && mx <= maxX + tol && my >= minY - tol && my <= maxY + tol,
      anchorIndex: -1,
    };
  }
  if ((drawing.type === 'long' || drawing.type === 'short') && pts.length >= 3) {
    const [entry, tp, sl] = pts;
    const minX = Math.min(entry.x, tp.x, sl.x);
    const maxX = Math.max(entry.x, tp.x, sl.x, entry.x + 80);
    const minY = Math.min(entry.y, tp.y, sl.y);
    const maxY = Math.max(entry.y, tp.y, sl.y);
    return {
      hit: mx >= minX - tol && mx <= maxX + tol && my >= minY - tol && my <= maxY + tol,
      anchorIndex: -1,
    };
  }
  if (drawing.type === 'brush' && pts.length >= 2) {
    for (let i = 1; i < pts.length; i++) {
      if (distToSegment(mx, my, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tol + 2) {
        return { hit: true, anchorIndex: -1 };
      }
    }
    return { hit: false, anchorIndex: -1 };
  }
  if (drawing.type === 'text' && pts[0]) {
    const w = Math.max(60, (drawing.text?.length || 6) * 7.5 + 16);
    return {
      hit: mx >= pts[0].x - 6 && mx <= pts[0].x + w && my >= pts[0].y - 16 && my <= pts[0].y + 10,
      anchorIndex: -1,
    };
  }
  return { hit: false, anchorIndex: -1 };
}

export function renderDrawing(
  ctx: CanvasRenderingContext2D,
  drawing: ChartDrawing,
  mapper: CoordMapper,
  isSelected: boolean,
  isPreview = false
) {
  const pts = drawing.points.map((p) => ({
    x: mapper.timeToX(p.time),
    y: mapper.priceToY(p.price),
    price: p.price,
    time: p.time,
  }));
  if (pts.length === 0) return;

  ctx.save();
  ctx.strokeStyle = drawing.color;
  ctx.fillStyle = drawing.color;
  ctx.lineWidth = drawing.lineWidth;
  if (drawing.dashed) ctx.setLineDash([6, 4]);

  switch (drawing.type) {
    case 'hline': {
      const y = Math.round(pts[0].y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(mapper.chartW, y);
      ctx.stroke();

      // Label tag near right edge
      ctx.setLineDash([]);
      const label = `$${pts[0].price.toFixed(1)}`;
      ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = drawing.color;
      ctx.fillRect(mapper.chartW - tw - 4, y - 9, tw, 18);
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mapper.chartW - tw / 2 - 4, y);
      break;
    }

    case 'hray': {
      const y = Math.round(pts[0].y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, y);
      ctx.lineTo(mapper.chartW, y);
      ctx.stroke();

      ctx.setLineDash([]);
      const label = `$${pts[0].price.toFixed(1)}`;
      ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = drawing.color;
      ctx.fillRect(mapper.chartW - tw - 4, y - 9, tw, 18);
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mapper.chartW - tw / 2 - 4, y);
      break;
    }

    case 'vline': {
      const x = Math.round(pts[0].x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, mapper.chartH);
      ctx.stroke();
      break;
    }

    case 'trendline': {
      if (pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();

      if (isSelected || isPreview) {
        const dp = pts[1].price - pts[0].price;
        const pct = pts[0].price > 0 ? (dp / pts[0].price) * 100 : 0;
        const mx = (pts[0].x + pts[1].x) / 2;
        const my = (pts[0].y + pts[1].y) / 2 - 12;
        ctx.setLineDash([]);
        ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        const txt = `${dp >= 0 ? '+' : ''}$${dp.toFixed(1)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
        const w = ctx.measureText(txt).width + 10;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(mx - w / 2, my - 9, w, 17);
        ctx.strokeStyle = drawing.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(mx - w / 2, my - 9, w, 17);
        ctx.fillStyle = drawing.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, mx, my);
      }
      break;
    }

    case 'ray': {
      if (pts.length < 2) break;
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const len = Math.hypot(dx, dy) || 1;
      const extX = pts[0].x + (dx / len) * 5000;
      const extY = pts[0].y + (dy / len) * 5000;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(extX, extY);
      ctx.stroke();
      break;
    }

    case 'rect': {
      if (pts.length < 2) break;
      const rx = Math.min(pts[0].x, pts[1].x);
      const ry = Math.min(pts[0].y, pts[1].y);
      const rw = Math.abs(pts[1].x - pts[0].x);
      const rh = Math.abs(pts[1].y - pts[0].y);
      ctx.fillStyle = hexToRgba(drawing.color, 0.14);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
      break;
    }

    case 'channel': {
      if (pts.length < 2) break;
      const [p1, p2] = pts;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      if (pts.length >= 3) {
        const p3 = pts[2];
        const offX = p3.x - p2.x;
        const offY = p3.y - p2.y;
        const q1x = p1.x + offX;
        const q1y = p1.y + offY;
        const q2x = p2.x + offX;
        const q2y = p2.y + offY;

        ctx.fillStyle = hexToRgba(drawing.color, 0.12);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(q2x, q2y);
        ctx.lineTo(q1x, q1y);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(q1x, q1y);
        ctx.lineTo(q2x, q2y);
        ctx.stroke();

        // Midline dashed
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = hexToRgba(drawing.color, 0.7);
        ctx.beginPath();
        ctx.moveTo((p1.x + q1x) / 2, (p1.y + q1y) / 2);
        ctx.lineTo((p2.x + q2x) / 2, (p2.y + q2y) / 2);
        ctx.stroke();
        ctx.restore();
      }
      break;
    }

    case 'fib': {
      if (pts.length < 2) break;
      const [p1, p2] = pts;
      const xStart = Math.min(p1.x, p2.x);
      const xEnd = Math.max(p1.x, p2.x, xStart + 120);
      const priceDiff = p1.price - p2.price;

      // Diagonal guide
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.restore();

      ctx.setLineDash([]);
      ctx.font = 'bold 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';

      for (let i = 0; i < FIB_LEVELS.length; i++) {
        const lv = FIB_LEVELS[i];
        const price = p2.price + priceDiff * lv.ratio;
        const y = Math.round(mapper.priceToY(price)) + 0.5;

        if (i > 0 && lv.ratio <= 1) {
          const prevPrice = p2.price + priceDiff * FIB_LEVELS[i - 1].ratio;
          const prevY = mapper.priceToY(prevPrice);
          ctx.fillStyle = hexToRgba(lv.color, 0.06);
          ctx.fillRect(xStart, Math.min(y, prevY), xEnd - xStart, Math.abs(y - prevY));
        }

        ctx.strokeStyle = lv.color;
        ctx.lineWidth = lv.ratio === 0.618 || lv.ratio === 0.5 ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(xStart, y);
        ctx.lineTo(xEnd, y);
        ctx.stroke();

        ctx.fillStyle = lv.color;
        ctx.fillText(`${lv.ratio} ($${price.toFixed(1)})`, xStart + 4, y - 2);
      }
      break;
    }

    case 'long':
    case 'short': {
      if (pts.length < 3) break;
      const [entry, tp, sl] = pts;
      const isLong = drawing.type === 'long';
      const xLeft = Math.min(entry.x, tp.x);
      const xRight = Math.max(entry.x + 110, tp.x, sl.x);
      const boxW = Math.max(80, xRight - xLeft);

      const tpTop = Math.min(entry.y, tp.y);
      const tpH = Math.abs(tp.y - entry.y);
      const slTop = Math.min(entry.y, sl.y);
      const slH = Math.abs(sl.y - entry.y);

      // Profit zone (green)
      ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
      ctx.fillRect(xLeft, tpTop, boxW, tpH);
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(xLeft, tpTop, boxW, tpH);

      // Stop loss zone (red)
      ctx.fillStyle = 'rgba(244, 63, 94, 0.22)';
      ctx.fillRect(xLeft, slTop, boxW, slH);
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(xLeft, slTop, boxW, slH);

      // Entry line
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(xLeft, entry.y);
      ctx.lineTo(xLeft + boxW, entry.y);
      ctx.stroke();

      const reward = Math.abs(tp.price - entry.price);
      const risk = Math.max(0.01, Math.abs(entry.price - sl.price));
      const rr = reward / risk;
      const rewardPct = entry.price > 0 ? (reward / entry.price) * 100 : 0;
      const riskPct = entry.price > 0 ? (risk / entry.price) * 100 : 0;

      ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      // TP Label
      ctx.fillStyle = '#34d399';
      ctx.fillText(
        `TP $${tp.price.toFixed(1)} (+${rewardPct.toFixed(2)}%)`,
        xLeft + 6,
        tpTop + Math.min(12, tpH / 2)
      );

      // SL Label
      ctx.fillStyle = '#fb7185';
      ctx.fillText(
        `SL $${sl.price.toFixed(1)} (-${riskPct.toFixed(2)}%)`,
        xLeft + 6,
        slTop + Math.max(slH - 12, slH / 2)
      );

      // R:R Center Pill
      const rrLabel = `${isLong ? 'LONG' : 'SHORT'}  R:R ${rr.toFixed(2)}  •  Entry $${entry.price.toFixed(1)}`;
      const pillW = ctx.measureText(rrLabel).width + 12;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.fillRect(xLeft + 4, entry.y - 9, pillW, 18);
      ctx.strokeStyle = rr >= 2 ? '#34d399' : '#38bdf8';
      ctx.lineWidth = 1;
      ctx.strokeRect(xLeft + 4, entry.y - 9, pillW, 18);
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(rrLabel, xLeft + 10, entry.y);
      break;
    }

    case 'brush': {
      if (pts.length < 2) break;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
      break;
    }

    case 'text': {
      const label = drawing.text || 'Note';
      ctx.setLineDash([]);
      ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
      ctx.fillRect(pts[0].x - 2, pts[0].y - 12, tw, 22);
      ctx.strokeStyle = isSelected ? '#facc15' : hexToRgba(drawing.color, 0.7);
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.strokeRect(pts[0].x - 2, pts[0].y - 12, tw, 22);
      ctx.fillStyle = drawing.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, pts[0].x + 4, pts[0].y - 1);
      break;
    }
  }

  // Render control handles if selected or actively previewing
  if ((isSelected || isPreview) && drawing.type !== 'brush') {
    for (let i = 0; i < pts.length; i++) {
      drawAnchorHandle(ctx, pts[i].x, pts[i].y, isSelected ? '#facc15' : drawing.color, isSelected);
    }
  }

  ctx.restore();
}

export function renderMeasureBox(
  ctx: CanvasRenderingContext2D,
  p1: ChartPoint,
  p2: ChartPoint,
  barDelta: number,
  mapper: CoordMapper
) {
  const x1 = mapper.timeToX(p1.time);
  const y1 = mapper.priceToY(p1.price);
  const x2 = mapper.timeToX(p2.time);
  const y2 = mapper.priceToY(p2.price);

  const dp = p2.price - p1.price;
  const pct = p1.price > 0 ? (dp / p1.price) * 100 : 0;
  const isUp = dp >= 0;
  const accent = isUp ? '#34d399' : '#fb7185';
  const fill = isUp ? 'rgba(16, 185, 129, 0.16)' : 'rgba(244, 63, 94, 0.16)';

  const rx = Math.min(x1, x2);
  const ry = Math.min(y1, y2);
  const rw = Math.abs(x2 - x1);
  const rh = Math.abs(y2 - y1);

  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.setLineDash([]);

  const dtMs = Math.abs(p2.time - p1.time);
  const dtMin = Math.round(dtMs / 60_000);
  const timeTxt =
    dtMin >= 1440
      ? `${(dtMin / 1440).toFixed(1)}d`
      : dtMin >= 60
        ? `${Math.floor(dtMin / 60)}h ${dtMin % 60}m`
        : `${dtMin}m`;

  const line1 = `${dp >= 0 ? '+' : ''}$${dp.toFixed(1)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  const line2 = `${Math.abs(barDelta)} bars • ${timeTxt}`;
  ctx.font = 'bold 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  const boxW = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 16;
  const boxH = 34;
  const bx = Math.max(8, Math.min(mapper.chartW - boxW - 8, (x1 + x2) / 2 - boxW / 2));
  const by = isUp ? Math.max(8, ry - boxH - 6) : Math.min(mapper.chartH - boxH - 8, ry + rh + 6);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.94)';
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(bx, by, boxW, boxH);

  ctx.fillStyle = accent;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(line1, bx + boxW / 2, by + 11);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(line2, bx + boxW / 2, by + 24);
  ctx.restore();
}
