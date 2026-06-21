# Prior Art: Fact-Checking Systems & HITL Tooling

> Companion to [`PIPELINE.md`](./pipeline/README.md) and
> [`RESEARCH-MATCHING.md`](./RESEARCH-MATCHING.md). Where those two cover
> the *matching* problem this labeler solves today, this document covers
> the wider landscape: previously-built fact-checking pipelines and the
> annotation tools that would slot in for a human-in-the-loop reviewer
> queue. Use it to (a) understand what the published literature has
> already solved, (b) decide which patterns to graft on as the project
> grows, (c) avoid reinventing tooling.
>
> Compiled from three adversarial-verification research passes
> (≈ 65 sources, ≈ 75 verified findings, 1 refuted).

## TL;DR

- **For matching today** — see [`RESEARCH-MATCHING.md`](./RESEARCH-MATCHING.md).
  This file covers everything else.
- **HITL reviewer queue, when we need one**: pair
  **Argilla** (extraction review — schema-flexible, Krippendorff's α,
  multi-reviewer overlap modes) with **Ozone** (verification review +
  label emission — it is the atproto-canonical labeler console and the
  UI/backend split lets us keep our own engine). Wrap LLM calls in
  **Autolabel**-style confidence routing so high-confidence cases auto-accept
  and low-confidence ones queue.
- **Pipeline patterns worth stealing**:
  - **ClaimBuster** (VLDB 2017) — 5-stage architecture (Monitor / Spotter
    / Matcher / Checker / Reporter) with hybrid lexical + semantic matcher.
    Still the canonical reference.
  - **ProoFVer** (TACL 2022) — *faithful-by-construction* verdicts: the
    output IS the proof. Rationale and verdict cannot disagree.
  - **AVeriTeC 2024/2025** — joint evidence-quality + verdict scoring.
    Adopt the joint metric so we never grade an "unsupported but confident"
    verdict as a hit.
  - **Loki / OpenFactVerification** (MIT, LM-Studio-compatible) —
    closest off-the-shelf engine match to our architecture; 5 modular
    stages each with its own LLM client.
- **AVeriTeC system-paper steals catalogue** — see § AVeriTeC patterns.
  Likert-scale LLM confidence, MMR reranking, HyDE expansion, iterative
  QG, evidence summarisation, cosine-NEI short-circuit. All independently
  measured to help.
- **Community Notes bridging algorithm** — `noteIntercept = µ + i_u + i_n +
  f_u·f_n`. Could power a reviewer-disagreement-bridging score if we ever
  have multiple HITL reviewers; not blocking for v1.

## HITL annotation tooling

The labeler is fully automated today (operator IS the reviewer when
running `pnpm cli:label`). When we add a true HITL reviewer queue —
either for noisy mention triage or for crowd-sourced claim proposals —
the candidate tools are mature and well-differentiated.

### Argilla (OSS, Apache 2.0)

- **Schema flexibility**: Feedback datasets accept structured records
  with custom question/field types — claim records (atomic text,
  decontextualised text, span, entities, confidence) fit naturally.
- **Pre-annotation**: Python SDK; programmatic record + suggestion writes.
- **Multi-reviewer / IAA**: primary metric **Krippendorff's α** with
  documented thresholds (≥ 0.8 reliable, ≥ 0.667 tentative). v1.29+ /
  2.x add Cohen's κ and Fleiss' κ. Three overlap strategies — *full*,
  *zero*, *controlled*.
- **Audit log**: record-level history of suggestions, responses, status.
- **Ozone integration**: none built-in — would be a custom bridge
  (Argilla webhooks → Ozone API).

Sources:
- <https://docs.v1.argilla.io/en/latest/reference/python/python_annotation_metrics.html>
- <https://docs.v1.argilla.io/en/v1.12.0/guides/llms/practical_guides/set_up_annotation_team.html>

### Prodigy (Explosion AI, commercial)

