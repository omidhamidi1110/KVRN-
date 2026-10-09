/** SQL invariants only: never connect to Neon or activate marketing.
 * Real concurrency and budget enforcement require isolated PostgreSQL tests.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const s=readFileSync('db/migrations/046_marketing_budget_atomic_control.sql','utf8')
const checks=[
  ['dispatch default stays off',/dispatch_enabled boolean NOT NULL DEFAULT false[\s\S]*?INSERT INTO marketing_budget_policy\(id,dispatch_enabled\)[\s\S]*?VALUES\(1,false\)/],
  ['database budget maxima are constrained, not only app promises',/sms_daily_cap_micros[\s\S]*?BETWEEN 1 AND 3000000[\s\S]*?sms_monthly_cap_micros[\s\S]*?BETWEEN 1 AND 15000000/],
  ['transaction-level advisory lock protects parallel HTTP requests',/pg_advisory_xact_lock\(/],
  ['caller-supplied caps only reduce persisted ceilings',/v_day_cap := LEAST\([\s\S]*?v_month_cap := LEAST\([\s\S]*?v_ai_cap := LEAST\(/],
  ['idempotency reuse rejects mismatched campaign or amount',/v_existing\.campaign_id=p_campaign[\s\S]*?v_existing\.reserved_micros=p_worst_micros[\s\S]*?MARKETING_IDEMPOTENCY_CONFLICT/],
  ['idempotent key cannot reopen settled/released or prior-day reservations',/v_existing\.state='reserved'[\s\S]*?v_existing\.budget_utc_day=v_day[\s\S]*?v_existing\.budget_utc_month=v_month/],
  ['campaign must be copy reviewed',/v_campaign\.state<>'reviewed'/],
  ['reserved and settled spend both consumed conservatively',/state='reserved' THEN reserved_micros::numeric[\s\S]*?state='settled' THEN actual_micros::numeric/],
  ['daily and monthly hard caps checked',/v_day_committed\+p_worst_micros::numeric>v_day_cap[\s\S]*?v_month_committed\+p_worst_micros::numeric>v_month_cap/],
  ['AI subset cap also checked',/v_ai_month_committed\+p_worst_micros::numeric>v_ai_cap/],
  ['disabled switch aborts reservation',/IF NOT v_policy\.dispatch_enabled THEN[\s\S]*?MARKETING_DISPATCH_DISABLED/],
  ['no embedded provider send or money side effects',/^((?!fetch\(|twilio\.messages|resend\.emails|stripe\.).)*$/s],
]
for(const [name,rule] of checks){assert.match(s,rule,name);console.log('PASS',name)}
console.log(`${checks.length}/${checks.length} offline SQL budget assertions passed; schema NOT applied.`)
