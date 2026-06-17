import { describe, expect, it } from 'vitest';

import { secp256k1 as k256 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as ui8 from 'uint8arrays';

import {
  encodePublicKeyMultibase,
  verifyAtprotoServiceJwt,
} from '../src/util/atproto-jwt.ts';

interface SignedJwt {
  jwt: string;
  pubkeyMultibase: string;
  alg: 'ES256K' | 'ES256';
}

function makeJwt({
  iss,
  aud,
  lxm,
  exp,
  iat,
  alg,
  privateKey,
}: {
  iss: string;
  aud: string;
  lxm: string;
  exp: number;
  iat?: number;
  alg: 'ES256K' | 'ES256';
  privateKey: Uint8Array;
}): SignedJwt {
  const header = { typ: 'JWT', alg };
  const payload: Record<string, unknown> = { iss, aud, exp, lxm };
  if (iat !== undefined) payload.iat = iat;

  const headerB64 = ui8.toString(ui8.fromString(JSON.stringify(header), 'utf8'), 'base64url');
  const payloadB64 = ui8.toString(ui8.fromString(JSON.stringify(payload), 'utf8'), 'base64url');
  const signingInput = ui8.fromString(`${headerB64}.${payloadB64}`, 'utf8');
  const hash = sha256(signingInput);

  const curve = alg === 'ES256K' ? k256 : p256;
  // noble/curves 2.x: sign() returns a 64-byte Uint8Array (raw r||s) directly.
  const sig = curve.sign(hash, privateKey) as Uint8Array;
  const sigB64 = ui8.toString(sig, 'base64url');

  const pubkey = curve.getPublicKey(privateKey);
  const pubkeyMultibase = encodePublicKeyMultibase(alg, pubkey);
  return {
    jwt: `${headerB64}.${payloadB64}.${sigB64}`,
    pubkeyMultibase,
    alg,
  };
}

function fakeFetchFor(did: string, pubkeyMultibase: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes(encodeURIComponent(did)) || url.endsWith(did)) {
      return new Response(
        JSON.stringify({
          verificationMethod: [
            {
              id: '#atproto',
              publicKeyMultibase: pubkeyMultibase,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const ISS = 'did:plc:alice';
const AUD = 'did:plc:fact-labeler';
const LXM = 'com.atproto.moderation.createReport';

describe('verifyAtprotoServiceJwt — happy path', () => {
  it('accepts a valid ES256K JWT signed by the PLC-resolved key', async () => {
    const sk = k256.utils.randomSecretKey();
    const signed = makeJwt({
      iss: ISS,
      aud: AUD,
      lxm: LXM,
      exp: Math.floor(Date.now() / 1000) + 60,
      alg: 'ES256K',
      privateKey: sk,
    });
    const result = await verifyAtprotoServiceJwt(signed.jwt, {
      expectedAud: AUD,
      expectedLxm: LXM,
      fetchImpl: fakeFetchFor(ISS, signed.pubkeyMultibase),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.iss).toBe(ISS);
      expect(result.payload.aud).toBe(AUD);
      expect(result.payload.lxm).toBe(LXM);
    }
  });

  it('accepts a valid ES256 JWT signed by the PLC-resolved key', async () => {
    const sk = p256.utils.randomSecretKey();
    const signed = makeJwt({
      iss: ISS,
      aud: AUD,
      lxm: LXM,
      exp: Math.floor(Date.now() / 1000) + 60,
      alg: 'ES256',
      privateKey: sk,
    });
    const result = await verifyAtprotoServiceJwt(signed.jwt, {
      expectedAud: AUD,
      expectedLxm: LXM,
      fetchImpl: fakeFetchFor(ISS, signed.pubkeyMultibase),
    });
    expect(result.ok).toBe(true);
  });
});

describe('verifyAtprotoServiceJwt — rejections', () => {
  function signedJwt(over: Partial<Parameters<typeof makeJwt>[0]> = {}): SignedJwt {
    return makeJwt({
      iss: ISS,
      aud: AUD,
      lxm: LXM,
      exp: Math.floor(Date.now() / 1000) + 60,
      alg: 'ES256K',
      privateKey: k256.utils.randomSecretKey(),
      ...over,
    });
  }

  it('rejects a malformed JWT', async () => {
    const result = await verifyAtprotoServiceJwt('not.a.jwt.too.many.parts', {
      expectedAud: AUD,
      expectedLxm: LXM,
      fetchImpl: fakeFetchFor(ISS, ''),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('malformed');
  });

  it('rejects a wrong audience', async () => {
    const s = signedJwt({ aud: 'did:plc:someone-else' });
    const result = await verifyAtprotoServiceJwt(s.jwt, {
      expectedAud: AUD,
      expectedLxm: LXM,
      fetchImpl: fakeFetchFor(ISS, s.pubkeyMultibase),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('audience');
  });

  it('rejects a wrong lxm', async () => {
    const s = signedJwt({ lxm: 'com.atproto.something.else' });
    const result = await verifyAtprotoServiceJwt(s.jwt, {
      expectedAud: AUD,
      expectedLxm: LXM,
      fetchImpl: fakeFetchFor(ISS, s.pubkeyMultibase),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('lxm');
  });

  it('rejects an expired JWT', async () => {
    const s = signedJwt({ exp: Math.floor(Date.now() / 1000) - 600 });
    const result = await verifyAtprotoServiceJwt(s.jwt, {
      expectedAud: AUD,
      expectedLxm: LXM,
      fetchImpl: fakeFetchFor(ISS, s.pubkeyMultibase),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('expired');
  });

  it('rejects a JWT whose signature does not match the resolved key', async () => {
    const goodSk = k256.utils.randomSecretKey();
    const otherSk = k256.utils.randomSecretKey();
    const otherPub = k256.getPublicKey(otherSk);
    const otherPubMultibase = encodePublicKeyMultibase('ES256K', otherPub);

    const signed = signedJwt({ privateKey: goodSk });
    // Resolve to the other key — signature won't validate.
    const result = await verifyAtprotoServiceJwt(signed.jwt, {
      expectedAud: AUD,
      expectedLxm: LXM,
      fetchImpl: fakeFetchFor(ISS, otherPubMultibase),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('signature');
  });

  it('rejects when the iss DID cannot be resolved', async () => {
    const signed = signedJwt();
    const fetchImpl = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const result = await verifyAtprotoServiceJwt(signed.jwt, {
      expectedAud: AUD,
      expectedLxm: LXM,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('could not resolve');
  });

  it('rejects an unsupported alg', async () => {
    // hand-craft a JWT with alg=RS256 — we won't sign it, just check the prefix is rejected
    const header = ui8.toString(ui8.fromString('{"typ":"JWT","alg":"RS256"}', 'utf8'), 'base64url');
    const payload = ui8.toString(
      ui8.fromString(
        JSON.stringify({ iss: ISS, aud: AUD, lxm: LXM, exp: Math.floor(Date.now() / 1000) + 60 }),
        'utf8',
      ),
      'base64url',
    );
    const result = await verifyAtprotoServiceJwt(`${header}.${payload}.sig`, {
      expectedAud: AUD,
      expectedLxm: LXM,
      fetchImpl: fakeFetchFor(ISS, ''),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('alg');
  });
});
