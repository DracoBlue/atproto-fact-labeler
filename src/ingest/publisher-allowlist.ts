/**
 * Allowlist of trusted ClaimReview publisher hostnames.
 *
 * The Google Data Commons feed mixes IFCN-tier fact-checkers with spam blogs,
 * SEO sites, gambling, and one XSS injection attempt observed in production.
 * We only ingest entries whose `author.url` hostname matches this list.
 */
import { readFileSync, existsSync } from 'node:fs';

export class PublisherAllowlist {
  private readonly exact = new Set<string>();
  private readonly suffix: string[] = [];

  constructor(lines: Iterable<string>) {
    for (const raw of lines) {
      const line = raw.replace(/#.*$/, '').trim().toLowerCase();
      if (!line) continue;
      if (line.startsWith('*.')) {
        const rest = line.slice(1);
        this.suffix.push(rest);
        this.exact.add(rest.slice(1));
      } else {
        this.exact.add(line);
      }
    }
  }

  static fromFile(path: string): PublisherAllowlist {
    const txt = readFileSync(path, 'utf8');
    return new PublisherAllowlist(txt.split('\n'));
  }

  static fromFileOrEmpty(path: string): PublisherAllowlist {
    if (!existsSync(path)) return new PublisherAllowlist([]);
    return PublisherAllowlist.fromFile(path);
  }

  get size(): number {
    return this.exact.size + this.suffix.length;
  }

  isAllowedHost(host: string | null | undefined): boolean {
    if (!host) return false;
    const h = host.toLowerCase().replace(/^www\./, '');
    if (this.exact.has(h)) return true;
    for (const s of this.suffix) if (h.endsWith(s)) return true;
    return false;
  }

  isAllowedUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    try {
      return this.isAllowedHost(new URL(url).hostname);
    } catch {
      return false;
    }
  }
}
