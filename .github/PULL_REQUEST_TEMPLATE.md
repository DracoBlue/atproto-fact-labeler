<!-- Thanks for the PR. Please fill in the sections below; delete what isn't relevant. -->

## What this changes

<!-- One paragraph. What is the new behaviour? -->

## Why

<!-- Link the issue, or describe the problem. -->

Fixes #

## How it was verified

- [ ] `pnpm typecheck` passes locally
- [ ] `pnpm test` passes locally
- [ ] `pnpm test:matching` checked (or noted N/A and why)
- [ ] Documented user-visible changes in the relevant doc under `docs/` or in `README.md`
- [ ] No new secrets, personal data or local paths in the diff

## For changes to the publisher allowlist

<!-- Delete this section if you're not touching config/claimreview-publishers-allowlist.txt -->

- [ ] Linked the corresponding allowlist Issue (`allowlist: add ...` / `allowlist: remove ...`)
- [ ] Re-ran `pnpm cleanup:claims --dry-run` and noted the row delta below

Row delta (`cleanup:claims --dry-run`):

```
total: ...
toDelete: ...
keep: ...
```

## Notes for the reviewer

<!-- Anything that helps. Trade-offs you considered, alternatives you rejected, what you're nervous about. -->
