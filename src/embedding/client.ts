/**
 * OpenAI-compatible embedding client.
 *
 * Used by Stage 1 (dense retrieval) to embed both ClaimReview rows during
 * index build and incoming claims at query time. Falls back to the
 * OPENAI_* slot when EMBEDDING_BASE_URL / EMBEDDING_API_KEY are unset so a
 * single LM Studio instance can serve LLM + embeddings.
 */
import OpenAI from 'openai';

import { getConfig } from '../config/index.ts';
import { logger } from '../util/logger.ts';

let _client: OpenAI | undefined;

function client(): OpenAI {
  if (_client) return _client;
  const cfg = getConfig();
  // See src/pipeline/extract.ts for why we disable response compression.
  _client = new OpenAI({
    apiKey: cfg.EMBEDDING_API_KEY ?? cfg.OPENAI_API_KEY,
    baseURL: cfg.EMBEDDING_BASE_URL ?? cfg.OPENAI_BASE_URL,
    defaultHeaders: { 'Accept-Encoding': 'identity' },
  });
  return _client;
}

export interface EmbedResult {
  vectors: Float32Array[];
  dim: number;
  model: string;
}

/** Embed a batch of texts. Returns float32 vectors in input order. */
export async function embedBatch(inputs: string[]): Promise<EmbedResult> {
  if (!inputs.length) {
    const cfg = getConfig();
    return { vectors: [], dim: 0, model: cfg.EMBEDDING_MODEL };
  }
  const cfg = getConfig();
  // Force encoding_format='float' — the openai-node SDK defaults to 'base64'
  // for efficiency, but LM Studio's base64 response is not decoded correctly
  // by the SDK, yielding zero-padded short vectors.
  const res = await client().embeddings.create({
    model: cfg.EMBEDDING_MODEL,
    input: inputs,
    encoding_format: 'float',
  });
  if (!res.data.length || res.data.length !== inputs.length) {
    throw new Error(
      `embedding API returned ${res.data.length} vectors for ${inputs.length} inputs`,
    );
  }
  const vectors = res.data.map((d) => new Float32Array(d.embedding));
  const dim = vectors[0]!.length;
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(`embedding API returned mixed dimensions (${dim} vs ${v.length})`);
    }
  }
  return { vectors, dim, model: cfg.EMBEDDING_MODEL };
}

/** Embed a single text. */
export async function embedOne(input: string): Promise<{ vector: Float32Array; dim: number; model: string }> {
  const r = await embedBatch([input]);
  return { vector: r.vectors[0]!, dim: r.dim, model: r.model };
}

/** Serialise a vector to a SQLite BLOB. */
export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Read a SQLite BLOB back into a Float32Array. */
export function blobToVector(blob: Buffer | Uint8Array): Float32Array {
  const buf = blob instanceof Buffer ? blob : Buffer.from(blob);
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`embedding BLOB has invalid byte length ${buf.byteLength}`);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Cosine similarity between two equal-length float32 vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function logEmbeddingReady(): void {
  const cfg = getConfig();
  logger.debug(
    { model: cfg.EMBEDDING_MODEL, baseURL: cfg.EMBEDDING_BASE_URL ?? cfg.OPENAI_BASE_URL },
    'embedding client ready',
  );
}
