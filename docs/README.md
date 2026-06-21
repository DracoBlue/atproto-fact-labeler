# Documentation

The repo `README.md` is the entry point. This folder is the
operator + contributor reference, organised by what the labeler
*does*.

## Folders

- **[`pipeline/`](./pipeline/README.md)** — how a post becomes a
  verdict. One file per stage (extract → retrieve → rerank → NLI
  judge → aggregate) plus the cross-cutting same-language filter.
- **[`sources/`](./sources/README.md)** — where the fact-checks
  come from. Per-path operational reference (own ClaimReviews /
  Google Data Commons feed / Fact Check Tools API / atproto records)
  plus the publisher allowlist and per-path licensing.
- **[`triggers/`](./triggers/README.md)** — what makes a post land
  in the pipeline (mentions / reports / watchlist / firehose) plus
  the shared reply / quote-post layer.
- **[`adr/`](./adr/README.md)** — Architecture Decision Records.
  Permanent record of *why* the project is shaped the way it is —
  with the alternatives that were considered and rejected. Read
  when you want context, not for current operational state.
- **[`research/`](./research/README.md)** — literature passes that
  informed the design (peer-reviewed matching architecture, prior
  art in production fact-checking, atproto label landscape).

## Cross-cutting docs

- [`HOSTING.md`](./HOSTING.md) — operator handbook. Prerequisites,
  minimum-to-run, trigger example, full env-var reference, Bluesky
  registration via `@skyware/labeler`, DNS + reverse proxy, periodic
  re-ingest, lifecycle (pause / retire / clear), going-live
  checklist.
- [`KNOWN_LIMITATIONS.md`](./KNOWN_LIMITATIONS.md) — what the
  system measurably doesn't do yet, with evidence. Operator-facing.
- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — offline dev, fixtures,
  smoke test, commit conventions.
- [`feedback.md`](./feedback.md) — the feedback channel that
  receives label appeals and reports against the labeler's own
  posts; review CLIs, Telegram surfacing, resolved workflow.
