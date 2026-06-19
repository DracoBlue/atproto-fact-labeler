/**
 * Minimal atproto service-JWT verifier.
 *
 * Used to authenticate `com.atproto.moderation.createReport` requests:
 *
 *   1. The user's PDS signs a JWT with `iss = user-did`,
 *      `aud = labeler-did`, `lxm = method`, short `exp`.
 *   2. We split the JWT, verify the claims, resolve `iss` to a signing key
 *      via PLC (`did:plc:…`) or did:web, and check the signature.
 *
 * Supports ES256K (secp256k1) and ES256 (p256), the two curves atproto
 * currently uses. Pure / async — no global state.
 *
 * The verifier intentionally does **not** trust:
 *  - missing or wrong `aud`,
 *  - missing or wrong `lxm`,
 *  - past-due `exp`,
 *  - unknown DID methods (only did:plc and did:web are handled),
 *  - signing-key types other than the two listed above.
 */
import { secp256k1 as k256 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import * as ui8 from 'uint8arrays';

const SECP256K1_MULTICODEC = new Uint8Array([0xe7, 0x01]);
const P256_MULTICODEC = new Uint8Array([0x80, 0x24]);

export interface AtprotoJwtPayload {
  iss: string;
  aud: string;
  exp: number;
  iat?: number;
  lxm?: string;
  jti?: string;
}

export interface VerifyOptions {
  expectedAud: string;
  expectedLxm: string;
  plcUrl?: string;
  /** For tests. */
  fetchImpl?: typeof fetch;
  /** Optional clock-skew tolerance in seconds (default 5). */
  clockSkewSec?: number;
  /**
   * Allow `did:web` issuers. Default false — `did:web` lets the JWT issuer
   * specify a hostname that the verifier will then fetch, which is an SSRF
   * surface unless the operator has further controls in place. Almost every
   * Bluesky reporter is `did:plc`; only enable this if you specifically need
   * `did:web` self-hosted-PDS reporters.
   */
  allowDidWeb?: boolean;
  /** Per-call DID resolution timeout (ms). Default 5000. */
  resolveTimeoutMs?: number;
}

export interface VerifyDebug {
  alg?: string;
  iss?: string;
  aud?: string;
  lxm?: string;
  expiresInSec?: number;
  sigLen?: number;
  keyAlg?: string;
}

export type VerifyResult =
  | { ok: true; iss: string; payload: AtprotoJwtPayload }
  | { ok: false; error: string; details?: VerifyDebug };

// Bounded in-memory replay cache. Keyed by `${iss}|${jti}` so two different
// issuers using the same `jti` don't collide. Entries expire by `exp`.
const seenJti = new Map<string, number>();
const JTI_CACHE_MAX = 10_000;

function checkAndRecordJti(iss: string, jti: string, exp: number, now: number): boolean {
  if (seenJti.size > JTI_CACHE_MAX) {
    for (const [k, v] of seenJti) {
      if (v < now) seenJti.delete(k);
      if (seenJti.size <= JTI_CACHE_MAX / 2) break;
    }
  }
  const key = `${iss}|${jti}`;
  if (seenJti.has(key)) return false;
  seenJti.set(key, exp);
  return true;
}

/** Exposed for tests that need to reset state between cases. */
export function _resetReplayCacheForTests(): void {
  seenJti.clear();
}

export async function verifyAtprotoServiceJwt(
  jwt: string,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const plcUrl = (opts.plcUrl ?? 'https://plc.directory').replace(/\/$/, '');
  const skew = opts.clockSkewSec ?? 5;
  const allowDidWeb = opts.allowDidWeb ?? false;
  const resolveTimeoutMs = opts.resolveTimeoutMs ?? 5000;

  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed JWT' };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  let payload: AtprotoJwtPayload;
  try {
    header = JSON.parse(ui8.toString(ui8.fromString(headerB64, 'base64url'), 'utf8'));
    payload = JSON.parse(ui8.toString(ui8.fromString(payloadB64, 'base64url'), 'utf8'));
  } catch {
    return { ok: false, error: 'invalid JWT encoding' };
  }

  const debug: VerifyDebug = {
    alg: header.alg,
    iss: payload.iss,
    aud: payload.aud,
    lxm: payload.lxm,
  };

  if (header.alg !== 'ES256K' && header.alg !== 'ES256') {
    return { ok: false, error: `unsupported alg: ${header.alg ?? 'missing'}`, details: debug };
  }
  if (payload.aud !== opts.expectedAud) {
    return { ok: false, error: `wrong audience: ${payload.aud}`, details: debug };
  }
  if (payload.lxm !== opts.expectedLxm) {
    return { ok: false, error: `wrong lxm: ${payload.lxm}`, details: debug };
  }
  const now = Math.floor(Date.now() / 1000);
  debug.expiresInSec = payload.exp - now;
  if (payload.exp + skew < now) {
    return { ok: false, error: 'expired', details: debug };
  }
  // Reject tokens dated in the future. Without this an attacker can mint a
  // JWT with a far-future `iat` and use it after `exp` rotation.
  if (typeof payload.iat === 'number' && payload.iat > now + skew) {
    return { ok: false, error: 'iat in the future', details: debug };
  }
  if (typeof payload.iss !== 'string' || !payload.iss.startsWith('did:')) {
    return { ok: false, error: 'invalid iss', details: debug };
  }

  const key = await resolveSigningKey(
    payload.iss,
    plcUrl,
    fetchImpl,
    allowDidWeb,
    resolveTimeoutMs,
  );
  if (!key) {
    return { ok: false, error: `could not resolve signing key for ${payload.iss}`, details: debug };
  }
  debug.keyAlg = key.alg;
  if (key.alg !== header.alg) {
    return {
      ok: false,
      error: `key/alg mismatch: key=${key.alg}, jwt=${header.alg}`,
      details: debug,
    };
  }

  const signedBytes = ui8.fromString(`${headerB64}.${payloadB64}`, 'utf8');
  const sig = ui8.fromString(sigB64, 'base64url');
  debug.sigLen = sig.length;
  if (sig.length !== 64) {
    return { ok: false, error: `unexpected signature length: ${sig.length}`, details: debug };
  }
  const curve = header.alg === 'ES256K' ? k256 : p256;
  // @noble/curves@2 default is prehash:true (hashes message internally), so we
  // pass the raw signing input — otherwise we'd verify against sha256(sha256(msg))
  // and every real PDS-signed JWT would look invalid. lowS:true enforces the
  // atproto spec's malleability protection — without it the same payload has
  // two valid signatures (s and -s mod n) and an attacker can replay either.
  const valid = curve.verify(sig, signedBytes, key.bytes, { lowS: true });
  if (!valid) {
    return { ok: false, error: 'signature invalid', details: debug };
  }
  // Replay defence — only check after signature verifies, so the cache can't
  // be filled with unauthenticated rubbish.
  if (typeof payload.jti === 'string' && payload.jti.length > 0) {
    if (!checkAndRecordJti(payload.iss, payload.jti, payload.exp, now)) {
      return { ok: false, error: 'replay (jti seen)', details: debug };
    }
  }
  return { ok: true, iss: payload.iss, payload };
}

interface ResolvedKey {
  alg: 'ES256K' | 'ES256';
  bytes: Uint8Array;
}

// Hostnames that resolve to / look like loopback or RFC1918 / link-local
// space — disallowed when fetching attacker-controlled `did:web` documents
// to prevent SSRF against metadata services (169.254.169.254 on AWS/GCP),
// internal vault hosts, etc.
function looksLikePrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  // IPv6 ULA + link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

async function resolveSigningKey(
  did: string,
  plcUrl: string,
  fetchImpl: typeof fetch,
  allowDidWeb: boolean,
  timeoutMs: number,
): Promise<ResolvedKey | null> {
  let doc: { verificationMethod?: Array<{ id?: string; publicKeyMultibase?: string }> };
  try {
    if (did.startsWith('did:plc:')) {
      // PLC URL is operator-configured (cfg.PLC_DIRECTORY_URL), not
      // attacker-controlled — safe to interpolate the DID into the path.
      const res = await fetchImpl(`${plcUrl}/${encodeURIComponent(did)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      doc = (await res.json()) as typeof doc;
    } else if (did.startsWith('did:web:')) {
      if (!allowDidWeb) return null;
      const rest = did.slice('did:web:'.length);
      if (rest.includes(':')) return null; // paths not supported here
      let host: string;
      try {
        host = decodeURIComponent(rest);
      } catch {
        return null;
      }
      // The attacker controls `host`. Reject anything that even looks like
      // an internal address, then let the parsed URL constructor catch the
      // rest (e.g. embedded credentials, non-ASCII tricks).
      if (looksLikePrivateHost(host)) return null;
      let target: URL;
      try {
        target = new URL(`https://${host}/.well-known/did.json`);
      } catch {
        return null;
      }
      if (looksLikePrivateHost(target.hostname)) return null;
      if (target.port && target.port !== '443') return null;
      const res = await fetchImpl(target.toString(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      doc = (await res.json()) as typeof doc;
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const vm = (doc.verificationMethod ?? []).find(
    (m) => m.id === `${did}#atproto` || m.id === '#atproto',
  );
  if (!vm?.publicKeyMultibase) return null;
  const mb = vm.publicKeyMultibase;
  if (!mb.startsWith('z')) return null;

  let prefixed: Uint8Array;
  try {
    prefixed = ui8.fromString(mb.slice(1), 'base58btc');
  } catch {
    return null;
  }
  if (prefixed.length < 3) return null;

  if (prefixed[0] === SECP256K1_MULTICODEC[0] && prefixed[1] === SECP256K1_MULTICODEC[1]) {
    return { alg: 'ES256K', bytes: prefixed.slice(2) };
  }
  if (prefixed[0] === P256_MULTICODEC[0] && prefixed[1] === P256_MULTICODEC[1]) {
    return { alg: 'ES256', bytes: prefixed.slice(2) };
  }
  return null;
}

/**
 * Helper for tests: encode a `did:key:`-style public key with the given curve.
 * Returns the `publicKeyMultibase` string suitable for a DID document.
 */
export function encodePublicKeyMultibase(curve: 'ES256K' | 'ES256', compressedPubkey: Uint8Array): string {
  const prefix = curve === 'ES256K' ? SECP256K1_MULTICODEC : P256_MULTICODEC;
  const prefixed = new Uint8Array(prefix.length + compressedPubkey.length);
  prefixed.set(prefix);
  prefixed.set(compressedPubkey, prefix.length);
  return 'z' + ui8.toString(prefixed, 'base58btc');
}
