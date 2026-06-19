/**
 * Compare on-device language detection libraries on real ClaimReview rows.
 *
 *   pnpm tsx experiment/language/compare.ts
 *
 * Loads the first N=100 claim_reviewed strings from the local SQLite, runs
 * every library on each, and prints a side-by-side comparison plus aggregates
 * (per-pair agreement, "und"/empty ratio, throughput).
 *
 * Output: a `report.md` next to this script.
 */
import Database from 'better-sqlite3';
import { franc as francAll } from 'franc';
import { franc as francMin } from 'franc-min';
import { detect as tinyldDetect } from 'tinyld';
import { eld } from 'eld/medium';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

interface Row {
  id: number;
  claim_reviewed: string;
  publisher: string;
  publisher_url: string | null;
  url: string;
  stored_lang: string | null;
}

interface Detector {
  name: string;
  detect: (text: string) => string;
}

// ISO 639-3 → 639-1 fallback for franc output (which returns 3-letter).
const ISO3_TO_ISO1: Record<string, string> = {
  eng: 'en', deu: 'de', fra: 'fr', spa: 'es', ita: 'it', por: 'pt', nld: 'nl',
  pol: 'pl', rus: 'ru', ukr: 'uk', tur: 'tr', ara: 'ar', heb: 'he', fas: 'fa',
  pes: 'fa', urd: 'ur', hin: 'hi', ben: 'bn', tam: 'ta', mar: 'mr', mal: 'ml',
  kan: 'kn', tel: 'te', guj: 'gu', pan: 'pa', jpn: 'ja', kor: 'ko', cmn: 'zh',
  zho: 'zh', tha: 'th', vie: 'vi', ind: 'id', msa: 'ms', tgl: 'tl', ron: 'ro',
  hun: 'hu', ces: 'cs', slk: 'sk', slv: 'sl', hrv: 'hr', srp: 'sr', bul: 'bg',
  mkd: 'mk', ell: 'el', swe: 'sv', dan: 'da', nob: 'no', nor: 'no', fin: 'fi',
  est: 'et', lav: 'lv', lit: 'lt', cat: 'ca', glg: 'gl', eus: 'eu', isl: 'is',
  und: '?',
};
const norm = (s: string | null | undefined): string => {
  if (!s) return '?';
  const m = s.toLowerCase();
  return ISO3_TO_ISO1[m] ?? (m.length === 2 ? m : '?');
};

const detectors: Detector[] = [
  { name: 'franc-min', detect: (t) => norm(francMin(t)) },
  { name: 'franc-all', detect: (t) => norm(francAll(t)) },
  { name: 'tinyld',    detect: (t) => norm(tinyldDetect(t) ?? '?') },
  {
    name: 'eld',
    detect: (t) => {
      const r = eld.detect(t);
      return norm(r?.language ?? '?');
    },
  },
];

function loadSample(n: number): Row[] {
  const db = new Database('data/labeler.sqlite', { readonly: true });
  return db
    .prepare(
      `SELECT id, claim_reviewed, publisher, publisher_url, source_url AS url, lang AS stored_lang
         FROM claim_review
        ORDER BY id
        LIMIT ?`,
    )
    .all(n) as Row[];
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function runComparison(rows: Row[]): {
  perRow: Array<{ row: Row; results: Record<string, string>; agreement: number }>;
  timings: Record<string, { ms: number; calls: number }>;
} {
  const perRow: ReturnType<typeof runComparison>['perRow'] = [];
  const timings: Record<string, { ms: number; calls: number }> = {};
  for (const d of detectors) timings[d.name] = { ms: 0, calls: 0 };

  for (const row of rows) {
    const results: Record<string, string> = {};
    for (const d of detectors) {
      const t0 = performance.now();
      try {
        results[d.name] = d.detect(row.claim_reviewed);
      } catch {
        results[d.name] = 'ERR';
      }
      const dt = performance.now() - t0;
      timings[d.name]!.ms += dt;
      timings[d.name]!.calls++;
    }
    // Agreement = size of the largest group of identical non-"?" answers.
    const buckets = new Map<string, number>();
    for (const v of Object.values(results)) {
      if (v === '?' || v === 'ERR') continue;
      buckets.set(v, (buckets.get(v) ?? 0) + 1);
    }
    const agreement = Math.max(0, ...buckets.values());
    perRow.push({ row, results, agreement });
  }

  return { perRow, timings };
}

function pairwiseAgreement(perRow: ReturnType<typeof runComparison>['perRow']): Record<string, number> {
  const pairs: Record<string, number> = {};
  const detNames = detectors.map((d) => d.name);
  for (let i = 0; i < detNames.length; i++) {
    for (let j = i + 1; j < detNames.length; j++) {
      let match = 0;
      let total = 0;
      for (const r of perRow) {
        const a = r.results[detNames[i]!]!;
        const b = r.results[detNames[j]!]!;
        if (a === '?' || a === 'ERR' || b === '?' || b === 'ERR') continue;
        total++;
        if (a === b) match++;
      }
      pairs[`${detNames[i]} ↔ ${detNames[j]}`] = total ? Math.round((match / total) * 1000) / 10 : 0;
    }
  }
  return pairs;
}

function undRatio(perRow: ReturnType<typeof runComparison>['perRow']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of detectors) {
    const undCount = perRow.filter((r) => r.results[d.name] === '?' || r.results[d.name] === 'ERR').length;
    out[d.name] = Math.round((undCount / perRow.length) * 1000) / 10;
  }
  return out;
}

