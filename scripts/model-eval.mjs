#!/usr/bin/env node
// Biweekly translation-model evaluation.
//
// Purpose: compare candidate Workers AI text-generation models on the SAME
// Korean cloud-news translation task that PRODUCTION runs, scoring each with
// the SAME quality gate production uses (worker/index.js assessTranslation
// Quality, after applyDeterministicFixes) and measuring Neuron cost, so a human
// can decide whether to switch TRANSLATION_MODEL. It NEVER changes the live
// model — it only reports.
//
// Alignment with production (why the eval imports from worker/index.js):
//   A model's score is only meaningful if it is produced the way production
//   produces cards. So the eval builds the identical prompt + few-shot + JSON
//   schema, runs the identical deterministic post-processing, and applies the
//   identical quality gate. Measuring a shorter paraphrase prompt (as an
//   earlier version did) scores something the live pipeline never emits.
//
// Quality is the priority: the primary pass/fail signal is production's
// assessTranslationQuality. A secondary raw fluent-korean flag count and a
// semantic fact-grounding check are printed too, and every model's raw output
// is shown so a human makes the final call.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/model-eval.mjs
// Optional env:
//   EVAL_MODELS      comma-separated model IDs (default: candidate set below)
//   EVAL_SAMPLES     number of source articles to pull (default 8; use >=30 for
//                    a decision-grade comparison with statistical power)
//   EVAL_MAX_TOKENS  max_tokens per generation (default 4096). Must stay high
//                    enough that verbose/reasoning models can finish their JSON
//                    — truncation shows up as parse_fail and would disqualify a
//                    model for a reason that has nothing to do with quality.
//   EVAL_RETRY_ON_FLAG  "1" to run production's single quality-retry on cards
//                    that fail the gate (mirrors the live queue consumer), so
//                    the comparison reflects post-retry quality. Default off.
//   EVAL_WITH_REVIEW  "1" to run production's SECOND-pass AI review
//                    (reviewTranslationQualityWithAI) after translation, so the
//                    eval measures the full card a user sees. Doubles AI calls
//                    and counts the review model's neurons. Default off.
//   EVAL_REVIEW_MODEL review model override for EVAL_WITH_REVIEW (default: the
//                    production review model, @cf/meta/llama-3.1-8b-instruct-fp8).
//   MCP_TOKEN        OPTIONAL. Only used if D1 is unavailable. An mcp-type
//                    bearer token for POST /mcp format="source". Normally the
//                    eval reads source text straight from D1 (no token needed).
//   EVAL_SKIP_D1     "1" to skip the D1 source path and use MCP/fixtures.
//   EVAL_D1_DB       D1 database name for the source query (default
//                    cloud-whats-new; see wrangler.toml [[d1_databases]]).
//   CURRENT_MODEL    baseline override; normally resolved from the live
//                    deployment via GET /api/stats (see resolveCurrentModel).
//   CURRENT_MODEL_FALLBACK  used only if /api/stats is unreachable.
//   API_BASE         default derived from SITE_URL (api.<host>)

// Production translation pipeline pieces — the single source of truth. Imported
// (not re-implemented) so the eval cannot silently drift from what runs live.
import {
  getTranslationPrompt,
  FEW_SHOT_KO,
  FEW_SHOT_EN,
  FEW_SHOT_JA,
  TRANSLATION_JSON_SCHEMA,
  cleanSourceDescription,
  buildVendorPromptHints,
  applyDeterministicFixes,
  assessTranslationQuality,
  parseAIResponse,
  buildReviewMessages,
  applyReviewEdits,
  getReviewModel,
} from '../worker/index.js';

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://whats-new.kr';
const API = process.env.API_BASE || `https://api.${new URL(SITE_URL).host}`;
const MCP_TOKEN = process.env.MCP_TOKEN || '';
const SAMPLES = Number(process.env.EVAL_SAMPLES || 8);

// The model currently live in production (TRANSLATION_MODEL). The verdict below
// only recommends switching AWAY from it when a candidate is at least as good
// on fluent-korean quality AND cheaper.
//
// The baseline must be what production is ACTUALLY running: TRANSLATION_MODEL
// can be set as a Cloudflare var/secret without touching wrangler.toml, so
// reading the repo file can compare against a model nobody is using. Resolution
// order: explicit CURRENT_MODEL override -> live GET /api/stats (public) ->
// CURRENT_MODEL_FALLBACK (wrangler.toml, passed by the workflow) -> built-in.
const LAST_KNOWN_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

async function resolveCurrentModel() {
  if (process.env.CURRENT_MODEL) {
    return { model: process.env.CURRENT_MODEL, source: 'CURRENT_MODEL env override' };
  }
  try {
    const res = await fetch(`${API}/api/stats`, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const live = (await res.json())?.models?.translation;
      if (typeof live === 'string' && live.startsWith('@cf/')) {
        return { model: live, source: `live deployment (${API}/api/stats)` };
      }
    }
  } catch { /* fall through to the static fallbacks below */ }
  const fallback = (process.env.CURRENT_MODEL_FALLBACK || '').trim();
  if (fallback.startsWith('@cf/')) {
    return { model: fallback, source: 'wrangler.toml (live value unavailable)' };
  }
  return { model: LAST_KNOWN_MODEL, source: 'built-in default (live value unavailable)' };
}

