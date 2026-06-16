import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { buildFtsQuery, lookupCandidates } from '../src/pipeline/lookup.ts';

function withFreshDb(seed: Array<{
  source_url: string;
  publisher: string;
  claim_reviewed: string;
  rating_native?: string;
  lang?: string;
  review_date?: string;
}>): Database.Database {
  // We can't import db.ts because it touches getConfig() which requires env. So
  // we recreate the schema inline (small subset needed for FTS matching).
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE claim_review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url TEXT, publisher TEXT, publisher_url TEXT,
      claim_reviewed TEXT, claim_author TEXT,
      rating_native TEXT, rating_url TEXT,
      review_date TEXT, lang TEXT, sd_license TEXT, attribution TEXT
    );
    CREATE VIRTUAL TABLE claim_review_fts USING fts5(
      claim_reviewed,
      content='claim_review',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER claim_review_ai AFTER INSERT ON claim_review BEGIN
      INSERT INTO claim_review_fts(rowid, claim_reviewed) VALUES (new.id, new.claim_reviewed);
    END;
  `);
  const insert = db.prepare(
    `INSERT INTO claim_review (source_url, publisher, claim_reviewed, rating_native, lang, review_date, attribution)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of seed) {
    insert.run(
      row.source_url,
      row.publisher,
      row.claim_reviewed,
      row.rating_native ?? null,
      row.lang ?? null,
      row.review_date ?? null,
      `Fact-checked by ${row.publisher}.`,
    );
  }
  return db;
}

describe('buildFtsQuery', () => {
  it('strips stopwords and short tokens, OR-joins with prefix match', () => {
    const q = buildFtsQuery('The earth is flat');
    expect(q).toContain('earth*');
    expect(q).toContain('flat*');
    expect(q).not.toContain('the*');
    expect(q).not.toContain('is*');
    expect(q.split(' OR ').length).toBeLessThanOrEqual(10);
  });

  it('returns empty string for stopword-only inputs', () => {
    expect(buildFtsQuery('the is a in on')).toBe('');
  });

  it('handles diacritics', () => {
    const q = buildFtsQuery('Größtenteils falsch über Köln');
    expect(q).toContain('grosstenteils*');
    expect(q).toContain('falsch*');
    expect(q).toContain('koln*');
  });
});

describe('lookupCandidates', () => {
  it('finds matching entries via FTS', () => {
    const db = withFreshDb([
      { source_url: 'https://example.com/1', publisher: 'CORRECTIV',
        claim_reviewed: 'Die Erde ist eine Scheibe', rating_native: 'Falsch', lang: 'de' },
      { source_url: 'https://example.com/2', publisher: 'PolitiFact',
        claim_reviewed: '5G causes coronavirus', rating_native: 'False', lang: 'en' },
      { source_url: 'https://example.com/3', publisher: 'Snopes',
        claim_reviewed: 'Cats secretly run the internet', rating_native: 'False', lang: 'en' },
    ]);

    const result = lookupCandidates('Die Erde ist flach', { lang: 'de' }, db);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]!.publisher).toBe('CORRECTIV');
  });

  it('returns empty when no match', () => {
    const db = withFreshDb([
      { source_url: 'https://example.com/1', publisher: 'X',
        claim_reviewed: 'Unrelated content here', rating_native: 'False' },
    ]);
    const result = lookupCandidates('quantum entanglement cures cancer', {}, db);
    expect(result.candidates).toEqual([]);
  });

  it('returns empty for stopword-only query', () => {
    const db = withFreshDb([
      { source_url: 'https://example.com/1', publisher: 'X',
        claim_reviewed: 'whatever', rating_native: 'False' },
    ]);
    const result = lookupCandidates('the is on', {}, db);
    expect(result.candidates).toEqual([]);
  });

  it('prefers same-language candidates', () => {
    const db = withFreshDb([
      { source_url: 'https://example.com/en', publisher: 'PolitiFact',
        claim_reviewed: 'covid vaccine microchip tracker', rating_native: 'False', lang: 'en' },
      { source_url: 'https://example.com/de', publisher: 'CORRECTIV',
        claim_reviewed: 'covid Impfstoff Mikrochip Tracker', rating_native: 'Falsch', lang: 'de' },
    ]);
    const result = lookupCandidates('covid microchip', { lang: 'en' }, db);
    expect(result.candidates[0]!.publisher).toBe('PolitiFact');
  });
});
