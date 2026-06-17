# Component Design: Two-Level atproto Claim Labeler

> Implementation-oriented design study for the two levels defined in
> `ARCHITECTURE` (see project memory): **Level 1 — Claim Extraction** and
> **Level 2 — Claim Verification**. Compiled 2026-06-15 from a multi-source
> adversarially-verified research pass (23 sources, 98 claims extracted,
> 25 verified, **4 refuted** — see §6).

> **Scope update (2026-06):** the project consolidated to **one** atproto
> labeler with an **internal two-stage pipeline** (extract → verify). The
> sections below labelled "Level 1" and "Level 2" are now **Stages A and
> B of one pipeline** — same content, single service-DID, unified
> `fact-*` label vocabulary on the wire. See
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the runtime topology.
>
> Verification's *primary* path is reusing existing fact-checks via
> ClaimReview ([`SOURCES.md`](./SOURCES.md)); the AVeriTeC-style RAG
> pipeline below is the **fallback** (Stage S4) for novel claims, not the
> default path.

## TL;DR

- **Ingestion:** Use **Jetstream** (JSON/WebSocket, `wantedCollections=app.bsky.feed.post`)
  as the cheap primary feed (~96–99% smaller than the firehose). Keep
  `com.atproto.sync.subscribeRepos` (signed firehose) wired in as a
  re-verification path — Jetstream events are not self-authenticating and Bluesky
  explicitly discourages them for moderation/archival.
- **Label emission:** Implement `com.atproto.label.subscribeLabels` (WebSocket) +
  `com.atproto.label.queryLabels`. Lite stack uses a tiny `label-server`
  (SQLite + `@skyware/labeler`); Ozone path uses Ozone's built-in
  endpoints. See [`ARCHITECTURE.md §11`](./ARCHITECTURE.md).
- **Extraction (Stage A):** Treat **decomposition** and **decontextualization** as
  distinct, interacting design knobs (DnDScore, EMNLP 2025). Store atomic
  claims with the decontextualized form *plus* a span back to the post text.
- **Verification (Stage B):** **ClaimReview lookup first** — reuse existing
  fact-checks via Google Fact Check Tools API ([`SOURCES.md`](./SOURCES.md)).
  Only fall back to **Retrieve-and-Generate** RAG for novel claims that no
  publisher has already covered. When RAG runs, evidence is a first-class
  persisted artifact, scored jointly with the verdict (AVeriTeC pattern).
- **Local-model reality check:** `google/gemma-4-e2b` (current LM Studio model)
  is sized for extraction (Stage A). For the RAG fallback (Stage B / S4),
  consider a larger local model (Qwen3-14B class) or a hosted fallback.

---

## Shared Infrastructure

### A. Ingestion (input plane)

**Primary stream — Jetstream**
- Endpoint: `wss://jetstream*.us-{east,west}-*.bsky.network/subscribe`
- Filter: `wantedCollections=app.bsky.feed.post` (and any other collection of
  interest, e.g. `app.bsky.feed.like` if needed for engagement signals).
- Optional `wantedDids=` for per-account subscriptions.
- Payload: JSON, ~25–28 GB/month steady state (vs. firehose ~720 GB baseline,
  ~3.16 TB during surge events).
- Cursors: use the per-event `time_us` cursor to resume after disconnects.
- Sources: <https://docs.bsky.app/blog/jetstream>, <https://jazco.dev/2024/09/24/jetstream/>

**Authoritative stream — signed firehose**
- Endpoint: `com.atproto.sync.subscribeRepos`
- Payload: CBOR + MST nodes + repo signatures.
- Use cases: (a) re-verifying any post the system is about to publish a label
  for, (b) backfill from a Relay, (c) cross-checking that a Jetstream record
  matches what the PDS actually signed.
- Source: <https://docs.bsky.app/docs/advanced-guides/firehose>

**Component shape**
- One long-lived WebSocket worker per stream, supervised with reconnect +
  backoff + cursor persistence.
- Dedup by `(repo, collection, rkey, cid)`; an idempotency key for the pipeline.
- Backfill / replay: keep raw events in a durable log (Kafka / NATS / Postgres
  append-only) for re-processing when extraction/verification logic changes.

### B. Pipeline & storage

