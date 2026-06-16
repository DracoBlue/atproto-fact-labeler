/**
 * CLI: bun run src/cli/ingest-claimreview.ts [path/to/data.json]
 */
import { getConfig } from '../config/index.ts';
import { ingestClaimReviewFeed } from '../ingest/claimreview-feed.ts';
import { getDbAsync } from '../store/db.ts';
import { logger } from '../util/logger.ts';

async function main(): Promise<void> {
  const cfg = getConfig();
  await getDbAsync();
  const feedPath = process.argv[2] ?? cfg.CLAIMREVIEW_FEED_PATH;
  const start = Date.now();
  const stats = await ingestClaimReviewFeed(feedPath);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info({ ...stats, elapsedSeconds: elapsed }, 'ingest completed');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'ingest crashed');
  process.exitCode = 1;
});
