/**
 * Evaluates language detection, sentiment and topic classification on the labelled set in test/fixtures/eval.
 *   npm run eval:ai                 → rule-based baseline only (no network)
 *   npm run eval:ai -- --llm        → also the configured Anthropic model (needs ANTHROPIC_API_KEY; spends tokens)
 * Writes docs/eval/ai-eval-<method>.json and prints a Markdown table. Scores describe this small synthetic set only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import evalSet from '../test/fixtures/eval/eval-set.json';
import holdoutSet from '../test/fixtures/eval/holdout-set.json';
import { macroF1 } from '../src/analysis/evaluate';
import { detectLanguage } from '../src/analysis/language';
import { BaselineProvider } from '../src/analysis/providers/baseline.provider';
import { AnthropicProvider } from '../src/analysis/providers/anthropic.provider';
import type { AnalysisProvider } from '../src/analysis/providers/provider';
import { sanitizeArticleAnalysis } from '../src/analysis/schemas';
import { TOPIC_KEYS } from '../src/analysis/taxonomy';

type Item = { id: string; text: string; language: string; sentiment?: string; topic: string };
const SETS: Record<string, Item[]> = { development: evalSet as Item[], holdout: holdoutSet as Item[] };
const pct = (n: number) => (n * 100).toFixed(1);

function table(title: string, r: ReturnType<typeof macroF1>): string {
  const rows = r.perClass.map((c) => `| ${c.label} | ${pct(c.precision)} | ${pct(c.recall)} | ${pct(c.f1)} | ${c.support} |`).join('\n');
  return `### ${title}\n\nAccuracy ${pct(r.accuracy)}% · macro-F1 ${pct(r.macroF1)}%\n\n| class | precision % | recall % | F1 % | support |\n|---|---|---|---|---|\n${rows}\n`;
}

async function evaluate(provider: AnalysisProvider, items: Item[]) {
  const lang = macroF1(items.map((x) => x.language), items.map((x) => { const d = detectLanguage(x.text); return ['id', 'en', 'ms', 'jv'].includes(d.language) ? d.language : 'und'; }),
    ['id', 'en', 'ms', 'jv', 'und']);
  const supported = items.filter((x) => ['id', 'en'].includes(x.language));
  const sentGold: string[] = []; const sentPred: string[] = []; const topicGold: string[] = []; const topicPred: string[] = [];
  let failures = 0;
  for (const x of supported) {
    try {
      const r = await provider.analyzeArticle({ title: x.text, excerpt: null, body: null, publisher: 'eval', language: x.language, customTopics: [] });
      const { analysis } = sanitizeArticleAnalysis(r.output, x.text, new Set(TOPIC_KEYS));
      if (x.sentiment) { sentGold.push(x.sentiment); sentPred.push(analysis.sentiment.label); }
      topicGold.push(x.topic); topicPred.push(analysis.topics[0]?.key ?? 'unknown');
    } catch (e) {
      failures++; console.error(`${x.id}: ${(e as Error).message}`);
    }
  }
  const sentiment = macroF1(sentGold, sentPred, ['positive', 'negative', 'neutral', 'mixed']);
  const topicLabels = [...new Set(topicGold)].sort();
  const topic = macroF1(topicGold, topicPred, topicLabels);
  return { lang, sentiment, topic, failures, n: { all: items.length, supported: supported.length, sentiment: sentGold.length } };
}

async function main() {
  const providers: AnalysisProvider[] = [new BaselineProvider()];
  if (process.argv.includes('--llm')) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { console.error('--llm requires ANTHROPIC_API_KEY; skipping the LLM run.'); }
    else providers.push(new AnthropicProvider({ apiKey: key, model: process.env.AI_MODEL ?? 'claude-opus-5-5', effort: 'low', timeoutMs: 60_000,
      baseURL: process.env.AI_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com', refusalFallback: process.env.AI_REFUSAL_FALLBACK !== 'off' }));
  }
  const outDir = join(__dirname, '..', '..', '..', 'docs', 'eval');
  mkdirSync(outDir, { recursive: true });
  for (const p of providers) for (const [setName, items] of Object.entries(SETS)) {
    const r = await evaluate(p, items);
    const md = `## ${p.name} (${p.model}, method ${p.method}) on the ${setName} set\n\nItems: ${r.n.all} total, ${r.n.supported} in supported languages, ${r.n.sentiment} with a sentiment label. Provider failures: ${r.failures}.\n\n` +
      table('Language identification (all items; ms/jv/und are "unsupported" classes)', r.lang) + '\n' +
      table('Article sentiment (supported languages)', r.sentiment) + '\n' + table('Primary topic (supported languages)', r.topic);
    console.log(md);
    writeFileSync(join(outDir, `ai-eval-${p.method}-${setName}.json`), JSON.stringify({ provider: p.name, model: p.model, method: p.method, evaluatedAt: new Date().toISOString(),
      dataset: setName === 'holdout' ? 'test/fixtures/eval/holdout-set.json (v1, synthetic, not used for tuning)' : 'test/fixtures/eval/eval-set.json (v1, synthetic, used during development)', ...r }, null, 2) + '\n');
  }
}

void main();