- Per-seat licence; self-hosted only.
- Recipe-driven; model-in-the-loop is the core pitch — first-class
  active learning with uncertainty-based recipes shipped.
- IAA: deliberately **excludes Cohen's κ**; implements **Percent
  Agreement**, **Krippendorff's α**, **Gwet's AC2**. Multi-reviewer
  plumbing via automatic `_annotator_id` and `_input_hash` grouping.
- **Notable user**: Full Fact's customised pipeline (2018 write-up).

Source: <https://prodi.gy/docs/metrics>

### Label Studio (Heartex, OSS + Cloud)

- Community edition Apache 2.0; XML-based labeling config; broad task
  coverage (text, image, video, time series).
- ML backend API for predictions; SDK for bulk import.
- IAA: consensus mode + Cohen's / Fleiss' κ per public guidance.

Treat the above as directional — research process did not surface
primary-source claims beyond the κ video; validate against current docs
before committing.

### doccano (OSS, MIT)

Simple Django-based annotation server. Good for early bootstrap;
weak pre-annotation story and limited multi-reviewer / IAA tooling.
Not a long-term home for a two-level pipeline.

### Autolabel (Refuel AI, OSS MIT)

- Python library for **programmatic LLM pre-annotation** across OpenAI /
  Anthropic / HuggingFace / Google.
- Built-in per-label confidence + explanations; documented HITL pattern
  of *routing low-confidence labels to humans*.
- **No bundled reviewer UI** — that's Refuel's commercial product.
  Slots in *upstream* of Argilla/Ozone as the LLM-call layer.
- Source: <https://github.com/refuel-ai/autolabel>

### Recommendation matrix

| Use case | Pick | Why |
| --- | --- | --- |
| LLM pre-annotation in code | **Autolabel** | MIT, programmatic, confidence routing |
| Extraction reviewer UI | **Argilla** | OSS, schema-flexible, α + overlap modes, SDK |
| Verification reviewer UI | **Ozone** (extended) | already canonical for atproto labels |
| Label emission to Bluesky | **Ozone backend or custom** implementing `subscribeLabels` / `queryLabels` (we use `@skyware/labeler` today) |
| Bootstrap / early prototype | **doccano** | simplest, throw-away |
| Fact-check newsroom adjacency | **Prodigy** | model-in-the-loop is its DNA; Full Fact precedent |

**Ozone vs. dedicated tool — decision**: run both. Ozone is decoupled
(Next.js UI ↔ separate labeling-service backend implementing the atproto
label endpoints), so we can:

1. Use Ozone for **label publishing + verification review** — it knows
   `subscribeLabels` / `queryLabels`, custom-label metadata, severity,
   blur, `defaultSetting`, localisation.
2. Run **Argilla alongside** for the extraction-review queue — claim
   records have richer custom structure than Ozone's report/label model.
3. Bridge with a small service: extraction-accepted claims → verification
   queue (Ozone) → emitted labels.

Sources for the Ozone side:
- <https://github.com/bluesky-social/ozone>
- <https://docs.bsky.app/blog/blueskys-moderation-architecture>

## Pipeline patterns from the literature

### ClaimBuster (UT Arlington, VLDB 2017)

End-to-end pipeline (claim detection → matching → verification reporting),
canonical reference cited in the field's surveys.

1. **Claim Monitor** — ingests live text streams.
2. **Claim Spotter** — check-worthiness score 0.0–1.0. Original: SVM on
   ~28k human-coded debate sentences with token + POS features
   (74 % recall / 79 % precision). Newer versions: transformer +
   adversarial training (arXiv 2002.07725).
3. **Claim Matcher** — *hybrid lexical (Elasticsearch) + semantic
   (Semilar)*, results merged.
4. **Claim Checker** — Wolfram Alpha + web queries when no prior match.
5. **Fact-check Reporter** — surfaces matched / generated reports.

