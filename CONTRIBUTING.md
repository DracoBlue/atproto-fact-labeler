# Contributing

Thanks for considering a contribution. This labeler routes existing
fact-check verdicts onto Bluesky — it deliberately does *not* decide what
is true on its own. Most contributions either improve that routing, add
support for new fact-checkers, or harden the operator workflow.

## What kind of contribution is this?

If you already know, jump straight to the matching issue template:

| You want to … | Open this |
|---|---|
| Report a bug | [Bug report](.github/ISSUE_TEMPLATE/bug.yml) |
| Suggest a feature | [Feature request](.github/ISSUE_TEMPLATE/feature.yml) |
| **Add a publisher to the allowlist** | [Publisher addition](.github/ISSUE_TEMPLATE/publisher-add.yml) |
| **Flag a publisher that should be removed** | [Publisher removal](.github/ISSUE_TEMPLATE/publisher-remove.yml) |
| Report a security issue | See [SECURITY.md](SECURITY.md) — do **not** open a public issue |

The allowlist forms are structured because every entry there is an
editorial decision — see [`docs/FEED_QUALITY.md`](docs/FEED_QUALITY.md)
for the reasoning. The form makes sure we collect the evidence we need
to act on the request.

## Local setup

```bash
git clone https://github.com/DracoBlue/atproto-fact-labeler.git
cd atproto-fact-labeler
pnpm install
cp .env.example .env                 # edit OPENAI_API_KEY at minimum

# Download the ClaimReview feed (~60 MB)
curl -L \
  https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json \
  -o data.json

pnpm ingest
pnpm cli:embed-rebuild
```

Then `pnpm test` for the unit tests, `pnpm test:matching` for the
end-to-end 13-case fixture (requires a live LLM endpoint).

## Before you push

```bash
pnpm typecheck
pnpm test
```

The CI runs both; PRs that don't pass these locally won't merge.

## Pull request conventions

- One concern per PR. A bug fix and a new feature in the same PR makes
  bisecting future regressions harder.
- Commit messages: short imperative subject (≤ 72 chars), then a blank
  line, then a paragraph or two on *why*. Existing history (`git log
  --oneline`) shows the style.
- Touch tests where behaviour changes. New code paths without tests
  will get pushback unless there's a good reason.
- Don't bundle dependency upgrades into feature PRs — Dependabot
  handles those on its own schedule.

## Areas where help is especially welcome

- **Reply language coverage** — the mention-reply template currently
  supports `en` and `de`. Add a third locale (Spanish, French,
  Portuguese, ...) and the `LABELER_REPLY_DEFAULT_LANG` enum opens up
  to it. Pattern is in `src/replier/format.ts`.
- **Publisher additions** — the allowlist is intentionally
  conservative. If your region's IFCN-signatory fact-checker isn't on
  the list, please open a Publisher addition issue with the evidence.
- **NLI / rerank prompt tuning** — `pnpm test:matching` is the
  regression harness. A PR that lifts the 13-case fixture from
  9/13 → 12/13 on a specific model is very welcome.
- **PDS compatibility** — the labeler is tested against `bsky.social`.
  Reports of running it against Eurosky, a self-hosted PDS or other
  major providers are valuable (open a Bug report with the symptoms).

## Areas where contributions will probably be declined

- **Adding new label values.** The six `fact-*` labels are deliberately
  scoped to map from third-party verdicts. Adding e.g. `fact-AI-generated`
  would mix editorial categories and is not in scope here.
- **Hardcoding a specific LLM provider.** The OpenAI-compatible
  abstraction is load-bearing for the operator promise that you can
  swap LM Studio in.
- **Heuristic rules that decide truth without a fact-checker source.**
  The labeler is a *router*, not a judge. Anything that produces a
  verdict without citing a third-party fact-check belongs in a different
  project.

## Licence of contributions

By submitting a PR you agree to license your contribution under the
project's MIT licence ([`LICENSE`](LICENSE)).