// Candidate set: current model + cheaper/newer contenders to re-check biweekly.
const DEFAULT_MODELS = [
  '@cf/mistralai/mistral-small-3.1-24b-instruct', // current
  '@cf/zai-org/glm-4.7-flash',              // reasoning; expensive output tokens
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
];
const MODELS_OVERRIDDEN = Boolean((process.env.EVAL_MODELS || '').trim());
const MODELS = MODELS_OVERRIDDEN
  ? process.env.EVAL_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
  : [...DEFAULT_MODELS];

// GLM-4.7-flash unit pricing (docs). Used only for a rough $ estimate; the
// per-model neuron count from the API usage block is the primary signal.
const NEURON_USD = 0.011 / 1000; // $0.011 per 1k neurons beyond the free tier

if (!ACCOUNT || !TOKEN) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.');
  process.exit(1);
}

// ---- fluent-korean deterministic checks (mirrors the worker's quality gate
// and the guideline in scripts/fluent-korean-reference.md) --------------------
function splitSentences(text) {
  return String(text || '').replace(/(\d)\.(\d)/g, '$1·$2')
    .split(/(?<=[.!?。])\s+/).map((s) => s.trim()).filter(Boolean);
}
function tokenSet(text) {
  return new Set(String(text || '').replace(/(\d)\.(\d)/g, '$1·$2')
    .split(/[^가-힣A-Za-z0-9·]+/)
    .map((t) => t.replace(/(을|를|이|가|은|는|과|와|의|에|에서|으로|로|도|만|에게|부터|까지)$/, ''))
    .filter((t) => t.length >= 2));
}
function overlap(a, b) {
  const A = tokenSet(a), B = tokenSet(b);
  if (A.size < 3) return 0;
  let hit = 0; for (const t of A) if (B.has(t)) hit++;
  return hit / A.size;
}
function scoreCard(card) {
  const title = card.title || '', summary = card.summary || '', target = card.target || '';
  const sents = splitSentences(summary);
  const flags = [];
  // 문장 단위: 완결된 1~2문장, 종결어미
  if (sents.length < 1 || sents.length > 2) flags.push('sentence-count');
  // 구 단위: 첫 문장 주어/변화 생략, 군더더기 연결
  if (/^(이는|또한|이제|이 기능|이 변경|이러한|이 업데이트|이 새로운)/.test(summary)) flags.push('omits-subject');
  if (sents.slice(1).some((s) => /^(또한|이는|이를 통해)\s/.test(s))) flags.push('filler-connector');
  // 2번째 문장이 첫 문장/제목/대상 반복
  if (sents.length >= 2 && (overlap(sents[1], sents[0]) >= 0.6 || overlap(sents[1], `${title} ${target}`) >= 0.8)) flags.push('redundant-2nd');
  // 제목: 명사구(문장 종결 금지), 영어 동사 잔재, 미번역
  if (/(?:합니다|됩니다|습니다|[다요])\.?$/.test(title) || /\.$/.test(title)) flags.push('title-is-sentence');
  if (/\b(delivers|announces|now supports|is now available)\b/i.test(title)) flags.push('title-english-verb');
  if (!/[가-힣]/.test(title)) flags.push('title-not-translated');
  if (title.length > 40) flags.push('title>40');
  // 독자 지시문 금지 (사실 서술)
  if (/(?:하세요|하십시오|바랍니다|해\s?보세요)[.!]?(?:\s|$)/.test(summary)) flags.push('imperative');
  // 영어 어간+한국어 어미
  if (/[A-Za-z]{3,}(?:하거나|하여|합니다|되며|됩니다|했습니다|되었습니다|하는 |되는 )/.test(summary)) flags.push('english-stem-korean-ending');
  // 미번역 영어 구절
  if (/[가-힣][A-Z]{3,}/.test(`${title} ${summary}`)) flags.push('garbled-hangul-caps');
  // 엠대시 자제
  if (/—/.test(`${title} ${summary}`)) flags.push('em-dash');
  // CJK 오염 (한자/가나)
  if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(`${title} ${summary}`)) flags.push('cjk-contamination');
  // 마크다운 잔재
  if (/\*\*|`|_workflow_/.test(`${title} ${summary}`)) flags.push('markdown-artifact');
  return flags;
}

// ---- semantic fact-grounding check (item 6: defend against Goodhart) --------
// The deterministic flags above and production's assessTranslationQuality score
// FORM — sentence count, particles, CJK, invented acronyms. A model can score a
// perfect 0 and still DROP or FABRICATE facts: a wrong version number, a lost
// region, a hallucinated metric. Optimizing form-only flags rewards exactly that
// failure. This cheap check compares salient source tokens that MUST survive
// translation (versions, CVEs, region codes, numeric quantities, ALL-CAPS
// product/acronym tokens) against the generated card, and reports:
//   - dropped: salient source token absent from the card (information loss)
//   - fabricated: version/CVE/number in the card that is NOT in the source
//     (hallucination) — allowing for the few the pipeline legitimately adds.
// These are advisory signals printed alongside the gate, not an auto-switch.
function salientSourceTokens(title, description) {
  const src = `${title} ${description}`;
  const toks = new Set();
  for (const m of src.matchAll(/\bv?\d+(?:\.\d+)+(?:-[A-Za-z0-9.]+)?\b/g)) toks.add(m[0]); // versions: 16.4, v1.30-beta.0
  for (const m of src.matchAll(/\bCVE-\d{4}-\d{4,7}\b/gi)) toks.add(m[0]);                 // CVE ids
  for (const m of src.matchAll(/\b[a-z]{2,}-[a-z]+-\d\b/g)) toks.add(m[0]);                // region codes: us-east-1
  for (const m of src.matchAll(/\b\d+(?:,\d{3})*(?:\.\d+)?\s?(?:%|GB|TB|MB|GiB|TiB|ms|vCPUs?|cores?)\b/gi)) toks.add(m[0]); // quantities
  return [...toks];
}
function numericTokens(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\bv?\d+(?:\.\d+)+(?:-[A-Za-z0-9.]+)?\b/g)) out.add(m[0]);
  for (const m of String(text || '').matchAll(/\bCVE-\d{4}-\d{4,7}\b/gi)) out.add(m[0].toUpperCase());
  return out;
}
function semanticGrounding(card, src) {
  const haystack = `${card.title || ''} ${card.summary || ''} ${card.features || ''} ${card.regions || ''}`;
  const salient = salientSourceTokens(src.title, String(src.description || '').slice(0, 1500));
  const dropped = salient.filter((t) => !haystack.includes(t));
  const srcNums = numericTokens(`${src.title} ${src.description}`);
  const fabricated = [...numericTokens(haystack)].filter((t) => !srcNums.has(t) && !srcNums.has(t.replace(/^v/, '')));
  return { salientCount: salient.length, dropped, fabricated };
}

// 4096, not a tight budget: reasoning models spend tokens before emitting JSON,
// and a truncated response is indistinguishable from bad output in the parser.
// The mistral-small switch was measured at this budget; keep them comparable.
//
// Returns { text, usage, raw, httpStatus, apiError, finishReason } so the caller
// can tell APART the distinct parse_fail causes (item 3 — diagnose, don't
// assume "bad JSON"): a transport/API error, an empty body, a truncated body
// (finish_reason="length" or non-empty text that won't parse), or a clean
// parse. response_format mirrors production (buildTranslationRecord) so a model
// that honors JSON mode isn't penalized relative to how it actually runs live.
async function aiRun(model, messages, maxTokens = Number(process.env.EVAL_MAX_TOKENS || 4096)) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, response_format: TRANSLATION_JSON_SCHEMA, max_tokens: maxTokens, temperature: 0.1 }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.success === false) {
    const err = data?.errors ? JSON.stringify(data.errors) : `HTTP ${res.status}`;
    throw new Error(err);
  }
  const r = data.result || {};
  const text = r.response ?? r.choices?.[0]?.message?.content ?? '';
  const usage = r.usage || {};
  const finishReason = r.choices?.[0]?.finish_reason ?? r.finish_reason ?? '';
  // Keep the full result object around so parseAIResponse (production parser)
  // can read choices[].message.{content,reasoning,reasoning_content}.
  return { text, usage, raw: r, httpStatus: res.status, finishReason };
}

// Build the production-identical message array for one source article. Mirrors
// worker/index.js buildTranslationRecord: cleaned description, short-title
// expansion, vendor region/entity hints in the user message, full system prompt
// + few-shot. `row` uses the worker's column names (title_en/description_en/csp)
// so buildVendorPromptHints and applyDeterministicFixes consume it unchanged.
function buildEvalMessages(sample, lang = 'ko') {
  const row = {
    title_en: sample.title || '',
    description_en: sample.description || '',
    csp: sample.csp || 'aws',
    id: sample.id, url: sample.url, pub_date: sample.pub_date,
  };
  const sourceDescription = cleanSourceDescription(row);
  const titleForLLM = row.title_en.length < 20
    ? `${row.title_en}: ${sourceDescription.slice(0, 100)}`
    : row.title_en;
  const userMsg = `${buildVendorPromptHints(row)}\n\nTitle: ${titleForLLM}\nDescription: ${sourceDescription.slice(0, 1500)}`;
  const { sysPrompt } = getTranslationPrompt(lang);
  const fewShot = lang === 'en' ? FEW_SHOT_EN : lang === 'ja' ? FEW_SHOT_JA : FEW_SHOT_KO;
  return { row, messages: [{ role: 'system', content: sysPrompt }, ...fewShot, { role: 'user', content: userMsg }] };
}

const FIXTURES = [
  { title: 'AWS Lambda now supports Python 3.13 runtime', csp: 'aws', description: 'Customers can now create and update Lambda functions using Python 3.13, which includes improved error messages, a new REPL, and performance improvements. Available in all AWS Regions where Lambda is available.' },
  { title: 'Amazon RDS for PostgreSQL supports minor version 16.4', csp: 'aws', description: 'Amazon RDS for PostgreSQL now supports PostgreSQL minor version 16.4. This release contains bug fixes and improvements. We recommend upgrading to keep current with security and performance patches.' },
  { title: '[Preview] Azure Cosmos DB continuous backup for analytical store', csp: 'azure', description: 'Azure Cosmos DB now supports continuous backup and point-in-time restore for analytical store data. This feature is currently in public preview.' },
];

// Returns { samples, source, degraded }. `degraded` marks a run that fell back
// to the 3 built-in fixtures: the models then all summarize the same three
// synthetic articles, which is enough for a smoke test but far too narrow to
// justify switching the live model. The report says so loudly rather than
// presenting those numbers as a verdict-grade comparison.
// Pull vendor-original source text straight from the D1 `articles` table via
// `wrangler d1 execute --remote`, using the same CLOUDFLARE_API_TOKEN/ACCOUNT
// the eval already needs for /ai/run. This is the token-free path for sourcing
// the SAME input production translates (title_en + description_en) without the
// mcp-type MCP_TOKEN that format="source" requires. The summary is NOT read —
// each candidate model regenerates it, which is what we score.
async function loadFromD1() {
  const DB = process.env.EVAL_D1_DB || 'cloud-whats-new';
  const perCsp = Math.max(1, Math.ceil(SAMPLES / 3));
  // Balance across aws/gcp/azure, newest first, non-empty source body only.
  const sql = ['aws', 'gcp', 'azure'].map((csp) =>
    `SELECT csp, title_en, description_en, pub_date FROM articles ` +
    `WHERE csp='${csp}' AND description_en IS NOT NULL AND length(description_en) > 80 ` +
    `ORDER BY pub_date DESC LIMIT ${perCsp}`,
  ).join(' UNION ALL ');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // --json prints a [{ results: [...] }] envelope; --remote hits the deployed DB.
  const { stdout } = await run('npx', [
    'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql,
  ], { env: process.env, maxBuffer: 20 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const rows = (Array.isArray(parsed) ? parsed : [parsed])
    .flatMap((r) => r?.results || []);
  return rows.map((r) => ({ title: r.title_en, description: r.description_en, csp: r.csp }));
}

async function loadSamples() {
  // 1) explicit eval set file (most controlled/reproducible)
  const file = process.env.EVAL_SET_FILE;
  if (file) {
    const { readFileSync } = await import('node:fs');
    const arr = JSON.parse(readFileSync(file, 'utf8'));
    return { samples: arr.slice(0, SAMPLES), source: `EVAL_SET_FILE (${file})`, degraded: false };
  }

  // 2) vendor-original source straight from D1 (no MCP_TOKEN needed). Preferred
  // because it reads the exact text production translates, using credentials
  // the eval already has. Set EVAL_SKIP_D1=1 to force the MCP/fixtures path.
  if (process.env.EVAL_SKIP_D1 !== '1' && ACCOUNT && TOKEN) {
    try {
      const d1 = await loadFromD1();
      if (d1.length) {
        return { samples: d1.slice(0, SAMPLES), source: `D1 articles table (${d1.length} rows via wrangler --remote)`, degraded: false };
      }
    } catch (e) {
      // Fall through to MCP/fixtures, but remember why D1 was unavailable.
      process.env._D1_DIAG = String(e.message || e).slice(0, 160);
    }
  }

  // 3) live vendor-original text via MCP (needs an mcp-type MCP_TOKEN)
  if (!MCP_TOKEN) {
    const d1why = process.env._D1_DIAG ? ` (D1 unavailable: ${process.env._D1_DIAG})` : '';
    return {
      samples: FIXTURES.slice(0, SAMPLES),
      source: `built-in fixtures (MCP_TOKEN not set${d1why})`,
      degraded: true,
    };
  }
  const out = [];
  const mcpDiag = []; // why each CSP produced nothing, surfaced in the report
  for (const csp of ['aws', 'gcp', 'azure']) {
    try {
      const res = await fetch(`${API}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MCP_TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_releases', arguments: { csp, format: 'source', limit: Math.ceil(SAMPLES / 3) } } }),
      });
      const data = await res.json().catch(() => null);
      // Surface a JSON-RPC error (e.g. an invalid/wrong-type MCP token rejected
      // by format="source") instead of silently falling back to fixtures.
      if (data?.error) { mcpDiag.push(`${csp}: ${data.error.message || JSON.stringify(data.error)}`); continue; }
      if (!res.ok) { mcpDiag.push(`${csp}: HTTP ${res.status}`); continue; }
      const text = data?.result?.content?.[0]?.text || '[]';
      const arr = JSON.parse(text.replace(/\n\n---[\s\S]*$/, ''));
      if (!arr.length) { mcpDiag.push(`${csp}: 0 source articles returned`); continue; }
      // Carry csp so the eval can build the same vendor region/entity hints
      // production uses (buildVendorPromptHints keys off row.csp).
      for (const a of arr) out.push({ title: a.title, description: a.description, csp });
    } catch (e) {
      mcpDiag.push(`${csp}: ${String(e.message).slice(0, 100)}`);
    }
  }
  if (!out.length) {
    // Report the ACTUAL reason (token rejected? empty? HTTP error?) so a failed
    // MCP fetch is diagnosable from the report, not misread as "no data".
    const why = mcpDiag.length ? `: ${mcpDiag.join(' | ')}` : '';
    const d1why = process.env._D1_DIAG ? ` [D1 unavailable: ${process.env._D1_DIAG}]` : '';
    return {
      samples: FIXTURES.slice(0, SAMPLES),
      source: `built-in fixtures (MCP fetch returned nothing${why})${d1why}`,
      degraded: true,
    };
  }
  return { samples: out.slice(0, SAMPLES), source: `live vendor originals via ${API}/mcp`, degraded: false };
}

