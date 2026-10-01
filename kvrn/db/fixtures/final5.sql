-- db/fixtures/final5.sql   (Final6: FAIL-HARD)
--
-- STANDALONE CHAIN: no dependency on any other fixture. Runs on its own fresh
-- database. Proves the Final5 freeze-candidate items plus the Final6
-- corrections against the real functions, not against a JS mirror.
--
-- HOW SUCCESS IS DETERMINED
-- The psql PROCESS EXIT CODE, under ON_ERROR_STOP, is the only authority. Every
-- check below is an assertion that RAISES an uncaught exception on mismatch:
--
--   * an expected rejection that unexpectedly SUCCEEDS  -> exception (exit != 0)
--   * an expected rejection that fails for a DIFFERENT reason -> exception
--     (the stable error token / SQLSTATE + constraint name must match exactly)
--   * a positive outcome or a monetary value / row count that differs from
--     the expectation -> exception
--
-- NOTICE lines are printed for readability only. Nothing here depends on them.
-- (The earlier version printed 'FAIL' from inside EXCEPTION WHEN OTHERS blocks
-- and could still exit 0 after an unexpected success.)
\set ON_ERROR_STOP on

-- ── assertion helpers ───────────────────────────────────────────────────────
-- Expect the statement to raise a KVRN error whose token (2nd '|' field) is
-- exactly p_token. Success, or any other error, raises.
CREATE OR REPLACE FUNCTION f5_expect_token(p_sql TEXT, p_token TEXT) RETURNS VOID
LANGUAGE plpgsql AS $f$
DECLARE v_msg TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF SPLIT_PART(v_msg, '|', 2) IS DISTINCT FROM p_token THEN
      RAISE EXCEPTION 'F5 ASSERT FAILED: expected token %, got [%] for: %', p_token, v_msg, p_sql;
    END IF;
    RAISE NOTICE 'PASS rejected with % : %', p_token, LEFT(REGEXP_REPLACE(p_sql, '\s+', ' ', 'g'), 70);
    RETURN;
  END;
  RAISE EXCEPTION 'F5 ASSERT FAILED: unexpected SUCCESS, expected token % for: %', p_token, p_sql;
END $f$;

-- Expect the statement to violate exactly the named CHECK constraint.
CREATE OR REPLACE FUNCTION f5_expect_check(p_sql TEXT, p_constraint TEXT) RETURNS VOID
LANGUAGE plpgsql AS $f$
DECLARE v_state TEXT; v_con TEXT; v_msg TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_con = CONSTRAINT_NAME, v_msg = MESSAGE_TEXT;
    IF v_state IS DISTINCT FROM '23514' OR v_con IS DISTINCT FROM p_constraint THEN
      RAISE EXCEPTION 'F5 ASSERT FAILED: expected SQLSTATE 23514 on constraint %, got % on % [%]',
        p_constraint, v_state, v_con, v_msg;
    END IF;
    RAISE NOTICE 'PASS check violation 23514 on %', v_con;
    RETURN;
  END;
  RAISE EXCEPTION 'F5 ASSERT FAILED: unexpected SUCCESS, expected check violation on % for: %', p_constraint, p_sql;
END $f$;

-- Equality assertion for outcomes, amounts and row counts.
CREATE OR REPLACE FUNCTION f5_assert_eq(p_label TEXT, p_actual TEXT, p_expected TEXT) RETURNS VOID
LANGUAGE plpgsql AS $f$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'F5 ASSERT FAILED: % expected [%] got [%]', p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE 'PASS % = %', p_label, p_actual;
END $f$;

CREATE OR REPLACE FUNCTION mko(p_id UUID,p_num TEXT,p_pi TEXT,p_sub INT,p_code TEXT,p_hold INT DEFAULT 0)
RETURNS VOID LANGUAGE plpgsql AS $f$ BEGIN
  INSERT INTO orders (id,order_number,stripe_checkout_session_id,stripe_payment_intent_id,payment_status,
    currency,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,paid_at,discount_code)
  VALUES (p_id,p_num,'cs_'||p_num,p_pi,'paid','usd',p_sub,0,0,0,p_sub,NOW()-INTERVAL '90 days',p_code);
