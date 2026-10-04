# KVRN Disaster-Recovery Drill (periodic, NON-production)

Purpose: prove — before an incident — that the recovery material in [`DISASTER-RECOVERY.md`](DISASTER-RECOVERY.md) and [`DISASTER-RECOVERY-CHECKLIST.md`](DISASTER-RECOVERY-CHECKLIST.md) actually works, on this repo, with these tools, in the hands of whoever will be on call.

Baseline `97c761a`, migrations `001`–`022`. Section letters ("D.5", "H.1") refer to the runbook.

**Layout and conventions (same as the runbook, section 0 and A.0):**
- The **Git root is one level above the app** (Codespace: `/workspaces/KVRN-`); the **app root is `kvrn/`**. `git` runs at the Git root; **`npm`, `npx wrangler`, `npx opennextjs-cloudflare` and every `db/...` path run in `kvrn/`**. After a clone you must `cd` into `kvrn/` before any `npm` command.
- **No shell `read` for secrets, ever.** Capture with Python `getpass` into a **chmod-600 temp file**, consume it without printing it, then `unset` the variable and `rm -f` the file (pattern in runbook section 0). A password-less **LOCAL** URL is not a secret — use a literal.
- **Dumps and drill evidence live OUTSIDE the Git repository** in `$EVID_DIR` (created in D0) — never under `/workspaces/KVRN-` or `/workspaces/KVRN-/kvrn`, including the drill's own clone.
- **PostgreSQL version:** production was verified as **PostgreSQL 18.6** at this baseline; **re-check the live Neon version at every drill**. Restore validation uses **PostgreSQL 18+** clients and server; a PG16 drill does **not** prove a PG18 production restore.

## THE RULE (read this first)

> **A drill must NEVER enable production checkout and must NEVER mutate production orders, payments, inventory, accounting rows, Worker variables/secrets, deployments or the production database.**

Everything that mutates anything happens on **your own machine**, against a **throwaway local database**. The only things a drill may do to production are strictly **read-only**:

| Allowed against production | Not allowed, ever, during a drill |
|---|---|
| Public `GET` probes (`/`, `/api/checkout/status?...`, `/api/analytics/config`) | Setting/changing `ENABLE_CHECKOUT`, `STRIPE_MODE` or any variable/secret |
| Unauthenticated `POST` to `/api/internal/*` or `/api/twilio/status` expecting `401/403/503` (they reject before doing anything) | `npx wrangler secret put …`, `npm run deploy`, `npm run deploy:preview`, merging to `main` |
| `npx wrangler secret list` (names only) and **viewing** dashboards (Cloudflare, Neon, Stripe, Shippo, Resend, Twilio) | **`POST /api/admin/financials/integrity`** (it appends to production history) and every other admin `POST/PATCH/DELETE` |
| *Optional:* one read-only `pg_dump` of production (a read; see D1) — or, better, use a backup you already hold | Replaying/resending Stripe events, creating orders or test payments, buying Shippo labels, sending real email/SMS |
| | Running fixtures, `db/seed.sql`, `scripts/test-0*-fixtures.sh` or jest DB tests with `TEST_DATABASE_URL` pointing at anything that is not **local** |

If any step below seems to need a production write, **stop the drill** and record it as a documentation defect (section "What failures require documentation updates").

---

## 1. Cadence

| Drill | When | Scope | Time box |
|---|---|---|---|
| **Full drill** | Every **quarter** (suggested), and **before** any planned launch/live-mode switch | Sections D0–D10 | ≈ 2–3 h |
| **Mini drill** | Every **month** (suggested) | D1–D4 only: obtain backup → restore locally → migration probe → counts → integrity scan | ≈ 30–60 min |
| **Event-driven** | After any new migration (023+) lands; after a Neon PostgreSQL major-version change; after changing hosting, CI, backup method or secret-handling; after any real incident; when the on-call operator changes | Full drill | ≈ 2–3 h |

Rotate the **tabletop scenario** (D8) through runbook C.1–C.10 so each class gets walked at least once a year.
The repo defines **no** backup schedule or retention. The drill therefore also forces the question "where does today's backup come from, and how old is it?" (D1) — set your recovery-point objective in writing (e.g. "no older than 7 days" is a *suggested* floor; the operator decides) and record it in the drill report.

---

## 2. Setup and safety pre-flight (D0)