// Map a production quality-gate reason to the Korean correction hint the live
// queue consumer appends on its single quality_retry (worker/index.js queue()).
// Kept in sync by intent; only the reasons the gate can emit are mapped.
function qualityHintFor(reasons, lang = 'ko') {
  const isKo = lang === 'ko';
  return (reasons || []).map((r) => {
    if (r === 'summary-repeats-title') return isKo ? '요약 첫 문장이 제목과 달라야 함' : 'Summary first sentence must differ from title';
    if (r === 'title-not-translated') return isKo ? '제목을 한국어로 번역해야 함' : 'Title must be translated';
    if (r === 'title-truncated') return isKo ? '제목이 잘리지 않게 완성해야 함' : 'Title must be completed without truncation';
    if (r === 'markdown-artifact') return isKo ? '마크다운 제거' : 'Remove markdown formatting';
    if (r === 'summary-sentence-count') return isKo ? '요약은 1~2문장. 새 정보가 없으면 1문장으로 끝낼 것' : 'Summary must be 1-2 sentences';
    if (r === 'summary-redundant') return '요약 두 번째 문장이 첫 문장·제목·대상을 반복함. 새 정보가 없으면 두 번째 문장을 삭제하고 1문장으로 쓸 것';
    if (r === 'summary-filler-connector') return '요약에서 또한/이는/이를 통해로 이어 붙인 문장을 없애고 구체적 사실만 쓸 것';
    if (r === 'summary-imperative') return '요약에 참조하세요/사용하세요 같은 독자 지시문을 쓰지 말고 변경 사실만 서술할 것';
    if (r === 'english-stem-korean-ending') return '영어 단어에 한국어 어미를 붙이지 말 것. 동사는 한국어로 번역할 것';
    if (r === 'untranslated-phrase') return '요약에 영어 구절을 남기지 말 것. 한글과 영어 대문자가 붙은 깨진 단어를 고칠 것';
    if (r === 'invented-acronym') return '원문에 없는 약어를 만들지 말 것. 제품·기능 이름은 원문 그대로 쓸 것';
    if (r === 'title-is-sentence') return '제목은 명사구. 합니다/됩니다/마침표로 끝나는 문장을 제목으로 쓰지 말 것';
    if (r === 'title-too-long') return '제목을 40자 이내로 줄일 것. 제품명 + 핵심 변경만 남길 것';
    if (r === 'target-too-generic') return isKo ? '대상을 구체적으로 작성' : 'Target must be specific';
    if (r === 'summary-omits-subject') return '요약 첫 문장에 주어와 핵심 변화를 명시하고 이는/또한/이제로 시작하지 말 것';
    if (r === 'awkward-particle') return '영어 제품명 뒤 조사는 발음 받침 기준으로 고를 것 (Engine을, Bedrock과, Integration을)';
    if (r === 'title-hallucinated') return '제목이 영문 원문과 무관한 한국어로 바뀌면 안 됨. 제품명과 핵심 변경을 유지할 것';
    return r;
  }).join('. ');
}