END $f$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ITEM 3A (Final6 blocker 1): compute_affiliate_commission validates TERMS
-- BEFORE it considers the base, so corruption is never hidden by a zero base.
-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## ITEM 3A: compute_affiliate_commission fails closed, at ANY base ##########'
-- Positive base (the Final5 cases, now assertions rather than echoes).
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(10000,'percentage',NULL,NULL)$q$, 'CORRUPT_TERMS');
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(10000,'percentage',0,NULL)$q$,    'CORRUPT_TERMS');
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(10000,'percentage',10001,NULL)$q$,'CORRUPT_TERMS');
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(10000,'fixed',NULL,NULL)$q$,      'CORRUPT_TERMS');
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(10000,'fixed',NULL,-1)$q$,        'CORRUPT_TERMS');
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(10000,'bogus_type',NULL,NULL)$q$, 'CORRUPT_TERMS');
-- ZERO base: the corrupt terms must STILL be rejected (the Final5 defect).
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(0,'percentage',NULL,NULL)$q$,  'CORRUPT_TERMS');
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(0,'percentage',0,NULL)$q$,     'CORRUPT_TERMS');
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(0,'percentage',10001,NULL)$q$, 'CORRUPT_TERMS');
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(0,'fixed',NULL,NULL)$q$,       'CORRUPT_TERMS');
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(0,'bogus_type',NULL,NULL)$q$,  'CORRUPT_TERMS');
-- Negative and NULL bases are also refused when the terms are corrupt.
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(-5,'percentage',NULL,NULL)$q$, 'CORRUPT_TERMS');
SELECT f5_expect_token($q$SELECT compute_affiliate_commission(NULL,'fixed',NULL,NULL)$q$,    'CORRUPT_TERMS');
-- Valid terms at a zero base legitimately return 0.
SELECT f5_assert_eq('zero base, valid percentage terms',
  compute_affiliate_commission(0,'percentage',1000,NULL)::text, '0');
SELECT f5_assert_eq('zero base, valid fixed 5000 terms',
  compute_affiliate_commission(0,'fixed',NULL,5000)::text, '0');
SELECT f5_assert_eq('zero base, valid fixed 0 terms',
  compute_affiliate_commission(0,'fixed',NULL,0)::text, '0');
-- Ordinary positive-base calculations are unchanged.
SELECT f5_assert_eq('legitimate $0 fixed at positive base',
  compute_affiliate_commission(10000,'fixed',NULL,0)::text, '0');
SELECT f5_assert_eq('10% of 10000',
  compute_affiliate_commission(10000,'percentage',1000,NULL)::text, '1000');
SELECT f5_assert_eq('100% (10000 bps) of 10000',
  compute_affiliate_commission(10000,'percentage',10000,NULL)::text, '10000');
SELECT f5_assert_eq('half-up rounding, 3333 x 15%',
  compute_affiliate_commission(3333,'percentage',1500,NULL)::text, '500');
SELECT f5_assert_eq('fixed 5000 capped at base 3000',
  compute_affiliate_commission(3000,'fixed',NULL,5000)::text, '3000');
SELECT f5_assert_eq('fixed 2500 under base 10000',
  compute_affiliate_commission(10000,'fixed',NULL,2500)::text, '2500');

-- ═══════════════════════════════════════════════════════════════════════════
-- ITEM 3B: affiliate_terms_events CHECK constraint, direct insert
-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## ITEM 3B: affiliate_terms_events fails closed at the table ##########'
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('f5000000-0000-0000-0000-000000000001','F5A','F5A','percentage',1000);
SELECT f5_expect_check($q$
  INSERT INTO affiliate_terms_events (affiliate_id,commission_type,commission_rate_bps,
    commission_fixed_cents,fixed_reversal_policy,attribution_window_days,commission_hold_days,effective_at)
  VALUES ('f5000000-0000-0000-0000-000000000001','percentage',NULL,NULL,'proportional',30,30,NOW())$q$,
  'ate_terms_present');
SELECT f5_expect_check($q$
  INSERT INTO affiliate_terms_events (affiliate_id,commission_type,commission_rate_bps,
    commission_fixed_cents,fixed_reversal_policy,attribution_window_days,commission_hold_days,effective_at)
  VALUES ('f5000000-0000-0000-0000-000000000001','fixed',NULL,NULL,'proportional',30,30,NOW())$q$,
  'ate_terms_present');