- [ ] Use a **fresh shell/terminal** that has **no production variables loaded**, and a **separate directory outside any Git repo** for the drill's clone (D1).
- [ ] Pre-flight: list the **names** (never values) of risky variables currently in your shell. Anything printed must be unset before continuing. `[READ-ONLY]`
  ```bash
  env | cut -d= -f1 | grep -E '^(DATABASE_URL|PRODUCTION_MIGRATION_URL|TEST_DATABASE_URL|SOURCE_URL|RESTORE_URL|STRIPE_|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|ENABLE_CHECKOUT|CRON_SECRET)' || echo "none set - good"
  ```
  Remove any hits with `unset <NAME>` (for example `unset DATABASE_URL`). Make this a habit: **`unset TEST_DATABASE_URL` before the non-DB regression run** (D5).
- [ ] **Evidence directory OUTSIDE the Git repository** (also checks that it is not inside a Git working tree). `[LOCAL/TEST]`
  ```bash
  EVID_DIR="${HOME}/kvrn-dr-evidence/drill-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$EVID_DIR" && chmod 700 "${HOME}/kvrn-dr-evidence" "$EVID_DIR"
  git -C "$EVID_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && echo "STOP: $EVID_DIR is inside a Git repository - set EVID_DIR to a path outside it" \
    || echo "evidence dir OK (outside any Git repo): $EVID_DIR"
  ```
  (Or any explicit operator-chosen encrypted location outside the repo — set `EVID_DIR` to it.)
- [ ] Tools present: `[READ-ONLY]`
  ```bash
  git --version; node --version; npm --version
  psql --version; pg_dump --version; pg_restore --version; createdb --version
  psql -h localhost -p 5432 -U <LOCAL_USER> -d postgres -Atc "SHOW server_version"
  ```
  **Client tools and the local server must be PostgreSQL 18 or newer** (the production major version at this baseline was **18.6**; re-check the live version in the Neon console and record it). If your local server is older (e.g. 16), **install/start a PG18+ server before continuing**; do not run the restore drill on PG16 and call it validated. The repo's fixture scripts default to `/usr/lib/postgresql/16/bin` — a legacy local-harness assumption, **not** the recovery-version authority.
- [ ] Open a new **drill report** (template at the end). It holds timings and results — **no secrets, no customer data**.

---

## 3. The drill

### D1 — Obtain the known-good source and a backup  *(proves: source + backup can be obtained)*

1. Source:
   - [ ] Clone into a **new directory outside any Git repo**, then **descend into `kvrn/`**. `[LOCAL/TEST]`
     ```bash
     DRILL_DIR="${HOME}/kvrn-drill-$(date -u +%Y%m%dT%H%M%SZ)"
     git clone <REPO_URL> "$DRILL_DIR"
     cd "$DRILL_DIR"                    # GIT ROOT (contains kvrn/)
     git checkout <KNOWN_GOOD_SHA_OR_TAG>
     git rev-parse HEAD
     git status --short                 # must print nothing
     test -f kvrn/package.json && echo "app root confirmed: kvrn/" || echo "STOP: kvrn/package.json not found - wrong layout/commit"
     cd kvrn                            # APP ROOT: all npm / db/... commands below run here
     pwd
     ```
     Record the SHA.
   - [ ] **Source-archive path** (GitHub-loss rehearsal, runbook C.9): extract an archived ZIP **outside any repo** and verify the hashes you recorded when you archived it. `[LOCAL/TEST]`
     ```bash
     md5sum <ARCHIVE>.zip && sha256sum <ARCHIVE>.zip      # compare with your recorded values
     unzip -q <ARCHIVE>.zip -d "${HOME}/kvrn-drill-from-zip"
     # the app is the kvrn/ folder inside the archive
     ls "${HOME}/kvrn-drill-from-zip/kvrn/package.json" "${HOME}/kvrn-drill-from-zip/kvrn/wrangler.toml" "${HOME}/kvrn-drill-from-zip/kvrn/open-next.config.ts" "${HOME}/kvrn-drill-from-zip/kvrn/cloudflare-cron-wrapper.js"
     ```
