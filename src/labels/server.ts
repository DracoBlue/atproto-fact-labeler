/**
 * Wrap @skyware/labeler's LabelerServer.
 *
 * - Generates a secp256k1 signing key on first run if `LABELER_SIGNING_KEY` is
 *   empty, writes it back to `.env` so the user can re-use it later.
 * - Persists the labeler's own SQLite next to ours (separate DB by skyware
 *   design — that's fine, labels are a different concern).
 * - Exposes `emitLabel(...)` for the orchestrator to call on accepted proposals.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import { LabelerServer } from '@skyware/labeler';

import { getConfig } from '../config/index.ts';
import { logger } from '../util/logger.ts';

interface FactLabel {
  uri: string;
  cid: string;
  val: string;
  neg?: boolean;
  exp?: string;
}

const ENV_FILE = '.env';

function generateSigningKeyHex(): string {
  // 32 random bytes is overwhelmingly a valid secp256k1 private key.
  return randomBytes(32).toString('hex');
}

function ensureSigningKey(): string {
  const cfg = getConfig();
  if (cfg.LABELER_SIGNING_KEY && cfg.LABELER_SIGNING_KEY.length >= 32) {
    return cfg.LABELER_SIGNING_KEY;
  }
  const fresh = generateSigningKeyHex();
  // Try to persist back to .env so the user can keep the key.
  try {
    if (existsSync(ENV_FILE)) {
      const current = readFileSync(ENV_FILE, 'utf8');
      if (current.includes('LABELER_SIGNING_KEY=')) {
        const updated = current.replace(
          /LABELER_SIGNING_KEY=.*$/m,
          `LABELER_SIGNING_KEY=${fresh}`,
        );
        writeFileSync(ENV_FILE, updated);
      } else {
        appendFileSync(ENV_FILE, `\nLABELER_SIGNING_KEY=${fresh}\n`);
      }
    } else {
      writeFileSync(ENV_FILE, `LABELER_SIGNING_KEY=${fresh}\n`);
    }
    logger.warn(
      'generated a new secp256k1 signing key and wrote it to .env — keep this safe',
    );
  } catch (err) {
    logger.error({ err }, 'failed to persist signing key to .env (continuing in-memory)');
  }
  process.env.LABELER_SIGNING_KEY = fresh;
  return fresh;
}

/** Underlying Fastify instance — exact type comes from @skyware/labeler's bundled Fastify. */
export type LabelerApp = LabelerServer['app'];

export interface FactLabelerServer {
  /** Mount extra routes here before start(). */
  app: LabelerApp;
  start(): Promise<void>;
  stop(): Promise<void>;
  emitLabel(label: FactLabel): Promise<void>;
}

export function createLabelerServer(): FactLabelerServer {
  const cfg = getConfig();
  const signingKey = ensureSigningKey();

  const dbPath = resolve(cfg.SQLITE_PATH.replace(/\.sqlite$/, '') + '-labels.db');
  mkdirSync(dirname(dbPath), { recursive: true });

  const server = new LabelerServer({
    did: cfg.LABELER_DID,
    signingKey,
    dbPath,
    // Auth: allow anyone in dev mode; in production this should be restricted.
    auth: () => true,
  });

  return {
    app: server.app,
    async start(): Promise<void> {
      return new Promise((resolveFn, reject) => {
        // Bind to 0.0.0.0 so Traefik / other containers can reach the server.
        // Fastify's default host is 127.0.0.1, which is loopback-only.
        server.start({ port: cfg.LABELER_PORT, host: '0.0.0.0' }, (err, address) => {
          if (err) reject(err);
          else {
            logger.info({ address, did: cfg.LABELER_DID }, 'labeler server listening');
            resolveFn();
          }
        });
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolveFn) => server.close(() => resolveFn()));
    },

    async emitLabel(label: FactLabel): Promise<void> {
      await server.createLabel({
        uri: label.uri,
        cid: label.cid,
        val: label.val,
        neg: label.neg ?? false,
        exp: label.exp,
      });
      logger.info(
        { uri: label.uri, val: label.val, neg: label.neg ?? false },
        'label emitted',
      );
    },
  };
}