-- A backdated invalid row is refused the same way (the historical case).
SELECT f5_expect_check($q$
  INSERT INTO affiliate_terms_events (affiliate_id,commission_type,commission_rate_bps,
    commission_fixed_cents,fixed_reversal_policy,attribution_window_days,commission_hold_days,effective_at)
  VALUES ('f5000000-0000-0000-0000-000000000001','percentage',NULL,NULL,'proportional',30,30,'2019-01-01')$q$,
  'ate_terms_present');

-- ═══════════════════════════════════════════════════════════════════════════
-- ITEM 3C: update_affiliate_terms() fails closed BEFORE the insert
-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## ITEM 3C: update_affiliate_terms rejects invalid historical terms ##########'
SELECT COUNT(*) AS terms_before FROM affiliate_terms_events
WHERE affiliate_id='f5000000-0000-0000-0000-000000000001' \gset
SELECT f5_expect_token($q$SELECT update_affiliate_terms('f5000000-0000-0000-0000-000000000001','percentage',
    NULL,NULL,'proportional',30,30,NULL,NOW(),'bad','admin')$q$, 'INVALID_TERMS');
SELECT f5_expect_token($q$SELECT update_affiliate_terms('f5000000-0000-0000-0000-000000000001','fixed',
    NULL,NULL,'proportional',30,30,NULL,NOW(),'bad','admin')$q$, 'INVALID_TERMS');
SELECT f5_assert_eq('rejected update_affiliate_terms wrote no terms row',
  (SELECT COUNT(*) FROM affiliate_terms_events
    WHERE affiliate_id='f5000000-0000-0000-0000-000000000001')::text, :'terms_before');
-- A legitimate change must still go through. A SEPARATE affiliate, so this
-- does not perturb the F5A rate the recovery-math scenarios below depend on.
INSERT INTO affiliates (id,code,name,default_commission_type,default_commission_rate_bps)
VALUES ('f5000000-0000-0000-0000-000000000002','F5B','F5B','percentage',1000);
SELECT f5_assert_eq('legitimate terms change outcome',
  update_affiliate_terms('f5000000-0000-0000-0000-000000000002','percentage',
    1500,NULL,'proportional',30,30,NULL,NOW(),'raise','admin')->>'outcome', 'terms_appended');

-- ═══════════════════════════════════════════════════════════════════════════
-- ITEM 5 (+ Final6 whitespace hardening): mark_affiliate_payout_paid actor
-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## ITEM 5: mark_affiliate_payout_paid requires a nonblank actor ##########'
INSERT INTO affiliate_status_events (affiliate_id,to_status,effective_at)
VALUES ('f5000000-0000-0000-0000-000000000001','active','2020-01-01');
UPDATE affiliates SET created_at='2020-01-01' WHERE id='f5000000-0000-0000-0000-000000000001';
UPDATE affiliate_terms_events SET effective_at='2020-01-01' WHERE affiliate_id='f5000000-0000-0000-0000-000000000001';
SELECT mko('f5100000-0000-0000-0000-000000000001','F5A','pi_f5a',10000,'F5A');
SELECT f5_assert_eq('accrued commission cents',
  resolve_order_affiliate_attribution('f5100000-0000-0000-0000-000000000001',NULL,'s')->>'commission_cents', '1000');
SELECT id AS cid1 FROM affiliate_commissions WHERE order_id='f5100000-0000-0000-0000-000000000001' \gset
SELECT f5_assert_eq('commission approved',
  refresh_affiliate_commission_state(:'cid1'::uuid)->>'status', 'approved');
SELECT create_affiliate_payout('f5000000-0000-0000-0000-000000000001',ARRAY[:'cid1'::uuid],'admin')->>'payout_id' AS payout_id \gset
SELECT status AS payout_status_before FROM affiliate_payouts WHERE id=:'payout_id'::uuid \gset
SELECT f5_assert_eq('payout starts unpaid', (:'payout_status_before' <> 'paid')::text, 'true');

