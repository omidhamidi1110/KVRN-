# KVRN ChatGPT Checkpoint 36 — Local Single-Recipient Harness and Fail-Closed Resend IDs

**Development/recovery only; NOT a release.** All schema migrations 038–060 remain unapplied. KVRN production Git `07ac61f` is unchanged, and Claude owns the separate Admin/CMS/SEO branch.

## Additional work since 35

- `lib/marketing-claimed-recipient-resolver.ts`: no longer permits a missing or malformed provider contact ID to pass because an injected permission-check implementation incorrectly returned true. Valid Resend IDs are required **before** any independent provider read or send. The consent, approval, budget and final content-hash checks remain in force.
- `lib/marketing-owner-local-send-gate.ts` and `app/api/admin/marketing/execute-local-once/route.ts`: strictly opt-in, **local development only** one-recipient execution harness. Requires `NODE_ENV=development`, `KVRN_RUNTIME_ENV=local`, a separate local-test enable flag and all existing independent transport switches, Cloudflare Access/Admin authentication, configured marketing owner identity, same-origin bounded JSON, exact explicit confirmation phrase and a valid immutable private-claim reference. Its payload may not contain recipient addresses, messages or caller-defined consent. It delegates to the existing atomic-claim coordinator; it cannot bypass durable evidence, budgets or provider permission. No bulk/cron/send-now feature was enabled in production.
- `scripts/test-marketing-owner-local-send-gate.mjs`: eight offline validation checks including deployed/staging build rejection, omitted switches, invalid confirmation, extra client fields, and route contract.
- Added the restricted route to `qa/route-contracts.json`; added `qa:marketing-local-manual` to consolidated offline checks.

## Remaining release blockers

The local test route is **not** a production sender and cannot be used for deployed staging builds. SMS remains blocked at the independent provider-permission layer; Twilio Advanced Opt-Out, reassignment, verified local consent, recipient-level price and time-zone evidence, and provider testing still require integration work and approval. Store-credit customer-facing cash-plus-credit checkout remains **unconnected** to the canonical Stripe order finalizer and needs a single atomic accounting model. Backend migrations 038–060 require isolated Postgres tests. Full TypeScript/Next/Jest browser testing requires a complete `node_modules` install in Codespaces. Don't turn on sends or credit redemption from source flags alone.

## Verification

`npm run qa:consolidated-offline` passes on the exported-source environment. `node scripts/test-marketing-claimed-recipient-resolver.mjs` 12/12, `node scripts/test-marketing-owner-local-send-gate.mjs` 8/8. No live provider calls or financial actions were made.
