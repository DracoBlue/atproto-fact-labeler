# Research artefacts

Background and literature passes that informed design decisions. Not
operational reference — for that, see [`../pipeline/`](../pipeline/README.md),
[`../sources/`](../sources/README.md), or [`../triggers/`](../triggers/README.md).

- [`matching.md`](./matching.md) — peer-reviewed evidence for the
  retrieve → rerank → NLI shape. Comparison tables, citation graph,
  empirical numbers from FEVER 2024 / FACT-GPT / AVeriTeC / SK_DU.
- [`prior-art.md`](./prior-art.md) — production fact-checking
  literature (Meedan Alegre, Full Fact, Argilla / Ozone HITL tooling)
  and how their patterns map to (or differ from) this project.
- [`atproto-label-landscape.md`](./atproto-label-landscape.md) —
  atproto label surfaces, what already exists in the moderation
  space, and where ClaimReview-shaped records would slot in.

Status-quo docs (under `pipeline/`, `sources/`, `triggers/`) cite
back to these for citations and benchmark numbers. ADRs (under
[`../adr/`](../adr/README.md)) cite them for empirical justification.
