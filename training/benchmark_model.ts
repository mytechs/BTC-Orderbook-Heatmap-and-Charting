import fs from 'node:fs';
import path from 'node:path';

interface EvalRow {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
}

interface CaseScore {
  kind: 'report' | 'chat';
  latencySec: number;
  genTps: number;
  promptTps: number;
  evalTokens: number;
  jsonValid?: boolean;
  priceGrounded?: boolean;
  rawDirectionValid?: boolean;
  rawRR?: number | null;
  rrMeetsSwingMin?: boolean;
  slDistPct?: number | null;
  biasMatch?: boolean;
  citesExactPrices?: boolean;
}

const BASE_URL = process.env.BENCH_AI_URL || 'http://127.0.0.1:11435';

async function setLoraScale(scale: number): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/lora-adapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: 0, scale }]),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function extractAnchorPrice(text: string): number | null {
  const m =
    text.match(/Price:\s*\$([0-9]+(?:\.[0-9]+)?)/i) ||
    text.match(/around \$([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : null;
}

function extractJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(cleaned.slice(s, e + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

const BENCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    marketBias: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral', 'Range-Bound'] },
    confidence: { type: 'integer' },
    marketRegime: { type: 'string' },
    summary: { type: 'string' },
    keyLevels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          price: { type: 'number' },
          type: { type: 'string', enum: ['Support', 'Resistance', 'Liquidity Wall', 'Pivot'] },
          strength: { type: 'string', enum: ['Strong', 'Moderate'] },
          reason: { type: 'string' },
        },
        required: ['price', 'type', 'strength', 'reason'],
      },
    },
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bias: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral'] },
          status: { type: 'string', enum: ['Confirmed', 'Forming', 'Watch'] },
          confidence: { type: 'integer' },
          timeframe: { type: 'string' },
          targetPrice: { type: ['number', 'null'] },
          invalidationPrice: { type: ['number', 'null'] },
          description: { type: 'string' },
        },
        required: ['name', 'bias', 'status', 'confidence', 'timeframe', 'description'],
      },
    },
    tradeIdeas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          direction: { type: 'string', enum: ['Long', 'Short'] },
          setupType: { type: 'string' },
          entryLow: { type: 'number' },
          entryHigh: { type: 'number' },
          entryPrice: { type: 'number' },
          stopLoss: { type: 'number' },
          takeProfits: { type: 'array', items: { type: 'number' } },
          riskReward: { type: 'string' },
          confidence: { type: 'integer' },
          rationale: { type: 'string' },
          invalidation: { type: 'string' },
        },
        required: [
          'title', 'direction', 'setupType', 'entryLow', 'entryHigh', 'entryPrice',
          'stopLoss', 'takeProfits', 'riskReward', 'confidence', 'rationale', 'invalidation',
        ],
      },
    },
    confluence: {
      type: 'object',
      properties: {
        technical: { type: 'array', items: { type: 'string' } },
        orderbook: { type: 'array', items: { type: 'string' } },
        derivatives: { type: 'array', items: { type: 'string' } },
      },
      required: ['technical', 'orderbook', 'derivatives'],
    },
    riskWarning: { type: 'string' },
  },
  required: [
    'marketBias', 'confidence', 'marketRegime', 'summary', 'keyLevels',
    'patterns', 'tradeIdeas', 'confluence', 'riskWarning',
  ],
};

async function queryModel(
  messages: { role: string; content: string }[],
  isReport: boolean
): Promise<{ content: string; reasoning: string; genTps: number; promptTps: number; evalTokens: number; latencySec: number }> {
  const t0 = Date.now();
  const body: Record<string, unknown> = {
    model: 'btc-neon-lite-4b',
    temperature: 0.6,
    max_tokens: isReport ? 2800 : 900,
    messages,
  };
  if (isReport) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'btc_chart_analysis',
        strict: true,
        schema: BENCH_JSON_SCHEMA,
      },
    };
  }
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
    timings?: {
      predicted_per_second?: number;
      prompt_per_second?: number;
      predicted_n?: number;
    };
  };
  const latencySec = +((Date.now() - t0) / 1000).toFixed(2);
  return {
    content: json.choices?.[0]?.message?.content || '',
    reasoning: json.choices?.[0]?.message?.reasoning_content || '',
    genTps: +(json.timings?.predicted_per_second || 0).toFixed(1),
    promptTps: +(json.timings?.prompt_per_second || 0).toFixed(1),
    evalTokens: json.timings?.predicted_n || 0,
    latencySec,
  };
}

