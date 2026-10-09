-- KVRN 059: provider-verified, immutable delivery-attempt outcome persistence.
-- STAGING ONLY / NOT APPLIED. Depends on 058. NO send, no cron, no automatic
-- retry, and no budget settlement. Must be called only after independent provider
-- authentication and exact message/attempt correlation by a trusted server handler.
BEGIN;
CREATE OR REPLACE FUNCTION kvrn_marketing_record_verified_attempt_outcome(
  p_attempt uuid,p_outcome text,p_source text,p_provider_reference_sha256 text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_attempt marketing_delivery_attempts%ROWTYPE;
  v_existing marketing_delivery_attempt_outcomes%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_attempt IS NULL OR p_outcome NOT IN ('provider_accepted','verified_not_submitted')
    OR p_source NOT IN ('provider_final_status','provider_invoice','verified_provider_rejection')
    OR p_provider_reference_sha256 IS NULL OR p_provider_reference_sha256 !~ '^[0-9a-f]{64}$'
    OR (p_outcome='verified_not_submitted' AND p_source<>'verified_provider_rejection')
    OR (p_outcome='provider_accepted' AND p_source NOT IN ('provider_final_status','provider_invoice'))
  THEN RAISE EXCEPTION 'MARKETING_OUTCOME_UNVERIFIED_INPUT'; END IF;

  -- Same lock ordering as claims: budget then plan. Terminal evidence cannot be
  -- written to a different claimed message or fabricated before the claim.
  PERFORM pg_advisory_xact_lock(48112026046::bigint);
  PERFORM pg_advisory_xact_lock(48112026050::bigint);
  SELECT * INTO v_attempt FROM marketing_delivery_attempts WHERE id=p_attempt FOR SHARE;
  IF NOT FOUND OR v_attempt.state<>'unknown'
    OR v_attempt.claimed_at IS NULL OR v_attempt.claimed_at>NOW()
  THEN RAISE EXCEPTION 'MARKETING_OUTCOME_ATTEMPT_INVALID'; END IF;

  SELECT * INTO v_existing FROM marketing_delivery_attempt_outcomes
    WHERE attempt_id=p_attempt FOR SHARE;
  IF FOUND THEN
    IF v_existing.outcome=p_outcome AND v_existing.verified_source=p_source
      AND v_existing.provider_reference_sha256=p_provider_reference_sha256
    THEN RETURN v_existing.id; END IF;
    RAISE EXCEPTION 'MARKETING_OUTCOME_CONFLICT_NO_RETRY';
  END IF;
  IF EXISTS(SELECT 1 FROM marketing_delivery_attempt_outcomes
      WHERE provider_reference_sha256=p_provider_reference_sha256)
  THEN RAISE EXCEPTION 'MARKETING_OUTCOME_PROVIDER_PROOF_REUSED'; END IF;

  INSERT INTO marketing_delivery_attempt_outcomes(
    attempt_id,outcome,verified_source,provider_reference_sha256)
  VALUES(p_attempt,p_outcome,p_source,p_provider_reference_sha256) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
-- Explicitly do NOT update marketing_budget_reservations, attempt.state, or
-- staged delivery state here. Provider accepted != billed or delivered.
-- Existing migration 058 append-only trigger protects rows from updates/deletes.
COMMIT;
