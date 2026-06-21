# Research: Claim-to-Fact-Check Matching

> Companion to [`docs/pipeline/README.md`](./pipeline/README.md). Captures the
> peer-reviewed sources that justify the three-stage architecture
> (retrieve → rerank → entail) replacing our broken FTS-only lookup.
>
> Compiled from a deep-research pass: 24 sources fetched, 93 claims
> extracted, **25 verified 3-vote, 0 refuted**. The findings below are the
> 11 that survived synthesis.

## TL;DR

Production claim-to-fact-check matching has converged on a **multi-stage
pipeline**:

1. **Retrieve** — multilingual dense embeddings (BGE-M3, Multilingual-E5-Large,
   SFR-embedding-2). BM25 alone is documented as insufficient at every
   measured cutoff.
2. **Rerank** — cross-encoder (`ms-marco-MiniLM-L-12-v2` is the workhorse;
   `bge-reranker-v2-m3` for multilingual). Cross-encoder beats bi-encoder
   beats BM25 at every cutoff in SK_DU's measurements.
3. **Polarity gate (NLI)** — 3-class entailment / neutral / contradiction
   over `(input claim, fact-check claim)`. Verdict is flipped on
   contradiction, passed through on entailment, dropped on neutral.

The **operational framing** at Full Fact ("two claims match iff
t(v) = t(u) — identical truth conditions") and Meedan ("can these be
served by one fact-check?") treats matching as **clustering / dedup**, not
as verdict pass-through. Our current code does pass-through, which neither
framing endorses.

## How the major systems do it

### AVeriTeC 2024 winners

The FEVER 2024 shared task on real-world fact verification used a
joint metric: a claim only counts as correctly verified when **both**
verdict is correct **and** retrieved evidence passes a quality threshold.
Source: <https://aclanthology.org/2024.fever-1.1/>

All four top systems use multi-stage pipelines with cross-encoder or
dense reranking and an NLI / LLM verification head:

| System | Stage 1 (retrieve) | Stage 2 (rerank) | Stage 3 (verdict) | Score |
| --- | --- | --- | --- | --- |
| TUDA_MAI | n/a public | n/a public | n/a public | **63 %** |
| HerO  | BM25 top-10k | SFR-embedding-2 → top-10 | LLM-as-judge | 57 % |
| SK_DU | Cross-encoder `ms-marco-MiniLM-L-12-v2` (22.7 M params) | same model also reranks | DeBERTa-v3-base NLI | (paper) |
| InFact | 6-stage LLM pipeline | LLM rerank | LLM verdict | (paper) |

Sources:
- AVeriTeC overview: <https://aclanthology.org/2024.fever-1.1/>
- HerO: <https://aclanthology.org/2024.fever-1.12/> and <https://arxiv.org/html/2410.12377>
- SK_DU: <https://aclanthology.org/2024.fever-1.11.pdf>

### Meedan (Alegre + Check)

Meedan operates the largest documented production claim-matching service
for fact-check tiplines. Their operational definition:

> *"Can the claims in these two posts be served with one fact-check?"*

This frames matching as **pairwise clustering**, not verdict transfer.
Their stack (Alegre) uses multilingual sentence-transformer embeddings
over Elasticsearch (with dense_vector kNN). Models in their repo include
`xlm_r_bert_base_nli_stsb_mean_tokens`, `indian_sbert`, plus a custom
knowledge-distilled multilingual embedder.

Sources:
- <https://meedan.org/post/claim-matching-global-fact-checks-at-meedan>
- <https://meedan.com/post/claim-matching-beyond-english-to-scale-global-fact-checking>
- <https://github.com/meedan/alegre>

### Full Fact

Full Fact's published definition (Sippitt 2021):

> Two claims **match** iff they have **identical truth conditions** —
> *t(v) = t(u)*. There is no possible world in which one is true and the
> other false.

This formally rules out polarity confusion. By the definition, "the earth
is round" and "the earth is flat" do **not** match — same topic, but their
truth conditions are inverted. The published Full Fact infrastructure
("ClaimMatcher" in talks) operates on this principle.

Source: <https://fullfact.org/blog/2021/oct/towards-common-definition-claim-matching/>

### FACT-GPT

Frames claim-to-fact-check matching as **3-class textual entailment**
(entailment / neutral / contradiction) explicitly. The model judges
whether the input claim entails, contradicts, or is neutral with respect
to the fact-check's reviewed claim.

Reported F1 scores from their fine-tuned LLMs:
- entailment ≈ **0.83**
- neutral ≈ **0.72**
- contradiction ≈ **0.46**

Contradiction detection is the documented weak link. Our pipeline must be
designed assuming false-negative contradictions (mis-classified as
neutral → silent abstention, the safe failure mode).

Source: <https://arxiv.org/html/2402.05904v1>

## Why dense beats BM25

Concrete cutoff measurements from SK_DU on AVeriTeC's evidence-retrieval
task (Hu-METEOR):

| Method | top-10 | top-100 |
| --- | --- | --- |
| BM25 | 0.1452 | 0.2338 |
| Bi-Encoder | 0.1787 | 0.2753 |
| **Cross-Encoder** | **0.1913** | **0.2907** |

Source: <https://aclanthology.org/2024.fever-1.11.pdf>

HerO measured a **+0.073 AVeriTeC score** improvement when replacing the
BM25-only retriever with BM25 → SFR-embedding-2 reranking on top-10k.

Source: <https://arxiv.org/html/2410.12377>

MultiClaim (EMNLP 2023) measured supervised fine-tuning of retrievers
significantly outperforming both BM25 and zero-shot embeddings on the
multilingual claim-matching task across 39 languages. Best zero-shot
performer: **BGE-M3** (highest MAP on the original split).

Source: <https://aclanthology.org/2023.emnlp-main.1027.pdf>

Pikuliak et al. 2024 evaluated on AMC-16K:
- Multilingual E5 Large: **Success@10 = 0.87**, MAP = 0.75.
- BGE-M3 comparable, with sparse + dense + multi-vector signal.

Source: <https://arxiv.org/html/2503.02737>

## LLM-as-judge as a viable variant

Large LLMs (70 B+) reach 80%+ macro F1 on claim-matching framed as binary
relevance classification:

| Model | Setup | Macro F1 |
| --- | --- | --- |
| Mistral Large | few-shot monolingual | **82.46** |
| C4AI Command R+ | zero-shot | **83.20** |

These are LLM-as-judge variants of reranking. They confirm that
prompting an LLM as a relevance/NLI judge is a defensible alternative to
a dedicated cross-encoder — but uses 70 B+ models. Our qwen3.6-27b would
sit in roughly this performance band; smaller (2 B–7 B) models drop
materially.

Source: <https://arxiv.org/html/2503.02737>

## Quality thresholds and "no match" handling

AVeriTeC's own evaluation **requires** evidence quality above a threshold
*before* a verdict is credited. From the overview:

> *"considers a claim accurately verified iff both verdict is correct
> and retrieved evidence meets a certain quality threshold."*

Concrete cosine / reranker thresholds are **not standardised** in the
literature — papers tune per dataset. The operational pattern is to
calibrate on a held-out set, not to copy a number from a paper.

Production systems' behaviour when no match passes the gate:
1. **Return uncovered** silently (Meedan's tipline framing assumes
   human-in-the-loop for low-confidence cases).
2. **Escalate to retrieval-augmented LLM verification** (the AVeriTeC
   default — InFact's 6-stage pipeline includes a web-evidence-retrieval
   fallback).
3. **Queue for human review**.

What they do **not** do: aggregate weak matches into a verdict. That's
the failure mode our current code falls into.

Source: <https://aclanthology.org/2024.fever-1.1/>

## Negation / polarity: the published state

Polarity / negation is acknowledged across the literature as a hard
sub-problem. The dominant principled approach is NLI-based:

1. Run NLI on `(input claim, claimReviewed)`.
2. On `entailment` → use publisher's verdict as-is.
3. On `contradiction` → **flip** the publisher's verdict.
4. On `neutral` → drop the candidate (no aggregation).

ProoFVer (TACL 2022) implements a related approach with natural-logic
operators producing a deterministic verdict from the proof structure —
faithful by construction. It is not deployed in production fact-check
matching but established the principle.

Sources:
- ProoFVer: <https://aclanthology.org/2022.tacl-1.59/>
- Multi-stage matching survey: <https://arxiv.org/pdf/2505.10740>

### Honest caveat

Polarity-flip-on-contradiction is **principled but not widely documented
as a deployed production pattern** in the surveyed sources. We would be
early — but on the correct side of the correctness frontier. Synthesis
finding, confidence: medium.

## Claim matching as a research task

Formally introduced by **Shaar et al. ACL 2020** ("That is a known lie:
Detecting previously fact-checked claims") as a learning-to-rank problem
distinct from claim verification.

Active shared tasks in 2024–2025:
- **SemEval-2025 Task 7**: monolingual + crosslingual claim matching.
  179 participants, 52 test submissions.
- **MultiClaim** (EMNLP 2023): 28 k posts, 206 k fact-checks, 27 / 39
  languages.

Sources:
- Shaar et al. 2020: <https://arxiv.org/abs/2005.06058>
- SemEval-2025: <https://aclanthology.org/2025.semeval-1.323/>
- MultiClaim: <https://aclanthology.org/2023.emnlp-main.1027.pdf>

## Recommended architecture (synthesised)

Concrete recipe for a small lookup-first labeler over a 200 k
ClaimReview corpus in en + de with a local LLM and no training budget:

1. **First-stage retrieval**: BGE-M3 or Multilingual-E5-Large dense
   embeddings, top-50.
2. **Reranking**: multilingual cross-encoder (bge-reranker-v2-m3),
   keep top-5 above a tuned threshold.
3. **Polarity gate**: zero-shot NLI step using either a fine-tuned
   mDeBERTa-v3-base-mnli-xnli or the local LLM prompted as a 3-class
   judge on `(input_claim, claimReviewed)`.
4. **Aggregation**: only across entailment-class matches (flipped on
   contradiction). Return `uncovered` if no candidate survives.
5. **No-match fallback**: AVeriTeC-style retrieval-augmented LLM
   verification, or human-queue escalation. (Explicitly out of scope for
   our v1.)

Cited in synthesis: <https://arxiv.org/html/2503.02737>,
<https://arxiv.org/html/2410.12377>,
<https://aclanthology.org/2024.fever-1.11.pdf>,
<https://arxiv.org/html/2402.05904v1>,
<https://meedan.org/post/claim-matching-global-fact-checks-at-meedan>.

Confidence: medium — synthesis from multiple primary sources; concrete
thresholds need calibration.

## Open questions

1. **Concrete cosine / reranker thresholds**: not universally published.
   Calibrate on a held-out set ([`docs/pipeline/README.md`](./pipeline/README.md) §
   Test-set / CI gate).
2. **Deployed verdict-flip-on-contradiction**: principled but unclear
   if any production system implements it as documented behaviour.
3. **BGE-M3 / Multilingual-E5 on German short claims**: benchmarks are
   en-centric; German-specific evaluation is sparse.
4. **Local LLM (gemma-2 B, qwen3-27 B) as NLI judge** vs. dedicated
   mDeBERTa-v3-base-mnli-xnli: both viable, the smaller-model competitive
   region needs measurement, not assertion.

## Caveats (verbatim from the verification pass)

- Concrete cosine / reranker thresholds are rarely published as
  universal numbers; numbers in this doc are operational guidance, not
  citable norms.
- AVeriTeC's evidence-retrieval scores measure document/sentence
  evidence retrieval, not strict claim-to-ClaimReview matching — the
  BM25 / Bi-Encoder / Cross-Encoder gap may not transfer 1:1.
- FACT-GPT's contradiction F1 ≈ 0.46 is from a single COVID-focused
  study and may not generalise.
- Meedan's Alegre uses Elasticsearch which now supports dense_vector
  kNN, so "not a pure vector DB" is a soft distinction.
- German-specific evaluation data is sparse — most benchmarks are
  en-centric (MultiClaim covers DE but published numbers are
  aggregated).
- The polarity-flip-on-contradiction recipe is principled but not
  widely deployed as a documented production pattern; it is synthesised
  from FACT-GPT's NLI framing plus Full Fact's truth-condition
  definition.

## Sources

| URL | Quality | Role |
| --- | --- | --- |
| <https://aclanthology.org/2024.fever-1.1/> | primary | AVeriTeC 2024 overview |
| <https://aclanthology.org/2024.fever-1.11.pdf> | primary | SK_DU system |
| <https://aclanthology.org/2024.fever-1.12/> | primary | HerO + multi-hop QG |
| <https://arxiv.org/html/2410.12377> | primary | HerO retrieval details |
| <https://aclanthology.org/2023.emnlp-main.1027.pdf> | primary | MultiClaim (EMNLP 2023) |
| <https://arxiv.org/html/2503.02737> | primary | Pikuliak et al. — AMC-16K + LLM judges |
| <https://arxiv.org/html/2402.05904v1> | primary | FACT-GPT (3-class NLI framing) |
| <https://aclanthology.org/2022.tacl-1.59/> | primary | ProoFVer (natural-logic verdict) |
| <https://meedan.org/post/claim-matching-global-fact-checks-at-meedan> | primary | Meedan operational definition |
| <https://meedan.com/post/claim-matching-beyond-english-to-scale-global-fact-checking> | primary | Meedan multilingual embeddings |
| <https://github.com/meedan/alegre> | primary | Meedan Alegre repo |
| <https://fullfact.org/blog/2021/oct/towards-common-definition-claim-matching/> | primary | Full Fact truth-conditions def |
| <https://arxiv.org/abs/2005.06058> | primary | Shaar et al. ACL 2020 |
| <https://aclanthology.org/2025.semeval-1.323/> | primary | SemEval-2025 Task 7 |
| <https://arxiv.org/pdf/2505.10740> | primary | Multi-stage matching survey |
| <https://huggingface.co/BAAI/bge-reranker-v2-m3> | primary | Recommended reranker model card |
| <https://developers.google.com/fact-check/tools/api> | primary | Google Fact Check Tools API |
