-- KVRN 060: append-only, private provisional provider receipt records.
-- UNAPPLIED. Requires 058-059. Staging/DB concurrency tests before production.
-- An initial Twilio/Resend HTTP success is NOT confirmed delivery, nor proof of
-- billable cost. This schema provides no sender, worker, retry, budget release,
-- subscription changes, or terminal provider outcome.
BEGIN;
CREATE TABLE IF NOT EXISTS marketing_provider_provisional_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES marketing_delivery_attempts(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('twilio','resend')),
  initial_result text NOT NULL CHECK (initial_result IN ('acknowledged','rejected','uncertain')),
  provider_reference_digest text UNIQUE CHECK (
     provider_reference_digest IS NULL OR provider_reference_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT marketing_provisional_reference_shape CHECK (
    (initial_result='acknowledged' AND provider_reference_digest IS NOT NULL)
    OR (initial_result IN ('rejected','uncertain') AND provider_reference_digest IS NULL)
  )
);
CREATE OR REPLACE FUNCTION kvrn_marketing_record_provisional_receipt(
 p_attempt uuid,p_provider text,p_result text,p_digest text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
 v_claim marketing_delivery_attempts%ROWTYPE;
 v_existing marketing_provider_provisional_receipts%ROWTYPE;
 v_id uuid;
BEGIN
 IF p_attempt IS NULL OR p_provider NOT IN ('twilio','resend')
   OR p_result NOT IN ('acknowledged','rejected','uncertain')
   OR (p_result='acknowledged' AND (p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'))
   OR (p_result<>'acknowledged' AND p_digest IS NOT NULL)
 THEN RAISE EXCEPTION 'MARKETING_PROVISIONAL_INVALID'; END IF;
 -- Ordered with claims and outcome recorder. No operation here touches budgets.
 PERFORM pg_advisory_xact_lock(48112026046::bigint);
 PERFORM pg_advisory_xact_lock(48112026050::bigint);
 SELECT * INTO v_claim FROM marketing_delivery_attempts WHERE id=p_attempt FOR SHARE;
 IF NOT FOUND OR v_claim.provider<>p_provider OR v_claim.state<>'unknown'
 THEN RAISE EXCEPTION 'MARKETING_PROVISIONAL_CLAIM_MISMATCH'; END IF;
 SELECT * INTO v_existing FROM marketing_provider_provisional_receipts
 WHERE attempt_id=p_attempt FOR SHARE;
 IF FOUND THEN
  IF v_existing.provider=p_provider AND v_existing.initial_result=p_result
     AND v_existing.provider_reference_digest IS NOT DISTINCT FROM p_digest
  THEN RETURN v_existing.id; END IF;
  RAISE EXCEPTION 'MARKETING_PROVISIONAL_CONFLICT_NO_RESEND';
 END IF;
 INSERT INTO marketing_provider_provisional_receipts(attempt_id,provider,initial_result,provider_reference_digest)
 VALUES(p_attempt,p_provider,p_result,p_digest) RETURNING id INTO v_id;
 RETURN v_id;
END; $$;
CREATE OR REPLACE FUNCTION kvrn_marketing_provisional_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MARKETING_PROVISIONAL_APPEND_ONLY'; END; $$;
CREATE TRIGGER marketing_provisional_immutable BEFORE UPDATE OR DELETE
 ON marketing_provider_provisional_receipts FOR EACH ROW EXECUTE FUNCTION kvrn_marketing_provisional_immutable();
COMMIT;
