# KVRN Disaster-Recovery Checklist

Fast, tick-the-box version of [`DISASTER-RECOVERY.md`](DISASTER-RECOVERY.md) (the **runbook** — section letters below, e.g. "D.5", refer to it). Baseline `97c761a`, migrations `001`–`022`.
Copy this file per incident; **do not commit filled-in copies** (they hold timestamps and operator names, never secrets).

**Prime directives:** checkout stays **closed** · back up before you repair · **UNKNOWN is not ZERO** · no secret in Git / docs / shell history / screenshots / chat · no blind replay.

**Command labels:** `[READ-ONLY]` safe anywhere · `[LOCAL/TEST]` your machine or a throwaway DB only — **never production** · `[PRODUCTION – CHANGES STATE]` changes production; log it in the evidence log first.
Shell is bash; no snippet calls `exit`.
**Layout:** the Git root is one level **above** the app (Codespace: `/workspaces/KVRN-`); the **app root is `kvrn/`**. `git` commands run at the Git root; **`npm` / `npx wrangler` / `npx opennextjs-cloudflare` and all `db/...` paths run in `kvrn/`**.
**Secrets** never use the shell `read` builtin: capture with the **Python `getpass` → chmod-600 temp file** pattern (runbook section 0), consume without printing, then `unset` the variable and `rm -f` the temp file. **Dumps/evidence go in `$EVID_DIR` OUTSIDE the Git repo** (created below).

```
Incident: ____________________  Operator: ____________  Start (UTC): ______________________
Last known-good commit: ______________  Backup path / sha256: ______________________________
BACKUP_STARTED_AT_UTC: ______________  RESTORE_POINT_UTC: ______________
```

---

## 1. IMMEDIATE CONTAINMENT  (runbook B, steps 1–3)

- [ ] Note the time (UTC) and start the evidence log (runbook K).
- [ ] **Close checkout:** Cloudflare dashboard → the `kvrn` Worker → Settings → Variables → `ENABLE_CHECKOUT` = `false` (exact string; anything other than `true` is closed). Do **not** rely on a deploy to do this.
- [ ] Confirm it is closed — expect **HTTP 503**: `[READ-ONLY]`
  ```bash
  curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X POST -H "Content-Type: application/json" -d '{}' https://kvrn.shop/api/checkout/session
  ```
- [ ] Remember: sessions created before the freeze can still be paid for ≈ **31 minutes**. **Keep the Stripe webhook endpoint up** during that window.
- [ ] Tell everyone: **no production deploys** except the tested fix. Treat pushes to `main` carefully. The repo's only workflow is nested under `kvrn/.github/` and GitHub does **not** load it, so a push is *not known* to deploy (runbook A.0) — but **check the Cloudflare dashboard** (the `kvrn` Worker's deployments/settings) for any provider-side Git integration that could.
- [ ] Do **not** delete anything (logs, branches, databases, dumps).
- [ ] Save evidence: Cloudflare Worker logs/deployments, Stripe webhook delivery status, Neon console state, failing commit SHA. (Worker deployments: `[READ-ONLY]` `npx wrangler deployments list` — not referenced by the repo; check `--help`.)

## 2. IDENTIFY FAILURE TYPE  (runbook C)

Tick the one that fits, then follow its mini-runbook; if unsure, keep checkout closed and gather evidence.

