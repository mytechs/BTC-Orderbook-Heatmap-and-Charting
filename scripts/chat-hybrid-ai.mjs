#!/usr/bin/env node
import readline from 'node:readline';

const BASE_URL = (process.env.HYBRID_AI_URL || 'http://127.0.0.1:11435').replace(/\/+$/, '');
let model = process.argv[2] || '';

async function detectModel() {
  try {
    const res = await fetch(`${BASE_URL}/v1/models`);
    if (res.ok) {
      const json = await res.json();
      if (!model && json.data?.[0]?.id) model = json.data[0].id;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

const ok = await detectModel();
if (!ok) {
  console.error(`Cannot reach Hybrid AI server at ${BASE_URL}.`);
  console.error('Start it first in another terminal: npm run start:hybrid-ai');
  process.exit(1);
}
if (!model) model = 'inkling-2-mini-hybrid';

console.log(`\x1b[36mConnected to ${BASE_URL} (${model})\x1b[0m`);
console.log('\x1b[90mCommands: /clear (reset chat), /exit (quit)\x1b[0m\n');

const messages = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = () => {
  rl.question('\x1b[32m>>> \x1b[0m', async (line) => {
    const text = line.trim();
    if (!text) return ask();
    if (text === '/exit' || text === '/bye' || text === '/quit') {
      rl.close();
      return;
    }
    if (text === '/clear') {
      messages.length = 0;
      console.log('\x1b[90mConversation cleared.\x1b[0m\n');
      return ask();
    }

    messages.push({ role: 'user', content: text });
    const t0 = Date.now();
    let fullContent = '';
    let inThinking = false;

    try {
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          temperature: 0.6,
          messages,
        }),
      });
      if (!res.ok || !res.body) {
        console.error(`\x1b[31mError (${res.status}): ${await res.text()}\x1b[0m\n`);
        messages.pop();
        return ask();
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;
          try {
            const chunk = JSON.parse(dataStr);
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.reasoning_content) {
              if (!inThinking) {
                process.stdout.write('\x1b[90m[thinking] ');
                inThinking = true;
              }
              process.stdout.write(delta.reasoning_content);
            }
            if (delta?.content) {
              if (inThinking) {
                process.stdout.write('\x1b[0m\n\n');
                inThinking = false;
              }
              fullContent += delta.content;
              process.stdout.write(delta.content);
            }
          } catch {
            // ignore partial JSON
          }
        }
      }
      if (inThinking) process.stdout.write('\x1b[0m');
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`\n\x1b[90m(${dt}s)\x1b[0m\n\n`);
      if (fullContent) messages.push({ role: 'assistant', content: fullContent });
    } catch (err) {
      console.error(`\x1b[31mRequest failed: ${err.message}\x1b[0m\n`);
      messages.pop();
    }
    ask();
  });
};

ask();
