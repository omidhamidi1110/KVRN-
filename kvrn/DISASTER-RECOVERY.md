# KVRN Disaster Recovery Runbook

Baseline: commit `97c761a` (Next.js 15 on Cloudflare Workers via OpenNext, Neon PostgreSQL, SQL migrations `001`–`022`).
Companions: [`DISASTER-RECOVERY-CHECKLIST.md`](DISASTER-RECOVERY-CHECKLIST.md) (fast, tick-the-box version) and
[`DISASTER-RECOVERY-DRILL.md`](DISASTER-RECOVERY-DRILL.md) (periodic non-production rehearsal).
Related existing docs: [`STRIPE-LIVE-MODE.md`](STRIPE-LIVE-MODE.md), [`.env.example`](.env.example), [`EMAIL_SETUP.md`](EMAIL_SETUP.md),
[`GA4-INTEGRATION.md`](GA4-INTEGRATION.md), [`FUNNEL-ANALYTICS.md`](FUNNEL-ANALYTICS.md). This runbook does not replace them; where they overlap it points at them.

**Repository layout (read this once, it matters for every command):**

* The **Git repository root is one level ABOVE the app** (in the operator's Codespace: `/workspaces/KVRN-`).
* The **app root is the `kvrn/` folder inside it** (`/workspaces/KVRN-/kvrn`). `package.json`, `package-lock.json`, `wrangler.toml`, `open-next.config.ts`, `cloudflare-cron-wrapper.js`, `db/`, `lib/`, `app/` and these three documents all live under `kvrn/`.
* **Git commands** (`clone`, `checkout`, `status`, `tag`) work from the repository root (they also work from inside `kvrn/`; paths then show as `kvrn/...` from the root). **`npm`, `npx wrangler`, `npx opennextjs-cloudflare` and every relative path in these documents (`db/migrations/...`, `lib/...`) run from the app root `kvrn/`.** After a fresh clone you must `cd` into `kvrn/` before any `npm` command.
* **Path convention:** every relative app path in these documents (`package.json`, `wrangler.toml`, `db/migrations/...`, `lib/...`) is relative to the **app root `kvrn/`**. When a path is named **from the Git root**, it is written with the `kvrn/` prefix (e.g. `kvrn/package.json`). The nested workflow is always written `kvrn/.github/workflows/deploy.yml` (from the Git root); **no `.github/workflows/` directory exists at the Git root today** — GitHub only loads workflows from there, which is why that file is inactive (A.0).

**Golden rules** (everything below is an application of these):

1. **Checkout stays closed** until every gate in section J passes **and the operator says so**.
2. **Preserve before you repair.** Back up the damaged state first. Never overwrite the only copy of anything.
3. **UNKNOWN is not ZERO.** A missing fee, cost or label price is *unknown*. Do not "fix" accounting to turn a check green.
4. **Providers keep their own records.** Stripe, Shippo, Resend and Twilio are evidence, not things to blindly replay.
5. **No secret ever touches Git, docs, shell history, screenshots or chat.**

---

## 0. How to read the commands

Every command block is labelled with one of:

| Label | Meaning |
|---|---|
| `[READ-ONLY]` | Changes nothing anywhere. Safe during an incident. |
| `[LOCAL/TEST]` | Runs only on your own machine / a throwaway database. **Never** point it at Neon production. |
| `[PRODUCTION – CHANGES STATE]` | Changes production (Worker vars/secrets, deployment, database). Needs a conscious decision and an evidence-log entry (section K). |
| `[PREVIEW – …]` | Changes only the separate `kvrn-preview` worker. |

Conventions used in the snippets:

* Shell is **bash**. Snippets never call `exit` (it would close your interactive shell); a failing step prints a message and you decide what to do next.
* Placeholders are written `<LIKE_THIS>`. Replace them; never paste a real secret into a document, issue, chat or screenshot.
* **Entering a secret — one pattern, used everywhere.** Do **not** use shell `read` to capture secrets (it is unreliable in some terminals, e.g. it can consume already-buffered input). Capture with Python's `getpass` (hidden, no echo, nothing in shell history) into a **chmod-600 temporary file**, consume it **without printing it**, then `unset` any variable and delete the file:

  ```bash
  # 1) CAPTURE - hidden prompt; writes /tmp/kvrn-dr-<purpose> with mode 600 (change <purpose> and the prompt text)
  python3 - <<'PY'
  import getpass, os
  value = getpass.getpass("<WHAT THIS IS> (hidden): ")
  path = "/tmp/kvrn-dr-<purpose>"
  fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
  with os.fdopen(fd, "w") as f:
      f.write(value)
  os.chmod(path, 0o600)
  PY

  # 2) CONSUME - into a NON-exported shell variable, or straight to stdin of the tool; never echo/cat it to the screen
  SECRET_VALUE="$(cat /tmp/kvrn-dr-<purpose>)"
  # ... run the one command that needs "$SECRET_VALUE" (or: tool < /tmp/kvrn-dr-<purpose>) ...

  # 3) CLEAN UP immediately after the operation
  unset SECRET_VALUE
  rm -f /tmp/kvrn-dr-<purpose>
  ```

  Never type or paste a secret on a visible command line, into chat, a ticket, a document or a screenshot. Never `echo`, `cat` (to the terminal), `set -x`, or `env`-dump a variable that holds a secret or connection string. If a step fails, still run step 3.
  For a **LOCAL** database URL that contains no password (e.g. `postgresql://<LOCAL_USER>@localhost:5432/<DB>`), a literal URL in the command is fine and preferable to prompting.
  On a **shared** machine a connection string passed as a command-line argument can be visible to other users via the process list; use a single-user workstation, or a `~/.pgpass` file (mode `600`) with a host-only connection string.
* **Evidence and dumps live OUTSIDE the Git repository, always.** Database dumps contain customer PII and money data. Never write one under the repository root (`/workspaces/KVRN-`) or the app root (`/workspaces/KVRN-/kvrn`). Create the evidence directory with this block (it also verifies that the location is not inside a Git working tree) and reuse `EVID_DIR` in later steps:

  ```bash
  EVID_DIR="${HOME}/kvrn-dr-evidence/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$EVID_DIR" && chmod 700 "${HOME}/kvrn-dr-evidence" "$EVID_DIR"
  git -C "$EVID_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && echo "STOP: $EVID_DIR is inside a Git repository - set EVID_DIR to a path outside it (e.g. an operator-chosen encrypted location)" \
    || echo "evidence dir OK (outside any Git repo): $EVID_DIR"
  ```

  `$HOME` is an example; any explicit operator-selected **encrypted location outside the repository** is equally valid (then set `EVID_DIR` to it).
* The repo's own migration headers use two shell variables: `TEST_DATABASE_URL` (local/test) and `PRODUCTION_MIGRATION_URL` (production, kept **separate** from the Worker's `DATABASE_URL`). This runbook reuses those names and adds three session-only variables of its own: `RESTORE_URL` (an **isolated** restore target), `SOURCE_URL` (the database being backed up) and `EVID_DIR` (evidence folder). None is a Worker variable, and none is ever `export`ed except `TEST_DATABASE_URL` for a single jest run against a **local** throwaway server (and it is `unset` immediately afterwards).
* `curl` probes use the public site URL `https://kvrn.shop` (it is already public in `wrangler.toml`). For the preview worker use the URL shown in the Cloudflare dashboard.

---

## A. Scope and architecture

```
 Visitor ──► Cloudflare (DNS / custom domain kvrn.shop) ──► Worker "kvrn"
                                                             ├─ cloudflare-cron-wrapper.js   (fetch → OpenNext; scheduled → cron)
                                                             └─ .open-next/worker.js          (Next.js 15 app, API routes)
 Admin  ──► Cloudflare Access (SSO at the edge) ──► /admin/*, /api/admin/*  (+ server-side JWT check: lib/admin-auth.ts)
 Worker ──► Neon PostgreSQL        (HTTP driver, DATABASE_URL secret; lib/db.ts)
 Worker ──► Stripe  (Checkout Sessions; webhook IN at /api/stripe/webhook)
 Worker ──► Shippo  (rates at checkout; labels via Shippo dashboard)          lib/shippo.ts
 Worker ──► Resend  (transactional email outbox; marketing contacts)          lib/resend-adapter.ts, lib/resend-marketing.ts
 Worker ──► Twilio  (SMS; webhooks IN at /api/twilio/incoming and /status)    lib/twilio.ts
 Browser ─► GA4 (only after consent) and first-party analytics (/api/analytics/*)
 Cron    ─► every 5 min, in-Worker calls to /api/internal/{transactional-email-retry,marketing-sync,stripe-fee-reconcile}
 GitHub  ─► repo root (/workspaces/KVRN- in the Codespace) ─► kvrn/  = app root (package.json, wrangler.toml, ...)
            kvrn/.github/workflows/deploy.yml is NESTED, so GitHub does NOT load it: no CI deploy exists today
 Operator ─► deliberate, manual:  cd kvrn && npm run deploy   (OpenNext build + deploy via Wrangler)  = how production is deployed
```

### A.0 Repository layout and how production is actually deployed