**What to steal**: the **hybrid matcher**. In 2026 substitute the dated
Semilar with `BAAI/bge-m3` / `granite-278m-multilingual` and ES with a
modern vector store. We already do dense-only retrieval in `retrieve.ts`;
adding a sparse + dense hybrid is a documented next step (see
PIPELINE.md § Future extensions).

Sources:
- <https://vldb.org/pvldb/vol10/p1945-li.pdf>
- <https://arxiv.org/abs/2109.11427> (Guo et al. survey context)
- Active deployment: <https://idir.uta.edu/claimbuster/>

### ProoFVer (Krishna et al., TACL 2022)

A seq2seq verifier that emits a **natural-logic proof** — lexical
mutations between claim and evidence spans annotated with NL operators
(equivalence, forward / backward entailment, negation, alternation,
cover, independence). **The verdict is determined solely by the operator
sequence**, not by a separate classifier head.

**What to steal**: *faithful-by-construction verdicts*. If the verifier
emits a structured proof and the verdict is a deterministic function of
that proof, **the rationale cannot lie about the verdict** — strong
property for HITL audit and end-user explanations of `disputed` labels.

No deployed service. NL-operator training data is expensive. But the
property is gold-standard for trust.

Source: <https://aclanthology.org/2022.tacl-1.59/>

### AVeriTeC shared task (FEVER 2024 & 2025)

Real-world claim verification with retrieval; verdict vocabulary
`{supported, refuted, not_enough_evidence, conflicting}`.

**Joint evaluation metric**: retrieval evidence scored by Q+A Hungarian
METEOR ≥ 0.25 as a gate; verdict accuracy is counted **only above the
gate**. Below-gate → score 0 regardless of verdict.

| Year | Winner | Score | Constraints |
| --- | --- | --- | --- |
| 2024 | TUDA_MAI (InFact) | 63 % | GPT-4o allowed |
| 2025 | CTU AIC | 33.17 % | open-weights only, single 23 GB GPU, ≤ 1 min/claim, precompiled KB |

> Don't naively compare absolute scores across years — the 2025 envelope
> is materially harder.

**What to steal**:
1. The **joint metric** — apply Q+A METEOR (or equivalent) so we never
   grade an "unsupported but confident" verdict as a hit.
2. The **operating envelope** — design for single-GPU open-weights from
   day one.

Sources:
- <https://aclanthology.org/2024.fever-1.1/>
- <https://aclanthology.org/2025.fever-1.15/>
- <https://arxiv.org/abs/2410.23850>
- HerO (open-weights reference): <https://github.com/ssu-humane/HerO>

### FEVER ecosystem

FEVER (Thorne et al. 2018) bootstrapped the modern claim-verification
literature with synthetic claims and Wikipedia evidence. Classic
pipelines: DOMLIN, KGAT, CorefBERT. **AVeriTeC supersedes FEVER for
real-world claims** — treat FEVER as the synthetic-benchmark predecessor
and bootstrap-data source.

- AVeriTeC dataset: <https://arxiv.org/abs/2210.15723>
- Multi-domain extension: <https://arxiv.org/abs/1910.09796>

## Full Fact AI — public vs. internal

The flagship Full Fact tooling is **commercial**. The marketing site
<https://fullfact.ai/> describes the suite as "trusted by over 45
organisations in 30 countries"; <https://fullfact.org/ai/> states it is
"available through a paid licence." Current functional taxonomy:
**Monitoring / Alerts / Transcription / Claim Matching**.