2. Backup — pick **one** and record which:
   - [ ] **(Preferred) a backup you already hold** (a retained dump, or a Neon-side branch/snapshot exported to a dump). Record its age. *Producing and keeping such backups is an operator process the repo does not define — if you cannot name today's backup, that is itself a drill **fail** (F-1).*
   - [ ] **(Optional) one fresh read-only dump of production** — a read; it changes nothing. `[READ-ONLY]` against production. Use a **direct** connection string, ideally a read-only database role (**provider feature — verify in the Neon console**). Capture it with `getpass` into a chmod-600 temp file (no shell `read`):
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
     Dump into `$EVID_DIR` (outside the repo; client must be PG **18+**). A `.sha256`/`.meta` and `BACKUP SUCCESS` are produced **only** if `pg_dump` succeeded; on failure the partial file is quarantined and no success record exists. The clean-up lines always run:
     ```bash
     SOURCE_URL="$(cat /tmp/kvrn-dr-source-url)"
     BACKUP_STARTED_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"   # non-secret; captured BEFORE pg_dump starts
     BACKUP_FILE="$EVID_DIR/kvrn-drill-$(date -u +%Y%m%dT%H%M%SZ).dump"
     pg_dump --version
     if pg_dump --format=custom --no-owner --no-privileges --file="$BACKUP_FILE" "$SOURCE_URL"; then
       chmod 600 "$BACKUP_FILE"
       sha256sum "$BACKUP_FILE" | tee "$BACKUP_FILE.sha256"
       printf 'backup_started_at_utc=%s\n' "$BACKUP_STARTED_AT_UTC" > "$BACKUP_FILE.meta"
       echo "BACKUP SUCCESS: $BACKUP_FILE (dump started $BACKUP_STARTED_AT_UTC)"
     else
       echo "BACKUP FAILURE: pg_dump did not succeed - NO usable backup exists. Record why; this is not a usable backup"
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
- [ ] **Tick only on `BACKUP SUCCESS`** (or for a retained dump you hold): backup path/age/size/sha256, **backup/snapshot time** (`BACKUP_STARTED_AT_UTC` — dump start time; earlier/conservative if unknown) and `pg_dump` + server versions recorded (production server version **re-checked**: PG 18.6 at this baseline). A fresh-dump run that printed `BACKUP FAILURE` is recorded as a failure (F-1), never as a backup. If using a retained dump, set `BACKUP_FILE="<path>"` — and if that dump currently sits under the Git repo or app root, **move it to `$EVID_DIR` first**.
- The dump contains **customer PII and money data**: encrypted disk, mode-`700` `$EVID_DIR`, **outside the Git repository and the app root**, never uploaded, deleted at the end of the drill (D10).

### D2 — Restore into an isolated LOCAL database  *(proves: the backup restores)*

- [ ] Create an empty local database (server **PostgreSQL 18+**) and point `RESTORE_URL` at it. A password-less local URL is not a secret — a literal is fine. `[LOCAL/TEST]`
  ```bash
  createdb -h localhost -p 5432 -U <LOCAL_USER> kvrn_drill_restore
  RESTORE_URL="postgresql://<LOCAL_USER>@localhost:5432/kvrn_drill_restore"
  ```
- [ ] **Guard** — confirm the target is local before restoring (prints only a verdict, not the URL). If it prints STOP, `unset RESTORE_URL` and start again. A restore into a server **older than the production major version (18)** is a drill **FAIL** (F-12). `[READ-ONLY]`
  ```bash
  case "$RESTORE_URL" in
    *@localhost*|*@127.0.0.1*|*//localhost*|*//127.0.0.1*|*host=/*) echo "target looks LOCAL - ok" ;;
    *) echo "STOP: RESTORE_URL does not look local. Do not continue." ;;
  esac
  ```
- [ ] Restore, failing fast. `[LOCAL/TEST]`
  ```bash
  pg_restore --no-owner --no-privileges --exit-on-error --dbname="$RESTORE_URL" "$BACKUP_FILE" \
    && echo "restore finished" || echo "RESTORE FAILED - record the error; this is a drill FAIL"
  ```
  Record wall-clock time of the restore (it tells you your real recovery time).

### D3 — Migrations are understood  *(proves: expected level can be established)*

- [ ] From the **app root `kvrn/`** (`pwd` ends in `/kvrn`): the migration set is contiguous and ends at 022; **no 023** exists unless a newer baseline is intentionally being drilled. `[READ-ONLY]`
  ```bash
  ls db/migrations/*.sql | sort | sed -n '1p;$p'
  for n in $(seq 1 22); do p=$(printf '%03d' "$n"); ls db/migrations/${p}_*.sql >/dev/null 2>&1 || echo "MISSING migration $p"; done
  ls db/migrations/ | grep -E '^02[3-9]' || echo "no migration newer than 022"
  ```
  (If a newer migration now exists, update the runbook's probe, level and checklist **before** declaring this step passed — F-3.)
- [ ] Run the **D.5 migration-level probe** from the runbook against `RESTORE_URL`: every row `t` ⇒ level 022. `[READ-ONLY]`
- [ ] Prove the migrations apply from nothing: build a **brand-new** local database from the repo's SQL and probe it. `[LOCAL/TEST]` (throwaway DB; never any other target)
  ```bash
  createdb -h localhost -p 5432 -U <LOCAL_USER> kvrn_drill_fresh
  FRESH_URL="postgresql://<LOCAL_USER>@localhost:5432/kvrn_drill_fresh"
  for f in db/migrations/0*.sql; do
    echo "applying $f"
    psql "$FRESH_URL" -X -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "FAILED at $f - stop here"; break; }
  done
  ```
  Then run the D.5 probe against `FRESH_URL`: all rows `t`. (The jest harness in D5 does the same thing automatically.)
- [ ] Compare **schema shape** of restore vs. fresh build (differences are expected only in data, not objects): `[READ-ONLY]`
  ```bash
  # recent pg_dump releases print a random \restrict/\unrestrict token on every run; filter those two lines or the files can never match
  pg_dump --schema-only --no-owner --no-privileges "$RESTORE_URL" | grep -vE '^\\(un)?restrict ' > "$EVID_DIR/schema-restore.sql"
  pg_dump --schema-only --no-owner --no-privileges "$FRESH_URL"   | grep -vE '^\\(un)?restrict ' > "$EVID_DIR/schema-fresh.sql"
  diff -q "$EVID_DIR/schema-restore.sql" "$EVID_DIR/schema-fresh.sql" && echo "schemas identical" || echo "schemas differ - review the diff, explain every difference"
  ```
  Differences are not automatically a failure (a production DB may carry history from earlier manual changes) but **every** difference must be explained in the report; unexplained differences are a **fail** (F-4).

### D4 — Data validation and integrity scan on the restore  *(proves: integrity checks can be exercised non-production)*

Run these against `RESTORE_URL` only; they are all in runbook **D.5** (copy the blocks verbatim):

- [ ] Critical-table row counts captured (and, if you made a fresh dump, compared with production's counts at dump time).
- [ ] Inventory sanity query ⇒ 0 impossible variants.
- [ ] `financial_integrity_entity_states()` and `financial_integrity_scan()` ⇒ results captured. **Do not "repair" findings** in the restore either — the drill's job is to prove the scan runs and is interpretable, and to rehearse reading it (runbook I). Note counts of `EXCEPTION` / `INCOMPLETE` / `advisory`.
- [ ] **Restore point** = the backup/snapshot time (`BACKUP_STARTED_AT_UTC` of the dump you restored, or the Neon PITR timestamp; earlier/conservative if unsure) — **not** derived from the data. Separately record `max(orders.paid_at)` and `max(webhook_events.created_at)` as **"latest business records present"** (sanity signals; neither should be later than the restore point). State, for the report, the "gap window" = restore point → now (runbook D.5/D.7).
- [ ] **Do not** call `record_financial_integrity_run()` on the restore and mistake it for production history.

### D5 — Typecheck, tests and build  *(proves: code can be validated)*

`[LOCAL/TEST]` in the **app root `kvrn/`** of the clean checkout from D1 (`pwd` must end in `/kvrn`; npm; the nested workflow targets Node 20). **First make sure no stale `TEST_DATABASE_URL` is in the shell** — do not rely on an empty assignment:

```bash
pwd
unset TEST_DATABASE_URL        # ALWAYS, before the default (non-DB) regression run
npm ci
npm run type-check
npm test                       # pass 1: everything; DB-backed suites skip VISIBLY because the variable is unset
npm run build
npm run cf:build
```

- [ ] `npm ci`, `type-check`, `build` and `cf:build` succeed. No production secrets were needed (the build uses a placeholder DB URL; the GA id is read at request time).
- [ ] Pass 1 of `npm test` is green.

Pass 2 — the DB-backed suites against a **local** PostgreSQL server (they create and drop throwaway databases there; the harness `lib/__tests__/helpers/fi-pg.ts` **refuses non-local hosts**, and applies every `db/migrations/*.sql` file to a fresh DB each time):

Set `TEST_DATABASE_URL` **only to a confirmed LOCAL throwaway PostgreSQL 18+ server** (a role with `CREATEDB`; a literal password-less URL is fine) for **this one command**, and `unset` it immediately afterwards. **Never Neon/production.**

```bash
export TEST_DATABASE_URL="postgresql://<LOCAL_USER>@localhost:5432/postgres"
npx jest "financial-integrity|funnel-analytics|ga4-money-path|launch-blockers-rev1-late-payment|recurring-expenses|tax-export"
unset TEST_DATABASE_URL
```

- [ ] Pass 2 green, with the DB suites **running, not skipped** (read the jest output for the skip notes).
- ⚠ Do **not** run a bare `npm test` with `TEST_DATABASE_URL` set to a local server: `lib/__tests__/reservations.test.ts` drives that URL through the **Neon HTTP driver** (`neon(TEST_DB)`), which cannot talk to a plain local PostgreSQL, so its integration cases would fail for environmental reasons. This is a known limitation of the harness, not a product defect — record it, do not "fix" it during a drill. Never point `TEST_DATABASE_URL` at Neon/production.
- *Optional / advanced:* `scripts/test-020-fixtures.sh` and `scripts/test-021-fixtures.sh` run SQL fixtures on a **fresh throwaway database** (created and dropped by the script) and assume a Debian-style **PostgreSQL 16** layout (`/usr/lib/postgresql/16/bin`), `su postgres`, port `5433` and a `/tmp` socket dir (overridable with `PGBIN`, `PGHOST_DIR`, `PGPORT`, `PGUSER`). That is a **legacy local-harness assumption, not the recovery-version authority**: they are **local only**, must never be aimed at Neon, and a PG16 run of them does **not** validate a PG18 production restore. If you use them, point `PGBIN` at a PostgreSQL 18+ install; if they do not fit your machine, the jest pass above is the supported equivalent. Note it in the report.

### D6 — Provider configuration presence, **read-only**  *(proves: config can be verified without changing it)*

- [ ] Secret **names** present, values never shown. `[READ-ONLY]` Tick each expected name against runbook F: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUDIENCE`, `ADMIN_EMAIL_ALLOWLIST`, `SHIPPO_API_TOKEN`, `RESEND_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_AUTH_TOKEN`, `GA4_MEASUREMENT_PROTOCOL_SECRET`, `CRON_SECRET` (+ `RESEND_MARKETING_API_KEY` if used). (Needs a Cloudflare credential, from the **app root `kvrn/`**. Use the `getpass` → chmod-600 temp file pattern, never shell `read`:)
  ```bash
  python3 - <<'PY'
  import getpass, os
  value = getpass.getpass("CLOUDFLARE_API_TOKEN (hidden): ")
  path = "/tmp/kvrn-dr-cf-token"
  fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
  with os.fdopen(fd, "w") as f:
      f.write(value)
  os.chmod(path, 0o600)
  PY
  export CLOUDFLARE_API_TOKEN="$(cat /tmp/kvrn-dr-cf-token)"
  npx wrangler whoami            # confirm the INTENDED account; do not paste the output anywhere
  npx wrangler secret list       # names only
  unset CLOUDFLARE_API_TOKEN
  rm -f /tmp/kvrn-dr-cf-token
  ```
- [ ] Dashboard **view-only** review (no edits, no revealed secret fields on screen): `STRIPE_MODE`, `ENABLE_CHECKOUT` (`false`/unset or exactly as production intends — **do not touch**), `NEXT_PUBLIC_GA_MEASUREMENT_ID`, `SHIPPO_FROM_*`, `SITE_URL`, `NEXT_PUBLIC_SITE_URL`, Twilio gating flags; custom domain `kvrn.shop` attached; cron `*/5 * * * *` present; Access application exists; Stripe webhook endpoint exists in the live mode with 13 events and recent `200` deliveries; Twilio webhook URLs; Resend sender domain verified.
- [ ] Public/unauthenticated probes. `[READ-ONLY]`
  ```bash
  BASE=https://kvrn.shop
  curl -sS -o /dev/null -w "home              HTTP %{http_code}\n" "$BASE/"
  curl -sS -w "\ncheckout/status    HTTP %{http_code}  (expect 404)\n" "$BASE/api/checkout/status?session_id=cs_test_drprobe0000000001"
  curl -sS "$BASE/api/analytics/config"
  curl -sS -o /dev/null -w "admin (no auth)    HTTP %{http_code}  (expect 302/401/403)\n" "$BASE/api/admin/dashboard"
  curl -sS -o /dev/null -w "internal (no auth) HTTP %{http_code}  (expect 401)\n" -X POST "$BASE/api/internal/transactional-email-retry"
  curl -sS -o /dev/null -w "twilio/status      HTTP %{http_code}  (expect 403)\n" -X POST "$BASE/api/twilio/status"
  ```
  *(The drill deliberately does **not** probe `POST /api/checkout/session` in production: it is a checkout endpoint, and a drill never exercises checkout.)*
- [ ] Record any name/variable that is missing or unexpected. Do not fix production from the drill — raise a ticket.

### D7 — Integrity checks on synthetic data  *(proves: checks catch problems, non-production)*

The jest pass 2 in D5 already builds throwaway databases from `db/migrations/001–022`, inserts synthetic orders/refunds/disputes/inventory/affiliates/expenses and asserts the scan's `RECONCILED` / `INCOMPLETE` / `EXCEPTION` outcomes and append-only guards (`financial-integrity*.test.ts`).

- [ ] Confirm those suites ran and passed (not skipped).
- [ ] Rehearse reading a finding: pick one `INCOMPLETE` or `advisory` finding from D4 and write down (a) what unknown it represents, (b) which independent source would resolve it, (c) which audited admin action would record the answer, (d) why editing the row directly is forbidden (runbook I, C.8).

### D8 — Tabletop: is the checklist usable?  *(proves: checklist usable under pressure)*

Pick the scenario from the rotation (runbook C.1–C.10). A second person reads the scenario aloud; the operator works **only** from `DISASTER-RECOVERY-CHECKLIST.md`, answering "what would I do and which command" — **without running any production command**.

- [ ] Time to reach "close checkout" (target: under 5 minutes; record actual).
- [ ] Time to a correct failure classification.
- [ ] Every checklist command was either executed in D1–D7 (non-production) or reviewed and judged correct; none contains a secret, `exit`, or an unlabeled destructive step. `[READ-ONLY]` syntax check of each shell block you copied into a scratch file: `bash -n scratch.sh`.
- [ ] Anything ambiguous, missing, mis-ordered or wrong ⇒ log it as a doc defect (F-5).
- [ ] Confirm the operator can answer without searching: *Where is `ENABLE_CHECKOUT` set? How is production actually deployed today, and why is the nested `kvrn/.github/workflows/deploy.yml` not a recovery path (what would you check in the Cloudflare dashboard)? From which directory do `git` commands run versus `npm` commands? Why must the database restore go to an empty/isolated target? What does `INCOMPLETE` mean? Why is `POST /api/admin/financials/integrity` not a "fix"?*

### D9 — Close-out checks

- [ ] No production variable, secret, deployment, order, payment or accounting row was changed (list the production touches you made — they should all be reads/probes).
- [ ] `git status --short` in the drill checkout is empty (the drill changed no code).
- [ ] Report completed (below) and filed **outside** the repository.

### D10 — Clean up (drill only — this is not an incident)

`[LOCAL/TEST]` Drop the throwaway databases and securely remove local dumps (they contain PII). Keep only the report, hashes, counts and tool versions.

```bash
dropdb -h localhost -p 5432 -U <LOCAL_USER> kvrn_drill_restore
dropdb -h localhost -p 5432 -U <LOCAL_USER> kvrn_drill_fresh
unset RESTORE_URL FRESH_URL TEST_DATABASE_URL SOURCE_URL CLOUDFLARE_API_TOKEN
ls -l /tmp/kvrn-dr-* 2>/dev/null || echo "no leftover secret temp files"
rm -f /tmp/kvrn-dr-source-url /tmp/kvrn-dr-restore-url /tmp/kvrn-dr-cf-token /tmp/kvrn-dr-secret-value
# remove the dump(s) in "$EVID_DIR" yourself, with your platform's secure-delete method, once the report is filed; keep only the report
# remove the throwaway clone ("$DRILL_DIR") when you no longer need it
```

(During a **real incident** you never delete backups, dumps or databases until the incident is closed — runbook L.8. This clean-up applies to drill artefacts only.)

---

## 4. Pass / fail criteria

The drill **passes** only if **every** row passes. Any fail ⇒ the drill failed; fix the cause or the documentation, then re-run the failed steps (and file a short note).

| # | Criterion | PASS when | FAIL when |
|---|---|---|---|
| P1 | Source obtainable | Known-good commit checked out clean at the Git root (`git status --short` empty), `kvrn/package.json` found and every `npm` command run from `kvrn/` **or** the archive hashes match and required files are present under `kvrn/` | Cannot find/verify a clean known-good source; wrong layout |
| P2 | Backup exists and is recent enough | A backup you can name — a retained dump, or a fresh `pg_dump` that printed `BACKUP SUCCESS` with its `.sha256` — with age within the recovery objective you set in writing, was obtained | No identifiable backup, a fresh `pg_dump` that failed (`BACKUP FAILURE`; partial files do not count), or older than your objective (F-1) |
| P3 | Restore works | `pg_restore --exit-on-error` completes into an isolated local DB on **PostgreSQL 18+** (≥ the production major version, re-checked in Neon) | Any restore error; restore ran against a non-local target (abort + F-2); local server/clients older than the production major version (F-12) |
| P4 | Migration level established | D.5 probe: all rows `t` on the restore **and** on a fresh from-scratch build; contiguous `001–022`; no unexplained schema differences | Missing/extra migrations unexplained; fresh build fails |
| P5 | Data sane | No impossible inventory; counts explicable; restore point (backup/PITR time) and gap window (restore point → now) stated; latest-business-records timestamps recorded separately as sanity signals | Unexplained row loss or impossible values |
| P6 | Integrity checks run | Scan functions return on the restore; synthetic-data suites ran and passed; findings were *read*, not "repaired" | Scan errors; DB suites skipped without a recorded reason; anyone edited data to go green |
| P7 | Code validates | From `kvrn/`: `npm ci`, `type-check`, `npm test` (pass 1 with `TEST_DATABASE_URL` **unset**, pass 2 against a local throwaway server), `build`, `cf:build` all succeed | Any failure not explained by the documented `lib/__tests__/reservations.test.ts` limitation |
| P8 | Provider config present | Every expected secret **name** present; variables/webhook/Access/cron/domain present and viewed read-only; probes return the expected codes | Missing secret/variable, wrong probe result (record; fix production **outside** the drill) |
| P9 | Checklist usable | Tabletop completed; time to "close checkout" recorded; no unusable/unsafe command found | A command is wrong, ambiguous, unsafe (secret exposure, `exit`, unlabeled destructive step) |
| P10 | Safety rule held | **Zero** production mutations; checkout never enabled; nothing replayed; no dump/evidence under the Git repo or app root; no secret ever typed on a command line or captured with shell `read` | Any production write — treat as an incident, not a drill |

---

## 5. Evidence to retain (keep ~12 months; no secrets, no PII)

- Drill report (template below), date, operators, repo SHA, tool versions (`node`, `npm`, `psql`/`pg_dump`/`pg_restore`, local PG server version, and the **Neon server version as re-checked at drill time** — 18.6 at this baseline).
- Backup **metadata only**: path/identifier, size, sha256, age, how it was produced.
- Timings: restore duration, time-to-close-checkout (D8), total drill time.
- D.5 outputs: migration-probe table, critical-table counts, inventory sanity result, integrity summary counts (`EXCEPTION` / `INCOMPLETE` / `advisory`).
- Terminal summaries of `npm run type-check`, `npm test` (both passes: totals and any skips), `npm run build`, `npm run cf:build`.
- `npx wrangler secret list` output (names only), the provider-config tick list, probe status codes.
- Schema diff (restore vs fresh) and the explanation of every difference.
- List of doc defects found and the commit/PR that fixed each.
- **Do not retain:** the dump itself, connection strings, tokens, screenshots that show secret or customer fields.

## 6. What failures require documentation updates

| Failure | Update |
|---|---|
| F-1 No named/recent backup | Runbook **D.2** and **A.1**: record how backups are actually produced and where they live; set/record the recovery objective |
| F-2 Restore error / wrong tool flags / version mismatch | Runbook **D.1, D.4**, checklist section 4: correct flags, version-compatibility note, role/ownership notes |
| F-3 New migration (023+) or changed schema | Runbook **D.5** probe + expected level + **D.3** table list + **C.x** references, checklist "level **022**" wording, this drill's D3 range check |
| F-4 Unexplained schema difference | Runbook **D.5/D.6**; open a development ticket (do not fix in the drill) |
| F-5 A checklist/runbook command is wrong, ambiguous or unsafe | Fix **both** the runbook and `DISASTER-RECOVERY-CHECKLIST.md`; re-run `bash -n` on the block |
| F-6 A route, script, env var or table named in the docs no longer exists | Runbook **E.3, F, G, H, I** and the checklist; re-verify every referenced path/script/route/variable |
| F-7 Provider UI/capability changed (Neon branching/PITR, Cloudflare rollback, Stripe event resend, Access setup) | The matching "verify in the provider console" notes in runbook **C, D, G, H** |
| F-8 Test/build instructions changed (`package.json` scripts, Node version, jest harness, CI) | Runbook **E.3** and drill **D5** |
| F-9 Config drift found (secret/variable missing or unexpected) | Runbook **F** and **C.10**; correct production **outside** the drill |
| F-10 Tabletop revealed a gap in order, naming or time-to-contain | Checklist ordering/labels; runbook **B** |
| F-11 Any production mutation during the drill | Declare an incident; follow the runbook; then tighten this drill's wording |
| F-12 Production PostgreSQL major version changed, or the drill ran on an older major | Runbook **D.1** (recorded production version), checklist section 4, drill D0/D2/P3; re-run the drill on a PostgreSQL ≥ the new production major |
| F-13 Repo layout or deployment mechanism changed (workflow moved to the repo root, Cloudflare Git integration found/enabled, app moved) | Runbook **A.0, C.1, C.9, E.2, E.4**, checklist sections 1 and 5, drill D1 |

---

## 7. Drill report template (keep outside the repo)

```
KVRN DR DRILL REPORT
Date (UTC):                  Operator(s):                 Type: full / mini / event-driven (reason: ______)
Repo SHA / tag drilled:      Tool versions:               Local PG version:      Neon PG major version:
Recovery objective (written): ____________________________
PG versions: Neon production (re-checked) ____   local server ____   pg_dump/pg_restore client ____   (all local tools must be >= production major)

