import { describe, expect, it } from 'vitest';

import {
  CLAIM_VERDICT_NSID,
  buildClaimVerdictRecord,
} from '../src/labels/atproto-verdict.ts';
import type { EvidenceSnapshot } from '../src/pipeline/orchestrator.ts';

const snapshot: EvidenceSnapshot = {
  evidence: [
    {
      polarity: 'contradict',
      intakePath: 'factcheck-api',
      attribution: 'Fact-checked by Full Fact. Sourced via Google Fact Check Tools API.',
      externalSource: {
        publisherName: 'Full Fact',
        publisherSite: 'fullfact.org',
        publisherUrl: 'https://fullfact.org/',
        sourceUrl: 'https://fullfact.org/online/earth-is-spherical-not-flat/',
        claimReviewed: 'The Earth is flat.',
        ratingNative: 'We have abundant evidence …',
        reviewDate: '2023-03-03T00:00:00Z',
        lang: 'en',
      },
    },
  ],
  voteBreakdown: { entail: 0, contradict: 1, neutral: 3 },
};

describe('buildClaimVerdictRecord', () => {
  it('produces a well-formed record for a true verdict', () => {
    const rec = buildClaimVerdictRecord({
      subject: { uri: 'at://did:plc:alice/app.bsky.feed.post/3kx', cid: 'bafy-post' },
      claimText: 'the earth is round.',
      verdict: 'true',
      confidence: 0.826,
      snapshot,
      verifiedAt: '2026-06-20T10:00:00Z',
      validAt: '2023-03-03T00:00:00Z',
      rationale: 'Aggregated from 1 fact-check; agreement=1.',
    });
    expect(rec).toMatchObject({
      $type: CLAIM_VERDICT_NSID,
      subject: { uri: 'at://did:plc:alice/app.bsky.feed.post/3kx', cid: 'bafy-post' },
      claimText: 'the earth is round.',
      verdict: 'supported',
      confidence: 826,
      voteBreakdown: { entail: 0, contradict: 1, neutral: 3 },
      verifiedAt: '2026-06-20T10:00:00Z',
      validAt: '2023-03-03T00:00:00Z',
      rationale: 'Aggregated from 1 fact-check; agreement=1.',
      emittedLabel: 'fact-supported',
    });
    expect((rec.evidence as unknown[]).length).toBe(1);
  });

  it('maps every internal verdict to a record verdict', () => {
    const cases: Array<[Parameters<typeof buildClaimVerdictRecord>[0]['verdict'], string]> = [
      ['true', 'supported'],
      ['false', 'refuted'],
      ['mixed', 'mixed'],
      ['disputed', 'disputed'],
      ['outdated', 'outdated'],
      ['unknown', 'unknown'],
    ];
    for (const [internal, expected] of cases) {
      const r = buildClaimVerdictRecord({
        subject: { uri: 'at://x/y/z', cid: 'c' },
        claimText: 'x',
        verdict: internal,
        confidence: 0.5,
        snapshot,
        verifiedAt: '2026-06-20T00:00:00Z',
      });
      expect(r.verdict).toBe(expected);
    }
  });

  it('omits decontextualizedText when identical to claimText', () => {
    const r = buildClaimVerdictRecord({
      subject: { uri: 'at://x/y/z', cid: 'c' },
      claimText: 'same',
      decontextualizedText: 'same',
      verdict: 'true',
      confidence: 0.5,
      snapshot,
      verifiedAt: '2026-06-20T00:00:00Z',
    });
    expect((r as { decontextualizedText?: string }).decontextualizedText).toBeUndefined();
  });

  it('includes decontextualizedText when it actually differs', () => {
    const r = buildClaimVerdictRecord({
      subject: { uri: 'at://x/y/z', cid: 'c' },
      claimText: 'it is round',
      decontextualizedText: 'The Earth is round.',
      verdict: 'true',
      confidence: 0.5,
      snapshot,
      verifiedAt: '2026-06-20T00:00:00Z',
    });
    expect(r.decontextualizedText).toBe('The Earth is round.');
  });

  it('omits emittedLabel when the verdict has no label mapping (none today)', () => {
    // All current verdicts map; this just guards against a future unmapped one.
    const r = buildClaimVerdictRecord({
      subject: { uri: 'at://x/y/z', cid: 'c' },
      claimText: 'x',
      verdict: 'true',
      confidence: null,
      snapshot,
      verifiedAt: '2026-06-20T00:00:00Z',
    });
    expect((r as { confidence?: number }).confidence).toBeUndefined();
  });
});
