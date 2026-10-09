-- KVRN 054 marketing cost reconciliation; NOT APPLIED / STAGING FIRST.
-- No sending, contact selection, or provider access in this migration.
-- Depends on 039, 046. Never release a budget merely because an API timed out;
-- unknown dispatch outcomes keep full worst-case reservation until reconciled.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_provider_cost_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reservation_id uuid NOT NULL UNIQUE REFERENCES marketing_budget_reservations(id) ON DELETE RESTRICT,
 provider text NOT NULL CHECK(provider IN ('twilio','resend')),
 outcome text NOT NULL CHECK(outcome IN ('charged','definitely_not_sent')),
 source text NOT NULL CHECK(source IN ('provider_final_status','provider_invoice','verified_provider_rejection')),
 provider_reference_sha256 text NOT NULL UNIQUE CHECK(provider_reference_sha256 ~ '^[0-9a-f]{64}$'),
 actual_micros bigint,
 evidenced_at timestamptz NOT NULL DEFAULT NOW(),
 CONSTRAINT provider_evidence_actual CHECK (
   (outcome='charged' AND actual_micros IS NOT NULL AND actual_micros>0
     AND source IN ('provider_final_status','provider_invoice')) OR
   (outcome='definitely_not_sent' AND actual_micros IS NULL
     AND source='verified_provider_rejection')
 )
);
CREATE OR REPLACE FUNCTION kvrn_marketing_cost_evidence_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MARKETING_COST_EVIDENCE_APPEND_ONLY'; END; $$;
CREATE TRIGGER marketing_cost_evidence_immutable BEFORE UPDATE OR DELETE ON marketing_provider_cost_evidence
  FOR EACH ROW EXECUTE FUNCTION kvrn_marketing_cost_evidence_append_only();

CREATE OR REPLACE FUNCTION kvrn_marketing_finalize_cost(p_reservation uuid,p_evidence uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_res marketing_budget_reservations%ROWTYPE;
 v_evidence marketing_provider_cost_evidence%ROWTYPE;
 v_target text;
BEGIN
 IF p_reservation IS NULL OR p_evidence IS NULL THEN RAISE EXCEPTION 'MARKETING_COST_INVALID_REFERENCE'; END IF;
 -- Same serialization lock as the budget reservation creation (046).
 PERFORM pg_advisory_xact_lock(48112026046::bigint);
 SELECT * INTO v_res FROM marketing_budget_reservations WHERE id=p_reservation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MARKETING_BUDGET_RESERVATION_MISSING'; END IF;
 SELECT * INTO v_evidence FROM marketing_provider_cost_evidence WHERE id=p_evidence FOR SHARE;
 IF NOT FOUND OR v_evidence.reservation_id<>p_reservation THEN RAISE EXCEPTION 'MARKETING_COST_EVIDENCE_MISMATCH'; END IF;
 IF (v_res.channel='sms' AND v_evidence.provider<>'twilio') OR
    (v_res.channel='email' AND v_evidence.provider<>'resend')
 THEN RAISE EXCEPTION 'MARKETING_COST_PROVIDER_CHANNEL_MISMATCH'; END IF;
 v_target:=CASE WHEN v_evidence.outcome='charged' THEN 'settled' ELSE 'released' END;
 IF v_target='settled' AND (v_evidence.actual_micros IS NULL OR v_evidence.actual_micros>v_res.reserved_micros)
 THEN RAISE EXCEPTION 'MARKETING_ACTUAL_EXCEEDS_RESERVED'; END IF;
 -- End-state retry only with the same authoritative immutable evidence.
 IF v_res.state<>'reserved' THEN
  IF v_res.state=v_target AND (
    (v_target='settled' AND v_res.actual_micros=v_evidence.actual_micros) OR
    (v_target='released' AND v_res.actual_micros IS NULL))
  THEN RETURN v_res.state; END IF;
  RAISE EXCEPTION 'MARKETING_BUDGET_FINALIZATION_CONFLICT';
 END IF;
 UPDATE marketing_budget_reservations
 SET state=v_target, actual_micros=CASE WHEN v_target='settled' THEN v_evidence.actual_micros ELSE NULL END,
   closed_at=NOW() WHERE id=p_reservation;
 RETURN v_target;
END; $$;
COMMIT;
