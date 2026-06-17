import { describe, expect, it } from 'vitest';

import { renderProposalText } from '../src/hitl/format.ts';
import type { Proposal } from '../src/pipeline/orchestrator.ts';

const sample: Proposal = {
  proposalId: 42,
  postUri: 'at://did:plc:alice/app.bsky.feed.post/3kx',
  postCid: 'bafy123',
  postText: 'Die Erde ist flach. Das weiß ich.',
  claimId: 1,
  verdictId: 1,
  claimText: 'Die Erde ist flach',
  decontextualized: 'Die Erde ist flach',
  verdict: 'false',
  aggregated: { verdict: 'false', confidence: 0.97, agreement: 1, votes: 3 },
  evidence: [
    {
      id: 1,
      sourceUrl: 'https://correctiv.org/faktencheck/...',
      publisher: 'CORRECTIV',
      publisherUrl: null,
      claimReviewed: 'Die Erde ist eine Scheibe',
      ratingNative: 'Falsch',
      reviewDate: '2018-04-01',
      lang: 'de',
      attribution: 'Fact-checked by CORRECTIV.',
      cosine: 0.82,
      nliLabel: 'entailment',
      nliConfidence: 0.95,
      publisherVerdict: 'false',
      effectiveVerdict: 'false',
    },
  ],
};

describe('renderProposalText', () => {
  it('renders a readable terminal block', () => {
    const text = renderProposalText(sample);
    expect(text).toContain('Proposal #42');
    expect(text).toContain('Die Erde ist flach');
    expect(text).toContain('false');
    expect(text).toContain('CORRECTIV');
    expect(text).toContain('https://correctiv.org/faktencheck/...');
  });
});