SELECT f5_expect_token(format($q$SELECT mark_affiliate_payout_paid(%L::uuid,NOW(),'ach','r',NULL)$q$, :'payout_id'),
  'ACTOR_REQUIRED');
SELECT f5_expect_token(format($q$SELECT mark_affiliate_payout_paid(%L::uuid,NOW(),'ach','r','')$q$, :'payout_id'),
  'ACTOR_REQUIRED');
SELECT f5_expect_token(format($q$SELECT mark_affiliate_payout_paid(%L::uuid,NOW(),'ach','r','   ')$q$, :'payout_id'),
  'ACTOR_REQUIRED');
SELECT f5_expect_token(format($q$SELECT mark_affiliate_payout_paid(%L::uuid,NOW(),'ach','r',E' \t\n ')$q$, :'payout_id'),
  'ACTOR_REQUIRED');
SELECT f5_assert_eq('rejected actors left the payout unchanged',
  (SELECT status FROM affiliate_payouts WHERE id=:'payout_id'::uuid), :'payout_status_before');
SELECT f5_assert_eq('payout paid with a real actor',
  mark_affiliate_payout_paid(:'payout_id'::uuid,NOW(),'ach','r','admin')->>'outcome', 'paid');
SELECT f5_assert_eq('payout status is paid',
  (SELECT status FROM affiliate_payouts WHERE id=:'payout_id'::uuid), 'paid');

-- ═══════════════════════════════════════════════════════════════════════════
-- ITEM 1 + 2: recovery idempotency compares the FULL payload, and marker vs
-- collection keys can never be reused across operation kinds
-- ═══════════════════════════════════════════════════════════════════════════
\echo '########## ITEM 1: recovery idempotency is full-payload, not amount-only ##########'
-- Build an overpayment: accrue 1000, pay 1000, then a 400 refund reversal -> ledger 600, outstanding 400.
INSERT INTO order_refunds (id,order_id,stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,amount_cents,
  merchandise_refund_cents,shipping_refund_cents,tax_refund_cents,component_breakdown_status,status,refunded_at)
VALUES ('f5200000-0000-0000-0000-000000000001','f5100000-0000-0000-0000-000000000001','rf5a','chf5a','pi_f5a',4000,
  4000,0,0,'resolved','succeeded',NOW());
SELECT f5_assert_eq('refund reversal cents',
  apply_affiliate_refund_reversal('f5200000-0000-0000-0000-000000000001','s')->>'adjustment_cents', '-400');
SELECT f5_assert_eq('outstanding overpayment before any recovery',
  affiliate_commission_overpaid(:'cid1'::uuid)::text, '400');

\echo '--- record: same key + same FULL payload is a no-op ---'
SELECT f5_assert_eq('record first call',
  record_affiliate_payout_recovery(:'cid1'::uuid,100,'2026-02-01'::timestamptz,'admin','n1','K-REC-1','2026-02-01')->>'outcome',
  'recovery_recorded');
SELECT f5_assert_eq('record identical retry',
  record_affiliate_payout_recovery(:'cid1'::uuid,100,'2026-02-01'::timestamptz,'admin','n1','K-REC-1','2026-02-01')->>'outcome',
  'already_recorded');

