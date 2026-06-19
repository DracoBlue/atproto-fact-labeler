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

export async function verifyAtprotoServiceJwt(
  jwt: string,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const plcUrl = (opts.plcUrl ?? 'https://plc.directory').replace(/\/$/, '');
  const skew = opts.clockSkewSec ?? 5;

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
  if (typeof payload.iss !== 'string' || !payload.iss.startsWith('did:')) {
    return { ok: false, error: 'invalid iss', details: debug };
  }

  const key = await resolveSigningKey(payload.iss, plcUrl, fetchImpl);
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
  // and every real PDS-signed JWT would look invalid. lowS:false because the
  // atproto spec asks for low-S but not every PDS strictly enforces it.
  const valid = curve.verify(sig, signedBytes, key.bytes, { lowS: false });
  if (!valid) {
    return { ok: false, error: 'signature invalid', details: debug };
  }
  return { ok: true, iss: payload.iss, payload };
}

interface ResolvedKey {
  alg: 'ES256K' | 'ES256';
  bytes: Uint8Array;
}

async function resolveSigningKey(
  did: string,
  plcUrl: string,
  fetchImpl: typeof fetch,
): Promise<ResolvedKey | null> {
  let doc: { verificationMethod?: Array<{ id?: string; publicKeyMultibase?: string }> };
  try {
    if (did.startsWith('did:plc:')) {
      const res = await fetchImpl(`${plcUrl}/${encodeURIComponent(did)}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      doc = (await res.json()) as typeof doc;
    } else if (did.startsWith('did:web:')) {
      const rest = did.slice('did:web:'.length);
      if (rest.includes(':')) return null; // paths not supported here
      const host = decodeURIComponent(rest);
      const res = await fetchImpl(`https://${host}/.well-known/did.json`, {
        headers: { accept: 'application/json' },
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