async function runSuite(label: string, reportRows: EvalRow[], chatRows: EvalRow[]) {
  const scores: CaseScore[] = [];

  for (const row of reportRows) {
    const sys = row.messages[0];
    const usr = row.messages[1];
    const gt = extractJson(row.messages[2].content);
    const anchor = extractAnchorPrice(`${sys.content}\n${usr.content}`);

    const out = await queryModel([sys, usr], true);
    const parsed = extractJson(out.content);

    let jsonValid = false;
    let priceGrounded = false;
    let rawDirectionValid = false;
    let rawRR: number | null = null;
    let rrMeetsSwingMin = false;
    let slDistPct: number | null = null;
    let biasMatch = false;

    if (parsed) {
      const reqKeys = ['marketBias', 'confidence', 'summary', 'keyLevels', 'patterns', 'tradeIdeas'];
      jsonValid = reqKeys.every((k) => k in parsed);
      biasMatch =
        Boolean(gt?.marketBias) &&
        String(parsed.marketBias).toLowerCase() === String(gt!.marketBias).toLowerCase();

      const ideas = Array.isArray(parsed.tradeIdeas) ? parsed.tradeIdeas : [];
      if (ideas.length > 0) {
        let allDirsOk = true;
        let allGrounded = true;
        const rrs: number[] = [];
        const slPcts: number[] = [];

        for (const t of ideas as {
          direction?: string;
          entryPrice?: number;
          stopLoss?: number;
          takeProfits?: number[];
        }[]) {
          const entry = Number(t.entryPrice || 0);
          const sl = Number(t.stopLoss || 0);
          const tps = Array.isArray(t.takeProfits) ? t.takeProfits.map(Number).filter((x) => x > 0) : [];
          if (anchor && (entry <= 0 || Math.abs(entry - anchor) / anchor > 0.2)) {
            allGrounded = false;
          }
          if (t.direction === 'Long') {
            if (!(sl > 0 && sl < entry && tps.length > 0 && entry < tps[0])) allDirsOk = false;
          } else if (t.direction === 'Short') {
            if (!(sl > entry && tps.length > 0 && entry > tps[0])) allDirsOk = false;
          } else {
            allDirsOk = false;
          }
          const risk = Math.abs(entry - sl);
          if (risk > 0 && tps.length > 0) {
            const topTp = tps[tps.length - 1];
            rrs.push(Math.abs(topTp - entry) / risk);
            slPcts.push((risk / entry) * 100);
          }
        }
        rawDirectionValid = allDirsOk;
        priceGrounded = allGrounded;
        if (rrs.length > 0) {
          rawRR = +(rrs.reduce((a, b) => a + b, 0) / rrs.length).toFixed(2);
          rrMeetsSwingMin = rrs[0] >= 1.8;
        }
        if (slPcts.length > 0) {
          slDistPct = +(slPcts.reduce((a, b) => a + b, 0) / slPcts.length).toFixed(2);
        }
      }
    }

    scores.push({
      kind: 'report',
      latencySec: out.latencySec,
      genTps: out.genTps,
      promptTps: out.promptTps,
      evalTokens: out.evalTokens,
      jsonValid,
      priceGrounded,
      rawDirectionValid,
      rawRR,
      rrMeetsSwingMin,
      slDistPct,
      biasMatch,
    });
  }

  for (const row of chatRows) {
    const sys = row.messages[0];
    const usr = row.messages[1];
    const anchor = extractAnchorPrice(sys.content);
    const out = await queryModel([sys, usr], false);
    const pricesInReply = [...out.content.matchAll(/\$([0-9]{2},?[0-9]{3})/g)].map((m) =>
      Number(m[1].replace(',', ''))
    );
    const citesExactPrices =
      pricesInReply.length >= 2 &&
      (!anchor || pricesInReply.every((p) => Math.abs(p - anchor) / anchor < 0.25));

    scores.push({
      kind: 'chat',
      latencySec: out.latencySec,
      genTps: out.genTps,
      promptTps: out.promptTps,
      evalTokens: out.evalTokens,
      citesExactPrices,
    });
  }

  const reps = scores.filter((s) => s.kind === 'report');
  const chats = scores.filter((s) => s.kind === 'chat');
  const avg = (arr: number[]) => (arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : 0);
  const pct = (arr: boolean[]) => (arr.length ? Math.round((arr.filter(Boolean).length / arr.length) * 100) : 0);

  return {
    model: label,
    cases: { reports: reps.length, chats: chats.length },
    speed: {
      avgGenTps: avg(scores.map((s) => s.genTps)),
      avgPromptTps: avg(scores.map((s) => s.promptTps)),
      avgReportLatencySec: avg(reps.map((s) => s.latencySec)),
      avgChatLatencySec: avg(chats.map((s) => s.latencySec)),
      avgEvalTokens: Math.round(avg(scores.map((s) => s.evalTokens))),
    },
    taReportQuality: {
      jsonValidPct: pct(reps.map((s) => Boolean(s.jsonValid))),
      priceGroundedPct: pct(reps.map((s) => Boolean(s.priceGrounded))),
      rawDirectionMathPct: pct(reps.map((s) => Boolean(s.rawDirectionValid))),
      swingRrPassPct: pct(reps.map((s) => Boolean(s.rrMeetsSwingMin))),
      avgRawRR: avg(reps.map((s) => s.rawRR).filter((x): x is number => x !== null)),
      avgStopWidthPct: avg(reps.map((s) => s.slDistPct).filter((x): x is number => x !== null)),
      heldOutBiasMatchPct: pct(reps.map((s) => Boolean(s.biasMatch))),
    },
    chatQuality: {
      groundedExactPricesPct: pct(chats.map((s) => Boolean(s.citesExactPrices))),
    },
  };
}

async function main() {
  const evalPath = path.resolve('training/data/eval.jsonl');
  const lines = fs
    .readFileSync(evalPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EvalRow);

  const reportRows = lines
    .filter((r) => r.messages[0].content.includes('valid JSON matching the exact schema'))
    .slice(0, 4);
  const chatRows = lines
    .filter((r) => !r.messages[0].content.includes('valid JSON matching the exact schema'))
    .slice(0, 3);

  console.log(`[Benchmark] Running head-to-head eval on ${reportRows.length} held-out TA Reports + ${chatRows.length} held-out Chats...`);

  await setLoraScale(1.0);
  const tuned = await runSuite('btc-neon-lite-4b (v2 QLoRA)', reportRows, chatRows);

  await setLoraScale(0.0);
  const base = await runSuite('qwen3:4b (Base Untuned)', reportRows, chatRows);

  // Restore trained LoRA adapter active at scale 1.0!
  await setLoraScale(1.0);

  console.log(JSON.stringify({ tuned, base }, null, 2));
}

main().catch(async (err) => {
  await setLoraScale(1.0);
  console.error(err);
  process.exit(1);
});
