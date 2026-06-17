# HITL Tooling & Prior Fact-Checking Systems

> Implementation-oriented deep-dive on the TODOs left open in
> [`COMPONENTS.md`](./COMPONENTS.md): (1) human-in-the-loop annotation tooling,
> (2) prior fact-checking systems. Compiled 2026-06-15 from a multi-source
> adversarially-verified research pass (24 sources, 110 claims extracted,
> 25 verified 3-vote, **0 refuted**). Topics with no surviving verified
> claims are flagged as **open** for a follow-up pass.

## TL;DR

- **HITL stack recommendation:**
  - **Argilla** (open source, HF-backed) for the **extraction reviewer UI** —
    flexible Feedback datasets, Krippendorff's α built in, programmatic
    pre-annotation via SDK.
  - **Ozone** for the **verification reviewer UI + label emission** — it's
    already the canonical atproto labeler console; UI is decoupled from the
    backend, so we can keep our verifier outside.
  - **Autolabel** (refuel-ai, MIT) for **LLM pre-annotation in code** with
    built-in confidence routing — no UI, slots in upstream of Argilla/Ozone.
- **Prior-system steals (cheat-sheet):**
  - **ClaimBuster** → 4-stage pipeline (Monitor / Spotter / Matcher / Checker
    / Reporter) and a hybrid lexical (Elasticsearch) + semantic (dense
    embeddings) matcher.
  - **ProoFVer** → faithful-by-construction verdicts: emit the natural-logic
    operator sequence; the verdict *is* the sequence, not a post-hoc rationale.
  - **AVeriTeC** → joint evidence + verdict scoring with a Q+A METEOR gate;
    use it as the eval pattern from day one.
- **Two important "no verified data this pass":** Community Notes bridging
  algorithm, AVeriTeC runners-up technique catalogue. Both flagged for a
  follow-up.

---

## Topic 1 — HITL annotation tooling

### 1.1 Argilla (open source, Hugging Face)

- **License / hosting:** OSS (Apache 2.0); self-hostable; HF Spaces template.
- **Schema flexibility:** Feedback datasets accept structured records with
  custom question/field types; suitable for claim records with multiple
  attributes (atomic text, decontextualized text, span, entities, confidence).
- **Pre-annotation:** Python SDK; programmatic record + suggestion writes.
- **Active learning:** community examples exist; not first-class.
- **Multi-reviewer / IAA:** primary metric is **Krippendorff's α**, with
  documented interpretation thresholds (≥0.8 reliable, ≥0.667 tentative);
  later versions (v1.29+ / 2.x) add explicit Cohen's κ, Fleiss' κ. Three
  overlap strategies: **full / zero / controlled**.
- **Audit log:** record-level history of suggestions, responses, status.
- **Ozone integration:** none built-in — would be a custom bridge
  (Argilla webhooks → Ozone API).

Sources:
- <https://docs.v1.argilla.io/en/latest/reference/python/python_annotation_metrics.html>
- <https://docs.v1.argilla.io/en/v1.12.0/guides/llms/practical_guides/set_up_annotation_team.html>

### 1.2 Prodigy (Explosion AI; commercial)

- **License / hosting:** commercial, per-seat; self-hosted only (no cloud).
- **Schema flexibility:** recipe-driven; arbitrary JSON via custom recipes.
- **Pre-annotation:** designed for it (model-in-the-loop is the core pitch).
- **Active learning:** first-class; uncertainty-based recipes shipped.
- **Multi-reviewer / IAA:** deliberately **excludes Cohen's κ** (requires
  full overlap, doesn't scale beyond two annotators or large label sets) and
  implements **Percent Agreement, Krippendorff's α, Gwet's AC2**. Multi-reviewer
  plumbing uses automatic `_annotator_id` assignment and `_input_hash`
  grouping to identify coincident examples.
