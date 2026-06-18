/**
 * Stage 2 — relevance rerank.
 *
 * Sits between Stage 1 dense retrieval (top-K cosine) and Stage 3 NLI
 * polarity gate. Single batched LLM call rates each retrieved candidate
 * for topical relevance to the user's claim, then drops candidates below
 * a threshold and caps to RERANK_KEEP.
 *
 * Why a single batched call instead of N per-pair calls: a smaller LLM
 * prompt with all candidates side-by-side asks a much simpler question
 * than NLI ("is this candidate even on-topic?") and runs once (~5-10 s)
 * instead of N times. Replacing 5 of 10 Stage-3 NLI calls (~7 s each)
 * with a single rerank call is a net win.
 *
 * Why not a dedicated cross-encoder like bge-reranker-v2-m3 in
 * Transformers.js: same ONNX-ergonomics concern documented in
 * [`docs/ADR_nli_llm_judge_over_mdeberta.md`](../../docs/ADR_nli_llm_judge_over_mdeberta.md).
 * The LLM-as-reranker path uses the LLM endpoint we already have wired
 * and proven.
 */
import OpenAI from 'openai';
import { z } from 'zod';

import { getConfig } from '../config/index.ts';
import { logger } from '../util/logger.ts';
import type { RetrieveCandidate } from './retrieve.ts';

export interface RerankedCandidate extends RetrieveCandidate {
  /** 0..1 relevance score from the rerank LLM. */
  rerankScore: number;
}

let _client: OpenAI | undefined;
function client(): OpenAI {
  if (_client) return _client;
  const cfg = getConfig();
  _client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY, baseURL: cfg.OPENAI_BASE_URL });
  return _client;
}

const RERANK_PROMPT = `You score the topical relevance of fact-check candidates to a user's claim.

For each candidate fact-check, return a relevance score in [0, 1]:
  - 1.0: the candidate reviews the SAME proposition as the user's claim
    (whether to support, refute, or qualify it). The publisher's verdict
    on the candidate is directly usable for the user's claim.
  - 0.7: same topic, same entities, but talks about a sibling proposition
    that may not transfer (different date, different statistic, related
    but distinct event).
  - 0.3: same broad domain but different entities or different specific
    claim — the publisher's verdict cannot be reused.
  - 0.0: unrelated topic.

Be strict — when in doubt, score lower. A high score means the user can
inherit the publisher's verdict (possibly with polarity flip on
contradiction). A medium score means downstream NLI will reject the
candidate anyway.

Respond with strict JSON, one score per candidate, in input order.`;

const ScoreItemSchema = z.object({
  idx: z.number().int().nonnegative(),
  score: z.number().min(0).max(1),
});
const ResponseSchema = z.object({
  scores: z.array(ScoreItemSchema),
});

function buildResponseFormat(n: number): OpenAI.ChatCompletionCreateParams['response_format'] {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'rerank_scores',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scores: {
            type: 'array',
            minItems: n,
            maxItems: n,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                idx: { type: 'integer', minimum: 0, maximum: Math.max(0, n - 1) },
                score: { type: 'number', minimum: 0, maximum: 1 },
              },
              required: ['idx', 'score'],
            },
          },
        },
        required: ['scores'],
      },
    },
  };
}

function parseResponse(raw: string, expected: number): number[] | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const validated = ResponseSchema.safeParse(parsed);
  if (!validated.success) return null;
  // Map idx → score so we don't depend on model returning entries in order.
  const out = new Array<number>(expected).fill(0);
  for (const item of validated.data.scores) {
    if (item.idx < expected) out[item.idx] = item.score;
  }
  return out;
}

export interface RerankOptions {
  /** Maximum number of candidates to keep after scoring. Default 5. */
  keep?: number;
  /** Drop candidates with rerankScore below this floor. Default 0.5. */
  threshold?: number;
}

export interface RerankResult {
  candidates: RerankedCandidate[];
  /** Score for every input candidate, in input order — diagnostic for tuning. */
  allScores: number[];
}

/**
 * Score and trim. Returns at most `keep` candidates, sorted by rerankScore
 * descending. Candidates whose score is below `threshold` are dropped even
 * if they would otherwise fit in the keep budget.
 *
 * On parse failure or empty input, behaves as a no-op (returns the input
 * unchanged with rerankScore=cosine as a fallback — the cosine ordering
 * is already a reasonable approximation).
 */
export async function rerankCandidates(
  claim: string,
  candidates: RetrieveCandidate[],
  options: RerankOptions = {},
): Promise<RerankResult> {
  const keep = Math.max(1, options.keep ?? 5);
  const threshold = options.threshold ?? 0.5;

  if (candidates.length === 0) {
    return { candidates: [], allScores: [] };
  }

  // No point reranking when we already have ≤ keep candidates.
  if (candidates.length <= keep) {
    const scores = candidates.map((c) => c.cosine);
    return {
      candidates: candidates.map((c) => ({ ...c, rerankScore: c.cosine })),
      allScores: scores,
    };
  }

  const cfg = getConfig();

  // Build the user message with numbered candidates so the model can index
  // by position.
  const lines: string[] = [];
  lines.push(`User claim: ${claim}`);
  lines.push('');
  lines.push('Candidates:');
  candidates.forEach((c, i) => {
    const text = c.claimReviewed.slice(0, 500);
    lines.push(`  [${i}] ${text}`);
  });
  const userContent = lines.join('\n');

  // Cap rerank tokens lower than extraction/NLI: the response is a tiny
  // JSON array of scores, but reasoning models (qwen3, deepseek-r1) will
  // otherwise burn the full OPENAI_MAX_TOKENS budget on internal thinking
  // before emitting the answer — once observed at 39 773 chars / 272 s for
  // a single rerank call.
  const rerankMaxTokens = Math.min(cfg.OPENAI_MAX_TOKENS || 1024, 1024);

  const completion = await client().chat.completions.create({
    model: cfg.OPENAI_MODEL,
    temperature: 0,
    max_tokens: rerankMaxTokens,
    messages: [
      { role: 'system', content: RERANK_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: buildResponseFormat(candidates.length),
  });

  const choice = completion.choices[0];
  const message = choice?.message as
    | { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }
    | undefined;
  const raw = (message?.content && message.content.trim().length > 0
    ? message.content
    : (message?.reasoning_content ?? message?.reasoning ?? '')) || '';

  const scores = parseResponse(raw, candidates.length);
  if (!scores) {
    logger.warn(
      { candidatesCount: candidates.length, rawLen: raw.length },
      'rerank: parse failed, falling back to cosine ordering',
    );
    return {
      candidates: candidates.slice(0, keep).map((c) => ({ ...c, rerankScore: c.cosine })),
      allScores: candidates.map((c) => c.cosine),
    };
  }

  const scored: RerankedCandidate[] = candidates.map((c, i) => ({
    ...c,
    rerankScore: scores[i] ?? 0,
  }));
  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  const kept = scored.filter((c) => c.rerankScore >= threshold).slice(0, keep);

  logger.debug(
    {
      input: candidates.length,
      kept: kept.length,
      threshold,
      keepBudget: keep,
      scores,
    },
    'rerank done',
  );

  return { candidates: kept, allScores: scores };
}

// Exposed for tests.
export const _internal = { parseResponse };
