-- KVRN 041 store credit liability ledger (SCHEMA ONLY; NOT APPLIED).
-- NO issuance, redemption, or checkout integration is enabled by this migration.
-- Must be reviewed against Stripe/return accounting and backed up before production execution.
BEGIN;
CREATE TABLE IF NOT EXISTS store_credit_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 -- HMAC-SHA256 of verified normalized checkout email, calculated with a server-only pepper.
 -- Never store a raw email or expose an account_key to the client.
 account_key text NOT NULL UNIQUE CHECK(account_key ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS store_credit_ledger (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES store_credit_accounts(id) ON DELETE RESTRICT,
 event_type text NOT NULL CHECK(event_type IN ('issue','hold','capture','release')),
 -- Strict per-event range; aggregate balances must ALSO be checked for overflow.
 amount_cents bigint NOT NULL CHECK(amount_cents>0 AND amount_cents<=9007199254740991),
 idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 12 AND 150),
 return_id uuid REFERENCES order_returns(id) ON DELETE RESTRICT,
 order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
 hold_key text CHECK(hold_key IS NULL OR length(hold_key) BETWEEN 8 AND 120),
 created_at timestamptz NOT NULL DEFAULT NOW(),
 CONSTRAINT sc_event_refs CHECK (
  (event_type='issue' AND return_id IS NOT NULL AND order_id IS NULL AND hold_key IS NULL)
  OR (event_type='hold' AND return_id IS NULL AND order_id IS NULL AND hold_key IS NOT NULL)
  OR (event_type='capture' AND return_id IS NULL AND order_id IS NOT NULL AND hold_key IS NOT NULL)
  OR (event_type='release' AND return_id IS NULL AND order_id IS NULL AND hold_key IS NOT NULL)
 )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_issue_return ON store_credit_ledger(return_id) WHERE event_type='issue';
CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_hold ON store_credit_ledger(account_id,hold_key) WHERE event_type='hold';
-- A hold can terminate exactly once: capture OR release, never both.
-- Still requires a serialized transactional writer to verify an existing matching hold.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_terminal_hold ON store_credit_ledger(account_id,hold_key)
 WHERE event_type IN ('capture','release');
CREATE INDEX IF NOT EXISTS idx_sc_account ON store_credit_ledger(account_id,id);
CREATE OR REPLACE FUNCTION kvrn_credit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'STORE_CREDIT_EVENTS_ARE_APPEND_ONLY'; END; $$;
CREATE TRIGGER store_credit_ledger_immutable BEFORE UPDATE OR DELETE ON store_credit_ledger
 FOR EACH ROW EXECUTE FUNCTION kvrn_credit_immutable();
-- Ledger balance is a liability, NOT a reduction in historical cash order revenue.
CREATE OR REPLACE VIEW store_credit_liability_totals AS
 SELECT COALESCE(SUM(amount_cents) FILTER(WHERE event_type='issue'),0)::bigint AS total_issued_cents,
        COALESCE(SUM(amount_cents) FILTER(WHERE event_type='capture'),0)::bigint AS total_redeemed_cents,
        (COALESCE(SUM(amount_cents) FILTER(WHERE event_type='issue'),0)
         - COALESCE(SUM(amount_cents) FILTER(WHERE event_type='capture'),0))::bigint AS outstanding_liability_cents
 FROM store_credit_ledger;
-- No exposed write procedure yet: release requires email verification, return inspection,
-- Stripe checkout split/refund handling, idempotent transaction and settlement proof.
COMMIT;