**Queue / workers**
- Two independent worker pools (one per level) consuming from a durable queue.
- Each unit of work is keyed by a stable hash (post URI for extraction; claim
  ID for verification) so retries and re-runs are idempotent.

**Records (suggested model)**
- `post` — minimal cache of `{uri, cid, did, text, lang, indexedAt}` for posts
  the system has touched.
- `claim` — `{id, post_uri, atomic_text, decontextualized_text, span,
  entities[], lang, extractor_version, extracted_at, confidence,
  status: proposed|accepted|rejected}`.
- `verdict` — `{id, claim_id, label: true|false|unknown|disputed, valid_at,
  verified_at, verifier_id, evidence_ids[], confidence, rationale,
  status: proposed|accepted|rejected|superseded}`.
- `evidence` — `{id, source_url, snippet, retrieved_at, retrieval_method,
  score}` — **persisted, not transient** (AVeriTeC-style evaluation requires
  it; see §3).
- `label_emit` — projection of `(post, accepted claims, current verdicts)` →
  what the labeler actually streams over `subscribeLabels`.

### C. Output (label emission)

- Implement `com.atproto.label.subscribeLabels` and `queryLabels` per the
  Bluesky moderation architecture.
- **Reuse Ozone** as the moderator console; Ozone covers report intake, label
  publishing, team workflows, escalations, and templates — the HITL surface for
  both levels can be modeled as Ozone "teams" with distinct label vocabularies.
- Label projection logic: when a claim's accepted verdict changes
  (`valid_at` ticks, new evidence supersedes prior verdict), recompute and
  emit a delta over the labels subscription.
- Sources: <https://docs.bsky.app/blog/blueskys-moderation-architecture>,
  <https://github.com/bluesky-social/ozone>

---

## Stage A — Claim Extraction (was "Level 1")

### 1.1 Component

- Input: a `post` record (or batch).
- Pre-filter: language detect (`fasttext-langdetect` or similar), content-type
  heuristics — drop pure boost/share, drop replies-without-substance, drop
  empty/media-only posts (or route them to a separate vision-extraction lane).
- Worker: LLM call (structured output) → list of claim candidates.
- Post-process: dedupe within post, attach entity links, ground spans, write
  `claim` records with `status=proposed`.
- HITL queue: any candidate below a confidence threshold goes to a review
  queue; the rest auto-accept (configurable).

### 1.2 AI support

**Decomposition vs. decontextualization (key design decision)**
- These are **two distinct knobs**, and the combination materially changes
  downstream factuality scores. (DnDScore, EMNLP 2025 main, paper 1205.)
- Recommendation: produce **both** an atomic-claim string *and* a
  decontextualized standalone version, and store both. Verify against the
  decontextualized form; show the atomic form (with span) to humans.
- Source: <https://aclanthology.org/2025.emnlp-main.1205.pdf>

**Structured output**
- Drive the LLM with a JSON Schema; LM Studio supports OpenAI-compatible
  `response_format: { type: "json_schema", ... }`. Minimal schema fields:
  `atomic_text`, `decontextualized_text`, `span: {start, end}`,
  `is_falsifiable: bool`, `is_hypothetical: bool`, `entities: [{surface, qid?}]`,
  `lang`, `confidence`.

**Entity linking**
- Lightweight option: `spaCy` + `spacyfishing` or `BLINK` for English; for
  multilingual use `mGENRE` or call **Wikidata wbsearchentities** with the
  surface form.
- Defer hard cases (no QID match, multiple high-score candidates) to HITL.

**Handling quotes / sarcasm / hypotheticals / questions**
- Prompt explicitly with negative examples ("the post quotes someone else",
  "the post asks a question rather than asserting"). DnDScore-style
  conservative atomicity reduces false positives more than aggressive
  decomposition.
- Set `is_falsifiable: false` for questions/hypotheticals; they remain
  catalogued but don't flow into verification.

**Single-pass alternative**
- VeriFastScore-style combined extract+verify (Llama-3.1-8B fine-tune) is
  ~6.6× faster than a strict pipeline, but **sacrifices auditability** and
  the ability to run HITL between levels. Keep as a future batch optimization,
  not the default.
