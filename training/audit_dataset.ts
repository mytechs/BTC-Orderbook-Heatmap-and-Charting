import fs from 'node:fs';
import path from 'node:path';

interface ChatRow {
  messages: { role: string; content: string }[];
}

const FILLER_PREFIXES = [
  'okay,',
  'okay ',
  'let me ',
  'the user is asking',
  'we are given',
  'alright,',
  'sure,',
  'hmm',
];

function extractAnchorPrice(userOrSysText: string): number | null {
  const m =
    userOrSysText.match(/Price:\s*\$([0-9]+(?:\.[0-9]+)?)/i) ||
    userOrSysText.match(/around \$([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : null;
}

function auditFile(filePath: string): {
  total: number;
  reports: number;
  chats: number;
  fastCount: number;
  deepCount: number;
  avgThinkWords: number;
  errors: string[];
} {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const errors: string[] = [];
  let reports = 0;
  let chats = 0;
  let fastCount = 0;
  let deepCount = 0;
  let totalThinkWords = 0;
  let deepThinkSamples = 0;

  lines.forEach((line, idx) => {
    const rowNum = idx + 1;
    let row: ChatRow;
    try {
      row = JSON.parse(line) as ChatRow;
    } catch {
      errors.push(`Row ${rowNum}: Invalid JSONL line`);
      return;
    }

    if (!Array.isArray(row.messages) || row.messages.length < 3) {
      errors.push(`Row ${rowNum}: Expected >=3 messages (system, user, assistant)`);
      return;
    }

    const sys = row.messages[0];
    const usr = row.messages[row.messages.length - 2];
    const asst = row.messages[row.messages.length - 1];
    if (sys.role !== 'system' || usr.role !== 'user' || asst.role !== 'assistant') {
      errors.push(`Row ${rowNum}: Unexpected role sequence`);
      return;
    }

    const thinkMatch = asst.content.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
    if (!thinkMatch) {
      errors.push(`Row ${rowNum}: Assistant reply missing well-formed <think>...</think> block`);
      return;
    }

    const thinkBody = thinkMatch[1].trim();
    const answerBody = thinkMatch[2].trim();
    if (!answerBody) {
      errors.push(`Row ${rowNum}: Empty answer body after </think>`);
      return;
    }

    if (thinkBody.length === 0) {
      fastCount++;
      const lowerAns = answerBody.toLowerCase();
      if (FILLER_PREFIXES.some((p) => lowerAns.startsWith(p))) {
        errors.push(`Row ${rowNum}: Fast-mode answer starts with conversational filler: "${answerBody.slice(0, 45)}"`);
      }
    } else {
      deepCount++;
      const words = thinkBody.split(/\s+/).filter(Boolean).length;
      totalThinkWords += words;
      deepThinkSamples++;
      if (words > 180) {
        errors.push(`Row ${rowNum}: <think> too verbose (${words} words > 180 limit)`);
      }
    }

    const isReport = sys.content.includes('valid JSON matching the exact schema');
    const anchorPrice = extractAnchorPrice(`${sys.content}\n${usr.content}`);

    if (isReport) {
      reports++;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(answerBody) as Record<string, unknown>;
      } catch {
        errors.push(`Row ${rowNum}: TA Report answer is not valid JSON`);
        return;
      }

      const requiredKeys = [
        'marketBias',
        'confidence',
        'marketRegime',
        'summary',
        'keyLevels',
        'patterns',
        'tradeIdeas',
        'confluence',
        'riskWarning',
      ];
      for (const k of requiredKeys) {
        if (!(k in parsed)) errors.push(`Row ${rowNum}: Missing JSON key "${k}"`);
      }

      const validBias = new Set(['Bullish', 'Bearish', 'Neutral', 'Range-Bound']);
      if (!validBias.has(String(parsed.marketBias))) {
        errors.push(`Row ${rowNum}: Invalid marketBias "${parsed.marketBias}"`);
      }

      const ideas = Array.isArray(parsed.tradeIdeas) ? parsed.tradeIdeas : [];
      if (ideas.length < 1) {
        errors.push(`Row ${rowNum}: Must include at least 1 tradeIdea`);
      }

      for (const idea of ideas as {
        direction: string;
        entryLow: number;
        entryHigh: number;
        entryPrice: number;
        stopLoss: number;
        takeProfits: number[];
        riskReward: string;
      }[]) {
        if (idea.entryLow > idea.entryHigh) {
          errors.push(`Row ${rowNum}: entryLow (${idea.entryLow}) > entryHigh (${idea.entryHigh})`);
        }
        if (anchorPrice) {
          const pctOff = Math.abs(idea.entryPrice - anchorPrice) / anchorPrice;
          if (pctOff > 0.25) {
            errors.push(`Row ${rowNum}: entryPrice $${idea.entryPrice} >25% away from anchor $${anchorPrice}`);
          }
        }
        if (idea.direction === 'Long') {
          if (!(idea.stopLoss < idea.entryPrice && idea.entryPrice < idea.takeProfits[0])) {
            errors.push(
              `Row ${rowNum}: Invalid Long ordering SL=${idea.stopLoss} entry=${idea.entryPrice} TP1=${idea.takeProfits[0]}`
            );
          }
        } else if (idea.direction === 'Short') {
          if (!(idea.stopLoss > idea.entryPrice && idea.entryPrice > idea.takeProfits[0])) {
            errors.push(
              `Row ${rowNum}: Invalid Short ordering SL=${idea.stopLoss} entry=${idea.entryPrice} TP1=${idea.takeProfits[0]}`
            );
          }
        }
        const risk = Math.abs(idea.entryPrice - idea.stopLoss);
        const topTp = idea.takeProfits[idea.takeProfits.length - 1];
        const reward = Math.abs(topTp - idea.entryPrice);
        const actualR = reward / Math.max(1e-6, risk);
        const mRR = String(idea.riskReward || '').match(/1:([0-9.]+)/);
        if (!mRR) {
          errors.push(`Row ${rowNum}: Malformed riskReward "${idea.riskReward}"`);
        } else {
          const claimedR = Number(mRR[1]);
          if (Math.abs(claimedR - actualR) > 0.16) {
            errors.push(
              `Row ${rowNum}: R:R mismatch claimed 1:${claimedR} vs actual 1:${actualR.toFixed(1)}`
            );
          }
        }
        if (actualR < 1.8) {
          errors.push(`Row ${rowNum}: Swing R:R too low (1:${actualR.toFixed(1)} < 1:1.8)`);
        }
      }
    } else {
      chats++;
    }
  });

  return {
    total: lines.length,
    reports,
    chats,
    fastCount,
    deepCount,
    avgThinkWords: deepThinkSamples > 0 ? Math.round(totalThinkWords / deepThinkSamples) : 0,
    errors,
  };
}

function main() {
  const trainPath = path.resolve('training/data/train.jsonl');
  const evalPath = path.resolve('training/data/eval.jsonl');
  const tRes = auditFile(trainPath);
  const eRes = auditFile(evalPath);

  console.log('=== DATASET QUALITY AUDIT ===');
  console.log('TRAIN:', { ...tRes, errorCount: tRes.errors.length, errors: tRes.errors.slice(0, 10) });
  console.log('EVAL: ', { ...eRes, errorCount: eRes.errors.length, errors: eRes.errors.slice(0, 10) });

  if (tRes.errors.length > 0 || eRes.errors.length > 0) {
    console.error(`AUDIT FAILED: ${tRes.errors.length + eRes.errors.length} errors found!`);
    process.exit(1);
  }
  console.log('AUDIT PASSED: 100% of rows verified with ZERO errors!');
}

main();
