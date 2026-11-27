import fs from 'node:fs';
import path from 'node:path';
import type { AiFeedbackStats, ExchangeId, TimeframeId } from '../shared/types.ts';

export interface AiFeedbackEntry {
  id: string;
  ts: number;
  kind: 'report' | 'chat';
  rating: 'up' | 'down';
  note?: string;
  model: string;
  exchange: ExchangeId;
  timeframe: TimeframeId;
  priceAtGeneration?: number;
  prompt: string;
  thinking?: string;
  response: string;
}

export class AiFeedbackStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'ai-training-log.jsonl');
  }

  private ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  append(entry: Omit<AiFeedbackEntry, 'id' | 'ts'>): AiFeedbackStats {
    this.ensureDir();
    const record: AiFeedbackEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      ...entry,
    };
    fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
    return this.getStats();
  }

  getStats(): AiFeedbackStats {
    if (!fs.existsSync(this.filePath)) {
      return { totalSamples: 0, positiveSamples: 0, negativeSamples: 0 };
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    let totalSamples = 0;
    let positiveSamples = 0;
    let negativeSamples = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { rating?: string };
        totalSamples++;
        if (parsed.rating === 'up') positiveSamples++;
        else if (parsed.rating === 'down') negativeSamples++;
      } catch {
        // ignore malformed line
      }
    }
    return { totalSamples, positiveSamples, negativeSamples };
  }
}