- Source: <https://arxiv.org/html/2505.16973v3>

**Local-model feasibility (gemma-4-e2b via LM Studio)**
- gemma-class small models can do English extraction acceptably with strict
  schema + few-shot. Quality drops sharply on (a) long posts, (b) non-English,
  (c) sarcasm. Expect to need explicit examples in the prompt for each
  edge category.
- Plan an evaluation harness early — see §5 open questions.

### 1.3 Human-in-the-loop

**Reviewer UI requirements**
- Show post text with extracted spans highlighted.
- For each proposed claim: atomic text, decontextualized text, entities,
  confidence — with accept / edit / reject actions.
- Bulk-accept for high-confidence batches; single-claim mode for edits.

**Active-learning sampling**
- Surface low-confidence extractions, disagreements between two extractor runs
  (e.g. different temperatures or different prompts), and posts where entity
  linking failed. Full Fact's customisation of Prodigy documents exactly this
  pattern.
- Source: <https://fullfact.org/blog/2018/feb/how-we-customised-prodigy-ai/>

**Inter-annotator agreement**
- Track Cohen's κ between any two reviewers seeing the same post; periodically
  sample double-annotated posts. Use disagreements to revise the labeling
  guideline.

**Tools to evaluate** *(named in research question, not surfaced with verified
claims this pass — TODO to confirm fit)*:
Prodigy, Argilla, Label Studio, doccano.

### 1.4 Prior systems

- **Full Fact (Prodigy customisation, 2018)** — concrete write-up of how a
  fact-check newsroom built an extraction pipeline with HITL.
  <https://fullfact.org/blog/2018/feb/how-we-customised-prodigy-ai/>
- **ClaimBuster** — claim-detection scoring (check-worthiness) on political
  speech; reference for an upstream filter before atomic decomposition.
  *(Not deeply surveyed this pass.)*
- **VeriFastScore, DnDScore, Molecular Facts** — current research baselines
  for decomposition design.

---

## Stage B — Claim Verification (was "Level 2")

> **Critical reframing:** verification is now **ClaimReview-lookup first,
> RAG-fallback second**. The RAG architecture below describes the fallback
> path (Stage S4 per [`ARCHITECTURE.md §3`](./ARCHITECTURE.md)) — what we
> do when no publisher has already covered the claim. The lookup path
> (Stages S2–S3) lives in [`SOURCES.md`](./SOURCES.md).

### 2.1 Component

- Input: a `claim` record with `status=accepted`.
- Retriever: embedding search over a corpus + optional live web search.
- Reasoner: LLM (or NLI model) → `{verdict, rationale, evidence_refs[],
  confidence, valid_at}`.
- Output: `verdict` record with `status=proposed`, evidence persisted.
- HITL queue: low-confidence and/or low-evidence-quality verdicts → human
  review; high-confidence high-evidence-quality verdicts can auto-accept
  (configurable per claim category).

### 2.2 AI support — Retrieve-and-Generate

**Architecture (FEVER-8 2025 winning stack — AIC CTU, Ev2R 0.48)**
- Embeddings: **`mxbai-embed-large-v1`** (1024-dim).
- Chunking: ~2048 chars; retrieve top-k.
- Vector store: **FAISS** (in-process) or **Qdrant** (server).
- Generator: **Qwen3-14B** via **Ollama** / llama.cpp.
- Hardware: single Nvidia A10 (23 GB VRAM), ~60s/claim.
- Source: <https://arxiv.org/html/2508.04390>
- **Caveat:** the "two-step RAG alone is sufficient for SOTA" claim was
  **refuted** in adversarial verification — Ev2R 0.48 is a modest absolute
  number. Treat the recipe as a strong baseline, not a finish line.

**Knowledge sources to index**
- **Wikidata** (entities, dates, deaths, offices held — handles "is X dead").
- **ClaimReview / Google Data Commons fact-check feed** — see RESEARCH.md §3.
- **Wikipedia** snapshots for general world knowledge.
- **News corpus** — pick one of GDELT, Common Crawl News, or licensed feed.
- **Live web search** as a fallback (Brave/SerpAPI/Bing) — gated because
  costs/non-determinism complicate audit.