- **Audit log:** review database; replay possible.
- **Ozone integration:** none; would also be custom.
- **Notable user:** Full Fact's customised pipeline (2018 write-up, see
  [`COMPONENTS.md` §1.3](./COMPONENTS.md#1-3-human-in-the-loop)).

Source: <https://prodi.gy/docs/metrics>

### 1.3 Label Studio (Heartex; OSS + Cloud)

- **License / hosting:** community edition Apache 2.0; enterprise paid.
- **Schema flexibility:** XML-based labeling config; broad task coverage
  (text, image, video, time series). Good for span/entity annotation.
- **Pre-annotation:** ML backend API for predictions; SDK for bulk import.
- **Active learning:** ML backend can score uncertainty; community recipes.
- **Multi-reviewer / IAA:** consensus mode, agreement metrics including
  Cohen's / Fleiss' κ (per public guidance video).
- **Ozone integration:** none; webhook-based custom bridge possible.

> Coverage note: detailed primary-source claims for Label Studio specifics
> didn't survive verification in this pass beyond the κ metrics video;
> treat above as directional. The vendor is mainstream and well-documented —
> validate against current docs before committing.

### 1.4 doccano (open source)

- **License / hosting:** MIT; Django-based; easy self-host.
- **Strengths:** simple, low-friction text annotation (NER, classification,
  seq2seq); good for early bootstrap.
- **Weaknesses:** thin pre-annotation story; limited multi-reviewer /
  IAA tooling; less suited as a long-term reviewer console for a two-level
  pipeline.

### 1.5 Newer / adjacent alternatives

- **Autolabel** (refuel-ai, MIT) — Python library for **programmatic LLM
  pre-annotation** across OpenAI / Anthropic / HuggingFace / Google;
  classification, QA, NER, entity matching. Built-in per-label confidence and
  explanations; documented HITL pattern of **routing low-confidence labels to
  humans**. **No bundled reviewer UI** — that's Refuel's commercial product.
  Slots in upstream of Argilla/Ozone as the LLM-call layer.
  - <https://github.com/refuel-ai/autolabel>
- **Lilac** — **archived 2025-07-25**. Signal-based pre-annotation
  (PII, language, near-duplicates) and Python-API batch labeling were
  capability-relevant. Reference design only; not a live integration target.
  - <https://github.com/databricks/lilac>
- **Scale Rapid, Snorkel Flow, Refuel Platform** — commercial; not surveyed.

### 1.6 Recommendation matrix

| Use case | Recommendation | Why |
| --- | --- | --- |
| LLM pre-annotation in code | **Autolabel** | MIT, programmatic, confidence routing |
| Extraction reviewer UI | **Argilla** | OSS, schema-flexible, α + overlap modes, SDK |
| Verification reviewer UI | **Ozone** (extended) | already canonical for atproto labels; UI/backend decoupled |
| Label emission to Bluesky | **Ozone backend or custom** implementing `subscribeLabels` / `queryLabels` |
| Bootstrap / early prototype | **doccano** | simplest path; throw-away |
| Fact-check newsroom adjacency | **Prodigy** | model-in-the-loop is its DNA; Full Fact precedent |

**Ozone vs. dedicated tool — decision:** **Run both.** Ozone is decoupled
(Next.js UI ↔ separate labeling-service backend implementing the atproto label
endpoints), so we can:

1. Use Ozone for **label publishing + verification review** (it knows about
   `subscribeLabels` / `queryLabels`, custom-label metadata, severity, blur,
   `defaultSetting`, localization).
2. Run **Argilla alongside** for the extraction-review queue, since claim
   records have richer custom structure than Ozone's report/label model.
3. Bridge via a small service: extraction-accepted claims → verification
   queue (Ozone) → emitted labels.

Sources for the Ozone side:
- <https://github.com/bluesky-social/ozone>
- <https://docs.bsky.app/blog/blueskys-moderation-architecture>

---

## Topic 2 — Prior fact-checking systems

### 2.1 ClaimBuster (UT Arlington)

- **Task:** end-to-end (claim detection → matching → verification reporting).
- **Architecture (VLDB 2017 canonical):**
  1. **Claim Monitor** — ingests live text streams.
  2. **Claim Spotter** — check-worthiness score 0.0–1.0. Original: SVM on
     ~28k human-coded debate sentences with token + POS features
     (74% recall / 79% precision). Newer versions use transformer / adversarial
     training (arXiv 2002.07725).
  3. **Claim Matcher** — **hybrid retrieval**: Elasticsearch lexical +
     **Semilar** semantic similarity, results merged.
  4. **Claim Checker** — Wolfram Alpha + web queries when no prior fact-check
     matches.
  5. **Fact-check Reporter** — surfaces matched / generated reports.
- **Status:** active deployment at <https://idir.uta.edu/claimbuster/>; the
  architecture pattern is the most-cited reference.
- **What to steal:** the **hybrid lexical + semantic matcher**. In 2026 replace
  Semilar with **sentence-transformers** (`mxbai-embed-large-v1`, `bge-m3`)
  and Elasticsearch with **Qdrant / FAISS + BM25**.

Sources:
- <https://vldb.org/pvldb/vol10/p1945-li.pdf>
- <https://arxiv.org/abs/2109.11427> (Guo et al. survey context)

### 2.2 ProoFVer (Krishna et al., TACL 2022)

- **Task:** claim verification (FEVER-style).
- **Architecture:** **seq2seq** model emits a **natural-logic proof** —
  lexical mutations between claim and evidence spans annotated with NL
  operators (equivalence, forward / backward entailment, negation,
  alternation, cover, independence). **The verdict is determined solely by
  the operator sequence**, not by a separate classifier head.
- **Status:** published; reference implementation available; not deployed as a
  service. Known weakness: NL-operator annotation cost during training.
- **What to steal:** **faithful-by-construction verdicts**. If the verifier
  emits a structured proof and the verdict is a deterministic function of that
  proof, **the rationale cannot lie about the verdict** — strong property for
  HITL audit and for explaining "disputed" labels to end users.

Source: <https://aclanthology.org/2022.tacl-1.59/>

### 2.3 AVeriTeC shared task (FEVER 2024 & 2025)

- **Task:** real-world claim verification with retrieval; verdict vocabulary
  `{supported, refuted, not_enough_evidence, conflicting}`.
- **Evaluation:** **joint** — retrieval evidence is scored by Q+A
  **Hungarian METEOR ≥ 0.25** as a gate; verdict accuracy is counted **only
  above the gate**. Below gate → score 0 regardless of verdict.
- **2025 edition constraints:** **open-weights models only**, single **23 GB
  GPU** (e.g., A10). Closed-LLM pipelines effectively excluded.
- **2025 winner:** **CTU AIC** at 33.17 % AVeriTeC score; 6 of 7 submissions
  beat baseline. (Their stack covered in
  [`COMPONENTS.md` §2.2](./COMPONENTS.md#2-2-ai-support-—-retrieve-and-generate).)
- **What to steal:**
  1. The **joint metric** — apply Q+A METEOR (or a moral equivalent) to our
     stored evidence, so we don't optimize the LLM into confident-but-empty
     verdicts.
  2. The **operating envelope** — design for single-GPU, open-weights from
     day one.

Sources:
- <https://aclanthology.org/2024.fever-1.1/>
- <https://aclanthology.org/2025.fever-1.15/>
- <https://arxiv.org/abs/2410.23850>
- AVeriTeC 2024 HerO system (open-weights reference): <https://github.com/ssu-humane/HerO>
- AVeriTeC 2024 paper #11: <https://aclanthology.org/2024.fever-1.11/>

### 2.4 FEVER ecosystem — short note

- Original FEVER dataset (Thorne et al. 2018) bootstrapped the modern
  claim-verification literature. Classic pipelines: **DOMLIN**, **KGAT**,
  **CorefBERT**. AVeriTeC supersedes FEVER for real-world claims; treat FEVER
  as the synthetic-benchmark predecessor.
- AVeriTeC dataset paper for context: <https://arxiv.org/abs/2210.15723>
- Multi-domain extension reference: <https://arxiv.org/abs/1910.09796>

### 2.5 Systems flagged in the brief but **not verified this pass**

These were named in the request but did not surface verified primary-source
claims in this verification batch. Treat as TODO for a focused follow-up
research pass, not as evidence-backed recommendations:

- **Full Fact AI** (internal pipeline details — Live / Trends / Search).
  Only the 2018 Prodigy customisation post is reliably cited.
- **Factiverse** (Norwegian commercial fact-check infra).
- **Originality.ai** (AI-detector / fact-check hybrid).
- **MultiVerS** (AllenAI multi-domain claim verification).
- **AVeriTeC 2024/2025 runners-up** beyond CTU AIC — the catalogue of
  interesting-but-not-winning ideas (multi-hop iterative QG, decomposition
  prompting, reranking strategies, proof-style verdicts in shared-task code).
- **Birdwatch / Community Notes algorithm** in technical depth —
  bridging-based matrix factorization objective, regularization terms,
  helpful-rater diversity factor.
- **IFCN signatories' internal tooling** (none surfaced as publicly documented
  this pass).
- **End-to-end OSS stacks** (OpenFact, fact-checker-explorer, MultiVerS code
  release) and licenses thereof.

Suggested next research pass: target each of these by name with
`site:github.com` and `site:aclanthology.org` queries.

---

## 3. What to steal — implementer cheat-sheet

| System / tool | Concrete takeaway |
| --- | --- |
| **Argilla** | Use Krippendorff's α with 0.8 / 0.667 thresholds; choose overlap mode (full / zero / controlled) per claim category. |
| **Prodigy** | When sizing reviewer pools, instrument `_annotator_id` + `_input_hash` from the start so coincident examples are queryable later. Skip Cohen's κ. |
| **Autolabel** | Wrap the LLM extraction/verification calls in a confidence-routing layer: high-conf auto-accept, low-conf to HITL queue. Borrow the per-label confidence pattern. |
| **Ozone** | Treat UI and backend as separate; we ship our own backend implementing `subscribeLabels` / `queryLabels`, point Ozone UI at it. Use Ozone's custom-label metadata schema (severity, blur, defaultSetting, localization) verbatim. |
| **ClaimBuster** | Build the matcher as **lexical + semantic hybrid** with merged results — substitute Qdrant/FAISS + BM25 + sentence-transformers for ES + Semilar. |
| **ProoFVer** | Emit structured proofs where the verdict is a deterministic function of the proof. Even if we don't implement NL operators, the property — *rationale cannot disagree with verdict* — is gold for HITL. |
| **AVeriTeC** | Adopt the joint evidence + verdict metric from day one; enforce evidence quality as a gate, not a tiebreaker. |
| **FEVER lineage** | Use as bootstrap data only; AVeriTeC is the real target. |

---

## 4. Open questions — answered

The follow-up research pass (see §7 below) addressed each of the original open
questions. Brief verdicts:

1. **Full Fact's public surface** — answered §7.1. Flagship stack (Live /
   Trends / Search / Stats Checker) is **commercial, paid licence**. Public
   GitHub org has 33 repos; the one cribbable artefact is **`health-misinfo-shared`** (MIT, Project Raphael with Google).
2. **Community Notes bridging MF** — answered §7.2. Algorithm published,
   open-source, with concrete objective and hyperparameters.
3. **AVeriTeC runners-up** — partially answered §7.3. **InFact** and **Team
   Papelo** verified as stealable patterns. Wider system-paper survey remains
   incomplete.
4. **OSS end-to-end stacks** — partially answered §7.4. URLs confirmed for
   **OpenFactVerification**, **factcheckexplorer**, **MultiVerS** but
   capability claims not adversarially verified — treat as leads.

## 5. Caveats

- Argilla v1.12 docs do not name Cohen's κ; later (v1.29+, 2.x) versions do.
  Pin a version when integrating.
- Lilac is archived (read-only since 2025-07-25). Reference, not dependency.
- ClaimBuster's VLDB 2017 architecture is canonical, but the deployed system
  has evolved (transformer / adversarial Spotter per arXiv 2002.07725).
  Semilar specifically is dated — substitute modern dense retrievers.
- "Ozone as the integration target" is editorial framing — Bluesky explicitly
  invites custom labeler implementations. Ozone remains the canonical
  reference.

## 6. Sources

| URL | Quality | Topic |
| --- | --- | --- |
| <https://docs.v1.argilla.io/en/latest/reference/python/python_annotation_metrics.html> | primary | HITL — Argilla metrics |
| <https://docs.v1.argilla.io/en/v1.12.0/guides/llms/practical_guides/set_up_annotation_team.html> | primary | HITL — Argilla team setup |
| <https://prodi.gy/docs/metrics> | primary | HITL — Prodigy metrics |
| <https://labelstud.io/videos/in-the-loop-cohen-and-fleiss-kappas/> | blog | HITL — Label Studio κ |
| <https://github.com/refuel-ai/autolabel> | primary | HITL — Autolabel |
| <https://www.refuel.ai/blog-posts/introducing-autolabel> | blog | HITL — Autolabel context |
| <https://github.com/databricks/lilac> | primary | HITL — Lilac (archived) |
| <https://github.com/bluesky-social/ozone> | primary | Labeler — Ozone |
| <https://docs.bsky.app/blog/blueskys-moderation-architecture> | primary | Labeler — protocol |
| <https://vldb.org/pvldb/vol10/p1945-li.pdf> | primary | Prior — ClaimBuster (VLDB 2017) |
| <https://arxiv.org/abs/2109.11427> | primary | Prior — Guo et al. fact-checking survey |
| <https://aclanthology.org/2022.tacl-1.59/> | primary | Prior — ProoFVer (TACL 2022) |
| <https://aclanthology.org/2024.fever-1.1/> | primary | Prior — AVeriTeC 2024 overview |
| <https://aclanthology.org/2024.fever-1.11/> | primary | Prior — AVeriTeC 2024 system paper |
| <https://aclanthology.org/2025.fever-1.15/> | primary | Prior — AVeriTeC 2025 overview |
| <https://arxiv.org/abs/2410.23850> | primary | Prior — AVeriTeC eval |
| <https://arxiv.org/abs/2210.15723> | primary | Prior — AVeriTeC dataset |
| <https://arxiv.org/abs/1910.09796> | primary | Prior — multi-domain context |
| <https://github.com/ssu-humane/HerO> | primary | Prior — AVeriTeC HerO (open-weights ref) |

---

## 7. Follow-up answers (2026-06-15 second pass)

Multi-source adversarially-verified pass (25 sources, 96 claims, 25 verified,
1 refuted).

### 7.1 Full Fact AI — public vs. internal

- **Flagship stack is commercial.** The marketing site
  <https://fullfact.ai/> describes the suite as "trusted by over 45
  organisations in 30 countries" and <https://fullfact.org/ai/> states tools
  are "available through a paid licence." Current marketing taxonomy:
  **Monitoring / Alerts / Transcription / Claim Matching**. The 2021 internal
  taxonomy was **Candidates / Digest / Live / Robochecking** (different names,
  same approximate functions).
- **GitHub org** <https://github.com/FullFact> has 33 public repos, **none** of
  which are the flagship components. Peripheral repos that are public:
  - `health-misinfo-shared` (MIT) — the one directly cribbable artefact.
  - `genai-utils` (Apache-2.0).
  - `pastel` (Apache-2.0).
  - `claim-review-schema-wordpress-plugin`.
  - `hackathon-vector-matching` (MIT) — exists, but is a hackathon artefact,
    **not** evidence of the production claim-matching stack (this inference
    was specifically **refuted** in adversarial verification).
  - `twscrape`, `wagtail-case-insensitive`, etc.
- **Classifier stack.** From <https://fullfact.org/ai/>: "We built this with
  the BERT model and fine-tuned it using our own annotated data … More
  recently, we've enhanced this approach by introducing a generative AI
  model." So: BERT-fine-tune + generative LLM. Specifics not public.
- **Prodigy integration.** Documented in the 2018 customisation post
  (<https://fullfact.org/blog/2018/feb/how-we-customised-prodigy-ai/>);
  current integration details are not public.

**Project Raphael / `health-misinfo-shared` — what to steal**

- Repo: <https://github.com/FullFact/health-misinfo-shared>
- Licence: **MIT**. Joint Full Fact + Google PoC.
- Pipeline: uses an "off-the-shelf LLM (e.g. Gemini)" to **extract claims from
  YouTube transcripts**, then runs a **multi-label checkworthiness
  classifier** with three buckets — `not worth checking` / `may be worth
  checking` / `worth checking` — and **generates a per-claim explanation**
  for *why* it's checkworthy.
- **Why this matters:** cleanest open-source pattern for the labeler's
  upstream **check-worthiness filter** before atomic decomposition. The
  three-bucket + explanation structure maps directly onto our extraction
  pipeline's filtering stage.

### 7.2 Community Notes bridging-based matrix factorization

**Source of truth:** <https://github.com/twitter/communitynotes> (open source,
Twitter/X). Foundational paper: **Wojcik et al. 2022**
(<https://arxiv.org/abs/2210.15723>) — "bridging-based ranking" selects
annotations "with broad appeal across diverse user populations rather than
maximising consensus within single groups."

**Model.** Predict each rating $r_{un}$ from rater $u$ on note $n$:

$$\hat{r}_{un} = \mu + i_u + i_n + f_u \cdot f_n$$

where:
- $\mu$ — global mean rating.
- $i_u$ — **rater intercept** (this rater's helpfulness baseline).
- $i_n$ — **note intercept** — *this is the score that gets used for ranking.*
- $f_u, f_n$ — **latent factor vectors** (typically low-dim). $f_u \cdot f_n$
  is the "ideology" / polarity term that absorbs systematic agreement.

**Bridging property — why it works.** The intercept $i_n$ scores high **only
when raters with opposing latent factors $f_u$ both rate the note helpful**.
If only one cluster (e.g., one polarity side) likes the note, the dot-product
term $f_u \cdot f_n$ absorbs the variance and the intercept stays modest.
Raters who agree across the polarity axis are forced to push their agreement
into the intercept — hence "bridging."

**Objective.** Regularised least squares; the quality-sensitive extension
(<https://arxiv.org/html/2604.11224>) gives the full form (notation
$\alpha_i, \beta_j, \gamma_i \delta_j$):

$$L = \tfrac{1}{2} \sum_{(i,j)} (r_{ij} - \mu - \alpha_i - \rho_i \beta_j - \gamma_i \delta_j)^2 + \text{reg}(\rho, \alpha, \gamma, \beta, \delta)$$

**Hyperparameters** (defaults in twitter/communitynotes):
- $\lambda_i = 0.15$ on intercepts.
- $\lambda_f = 0.03$ on factors.
- Regularisation on intercepts is **what prevents the "everyone agrees"
  trivial solution** — without it, $i_n$ would absorb everything and bridging
  would collapse.

**Adapting it for the labeler.** Algorithm is domain-agnostic: needs only a
sparse `reviewers × items` rating matrix. To score reviewer disagreement on
**claim verdicts**:
- Reviewers play the role of raters; (claim, proposed-verdict) pairs play the
  role of notes; reviewer accept/reject votes play the role of helpful/not.
- The latent factor $f_u$ will absorb whatever systematic bias exists —
  partisan lean, methodological school, domain expertise alignment.
- The note-intercept score acts as a "verdict bridges disagreement"
  indicator — useful for **deciding when to auto-accept vs. escalate**.

**Caveat** (medium-confidence claim): bridging is only useful when there
**is** a polarity axis to bridge. If reviewer disagreement on claim verdicts
is essentially noise (no structured factions), the latent factors won't
separate and the intercept becomes uninformative. Start with synthetic data
or audit reviewer correlations before assuming the algorithm will help.

### 7.3 AVeriTeC system-paper steals (2024–2025)

**InFact** — AVeriTeC 2024 winner at **63 % AVeriTeC score** (1 of 21).
<https://aclanthology.org/2024.fever-1.12/>
- **Pattern:** 6-stage LLM-driven pipeline using GPT-4o. Decompose verification
  into discrete stages (claim normalisation → query generation → retrieval →
  evidence selection → verdict → justification).
- **What to steal:** the **stage decomposition**. Each stage is independently
  promptable, evaluable, swappable. Maps cleanly onto our verification
  worker's internal structure.

**Team Papelo** — AVeriTeC 2024, 0.510 dev / 0.477 test.
<https://arxiv.org/abs/2411.05762>
- **Pattern:** **iterative follow-up question generation** as evidence
  accumulates, *not* batched upfront question generation. Gain over one-shot:
  **+0.045 label accuracy / +0.155 AVeriTeC score**.
- **What to steal:** the **adaptive question-generation loop**. Resolves the
  earlier conflict with the previously-refuted "multi-hop QG" claim — the
  difference is *adaptive* vs. *batched*. Adaptive works.

**CTU AIC (2025 winner, 33.17 %)** — already covered in §2.3.

**Combined verdict-stage takeaway:** stage-decompose AND make the QG loop
iterative.

> The wider AVeriTeC system-paper survey (reranking strategies, confidence
> calibration, proof-style verdicts in shared-task code) was **not completed**
> in this pass. Remains open — see §8.

### 7.4 OSS end-to-end fact-checking stacks

URLs confirmed as primary sources in this pass, but capability claims
**not adversarially verified** — these are leads to evaluate hands-on, not
endorsements.

- **OpenFactVerification** — <https://github.com/Libr-AI/OpenFactVerification>
  with companion site <https://openfactcheck.com/>. Reportedly an end-to-end
  framework for evaluating factuality of LLM responses.
- **factcheckexplorer** — <https://github.com/GONZOsint/factcheckexplorer> —
  exists, status / scope unverified this pass.
- **MultiVerS (AllenAI)** — <https://github.com/dwadden/multivers>. Paper:
  <https://aclanthology.org/2022.findings-naacl.6/>,
  preprint <https://arxiv.org/pdf/2112.01640>. Multi-domain claim verification
  (originally for scientific claims, extended to multi-domain).

**Action item:** evaluate each repo's licence, freshness, and integration cost
before committing.

### 7.5 Commercial / closed profiles

- **Factiverse** (Norway) — API surface at
  <https://www.factiverse.ai/features/api>. Commercial; API-first; Norwegian.
- **Originality.ai** — automated fact-checker (with AI-detection as the
  primary product). <https://originality.ai/automated-fact-checker>.
  Commercial.

Both are reference points for product surface, not embeddable building blocks.

## 8. Still open after the follow-up

1. AVeriTeC 2024/2025 wider system-paper survey: reranking, confidence
   calibration, proof-style verdicts in shared-task code (only InFact +
   Papelo verified this pass).
2. Hands-on capability evaluation of OpenFactVerification, factcheckexplorer,
   MultiVerS (URLs confirmed, claims about capabilities not verified).
3. Documented stacks from IFCN signatories beyond Full Fact (Chequeado, AFP
   Factuel, PolitiFact, Logically).

## 9. Caveats (follow-up pass)

- Full Fact's product taxonomy shifted between 2021 (Candidates / Digest /
  Live / Robochecking) and 2026 (functional marketing names) — don't assume
  the older names are current.
- The "quality-sensitive" Community Notes extension (arxiv 2604.11224) is a
  **future-dated preprint** relative to the original Wojcik 2022 paper.
  Bridging mechanism is solid and confirmed in twitter/communitynotes; the
  specific $\gamma_i \delta_j$ re-notation and $\rho_i$ quality-weighting come
  from the newer paper and may not match the production algorithm 1:1.
- AVeriTeC absolute scores: **don't compare across years naively**. 2025
  (33.17 % winner) is far below 2024 (63 % InFact) because of the open-weights
  + 23 GB GPU + 1-minute constraints.
- Factiverse / Originality.ai / OpenFactVerification / factcheckexplorer /
  MultiVerS profiles: only URLs were verified, **not capability claims**.
- The `health-misinfo-shared` repo is a PoC, not a production system.

## 10. Additional sources (follow-up pass)

| URL | Quality | Topic |
| --- | --- | --- |
| <https://github.com/FullFact> | primary | Full Fact GitHub org |
| <https://fullfact.org/ai/> | primary | Full Fact AI program |
| <https://fullfact.ai/> | primary | Full Fact AI marketing |
| <https://fullfact.org/blog/2021/jul/how-does-automated-fact-checking-work/> | primary | Full Fact 2021 pipeline |
| <https://github.com/FullFact/health-misinfo-shared> | primary | Project Raphael |
| <https://github.com/twitter/communitynotes> | primary | Community Notes source |
| <https://arxiv.org/abs/2210.15723> | primary | Bridging-based ranking (Wojcik 2022) |
| <https://arxiv.org/html/2604.11224> | primary | Quality-sensitive MF extension |
| <https://arxiv.org/pdf/2502.13322> | primary | Community Notes follow-up |
| <https://aclanthology.org/2024.fever-1.12/> | primary | InFact (AVeriTeC 2024 winner) |
| <https://aclanthology.org/2024.fever-1.8/> | primary | AVeriTeC 2024 system paper |
| <https://arxiv.org/abs/2411.05762> | primary | Team Papelo (iterative QG) |
| <https://github.com/Libr-AI/OpenFactVerification> | primary | OpenFactVerification |
| <https://openfactcheck.com/> | primary | OpenFactCheck site |
| <https://github.com/GONZOsint/factcheckexplorer> | primary | factcheckexplorer |
| <https://github.com/dwadden/multivers> | primary | MultiVerS code |
| <https://aclanthology.org/2022.findings-naacl.6/> | primary | MultiVerS paper |
| <https://arxiv.org/pdf/2112.01640> | primary | MultiVerS preprint |
| <https://www.factiverse.ai/features/api> | primary | Factiverse API |
| <https://originality.ai/automated-fact-checker> | blog | Originality.ai |

---

## 11. Hands-on eval of OSS end-to-end stacks (2026-06-15)

Direct repo inspection via GitHub API + README reading. Closes §8 item 2.

### 11.1 Loki / OpenFactVerification ★ top pick

- **Repo:** <https://github.com/Libr-AI/OpenFactVerification> (a.k.a. **Loki**)
- **License:** MIT · **Language:** Python · **Stars:** ~1.1k
- **Activity:** active (last push 2024-10), created 2024-03. Homepage:
  <https://loki.librai.tech/>
- **Architecture:** five-stage modular pipeline — `Decompose` → `Checkworthy`
  → `QueryGenerator` → `Retriever` (serper / etc.) → `ClaimVerify`. **Each
  stage takes its own LLM client and model name**, so we can mix-and-match
  (e.g., gemma for Decompose / Checkworthy, larger model for ClaimVerify).
- **LM Studio compatible:** **yes** — config supports `LOCAL_API_URL` +
  `LOCAL_API_KEY` for any OpenAI-compatible endpoint, including LM Studio.
- **What to steal — a lot:**
  - The **stage decomposition** maps almost 1:1 onto our two-level design
    (Decompose + Checkworthy = our Level 1; QueryGenerator + Retriever +
    ClaimVerify = our Level 2).
  - The **per-stage model swap** pattern (each module gets its own LLM client)
    is exactly the right abstraction for our gemma-for-extraction +
    larger-model-for-verification split.
  - The **prompt mapper** + retriever mapper are clean extension points.
- **Gaps vs. our needs:** no atproto integration (we add); no HITL queue (we
  add via Argilla / Ozone); search uses Serper API by default (commercial — we
  swap for Wikidata + ClaimReview feed + local index).
- **Verdict:** **prime candidate** to fork or vendor-in as the engine for
  both levels. Saves weeks of plumbing.

### 11.2 MultiVerS (AllenAI)

- **Repo:** <https://github.com/dwadden/multivers>
- **License:** MIT · **Language:** Python · **Stars:** 54
- **Activity:** quiescent (last push 2023-08), created 2021-12. Research
  prototype disclaimer in README.
- **Architecture:** Longformer-based long-document classifier (formerly
  "LongChecker"). Single seq2seq model for **scientific** claim verification
  with full-document context and weak supervision. NAACL Findings 2022
  (<https://arxiv.org/abs/2112.01640>).
- **Checkpoints:** `fever`, `fever_sci`, `covidfact`, `healthver`, `scifact`,
  `longformer_large_science`. All downloadable.
- **What to steal:**
  - **Full-document context** strategy via Longformer for claims that need
    long-range evidence (e.g., a thread, a long article). Worth keeping in
    mind if we add an *article-level* labeler later.
  - The **multi-domain checkpoint family** is a useful reference for staging
    domain-specific fine-tunes (health, science).
- **Gaps:** scientific-claim-focused, conda/Python 3.8, no RAG retrieval stage
  (assumes evidence is given) — not an end-to-end stack, only the verdict
  model.
- **Verdict:** **niche tool**, not the backbone. Borrow ideas, not code.

### 11.3 factcheckexplorer

- **Repo:** <https://github.com/GONZOsint/factcheckexplorer>
- **License:** MIT · **Language:** Python · **Stars:** 17
- **Activity:** quiescent (last push 2024-04), created 2024-04. Single dev.
- **What it actually is:** a thin Python client over **Google Fact Check
  Explorer's** undocumented API — bypasses front-end limits to fetch up to
  10k ClaimReview results with language filter and CSV export.
- **What to steal:** use it (or the pattern) as our **ClaimReview ingest
  source** if we want a quick proxy for the Data Commons feed mentioned in
  [`RESEARCH.md` §3](./RESEARCH.md#3-interop-standard-schemaorg-claimreview).
  Caveat: undocumented API, can break.
- **Verdict:** **data-acquisition utility**, not architecture. Keep in
  toolbox.

### 11.4 Summary

| Repo | License | Role for our project | Priority |
| --- | --- | --- | --- |
| **Loki / OpenFactVerification** | MIT | Engine for L1+L2 pipeline; LM-Studio-ready out of the box | **High** |
| **MultiVerS** | MIT | Reference for long-doc verdict modeling; future article labeler | Low |
| **factcheckexplorer** | MIT | ClaimReview ingest helper | Medium |

Loki is the headline finding: a permissively-licensed, modular, LM-Studio-
compatible pipeline that matches our architecture almost exactly.
Recommend prototyping against Loki as the engine, with our atproto ingestion +
Ozone-backed HITL + label emission layered on top.

---

## 12. AVeriTeC system-paper survey — non-winning steals (2026-06-15)

Multi-source adversarially-verified pass (19 sources, 76 claims, 25 verified,
0 refuted). Closes §8 item 1.

### 12.1 Leaderboard recap

| Year | 1st | 2nd | Notes |
| --- | --- | --- | --- |
| 2024 | **TUDA_MAI** 0.63 (InFact) | **HerO** | GPT-4o + open-weights allowed |
| 2025 | **CTU AIC** 33.17 % | **HUMANE / HerO 2** | open-weights only · 23 GB GPU · ≤ 1 min/claim · precompiled KB |

> Don't naively compare 2024 vs. 2025 absolute scores — the 2025 envelope is
> much harder.

Sources:
<https://aclanthology.org/2024.fever-1.1/>,
<https://aclanthology.org/2025.fever-1.15/>,
<https://aclanthology.org/2025.fever-1.16/>,
<https://arxiv.org/pdf/2507.11004>

### 12.2 Reusable patterns (one-paragraph each)

**AIC CTU 2024** (3rd place) — **MMR reranking + Likert-scale LLM
confidence.** Prompts the verdict LLM to print each label with a 1–5
"strongly disagree / strongly agree" rating; aggregates as a lightweight
calibration proxy that avoids token-probability tokenization quirks and
enables ensembling. No formal ECE/Brier reported (authors call it
"confidence emulation"). Code: <https://github.com/aic-factcheck/aic_averitec>.
**Steal:** the Likert prompt + MMR over dense embeddings.

**HerO (2024, 2nd) / Fathom (2025) / SANCTUARY (2025)** — **HyDE-style
hypothetical document/question expansion** as query expansion before
sparse + dense hybrid retrieval. Fathom: 0.2043 test, +27.7pp over baseline
on dev. SANCTUARY: 25.27 (+5 over baseline). **Steal:** cheap LLM-generated
hypothetical Q/A injected as extra retrieval queries.
Sources: <https://aclanthology.org/2024.fever-1.15/>,
<https://aclanthology.org/2025.fever-1.19/>.

**Team Papelo (2024)** — **iterative LLM-driven follow-up question
generation** (multi-hop evidence pursuit). +0.155 AVeriTeC / +0.045 label
accuracy vs. one-shot QG. Final: 0.510 dev / 0.477 test. **Steal:** agentic
loop — ask, retrieve, identify gap, ask next.
<https://arxiv.org/pdf/2411.05762>

**IKR3-UNIMIB (2024)** — **question-from-claim decomposition + Chain-of-RAG
with BM25 + ColBERT reranker** (0.18 test). Reverses the usual
question-from-evidence pipeline. **Steal:** generate questions *from* the
claim rather than from retrieved evidence — simpler control flow.

**OldJoe (2025)** — **embedding-into-SQL retrieval.** Embeds the knowledge
store with a pretrained embedding LM and stores vectors in **plain SQL**
instead of a dedicated vector DB; then LLM-driven QG → QA → verdict.
**Steal:** SQL-as-vector-store is operationally simple for small-to-medium
corpora — useful for our claim/evidence/verdict store.
Repo: <https://github.com/farahft/OldJoe> ·
Paper: <https://aclanthology.org/2025.fever-1.18/>

**SK_DU (2024)** — **cross-encoder evidence retrieval** combined with LLM
question generation as a documented multi-stage approach. **Steal:** add a
cross-encoder reranking layer between dense retrieval and LLM verdict.

**HerO 2 (HUMANE, 2025 2nd)** — **document summarization + answer
reformulation + post-training quantization.** Summarises web docs into
paragraph evidence blocks, reformulates retrieved evidence into answer-form
text (best at top-10 QA), applies PTQ for runtime. **Steal:** pre-summarise
evidence blocks before LLM verdict; quantize for the 1-min envelope.
Repo: <https://github.com/ssu-humane/HerO2>

**SFEFC (2025)** — **cosine-similarity thresholds for NEI / conflicting**
labels short-circuit easy cases, cutting average runtime from 33.88 s to
7.01 s per claim. **Steal:** reuse retrieval-stage cosine scores as a cheap
verdict-stage gate for "not enough info."

**FZI-WIM (2024)** — empirical finding: **"more questions generated during
QG correlates with higher AVeriTeC scores."** **Steal:** don't truncate QG
aggressively — sample broadly, let downstream evidence filtering prune.
<https://aclanthology.org/2024.fever-1.8/>

### 12.3 Structured / proof-style verdicts — still a gap

**ProoFVer** (TACL 2022) remains the canonical natural-logic-operator
approach. **No AVeriTeC 2024 / 2025 shared-task system in this survey
reimplemented it.** Closest analogues are HerO 2's structured QA evidence
and AIC CTU's Likert confidence — not deterministic proof structures.

**Implication for us:** the "faithful-by-construction verdict" idea
(rationale deterministically maps to verdict, see §2.2) is **open
territory** on the AVeriTeC benchmark. Could be a contribution we publish
later.

### 12.4 Confidence calibration — also a gap

- AIC CTU's Likert proxy is the only documented mechanism in the surveyed
  systems.
- **No team reports formal ECE / Brier numbers** in the surviving claims.
- For our HITL escalation rules, this means we can't lift a calibrated
  abstention threshold from the literature — we'll need to derive one from
  reviewer feedback.

### 12.5 Cheat-sheet (additions)

| Pattern | Source | One-line steal |
| --- | --- | --- |
| Likert-scale LLM confidence | AIC CTU 2024 | Prompt model to print each label + 1–5 rating → use as confidence proxy |
| MMR reranking | AIC CTU 2024 | Diversify retrieval with MMR before verdict |
| HyDE hypothetical Q/A | HerO / Fathom / SANCTUARY | LLM-generate hypothetical answers, retrieve against them |
| Iterative QG | Team Papelo | Ask one question at a time, retrieve, then ask next based on gap |
| Question-from-claim | IKR3-UNIMIB | Generate questions from the claim, not from retrieved evidence |
| SQL-as-vector-store | OldJoe 2025 | Skip the vector DB for small KBs — just store embeddings in SQL |
| Cross-encoder reranking | SK_DU 2024 | Cross-encoder layer between dense retrieval and verdict |
| Evidence summarization | HerO 2 2025 | Summarise retrieved docs into paragraph blocks before verdict |
| Cosine-threshold NEI cut | SFEFC 2025 | Use retrieval cosine scores to short-circuit easy "not enough info" |
| Broad QG sampling | FZI-WIM 2024 | Don't truncate QG; sample widely and prune downstream |

---

## 13. IFCN signatory stacks — still unresolved

Topic B from §8 did **not** surface verified claims in this pass — none of
the 25 surviving claims address Chequeado / Chequeabot, AFP Factuel,
PolitiFact, Logically, Africa Check, Snopes, FactCheck.org, Lead Stories,
AAP, Boom Live, VERA Files, dpa-Faktencheck, or LatamChequea.

This is **not evidence of absence** — most IFCN signatories publish
journalism, not engineering blogs, and even Chequeado's "Chequeabot" has
only Knight / Poynter coverage, not a peer-reviewed system paper of
Full-Fact-grade depth.

**Leads worth a targeted follow-up pass:**

- **Chequeado / Chequeabot** — <https://github.com/chequeado> and
  <https://github.com/chequeado/autofact> exist as primary sources (not
  verified for capability in this pass). Poynter writeup:
  <https://www.poynter.org/fact-checking/2019/chequeado-is-teaming-up-with-citizens-and-robots-to-expand-the-fact-checking-universe/>.
  Academic candidate: <https://arxiv.org/pdf/2110.14532>.
- Re-run targeted queries to **LatamChequea** reports, **Reuters Institute
  Journalism Innovation** reports, and **Computation+Journalism Symposium**
  proceedings.

**Decision:** treat IFCN-signatory automation as out-of-scope for current
implementation; revisit if/when we want partnership outreach.

---

## 14. All §8 items closed

| Item | Status | Where |
| --- | --- | --- |
| 1. AVeriTeC wider survey | ✅ closed | §12 |
| 2. Hands-on OSS eval | ✅ closed | §11 |
| 3. IFCN signatory stacks | ⚠️ deferred — no primary engineering sources surfaced | §13 |