function distinctVerdicts(perRow: ReturnType<typeof runComparison>['perRow']): Record<string, Map<string, number>> {
  const out: Record<string, Map<string, number>> = {};
  for (const d of detectors) {
    const m = new Map<string, number>();
    for (const r of perRow) {
      const v = r.results[d.name]!;
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    out[d.name] = new Map([...m].sort((a, b) => b[1] - a[1]));
  }
  return out;
}

function renderReport(
  perRow: ReturnType<typeof runComparison>['perRow'],
  timings: Record<string, { ms: number; calls: number }>,
): string {
  const lines: string[] = [];
  lines.push('# Language detection — library comparison');
  lines.push('');
  lines.push(`Sample: first ${perRow.length} \`claim_review\` rows from the local index.`);
  lines.push('');

  lines.push('## Per-detector summary');
  lines.push('');
  lines.push('| detector | undefined % | mean latency µs/call | total calls |');
  lines.push('| --- | ---: | ---: | ---: |');
  const und = undRatio(perRow);
  for (const d of detectors) {
    const t = timings[d.name]!;
    const meanUs = Math.round((t.ms / t.calls) * 1000);
    lines.push(`| ${d.name} | ${und[d.name]} % | ${meanUs} µs | ${t.calls} |`);
  }
  lines.push('');

  lines.push('## Pair-wise agreement');
  lines.push('');
  lines.push('Percentage of rows where two detectors return the *same* non-undefined code.');
  lines.push('');
  lines.push('| pair | agreement |');
  lines.push('| --- | ---: |');
  const pairs = pairwiseAgreement(perRow);
  for (const [k, v] of Object.entries(pairs)) lines.push(`| ${k} | ${v} % |`);
  lines.push('');

  lines.push('## Top languages reported');
  lines.push('');
  const dist = distinctVerdicts(perRow);
  for (const d of detectors) {
    lines.push(`### ${d.name}`);
    lines.push('');
    lines.push('| code | count |');
    lines.push('| --- | ---: |');
    for (const [code, n] of [...dist[d.name]!].slice(0, 12)) lines.push(`| ${code} | ${n} |`);
    lines.push('');
  }

  lines.push('## Per-row results');
  lines.push('');
  lines.push('Only shows rows where the four detectors disagree, plus the URL/publisher for ground-truth eyeballing.');
  lines.push('');
  const header = `| id | stored | ${detectors.map((d) => d.name).join(' | ')} | text | publisher | url |`;
  const sep = `| --- | --- | ${detectors.map(() => '---').join(' | ')} | --- | --- | --- |`;
  lines.push(header);
  lines.push(sep);
  for (const r of perRow) {
    const vals = detectors.map((d) => r.results[d.name]!);
    const allSame = vals.every((v) => v === vals[0]);
    if (allSame) continue;
    lines.push(
      `| ${r.row.id} | ${r.row.stored_lang ?? '–'} | ${vals.join(' | ')} | ${truncate(
        r.row.claim_reviewed.replace(/\|/g, '\\|'),
        80,
      )} | ${r.row.publisher} | ${r.row.url} |`,
    );
  }
  lines.push('');

  lines.push('## All rows');
  lines.push('');
  lines.push(header);
  lines.push(sep);
  for (const r of perRow) {
    const vals = detectors.map((d) => r.results[d.name]!);
    lines.push(
      `| ${r.row.id} | ${r.row.stored_lang ?? '–'} | ${vals.join(' | ')} | ${truncate(
        r.row.claim_reviewed.replace(/\|/g, '\\|'),
        80,
      )} | ${r.row.publisher} | ${r.row.url} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

const SAMPLE = Number(process.env.SAMPLE ?? 100);
const rows = loadSample(SAMPLE);
const { perRow, timings } = runComparison(rows);
const report = renderReport(perRow, timings);
const outPath = resolve('experiment/language/report.md');
writeFileSync(outPath, report);

console.log(report);
console.error(`\nReport written to ${outPath}`);