**Verdict prediction**
- LLM-as-judge with explicit verdict vocabulary
  `{supported, refuted, not_enough_evidence, conflicting}` (mirrors AVeriTeC)
  → map to our `{true, false, unknown, disputed}`.
- Alternative: lightweight NLI head (e.g. DeBERTa-v3-large-mnli) on
  claim ⊨ evidence — useful as a cheap second opinion / disagreement signal.
- Source: <https://aclanthology.org/2024.fever-1.1/>

**Time-aware reasoning (`valid_at`)**
- Always include the evidence's own date in the prompt; require the model to
  emit `valid_at`.
- For time-sensitive claims ("X is dead", "X is president of Y"), explicitly
  prompt for "as of when is this true?"
- When evidence and claim timestamps disagree by > threshold, route to HITL.

**Evidence quality is a first-class concern**
- AVeriTeC counts a claim as verified only when the verdict is correct **and**
  retrieved evidence passes a quality threshold (Hungarian METEOR Q+A ≥ 0.25).
- Implication: persist ranked evidence with provenance and surface
  evidence-quality estimates next to verdict confidence.
- Source: <https://arxiv.org/pdf/2410.23850>

**Uncertainty / hallucination mitigation**
- Two-pass cross-check: re-run with shuffled evidence order and accept only on
  agreement.
- Force evidence-citing rationale; reject rationales that quote text not in
  the retrieved evidence pool.

**Local-model feasibility (gemma-4-e2b)**
- A 2B-class model is below the operating point of every cited verification
  pipeline. Plausible options, ranked:
  1. Use gemma for extraction only; deploy a 7–14B local model
     (Qwen3-14B / Llama-3.1-8B / Mistral-Nemo) for verification.
  2. Use gemma to draft a verdict, but require evidence-grounded human
     confirmation before emitting any label.
  3. Hosted-API fallback for the verification step.
- Don't ship gemma-only verification without an eval against AVeriTeC dev or
  a custom set.

### 2.3 Human-in-the-loop

**Reviewer UI requirements**
- Side-by-side: claim (atomic + decontextualized) | suggested verdict |
  ranked evidence snippets with source links | rationale.
- Quick actions: confirm, override verdict, edit `valid_at`, add evidence,
  reject (and tag reason).
- Audit log of every transition.

**Escalation rules (fire HITL when any holds)**
- Verdict confidence below threshold T_v.
- Evidence-quality estimate below threshold T_e (even if verdict confidence
  is high — see AVeriTeC).
- Evidence sources contradict each other.
- Claim category in a high-stakes list (health, elections, named individuals).
- Time-sensitive `valid_at` within last N days.

**Multi-reviewer consensus / quorum**
- Default: 1 reviewer for low-stakes, 2-of-3 quorum for high-stakes claims.
- Expert verifier roles for specific domains (medicine, law, finance).
- Pattern reference: **Community Notes / Birdwatch** uses a bridging-algorithm
  that requires agreement across reviewers with normally-divergent rating
  patterns — applicable as a future enhancement to dampen partisan capture.
  <https://en.wikipedia.org/wiki/Birdwatch_(fact_checker)>

**Audit log**
- Every verdict change writes a superseding record; we never destroy history.
  This is also what makes `valid_at` meaningful — old verdicts remain queryable
  as of their `verified_at`.

### 2.4 Prior systems

- **AVeriTeC** (FEVER 2024 shared task) — closest benchmark; same verdict
  vocabulary, real fact-checker claims, joint retrieval + verdict scoring.
  <https://aclanthology.org/2024.fever-1.1/>, <https://arxiv.org/pdf/2410.23850>
- **AIC CTU @ FEVER 8 (Aug 2025)** — winning RAG recipe.
  <https://arxiv.org/html/2508.04390>
- **VeriFastScore** — combined single-pass extract+verify (optimization
  reference). <https://arxiv.org/html/2505.16973v3>
- **Community Notes / Birdwatch** — bridging-based consensus pattern for HITL.
- **Survey:** RAG for fact-checking. <https://arxiv.org/pdf/2408.12060>
- *Named but not deeply surveyed this pass — TODO:* Factiverse, Originality.ai,
  ClaimReview producers' internal pipelines, MultiVerS, ProoFVer.

---

## 5. Open questions

