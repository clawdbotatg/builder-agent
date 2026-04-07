import { log } from './utils.js';

const GATEWAY_URL = 'https://llm.bankr.bot/v1/chat/completions';

// Model aliases
export const MODELS = {
  minimax: 'minimax-m2.7',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

// Approximate cost per 1M tokens (input/output) in USD
const COST_PER_1M = {
  'minimax-m2.7':      { input: 0.10,  output: 0.10  },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
};

let runLog = [];

export function getRunLog() {
  return runLog;
}

export function resetRunLog() {
  runLog = [];
}

export function generateAuditMarkdown() {
  const lines = [];
  lines.push('# LLM Audit Log');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('| # | Timestamp | Model | Label | Prompt Tokens | Completion Tokens | Total Tokens | Time | Est. Cost |');
  lines.push('|---|-----------|-------|-------|--------------|-------------------|-------------|------|-----------|');

  let totalCost = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTokensAll = 0;

  runLog.forEach((entry, i) => {
    const cost = estimateCost(entry.model, entry.promptTokens, entry.completionTokens);
    totalCost += cost;
    totalPrompt += entry.promptTokens;
    totalCompletion += entry.completionTokens;
    totalTokensAll += entry.totalTokens;
    lines.push(`| ${i + 1} | ${entry.timestamp.slice(11, 19)} | ${entry.model} | ${entry.label || '—'} | ${entry.promptTokens.toLocaleString()} | ${entry.completionTokens.toLocaleString()} | ${entry.totalTokens.toLocaleString()} | ${entry.elapsed} | $${cost.toFixed(4)} |`);
  });

  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Total LLM calls:** ${runLog.length}`);
  lines.push(`- **Total prompt tokens:** ${totalPrompt.toLocaleString()}`);
  lines.push(`- **Total completion tokens:** ${totalCompletion.toLocaleString()}`);
  lines.push(`- **Total tokens:** ${totalTokensAll.toLocaleString()}`);
  lines.push(`- **Estimated total cost:** $${totalCost.toFixed(4)}`);
  lines.push('');

  // Per-model breakdown
  const byModel = {};
  runLog.forEach(entry => {
    if (!byModel[entry.model]) byModel[entry.model] = { calls: 0, prompt: 0, completion: 0, total: 0, cost: 0 };
    const m = byModel[entry.model];
    m.calls++;
    m.prompt += entry.promptTokens;
    m.completion += entry.completionTokens;
    m.total += entry.totalTokens;
    m.cost += estimateCost(entry.model, entry.promptTokens, entry.completionTokens);
  });

  lines.push('### Cost by Model');
  lines.push('');
  lines.push('| Model | Calls | Prompt Tokens | Completion Tokens | Total Tokens | Est. Cost |');
  lines.push('|-------|-------|--------------|-------------------|-------------|-----------|');
  for (const [model, m] of Object.entries(byModel)) {
    lines.push(`| ${model} | ${m.calls} | ${m.prompt.toLocaleString()} | ${m.completion.toLocaleString()} | ${m.total.toLocaleString()} | $${m.cost.toFixed(4)} |`);
  }
  lines.push('');

  return lines.join('\n');
}

function estimateCost(model, promptTokens, completionTokens) {
  const rates = COST_PER_1M[model] || { input: 1.0, output: 1.0 };
  return (promptTokens / 1_000_000) * rates.input + (completionTokens / 1_000_000) * rates.output;
}

export async function callLLM(model, systemPrompt, userPrompt, options = {}) {
  const apiKey = process.env.BANKR_API_KEY;
  if (!apiKey) throw new Error('BANKR_API_KEY not set in .env');

  const modelId = MODELS[model] || model;
  const maxTokens = options.maxTokens || 4096;
  const retries = options.retries ?? 2;
  const label = options.label || '';

  log(`LLM call → ${modelId}${label ? ` [${label}]` : ''} (max ${maxTokens} tokens)`);

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) log(`  Retry ${attempt}/${retries}...`);

    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

      const response = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          model: modelId,
          messages,
          max_tokens: maxTokens,
          temperature: options.temperature ?? 0.3,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text();
        if (response.status >= 500 && attempt < retries) {
          log(`  ⚠ Server error (${response.status}), will retry...`);
          await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw new Error(`LLM API error (${response.status}): ${body}`);
      }

      const data = await response.json();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      let content = data.choices?.[0]?.message?.content || '';

      // Strip <think>...</think> blocks (minimax chain-of-thought)
      content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
      const usage = data.usage || {};

      const entry = {
        model: modelId,
        label,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        elapsed: `${elapsed}s`,
        timestamp: new Date().toISOString(),
      };
      runLog.push(entry);

      log(`  ← ${entry.totalTokens} tokens in ${elapsed}s`);

      return content;
    } catch (err) {
      if (err.name === 'AbortError' && attempt < retries) {
        log(`  ⚠ Request timed out, will retry...`);
        continue;
      }
      throw err;
    }
  }
}
