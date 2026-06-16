/**
 * Stage S1 — extract atomic, falsifiable claims from a post.
 *
 * Calls LM Studio via the OpenAI-compatible API. Output is constrained by a JSON
 * Schema so the model returns parseable structured data. See docs/COMPONENTS.md
 * §1 for the prompting rationale (DnDScore decomposition + decontextualisation).
 */
import OpenAI from 'openai';
import { z } from 'zod';

import { getConfig } from '../config/index.ts';
import { logger } from '../util/logger.ts';

let _client: OpenAI | undefined;

function client(): OpenAI {
  if (_client) return _client;
  const cfg = getConfig();
  _client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY, baseURL: cfg.OPENAI_BASE_URL });
  return _client;
}

const ClaimSchema = z.object({
  atomic_text: z.string().min(1),
  decontextualized_text: z.string().min(1),
  span_start: z.number().int().nonnegative().nullable().optional(),
  span_end: z.number().int().nonnegative().nullable().optional(),
  is_falsifiable: z.boolean(),
  lang: z.string().optional(),
  entities: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

const ResponseSchema = z.object({
  claims: z.array(ClaimSchema).default([]),
});

export type ExtractedClaim = z.infer<typeof ClaimSchema>;

const EXTRACTION_PROMPT = `You extract atomic, falsifiable factual claims from social media posts.

Rules:
- A *falsifiable* claim is one that could in principle be checked against the world: deaths, dates, statistics, who said what, whether an event happened.
- Opinions ("I love this"), feelings, hypotheticals ("if X then Y"), rhetorical questions, jokes, and pure name-calling are NOT falsifiable.
- Quotes attributed to a third party still count — extract them with the quoted person as the entity.
- Decompose compound claims into separate atomic ones.
- Provide a *decontextualised* version: rewrite the claim so it stands alone outside the post.
- Map each claim back to the character span in the original post text where possible.
- Mark every claim with confidence 0..1 indicating how sure you are it is a real factual assertion (not how sure you are it is true).

Respond with strict JSON matching this schema:
{
  "claims": [
    {
      "atomic_text":           string,
      "decontextualized_text": string,
      "span_start":            integer | null,
      "span_end":              integer | null,
      "is_falsifiable":        boolean,
      "lang":                  string (BCP47, optional),
      "entities":              [string, ...],
      "confidence":            number 0..1
    }
  ]
}

If the post contains no falsifiable claims, return { "claims": [] }.`;

const RESPONSE_FORMAT: OpenAI.ChatCompletionCreateParams['response_format'] = {
  type: 'json_schema',
  json_schema: {
    name: 'claim_extraction',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        claims: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              atomic_text: { type: 'string' },
              decontextualized_text: { type: 'string' },
              span_start: { type: ['integer', 'null'] },
              span_end: { type: ['integer', 'null'] },
              is_falsifiable: { type: 'boolean' },
              lang: { type: 'string' },
              entities: { type: 'array', items: { type: 'string' } },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: [
              'atomic_text',
              'decontextualized_text',
              'span_start',
              'span_end',
              'is_falsifiable',
              'entities',
              'confidence',
            ],
          },
        },
      },
      required: ['claims'],
    },
  },
};

export interface ExtractInput {
  text: string;
  lang?: string;
}

export interface ExtractResult {
  claims: ExtractedClaim[];
  extractorVersion: string;
  raw?: string;
}

/** Parse a raw model response into validated claims. Pure for testability. */
export function parseExtractionResponse(raw: string): ExtractedClaim[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Some local models wrap JSON in markdown fences — strip them.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  const validated = ResponseSchema.safeParse(parsed);
  if (!validated.success) return [];
  return validated.data.claims;
}

export async function extractClaims(input: ExtractInput): Promise<ExtractResult> {
  const cfg = getConfig();
  const userContent = input.lang
    ? `Post (lang=${input.lang}):\n${input.text}`
    : `Post:\n${input.text}`;

  const completion = await client().chat.completions.create({
    model: cfg.OPENAI_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: RESPONSE_FORMAT,
  });

  const raw = completion.choices[0]?.message?.content ?? '';
  const claims = parseExtractionResponse(raw);
  logger.debug({ count: claims.length, model: cfg.OPENAI_MODEL }, 'extraction done');
  return { claims, extractorVersion: cfg.OPENAI_MODEL, raw };
}
