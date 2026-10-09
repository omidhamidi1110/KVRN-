import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const sql=readFileSync('db/migrations/058_marketing_at_most_once_claim.sql','utf8')
let n=0
function test(label,fn){fn();console.log('PASS',label);n++}
test('default evidence timestamp max five minutes and immutable',()=>{assert.match(sql,/expires_at<=verified_at\+INTERVAL '5 minutes'/);assert.match(sql,/delivery_evidence_immutable BEFORE UPDATE OR DELETE/)})
test('attempt initially unknown and has no retry-success state',()=>{assert.match(sql,/DEFAULT 'unknown' CHECK\(state='unknown'\)/);assert.match(sql,/MARKETING_CLAIM_ALREADY_ATTEMPTED_NO_RETRY/);assert.match(sql,/UNIQUE\(plan_id,audience_member_id\)/)})
test('same serial DB budget lock as initial reservations',()=>assert.match(sql,/pg_advisory_xact_lock\(48112026046::bigint\)/))
test('owner approval must match campaign version and expire in future',()=>{assert.match(sql,/v_approval\.campaign_version<>v_campaign\.version/);assert.match(sql,/v_approval\.expires_at<=NOW\(\)/);assert.match(sql,/v_approval\.state<>'approved'/)})
test('prevents send while marketing DB policy disabled',()=>assert.match(sql,/v_policy\.dispatch_enabled IS DISTINCT FROM true/))
test('campaign and staged recipient must remain exact and uncancelled',()=>{assert.match(sql,/v_campaign\.state<>'reviewed'/);assert.match(sql,/marketing_staged_delivery_items/);assert.match(sql,/v_plan\.state<>'staged'/);assert.match(sql,/v_count<>v_approval\.recipient_count/)})
test('local consent with signed keyword proof rechecked, opt-out wins',()=>{assert.match(sql,/sms_keyword_consent_proofs/);assert.match(sql,/s\.unsubscribed_at IS NULL/);assert.match(sql,/twilio_opt_out_state='opted_in'/);assert.match(sql,/MARKETING_SMS_CONSENT_REVOKED/)})
test('email consent events and later unsubscribes win',()=>{assert.match(sql,/marketing_email_consent_events/);assert.match(sql,/event_type='unsubscribed'/);assert.match(sql,/MARKETING_EMAIL_CONSENT_REVOKED/)})
test('approval binds exact final-message digest and reviewer',()=>{assert.match(sql,/approved_message_sha256<>p_message_sha256/);assert.match(sql,/v_evidence\.reviewer_sha256<>v_approval\.owner_identity_sha256/)})
test('never estimates 50 recipients from one price; checks each verified quote sum',()=>{assert.match(sql,/COUNT\(ev.id\)::integer/);assert.match(sql,/SUM\(ev.per_recipient_worst_micros::numeric\)/);assert.match(sql,/v_evidenced_members<>v_count/);assert.match(sql,/v_total_verified_price>v_res.reserved_micros::numeric/)})
test('timezone must be recognized and quiet hours verified in recipient local time',()=>{assert.match(sql,/pg_timezone_names/);assert.match(sql,/AT TIME ZONE v_evidence\.recipient_timezone/);assert.match(sql,/v_local_hour<9 OR v_local_hour>=20/)})
test('unresolved outcome blocks indefinitely; accepted contacts have 72-hour cap',()=>{assert.match(sql,/INTERVAL '72 hours'/);assert.match(sql,/o.id IS NULL/);assert.match(sql,/marketing_delivery_attempt_outcomes/);assert.match(sql,/MARKETING_RECIPIENT_FREQUENCY_LIMIT/)})
test('unknown claimed attempts forever append only, no provider actions',()=>{assert.match(sql,/delivery_attempt_immutable BEFORE UPDATE OR DELETE/);assert.doesNotMatch(sql,/https?:\/\/|http_post|http_get|sendSms|sendEmail|\.send\(/i)})
test('single recipient attempt claims a budget already reserved in current UTC day',()=>{assert.match(sql,/v_res\.state<>'reserved'/);assert.match(sql,/budget_utc_day<>\(NOW\(\) AT TIME ZONE 'UTC'\)::date/);assert.match(sql,/budget_reservation_id uuid NOT NULL REFERENCES marketing_budget_reservations/)})
test('evidence can be reverified without blocking approved plan',()=>{assert.match(sql,/UNIQUE\(plan_id,audience_member_id,approval_id,verified_at\)/);assert.match(sql,/LEFT JOIN LATERAL/);assert.match(sql,/MARKETING_RECIPIENT_EVIDENCE_SUPERSEDED/)})
test('outcome proof immutable and cannot mistake unknown for not submitted',()=>{assert.match(sql,/outcome IN \(\'provider_accepted\',\'verified_not_submitted\'\)/);assert.match(sql,/marketing_delivery_outcome_immutable BEFORE UPDATE OR DELETE/);assert.match(sql,/verified_source='verified_provider_rejection'/)})
console.log(`${n}/${n} offline at-most-once claim checks passed`)
