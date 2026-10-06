-- KVRN Migration 026 — Support inbox (support@kvrn.shop + storefront contact form)
--
-- Forward-only. Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE,
-- DROP TRIGGER IF EXISTS, so re-running it any number of times is safe.
-- Migrations 001–025 are not edited.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
--
-- A small, focused support inbox. There was no support / inbox / thread / email-message
-- model before this migration, so nothing is replaced and no second competing store exists.
--
--   support_threads    one conversation with one customer (mutable metadata only)
--   support_messages   one message in a thread (IMMUTABLE facts: no UPDATE, DELETE or TRUNCATE)
--
-- Message content is customer data. Nothing here stores a credential, and attachment
-- BINARIES are never stored: attachment_metadata is a JSON array of {filename, mimeType,
-- size, disposition} only. The forwarded mailbox keeps the original attachment.
--
-- ── ATOMIC WRITE PATHS (SQL functions, same style as 019–025) ───────────────
--
--   support_ingest_message(jsonb)    inbound email OR storefront contact form:
--                                    idempotency + thread resolution + message insert +
--                                    thread counters, in ONE transaction.
--   support_record_outbound(jsonb)   an admin reply AFTER the email provider accepted it:
--                                    idempotent insert + thread update + audit row.
--   support_set_thread_status(...)   close / reopen, with an audit row.
--
-- Normalization (email address, subject key, header Message-ID tokens) is done by the
-- application (lib/support-inbox.ts) and passed in; the database only matches on the
-- normalized values it is given, so the rules live in exactly one place.
--
-- ── THREAD RESOLUTION (conservative) ────────────────────────────────────────
--
--   1. In-Reply-To matched against a stored internet_message_id - ONLY in a thread whose customer_email
--      equals the inbound sender.
--   2. References, most recent id first, matched the same way (same sender rule).
--      A header can therefore never pull a message into another customer's conversation: Message-IDs
--      are not secret (they sit in every mail the customer's own server touches), so a different
--      sender that quotes one is stored as its own thread (never discarded) and the existing thread
--      is untouched. There is deliberately no cross-sender attach and no merge feature.
--   3. Fallback ONLY if no header matched: same normalized customer email, same normalized
--      (Re:/Fwd:-stripped) non-empty subject, thread OPEN, last activity within 14 days, and
--      EXACTLY ONE such thread. Zero or several candidates -> a new thread, so unrelated
--      issues are never merged by guesswork.
--   4. A storefront contact-form submission ALWAYS opens a new thread (force_new_thread):
--      anyone can type any email address into a form, so a form post must never be able to
--      attach itself to somebody else's existing conversation.
--
-- ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
--
--   * dedupe_key is unique. For email it is 'mid:<normalized Message-ID>' when the message has
--     one, else 'sha256:<digest of the raw message>' (a content digest, NOT an invented
--     Message-ID; internet_message_id stays NULL). Contact forms use 'cf:<submission id>'
--     when the browser sent one. Outbound replies use 'out:<client request id>'.
--   * internet_message_id and (provider, provider_message_id) are unique when present.
--   * A redelivered email / retried request returns the existing row (duplicate = true) and
--     changes nothing: no second message, no second unread increment.
--
-- ── WHAT DOES NOT CHANGE ────────────────────────────────────────────────────
--
--   No order, payment, inventory, FIFO, refund, cancellation or checkout object is read or
--   written. The only pre-existing table touched is admin_audit_logs (INSERT only).

BEGIN;

-- ── support_threads ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS support_threads (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_email         TEXT        NOT NULL,
  customer_name          TEXT,
  -- Subject of the first message, exactly as received ('' if the sender gave none).
  subject                TEXT        NOT NULL,
  -- Normalized subject (Re:/Fwd: stripped, lower-cased, whitespace collapsed). Fallback matching only.
  subject_key            TEXT        NOT NULL,
  -- Free text typed on the storefront form; NOT validated against orders.
  order_number           TEXT,
  status                 TEXT        NOT NULL DEFAULT 'open',
  source                 TEXT        NOT NULL,
  unread_count           INTEGER     NOT NULL DEFAULT 0,
  last_message_at        TIMESTAMPTZ NOT NULL,
  last_message_direction TEXT        NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT st_status_chk    CHECK (status IN ('open', 'closed')),
  CONSTRAINT st_source_chk    CHECK (source IN ('email', 'contact_form')),
  CONSTRAINT st_unread_chk    CHECK (unread_count >= 0),
  CONSTRAINT st_direction_chk CHECK (last_message_direction IN ('inbound', 'outbound')),
  CONSTRAINT st_email_chk     CHECK (
    customer_email = lower(btrim(customer_email))
    AND char_length(customer_email) BETWEEN 3 AND 254
    AND customer_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  CONSTRAINT st_subject_len_chk CHECK (char_length(subject) <= 998 AND char_length(subject_key) <= 998),
  CONSTRAINT st_name_len_chk    CHECK (customer_name IS NULL OR char_length(customer_name) <= 200),
  CONSTRAINT st_order_len_chk   CHECK (order_number IS NULL OR char_length(order_number) <= 60)
);

CREATE INDEX IF NOT EXISTS st_list_idx
  ON support_threads (status, last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS st_recent_idx
  ON support_threads (last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS st_unread_idx
  ON support_threads (last_message_at DESC, id DESC) WHERE unread_count > 0;
CREATE INDEX IF NOT EXISTS st_customer_idx
  ON support_threads (customer_email, last_message_at DESC);
CREATE INDEX IF NOT EXISTS st_fallback_idx
  ON support_threads (customer_email, subject_key, last_message_at DESC) WHERE status = 'open';

-- ── support_messages ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS support_messages (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           UUID        NOT NULL REFERENCES support_threads(id) ON DELETE RESTRICT,
  direction           TEXT        NOT NULL,
  channel             TEXT        NOT NULL,
  provider            TEXT        NOT NULL,
  provider_message_id TEXT,
  internet_message_id TEXT,
  dedupe_key          TEXT,
  in_reply_to         TEXT,
  references_header   TEXT,
  from_email          TEXT        NOT NULL,
  from_name           TEXT,
  to_email            TEXT        NOT NULL,
  subject             TEXT        NOT NULL,
  body_text           TEXT        NOT NULL,
  -- [{filename, mimeType, size, disposition}] — metadata only, never content.
  attachment_metadata JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Set when the stored copy is not the whole message (truncated body, parse failure, too large).
  import_note         TEXT,
  -- The admin who sent an outbound reply. NULL for inbound.
  actor_email         TEXT,
  -- The time the SENDER claims (an email Date header, clamped to never be in the future). Display
  -- only: a skewed or forged sender clock must not reorder a conversation or hide an unread reply.
  occurred_at         TIMESTAMPTZ NOT NULL,
  -- When KVRN stored it. Conversation order and last_message_at follow ARRIVAL, i.e. this column.
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sm_direction_chk CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT sm_channel_chk   CHECK (channel IN ('email', 'contact_form')),
  CONSTRAINT sm_provider_chk  CHECK (provider IN ('cloudflare_email', 'resend', 'contact_form')),
  CONSTRAINT sm_combo_chk CHECK (
    (direction = 'inbound'  AND channel = 'email'        AND provider = 'cloudflare_email') OR
    (direction = 'inbound'  AND channel = 'contact_form' AND provider = 'contact_form')     OR
    (direction = 'outbound' AND channel = 'email'        AND provider = 'resend')
  ),
  -- An outbound message exists only because the provider accepted it, so it always has the
  -- provider id, the admin who sent it, and real text.
  CONSTRAINT sm_outbound_chk CHECK (
    direction = 'inbound'
    OR (provider_message_id IS NOT NULL AND actor_email IS NOT NULL AND btrim(body_text) <> '')
  ),
  CONSTRAINT sm_attachments_chk CHECK (
    jsonb_typeof(attachment_metadata) = 'array' AND jsonb_array_length(attachment_metadata) <= 100
  ),
  CONSTRAINT sm_len_chk CHECK (
    char_length(body_text) <= 200000
    AND char_length(subject) <= 998
    AND char_length(from_email) <= 254 AND char_length(to_email) <= 254
    AND (internet_message_id IS NULL OR char_length(internet_message_id) <= 998)
    AND (in_reply_to IS NULL OR char_length(in_reply_to) <= 4000)
    AND (references_header IS NULL OR char_length(references_header) <= 8000)
    AND (import_note IS NULL OR char_length(import_note) <= 300)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sm_internet_message_id_uq
  ON support_messages (internet_message_id) WHERE internet_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sm_provider_message_id_uq
  ON support_messages (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sm_dedupe_key_uq
  ON support_messages (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sm_thread_idx
  ON support_messages (thread_id, created_at, id);

-- ── Guards ──────────────────────────────────────────────────────────────────

-- Messages are immutable facts. The thread FK is RESTRICT and threads cannot be deleted
-- either, so no message can disappear through a cascade.
CREATE OR REPLACE FUNCTION support_messages_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KVRN_SUPPORT|MESSAGE_IMMUTABLE|support_messages is append-only (% blocked)', TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS sm_immutable ON support_messages;
CREATE TRIGGER sm_immutable BEFORE UPDATE OR DELETE ON support_messages
  FOR EACH ROW EXECUTE FUNCTION support_messages_immutable();
DROP TRIGGER IF EXISTS sm_no_truncate ON support_messages;
CREATE TRIGGER sm_no_truncate BEFORE TRUNCATE ON support_messages
  FOR EACH STATEMENT EXECUTE FUNCTION support_messages_immutable();

-- A thread's identity (who it is with, what it was about, where it came from) is fixed at
-- creation. Status, read counter, last-message pointers, a late-learned display name and a
-- late-learned order number may change. Threads are never deleted.
CREATE OR REPLACE FUNCTION support_threads_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|THREAD_UNDELETABLE|support_threads rows are never deleted'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.customer_email <> OLD.customer_email
     OR NEW.subject <> OLD.subject
     OR NEW.subject_key <> OLD.subject_key
     OR NEW.source <> OLD.source
     OR NEW.created_at <> OLD.created_at
     OR (OLD.customer_name IS NOT NULL AND NEW.customer_name IS DISTINCT FROM OLD.customer_name)
     OR (OLD.order_number  IS NOT NULL AND NEW.order_number  IS DISTINCT FROM OLD.order_number) THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|THREAD_IDENTITY_IMMUTABLE|thread identity fields cannot change'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS st_guard ON support_threads;
CREATE TRIGGER st_guard BEFORE UPDATE OR DELETE ON support_threads
  FOR EACH ROW EXECUTE FUNCTION support_threads_guard();
DROP TRIGGER IF EXISTS st_no_truncate ON support_threads;
CREATE TRIGGER st_no_truncate BEFORE TRUNCATE ON support_threads
  FOR EACH STATEMENT EXECUTE FUNCTION support_threads_guard();

-- set_updated_at() is defined in migration 001 and used by the other mutable tables.
DROP TRIGGER IF EXISTS set_support_threads_updated_at ON support_threads;
CREATE TRIGGER set_support_threads_updated_at BEFORE UPDATE ON support_threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── support_ingest_message ──────────────────────────────────────────────────
--
-- Input (jsonb), every value already normalized by lib/support-inbox.ts:
--   provider            'cloudflare_email' | 'contact_form'
--   dedupe_key          text (required for cloudflare_email; optional for contact_form)
--   internet_message_id text | null
--   in_reply_to_ids     [text]  Message-ID tokens from In-Reply-To
--   reference_ids       [text]  Message-ID tokens from References, MOST RECENT FIRST
--   in_reply_to / references_header   raw header text kept for audit
--   customer_email, customer_name, from_email, from_name, to_email
--   subject, subject_key, body_text, attachments [..], import_note
--   occurred_at         timestamptz text | null (sender-claimed; clamped to now(); future dates never stored)
--   order_number        text | null
--   force_new_thread    boolean
-- Returns: {duplicate, thread_id, message_id, thread_created, matched_by}

CREATE OR REPLACE FUNCTION support_ingest_message(p JSONB) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_provider   TEXT    := p->>'provider';
  v_dedupe     TEXT    := NULLIF(p->>'dedupe_key', '');
  v_mid        TEXT    := NULLIF(p->>'internet_message_id', '');
  v_cust       TEXT    := p->>'customer_email';
  v_key        TEXT    := COALESCE(p->>'subject_key', '');
  v_force_new  BOOLEAN := COALESCE((p->>'force_new_thread')::boolean, FALSE);
  v_occ        TIMESTAMPTZ;
  v_dup        RECORD;
  v_thread     UUID;
  v_matched    TEXT := 'new';
  v_created    BOOLEAN := FALSE;
  v_msg        UUID;
  v_source     TEXT;
  v_channel    TEXT;
  v_cands      UUID[];
  v_note       TEXT;
BEGIN
  IF v_provider NOT IN ('cloudflare_email', 'contact_form') THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|INVALID_PROVIDER|%', v_provider;
  END IF;
  IF v_provider = 'cloudflare_email' AND v_dedupe IS NULL THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|DEDUPE_KEY_REQUIRED|inbound email needs a dedupe key';
  END IF;
  IF v_cust IS NULL THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|INVALID|customer_email is required';
  END IF;

  v_channel := CASE WHEN v_provider = 'contact_form' THEN 'contact_form' ELSE 'email' END;
  v_source  := v_channel;
  -- The sender's claimed time is display-only. An unparseable / out-of-range value must never make a
  -- valid message unstorable, so any failure here falls back to the arrival time.
  BEGIN
    v_occ := LEAST(COALESCE(NULLIF(p->>'occurred_at', '')::timestamptz, NOW()), NOW());
  EXCEPTION WHEN OTHERS THEN
    v_occ := NOW();
  END;

  -- Serialize concurrent deliveries of the SAME message, then look for it.
  IF v_dedupe IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('kvrn_support_dedupe|' || v_dedupe, 0));
  END IF;
  IF v_mid IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('kvrn_support_mid|' || v_mid, 0));
  END IF;

  SELECT m.id, m.thread_id, m.from_email INTO v_dup
    FROM support_messages m
   WHERE (v_dedupe IS NOT NULL AND m.dedupe_key = v_dedupe)
      OR (v_mid    IS NOT NULL AND m.internet_message_id = v_mid)
   ORDER BY m.created_at
   LIMIT 1;
  IF FOUND THEN
    IF v_dup.from_email = p->>'from_email' THEN
      -- The same message from the same sender: a redelivery. Nothing changes.
      RETURN jsonb_build_object('duplicate', TRUE, 'thread_id', v_dup.thread_id,
                                'message_id', v_dup.id, 'thread_created', FALSE, 'matched_by', 'duplicate');
    END IF;
    -- The same Message-ID / key but a DIFFERENT sender: a weak mailer reusing an id (e.g. <1@localhost>)
    -- or a forged id. The message is real and must not be silently dropped as a "duplicate". It is stored
    -- WITHOUT the colliding Message-ID (so header threading cannot be steered by it) under a sender-scoped key.
    v_dedupe := COALESCE(v_dedupe, 'mid:' || v_mid) || '|' || (p->>'from_email');
    v_mid    := NULL;
    v_note   := 'Message-ID was already used by a different sender; stored without it.';
    SELECT m.id, m.thread_id INTO v_dup FROM support_messages m WHERE m.dedupe_key = v_dedupe LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', TRUE, 'thread_id', v_dup.thread_id,
                                'message_id', v_dup.id, 'thread_created', FALSE, 'matched_by', 'duplicate');
    END IF;
  END IF;

  -- Serialize thread resolution per customer so two near-simultaneous first messages do not
  -- each create their own thread.
  PERFORM pg_advisory_xact_lock(hashtextextended('kvrn_support_cust|' || v_cust, 0));

  IF NOT v_force_new THEN
    -- 1. In-Reply-To (only into a thread belonging to THIS sender)
    SELECT m.thread_id INTO v_thread
      FROM jsonb_array_elements_text(COALESCE(p->'in_reply_to_ids', '[]'::jsonb)) WITH ORDINALITY r(id, ord)
      JOIN support_messages m ON m.internet_message_id = r.id
      JOIN support_threads  t ON t.id = m.thread_id AND t.customer_email = v_cust   -- same sender only
     ORDER BY r.ord
     LIMIT 1;
    IF v_thread IS NOT NULL THEN
      v_matched := 'in_reply_to';
    ELSE
      -- 2. References (most recent first, as supplied)
      SELECT m.thread_id INTO v_thread
        FROM jsonb_array_elements_text(COALESCE(p->'reference_ids', '[]'::jsonb)) WITH ORDINALITY r(id, ord)
        JOIN support_messages m ON m.internet_message_id = r.id
        JOIN support_threads  t ON t.id = m.thread_id AND t.customer_email = v_cust   -- same sender only
       ORDER BY r.ord
       LIMIT 1;
      IF v_thread IS NOT NULL THEN v_matched := 'references'; END IF;
    END IF;

    -- 3. Conservative fallback: exactly one open recent thread, same customer, same subject key.
    IF v_thread IS NULL AND v_key <> '' THEN
      SELECT array_agg(s.id) INTO v_cands FROM (
        SELECT t.id FROM support_threads t
         WHERE t.customer_email = v_cust
           AND t.subject_key    = v_key
           AND t.status         = 'open'
           AND t.last_message_at > NOW() - INTERVAL '14 days'
         LIMIT 2
      ) s;
      IF v_cands IS NOT NULL AND cardinality(v_cands) = 1 THEN
        v_thread  := v_cands[1];
        v_matched := 'subject';
      END IF;
    END IF;
  END IF;

  IF v_thread IS NULL THEN
    INSERT INTO support_threads
      (customer_email, customer_name, subject, subject_key, order_number, status, source,
       unread_count, last_message_at, last_message_direction)
    VALUES
      (v_cust, NULLIF(p->>'customer_name', ''), COALESCE(p->>'subject', ''), v_key,
       NULLIF(p->>'order_number', ''), 'open', v_source, 0, NOW(), 'inbound')
    RETURNING id INTO v_thread;
    v_created := TRUE;
  END IF;

  INSERT INTO support_messages
    (thread_id, direction, channel, provider, internet_message_id, dedupe_key, in_reply_to,
     references_header, from_email, from_name, to_email, subject, body_text,
     attachment_metadata, import_note, occurred_at)
  VALUES
    (v_thread, 'inbound', v_channel, v_provider, v_mid, v_dedupe,
     NULLIF(p->>'in_reply_to', ''), NULLIF(p->>'references_header', ''),
     p->>'from_email', NULLIF(p->>'from_name', ''), p->>'to_email',
     COALESCE(p->>'subject', ''), COALESCE(p->>'body_text', ''),
     COALESCE(p->'attachments', '[]'::jsonb),
     NULLIF(btrim(concat_ws(' ', NULLIF(p->>'import_note', ''), v_note)), ''), v_occ)
  RETURNING id INTO v_msg;

  -- Thread counters. A new message reopens a closed thread and moves the thread to the top of the
  -- inbox by ARRIVAL time (never by the sender's claimed Date).
  UPDATE support_threads t
     SET status       = 'open',
         unread_count = t.unread_count + 1,
         last_message_direction = 'inbound',
         last_message_at = GREATEST(t.last_message_at, NOW()),
         customer_name = COALESCE(t.customer_name, NULLIF(p->>'customer_name', '')),
         order_number  = COALESCE(t.order_number,  NULLIF(p->>'order_number', ''))
   WHERE t.id = v_thread;

  RETURN jsonb_build_object('duplicate', FALSE, 'thread_id', v_thread, 'message_id', v_msg,
                            'thread_created', v_created, 'matched_by', v_matched);
END;
$$;

-- ── support_unread_after ────────────────────────────────────────────────────
--
-- How many INBOUND messages arrived after a message the admin has seen. Used so that "mark read" and
-- "reply" clear exactly what the admin saw, and a customer message that arrived while the thread was open
-- stays unread. NULL when p_seen is not a message of the thread (then the caller leaves the counter alone).

CREATE OR REPLACE FUNCTION support_unread_after(p_thread UUID, p_seen UUID) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN s.id IS NULL THEN NULL ELSE (
           SELECT count(*)::int FROM support_messages m
            WHERE m.thread_id = p_thread AND m.direction = 'inbound'
              AND (m.created_at, m.id) > (s.created_at, s.id)) END
    FROM (SELECT 1) one
    LEFT JOIN support_messages s ON s.id = p_seen AND s.thread_id = p_thread
$$;

-- ── support_mark_thread_read ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION support_mark_thread_read(p_thread UUID, p_seen UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_row support_threads%ROWTYPE;
  v_new INTEGER;
BEGIN
  SELECT * INTO v_row FROM support_threads WHERE id = p_thread FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', FALSE, 'cleared', FALSE, 'unread', 0);
  END IF;
  IF p_seen IS NULL THEN
    v_new := 0;
  ELSE
    v_new := LEAST(v_row.unread_count, COALESCE(support_unread_after(p_thread, p_seen), v_row.unread_count));
  END IF;
  IF v_new <> v_row.unread_count THEN
    UPDATE support_threads SET unread_count = v_new WHERE id = p_thread;
  END IF;
  RETURN jsonb_build_object('found', TRUE, 'cleared', v_new <> v_row.unread_count, 'unread', v_new);
END;
$$;

-- ── support_record_outbound ─────────────────────────────────────────────────
--
-- Called ONLY after the email provider accepted the message. Input (jsonb):
--   thread_id, to_email (must equal the thread's customer), provider_message_id (required),
--   internet_message_id (nullable), dedupe_key, in_reply_to, references_header,
--   from_email, from_name, subject, body_text, actor_email (required),
--   seen_through_message_id (optional: the newest message the admin had on screen when the reply was
--   started; inbound messages that arrived AFTER it stay unread)
-- Returns: {duplicate, thread_id, message_id}

CREATE OR REPLACE FUNCTION support_record_outbound(p JSONB) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_thread    UUID := (p->>'thread_id')::uuid;
  v_dedupe    TEXT := NULLIF(p->>'dedupe_key', '');
  v_pmid      TEXT := NULLIF(p->>'provider_message_id', '');
  v_mid       TEXT := NULLIF(p->>'internet_message_id', '');
  v_actor     TEXT := NULLIF(btrim(COALESCE(p->>'actor_email', '')), '');
  v_row       support_threads%ROWTYPE;
  v_dup       RECORD;
  v_msg       UUID;
BEGIN
  IF v_pmid IS NULL THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|PROVIDER_ID_REQUIRED|an outbound message is stored only after the provider accepted it';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|ACTOR_REQUIRED|actor_email is required';
  END IF;

  IF v_dedupe IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('kvrn_support_dedupe|' || v_dedupe, 0));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kvrn_support_pmid|' || v_pmid, 0));

  SELECT m.id, m.thread_id INTO v_dup
    FROM support_messages m
   WHERE (v_dedupe IS NOT NULL AND m.dedupe_key = v_dedupe)
      OR (m.provider = 'resend' AND m.provider_message_id = v_pmid)
      OR (v_mid IS NOT NULL AND m.internet_message_id = v_mid)
   ORDER BY m.created_at
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('duplicate', TRUE, 'thread_id', v_dup.thread_id, 'message_id', v_dup.id);
  END IF;

  SELECT * INTO v_row FROM support_threads WHERE id = v_thread FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|THREAD_NOT_FOUND|%', v_thread;
  END IF;
  IF lower(btrim(COALESCE(p->>'to_email', ''))) <> v_row.customer_email THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|RECIPIENT_MISMATCH|a reply may only go to the thread customer';
  END IF;

  INSERT INTO support_messages
    (thread_id, direction, channel, provider, provider_message_id, internet_message_id, dedupe_key,
     in_reply_to, references_header, from_email, from_name, to_email, subject, body_text,
     attachment_metadata, actor_email, occurred_at)
  VALUES
    (v_thread, 'outbound', 'email', 'resend', v_pmid, v_mid, v_dedupe,
     NULLIF(p->>'in_reply_to', ''), NULLIF(p->>'references_header', ''),
     p->>'from_email', NULLIF(p->>'from_name', ''), v_row.customer_email,
     COALESCE(p->>'subject', ''), p->>'body_text', '[]'::jsonb, v_actor, NOW())
  RETURNING id INTO v_msg;

  -- Replying means the conversation has been read — up to what the admin had seen. A customer message
  -- that arrived while the reply was being written stays unread.
  UPDATE support_threads
     SET unread_count = CASE
           WHEN NULLIF(p->>'seen_through_message_id', '') IS NULL THEN 0
           ELSE LEAST(unread_count, COALESCE(support_unread_after(v_thread, (p->>'seen_through_message_id')::uuid), 0)) END,
         last_message_at = GREATEST(last_message_at, NOW()),
         last_message_direction = 'outbound'
   WHERE id = v_thread;

  -- No message body and no customer address in the audit payload.
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (v_actor, 'support_reply_sent', 'support_thread', v_thread::text,
          jsonb_build_object('message_id', v_msg, 'provider_message_id', v_pmid,
                             'internet_message_id_captured', v_mid IS NOT NULL,
                             'body_chars', char_length(p->>'body_text')));

  RETURN jsonb_build_object('duplicate', FALSE, 'thread_id', v_thread, 'message_id', v_msg);
END;
$$;

-- ── support_set_thread_status ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION support_set_thread_status(p_thread UUID, p_status TEXT, p_actor TEXT)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_actor TEXT := NULLIF(btrim(COALESCE(p_actor, '')), '');
  v_old   TEXT;
BEGIN
  IF p_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|INVALID_STATUS|%', p_status;
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|ACTOR_REQUIRED|actor is required';
  END IF;

  SELECT status INTO v_old FROM support_threads WHERE id = p_thread FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KVRN_SUPPORT|THREAD_NOT_FOUND|%', p_thread;
  END IF;
  IF v_old = p_status THEN
    RETURN jsonb_build_object('changed', FALSE, 'status', p_status);
  END IF;

  UPDATE support_threads SET status = p_status WHERE id = p_thread;
  INSERT INTO admin_audit_logs (actor_email, action, resource, resource_id, payload)
  VALUES (v_actor,
          CASE WHEN p_status = 'closed' THEN 'support_thread_closed' ELSE 'support_thread_reopened' END,
          'support_thread', p_thread::text,
          jsonb_build_object('from', v_old, 'to', p_status));
  RETURN jsonb_build_object('changed', TRUE, 'status', p_status);
END;
$$;

COMMIT;