// Classify WHY a card did not score (item 3): diagnose, never assume "bad JSON".
//   api-error     — the /ai/run call failed (transport, auth, capacity, timeout)
//   empty-output  — call succeeded but returned no text at all
//   truncated     — finish_reason=length, or non-empty text that won't parse
//                   (model ran out of tokens mid-JSON — a budget problem, not quality)
//   unparseable   — non-empty, finished, but still not valid JSON
function classifyFailure({ apiError, text, finishReason }) {
  if (apiError) return `api-error: ${String(apiError).slice(0, 100)}`;
  const t = String(text || '').trim();
  if (!t) return 'empty-output';
  if (finishReason === 'length') return `truncated (finish_reason=length, ${t.length} chars)`;
  return `unparseable (${finishReason || 'stop'}, ${t.length} chars)`;
}

// Generate one card the production way, apply production's deterministic fixes,
// and score with production's quality gate. Returns a rich per-sample record so
// the report can diagnose failures and the verdict can use scored (not total)
// denominators. Optionally runs ONE quality retry (EVAL_RETRY_ON_FLAG) exactly
// as the live queue consumer does.
async function generateAndScore(model, sample, { retryOnFlag, withReview, reviewModel }) {
  const { row, messages } = buildEvalMessages(sample, 'ko');
  let usage = {}, text = '', finishReason = '', raw = null, apiError = null;
  try {
    ({ text, usage, finishReason, raw } = await aiRun(model, messages));
  } catch (e) {
    apiError = e.message;
  }
  const neurons = Number(usage.neurons || 0);
  const outTok = Number(usage.completion_tokens || 0);

  // Parse with the production parser (reads choices[].message.content/reasoning
  // and aiResp.response, strips <think>), so a model that puts JSON where
  // production looks for it is parsed the same way production parses it.
  const parsed = raw ? parseAIResponse(raw) : null;
  if (!parsed || !parsed.title) {
    return {
      src: sample.title, scored: false, neurons, outTok,
      err: classifyFailure({ apiError, text, finishReason }),
    };
  }

  // Production path, in order: applyDeterministicFixes -> (optional AI review
  // -> applyDeterministicFixes) -> assessTranslationQuality. The review pass is
  // the SAME second model production runs (reviewTranslationQualityWithAI); it
  // is opt-in here (EVAL_WITH_REVIEW=1) because it doubles AI calls/cost. With
  // it off, the eval measures translation-model quality in isolation; with it
  // on, it measures the full card a user would actually see.
  let record = applyDeterministicFixes(parsed, row, 'ko');
  let reviewNeurons = 0, reviewed = false, retried = false;

  if (withReview) {
    const { messages: reviewMsgs, maxTokens: reviewMax } = buildReviewMessages(row, record, 'ko', '');
    try {
      const rr = await aiRun(reviewModel, reviewMsgs, reviewMax);
      reviewNeurons = Number(rr.usage?.neurons || 0);
      const reviewParsed = rr.raw ? parseAIResponse(rr.raw) : null;
      const applied = applyReviewEdits(reviewParsed, record, row, 'ko');
      // Re-apply deterministic fixes to the reviewer's output, exactly as
      // runTranslationPipeline does.
      record = applyDeterministicFixes(applied.record, row, 'ko');
      reviewed = applied.reasons?.includes('reviewer-applied-edit') || reviewParsed != null;
    } catch { /* review failure is non-fatal in production too (review-error) */ }
  }

  let quality = assessTranslationQuality(record, row, 'ko');

  if (retryOnFlag && !quality.pass) {
    retried = true;
    const hint = qualityHintFor(quality.reasons, 'ko');
    const { sysPrompt } = getTranslationPrompt('ko');
    const retryMessages = [
      ...messages.slice(0, -1),
      { role: 'system', content: `${sysPrompt}\n\n=== 추가 지시 ===\n${hint}` },
      messages[messages.length - 1],
    ];
    try {
      const r2 = await aiRun(model, retryMessages);
      usage = r2.usage || {};
      const reparsed = r2.raw ? parseAIResponse(r2.raw) : null;
      // Count the retry's cost too — production pays it on a quality_retry.
      if (reparsed && reparsed.title) {
        record = applyDeterministicFixes(reparsed, row, 'ko');
        quality = assessTranslationQuality(record, row, 'ko');
      }
    } catch { /* keep the first attempt's result if the retry call fails */ }
  }

  const rawFlags = scoreCard(record);                 // secondary fluent-korean signal
  const grounding = semanticGrounding(record, sample); // item 6 semantic signal
  return {
    src: sample.title, scored: true, retried, reviewed,
    // Report translation + review neurons so cost reflects what production pays.
    neurons: neurons + reviewNeurons, outTok,
    title: record.title, summary: record.summary,
    pass: quality.pass, reasons: quality.reasons,
    rawFlags, grounding,
  };
}

