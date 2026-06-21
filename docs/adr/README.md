# Architecture Decision Records

Permanent records of *why* a particular shape was chosen, including
the alternatives that were considered and rejected. Each ADR carries a
`Status` line and a date; once accepted, its content does not change
(superseding ADRs are added alongside, not in place).

ADRs are referenced from the status-quo docs (pipeline / sources /
triggers) but kept separate so that the operational reference stays
crisp — "what is" lives in those docs, "why this shape" lives here.

## Current ADRs

- [`data-sources.md`](./data-sources.md) — why three intake paths and
  what was rejected (Fact-Check Insights, Common Crawl, direct
  crawling, OAuth on `claims:search`, per-publisher RSS).
- [`pipeline-three-stage-matching.md`](./pipeline-three-stage-matching.md)
  — why dense retrieve → rerank → NLI judge → polarity-aware
  aggregation, with the empirical evidence (Earth-flat /
  Earth-round) for each failure mode the design closes.
- [`model-choices.md`](./model-choices.md) — embedding / extraction
  / rerank / NLI model selection. Hybrid-vs-pure-local trade-off and
  the head-to-head benchmark that picked the deployed models.
- [`nli-judge-llm-not-mdeberta.md`](./nli-judge-llm-not-mdeberta.md)
  — empirical probe that rejected mDeBERTa as the Stage 4 backend;
  why LLM-as-judge stays the only supported path.

## Adding an ADR

A new ADR is warranted when:

- A meaningful design alternative was considered and rejected, and
  somebody six months from now is going to ask why.
- A revisit trigger exists (e.g. "reconsider when model X reaches
  Y F1") that deserves its own checkpoint.
- The decision involves a trade-off that the status-quo doc would
  otherwise have to keep re-explaining.

ADRs are *not* the place for current operational state — that
belongs in the relevant `pipeline/`, `sources/`, or `triggers/` doc.

Naming: `kebab-case.md`, no `ADR_` prefix needed (the folder is the
prefix). Status line at the top with date. Sections: `Context`,
`Decision`, `Consequences`, `Alternatives considered`.