- [ ] C.1 Bad deploy / regression (started right after a manual `npm run deploy`, or a deployment in the Cloudflare dashboard you did not make)
- [ ] C.2 Worker / configuration loss (Worker, vars, secrets, domain, cron or Access app missing)
- [ ] C.3 Database corruption / destructive change (missing rows, odd data, integrity `EXCEPTION`s)
- [ ] C.4 Lost / rotated DB credential (all DB routes 500; data is fine)
- [ ] C.5 Stripe webhook / config failure (payments succeed, orders don't appear; Stripe shows failing deliveries)
- [ ] C.6 Provider credential loss / rotation
- [ ] C.7 Partial provider outage (check the provider's status page first)
- [ ] C.8 Suspicious financial mismatch after a restore
- [ ] C.9 GitHub / source loss
- [ ] C.10 Environment / config drift

Quick DB-reachability probe — **404 `not_found` = DB reachable; 500 = DB/config failure**: `[READ-ONLY]`
```bash
curl -sS -w "\nHTTP %{http_code}\n" "https://kvrn.shop/api/checkout/status?session_id=cs_test_drprobe0000000001"
```
- [ ] Probe result: __________  (404 ⇒ do **not** restore the database — look elsewhere.)

## 3. BACK UP CURRENT STATE  (runbook D.2)

Do this **before any destructive step**, even if the database looks broken.

- [ ] Work on an encrypted, single-user machine. Dumps contain customer PII + money data and **must never sit under the Git repo or the app root** (`.gitignore` does not exclude `*.dump`). Create the evidence folder **outside** any repo (and let the check confirm it): `[LOCAL/TEST]`
  ```bash
  EVID_DIR="${HOME}/kvrn-dr-evidence/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$EVID_DIR" && chmod 700 "${HOME}/kvrn-dr-evidence" "$EVID_DIR"
  git -C "$EVID_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && echo "STOP: $EVID_DIR is inside a Git repository - set EVID_DIR to a path outside it" \
    || echo "evidence dir OK (outside any Git repo): $EVID_DIR"
  ```
  (Any explicit operator-chosen encrypted location outside the repo is equally fine — set `EVID_DIR` to it.)
- [ ] `[READ-ONLY]` against production — dump the current (damaged) database. Capture the Neon **direct** connection string with `getpass` (hidden) into a chmod-600 temp file:
  ```bash
  python3 - <<'PY'
  import getpass, os
  value = getpass.getpass("SOURCE_URL - Neon direct connection string (hidden): ")
  path = "/tmp/kvrn-dr-source-url"
  fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
  with os.fdopen(fd, "w") as f:
      f.write(value)
  os.chmod(path, 0o600)
  PY
  ```
  Dump (client major version must be ≥ the server's; production was **PostgreSQL 18.6** at this baseline — **re-check** in the Neon console). The `if` block records a `.sha256`/`.meta` and prints `BACKUP SUCCESS` **only** if `pg_dump` succeeded; on failure it prints `BACKUP FAILURE`, quarantines any partial file and writes **no** success record. The clean-up lines always run:
  ```bash
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
- [ ] **Tick only if the block above printed `BACKUP SUCCESS`** (a `.sha256` exists next to the dump): backup path + sha256 + `BACKUP_STARTED_AT_UTC` + server/`pg_dump` versions recorded. If it printed `BACKUP FAILURE`, leave this box **unticked** — there is no backup. (`pg_dump` major version must be ≥ the Neon server's: **PostgreSQL 18.6** at this baseline → use **18+** clients; re-check the live version.)
- [ ] If `pg_dump` failed (`BACKUP FAILURE`), do **not** treat the quarantined partial file as a backup; snapshot/branch the damaged state in the Neon console — **provider feature, verify in the console** — and record the error text.
- [ ] Export what the admin sees: `GET /api/admin/financials/integrity/export` (CSV) saved to `$EVID_DIR` (signed in via Cloudflare Access).

## 4. DATABASE RECOVERY  (runbook D)  — skip if C.4 / C.7 / C.10 or the DB is fine

Restore into an **isolated** database first. Never onto the only copy.

- [ ] **Restore point** chosen and recorded as `RESTORE_POINT_UTC` = __________ — the Neon point-in-time/branch timestamp you picked (**verify availability in the console**), or the retained dump's recorded `BACKUP_STARTED_AT_UTC` (earlier/conservative if the exact snapshot time is unknown). It must be **earlier than the damage**.
- [ ] Local server version check — restore validation uses **PostgreSQL 18 or newer** (production was 18.6; a PG16 restore does **not** validate a PG18 production restore; re-check the live Neon version). `[READ-ONLY]`
  ```bash
  psql -h localhost -p 5432 -U <LOCAL_USER> -d postgres -Atc "SHOW server_version"
  pg_restore --version
  ```
- [ ] Create an **empty** isolated target (local PostgreSQL 18+, or a separate Neon project/branch). `[LOCAL/TEST]`
  ```bash
  createdb -h localhost -p 5432 -U <LOCAL_USER> kvrn_restore_check
  RESTORE_URL="postgresql://<LOCAL_USER>@localhost:5432/kvrn_restore_check"
  ```
  (A password-less LOCAL URL is not a secret; a literal is fine. For an isolated **Neon** target, capture its URL with the `getpass` pattern into `/tmp/kvrn-dr-restore-url`, load it with `RESTORE_URL="$(cat /tmp/kvrn-dr-restore-url)"`, and `unset RESTORE_URL; rm -f /tmp/kvrn-dr-restore-url` when done.)
- [ ] Restore with fail-fast. `[LOCAL/TEST]`
  ```bash
  pg_restore --no-owner --no-privileges --exit-on-error --dbname="$RESTORE_URL" "$BACKUP_FILE" \
    && echo "restore finished" || echo "RESTORE FAILED - do NOT switch production to this database"
  ```
- [ ] Migration level = **022** (every row `t`) using the probe in **runbook D.5**: `[READ-ONLY]` `psql "$RESTORE_URL" -X -v ON_ERROR_STOP=1 <<'SQL' … SQL` (copy the whole block from D.5).
- [ ] Critical-table row counts compared with the damaged copy (D.5); differences fully explained by the time window.
- [ ] Inventory sanity query returned **0 impossible variants** (D.5). Reservations by status look sane.
- [ ] Integrity scan on the restore reviewed (D.5, read-only): `financial_integrity_entity_states()` / `financial_integrity_scan()`.
- [ ] **Latest business records present** in the restored DB (sanity signals only — **not** the restore point): `max(orders.paid_at)` = __________ · `max(webhook_events.created_at)` = __________ (neither should be later than `RESTORE_POINT_UTC`). The **gap window** is `RESTORE_POINT_UTC` → now (D.7).
- [ ] Migrations: **none applied** if at 022. If older: ask why (wrong backup?) before anything else; apply only missing ones, in order, one at a time, **on the isolated copy first** (D.6).
- [ ] Switch production to the validated DB only now — see **DANGER ZONE A** below.

> ### DANGER ZONE A — database cut-over  `[PRODUCTION – CHANGES STATE]`
> - [ ] Fresh dump of the *validated* restore taken (new baseline).
> - [ ] Decision + operator name in the evidence log.
> - [ ] Set `DATABASE_URL` with the **getpass → chmod-600 temp file → `npx wrangler secret put DATABASE_URL < /tmp/kvrn-dr-secret-value` → `rm -f`** block (runbook F, "Re-entering a secret"), from `kvrn/`. Takes effect immediately for new requests.
> - [ ] Re-run the DB-reachability probe from section 2 → **404**.
> - [ ] Damaged DB/branch **left untouched** until the incident is closed.
> - ❌ Never: `pg_restore --clean` into a populated DB · `--disable-triggers` · fixtures · `db/seed.sql` · hand-written `ALTER/DROP/UPDATE` · "migration 023".

## 5. APP / DEPLOYMENT RECOVERY  (runbook E)

- [ ] Known-good commit/tag identified: __________ (Git history + Cloudflare deployments list).
- [ ] Clean checkout — **Git root first, then descend into `kvrn/`** before any `npm` command. `[LOCAL/TEST]`
  ```bash
  CHECKOUT_DIR="${HOME}/kvrn-recovery-checkout-$(date -u +%Y%m%dT%H%M%SZ)"
  git clone <REPO_URL> "$CHECKOUT_DIR"
  cd "$CHECKOUT_DIR"                 # GIT ROOT (contains kvrn/)
  git fetch --all --tags
  git log --oneline -n 20
  git checkout <KNOWN_GOOD_SHA>
  git status --short                 # must print nothing
  test -f kvrn/package.json && echo "app root confirmed: kvrn/" || echo "STOP: kvrn/package.json not found - wrong layout/commit"
  cd kvrn                            # APP ROOT: npm / wrangler / opennextjs-cloudflare run here
  pwd
  ```
  No `.env*` file with production secrets under `kvrn/`.
- [ ] Install, typecheck, test, build — from `kvrn/` (npm; Node 20 is what the nested workflow targets). `[LOCAL/TEST]`
  ```bash
  pwd                      # must end in /kvrn
  unset TEST_DATABASE_URL  # ALWAYS before the default regression run
  node --version
  npm ci
  npm run type-check
  npm test
  npm run build
  npm run cf:build
  ```
  (This is the **non-DB** regression pass; DB-backed suites skip visibly. DB suites run only against a confirmed **local** throwaway PostgreSQL, with `TEST_DATABASE_URL` set for that one command and `unset` right after — see the DRILL doc, D5. **Never Neon/production.**)
- [ ] All green. If not: stop, do not deploy that commit.
- [ ] Optional preview rehearsal `[PREVIEW – changes only kvrn-preview]`, from `kvrn/`: `npm run deploy:preview` (the preview worker has its own variables/secrets; it must **never** be pointed at the production database).

> ### DANGER ZONE B — production deploy  `[PRODUCTION – CHANGES STATE]`
> - [ ] `ENABLE_CHECKOUT` is **still `false`** (re-check with the 503 probe).
> - [ ] You are in the **app root `kvrn/`** of the clean checkout (`pwd`).
> - [ ] Capture the Cloudflare API token with `getpass` into a chmod-600 temp file (no shell `read`):
>   ```bash
>   python3 - <<'PY'
>   import getpass, os
>   value = getpass.getpass("CLOUDFLARE_API_TOKEN (hidden): ")
>   path = "/tmp/kvrn-dr-cf-token"
>   fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
>   with os.fdopen(fd, "w") as f:
>       f.write(value)
>   os.chmod(path, 0o600)
>   PY
>   export CLOUDFLARE_API_TOKEN="$(cat /tmp/kvrn-dr-cf-token)"
>   npx wrangler whoami
>   ```
>   `wrangler.toml` already holds the account id. Confirm `whoami` shows the **intended** account (do not paste its output anywhere).
> - [ ] `npm run deploy`  (production is deployed **deliberately from `kvrn/`**; the nested workflow is inactive)
> - [ ] Clean up **immediately**, even if the deploy failed:
>   ```bash
>   unset CLOUDFLARE_API_TOKEN
>   rm -f /tmp/kvrn-dr-cf-token
>   ```
> - [ ] Deploy logged (commit SHA, time) in the evidence log.
> - ❌ Never deploy with checkout open unless this deploy *is* the tested fix. Never assume a push to `main` is harmless — or that it deploys: verify in the Cloudflare dashboard (runbook A.0).

- [ ] Smoke checks `[READ-ONLY]` (all public, none change state):
  ```bash
  BASE=https://kvrn.shop
  curl -sS -o /dev/null -w "home              HTTP %{http_code}\n" "$BASE/"
  curl -sS -w "\ncheckout/status    HTTP %{http_code}  (expect 404)\n" "$BASE/api/checkout/status?session_id=cs_test_drprobe0000000001"
  curl -sS -o /dev/null -w "checkout/session   HTTP %{http_code}  (expect 503 while closed)\n" -X POST -H "Content-Type: application/json" -d '{}' "$BASE/api/checkout/session"
  curl -sS "$BASE/api/analytics/config"
  curl -sS -o /dev/null -w "admin (no auth)    HTTP %{http_code}  (expect 302/401/403, never 200)\n" "$BASE/api/admin/dashboard"
  curl -sS -o /dev/null -w "internal (no auth) HTTP %{http_code}  (expect 401; 503 = CRON_SECRET missing)\n" -X POST "$BASE/api/internal/transactional-email-retry"
  ```
- [ ] Cloudflare dashboard: custom domain `kvrn.shop` attached · cron trigger `*/5 * * * *` present · Worker version is the intended one. (Carry-over of routes/cron/vars into `--env production` is **not provable from the repo** — look.)

## 6. CONFIG / SECRET RECOVERY  (runbook F)

- [ ] List secret **names only**: `[READ-ONLY]` `npx wrangler secret list`
- [ ] Compare with the expected names (runbook F). Expected secrets: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUDIENCE`, `ADMIN_EMAIL_ALLOWLIST`, `SHIPPO_API_TOKEN`, `RESEND_API_KEY`, `RESEND_MARKETING_API_KEY` (if marketing sync used), `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_AUTH_TOKEN`, `GA4_MEASUREMENT_PROTOCOL_SECRET`, `CRON_SECRET`.
  *(Ignore `ADMIN_SECRET`, `EMAIL_FROM`, `TWILIO_PHONE_NUMBER`, `ORDERS_EMAIL`, `RETURNS_EMAIL` from the `wrangler.toml` comments — the code never reads them.)*
- [ ] Dashboard-managed **variables** verified (view only; do not screenshot with secrets revealed): `STRIPE_MODE` = intended (`test`/`live`, nothing else) · `ENABLE_CHECKOUT` = `false` · `NEXT_PUBLIC_GA_MEASUREMENT_ID` set or deliberately absent · `SHIPPO_FROM_STREET1/CITY/STATE/ZIP` present · `SITE_URL` / `NEXT_PUBLIC_SITE_URL` = `https://kvrn.shop` · `TWILIO_A2P_APPROVED` / `TWILIO_MARKETING_SEND_ENABLED` unchanged (`"false"` in `wrangler.toml`).
- [ ] Key/mode agreement: `STRIPE_SECRET_KEY` prefix and `STRIPE_WEBHOOK_SECRET` belong to the **same** mode as `STRIPE_MODE` and as the mode shown in the Stripe dashboard.

> ### DANGER ZONE C — re-entering a secret  `[PRODUCTION – CHANGES STATE]`
> - [ ] Value comes from your password manager / the provider dashboard — **never** from a doc, chat or the repo.
> - [ ] From `kvrn/`, one secret at a time, logged by **name** only: `getpass` → chmod-600 temp file → `npx wrangler secret put <NAME> < /tmp/kvrn-dr-secret-value` → `rm -f /tmp/kvrn-dr-secret-value` (exact block: runbook F, "Re-entering a secret"). Needs Cloudflare auth as in DANGER ZONE B.
> - [ ] If a secret was exposed anywhere: **rotate it at the provider now**, then update the Worker.
> - ❌ Never `echo`/print a secret, never `printenv`/`env`, never the shell `read` builtin, never `wrangler secret bulk` from a file, never pass a value as a command argument.

## 7. PROVIDER VALIDATION  (runbook G, H)

Checkout still **closed**. Nothing here sends a customer email/SMS or creates an order.

**Stripe**
- [ ] Webhook endpoint `https://kvrn.shop/api/stripe/webhook` exists **in the intended mode** and subscribes to all 13 events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `refund.created`, `refund.updated`, `charge.refund.updated`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`.
- [ ] Stripe dashboard → endpoint → recent deliveries are **200** (500 = secret missing or processing error; 400 = invalid signature ⇒ wrong-mode secret).
- [ ] Gap window (`RESTORE_POINT_UTC` → now; start earlier if unsure): payments/refunds/disputes in Stripe missing from KVRN **listed**, compared by id — not assumed from `max(paid_at)` (runbook D.7). **No replay yet.**
- [ ] `GET /api/admin/payment-exceptions?status=open` reviewed (signed in via Access).

**Shippo** (H.1)
- [ ] `npx wrangler secret list` shows `SHIPPO_API_TOKEN`.
- [ ] Quote check (quotes rates only, buys **no** label) — use a real SKU: `[READ-ONLY]`-equivalent
  ```bash
  curl -sS -X POST -H "Content-Type: application/json" \
    -d '{"city":"<CITY>","state":"<ST>","zip":"<ZIP>","country":"US","items":[{"sku":"<REAL_SKU>","quantity":1}]}' \
    https://kvrn.shop/api/shipping-rates
  ```
  Expect rates with `"source":"shippo"`. `"unavailable":true` ⇒ **fail**.

**Resend** (H.2)
- [ ] `RESEND_API_KEY` present; sender domain verified in the Resend dashboard.
- [ ] Outbox not piling up (read-only, on the live DB or a copy): `SELECT status, count(*) FROM transactional_emails GROUP BY status;`

**Twilio** (H.3)
- [ ] Five Twilio secrets present; console webhook URLs point at `https://kvrn.shop/api/twilio/incoming` and `/api/twilio/status`.
- [ ] Fail-closed check: `curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://kvrn.shop/api/twilio/status` → **403** (ok). **503** = `TWILIO_AUTH_TOKEN` missing ⇒ fix.

**GA4 / first-party analytics** (H.4, H.5)
- [ ] `curl -sS https://kvrn.shop/api/analytics/config` → `{"measurementId":"G-…"}` or `null` (never a secret).
- [ ] Understood: analytics are best-effort (≈2.5 s bound) and **non-fatal to payment**; a failure here does not block recovery.

**Cloudflare Access / admin** (H.6)
- [ ] Unauthenticated admin API → 302/401/403, never 200.
- [ ] Signed-in admin loads `/admin`; `GET /api/admin/dashboard` returns JSON.

**Cron / internal jobs** (H.7)
- [ ] `CRON_SECRET` is in the secret list; unauthenticated internal POST → 401 (not 200/503).
- [ ] Worker logs show `[cron]` lines without errors after a 5-minute tick. (Do **not** call the internal routes with the real secret by hand.)
- [ ] Aware: a restore can queue duplicate order-confirmation emails for orders re-finalized after the restore point; cron sends due emails automatically.

## 8. FINANCIAL / INVENTORY VALIDATION  (runbook I)

**UNKNOWN is not ZERO. Do not edit accounting rows to turn anything green.**

- [ ] `GET /api/admin/financials/integrity` reviewed — summary `overall`: ______ (RECONCILED / INCOMPLETE / EXCEPTION). CSV exported: `GET /api/admin/financials/integrity/export`.
- [ ] Every **EXCEPTION** understood; each is either fixed **at the source** with an audited admin action or accepted *in writing* by the operator as a restore artefact.
- [ ] Every **INCOMPLETE** is either time-dependent (Stripe fee awaiting settlement — cron fills it) or a **recorded UNKNOWN** — never a zero.
- [ ] Orders vs Stripe payments cross-checked (each paid order has a payment; each in-window payment has an order or a `payment_exceptions` row).
- [ ] Inventory: no negative/over-reserved variants; stock vs a physical spot-check; cost layers/valuation sane (`GET /api/admin/inventory/valuation`).
- [ ] Refunds: one `order_refunds` per Stripe refund; no double refund; fee-returned/components unresolved ⇒ INCOMPLETE until entered via `POST /api/admin/refunds/<id>/fee-returned` / `…/resolve-components`.
- [ ] Disputes match Stripe (`GET /api/admin/disputes`). Shipping cost: label costs entered via `PATCH /api/admin/shipments/<id>/cost` from Shippo records; missing ⇒ INCOMPLETE. Stripe fees: **never typed in by hand**.
- [ ] Affiliate effects reviewed (`GET /api/admin/affiliates`); append-only history counts (`financial_integrity_runs`, `financial_integrity_events`, `admin_audit_logs`) ≥ the backup's.
- [ ] Payment exceptions: each open row **triaged** (refund in Stripe first → then `PATCH /api/admin/payment-exceptions/<id>` with `resolution` + required `note`).
- [ ] Once reviewed: `POST /api/admin/financials/integrity` **once** to append the post-recovery state to the history (changes no economic row).

> ### DANGER ZONE D — replaying Stripe events  `[PRODUCTION – CHANGES STATE]`
> - [ ] Checkout **closed**. Gap window listed. Payment still exists and is not refunded.
> - [ ] Know the idempotency keys: `webhook_events.stripe_event_id` (UNIQUE) and `orders.stripe_checkout_session_id` (UNIQUE).
> - [ ] Resend **one** event from the Stripe dashboard (verify the UI) → check admin: exactly one order *or* one payment exception; inventory moved once; one email queued → **then** the next.
> - ❌ No bulk/blind replay · no manual `payment_status`/order edits · no double refund · no manual inventory consumption · no hand-entered fees or revenue.

## 9. CONTROLLED TEST  (runbook J.2) — only with explicit operator approval

- [ ] **Do NOT turn the production Worker into a test rig:** no flipping production to `STRIPE_MODE=test`, no `sk_test_` key / test webhook secret on the production Worker, **no test-mode orders in the production database** (pollutes orders, inventory, email, analytics, reconciliation; causes config drift).
- [ ] **Stripe test-mode end-to-end → PREVIEW / ISOLATED only:** `kvrn-preview` worker (`npm run deploy:preview` from `kvrn/`) + an **isolated non-production database** (a validated restore, runbook D.4) + **test** Stripe key, **test** webhook endpoint pointing at the preview URL, own secrets. **Never** point a test harness or preview checkout at the production database.
- [ ] **Production:** `ENABLE_CHECKOUT` stays **`false`** until every non-mutating validation passes (sections 7, 8 and the checks in section 10).
- [ ] Only if a real production checkout must be proven: **explicit operator approval** for **ONE real, low-value live order** with the **intended live configuration** (no mode flip): who ______ when ______
- [ ] Open `ENABLE_CHECKOUT` for the shortest possible time → place that one order yourself → verify the whole real path: webhook `200`, exactly one order, inventory moved once, confirmation email delivered, integrity shows nothing new beyond a fee awaiting settlement.
- [ ] Handle the order (fulfil, or refund in Stripe) through the **normal audited mechanisms**; the refund flows back through the webhook. No manual order/payment edits.
- [ ] Time of every enable/disable recorded. If anything looks wrong: **`ENABLE_CHECKOUT` = `false` first**, investigate second.

## 10. REOPEN CHECKOUT  (runbook J) — every box, no exceptions

- [ ] Database reachable (status probe → **404**).
- [ ] Required migrations present (probe: level **022**, all rows `t`).
- [ ] Admin read paths work (`/admin`, dashboard, inventory, financial summary, integrity, payment exceptions); unauthenticated calls refused.
- [ ] Inventory sane.
- [ ] Reconciliation reviewed (section 8 complete).
- [ ] Stripe mode correct (`STRIPE_MODE`, key prefix, webhook secret, dashboard mode all agree).
- [ ] Webhook healthy (endpoint exists, 13 events, deliveries `200`, secret set; gap window closed or triaged).
- [ ] Shipping validated (live Shippo rates, not `unavailable`).
- [ ] Transactional email validated (key present, outbox not failing, real delivery seen).
- [ ] Analytics cannot block payment (non-fatal, ≈2.5 s bound; tests green in section 5).
- [ ] No unresolved **critical** payment exceptions caused by the recovery.
- [ ] **Operator explicitly approves** reopening: name ______ time (UTC) ______
- [ ] `[PRODUCTION – CHANGES STATE]` Set `ENABLE_CHECKOUT` = `true` (dashboard). Timestamp recorded: ______
- [ ] Watch the first real orders end to end (order, inventory, email, webhook `200`). Stay on call for 24 h.
- [ ] If anything looks wrong: **set `ENABLE_CHECKOUT` = `false` first, investigate second.**

## 11. POST-INCIDENT

- [ ] Evidence log completed (runbook K): times, symptoms, cause, commit, backup id/path, restore target, migration level, config changes (names only), provider checks, tests, reconciliation results, enable/disable timestamps, operator, outcome.
- [ ] Backups, dumps, damaged DB/branch, Worker logs and Stripe event lists are **kept until the incident is formally closed**; only then, with sign-off, delete the temporary restore databases and local dump copies (securely).
- [ ] Rotated/exposed secrets: old ones revoked at the provider.
- [ ] Any permanent UNKNOWN costs/fees recorded as unknown (not zero) and ticketed.
- [ ] Root cause + fix recorded; a tag created for the new known-good commit (`git tag recovery-<date>-known-good <sha>`; tagging changes nothing in production).
- [ ] This checklist/runbook updated for anything that was wrong, missing or slow (see DRILL → "what failures require documentation updates").
- [ ] Next drill scheduled (`DISASTER-RECOVERY-DRILL.md`).
- [ ] Incident closed — operator ______ date ______