async function main() {
  const { samples, source: sampleSource, degraded } = await loadSamples();
  const { model: CURRENT_MODEL, source: baselineSource } = await resolveCurrentModel();
  const maxTokens = Number(process.env.EVAL_MAX_TOKENS || 4096);
  // Without the baseline in the run there is nothing to compare against, so
  // pull it in unless the caller pinned an explicit model list.
  if (!MODELS_OVERRIDDEN && !MODELS.includes(CURRENT_MODEL)) MODELS.unshift(CURRENT_MODEL);
  const retryOnFlag = process.env.EVAL_RETRY_ON_FLAG === '1';
  const withReview = process.env.EVAL_WITH_REVIEW === '1';
  // Review model resolution mirrors production getReviewModel(env): explicit
  // EVAL_REVIEW_MODEL wins, else production's default review model.
  const reviewModel = getReviewModel({ REVIEW_MODEL: process.env.EVAL_REVIEW_MODEL || '' });
  console.log(`# Translation model evaluation — ${new Date().toISOString().slice(0, 16)}Z`);
  console.log(`Samples: ${samples.length} (${sampleSource}) | Models: ${MODELS.length} | max_tokens: ${maxTokens}${retryOnFlag ? ' | quality-retry: on' : ''}${withReview ? ` | review: ${reviewModel}` : ''}`);
  console.log(`Baseline: \`${CURRENT_MODEL}\` — ${baselineSource}`);
  console.log(`Pipeline: production getTranslationPrompt + few-shot + JSON schema → applyDeterministicFixes${withReview ? ' → AI review → applyDeterministicFixes' : ''} → assessTranslationQuality (worker/index.js).`);
  console.log(`Rubric: scripts/fluent-korean-reference.md (github.com/snflkd/fluent-korean)\n`);
  if (samples.length < 30 && !degraded) {
    console.log(`> ⚠️ **Underpowered: n=${samples.length}.** Flag-rate differences this small are not`);
    console.log('> statistically reliable. Set `EVAL_SAMPLES=30` (or more) for a decision-grade run.\n');
  }
  if (degraded) {
    console.log('> ⚠️ **Smoke-test run, not a decision-grade comparison.** No `MCP_TOKEN`,');
    console.log(`> so every model summarized the same ${samples.length} built-in fixture article(s). Set the`);
    console.log('> `MCP_TOKEN` repo secret (an `mcp`-type `API_KEY_RING` token) to evaluate on');
    console.log('> real vendor originals before acting on any recommendation below.\n');
  }

  const results = [];
  for (const model of MODELS) {
    let neurons = 0, outTok = 0, gateFail = 0, rawFlagged = 0, parseFail = 0, scored = 0, grounded = 0;
    const samplesOut = [];
    for (const s of samples) {
      const rec = await generateAndScore(model, s, { retryOnFlag, withReview, reviewModel });
      neurons += rec.neurons;
      outTok += rec.outTok;
      if (!rec.scored) { parseFail++; samplesOut.push(rec); continue; }
      scored++;
      if (!rec.pass) gateFail++;              // production quality gate
      if (rec.rawFlags.length) rawFlagged++;  // secondary fluent-korean flags
      // "grounded" = no dropped salient facts AND no fabricated numbers.
      if (!rec.grounding.dropped.length && !rec.grounding.fabricated.length) grounded++;
      samplesOut.push(rec);
    }
    const n = samples.length;
    results.push({
      model, neurons, neuronPer: neurons / n, outTokPer: outTok / n,
      // Quality denominators are SCORED cards, not total: a model that parses 0
      // cards has 0 quality signal, not a perfect score (the earlier bug).
      scored, gateFail, rawFlagged, grounded, parseFail, n, samplesOut,
    });
  }

  // Summary table. gate_fail / raw_flag / ungrounded are over SCORED cards
  // (the parse-fail bug fix): a model that parsed 0 cards shows "—", never 0.
  const rate = (num, den) => (den > 0 ? `${num}/${den}` : '—');
  console.log('## Summary\n');
  console.log('gate_fail = failed production quality gate (lower better) · raw_flag = fluent-korean flags · ungrounded = dropped/fabricated facts (lower better) · all over SCORED cards\n');
  console.log('| model | neuron/card | out_tok/card | gate_fail | raw_flag | ungrounded | parse_fail | est $/1k cards |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const per1k = (r.neuronPer * 1000 * NEURON_USD).toFixed(2);
    const ungrounded = r.scored - r.grounded;
    console.log(`| ${r.model} | ${r.neuronPer.toFixed(1)} | ${r.outTokPer.toFixed(0)} | ${rate(r.gateFail, r.scored)} | ${rate(r.rawFlagged, r.scored)} | ${rate(ungrounded, r.scored)} | ${r.parseFail}/${r.n} | $${per1k} |`);
  }

  // --- Verdict (advisory; quality gate first, then cost) ---------------------
  // A candidate is eligible only if, on cards it actually PRODUCED, it is at
  // least as good as the current model on the production quality gate AND on
  // reliability (parse-fail rate), AND it produced enough scored cards to judge.
  // A model that parse-fails most cards is NOT eligible no matter how its few
  // scored cards look — the earlier logic rewarded exactly that (0 flagged
  // because 0 scored). Among eligible candidates, cheapest (fewest neurons) wins.
  const byModel = Object.fromEntries(results.map((r) => [r.model, r]));
  const current = byModel[CURRENT_MODEL];
  console.log('\n## Verdict\n');
  console.log(`Current model: \`${CURRENT_MODEL}\``);
  if (!current) {
    console.log('> Current model was not in this run; add it to EVAL_MODELS for a comparison. No recommendation.');
  } else if (current.scored === 0) {
    console.log('> Current model produced no parseable cards this run — the comparison has no baseline. No recommendation.');
  } else {
    const gateRate = (r) => (r.scored > 0 ? r.gateFail / r.scored : 1);
    const failRate = (r) => r.parseFail / r.n;
    // A candidate must have scored at least as large a share of cards as the
    // current model (reliability floor) before its quality is comparable.
    const MIN_SCORED_SHARE = Math.max(0.8, current.scored / current.n - 1e-9);
    const curGate = gateRate(current);
    const curFail = failRate(current);
    const eligible = results.filter((r) =>
      r.scored / r.n >= MIN_SCORED_SHARE &&
      gateRate(r) <= curGate + 1e-9 &&
      failRate(r) <= curFail + 1e-9,
    );
    eligible.sort((a, b) => a.neuronPer - b.neuronPer);
    const winner = eligible[0];
    // Note any model that LOOKED clean only because it barely produced cards.
    const vacuous = results.filter((r) => r.model !== CURRENT_MODEL && r.scored / r.n < MIN_SCORED_SHARE && r.gateFail === 0 && r.scored > 0);
    if (vacuous.length) {
      console.log(`> ⚠️ Ignored as unreliable (too few parseable cards to judge quality, not "clean"): ${vacuous.map((r) => `\`${r.model}\` (${r.scored}/${r.n} scored)`).join(', ')}.`);
    }
    if (!winner || winner.model === CURRENT_MODEL) {
      console.log('**Recommendation: KEEP current model.** No candidate matches its quality and reliability at a lower cost.');
    } else if (degraded || samples.length < 30) {
      console.log(`**Recommendation: KEEP current model for now** — \`${winner.model}\` led this run`);
      console.log(`(${winner.neuronPer.toFixed(1)} vs ${current.neuronPer.toFixed(1)} neuron/card, gate_fail ${rate(winner.gateFail, winner.scored)} vs ${rate(current.gateFail, current.scored)}),`);
      console.log(`but n=${samples.length}${degraded ? ' and fixtures-only' : ''} is not decision-grade. Set \`MCP_TOKEN\`, \`EVAL_SAMPLES=30\`,`);
      console.log('and re-run (Actions → Translation model evaluation → Run workflow) before switching.');
    } else {
      const save = (1 - winner.neuronPer / current.neuronPer) * 100;
      console.log(`**Recommendation: consider switching to \`${winner.model}\`.**`);
      console.log(`- Quality: gate_fail ${rate(winner.gateFail, winner.scored)} vs current ${rate(current.gateFail, current.scored)} (candidate is no worse), parse_fail ${winner.parseFail}/${winner.n} vs ${current.parseFail}/${current.n}.`);
      console.log(`- Cost: ${winner.neuronPer.toFixed(1)} vs ${current.neuronPer.toFixed(1)} neuron/card (~${save.toFixed(0)}% cheaper).`);
      console.log('- **Quality is the priority — review the raw outputs below before switching.** To apply:');
      console.log('  ```');
      console.log(`  npx wrangler secret put TRANSLATION_MODEL   # value: ${winner.model}`);
      console.log('  # or edit wrangler.toml [vars] TRANSLATION_MODEL and push');
      console.log('  ```');
      console.log('  Remove the var to fall back. Then watch scripts/ko-quality-report.mjs for a few days.');
      // machine-readable marker for the workflow to flag the issue title
      console.log(`\n<!-- SWITCH_RECOMMENDED:${winner.model} -->`);
    }
  }

  // Per-model samples for human review (quality is the priority). Failures now
  // carry their diagnosed cause (api-error / empty / truncated / unparseable)
  // instead of a bare "unparseable/empty JSON".
  console.log('\n## Raw outputs for human review\n');
  for (const r of results) {
    console.log(`### ${r.model}`);
    for (const s of r.samplesOut) {
      if (!s.scored) { console.log(`- [FAIL] ${s.src} :: ${s.err}`); continue; }
      const marks = [];
      if (!s.pass) marks.push(`gate: ${s.reasons.join(', ')}`);
      if (s.rawFlags.length) marks.push(`flags: ${s.rawFlags.join(', ')}`);
      if (s.grounding.dropped.length) marks.push(`dropped: ${s.grounding.dropped.join(', ')}`);
      if (s.grounding.fabricated.length) marks.push(`fabricated: ${s.grounding.fabricated.join(', ')}`);
      if (s.retried) marks.push('(after 1 quality retry)');
      if (s.reviewed) marks.push('(after AI review)');
      const tag = marks.length ? `  ⚠️ ${marks.join(' | ')}` : '  ✅';
      console.log(`- ${s.title}${tag}`);
      console.log(`    ${String(s.summary).slice(0, 160)}`);
    }
    console.log();
  }

  console.log('> The quality gate (gate_fail) is production\'s assessTranslationQuality — the same gate a live card must pass.');
  console.log('> Form flags and the fact-grounding check are advisory; a human reviews the raw outputs, then sets TRANSLATION_MODEL only if quality holds. Nothing switches automatically.');
}

main().catch((e) => { console.error(e); process.exit(1); });