D1 source:           clone/zip?  hash match?  kvrn/package.json found, npm run from kvrn/: Y/N   P1: PASS / FAIL
D1 backup:           identifier ________  age ____  size ____  sha256 ________  produced by: ________
                     pg_dump outcome (SUCCESS/FAILURE/retained): ____  BACKUP_STARTED_AT_UTC ________      P2: PASS / FAIL
D2 restore:          duration ____    errors: none / ________                                           P3: PASS / FAIL
D3 migrations:       contiguous 001-022 / no 023: Y/N   restore probe all t: Y/N   fresh build all t: Y/N
                     schema differences explained: Y/N / n.a.                                            P4: PASS / FAIL
D4 data/integrity:   counts saved: Y/N   inventory sane: Y/N   restore point (backup/PITR time) ________  gap window (restore point -> now) ________
                     latest business records present: max(paid_at) ________  max(webhook created_at) ________ (sanity signals)
                     integrity: EXCEPTION ___ INCOMPLETE ___ advisory ___ (read, not repaired)           P5/P6: PASS / FAIL
D5 code:             npm ci ok / type-check ok / test pass1 ok / test pass2 ok (suites run, skips: ____) / build ok / cf:build ok   P7: PASS / FAIL
D6 provider config:  secret names all present: Y/N (missing: ____)   dashboards viewed read-only: Y/N
                     probes: status __ / admin __ / internal __ / twilio __ / analytics config __        P8: PASS / FAIL
D7 synthetic checks: integrity suites ran & passed: Y/N                                                   (part of P6)
D8 tabletop:         scenario C.__   time to "close checkout": ____   defects found: ____               P9: PASS / FAIL
D9 safety:           production mutations: NONE / (list)   checkout touched: NO                          P10: PASS / FAIL
Doc defects found:   ____________________  fixed in: ____________________
Overall:             PASS / FAIL          Next drill due: ____________
Signed off by:       ____________
```
