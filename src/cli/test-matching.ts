/**
 * pnpm test:matching
 *
 * Runs every case in test/fixtures/matching-cases.json through the Stage 2-5
 * pipeline (retrieve → entail → match) against the live SQLite index and
 * the configured LLM endpoint. Prints a pass/fail report and exits non-zero
 * on regression.
 *
 * This is the "polarity matrix" gate referenced in docs/pipeline/README.md §
 * "Test-set / CI gate". Not part of `pnpm test` — it needs LM Studio
 * running, a populated index with embeddings, and ~15 min wall clock for
 * the full set on M3 Max.
 *
 * Flags:
 *   --filter <substring>   Run only cases whose claim or category matches
 *   --top <n>              Override Stage 2 topK (default 8)
 *   --min-cosine <n>       Override Stage 2 minCosine floor (default 0.55)
 *   --json                 Emit JSON-only report (for CI ingest)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getDbAsync, closeDb } from '../store/db.ts';
import { matchClaim, type MatchingResult } from '../pipeline/matching.ts';

interface TestCase {
  claim: string;
  expected_verdict: 'true' | 'false' | 'mixed' | 'unknown' | 'disputed' | 'outdated' | 'uncovered';
  min_confidence?: number;
  category: string;
  notes?: string;
  /** BCP-47 lang of the claim. Defaults to 'en' since the fixture is English. */
  lang?: string;
}

interface CaseResult {
  case: TestCase;
  outcome: 'pass' | 'fail';
  actualVerdict: string;
  actualConfidence: number | null;
  match: MatchingResult;
  elapsedMs: number;
  reason?: string;
}

interface CliArgs {
  filter: string | null;
  topK: number;
  minCosine: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { filter: null, topK: 8, minCosine: 0.55, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') out.filter = argv[++i] ?? null;
    else if (a === '--top') out.topK = Math.max(1, Number(argv[++i] ?? '8'));
    else if (a === '--min-cosine') out.minCosine = Number(argv[++i] ?? '0.55');
    else if (a === '--json') out.json = true;
  }
  return out;
}

function evaluate(c: TestCase, m: MatchingResult): { outcome: 'pass' | 'fail'; reason?: string } {
  const actualVerdict = m.aggregated?.verdict ?? 'uncovered';
  if (actualVerdict !== c.expected_verdict) {
    return {
      outcome: 'fail',
      reason: `verdict mismatch — expected ${c.expected_verdict}, got ${actualVerdict}`,
    };
  }
  if (c.min_confidence != null && m.aggregated != null) {
    if (m.aggregated.confidence < c.min_confidence) {
      return {
        outcome: 'fail',
        reason: `confidence ${m.aggregated.confidence.toFixed(3)} below min ${c.min_confidence}`,
      };
    }
  }
  return { outcome: 'pass' };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const fixturePath = resolve('test/fixtures/matching-cases.json');
  const allCases = JSON.parse(readFileSync(fixturePath, 'utf8')) as TestCase[];
  const cases = args.filter
    ? allCases.filter(
        (c) =>
          c.claim.toLowerCase().includes(args.filter!.toLowerCase()) ||
          c.category.toLowerCase().includes(args.filter!.toLowerCase()),
      )
    : allCases;

  if (!cases.length) {
    process.stderr.write(`no cases match filter ${JSON.stringify(args.filter)}\n`);
    process.exit(1);
  }

  await getDbAsync();

  if (!args.json) {
    process.stderr.write(
      `running ${cases.length} matching case(s) with topK=${args.topK} minCosine=${args.minCosine}\n` +
        `expect ~1m per case against qwen3-class NLI judge.\n\n`,
    );
  }

  const results: CaseResult[] = [];
  const tStart = Date.now();
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    if (!args.json) {
      process.stderr.write(`[${i + 1}/${cases.length}] ${c.claim}\n`);
    }
    const t0 = Date.now();
    const match = await matchClaim(c.claim, {
      topK: args.topK,
      minCosine: args.minCosine,
      lang: c.lang ?? 'en',
    });
    const elapsedMs = Date.now() - t0;
    const evalResult = evaluate(c, match);
    const actualVerdict = match.aggregated?.verdict ?? 'uncovered';
    const actualConfidence = match.aggregated?.confidence ?? null;
    results.push({
      case: c,
      outcome: evalResult.outcome,
      actualVerdict,
      actualConfidence,
      match,
      elapsedMs,
      reason: evalResult.reason,
    });
    if (!args.json) {
      const mark = evalResult.outcome === 'pass' ? '✓' : '✗';
      const confStr = actualConfidence == null ? '-' : actualConfidence.toFixed(3);
      process.stderr.write(
        `  ${mark} ${evalResult.outcome.toUpperCase()} — verdict=${actualVerdict} conf=${confStr}` +
          ` (retrieved=${match.retrieved} reranked=${match.reranked} entail=${match.entailed} contradict=${match.contradicted} neutral=${match.neutral})` +
          ` [${(elapsedMs / 1000).toFixed(1)}s]\n`,
      );
      if (evalResult.outcome === 'fail') {
        process.stderr.write(`    reason: ${evalResult.reason}\n`);
      }
    }
  }
  closeDb();

  const totalElapsedMs = Date.now() - tStart;
  const passes = results.filter((r) => r.outcome === 'pass').length;
  const fails = results.length - passes;

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          summary: { total: results.length, passes, fails, elapsedMs: totalElapsedMs },
          cases: results.map((r) => ({
            claim: r.case.claim,
            category: r.case.category,
            outcome: r.outcome,
            expectedVerdict: r.case.expected_verdict,
            actualVerdict: r.actualVerdict,
            actualConfidence: r.actualConfidence,
            elapsedMs: r.elapsedMs,
            reason: r.reason,
            retrieved: r.match.retrieved,
            reranked: r.match.reranked,
            entailed: r.match.entailed,
            contradicted: r.match.contradicted,
            neutral: r.match.neutral,
          })),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stderr.write(
      `\n${passes}/${results.length} passed, ${fails} failed in ${(totalElapsedMs / 1000).toFixed(1)}s\n`,
    );
    if (fails > 0) {
      process.stderr.write('\nfailures:\n');
      for (const r of results.filter((r) => r.outcome === 'fail')) {
        process.stderr.write(
          `  - "${r.case.claim}" (${r.case.category})\n    ${r.reason}\n`,
        );
      }
    }
  }

  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`test-matching failed: ${(err as Error).message}\n`);
  process.exit(2);
});