* **Git root ≠ app root.** Git root: the folder above `kvrn/` (`/workspaces/KVRN-`). App root: `kvrn/`. All npm/OpenNext/Wrangler commands run in `kvrn/`.
* **The checked-in workflow is not active.** The repo contains `kvrn/.github/workflows/deploy.yml` (it looks intended to deploy on pushes to `main` and PRs). GitHub Actions only loads workflows from `<repository-root>/.github/workflows/`; because the repository root is the folder *above* `kvrn/`, this nested file is **not in a location GitHub recognises**. Consistent with that, commits `c046449` and `97c761a` were pushed to `origin/main` **without** deploying the production Worker — production stayed on the older, manually deployed version (operator-observed).
* **Do not rely on that workflow for recovery.** Production is currently deployed **deliberately, by an operator, from `kvrn/`** with the repo's deploy command (`npm run deploy`, i.e. the Wrangler/OpenNext flow in E.4).
* **Not provable from source:** a *provider-side* Cloudflare Git/build integration could exist outside the repo. During an incident, **check the Cloudflare dashboard** (the `kvrn` Worker's settings/deployments: what produced the current version, and is any Git-connected build enabled?) before assuming a push cannot deploy. Treat any push to `main` carefully regardless; just do not state that it necessarily deploys.
* This documentation task does **not** change the workflow. Moving or fixing it would be a separate, reviewed change.

### A.1 Sources of truth

| Thing | Source of truth | Where else a copy exists | If lost |
|---|---|---|---|
| **Application code** | The GitHub repository (commit/tag history) | Any clone; the source ZIP archives you keep; the *deployed* bundle in Cloudflare (not a source of truth — you cannot rebuild source from it) | Section C.9 / E |
| **Business data** (orders, order items + COGS snapshots, reservations, inventory quantities, FIFO cost layers, purchases, expenses, ad spend, discounts, affiliates/commissions/payouts, returns/exchanges/disputes, audit logs, financial-integrity history, payment exceptions, SMS/marketing subscribers, first-party analytics) | **Neon PostgreSQL — KVRN's own database** | KVRN backups only (see D). Providers hold *some* inputs, never the whole picture | Section D |
| **Payment records** | **Stripe** (payments, charges, refunds, disputes, balance transactions/fees) | KVRN's copy in `orders`, `order_refunds`, `order_disputes`, `webhook_events`, `payment_exceptions` | Reconcile DB against Stripe (G, I) |
| **Runtime configuration** | **Cloudflare Worker**: ordinary variables (dashboard + `wrangler.toml [vars]`) and encrypted **secrets** | `wrangler.toml` (non-secret vars only), `.env.example` (names only), your password manager / provider dashboards (values) | Section F / C.2 |
| **Shipping labels / carrier cost** | Shippo | `shipments` table (label cost, tracking) | Re-enter from Shippo; cost stays UNKNOWN until then |
| **Email delivery log** | Resend | `transactional_emails` outbox (status, attempts, provider message id) | Outbox drives retries; see C.3 duplicate-email warning |
| **SMS delivery log / consent** | Twilio (delivery), KVRN DB (`sms_subscribers`, `sms_messages`) | | Consent lives in KVRN DB — restore from backup |
| **Admin identity** | Cloudflare Access policy + `ADMIN_EMAIL_ALLOWLIST` | | C.2 / H.6 |
| **Domain / DNS** | Cloudflare (custom domain `kvrn.shop`), registrar (Namecheap per `lib/provider-portals.ts`) | | Provider dashboards |

### A.2 What can be reconstructed from providers vs. what only KVRN backups hold

| Reconstructable from a provider | Only in KVRN's database/backups (cannot be rebuilt from anyone else) |
|---|---|
| That a payment, refund or dispute happened, its amount, currency, charge/PaymentIntent ids, **actual Stripe fee** (`stripe_fee_cents` is re-fetched by the `stripe-fee-reconcile` cron while NULL) | **COGS snapshots** on order items, **FIFO cost layers**, inventory purchases, write-offs and receipts |
| Customer email/name/shipping address *as entered at checkout* (in the Stripe session) | **Inventory quantities** (`stock_on_hand`, `reserved_quantity`) and their movement history |
| Label purchase cost and tracking (Shippo dashboard) — must be **re-entered** into KVRN | **Affiliate** attribution, commissions, payouts, recoveries |
| Which emails/SMS were sent (Resend/Twilio logs) | **Expenses and ad spend**, discounts and redemptions, returns/exchanges |
| | **Financial-integrity history** (append-only detection log) and **admin audit logs** |
| | **`payment_exceptions`** (a payment KVRN could not turn into an order; the only KVRN-side record of it) |
| | Subscriber **consent** records, first-party analytics |

Consequence: **the database backup is the single most valuable recovery asset.** Everything else is replaceable or re-derivable. Orders created *after* the backup you restore exist in Stripe but not in KVRN — see D.7.

---

## B. Recovery priority order (do them in this order)

The controls that make this safe are in `lib/stripe-mode.ts` and are **fail-closed**:

* `ENABLE_CHECKOUT` must be exactly the string `true` to open checkout. Unset, empty, `false`, `TRUE`, `1`, `yes` ⇒ **closed**. (When non-empty it takes precedence over the legacy flag.)
* `ENABLE_STRIPE_TEST_CHECKOUT` (legacy; `wrangler.toml` sets it `"false"`) can only open checkout in **test** mode and only while `ENABLE_CHECKOUT` is unset. It can never open live checkout.
* `STRIPE_MODE`: unset/`test` ⇒ test; `live` ⇒ live; **anything else makes Stripe code throw** (never defaults). `STRIPE_SECRET_KEY` must match: `sk_test_…` in test, `sk_live_…` in live; a live key without `STRIPE_MODE=live`, a test key under live, and restricted keys (`rk_…`) are all rejected.
* When closed, `POST /api/checkout/session` returns **503** `{"error":"Checkout is not enabled."}` (checked in `lib/checkout-session-handler.ts` before a session is created).

| # | Step | Detail |
|---|---|---|
| 1 | **Freeze / keep checkout disabled** | Set `ENABLE_CHECKOUT` = `false` in the Cloudflare dashboard (the `kvrn` Worker → Settings → Variables; menu labels may differ). Do **not** rely on a deploy to do it. Confirm with the probe below. Note: a Stripe Checkout Session created *before* the freeze can still be paid for up to ~31 minutes (`expires_at` is set to now + 31 min in `lib/checkout-session-handler.ts`) — **keep the webhook endpoint healthy** during that window. Also glance at the Worker's deployment history in the dashboard to see whether anything (a manual deploy, or a provider-side Git integration) is still deploying (A.0). |
| 2 | **Identify the failure class** | Section C. Wrong class ⇒ wrong, possibly destructive, action. |
| 3 | **Preserve evidence** | Open the evidence log (K). Save Cloudflare Worker logs/deployments list, Stripe webhook delivery status, Neon console state, the failing commit SHA. **Do not delete anything.** |
| 4 | **Back up the damaged state** | Before *any* destructive step, take a fresh backup of whatever is left (D.2) — even a corrupt database can hold rows the last good backup lacks. |
| 5 | **Restore the database if needed** | Section D. Restore into an **isolated** database first; switch `DATABASE_URL` only after validation. |
| 6 | **Restore code/deployment** | Section E. Known-good commit, clean checkout, test, build, deploy **with checkout still closed**. |
| 7 | **Restore / re-enter secrets and config** | Section F. Names only in notes; values only via the getpass block in section F (stdin to `wrangler secret put`) or the dashboard. |
| 8 | **Validate providers and webhooks** | Sections G and H. |
| 9 | **Run integrity / reconciliation checks** | Section I (admin read paths + read-only SQL). |
| 10 | **Read-only / admin validation** | Admin pages and `GET` endpoints load; numbers make sense. |
| 11 | **Controlled checkout validation — only when explicitly approved** | Stripe test-mode E2E only in a preview/isolated environment with an isolated database (J.2) — **never** by flipping production to test mode. A production checkout is proven only by ONE real, low-value live order with explicit operator approval, handled through audited mechanisms. |
| 12 | **Reopen checkout only after all gates pass** | Section J. Set `ENABLE_CHECKOUT` = `true`, record the timestamp, watch the first orders. |

`[READ-ONLY]` Confirm checkout is closed (expect `503`; do this **only while closed** — if checkout were open, a malformed POST should be rejected with `4xx`, but do not rely on that):

```bash
curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X POST -H "Content-Type: application/json" -d '{}' https://kvrn.shop/api/checkout/session
```

The dashboard is the documented method (`STRIPE-LIVE-MODE.md`); setting a plain *variable* from the CLI is not documented by the repo, so do not improvise one.

---

## C. Incident mini-runbooks

Each mini-runbook assumes steps 1–4 of section B are done. "→" points to the detailed section.

### C.1 Bad application deploy / regression

*Signs:* new errors after a deploy; admin pages broken; checkout/webhook failing; a manual `npm run deploy` just happened. (A push to `main` is **not** known to deploy: the only workflow in the repo is nested under `kvrn/.github/` and is not loaded by GitHub — see A.0. If the dashboard shows a deployment you did not make, suspect a provider-side Git integration.)

1. Freeze checkout (B-1). Note the bad commit SHA and deploy time in the evidence log.
2. Identify the last known-good commit/tag (E.1). Compare `git log` with the Cloudflare deployments list (`[READ-ONLY]` `npx wrangler deployments list` — a wrangler command not referenced by the repo; confirm with `npx wrangler deployments --help`, wrangler is pinned to 4.92.0 in `package.json`).
3. Prefer **redeploying a known-good commit from a clean checkout** (E). Cloudflare also offers rollback to a previous Worker version (`npx wrangler rollback`, or the dashboard) — *not referenced by the repo; verify with `--help` and the Cloudflare docs what a rollback does and does not restore (variables, secrets, cron) and re-run the config check (F) afterwards.*
4. **Do not deploy a fix while checkout is open** unless that deploy is the tested fix. Fix on a branch, run `type-check`/`npm test`/`build` from `kvrn/` (E.3), then deploy deliberately (E.4). Treat pushes to `main` carefully, and confirm in the Cloudflare dashboard that no Git-connected build can deploy it for you (A.0).
5. Database was not touched by a code deploy unless a migration was run by hand. If a migration was run, treat as C.3.
6. Smoke checks (E.6) → integrity (I) → reopen only via J.

### C.2 Cloudflare Worker / configuration loss

*Signs:* Worker missing or reset, variables/secrets gone, custom domain detached, cron missing, Access app deleted.

1. Freeze: with the Worker gone, checkout is already unreachable; if a Worker exists with no variables, `ENABLE_CHECKOUT` is unset ⇒ **closed by default**.
2. Rebuild the Worker from a clean checkout of a known-good commit and deploy (E). `wrangler.toml` restores: worker name, custom domain `[[routes]]`, assets binding, cron `*/5 * * * *`, and the non-secret `[vars]`.
3. Re-enter **secrets** with `npx wrangler secret put <NAME>` (the getpass/stdin block in section F) from your password manager / provider dashboards — inventory in F. Re-create **dashboard-only variables** that `wrangler.toml` does not set: `STRIPE_MODE`, `ENABLE_CHECKOUT` (keep `false`), `NEXT_PUBLIC_GA_MEASUREMENT_ID`, and the `SHIPPO_FROM_*`/`RESEND_*`/`TRANSACTIONAL_EMAIL_*` values you use.
4. Re-create/verify the Cloudflare Access application protecting `/admin*` and `/api/admin*` (Zero Trust dashboard — **operator step, cannot be proven from the repo**), then set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUDIENCE` (the Access application's AUD tag) and `ADMIN_EMAIL_ALLOWLIST`.
5. Verify the custom domain and cron trigger are attached (dashboard → Worker → Settings → Domains & Routes / Triggers).
6. Re-register nothing at providers unless the public URL changed (Stripe/Twilio webhook URLs are `https://kvrn.shop/...`).
7. Continue at G → H → I → J.

### C.3 Database corruption or accidental destructive change

*Signs:* missing/odd rows, schema objects gone, integrity scan lights up with `EXCEPTION`, a hand-run SQL went wrong.

1. Freeze. **Stop further writes if you can**: freezing checkout stops new reservations/orders, but the webhook, cron and admin still write. Keep the webhook reachable (Stripe will retry failures; the late-payment path handles stragglers — G), but avoid admin writes.
2. **Back up the damaged database now** (D.2) — read-only, extra copy. Also note the exact time of the damaging change; the restore point you choose must be **earlier** than it.
3. Decide the restore point: Neon point-in-time restore / branch from a timestamp *before* the damage (**Neon feature — verify availability and retention window in the Neon console; the repo cannot prove it**), or the latest `pg_dump` you hold.
4. Restore into an **isolated new database/branch** (D.4), validate (D.5–D.6), compare to the damaged copy to see what the restore would lose (D.7). Never restore on top of the only copy.
5. Switch the Worker to the validated database by updating the `DATABASE_URL` secret (C.4 steps), keep the damaged one untouched until the incident is closed.
6. Orders/refunds/disputes after the restore point exist in Stripe but not in the restored DB → D.7 and G.
7. `payment_exceptions`, `financial_integrity_*` and audit logs are append-only by design; a restore that rolls them back loses real history — record in the evidence log what was lost.
8. Continue at I → J. Duplicate-email risk: restored `transactional_emails` rows that were already emailed before the restore point are `sent` and safe; orders re-created *after* it will get new outbox rows and a confirmation email even if the customer already received one from the lost state. Acceptable, but know it (cron runs every 5 minutes as soon as the Worker is up).

### C.4 Lost or rotated database credential

*Signs:* every DB-backed route 500s; admin pages blank; `GET /api/checkout/status?session_id=cs_test_probe0000000001` returns **500** `Status temporarily unavailable.` instead of **404** `not_found`.

1. Freeze checkout. Nothing is wrong with the data — do **not** restore anything.
2. In the Neon console create/rotate the role password or reveal the connection string (**provider dashboard step — verify the current Neon UI**). Neon connection strings contain the password: treat as a secret.
3. `[PRODUCTION – CHANGES STATE]` Update the Worker secret `DATABASE_URL` using the **"Re-entering a secret" block in section F** (getpass → chmod-600 temp file → `npx wrangler secret put DATABASE_URL < /tmp/kvrn-dr-secret-value` → delete the file). `wrangler secret put` takes effect for new requests immediately (it creates a new Worker version).
4. Update your own `PRODUCTION_MIGRATION_URL` source (password manager). Revoke the old credential in Neon once the new one is verified.
5. Verify (`[READ-ONLY]`): the probe above returns **404 not_found**, then `GET /api/admin/dashboard` (through Access) loads.
6. Note: `lib/db.ts` falls back to a placeholder connection string when `DATABASE_URL` is empty (so builds succeed) — an **unset** secret therefore fails at request time, not at deploy time. A deploy succeeding does **not** prove the DB is reachable.

### C.5 Stripe webhook / configuration failure

*Signs:* Stripe dashboard shows failing deliveries (endpoint `https://kvrn.shop/api/stripe/webhook`), payments succeed but no orders appear, `[WEBHOOK]` errors in Worker logs.

Webhook behaviour (`app/api/stripe/webhook/route.ts`): **500** if `STRIPE_WEBHOOK_SECRET` is unset or processing throws; **400** if the `Stripe-Signature` header is missing or the signature is invalid; **200** otherwise (`handled:false` for event types it does not process).

1. Freeze checkout (customers must not pay into a broken pipe).
2. Classify: (a) secret mismatch (wrong mode/endpoint ⇒ **400 Invalid signature** in Stripe's delivery log), (b) secret missing (**500 Webhook not configured**), (c) code/DB error (**500 Processing error**), (d) endpoint URL/events wrong.
3. Fix the cause: re-copy the endpoint's signing secret **of the same mode as `STRIPE_SECRET_KEY`** from the Stripe dashboard into `npx wrangler secret put STRIPE_WEBHOOK_SECRET`; or fix events (the 13 events in G.2); or fix code/DB (C.1 / C.4).
4. Do **not** replay events yet. First read G.4 (replay and idempotency), then resend only the specific failed events, one at a time, watching admin.
5. Check `payment_exceptions` (G.3) and run I.

### C.6 Provider credential loss / rotation (Stripe, Shippo, Resend, Twilio, GA4, Cloudflare API token)

General procedure: rotate/re-issue in the provider dashboard → `npx wrangler secret put <NAME>` → verify with a **non-mutating** check from H → delete the old credential at the provider. Per provider:

| Provider | Secrets to re-enter | Notes |
|---|---|---|
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Key must match `STRIPE_MODE` (`sk_test_`/`sk_live_`); restricted keys unsupported. Rotating the **key** does not change the webhook secret; re-creating the **endpoint** does. |
| Shippo | `SHIPPO_API_TOKEN` | Without it `/api/shipping-rates` returns `unavailable:true` — **checkout has no shipping option** (fail-closed; no static fallback). |
| Resend | `RESEND_API_KEY` (+ `RESEND_MARKETING_API_KEY` if used) | Missing key ⇒ emails fail and stay in the outbox for retry; never blocks payment. |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_AUTH_TOKEN` | `TWILIO_AUTH_TOKEN` validates **inbound webhooks**; an API key secret is not a substitute. Missing token ⇒ webhooks answer **503** (fail-closed). |
| GA4 | `GA4_MEASUREMENT_PROTOCOL_SECRET` (secret), `NEXT_PUBLIC_GA_MEASUREMENT_ID` (public variable) | Loss only disables analytics. |
| Cloudflare API token (operator / nested workflow) | A token with Workers-edit permission, supplied to Wrangler as `CLOUDFLARE_API_TOKEN` for a manual deploy; the nested workflow (inactive, A.0) would read GitHub secrets `CF_API_TOKEN` / `CF_ACCOUNT_ID` | Create/rotate in the Cloudflare dashboard; handle with the getpass pattern (section 0, E.4); never in the repo. |
| Cron/internal | `CRON_SECRET` | Rotating is safe: generate a new random value, `wrangler secret put CRON_SECRET`; the Worker's cron calls itself with the same env, so no external caller needs updating. |

If a secret was **exposed** (pasted into chat, committed, screenshotted) treat it as compromised: rotate at the provider immediately, then update the Worker. Removing it from Git history does not un-expose it.

### C.7 Partial provider outage

KVRN is built to degrade without losing money:

| Provider down | What happens | Action |
|---|---|---|
| **Stripe** API/dashboard | New checkout sessions fail; webhooks delayed | Freeze if sessions fail. After recovery rely on Stripe's delivery retries; run G.3/I. Do not resend events while Stripe is flaky. |
| **Shippo** | `/api/shipping-rates` → `unavailable:true`; checkout cannot choose shipping | Keep checkout closed (or accept no orders). Never add a static rate. |
| **Resend** | Order-confirmation emails fail, retried by cron at 0, +5 min, +30 min, +2 h, +12 h (max 5 attempts); a row stuck `sending` > 15 min becomes retryable | Nothing to do; check outbox afterwards (H.2). |
| **Twilio** | SMS sends fail; marketing sends are additionally gated off by `TWILIO_A2P_APPROVED`/`TWILIO_MARKETING_SEND_ENABLED` (`"false"` in `wrangler.toml`) | Do not flip those flags during recovery. |
| **GA4 / first-party analytics** | Best-effort and hard-bounded (≈2.5 s), **non-fatal to payment** | Ignore until after recovery. |
| **Neon** | Everything DB-backed fails | C.4 / C.3. Do not restore on suspicion — confirm the outage in Neon status first. |
| **Cloudflare** | Whole site down | Nothing to deploy; wait, then C.2 checks. |

### C.8 Suspicious financial mismatch after a restore

*Signs:* reconciliation shows `EXCEPTION`/`INCOMPLETE` after the restore, revenue differs from Stripe, orders missing, inventory off.

1. **Do not edit accounting rows to make numbers match.** Guard triggers (migrations 018–021) deliberately block `UPDATE`/`DELETE`/`TRUNCATE` on money tables (e.g. `expense_transactions`, `ad_spend`, `financial_integrity_runs`, `financial_integrity_events`, paid affiliate payouts) — if SQL you run is rejected by one of those, **stop**; that is the system protecting history.
2. Capture the evidence: export the findings CSV (`GET /api/admin/financials/integrity/export`) and the summary (`GET /api/admin/financials/integrity`) **before** touching anything. Save `financial_integrity_scan()` output.
3. Classify each finding with section I: missing-because-after-restore-point (D.7), missing-because-provider-data-not-yet-fetched (fees: wait for cron), or genuinely inconsistent.
4. Fix at the **source** with audited tools: Stripe-side facts via webhook/cron, costs via the admin endpoints (e.g. `PATCH /api/admin/shipments/<id>/cost`, `POST /api/admin/refunds/<id>/fee-returned`, `POST /api/admin/refunds/<id>/resolve-components`), payment exceptions via `PATCH /api/admin/payment-exceptions/<id>`. Every such change goes in the evidence log with who/why.
5. A finding with `resolution = manual_review` needs a human decision, not an automated fix.
6. Re-run `POST /api/admin/financials/integrity` only to **record** the post-recovery state (it appends to the history; it changes no economic row).

### C.9 GitHub / source loss

1. Find the freshest copy, in order: any developer clone (`git fetch --all`, then `git log -1`), the source ZIPs you archive (verify with `md5sum`/`sha256sum` against the values recorded in your delivery notes), the deployed bundle (**last resort: build output is not source**).
2. Verify the candidate. Seen **from the Git root** (the folder that contains `kvrn/`), it must contain `kvrn/package.json`, `kvrn/package-lock.json`, `kvrn/wrangler.toml`, `kvrn/open-next.config.ts`, `kvrn/cloudflare-cron-wrapper.js` and `kvrn/db/migrations/001`…`022`. Then `cd kvrn` (the app root) **before** any npm/build check, and run the drill checks (type-check/test/build) there before trusting the candidate.
3. **Re-create the repository with the same layout:** Git root = the folder that **contains** `kvrn/`; the app stays in `kvrn/`. Do not flatten the app to the repository root. Push to a non-`main` branch first and verify (E.3) before `main`.
4. **Do not expect CI to deploy.** The nested `kvrn/.github/workflows/deploy.yml` is not loaded by GitHub in this layout (A.0), so a re-created repository will not deploy anything by itself; deployment stays a deliberate operator action from `kvrn/` (E.4). Re-adding GitHub secrets (`CF_API_TOKEN`, `CF_ACCOUNT_ID`) is only needed if someone later moves the workflow to `<repository-root>/.github/workflows/` with adjusted paths — a separate, reviewed change that this recovery does not make. Also re-check the Cloudflare dashboard for any provider-side Git integration that points at the old repository.
5. Never rebuild source from memory of a deployed bundle; never skip type-check/test/build.

### C.10 Accidental environment / configuration drift

*Signs:* checkout opens or closes unexpectedly, wrong Stripe mode, analytics vanish, email "from" changes, SMS gates flip, admin returns 401/403.

1. Freeze checkout. List what is configured **without values**: `[READ-ONLY]` `npx wrangler secret list` (names only). Variables: view in the dashboard (they are not secret, except see F — never screenshot secret fields).
2. Compare against F (expected names) and `wrangler.toml [vars]`.
3. Known drift traps in this repo:
   * `wrangler.toml` has `keep_vars = true`, meaning dashboard variables survive `wrangler deploy`. The toml re-applies its own `[vars]` on every deploy, so **do not set `STRIPE_MODE`/`ENABLE_CHECKOUT` in the toml** (they are dashboard-managed). The repo's own deploy command (`npm run deploy`) deploys the **top-level** config; the `[env.production]` block would only be used by `wrangler deploy --env production` (what the inactive nested workflow would run), and `keep_vars` sits at the top level. **Verify after every deploy that the dashboard-only variables survived** (inheritance into an environment block is not provable from the repo). Consequences if they were dropped are safe: `ENABLE_CHECKOUT` unset ⇒ closed; `STRIPE_MODE` unset ⇒ test ⇒ a live key is rejected; GA id unset ⇒ GA off.
   * The toml's top-level `[vars]` and `[env.production.vars]` are duplicated by hand — keep them identical.
   * `wrangler.toml` comments list secrets the code never reads (`ADMIN_SECRET`, `EMAIL_FROM`, `TWILIO_PHONE_NUMBER`, `ORDERS_EMAIL`, `RETURNS_EMAIL`) and omit ones it does (`TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID`, `CF_ACCESS_*`, `ADMIN_EMAIL_ALLOWLIST`, `RESEND_*`, `SHIPPO_*`). **Use section F, not the toml comments.**
   * The nested (inactive) `kvrn/.github/workflows/deploy.yml` builds with `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and `NEXT_PUBLIC_GA_MEASUREMENT_ID` from GitHub secrets; **neither is read by runtime code** (GA's id is read at request time from the Worker variable). Their absence from GitHub is not an outage.
4. Restore the intended value, record the change, re-run the checks for the affected area (G/H).

---

## D. Database backup and restore

### D.1 Architecture facts that shape the procedure

* The application talks to Neon through the **`@neondatabase/serverless` HTTP driver** with the `DATABASE_URL` secret (`lib/db.ts`). **`pg_dump`, `pg_restore` and `psql` are external operator tools**, not part of the app. They are standard PostgreSQL client tools and are used the same way the repo's own migration headers use `psql` (`psql "$…" -v ON_ERROR_STOP=1 -f …`).
* There is **no migration-tracking table**; migrations are plain SQL files `db/migrations/001_…sql` … `022_late_payment_recovery.sql`, applied by hand in numeric order. Do not assume you can read "the version" from the DB — use the object probes in D.5.
* Several migrations are re-runnable (021 declares itself fully idempotent; 022 uses `IF NOT EXISTS`/`CREATE OR REPLACE`; several say "safe to re-run"), but **do not assume this for the others**. Never apply a migration to production because a restore "looks old" — see D.6.
* Neon features (branching, point-in-time restore, automated backups, retention, pooled vs. direct endpoints) are **provider capabilities the repo does not document**. Treat each as "verify in the Neon console" and record what you verified in the evidence log. Prefer a *direct* (non-pooled) connection for `pg_dump`/`pg_restore` (verify in Neon docs).
* **Version compatibility (PostgreSQL 18 at this baseline):** **Neon production was verified as PostgreSQL 18.6** (operator-verified during the launch work; **re-check the current server version in the Neon console, or with `SELECT version();`, at every incident and every drill — it can change**). Use `pg_dump`/`pg_restore`/`psql` client versions **compatible with the source — at least the source's major version** (`pg_dump --version`; for the current environment that means **PostgreSQL 18 or newer clients**), and restore into a PostgreSQL server of the **same or newer major version — PostgreSQL 18+ for restore validation** here. A **PostgreSQL 16 client or server must not be used as the recovery-validation target for a PG18 production database**, and a restore drill on PG16 does **not** prove a PG18 production restore (a PG16 `pg_restore` can refuse a newer archive, or silently differ in behaviour). The fixture scripts (`scripts/test-020-fixtures.sh`, `scripts/test-021-fixtures.sh`) default to `/usr/lib/postgresql/16/bin` — that is a **legacy local-harness assumption**, not the recovery-version authority; they are not part of any recovery.
* No extensions or roles are created by the migrations (no `CREATE EXTENSION`, `GRANT`, `CREATE ROLE`; `gen_random_uuid()` is used). Restore with `--no-owner --no-privileges` and restore **as the same role the Worker's `DATABASE_URL` uses**, so the app can read the objects.
* Money tables carry guard triggers that **block UPDATE/DELETE/TRUNCATE** (see C.8). A restore therefore must go into an **empty** database. Do **not** use `pg_restore --clean` against a populated database and do **not** use `--disable-triggers` on anything destined for production without a written decision recorded in the evidence log.

### D.2 Pre-recovery backup (always first)

`[READ-ONLY]` against production (a dump only reads). Use a **direct** connection string captured with the secure pattern from section 0 (Python `getpass` → chmod-600 temp file → consumed once → deleted). The dump goes into `EVID_DIR` (section 0), **outside the Git repository**:

```bash
# 0) evidence dir outside any Git repo (block from section 0) - EVID_DIR must be set and confirmed "OK" before continuing

# 1) capture the connection string (hidden)
python3 - <<'PY'
import getpass, os
value = getpass.getpass("SOURCE_URL - Neon direct connection string (hidden): ")
path = "/tmp/kvrn-dr-source-url"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(value)
os.chmod(path, 0o600)
PY

# 2) dump (client must be >= the server major version; the server was PostgreSQL 18.6 at this baseline - re-check).
#    A sha256 / .meta record is written ONLY if pg_dump succeeded; a failed run leaves a quarantined partial file and no success record.
SOURCE_URL="$(cat /tmp/kvrn-dr-source-url)"
BACKUP_STARTED_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"   # non-secret; captured BEFORE pg_dump starts
BACKUP_FILE="$EVID_DIR/kvrn-pre-recovery-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --version
if pg_dump --format=custom --no-owner --no-privileges --file="$BACKUP_FILE" "$SOURCE_URL"; then
  chmod 600 "$BACKUP_FILE"
  sha256sum "$BACKUP_FILE" | tee "$BACKUP_FILE.sha256"
  printf 'backup_started_at_utc=%s\n' "$BACKUP_STARTED_AT_UTC" > "$BACKUP_FILE.meta"
  echo "BACKUP SUCCESS: $BACKUP_FILE (dump started $BACKUP_STARTED_AT_UTC)"
else
  echo "BACKUP FAILURE: pg_dump did not succeed - NO usable backup exists. Do not proceed with destructive steps"
  if [ -e "$BACKUP_FILE" ]; then
    chmod 600 "$BACKUP_FILE"
    mv "$BACKUP_FILE" "$BACKUP_FILE.FAILED-PARTIAL-DO-NOT-USE"
    echo "partial file quarantined as $BACKUP_FILE.FAILED-PARTIAL-DO-NOT-USE (no .sha256 is written)"
  fi
  unset BACKUP_FILE
fi

# clean up the secret material - always, success or failure
unset SOURCE_URL
rm -f /tmp/kvrn-dr-source-url
```

* The dump contains customer PII and money data. Keep it on an encrypted disk in the mode-`700` `EVID_DIR`, **never under the repository root or the app root** (`.gitignore` does not exclude `*.dump`, so a dump inside the working tree could be staged by accident), never in chat/e-mail.
* If the database is partially corrupt and `pg_dump` fails, take what you can (`--table=…` for critical tables, D.3) and capture the error text in the evidence log. A Neon-side snapshot/branch of the damaged state (**verify in the Neon console**) is an equally valid "preserve damaged state" step.
* **Success vs failure.** Only a run that printed `BACKUP SUCCESS` produced a backup: the dump is mode `600`, has a `.sha256` and a `.meta` (the dump **start** time). A run that printed `BACKUP FAILURE` has **no** backup — the partial file (if any) is renamed `*.FAILED-PARTIAL-DO-NOT-USE`, no `.sha256` exists, and `BACKUP_FILE` is unset so later steps cannot pick it up by accident. Never hash, restore from or "repair" a partial dump.
* **What time is this backup?** `BACKUP_STARTED_AT_UTC` (captured immediately **before** `pg_dump` ran) is the backup's **snapshot time**. `pg_dump` reads a single consistent snapshot taken when the dump begins, so its start time is a **conservative lower bound** for what the file contains when no exact provider/database snapshot timestamp is available. Record it with the dump metadata. It is the *restore point* only if you later restore **this** dump; to recover from an older dump or a Neon point-in-time restore, the restore point is that backup's own recorded time (D.5).
* Record: file path, size, sha256, `BACKUP_STARTED_AT_UTC`, source host (not the password), PG versions.

### D.3 Critical tables (from `db/migrations`)

Orders & payments: `orders`, `order_items`, `reservations`, `reservation_items`, `webhook_events`, `payment_exceptions`, `shipments`, `transactional_emails`.
Catalog & inventory: `products`, `product_variants`, `inventory_movements`, `inventory_cost_layers`, `inventory_layer_consumptions`, `inventory_purchases`, `inventory_purchase_payments`, `inventory_batch_receipts`, `inventory_write_offs`, `product_cost_batches`.
Refunds/returns/disputes: `order_refunds`, `order_returns`, `order_return_items`, `order_exchanges`, `order_disputes`, `order_dispute_events`, `order_dispute_financial_adjustments`, `dispute_balance_transactions`, `return_refund_allocations`.
Affiliates: `affiliates`, `affiliate_links`, `affiliate_commissions`, `affiliate_commission_adjustments`, `affiliate_payouts`, `affiliate_payout_lines`, `order_affiliate_attributions`.
Expenses/finance: `expense_definitions`, `expense_transactions`, `ad_spend`, `provider_usage_snapshots`, `discounts`, `discount_redemptions`, `discount_claims`.
Integrity/audit: `financial_integrity_runs`, `financial_integrity_events`, `admin_audit_logs`.
People/analytics: `marketing_subscribers`, `sms_subscribers`, `sms_messages`, `sms_signup_claims`, `analytics_events`, `analytics_sessions`.

There is **no live `payments` table**: migration 002 renames the original `payments`, `orders`, `order_items`, `shipments`, `inventory_reservations` and `checkout_sessions` to `*_legacy_v45`. Those six legacy tables exist on any database built from migration 001 forward, are not referenced by app code, and are part of a full dump — leave them alone (never drop them during a recovery). Payment facts live in `orders` (+ Stripe), `order_refunds`, `order_disputes`, `webhook_events` and `payment_exceptions`.

### D.4 Restore into an isolated database first

Target options (pick one; **never the production database**): a local PostgreSQL ≥ source major version, or a **separate** Neon project/branch created for the recovery (**provider feature — verify in the Neon console**).

`[LOCAL/TEST]` — local server example. Substitute your own local host/port/user; this must **not** be the Neon production endpoint. The local server must be **PostgreSQL 18 or newer** (same-or-newer major than the source; D.1):

```bash
# create an empty database on YOUR LOCAL server
createdb -h localhost -p 5432 -U <LOCAL_USER> kvrn_restore_check
# a LOCAL URL without a password is not a secret: a literal is fine (not exported)
RESTORE_URL="postgresql://<LOCAL_USER>@localhost:5432/kvrn_restore_check"

# fail-fast restore: stop at the first error instead of continuing into a half-restored database
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$RESTORE_URL" "$BACKUP_FILE" \
  && echo "restore finished" || echo "RESTORE FAILED - read the error above; do NOT switch production to this database"
```

If the isolated target is instead a **separate Neon project/branch** (its connection string contains a password), capture it with the secure pattern from section 0 into `/tmp/kvrn-dr-restore-url`, load it with `RESTORE_URL="$(cat /tmp/kvrn-dr-restore-url)"` (not exported), and after the restore and validation run `unset RESTORE_URL; rm -f /tmp/kvrn-dr-restore-url`.

Notes: `pg_restore --exit-on-error` is the fail-fast switch (the psql equivalent for plain-SQL dumps is `-v ON_ERROR_STOP=1`, which is also what every KVRN migration header uses). A plain-SQL dump restores with `psql "$RESTORE_URL" -X -v ON_ERROR_STOP=1 -f <file.sql>`.

### D.5 Schema and data validation (read-only; works on any copy)

Run against `RESTORE_URL` first, later against production once switched. `BEGIN READ ONLY … ROLLBACK` guarantees nothing is written.

**Expected migration level** — a presence probe per migration (there is no tracking table, so this is object-existence evidence, not proof of a clean apply). Every row must be `t` for a database at migration **022**:

```bash
psql "$RESTORE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
WITH probe(mig, marker, present) AS (VALUES
 ('001','tables products, orders, webhook_events, admin_audit_logs',
   to_regclass('public.products') IS NOT NULL AND to_regclass('public.orders') IS NOT NULL
   AND to_regclass('public.webhook_events') IS NOT NULL AND to_regclass('public.admin_audit_logs') IS NOT NULL),
 ('002','table reservations + function reserve_inventory',
   to_regclass('public.reservations') IS NOT NULL
   AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reserve_inventory')),
 ('003','column reservations.customer_email',
   EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' AND column_name='customer_email')),
 ('004','table transactional_emails', to_regclass('public.transactional_emails') IS NOT NULL),
 ('005','function mark_order_shipped',
   EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='mark_order_shipped')),
 ('007','table marketing_subscribers', to_regclass('public.marketing_subscribers') IS NOT NULL),
 ('008','table sms_subscribers', to_regclass('public.sms_subscribers') IS NOT NULL),
 ('009','table discounts', to_regclass('public.discounts') IS NOT NULL),
 ('010','table sms_signup_claims', to_regclass('public.sms_signup_claims') IS NOT NULL),
 ('011','table analytics_events', to_regclass('public.analytics_events') IS NOT NULL),
 ('012','column orders.attribution',
   EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='attribution')),
 ('013','table product_cost_batches', to_regclass('public.product_cost_batches') IS NOT NULL),
 ('014','column orders.stripe_fee_cents',
   EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='stripe_fee_cents')),
 ('015','table order_refunds', to_regclass('public.order_refunds') IS NOT NULL),
 ('016','table expense_transactions', to_regclass('public.expense_transactions') IS NOT NULL),
 ('017','function resolve_cost_batch',
   EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='resolve_cost_batch')),
 ('018','table order_disputes', to_regclass('public.order_disputes') IS NOT NULL),
 ('019','table inventory_cost_layers', to_regclass('public.inventory_cost_layers') IS NOT NULL),
 ('020','table affiliates', to_regclass('public.affiliates') IS NOT NULL),
 ('021','table financial_integrity_runs + function financial_integrity_scan',
   to_regclass('public.financial_integrity_runs') IS NOT NULL
   AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='financial_integrity_scan')),
 ('022','table payment_exceptions + finalize_paid_order references record_payment_exception',
   to_regclass('public.payment_exceptions') IS NOT NULL
   AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='finalize_paid_order'
                 AND pg_get_functiondef(p.oid) LIKE '%record_payment_exception%'))
)
SELECT mig, present, marker FROM probe ORDER BY mig;
ROLLBACK;
SQL
```

* Migration **006** is data-only (it fills product shipping weights/dimensions) and **013/016/etc. may have data you must not "re-seed"** — probe `SELECT count(*) FROM products WHERE shipping_weight_lb IS NULL AND active;` as a sanity check only.
* Any `f` row ⇒ the database is **older than 022** (or damaged). That is a finding to record, not an instruction to run migrations — see D.6.

**Critical-table row counts** — run the same query on the source (or damaged copy) and the restored copy and compare. Differences should be fully explained by the time window between the backup and the damage:

```bash
psql "$RESTORE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SELECT 'orders' AS tbl, count(*) FROM orders
UNION ALL SELECT 'order_items', count(*) FROM order_items
UNION ALL SELECT 'reservations', count(*) FROM reservations
UNION ALL SELECT 'webhook_events', count(*) FROM webhook_events
UNION ALL SELECT 'payment_exceptions', count(*) FROM payment_exceptions
UNION ALL SELECT 'shipments', count(*) FROM shipments
UNION ALL SELECT 'transactional_emails', count(*) FROM transactional_emails
UNION ALL SELECT 'product_variants', count(*) FROM product_variants
UNION ALL SELECT 'inventory_cost_layers', count(*) FROM inventory_cost_layers
UNION ALL SELECT 'inventory_layer_consumptions', count(*) FROM inventory_layer_consumptions
UNION ALL SELECT 'order_refunds', count(*) FROM order_refunds
UNION ALL SELECT 'order_disputes', count(*) FROM order_disputes
UNION ALL SELECT 'affiliate_commissions', count(*) FROM affiliate_commissions
UNION ALL SELECT 'expense_transactions', count(*) FROM expense_transactions
UNION ALL SELECT 'ad_spend', count(*) FROM ad_spend
UNION ALL SELECT 'admin_audit_logs', count(*) FROM admin_audit_logs
UNION ALL SELECT 'financial_integrity_runs', count(*) FROM financial_integrity_runs
UNION ALL SELECT 'financial_integrity_events', count(*) FROM financial_integrity_events
ORDER BY 1;
SELECT 'latest order paid_at' AS what, max(paid_at)::text AS value FROM orders
UNION ALL SELECT 'latest webhook event', max(created_at)::text FROM webhook_events;
ROLLBACK;
SQL
```

**Restore point vs. "latest business records present" — two different things:**

* The **restore point** is the **snapshot/backup point that was actually restored**, and it comes from the backup, not from the data: for a **Neon point-in-time restore / branch**, the **provider restore timestamp you chose** (verify in the Neon console); for a **retained `pg_dump`**, the **recorded dump/snapshot time** — `BACKUP_STARTED_AT_UTC` from D.2 (`.meta`). If no exact snapshot time exists, use the **earlier / more conservative** boundary (a dump start time, or earlier if unsure) rather than risk leaving Stripe events out of reconciliation. A file's modification time is the dump's **end**, not its start — it is **not** a conservative bound on its own. Record it as `RESTORE_POINT_UTC` in the evidence log.
* The two queries above give the **latest business records present in the restored DB**: newest `orders.paid_at` and newest `webhook_events.created_at`. Record them **separately**. They are **sanity signals only** — they do **not** define the snapshot time, and a quiet shop will show values well before the restore point. Use them for plausibility: a value **later** than `RESTORE_POINT_UTC` (allowing for clock skew) means the restore point or the file is not what you think — stop and find out why before continuing.

Stripe activity after `RESTORE_POINT_UTC` is the **reconciliation-risk window**: some provider-side activity may be absent from the restored copy, especially when `RESTORE_POINT_UTC` is intentionally conservative — see D.7. Do **not** assume every Stripe event in that window is missing, or that everything before it is present.

**Quick sanity of inventory and payment state** (read-only):

```bash
psql "$RESTORE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
-- variants whose stock/reserved numbers are impossible (expect 0 rows)
SELECT sku, stock_on_hand, reserved_quantity FROM product_variants
 WHERE stock_on_hand < 0 OR reserved_quantity < 0 OR reserved_quantity > stock_on_hand;
-- reservations by status (long-lived 'creating'/'open'/'awaiting_payment' rows after a restore are suspect)
SELECT status, count(*) FROM reservations GROUP BY status ORDER BY status;
-- payment exceptions by status (open ones need a human; see section G.3)
SELECT status, count(*) FROM payment_exceptions GROUP BY status;
-- webhook events recorded but not marked processed
SELECT count(*) AS unprocessed_webhook_events FROM webhook_events WHERE processed = false;
ROLLBACK;
SQL
```

**Run the financial-integrity scan** on the restored copy (read-only; these SQL functions are `STABLE`):

```bash
psql "$RESTORE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SELECT entity_type, state, count(*) FROM financial_integrity_entity_states() GROUP BY entity_type, state ORDER BY entity_type, state;
SELECT issue_code, state, domain, resolution, count(*) FROM financial_integrity_scan()
 GROUP BY issue_code, state, domain, resolution
 ORDER BY CASE state WHEN 'exception' THEN 0 WHEN 'incomplete' THEN 1 ELSE 2 END, issue_code;
ROLLBACK;
SQL
```

These are the same queries `lib/financial-integrity.ts` runs for the admin summary. Interpretation is in section I. **Do not call `record_financial_integrity_run()` on an isolated copy and then treat its history as production history** — it appends to that database's append-only log.

### D.6 Migrations: when, and when not

* **Restored database is at 022:** apply **nothing**.
* **Restored database is older than 022 (probe shows `f` rows):** the backup predates a migration. First ask *why*: wrong backup? Then prefer a newer backup. If you must proceed, apply only the **missing** migrations, **in numeric order, one at a time, on the isolated copy first**, using the repo's own pattern:

  `[LOCAL/TEST]`
  ```bash
  psql "$RESTORE_URL" -X -v ON_ERROR_STOP=1 -f db/migrations/<NNN_name>.sql
  ```

  Re-run the D.5 probe after each. Only after the isolated copy validates, and a *fresh dump of the copy* is taken, does the same sequence get applied to whatever becomes production (`PRODUCTION_MIGRATION_URL`, per the migration headers).
* Do **not** guess: never run a migration "to see if it fixes things", never hand-write `ALTER`/`DROP`/`UPDATE` to align schemas, never apply a migration a second time unless its header says it is safe to re-run.
* There is **no migration 023** in this baseline. If a recovery seems to require one, stop and escalate; that is a development task, not a recovery step.
* **Never run fixtures or seed data on production.** `db/fixtures/*.sql`, `scripts/test-020-fixtures.sh`, `scripts/test-021-fixtures.sh` create and drop throwaway databases and insert synthetic orders — local only. `db/seed.sql` upserts the D001 catalog with **zero** stock and is not part of recovery; do not run it against a database that holds real data.

### D.7 The "orders after the restore point" gap (the main danger of any restore)

Restoring an older backup creates a **reconciliation-risk window** (**restore point → now**, where the restore point is the **backup/PITR timestamp or conservative lower bound**, D.5) in which Stripe may contain payments, refunds or disputes that are not represented in the restored KVRN database. Some events in a conservatively widened window may already be present; compare by provider/event id rather than assuming absence. In that window customers may also have been emailed, labels may have been bought, and stock may have changed.

1. Establish the window as **`RESTORE_POINT_UTC` (the actual or conservative restore point from D.5) → now**, and list from the Stripe dashboard the payments/refunds/disputes created in that window, in the correct **mode**. The newest `orders.paid_at` / `webhook_events.created_at` in the restored DB are *latest business records present* — sanity signals, **not** the window boundary. If the exact snapshot time is uncertain, **start the window earlier**: events already present are skipped by the idempotency guards (G.4), whereas an event left outside the window is silently lost. Compare each Stripe payment/refund/dispute with the restored DB **by id** instead of assuming everything after `max(paid_at)` is missing.
2. List every Stripe payment in the window. For each, decide: *missing order* (needs the webhook to be re-delivered), *already refunded*, *test-mode noise*.
3. Reprocess **only events confirmed to be missing or otherwise requiring recovery**, through the existing idempotent paths (G.4), **with checkout closed**, **one event at a time**, and read the result in admin after each. A confirmed-missing Stripe event id will not be present in the restored `webhook_events` table, so it will be processed as new — which is exactly what heals the gap, and exactly why blind bulk replay is dangerous (stock may no longer exist → `payment_exceptions`, not an order).
4. Shippo labels bought in the window are **not** in `shipments`: label cost stays UNKNOWN until entered via the admin cost endpoint from the Shippo record.
5. Refunds issued in Stripe in the window flow back through `charge.refunded`/`refund.*` and `record_order_refund` is idempotent per `stripe_refund_id`.
6. Inventory: quantities in the restored DB reflect the restore point, not physical reality. Reconcile against a **physical count** and record differences through the admin inventory functions so cost layers and history stay consistent; this is a business decision — do not edit `stock_on_hand` directly.

### D.8 Switching production to a restored database

Only after D.5 passes and the evidence log has the decision:

1. Take one more dump of the validated restore (it is the new baseline).
2. `[PRODUCTION – CHANGES STATE]` `npx wrangler secret put DATABASE_URL` via the **"Re-entering a secret" block in section F** (the string must point at the **restored** database and role the app should use; the value never appears on a command line).
3. Verify with the C.4 probe (404 `not_found` ⇒ DB reachable), then admin reads, then section I.
4. Keep the damaged database/branch untouched until the incident is closed (L).

---

## E. Code and deployment recovery

### E.1 Pick a known-good commit

`[READ-ONLY]`
```bash
git fetch --all --tags
git log --oneline -n 20
git tag --list
```
Choose the commit that was live *before* the incident (Cloudflare's deployments list, Git history, evidence log). The supplied baseline for this documentation is `97c761a` (`Add consent-gated GA4 ecommerce analytics`). Record the SHA. If no tags exist, create one after recovery succeeds (`git tag recovery-<date>-known-good <sha>`) — tagging changes nothing in production.

### E.2 Clean checkout (Git root, then descend into `kvrn/`)

`[LOCAL/TEST]` Clone **outside** any other working tree (a new, non-existing directory) and **descend into `kvrn/` before any `npm` command**:

```bash
CHECKOUT_DIR="${HOME}/kvrn-recovery-checkout-$(date -u +%Y%m%dT%H%M%SZ)"
git clone <REPO_URL> "$CHECKOUT_DIR"
cd "$CHECKOUT_DIR"                 # <- GIT ROOT (contains kvrn/)
git checkout <KNOWN_GOOD_SHA>
git status --short                 # must print nothing
test -f kvrn/package.json && echo "app root confirmed: kvrn/" || echo "STOP: kvrn/package.json not found - wrong layout/commit"
cd kvrn                            # <- APP ROOT: every npm / wrangler / opennextjs-cloudflare command below runs here
pwd
```
Make sure no `.env*` file holding production secrets is present under `kvrn/` (`.gitignore` excludes `.env`, `.env.local`, `.env.*.local`).

### E.3 Install, typecheck, test, build

The package manager is **npm** (`package-lock.json`; install with `npm ci`; the nested workflow targets Node 20). Scripts that exist in `package.json`: `dev`, `build`, `start`, `lint`, `type-check`, `deploy`, `deploy:preview`, `cf:build`, `test`.

`[LOCAL/TEST]` — run from the **app root `kvrn/`** (E.2), in a shell where `TEST_DATABASE_URL` is **not** set:
```bash
pwd                          # must end in /kvrn  (the folder that contains package.json)
unset TEST_DATABASE_URL      # ALWAYS, before the default regression run - a leftover value changes which suites run
node --version               # the nested workflow targets Node 20
npm ci
npm run type-check           # tsc --noEmit
npm test                     # jest; DB-backed suites skip VISIBLY when TEST_DATABASE_URL is unset
npm run build                # next build
npm run cf:build             # npx opennextjs-cloudflare build  → .open-next/worker.js (required by cloudflare-cron-wrapper.js)
```
`npm test` here is the **non-DB regression pass**. DB-backed suites run only against a confirmed **LOCAL throwaway** PostgreSQL (see the DRILL doc, D5) — set `TEST_DATABASE_URL` for that one command only and `unset` it immediately afterwards; **never Neon/production**.
Do not skip `npm test` for recovery deploys: no CI runs it for you (the only workflow is inactive, A.0), so this is your only automated safety net. The build does not need production secrets (`lib/db.ts` substitutes a placeholder at build time; GA's id is read at request time).

### E.4 Deploy procedure (from the actual config)

* `wrangler.toml`: `main = "cloudflare-cron-wrapper.js"` (wraps `.open-next/worker.js` and adds the scheduled handler), assets from `.open-next/assets`, `compatibility_flags = ["nodejs_compat"]`, custom domain `kvrn.shop`, cron `*/5 * * * *`, `keep_vars = true`.
* **How production is deployed today:** a deliberate, manual deploy **from the app root `kvrn/`** with `npm run deploy` (`npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy`). Preview: `npm run deploy:preview` (`… deploy --env preview`).
* **Not a recovery path:** the nested `kvrn/.github/workflows/deploy.yml` (would run `wrangler deploy --env production` on pushes to `main` and `--env preview` on PRs). GitHub does not load it from that location (A.0). **Do not rely on it**, and do not claim that pushing to `main` deploys. A provider-side Cloudflare Git integration cannot be ruled out from source — **check the Cloudflare dashboard**.
* **Authentication:** the repo does not prescribe how a human authenticates locally; Wrangler supports an interactive login, or an API token in `CLOUDFLARE_API_TOKEN` (the nested workflow also supplies `CLOUDFLARE_ACCOUNT_ID`; `wrangler.toml` already contains the account id, so a local token alone is enough). Use the secure pattern from section 0 — **no shell `read`**, no token on a visible command line, never printed:

  ```bash
  # 1) capture the token (hidden) into a chmod-600 temp file
  python3 - <<'PY'
  import getpass, os
  value = getpass.getpass("CLOUDFLARE_API_TOKEN (hidden): ")
  path = "/tmp/kvrn-dr-cf-token"
  fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
  with os.fdopen(fd, "w") as f:
      f.write(value)
  os.chmod(path, 0o600)
  PY

  # 2) use it for this deploy only (from the app root kvrn/)
  export CLOUDFLARE_API_TOKEN="$(cat /tmp/kvrn-dr-cf-token)"
  npx wrangler whoami            # verify it is the INTENDED account (do not paste this output into chat/tickets)
  # ... perform the intended deploy (below) ...

  # 3) clean up immediately afterwards (also if anything failed)
  unset CLOUDFLARE_API_TOKEN
  rm -f /tmp/kvrn-dr-cf-token
  ```
* **Preview first** if there is any doubt: `[PREVIEW – changes only the `kvrn-preview` worker]` `npm run deploy:preview` deploys the `kvrn-preview` worker (separate name; it has its **own** variables and secrets and does not inherit production's). See J.2 for what preview may be used for.

`[PRODUCTION – CHANGES STATE]` Deploy to production **with `ENABLE_CHECKOUT` still `false`**, from the app root `kvrn/`, between the `whoami` check and the clean-up above:
```bash
npm run deploy
```
(`npm run deploy` deploys the top-level `wrangler.toml` config. After *any* deploy verify domain, cron and variables as below.)

**Do not deploy while checkout is open** unless the deploy *is* the tested fix. A push to `main` is not known to deploy anything (A.0), but treat it carefully anyway and verify in the Cloudflare dashboard that nothing is Git-connected.

### E.5 Preserve variables and secrets across a deploy

* Secrets are stored in Cloudflare, not in the bundle: a normal deploy does not remove them. Confirm names with `[READ-ONLY]` `npx wrangler secret list` (prints names, **not values**).
* `keep_vars = true` keeps dashboard-set variables. Verify after every recovery deploy that `STRIPE_MODE`, `ENABLE_CHECKOUT` (still `false`!) and the GA id are as intended (F.2, F.8).
* Never run a deploy command that takes variable values on the command line.

### E.6 Post-deploy smoke checks

`[READ-ONLY]` (public; none of these change state). `BASE=https://kvrn.shop`:

```bash
BASE=https://kvrn.shop
# site renders
curl -sS -o /dev/null -w "home            HTTP %{http_code}\n" "$BASE/"
# DB reachable through a public route: expect 404 (valid-format unknown session) — 500 means DB/config failure
curl -sS -w "\ncheckout/status  HTTP %{http_code}\n" "$BASE/api/checkout/status?session_id=cs_test_drprobe0000000001"
# checkout is CLOSED: expect 503
curl -sS -o /dev/null -w "checkout/session HTTP %{http_code} (expect 503 while closed)\n" -X POST -H "Content-Type: application/json" -d '{}' "$BASE/api/checkout/session"
# GA runtime config route (public id or null; never a secret)
curl -sS "$BASE/api/analytics/config"
# admin is protected: expect Access redirect/login (302/401/403), NOT 200 JSON
curl -sS -o /dev/null -w "admin api (no auth) HTTP %{http_code}\n" "$BASE/api/admin/dashboard"
# internal routes are closed to the public: expect 401 (no/invalid Bearer) or 503 (CRON_SECRET unset) — never 200
curl -sS -o /dev/null -w "internal retry (no auth) HTTP %{http_code}\n" -X POST "$BASE/api/internal/transactional-email-retry"
```

Also confirm in the Cloudflare dashboard: custom domain `kvrn.shop` is attached to the Worker, the `*/5 * * * *` cron trigger exists (the toml comment says to "enable cron in Cloudflare dashboard after first deployment"), the Worker version/deployment is the intended one. **Inheritance of routes/cron/assets into `[env.production]` is not provable from the repo — verify, do not assume.**

---

## F. Runtime configuration and secrets inventory

Names below were extracted from the code (`process.env.*`), `.env.example` and `wrangler.toml`. **Secret** = Cloudflare encrypted secret (`npx wrangler secret put NAME`, fed from the getpass block in the "Re-entering a secret" paragraph below). **Public** = ordinary Worker variable (visible in dashboard; safe to read, still don't paste into chat unnecessarily).

"Verify without revealing": `[READ-ONLY]` `npx wrangler secret list` shows **names only**. For *behaviour*, use the probes referenced. Never `echo` a secret, never print `env`, never screenshot a secrets/variables page with values revealed.

### F.1 Database
| Name | Type | Purpose | If missing | Verify |
|---|---|---|---|---|
| `DATABASE_URL` | **Secret** | Neon connection string used by `lib/db.ts` | All DB routes fail at request time (placeholder fallback hides it at build) | `secret list` shows the name; `GET /api/checkout/status?session_id=cs_test_drprobe0000000001` ⇒ **404** (500 = bad/missing) |
| `PRODUCTION_MIGRATION_URL`, `TEST_DATABASE_URL` | Operator shell only (not Worker vars) | Migration/test targets named in the repo's migration headers and test harness | n/a | — |

### F.2 Stripe
| Name | Type | Purpose | If missing | Verify |
|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | **Secret** | Stripe API key; must be `sk_test_…` (test) or `sk_live_…` (live) matching `STRIPE_MODE` | Checkout session creation fails; fee reconcile skips (`stripe_unconfigured`) | `secret list`; shape/mode agreement is enforced by `assertStripeKeyForMode` (names the variable, never the value). Provider side: Stripe dashboard in the same mode |
| `STRIPE_WEBHOOK_SECRET` | **Secret** | Signing secret (`whsec_…`) of the endpoint **in the same mode** | Webhook returns **500** `Webhook not configured`; wrong value ⇒ **400** `Invalid signature` | Stripe dashboard → endpoint → recent deliveries show `200` |
| `STRIPE_MODE` | Public (dashboard var) | `test` (default when unset) or `live`; anything else throws | Unset ⇒ test | Dashboard variable value; behaviour: a live key with mode unset is rejected |
| `ENABLE_CHECKOUT` | Public (dashboard var) | Canonical gate; exactly `true` opens | Unset ⇒ **closed** | Dashboard value; `POST /api/checkout/session` ⇒ 503 when closed |
| `ENABLE_STRIPE_TEST_CHECKOUT` | Public (`wrangler.toml` = `"false"`) | Legacy gate, test mode only, ignored when `ENABLE_CHECKOUT` is set | Closed | toml |

### F.3 Cloudflare / admin access
| Name | Type | Purpose | If missing | Verify |
|---|---|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | Secret per `.env.example` (value is a hostname) | JWKS host `https://<team-domain>/cdn-cgi/access/certs` used by `lib/admin-auth.ts` | **All admin API calls 401** (JWT cannot be verified) | Signed-in admin loads `/admin`; unauthenticated `GET /api/admin/dashboard` is 401/403/redirect |
| `CF_ACCESS_AUDIENCE` | Secret | Access application AUD tag the JWT must carry | Admin 401 | same |
| `ADMIN_EMAIL_ALLOWLIST` | Secret | Comma-separated admin emails | Admin 403 for everyone | same |
| `DEV_ADMIN_EMAIL` | **Local only — never in Cloudflare** | Dev bypass (ignored when `NODE_ENV=production`) | — | — |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | **GitHub Actions secrets** (not Worker) | Read only by the nested, **currently inactive** workflow (A.0) | Nothing today (the workflow is not loaded) | GitHub → Settings → Secrets (names only) |

### F.4 Shippo
| Name | Type | Purpose | If missing | Verify |
|---|---|---|---|---|
| `SHIPPO_API_TOKEN` | **Secret** | Live rate lookup (`lib/shippo.ts`) | `/api/shipping-rates` → `unavailable:true`; no shipping option | H.1 |
| `SHIPPO_FROM_STREET1`, `_CITY`, `_STATE`, `_ZIP` | Public/variable (required) | Ship-from address | Same fail-closed behaviour (logs "Missing required SHIPPO_FROM_* configuration") | H.1 |
| `SHIPPO_FROM_NAME`, `_STREET2`, `_COUNTRY`, `_PHONE`, `_EMAIL` | Public/variable (optional; defaults `KVRN`/`US`) | Ship-from details | Defaults | H.1 |

### F.5 Resend (email)
| Name | Type | Purpose | If missing | Verify |
|---|---|---|---|---|
| `RESEND_API_KEY` | **Secret** | Transactional email | Emails stay `pending`/`failed` in `transactional_emails`; **payment unaffected** | H.2 |
| `RESEND_FROM_NAME`, `RESEND_FROM_EMAIL`, `TRANSACTIONAL_EMAIL_FROM`, `TRANSACTIONAL_EMAIL_REPLY_TO`, `SUPPORT_EMAIL` | Public/variable | Sender/reply-to (defaults in code: `KVRN <orders@send.kvrn.shop>`, reply-to `support@kvrn.shop`) | Defaults used | H.2 |
| `RESEND_MARKETING_API_KEY`, `RESEND_MARKETING_SEGMENT_ID`, `RESEND_MARKETING_TOPIC_ID` | Key = **Secret**; ids = variables | Marketing contact sync | Marketing sync does nothing/fails; no effect on orders | H.2 |

### F.6 Twilio
| Name | Type | Purpose | If missing | Verify |
|---|---|---|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID` | Secrets (SID/ids are sensitive) | Sending SMS | `sendSms` returns "not configured"; sign-up still stores consent | H.3 |
| `TWILIO_AUTH_TOKEN` | **Secret** | Validates inbound webhook signatures | `/api/twilio/incoming` and `/status` → **503** (fail-closed) | H.3 |
| `TWILIO_A2P_APPROVED`, `TWILIO_MARKETING_SEND_ENABLED` | Public (`"false"` in toml) | Both must be `true` to send promotional SMS | Marketing SMS off | toml/dashboard — **do not flip during recovery** |
| `SMS_SIGNUP_DISCOUNT_AMOUNT_CENTS`, `NEXT_PUBLIC_KVRN_SMS_NUMBER` | Public (toml) | Sign-up discount and public SMS number | Defaults/blank | toml |

### F.7 Cron / internal auth
| Name | Type | Purpose | If missing | Verify |
|---|---|---|---|---|
| `CRON_SECRET` | **Secret** | Bearer token for `/api/internal/*`; the cron wrapper calls them in-Worker | Internal routes **503**; cron logs "CRON_SECRET is not configured" and skips — no emails retried, fees not reconciled | H.7 |

### F.8 Site URLs, analytics and operational flags
| Name | Type | Purpose | If missing | Verify |
|---|---|---|---|---|
| `SITE_URL`, `NEXT_PUBLIC_SITE_URL` | Public (toml: `https://kvrn.shop`) | Canonical origin for redirects/links | Checkout session creation returns **500** `Server configuration error` | toml; smoke checks |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | Public **runtime** variable (dashboard) | GA4 id served by `/api/analytics/config` | GA off, nothing else | `curl $BASE/api/analytics/config` ⇒ `{"measurementId":"G-…"}` or `null` |
| `GA4_MEASUREMENT_PROTOCOL_SECRET` | **Secret** | Server-side GA4 purchase event | No server-side purchase event; **no payment impact** | `secret list` |
| `NEXT_PUBLIC_CLARITY_PROJECT_ID` | Public | Clarity (ungated in this baseline) | Clarity off | — |
| `NODE_ENV` | Public (toml `production`) | Disables the admin dev bypass | — | toml |
| `TEST_DATABASE_URL`, `DEV_ADMIN_EMAIL` | Local only | Tests/dev | — | never set in Cloudflare |

Anything in `wrangler.toml` comments that is not in this list (`ADMIN_SECRET`, `EMAIL_FROM`, `TWILIO_PHONE_NUMBER`, `ORDERS_EMAIL`, `RETURNS_EMAIL`) is **not read by the code**: do not chase it.

**Re-entering a secret** (`[PRODUCTION – CHANGES STATE]`) — the secure pattern from section 0, feeding Wrangler on **stdin** so the value never appears on a command line. Run from the app root `kvrn/`, one secret at a time; replace `<SECRET_NAME>`:

```bash
# 1) capture (hidden) into a chmod-600 temp file
python3 - <<'PY'
import getpass, os
value = getpass.getpass("<SECRET_NAME> value (hidden): ")
path = "/tmp/kvrn-dr-secret-value"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(value)
os.chmod(path, 0o600)
PY

# 2) hand it to Wrangler on stdin (needs Cloudflare auth - see E.4); nothing is printed
npx wrangler secret put <SECRET_NAME> < /tmp/kvrn-dr-secret-value

# 3) delete the temp file immediately (also if step 2 failed)
rm -f /tmp/kvrn-dr-secret-value
```
Do not use `wrangler secret bulk` with a file of secrets (it leaves a multi-secret file on disk), and do not pass values as arguments. In the sections below, "`npx wrangler secret put <NAME>`" always means this block.

---

## G. Stripe / payment recovery

### G.1 Mode and gate
Section B lists the rules. Before reopening, confirm **all** of: `STRIPE_MODE` is the mode you intend; `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are from that **same mode's** Stripe account view; the Stripe dashboard is viewing that mode; `ENABLE_CHECKOUT` is still `false` until section J. See `STRIPE-LIVE-MODE.md` for the live enable procedure.

### G.2 Webhook endpoint and events
Endpoint: `https://kvrn.shop/api/stripe/webhook` (create **one per mode** in the Stripe dashboard — operator step). Events handled in `app/api/stripe/webhook/route.ts`:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `refund.created`, `refund.updated`, `charge.refund.updated`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`. Any other event type is acknowledged (`200`, `handled:false`).

Healthy = Stripe dashboard shows recent deliveries to that endpoint as **200**, no growing failure list. (Reading delivery status is a Stripe-dashboard step; the repo cannot prove it.)

### G.3 Late payment / payment exceptions
If Stripe reports a **successful** payment that KVRN cannot safely turn into an order (stock gone after a late webhook, no matching reservation, unexpected reservation state), migration 022 records a **`payment_exceptions`** row instead of an order and logs `[WEBHOOK][PAYMENT_EXCEPTION]`. It has **no order**, so it creates no revenue, COGS, fee or affiliate effect. It is **append-only** (`payment_exceptions_no_delete`).

* Review: `GET /api/admin/payment-exceptions` (Access-protected; add `?status=open|resolved|all` only if the route supports it — check the route before relying on a filter). `[READ-ONLY]`
* Resolve only after the real-world action: issue the refund **in Stripe first**, then `PATCH /api/admin/payment-exceptions/<id>` with `{ "resolution": "refunded" | "fulfilled_manually" | "dismissed", "note": "<what you did, e.g. refund id>" }`. A note is required; the change is audited (`resolve_payment_exception()` writes `admin_audit_logs` in the same transaction). Do not resolve a row to make a list shorter.
* **After a restore or an outage, new open exceptions are expected and normal** (late webhooks arriving into a database with different stock). "No *unresolved critical* exceptions caused by the recovery" (J) means each one has been **looked at and either refunded/fulfilled or consciously triaged**, not that there are none.

### G.4 Replay and idempotency
What the repo guarantees:
* `webhook_events.stripe_event_id` is `UNIQUE`; `finalize_paid_order()` / release functions record the event and return `already_processed` for a repeat.
* `orders.stripe_checkout_session_id` is `UNIQUE` (`orders_v49_cs_uq`): one order per checkout session.
* Refunds converge on `record_order_refund` (idempotent per `stripe_refund_id`); disputes on one idempotent, staleness-guarded SQL function; fee capture on `stripe_fee_cents IS NULL`.

What it does **not** guarantee: that replaying an event is *harmless* when the surrounding state changed (restored DB, sold-out stock, refunded in Stripe meanwhile). Therefore:

* Resend a Stripe event only from the Stripe dashboard's event/delivery view (**provider capability — verify the UI**), **one event, then check admin, then the next**.
* Before each: confirm the payment still exists and is not refunded; know what the idempotency keys will do (event id already in `webhook_events`? order for that session already exists?).
* After each: confirm exactly one order (or one `payment_exception`), inventory moved once, one confirmation email queued.

### G.5 NEVER (payment-specific)
* **Do not change `payment_status`/order states by SQL or any tool to "make them match" Stripe.** Missing facts arrive via the webhook paths; contradictory facts are findings (I) to resolve with audited actions.
* **No blind or bulk replay** of every event in a time window.
* **No double refunds:** before refunding a payment exception or order, check Stripe *and* `order_refunds` (`stripe_refund_id`) for an existing refund.
* **No double inventory consumption:** an order's FIFO consumption is recorded in `inventory_layer_consumptions`; do not re-run consumption manually, and do not "re-finalize" an order by hand.
* **No double-counted fees/revenue:** `stripe_fee_cents` is written once, from Stripe's balance transaction, when NULL. Never enter a fee by estimate; never insert an order/payment row by hand.

---

## H. Provider revalidation (safe, repo-supported checks only)

None of these sends a real customer email/SMS or creates an order. Run with checkout **closed**.

### H.1 Shippo
* Config presence: `secret list` shows `SHIPPO_API_TOKEN`; dashboard shows the required `SHIPPO_FROM_*` variables.
* Behaviour: `POST /api/shipping-rates` with a real catalog SKU and a destination returns live rates (`source: shippo`) or `unavailable:true`. This **calls Shippo to quote rates only; it buys no label.** Payload (from the route): `{ "city": "<CITY>", "state": "<ST>", "zip": "<ZIP>", "country": "US", "items": [ { "sku": "<REAL_SKU>", "quantity": 1 } ] }`. Use a real SKU from `product_variants` (the route resolves prices from the DB — this also proves DB reachability).
* `unavailable:true` = missing token/address config or Shippo failure ⇒ **fail validation**; do not reopen.
* Label purchases happen in the Shippo dashboard (`https://apps.goshippo.com/`); costs are entered in KVRN via `PATCH /api/admin/shipments/<id>/cost`. Do not buy labels as a "test".

### H.2 Resend
* Config presence: `secret list` shows `RESEND_API_KEY`.
* Outbox health (read-only SQL, any copy): `SELECT status, count(*) FROM transactional_emails GROUP BY status;` — growing `failed`/`sending` rows after recovery mean the key, sender domain or Resend is unhealthy. Rows retry automatically via cron (max 5 attempts, schedule in C.7).
* Provider side: Resend dashboard (`https://resend.com/overview`) — sender domain verified, recent sends. **Do not** create an order or call the retry route manually just to "see an email"; a real delivery test belongs to J.2 (test mode order to an inbox you control).
* Marketing contact sync (`/api/internal/marketing-sync`) needs `RESEND_MARKETING_*`; it never affects payment.

### H.3 Twilio
* Config presence: `secret list` shows the five Twilio secrets.
* Webhook fail-closed check (`[READ-ONLY]`, unauthenticated, causes no send): `curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://kvrn.shop/api/twilio/status` ⇒ **403** (token present, signature missing/invalid) or **503** (`TWILIO_AUTH_TOKEN` unset). Either way it proves the route is closed to forgeries; **503 means fix the token**.
* Console side: Twilio console (`https://console.twilio.com/`) webhook URLs point at `https://kvrn.shop/api/twilio/incoming` and `/api/twilio/status`; Messaging Service intact. Do not send a test SMS to real customers. A2P/marketing flags stay as they were.

### H.4 GA4
* `curl -sS https://kvrn.shop/api/analytics/config` ⇒ `{"measurementId":"G-…"}` or `{"measurementId":null}`; **never a secret**. Loss = analytics off, nothing else.
* In a browser: GA loads **only after** the visitor accepts analytics and has no Do Not Track / Global Privacy Control. GA failure must never block payment (see J.9). GA4's own UI (DebugView) is a provider step; the repo has no GA reporting API.

### H.5 First-party analytics
* Tables `analytics_events`, `analytics_sessions` (migration 011); API `POST /api/analytics/event`; admin view `GET /api/admin/analytics/funnel`. They are **best-effort and hard-bounded (≈2.5 s), non-fatal to payment**. A broken analytics pipeline is a post-recovery task, not a blocker — **but** confirm it cannot slow the money path (J.9; `lib/__tests__/funnel-analytics-timeout.test.ts` covers the bound).

### H.6 Cloudflare Access / admin
* Unauthenticated: `GET /api/admin/dashboard` ⇒ 401/403 or an Access redirect — **never 200**.
* Authenticated (browser, signed in via Access): `/admin` loads; `GET /api/admin/dashboard`, `GET /api/admin/financials/integrity`, `GET /api/admin/payment-exceptions` return JSON.
* Access application, policy and AUD tag are Zero Trust dashboard objects (operator step). A wrong `CF_ACCESS_AUDIENCE` shows as 401 for everyone. The local dev bypass is disabled when `NODE_ENV=production`.

### H.7 Cron / internal jobs
Three internal routes, all `POST` with `Authorization: Bearer <CRON_SECRET>`, all **fail closed**: **503** if `CRON_SECRET` is unset, **401** if the Bearer is missing, and **401 or 403** if it is wrong (the routes differ slightly):
`/api/internal/transactional-email-retry`, `/api/internal/marketing-sync`, `/api/internal/stripe-fee-reconcile`.
* `[READ-ONLY]` closed-door check (no secret needed): the unauthenticated POST in E.6 ⇒ 401 (or 503 = secret missing ⇒ fix F.7).
* **Do not call these with the real secret by hand during recovery** unless you intend their effect (they send due emails, sync contacts, and write fees). They run automatically every 5 minutes from the Worker's cron (`cloudflare-cron-wrapper.js`, in-Worker calls, no public self-fetch). Evidence of health: Worker logs show `[cron]` lines without errors; `transactional_emails` rows leave `pending`; `orders.stripe_fee_cents` fills in for paid orders older than ~10 minutes.

---

## I. Financial / inventory integrity gate

**UNKNOWN is not ZERO.** A missing Stripe fee, an unresolved cost layer, a label price not yet entered or an unreconciled refund component is *unknown*. The system reports it as `INCOMPLETE`; it must not be displayed, summed or "fixed" as 0. **Never repair accounting records merely to turn reconciliation green.** A green result produced by editing data is worse than an honest `INCOMPLETE`.

### I.1 What exists
* SQL scan functions (migration 021): `financial_integrity_scan()` (union of `fi_scan_orders/refunds/disputes/inventory/affiliates/expenses`), `financial_integrity_entity_states()`, `financial_integrity_findings()`, `record_financial_integrity_run(actor, trigger)`.
* Three states: **RECONCILED** (every required fact known and consistent), **INCOMPLETE** (a required fact unknown/unresolved), **EXCEPTION** (data contradicts an invariant). *Advisories* are disclosed assumptions that never change a state. There is no stored "reconciled" flag: the scan re-derives from authoritative rows every time.
* Admin API (Access-protected, `lib/financial-integrity.ts`): `GET /api/admin/financials/integrity` (summary + findings, filterable), `GET /api/admin/financials/integrity/export` (CSV, one row per current finding, stamped with scan time), `POST /api/admin/financials/integrity` (**records** the scan into the history; touches no economic row). UI: `/admin/financials/integrity`.
* Append-only history: `financial_integrity_runs` and `financial_integrity_events` cannot be updated, deleted or truncated (`financial_integrity_block_mutation`). Money tables for expenses/ad spend, paid affiliate payouts, order COGS snapshots, refund fees and exchange shipping cost are guarded by triggers.

### I.2 The gate, domain by domain
Run `GET /api/admin/financials/integrity` (or the D.5 SQL on a copy), export the CSV, and review **every** `exception` and `incomplete` finding. For each domain also cross-check the independent source named here.

| Domain | What to confirm | Independent cross-check |
|---|---|---|
| **Orders vs payments** | Every paid order has a PaymentIntent/charge; no order without a payment; no payment (in the restore window) without an order or a `payment_exceptions` row | Stripe dashboard payments list (right **mode**); `webhook_events` |
| **Inventory quantities** | No negative or over-reserved variants (D.5 query); reservations not stuck | Physical count; `inventory_movements` |
| **Inventory cost layers** | Layers sum to quantity on hand; consumptions match sold order items; no order item without a COGS snapshot (unknown cost ⇒ INCOMPLETE) | Inventory valuation admin endpoint `GET /api/admin/inventory/valuation`; purchases/receipts |
| **Refunds** | One `order_refunds` row per Stripe refund; refund components resolved; **fee-returned** unknown ⇒ INCOMPLETE until entered | Stripe refunds list; `POST /api/admin/refunds/<id>/fee-returned`, `…/resolve-components` for the audited fix |
| **Disputes** | Dispute state matches Stripe; adjustments recorded once | Stripe disputes list; `GET /api/admin/disputes` |
| **Shipping cost** | Shipment label cost known where a label exists; quote vs actual label source distinguished; missing ⇒ INCOMPLETE | Shippo dashboard; `PATCH /api/admin/shipments/<id>/cost` |
| **Stripe fees** | `stripe_fee_cents` NULL on recent orders is *normal until settlement*; stuck NULL beyond ~10 min + cron cycles is a finding. **Never type a fee in by hand** | Stripe balance transactions; cron `stripe-fee-reconcile` |
| **Affiliate effects** | Commissions consistent with orders, refunds and disputes; paid payouts untouched | `GET /api/admin/affiliates` (admin). `POST /api/admin/affiliates/reconciliation` supplies the verified merchandise split for a *partial* dispute — an audited human input, never something to call to clear a finding; paid payouts are trigger-guarded |
| **Unknown authoritative costs** | Anything `INCOMPLETE` stays labelled unknown in the P&L; do not substitute estimates | Supplier invoices (outside KVRN) |
| **History** | `financial_integrity_runs` / `_events` and `admin_audit_logs` counts ≥ the backup; nothing silently lost | D.5 counts |

### I.3 Rules
* **EXCEPTION** findings block reopening until each is understood and either fixed at the source with an audited action or accepted in writing by the operator as a restore artefact (record in the evidence log).
* **INCOMPLETE** findings that are *purely time-dependent* (fees awaiting settlement) are acceptable if they trend to zero within the cron cycles; findings that are *permanent* (a lost cost) are acceptable only as **explicit, recorded UNKNOWNs** — never zeros.
* Do not run SQL `UPDATE`/`DELETE` against accounting tables to clear a finding. The guards will refuse some; the ones they do not refuse are still off-limits.
* After review, `POST /api/admin/financials/integrity` once to record the post-recovery state in the append-only history.

---

## J. Acceptance criteria — do NOT reopen checkout until ALL are true

Check each, record the result and timestamp in the evidence log.

1. **Database reachable** — `GET /api/checkout/status?session_id=cs_test_drprobe0000000001` ⇒ **404**; admin reads load.
2. **Required migrations present** — D.5 probe shows every row `t` (level **022**), and the database is the intended one (counts/latest timestamps sensible, D.5/D.7).
3. **Admin read paths work** — signed in via Access: `/admin`, `GET /api/admin/dashboard`, `GET /api/admin/inventory`, `GET /api/admin/financials/summary`, `GET /api/admin/financials/integrity`, `GET /api/admin/payment-exceptions` all return data; unauthenticated calls are refused.
4. **Inventory sane** — no negative/over-reserved variants; stock matches a physical spot-check or a documented reconciliation; no long-stuck reservations.
5. **Reconciliation reviewed** — I complete; no unexplained `EXCEPTION`; every `INCOMPLETE` explained as time-dependent or a recorded UNKNOWN.
6. **Stripe mode correct** — `STRIPE_MODE`, key prefix and webhook secret all belong to the intended mode; Stripe dashboard shows the same mode.
7. **Webhook healthy** — endpoint exists for that mode, subscribes to the 13 events, recent deliveries `200`, `STRIPE_WEBHOOK_SECRET` set; replay gap (D.7) closed or consciously triaged.
8. **Shipping validated** — H.1: live rates returned for a real SKU and destination.
9. **Transactional email validated** — H.2: key present, outbox not accumulating failures; a real order-confirmation delivery confirmed in the controlled test.
10. **Analytics cannot block payment** — GA/first-party failures are non-fatal and bounded (≈2.5 s); confirm by the existing tests in the build/test run (E.3) and by the fact that analytics endpoints/GA id being absent does not affect `/api/checkout/session` behaviour.
11. **No unresolved critical payment exceptions caused by the recovery** — every open `payment_exceptions` row triaged (G.3).
12. **Checkout remains disabled until the operator explicitly approves** — `ENABLE_CHECKOUT` is `false`/unset up to this moment; the approval (who, when) is in the evidence log.

### J.2 Controlled checkout validation (only when explicitly approved)

**Never convert the production Worker into a test rig.** Do **not** flip the production Worker from live to test mode (`STRIPE_MODE`, `sk_test_` key, test webhook secret) merely to run a recovery test, and never create test-mode orders in the production database: that pollutes production orders, inventory, email, analytics and financial/reconciliation history and introduces configuration drift.

* **Stripe test-mode end-to-end belongs in a PREVIEW / ISOLATED environment** with an **isolated, non-production database** and a matching **test-mode** Stripe key, **test** webhook endpoint (pointing at the preview URL) and its own secrets. The preview worker is `kvrn-preview` (`npm run deploy:preview`); it does not inherit production's variables or secrets, so set them deliberately. Its database must be a restored/isolated copy (D.4), **never the production database**; never point a test harness or a preview checkout at production data.
* **Production:** keep checkout **closed** until every non-mutating validation (J.1–J.12 and sections G–I) passes.
* **If an actual production checkout must be proven:** it needs **explicit operator approval** (name, time, evidence log) for **ONE real, low-value live order** using the **intended live configuration** (live `STRIPE_MODE`, live key, live webhook secret — no mode flip). Open `ENABLE_CHECKOUT` for the shortest possible time, place the order yourself, then verify the whole real path: webhook `200`, exactly one order, inventory moved once, confirmation email delivered, integrity shows nothing new beyond a fee awaiting settlement, shipping cost expectations. Handle the order (fulfil it, or refund it in Stripe) through the **normal, audited mechanisms** — the refund flows back through the webhook; never edit order/payment rows. This single real order is the comprehensive E2E check, done only after the rest of the system is ready (it matches the KVRN launch plan).
* **Reopen:** set `ENABLE_CHECKOUT` = `true` (dashboard), record the timestamp, watch the first real orders end to end, keep this runbook open for 24 h. If anything looks wrong: set `ENABLE_CHECKOUT` = `false` first, investigate second.

---

## K. Evidence log (copy per incident; keep it OUT of the repo, e.g. a private doc)

```
INCIDENT ID / TITLE:
Operator(s):
Incident start time (UTC):            Detected by / how:
Symptoms (what, where, error text — no secrets, no customer PII):
Failure class (C.1–C.10):
Suspected cause:
Last known-good commit / tag:         Bad commit / deploy (if any):
Checkout disabled at (UTC):           Method (dashboard var / other):
Backup identifier / path / sha256:    BACKUP_STARTED_AT_UTC (dump start):   pg_dump version / source server version:
pg_dump outcome (BACKUP SUCCESS / BACKUP FAILURE; if FAILURE: no backup, partial quarantined?):
Database restore target (isolated DB/branch name, host only):
RESTORE_POINT_UTC (Neon PITR timestamp, or dump start time; earlier/conservative if unsure) and its source:
Latest business records present in restored DB (sanity signals, NOT the restore point):  max(orders.paid_at) ______   max(webhook_events.created_at) ______
Reconciliation gap window (RESTORE_POINT_UTC -> now):
Migration level (D.5 result):         Row-count comparison saved at:
Config changes made (names only, who, when, why):   (never values)
Secrets rotated (names only):
Provider checks (Stripe / Shippo / Resend / Twilio / GA4 / Access / cron) — result + time:
Tests run (type-check / npm test / build) — result + commit:
Reconciliation results (EXCEPTION / INCOMPLETE counts before and after; CSV saved at):
Payment exceptions triaged (ids, resolutions):
Stripe replay actions (event id, time, result):
Data loss accepted (what, by whom):
J-criteria checklist result:          Operator approval to reopen (who, UTC):
Checkout enabled at (UTC):            Checkout disabled again at (UTC, if any):
Outcome:                              Follow-ups / doc updates required:
Evidence retained until (incident closed date):
```

---

## L. NEVER DO THIS

1. **Never run fixtures or tests against production.** `db/fixtures/*`, `scripts/test-020-fixtures.sh`, `scripts/test-021-fixtures.sh` and the jest DB harness (`lib/__tests__/helpers/fi-pg.ts`, which `CREATE`s/`DROP`s databases) are local-only. `db/seed.sql` is not a recovery tool.
2. **Never guess a destructive migration.** No hand-written `DROP`/`ALTER`/`UPDATE` to "align" schemas; no re-running migrations whose headers do not say they are re-runnable; no migration 023.
3. **Never dump secrets.** No `env`, `printenv`, `echo $SECRET`, `wrangler secret` values, screenshots of revealed variables, secrets in tickets/chat/commits/shell history/CI logs. Rotate anything that leaked.
4. **Never replay webhooks blindly.** One event, verified, then the next (G.4).
5. **Never mutate accounting without an audit trail.** Use the admin endpoints that write `admin_audit_logs`; no raw SQL on money tables; no deleting or "fixing" `financial_integrity_*` history.
6. **Never enable checkout before verification** (J) and operator approval; never flip `ENABLE_CHECKOUT` to `true` as a way to "test whether it works".
7. **Never treat unknown as zero** — not a fee, a cost, a label price, a refund component.
8. **Never delete evidence or backups before the incident is closed** — including the damaged database/branch, Worker logs you exported, dumps, Stripe event lists, and this evidence log.
9. **Never deploy production while checkout is open** unless the deploy is the tested fix (passed `type-check`, `npm test`, `build` from `kvrn/`). Do not assume a push to `main` is harmless **or** that it deploys: the nested workflow is inactive (A.0), but a provider-side Git integration cannot be ruled out — check the Cloudflare dashboard.
10. **Never restore over the only copy**, never `pg_restore --clean` into a populated database, never `--disable-triggers` on production-bound data without a recorded decision.
11. **Never point `TEST_DATABASE_URL` at Neon/production**, and never reuse `DATABASE_URL` as the migration URL (`PRODUCTION_MIGRATION_URL` exists to keep them separate).
12. **Never flip `TWILIO_A2P_APPROVED` / `TWILIO_MARKETING_SEND_ENABLED` or Stripe mode as part of a recovery** unless that *is* the recovery and it is written in the evidence log. **Never switch the production Worker to Stripe test mode, or write test-mode orders into the production database, to "test" a recovery** (J.2).
13. **Never use the shell `read` builtin (in any silent-prompt form) to capture a secret**, never put a secret on a visible command line, and never store a dump or evidence under the Git repository or app root (section 0).

---

## M. Discrepancies found while writing this runbook (repo ⇄ reality)

These were found by auditing commit `97c761a` and the operator's later observations. None was changed (this task is documentation-only); each is handled above.

| # | Finding | Where handled |
|---|---|---|
| 1 | `wrangler.toml` comments list secrets the code never reads (`ADMIN_SECRET`, `EMAIL_FROM`, `TWILIO_PHONE_NUMBER`, `ORDERS_EMAIL`, `RETURNS_EMAIL`) and omit ones it needs (`TWILIO_API_KEY_SID/SECRET`, `TWILIO_MESSAGING_SERVICE_SID`, `CF_ACCESS_*`, `ADMIN_EMAIL_ALLOWLIST`, `SHIPPO_*`, `RESEND_*`, `STRIPE_*`) | F |
| 2 | `kvrn/.github/workflows/deploy.yml` passes `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and `NEXT_PUBLIC_GA_MEASUREMENT_ID` at build, but no runtime code reads either (the GA id is a runtime Worker variable) | C.10 |
| 3 | The Git root is **one level above** the app; the app root is `kvrn/`. The workflow file is `kvrn/.github/workflows/deploy.yml` (nested), which GitHub does **not** load (only `<repository-root>/.github/workflows/` is). Its `working-directory: ./kvrn` would be right only if it were at the root | A.0, C.9, E.2 |
| 4 | **Correction from the first draft:** pushing to `main` does **not** deploy in the current layout (nested workflow inactive; `c046449` and `97c761a` were pushed without deploying). Production is deployed manually from `kvrn/` with `npm run deploy`. A provider-side Git integration cannot be ruled out from source — verify in Cloudflare. (If the workflow were ever activated it would run `type-check` and a build but **not** `npm test`.) | A.0, C.1, E.4, L |
| 5 | `keep_vars = true` is top-level only; whether dashboard variables, routes, cron and assets carry into an environment block (`--env production`/`--env preview`) is **not provable from the repo** | C.10, E.6 |
| 6 | `README.md` still describes Next.js 14 / Cloudflare Pages (stale). Authoritative sources for recovery are this runbook, `STRIPE-LIVE-MODE.md`, `.env.example` and the config files | — |
| 7 | There is no migration-tracking table; expected migration level can only be inferred by object probes | D.5 |
| 8 | Snippets never call `exit` (it would close an interactive shell) and never use shell `read` for secrets (known to misbehave in the operator's Codespaces terminal); failure branches print a message, secrets use `getpass` + a chmod-600 temp file | 0 |
| 9 | Neon, Cloudflare rollback and Stripe event-resend features are provider capabilities the repo does not document; each is marked *verify in the provider dashboard* | C, D, G |
| 10 | The repo has no automated backup, restore script or backup dashboard (explicitly out of scope). Backups depend on Neon's own features and operator-run `pg_dump` | D |
| 11 | The fixture scripts default to PostgreSQL 16 paths (`/usr/lib/postgresql/16/bin`); production was verified as **PostgreSQL 18.6**. The scripts are a legacy local harness, not the recovery-version authority; recovery/restore validation uses PostgreSQL 18+ and the version is re-checked at runtime | D.1, DRILL |
| 12 | `lib/__tests__/reservations.test.ts` reaches `TEST_DATABASE_URL` through the Neon HTTP driver, so it cannot run its integration cases against a plain local PostgreSQL; the default regression run therefore starts with `unset TEST_DATABASE_URL` | E.3, DRILL D5 |
