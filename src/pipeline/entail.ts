/**
 * Stage 3 — NLI polarity gate.
 *
 * Determines whether the input claim entails, contradicts, or is neutral
 * w.r.t. each retrieved fact-check's claim_reviewed text. This is the
 * principled fix for the FTS aggregator's polarity bug — see docs/PIPELINE.md
 * § "Stage 3 — NLI polarity gate".
 *
 * Modes:
 *   - llm-judge: prompt OPENAI_MODEL (e.g. qwen3.6-27b) with a structured
 *                JSON Schema response. One call per candidate. Slow on big
 *                reasoning models but no extra model to install.
 *   - dedicated: reserved for a future dedicated NLI server. Currently throws.
 */
import OpenAI from 'openai';
import { z } from 'zod';

import { getConfig } from '../config/index.ts';
import { logger } from '../util/logger.ts';

export type NliLabel = 'entailment' | 'contradiction' | 'neutral';

export interface NliJudgment {
  label: NliLabel;
  confidence: number;
  reason?: string;
}

let _client: OpenAI | undefined;
function client(): OpenAI {
  if (_client) return _client;
  const cfg = getConfig();
  _client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY, baseURL: cfg.OPENAI_BASE_URL });
  return _client;
}

const NLI_PROMPT = `You are a careful natural-language inference judge.

Decide whether claim H (hypothesis) is *entailed by*, *contradicted by*, or
*neutral with respect to* claim P (premise).

Rules:
- entailment: if P is true, H must also be true. Same truth conditions.
- contradiction: if P is true, H must be false. Opposite truth conditions.
- neutral: H and P talk about different things, different time periods,
  different entities, or one is more specific than the other in a way that
  truth doesn't transfer.

Examples:
  P: "The earth is flat."                H: "The earth is round."          -> contradiction
  P: "Joe Biden won the 2020 election."  H: "Trump won the 2016 election." -> neutral (different year)
  P: "5G causes COVID."                  H: "5G technology causes COVID-19."-> entailment
  P: "Vaccines contain microchips."      H: "Vaccines do not contain microchips." -> contradiction
  P: "Inflation in the US is 3.2%."      H: "Trump claims there is no inflation in the US." -> neutral (different speakers/propositions)

Be conservative: prefer "neutral" over an uncertain entail/contradict.

Respond with strict JSON.`;

const RESPONSE_FORMAT: OpenAI.ChatCompletionCreateParams['response_format'] = {
  type: 'json_schema',
  json_schema: {
    name: 'nli_judgment',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', enum: ['entailment', 'contradiction', 'neutral'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' },
      },
      required: ['label', 'confidence', 'reason'],
    },
  },
};

const JudgmentSchema = z.object({
  label: z.enum(['entailment', 'contradiction', 'neutral']),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
});

function parseJudgment(raw: string): NliJudgment | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (!trimmed) return null;
  try {
    const parsed = JudgmentSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function judgeNli(
  hypothesis: string,
  premise: string,
): Promise<NliJudgment | null> {
  const cfg = getConfig();
  if (cfg.NLI_MODE === 'dedicated') {
    throw new Error('NLI_MODE=dedicated not yet implemented');
  }

  const completion = await client().chat.completions.create({
    model: cfg.OPENAI_MODEL,
    temperature: 0,
    ...(cfg.OPENAI_MAX_TOKENS > 0 ? { max_tokens: cfg.OPENAI_MAX_TOKENS } : {}),
    messages: [
      { role: 'system', content: NLI_PROMPT },
      { role: 'user', content: `P: ${premise}\nH: ${hypothesis}` },
    ],
    response_format: RESPONSE_FORMAT,
  });

  const choice = completion.choices[0];
  const message = choice?.message as
    | { content?: string | null; reasoning_content?: string | null }
    | undefined;
  const raw = (message?.content && message.content.trim().length > 0
    ? message.content
    : (message?.reasoning_content ?? '')) || '';

  if (!raw) {
    logger.warn({ finishReason: choice?.finish_reason }, 'NLI judge returned empty content');
    return null;
  }

  const judgment = parseJudgment(raw);
  if (!judgment) {
    logger.warn({ raw: raw.slice(0, 200) }, 'NLI judge returned unparseable content');
  }
  return judgment;
}

/** Parallel-safe batch judging. */
export async function judgeNliBatch(
  pairs: Array<{ hypothesis: string; premise: string }>,
): Promise<Array<NliJudgment | null>> {
  // Sequential — LM Studio with a single LLM slot serialises anyway, and
  // sequential keeps logs interpretable.
  const out: Array<NliJudgment | null> = [];
  for (const p of pairs) {
    out.push(await judgeNli(p.hypothesis, p.premise));
  }
  return out;
}

// Exposed for tests.
export const _internal = { parseJudgment };