\echo '--- record: same key + any changed field -> IDEMPOTENCY_CONFLICT, nothing mutated ---'
SELECT f5_expect_token(format($q$SELECT record_affiliate_payout_recovery(%L::uuid,
    100,'2026-02-01'::timestamptz,'admin','DIFFERENT NOTE','K-REC-1','2026-02-01')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_expect_token(format($q$SELECT record_affiliate_payout_recovery(%L::uuid,
    100,'2026-02-01'::timestamptz,'admin','n1','K-REC-1','2026-02-02')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_expect_token(format($q$SELECT record_affiliate_payout_recovery(%L::uuid,
    100,'2026-02-01'::timestamptz,'someone-else','n1','K-REC-1','2026-02-01')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_expect_token(format($q$SELECT record_affiliate_payout_recovery(%L::uuid,
    101,'2026-02-01'::timestamptz,'admin','n1','K-REC-1','2026-02-01')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_assert_eq('exactly one recovery-marker row for K-REC-1',
  (SELECT COUNT(*) FROM affiliate_commission_adjustments
    WHERE commission_id=:'cid1'::uuid AND recovery_idempotency_key='K-REC-1')::text, '1');

\echo '--- collect: same key + same FULL payload is a no-op ---'
SELECT f5_assert_eq('collect first call',
  collect_affiliate_recovery(:'cid1'::uuid,50,'2026-02-05'::timestamptz,'ach','ref-1','admin','K-COL-1','note-c','2026-02-05')->>'outcome',
  'collected');
SELECT f5_assert_eq('collect identical retry',
  collect_affiliate_recovery(:'cid1'::uuid,50,'2026-02-05'::timestamptz,'ach','ref-1','admin','K-COL-1','note-c','2026-02-05')->>'outcome',
  'already_collected');

\echo '--- collect: same key + any changed field -> IDEMPOTENCY_CONFLICT, nothing mutated ---'
SELECT f5_expect_token(format($q$SELECT collect_affiliate_recovery(%L::uuid,
    50,'2026-02-05'::timestamptz,'wire','ref-1','admin','K-COL-1','note-c','2026-02-05')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_expect_token(format($q$SELECT collect_affiliate_recovery(%L::uuid,
    50,'2026-02-05'::timestamptz,'ach','ref-DIFFERENT','admin','K-COL-1','note-c','2026-02-05')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_expect_token(format($q$SELECT collect_affiliate_recovery(%L::uuid,
    50,'2026-02-05'::timestamptz,'ach','ref-1','admin','K-COL-1','DIFFERENT NOTE','2026-02-05')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_expect_token(format($q$SELECT collect_affiliate_recovery(%L::uuid,
    50,'2026-02-05'::timestamptz,'ach','ref-1','someone-else','K-COL-1','note-c','2026-02-05')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_expect_token(format($q$SELECT collect_affiliate_recovery(%L::uuid,
    50,'2026-02-05'::timestamptz,'ach','ref-1','admin','K-COL-1','note-c','2026-02-06')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_expect_token(format($q$SELECT collect_affiliate_recovery(%L::uuid,
    51,'2026-02-05'::timestamptz,'ach','ref-1','admin','K-COL-1','note-c','2026-02-05')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_assert_eq('exactly one collection row for K-COL-1',
  (SELECT COUNT(*) FROM affiliate_commission_adjustments
    WHERE commission_id=:'cid1'::uuid AND recovery_idempotency_key='K-COL-1')::text, '1');

\echo '########## ITEM 1: marker and collection keys can never cross operation kinds ##########'
-- A RECORD key reused for COLLECT (same amount, so an amount-only check would pass).
SELECT f5_expect_token(format($q$SELECT collect_affiliate_recovery(%L::uuid,
    100,'2026-02-01'::timestamptz,'ach','x','admin','K-REC-1')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
-- A COLLECT key reused for RECORD at the SAME amount: the hardest case. record's
-- old (pre-Final5) check compared only recovery_amount_cents, which collect also
-- writes, so this used to slip through as 'already_recorded'.
SELECT f5_expect_token(format($q$SELECT record_affiliate_payout_recovery(%L::uuid,
    50,NOW(),'admin',NULL,'K-COL-1')$q$, :'cid1'), 'IDEMPOTENCY_CONFLICT');
SELECT f5_assert_eq('no cross-kind row was ever created',
  (SELECT COUNT(*) FROM affiliate_commission_adjustments
    WHERE commission_id=:'cid1'::uuid AND recovery_idempotency_key IN ('K-REC-1','K-COL-1'))::text, '2');
-- Money: the marker moved nothing, the single 50 collection reduced outstanding
-- 400 -> 350, and every rejected call above changed neither figure.
SELECT f5_assert_eq('outstanding after one 50 collection and all rejections',
  affiliate_commission_overpaid(:'cid1'::uuid)::text, '350');
SELECT f5_assert_eq('commission ledger economics unchanged by cash operations',
  (SELECT COALESCE(SUM(adjustment_cents),0) FROM affiliate_commission_adjustments
    WHERE commission_id=:'cid1'::uuid AND reason IN ('initial_accrual','refund_reversal','dispute_reversal'))::text, '600');

\echo '########## final5 fixture: ALL ASSERTIONS PASSED (fail-hard) ##########'
