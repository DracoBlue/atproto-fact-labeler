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

Be conservative: prefer "neutral" over an uncertain entail/contradict.

Respond with exactly this JSON shape — three fields, no extras:
{"label": "entailment" | "neutral" | "contradiction", "confidence": <number 0-1>, "reason": "<short sentence>"}

Examples (P = premise, H = hypothesis, then the JSON you must emit):

P: "The earth is flat."
H: "The earth is round."
{"label": "contradiction", "confidence": 0.98, "reason": "Round and flat are mutually exclusive geometric descriptions of the same object."}

P: "Joe Biden won the 2020 US presidential election."
H: "Trump won the 2016 election."
{"label": "neutral", "confidence": 0.9, "reason": "Different election year — the two propositions are independent."}

P: "5G causes COVID."
H: "5G technology causes COVID-19."
{"label": "entailment", "confidence": 0.95, "reason": "The hypothesis is a more specific phrasing of the same claim."}

P: "Vaccines contain microchips."
H: "Vaccines do not contain microchips."
{"label": "contradiction", "confidence": 0.99, "reason": "The hypothesis directly negates the premise."}

P: "Inflation in the US is 3.2%."
H: "Trump claims there is no inflation in the US."
{"label": "neutral", "confidence": 0.85, "reason": "Different speakers and propositions — one is a measurement, the other is a third-party claim."}`;

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

// Strict schema is what we ASK the model for via response_format. The parser
// below is intentionally more lenient — many OpenAI-compatible gateways
// (Vercel AI Gateway, LM Studio with MLX models, ...) do not actually enforce
// strict json_schema and let models emit just { "label": "..." } or use a
// different key name like "relationship". As long as we can recover the label,
// the matching pipeline is functional; missing confidence defaults to a
// sensible 0.7.
const LABEL_VALUES = ['entailment', 'contradiction', 'neutral'] as const;
type LabelValue = (typeof LABEL_VALUES)[number];

const StrictJudgmentSchema = z.object({
  label: z.enum(LABEL_VALUES),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
});

function tryRecoverPartialJson(raw: string): unknown {
  // Some models (gemma-4-26b on LM Studio) start the JSON correctly then loop
  // on whitespace until max_tokens kills them. Salvage by appending a closing
  // brace if the string is an unterminated object starting with `{`.
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  let candidate = trimmed;
  if (!candidate.endsWith('}')) {
    // Strip trailing junk after the last quoted value, then close.
    const lastQuote = candidate.lastIndexOf('"');
    if (lastQuote > 0) {
      candidate = candidate.slice(0, lastQuote + 1) + '}';
    } else {
      candidate = candidate + '}';
    }
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function parseJudgment(raw: string): NliJudgment | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = tryRecoverPartialJson(trimmed);
    if (parsed == null) return null;
  }

  // Strict pass first — gives us confidence + reason if the model honoured the schema.
  const strict = StrictJudgmentSchema.safeParse(parsed);
  if (strict.success) return strict.data;

  // Lenient pass: pull a label out of any plausible key. Accept "label",
  // "relationship", "result", "class", "verdict" — all observed in the wild.
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const labelRaw = obj.label ?? obj.relationship ?? obj.relation ?? obj.result ?? obj.class ?? obj.verdict;
  if (typeof labelRaw !== 'string') return null;
  const label = labelRaw.toLowerCase() as LabelValue;
  if (!LABEL_VALUES.includes(label)) return null;
  const confidence = typeof obj.confidence === 'number' && obj.confidence >= 0 && obj.confidence <= 1
    ? obj.confidence
    : 0.7; // sensible default when the model omits confidence
  const reason = typeof obj.reason === 'string' ? obj.reason : undefined;
  return { label, confidence, reason };
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
    | { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }
    | undefined;
  const raw = (message?.content && message.content.trim().length > 0
    ? message.content
    : (message?.reasoning_content ?? message?.reasoning ?? '')) || '';

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
