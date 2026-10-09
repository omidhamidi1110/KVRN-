-- KVRN 061: private customer proof-of-email for store-credit balance and future redemption.
-- STAGING ONLY; requires 041 and 037. Does NOT enable redemption or Stripe checkout.
-- Each challenge is single-use; a GET/link-preview cannot consume it. No plaintext
-- email, email token, account HMAC secret, or session token is stored in this schema.
BEGIN;
CREATE TABLE store_credit_identity_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_key text NOT NULL CHECK(account_key ~ '^[0-9a-f]{64}$'),
 token_sha256 text NOT NULL UNIQUE CHECK(token_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT NOW(),
 expires_at timestamptz NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
 redeemed_at timestamptz,
 CONSTRAINT credit_identity_challenge_ttl CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '10 minutes'),
 CONSTRAINT credit_identity_challenge_redemption CHECK(redeemed_at IS NULL OR redeemed_at>=created_at)
);
CREATE INDEX idx_credit_identity_challenge_cleanup ON store_credit_identity_challenges(expires_at);
CREATE TABLE store_credit_identity_sessions (
 token_sha256 text PRIMARY KEY CHECK(token_sha256 ~ '^[0-9a-f]{64}$'),
 account_key text NOT NULL CHECK(account_key ~ '^[0-9a-f]{64}$'),
 challenge_id uuid NOT NULL UNIQUE REFERENCES store_credit_identity_challenges(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT NOW(),
 expires_at timestamptz NOT NULL DEFAULT(NOW()+INTERVAL '30 minutes'),
 revoked_at timestamptz,
 CONSTRAINT credit_identity_session_ttl CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '30 minutes'),
 CONSTRAINT credit_identity_session_revoked CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX idx_credit_identity_session_cleanup ON store_credit_identity_sessions(expires_at);

-- The ONLY way to redeem a challenge into a browser session. Row lock ensures
-- two concurrent clicks cannot mint two sessions from the same email proof.
CREATE FUNCTION kvrn_credit_redeem_identity_challenge(
 p_challenge_id uuid,p_challenge_digest text,p_session_digest text
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_challenge store_credit_identity_challenges%ROWTYPE;
BEGIN
 IF p_challenge_id IS NULL OR p_challenge_digest IS NULL OR p_session_digest IS NULL
  OR p_challenge_digest !~ '^[0-9a-f]{64}$'
  OR p_session_digest !~ '^[0-9a-f]{64}$' OR p_challenge_digest=p_session_digest
 THEN RETURN false; END IF;
 SELECT * INTO v_challenge FROM store_credit_identity_challenges
 WHERE id=p_challenge_id FOR UPDATE;
 IF NOT FOUND OR v_challenge.redeemed_at IS NOT NULL
  OR v_challenge.expires_at<=NOW() OR v_challenge.token_sha256<>p_challenge_digest
 THEN RETURN false; END IF;
 UPDATE store_credit_identity_challenges SET redeemed_at=NOW() WHERE id=v_challenge.id;
 INSERT INTO store_credit_identity_sessions(token_sha256,account_key,challenge_id)
 VALUES(p_session_digest,v_challenge.account_key,v_challenge.id);
 RETURN true;
END; $$;

-- Hash lookup used for balance reads; callers independently verify the supplied
-- checkout email's HMAC account key. This does not authorize a redemption.
CREATE FUNCTION kvrn_credit_verified_account_key(p_session_digest text)
RETURNS text LANGUAGE sql STABLE AS $$
 SELECT account_key FROM store_credit_identity_sessions
 WHERE token_sha256=p_session_digest AND revoked_at IS NULL AND expires_at>NOW()
 LIMIT 1;
$$;
-- Revoke even if a browser deletes its cookie; no account keys sent to a client.
CREATE FUNCTION kvrn_credit_revoke_identity_session(p_digest text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 UPDATE store_credit_identity_sessions SET revoked_at=NOW()
 WHERE token_sha256=p_digest AND revoked_at IS NULL;
 RETURN FOUND;
END; $$;
COMMIT;