The Full Fact GitHub org (<https://github.com/FullFact>) has 33 public
repos, **none** of which are the flagship components. Peripheral repos:

- `health-misinfo-shared` (MIT) — Project Raphael, joint Full Fact +
  Google PoC. **The one directly cribbable artefact.**
- `genai-utils` (Apache 2.0).
- `pastel` (Apache 2.0).
- `claim-review-schema-wordpress-plugin`.
- `hackathon-vector-matching` (MIT) — exists, but is a hackathon
  artefact, **not** evidence of the production claim-matching stack.

**Classifier stack** (from <https://fullfact.org/ai/>): "We built this
with the BERT model and fine-tuned it using our own annotated data …
More recently, we've enhanced this approach by introducing a generative
AI model." BERT-fine-tune + generative LLM. Specifics not public.

### Project Raphael (`health-misinfo-shared`) — what to steal

- Repo: <https://github.com/FullFact/health-misinfo-shared>
- Pipeline: off-the-shelf LLM (Gemini) **extracts claims from YouTube
  transcripts**, then runs a **multi-label checkworthiness classifier**
  with three buckets — `not worth checking` / `may be worth checking` /
  `worth checking` — and generates a **per-claim explanation** for
  *why* it's checkworthy.
- **Why it matters**: the cleanest open-source pattern for an
  upstream **check-worthiness filter** before atomic decomposition. Maps
  directly onto our extraction stage's filtering step.

## Community Notes bridging algorithm

Source of truth: <https://github.com/twitter/communitynotes>. Foundational
paper: Wojcik et al. 2022 (<https://arxiv.org/abs/2210.15723>) —
*bridging-based ranking* selects annotations "with broad appeal across
diverse user populations rather than maximising consensus within single
groups."

**Model**: predict each rating `r_un` from rater `u` on note `n`:

    r_un = µ + i_u + i_n + f_u · f_n

- `µ` — global mean rating.
- `i_u` — rater intercept (this rater's helpfulness baseline).
- `i_n` — note intercept — **this is what gets used for ranking**.
- `f_u, f_n` — latent factor vectors. `f_u · f_n` is the
  "ideology" / polarity term that absorbs systematic agreement.

**Bridging property**: the intercept `i_n` scores high **only when
raters with opposing latent factors `f_u` both rate the note helpful**.
If only one cluster likes the note, the dot product absorbs the
variance and the intercept stays modest. Cross-cluster agreement is
forced into the intercept — hence *bridging*.

**Default hyperparameters** (twitter/communitynotes):
- `λ_i = 0.15` on intercepts.
- `λ_f = 0.03` on factors.
- Intercept regularisation is what prevents the "everyone agrees"
  trivial solution.

### Adapting it for the labeler

The algorithm is domain-agnostic: needs only a sparse
`reviewers × items` rating matrix. To score reviewer disagreement on
verdicts:

- Reviewers play the role of raters; (claim, proposed-verdict) pairs
  play the role of notes; reviewer accept/reject votes play the role
  of helpful/not.
- `f_u` absorbs systematic bias — partisan lean, methodological school,
  domain expertise alignment.
- `i_n` acts as a "this verdict bridges disagreement" indicator — useful
  for auto-accept vs. escalate.

**Caveat**: bridging is only useful when there *is* a polarity axis to
bridge. If reviewer disagreement is essentially noise, the latent
factors won't separate and the intercept becomes uninformative. Audit
reviewer correlations before assuming the algorithm will help.

## AVeriTeC system-paper steals

Catalogue of reusable patterns from non-winning AVeriTeC teams. One
paragraph each, with the single steal-worthy idea highlighted.

**AIC CTU 2024** (3rd place) — *Likert-scale LLM confidence + MMR
reranking*. Prompts the verdict LLM to print each label with a 1–5
"strongly disagree / strongly agree" rating; aggregates as a lightweight
calibration proxy that avoids token-probability tokenisation quirks and
enables ensembling. **Steal**: the Likert-prompt + MMR over dense
embeddings. Code: <https://github.com/aic-factcheck/aic_averitec>.

**HerO (2024, 2nd) / Fathom (2025) / SANCTUARY (2025)** — *HyDE-style
hypothetical document / question expansion* as query expansion before
sparse + dense hybrid retrieval. Fathom: 0.2043 test, +27.7 pp over
baseline on dev. **Steal**: cheap LLM-generated hypothetical Q/A
injected as extra retrieval queries.
Sources: <https://aclanthology.org/2024.fever-1.15/>,
<https://aclanthology.org/2025.fever-1.19/>.

**Team Papelo (2024)** — *iterative LLM-driven follow-up question
generation* (multi-hop evidence pursuit). +0.155 AVeriTeC / +0.045 label
accuracy vs. one-shot QG. Final: 0.510 dev / 0.477 test. **Steal**: the
agentic loop — ask, retrieve, identify gap, ask next.
<https://arxiv.org/pdf/2411.05762>

**IKR3-UNIMIB (2024)** — *question-from-claim decomposition + Chain-of-RAG
with BM25 + ColBERT reranker* (0.18 test). Reverses the usual
question-from-evidence direction. **Steal**: generate questions
*from the claim*, not from retrieved evidence — simpler control flow.

**OldJoe (2025)** — *embedding-into-SQL retrieval*. Embeds the knowledge
store and stores vectors in **plain SQL** instead of a dedicated vector
DB; LLM-driven QG → QA → verdict. **Steal**: SQL-as-vector-store is
operationally simple for small-to-medium corpora — this is exactly what
our `claim_review.embedding BLOB` column does.
Repo: <https://github.com/farahft/OldJoe>.
Paper: <https://aclanthology.org/2025.fever-1.18/>.

**SK_DU (2024)** — *cross-encoder evidence retrieval* combined with LLM
question generation as a documented multi-stage approach. **Steal**: add
a cross-encoder reranking layer between dense retrieval and LLM verdict.
This is exactly Stage 3 in our pipeline — currently deferred but
straightforward to add.

**HerO 2 (HUMANE, 2025 2nd)** — *document summarisation + answer
reformulation + post-training quantisation*. Summarises web docs into
paragraph evidence blocks, reformulates retrieved evidence into
answer-form text (best at top-10 QA), applies PTQ for runtime. **Steal**:
pre-summarise evidence blocks before LLM verdict; quantise for the
1-minute envelope.
Repo: <https://github.com/ssu-humane/HerO2>.

**SFEFC (2025)** — *cosine-similarity thresholds for NEI / conflicting
labels* short-circuit easy cases, cutting average runtime from 33.88 s
to 7.01 s per claim. **Steal**: reuse retrieval-stage cosine scores as
a cheap verdict-stage gate for "not enough info."

**FZI-WIM (2024)** — empirical: *"more questions generated during QG
correlates with higher AVeriTeC scores."* **Steal**: don't truncate QG
aggressively — sample broadly, let downstream evidence filtering prune.
<https://aclanthology.org/2024.fever-1.8/>

### Structured / proof-style verdicts — still a gap

**ProoFVer** (TACL 2022) remains the canonical natural-logic-operator
approach. **No AVeriTeC 2024 / 2025 shared-task system reimplements
it.** Closest analogues are HerO 2's structured QA evidence and AIC
CTU's Likert confidence — not deterministic proof structures.

**Implication for us**: the *faithful-by-construction verdict* idea is
**open territory** on the AVeriTeC benchmark. Could be a contribution
later.

### Confidence calibration — also a gap

- AIC CTU's Likert proxy is the only documented mechanism in surveyed
  systems.
- **No team reports formal ECE / Brier numbers** in published claims.
- For HITL escalation thresholds: derive ourselves from reviewer
  feedback, not from the literature.

## OSS end-to-end stacks

Hands-on evaluation. Direct repo inspection + README reading.

### Loki / OpenFactVerification (★ top pick)

- Repo: <https://github.com/Libr-AI/OpenFactVerification>
- License: MIT · Python · ~1.1 k stars · active (2024-10 last push).
- Homepage: <https://loki.librai.tech/>
- **Architecture**: five-stage modular pipeline —
  `Decompose` → `Checkworthy` → `QueryGenerator` → `Retriever` →
  `ClaimVerify`. **Each stage takes its own LLM client and model name**.
- **LM Studio compatible**: yes — supports `LOCAL_API_URL` +
  `LOCAL_API_KEY` for any OpenAI-compatible endpoint.
- **What to steal**:
  - The **stage decomposition** maps almost 1:1 onto our two-level
    design (Decompose + Checkworthy ≈ Level 1; QueryGenerator + Retriever
    + ClaimVerify ≈ Level 2).
  - **Per-stage model swap**: each module gets its own LLM client — the
    right abstraction for our gemma-for-extraction +
    larger-model-for-verification split.
  - The prompt mapper + retriever mapper are clean extension points.
- **Gaps vs. our needs**: no atproto integration (we add); no HITL queue
  (we add); default search uses Serper API (commercial) — we swap for
  ClaimReview + local index.

**Verdict**: prime candidate to fork or vendor-in as the engine if we
ever outgrow the current minimal pipeline. Saves weeks of plumbing.

### MultiVerS (AllenAI)

- Repo: <https://github.com/dwadden/multivers>
- License: MIT · Python · 54 stars · quiescent (2023-08 last push).
- Longformer-based long-document classifier for scientific claim
  verification with full-document context and weak supervision. NAACL
  Findings 2022 (<https://arxiv.org/abs/2112.01640>).
- Checkpoints: `fever`, `fever_sci`, `covidfact`, `healthver`, `scifact`,
  `longformer_large_science`.
- **What to steal**: full-document context strategy via Longformer for
  claims needing long-range evidence. Worth keeping in mind if we add
  an *article-level* labeler later.

**Verdict**: niche tool, not the backbone. Borrow ideas, not code.

### factcheckexplorer

- Repo: <https://github.com/GONZOsint/factcheckexplorer>
- License: MIT · Python · 17 stars · quiescent.
- A thin Python client over **Google Fact Check Explorer's** undocumented
  API. Bypasses front-end limits to fetch up to 10 k ClaimReview results
  with language filter and CSV export.
- **What to steal**: pattern as ClaimReview ingest fallback if the Data
  Commons feed becomes inadequate. Caveat: undocumented API, can break.

**Verdict**: data-acquisition utility, not architecture. Keep in toolbox.

### Summary

| Repo | License | Role for our project | Priority |
| --- | --- | --- | --- |
| **Loki / OpenFactVerification** | MIT | Engine for L1+L2 pipeline; LM-Studio-ready | High if we expand beyond lookup-first |
| **MultiVerS** | MIT | Reference for long-doc verdict modelling; future article labeler | Low |
| **factcheckexplorer** | MIT | ClaimReview ingest helper | Medium |

## Cross-system cheat-sheet

| Pattern | Source | One-line steal |
| --- | --- | --- |
| Krippendorff's α with 0.8 / 0.667 thresholds | Argilla | Use for extraction reviewer agreement |
| Multi-reviewer instrumentation | Prodigy | Stamp `_annotator_id` + `_input_hash` from day one |
| Confidence routing | Autolabel | High-conf auto-accept, low-conf to HITL queue |
| Ozone UI/backend split | Bluesky | Ship our own backend implementing label endpoints; point Ozone UI at it |
| Hybrid lexical + semantic matcher | ClaimBuster | Sparse + dense retrieval merged (we ship dense-only; sparse is a next step) |
| Faithful-by-construction verdicts | ProoFVer | Output structured proofs; verdict deterministic from proof |
| Joint evidence-quality + verdict score | AVeriTeC | Evidence quality is a gate, not a tiebreaker |
| Likert-scale LLM confidence | AIC CTU 2024 | Prompt model to print label + 1–5 rating → use as confidence proxy |
| MMR reranking | AIC CTU 2024 | Diversify retrieval with MMR before verdict |
| HyDE hypothetical Q/A | HerO / Fathom / SANCTUARY | LLM-generate hypothetical answers, retrieve against them |
| Iterative QG | Team Papelo | Ask one question at a time, retrieve, then ask next based on gap |
| Question-from-claim | IKR3-UNIMIB | Generate questions from the claim, not from retrieved evidence |
| SQL-as-vector-store | OldJoe 2025 | Skip the vector DB for small KBs — embeddings in SQL (we already do this) |
| Cross-encoder reranking | SK_DU 2024 | Cross-encoder layer between dense retrieval and verdict |
| Evidence summarisation | HerO 2 2025 | Summarise retrieved docs into paragraph blocks before verdict |
| Cosine-threshold NEI cut | SFEFC 2025 | Use retrieval cosine scores to short-circuit easy "not enough info" |
| Broad QG sampling | FZI-WIM 2024 | Don't truncate QG; sample widely and prune downstream |
| Stage decomposition | Loki | Each pipeline stage gets its own LLM client |
| Check-worthiness 3-bucket + explanation | Full Fact / Project Raphael | Filter claims with explanation before atomic decomposition |
| Bridging-based ranking | Community Notes | `i_n = noteIntercept` only scores when raters with opposing `f_u` agree |

## Open questions

- **Full Fact's current flagship internals**: BERT fine-tune + generative
  LLM is the only public detail. Specific architecture not published.
- **Community Notes adaptation to claim verdicts**: medium-confidence
  the algorithm helps. Validation requires a multi-reviewer setting we
  don't have yet.
- **IFCN signatory engineering blogs**: Chequeado, AFP Factuel,
  PolitiFact, Logically, Africa Check, Snopes, FactCheck.org, Lead
  Stories, AAP, Boom Live, VERA Files, dpa-Faktencheck, LatamChequea —
  none surfaced verified primary engineering sources. Most publish
  journalism, not engineering. Treat as out-of-scope for current
  implementation; revisit for partnership outreach.
- **Confidence calibration**: no surveyed team reports formal ECE /
  Brier numbers. Derive our HITL escalation thresholds from reviewer
  feedback once a reviewer pool exists.
- **Structured / proof-style verdicts** are an open contribution on
  AVeriTeC. Worth revisiting if we add a verification stage (Stage 6
  in PIPELINE.md § Future extensions).

## Caveats

- **Argilla v1.12 docs do not name Cohen's κ**; later versions (v1.29+,
  2.x) do. Pin a version when integrating.
- **Lilac is archived** (read-only since 2025-07-25). Reference only.
- **ClaimBuster's VLDB 2017 architecture is canonical**, but the
  deployed system has evolved (transformer / adversarial Spotter per
  arXiv 2002.07725). Semilar specifically is dated — substitute modern
  dense retrievers.
- **Full Fact's product taxonomy shifted** between 2021 (Candidates /
  Digest / Live / Robochecking) and 2026 (functional marketing names)
  — don't assume old names are current.
- **Community Notes quality-sensitive extension** (arxiv 2604.11224) is
  newer than the original Wojcik 2022 paper. Bridging mechanism is solid
  and confirmed in `twitter/communitynotes`; the specific `γ_i δ_j`
  re-notation and `ρ_i` quality-weighting come from the newer paper and
  may not match the production algorithm 1:1.
- **AVeriTeC absolute scores**: do not compare across years naively.
  2025 (33.17 % winner) is far below 2024 (63 % InFact) because of the
  open-weights + 23 GB GPU + 1-minute envelope.
- **Factiverse / Originality.ai / OpenFactVerification / factcheckexplorer
  / MultiVerS** — only URLs verified, not capability claims.
- **`health-misinfo-shared`** is a PoC, not a production system.
- **"Ozone as the integration target" is editorial framing** — Bluesky
  explicitly invites custom labeler implementations. Ozone is the
  canonical reference.

## Sources

| URL | Quality | Topic |
| --- | --- | --- |
| <https://docs.v1.argilla.io/en/latest/reference/python/python_annotation_metrics.html> | primary | HITL — Argilla metrics |
| <https://docs.v1.argilla.io/en/v1.12.0/guides/llms/practical_guides/set_up_annotation_team.html> | primary | HITL — Argilla team setup |
| <https://prodi.gy/docs/metrics> | primary | HITL — Prodigy metrics |
| <https://labelstud.io/videos/in-the-loop-cohen-and-fleiss-kappas/> | blog | HITL — Label Studio κ |
| <https://github.com/refuel-ai/autolabel> | primary | HITL — Autolabel |
| <https://github.com/databricks/lilac> | primary | HITL — Lilac (archived) |
| <https://github.com/bluesky-social/ozone> | primary | Labeler — Ozone |
| <https://docs.bsky.app/blog/blueskys-moderation-architecture> | primary | Labeler — protocol |
| <https://vldb.org/pvldb/vol10/p1945-li.pdf> | primary | ClaimBuster (VLDB 2017) |
| <https://arxiv.org/abs/2109.11427> | primary | Guo et al. fact-checking survey |
| <https://aclanthology.org/2022.tacl-1.59/> | primary | ProoFVer (TACL 2022) |
| <https://aclanthology.org/2024.fever-1.1/> | primary | AVeriTeC 2024 overview |
| <https://aclanthology.org/2024.fever-1.11/> | primary | AVeriTeC 2024 system paper |
| <https://aclanthology.org/2024.fever-1.12/> | primary | InFact (AVeriTeC 2024 winner) |
| <https://aclanthology.org/2024.fever-1.15/> | primary | HerO (AVeriTeC 2024 2nd) |
| <https://aclanthology.org/2024.fever-1.8/> | primary | FZI-WIM (AVeriTeC 2024) |
| <https://aclanthology.org/2025.fever-1.15/> | primary | AVeriTeC 2025 overview |
| <https://aclanthology.org/2025.fever-1.18/> | primary | OldJoe (AVeriTeC 2025) |
| <https://aclanthology.org/2025.fever-1.19/> | primary | Fathom (AVeriTeC 2025) |
| <https://arxiv.org/abs/2410.23850> | primary | AVeriTeC evaluation |
| <https://arxiv.org/abs/2210.15723> | primary | AVeriTeC dataset / Wojcik 2022 |
| <https://arxiv.org/abs/2411.05762> | primary | Team Papelo (iterative QG) |
| <https://arxiv.org/abs/1910.09796> | primary | Multi-domain context |
| <https://github.com/ssu-humane/HerO> | primary | HerO repo (open-weights AVeriTeC ref) |
| <https://github.com/ssu-humane/HerO2> | primary | HerO 2 repo |
| <https://github.com/aic-factcheck/aic_averitec> | primary | AIC CTU code |
| <https://github.com/farahft/OldJoe> | primary | OldJoe code |
| <https://github.com/FullFact> | primary | Full Fact GitHub org |
| <https://github.com/FullFact/health-misinfo-shared> | primary | Project Raphael |
| <https://fullfact.org/ai/> | primary | Full Fact AI program |
| <https://fullfact.ai/> | primary | Full Fact marketing |
| <https://fullfact.org/blog/2018/feb/how-we-customised-prodigy-ai/> | blog | Full Fact + Prodigy |
| <https://fullfact.org/blog/2021/jul/how-does-automated-fact-checking-work/> | primary | Full Fact 2021 pipeline |
| <https://github.com/twitter/communitynotes> | primary | Community Notes source |
| <https://arxiv.org/html/2604.11224> | primary | Quality-sensitive MF extension |
| <https://github.com/Libr-AI/OpenFactVerification> | primary | Loki / OpenFactVerification |
| <https://openfactcheck.com/> | primary | OpenFactCheck site |
| <https://github.com/GONZOsint/factcheckexplorer> | primary | factcheckexplorer |
| <https://github.com/dwadden/multivers> | primary | MultiVerS code |
| <https://aclanthology.org/2022.findings-naacl.6/> | primary | MultiVerS paper |
| <https://arxiv.org/pdf/2112.01640> | primary | MultiVerS preprint |
| <https://www.factiverse.ai/features/api> | primary | Factiverse API |
| <https://originality.ai/automated-fact-checker> | blog | Originality.ai |
