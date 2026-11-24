export type AlertKind = 'whale' | 'liquidation' | 'price';

export interface AlertToastItem {
  id: string;
  kind: AlertKind;
  title: string;
  detail: string;
  price: number;
  tone: 'bid' | 'ask' | 'info';
  ts: number;
}

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

export function playAlertChime(kind: AlertKind, tone: 'bid' | 'ask' | 'info') {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (kind === 'liquidation') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(tone === 'bid' ? 660 : 420, now);
      osc.frequency.exponentialRampToValueAtTime(tone === 'bid' ? 920 : 280, now + 0.14);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.23);
    } else if (kind === 'price') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1175, now + 0.09);
      gain.gain.setValueAtTime(0.055, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.start(now);
      osc.stop(now + 0.3);
    } else {
      // Subtle whale ping
      osc.type = 'sine';
      osc.frequency.setValueAtTime(tone === 'bid' ? 587 : 494, now);
      osc.frequency.exponentialRampToValueAtTime(tone === 'bid' ? 784 : 392, now + 0.12);
      gain.gain.setValueAtTime(0.045, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now);
      osc.stop(now + 0.19);
    }
  } catch {
    // Ignore autoplay/audio restriction errors
  }
}