1. **Smallest viable verifier** — does `gemma-4-e2b` give acceptable AVeriTeC
   numbers? If not, is the right step a local 7–14B model, or a hosted fallback?
2. **HITL on Ozone vs. standalone** — is Ozone extensible enough to host the
   extraction reviewer UI, or do we run Argilla / Label Studio alongside and
   only use Ozone for the label-publishing stage?
3. **Knowledge base composition** — Wikidata + ClaimReview + Wikipedia
   + news, and how to handle freshness when claim and evidence have different
   timestamps?
4. **Wire format for "disputed"** — single label with a confidence/severity,
   multiple competing labels, or a separate dispute record referenced from the
   label?

## 6. Refuted claims (do **not** assume these)

These were named in cited sources but failed adversarial verification this pass:

1. ❌ "A two-stage Llama-3.1-8B fine-tune is sufficient for combined
   extract+verify." (1-2 vote; <https://arxiv.org/html/2505.16973v3>)
2. ❌ "A two-step RAG pipeline alone is sufficient for SOTA on-premise
   fact-checking." (0-3 vote; <https://arxiv.org/html/2508.04390>)
3. ❌ "Multi-hop iterative question generation outperforms single-shot by .155
   AVeriTeC score." (1-2 vote; <https://arxiv.org/html/2411.05762>)
4. ❌ "Reasoning over one retrieved document at a time is a critical design
   choice for verification accuracy." (0-3 vote; same source)

## 7. Caveats

- Quantitative Jetstream bandwidth numbers (3.16 TB/month) reflect Brazil-surge
  rates, not steady-state — baseline is ~720 GB/month.
- The local gemma-4-e2b model is much smaller than the 8–14B models in the
  verification literature; verification quality will likely be the bottleneck.
- HITL tooling (Prodigy / Argilla / Label Studio / doccano) and several prior
  systems (ClaimBuster, Factiverse, MultiVerS, ProoFVer) were named in the
  research question but did not surface verified claims in this pass — treat
  their inclusion as TODO.
- atproto lexicons evolve; pin a version (label spec sig/exp fields were
  added in 2024).

## 8. Sources

| URL | Quality | Angle |
| --- | --- | --- |
| <https://docs.bsky.app/blog/jetstream> | primary | ingestion |
| <https://jazco.dev/2024/09/24/jetstream/> | primary | ingestion |
| <https://docs.bsky.app/docs/advanced-guides/firehose> | primary | ingestion |
| <https://docs.bsky.app/blog/blueskys-moderation-architecture> | primary | label emit |
| <https://github.com/bluesky-social/ozone> | primary | label emit / HITL |
| <https://aclanthology.org/2025.emnlp-main.1205.pdf> | primary | extraction (DnDScore) |
| <https://arxiv.org/html/2505.16973v3> | primary | extraction (VeriFastScore) |
| <https://arxiv.org/pdf/2502.08909> | primary | extraction |
| <https://aclanthology.org/2024.fever-1.1/> | primary | verification (AVeriTeC overview) |
| <https://arxiv.org/pdf/2410.23850> | primary | verification (AVeriTeC eval) |
| <https://arxiv.org/html/2508.04390> | primary | verification (AIC CTU stack) |
| <https://arxiv.org/html/2411.05762> | primary | verification (multi-hop) |
| <https://arxiv.org/pdf/2408.12060> | primary | RAG for fact-checking survey |
| <https://www.researchgate.net/publication/386182599_AIC_CTU_system_at_AVeriTeC_Re-framing_automated_fact-checking_as_a_simple_RAG_task> | primary | verification |
| <https://arxiv.org/pdf/2412.02868> | primary | small-model feasibility |
| <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12079058/> | primary | small-model feasibility |
| <https://arxiv.org/pdf/2508.03860> | primary | small-model feasibility |
| <https://arxiv.org/abs/2104.07175> | primary | HITL |
| <https://en.wikipedia.org/wiki/Birdwatch_(fact_checker)> | secondary | HITL (Community Notes) |
| <https://fullfact.org/blog/2018/feb/how-we-customised-prodigy-ai/> | primary | HITL (Full Fact / Prodigy) |
| <https://arxiv.org/pdf/1809.08193> | primary | HITL |
