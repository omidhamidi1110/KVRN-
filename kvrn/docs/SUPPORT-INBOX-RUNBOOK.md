# Support Inbox runbook (support@kvrn.shop)

What this adds: mail sent to **support@kvrn.shop** is (1) forwarded in full to the owner's own mailbox,
(2) stored in KVRN's Neon database and shown in **Admin → Support**, and (3) answerable from the admin
(FROM `KVRN Support <support@kvrn.shop>`, Reply-To `support@kvrn.shop`, sent through Resend). The storefront
contact form now saves into the same inbox.

Nothing in this change is deployed or applied. Every step below is a manual step for the owner, **after** code review.

```
sender ──► support@kvrn.shop ──► Cloudflare Email Routing ──► Worker "kvrn" email() handler
                                                               ├─ message.forward(SUPPORT_FORWARD_TO)   (full original, attachments included)
                                                               └─ POST /api/internal/support-email-ingest (Bearer SUPPORT_EMAIL_INGEST_SECRET)
                                                                     └─ Neon: support_threads / support_messages
Admin → Support ── reply ──► Resend (support@kvrn.shop) ──► customer ──► reply ──► (same route, same thread)
```

## 0. Order of operations

1. Review the code. Run the tests (`npx jest --runInBand`).
2. **Apply migration `db/migrations/026_support_inbox.sql` to Neon** (see §1). Idempotent; safe to re-run.
3. Set the two Worker secrets (§2) and verify the sender in Resend (§4).
4. Deploy the Worker as you normally do.
5. Only **after** the deploy, create the Email Routing rule (§3). Routing before the deploy would hit a Worker with no `email()` handler.
6. Run the end-to-end test (§5).

The migration and the secrets can be done before the deploy; the website keeps working either way (the contact form
returns an honest error until 026 exists, rather than pretending to succeed).

## 1. Database

Apply `026_support_inbox.sql` to the Neon database with your usual migration procedure, e.g.

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/026_support_inbox.sql
```

It only creates new objects (`support_threads`, `support_messages`, indexes, triggers, `support_*` functions). It does not
touch orders, payments, inventory, FIFO, refunds or cancellations. Messages are append-only (a trigger refuses UPDATE/DELETE);
threads are never deleted. Back up first as you would for any migration.

## 2. Worker secrets (never paste values into chat, tickets or git)

```
npx wrangler secret put SUPPORT_FORWARD_TO            # the owner mailbox that receives a copy (a verified Email Routing destination)
npx wrangler secret put SUPPORT_EMAIL_INGEST_SECRET   # >= 32 random characters
```

Generate the ingest secret without displaying it in your shell history, e.g. `openssl rand -base64 36 | npx wrangler secret put SUPPORT_EMAIL_INGEST_SECRET`.
`RESEND_API_KEY` already exists and is reused. The forwarding address is **runtime configuration only**; it is not in the source.
If `SUPPORT_FORWARD_TO` is unset the Worker skips the forward (mail is still stored); if the ingest secret is unset it skips the
database copy (mail is still forwarded). If **both** fail the sender receives a permanent SMTP rejection instead of the mail vanishing.
The contact form also uses `SUPPORT_FORWARD_TO` for its owner notification (skipped when unset).

## 3. Cloudflare Email Routing (dashboard)

1. Cloudflare → `kvrn.shop` → **Email → Email Routing**. Enable/onboard it (Cloudflare adds MX + SPF records; if the domain already
   has MX records for other mail, review them first — Email Routing replaces the domain's MX).
2. **Destination addresses** → add the owner mailbox → click the verification link Cloudflare sends. `message.forward()` only works for
   verified destinations.
3. **Routing rules → Create address**: custom address `support`, action **Send to a Worker**, Worker **`kvrn`**.
   Route **only** `support@kvrn.shop`. Do **not** enable a catch-all to this Worker: the handler rejects any other recipient.
4. **DNS: two separate systems, do not merge them by assumption.**
   - **Cloudflare Email Routing (receiving)** uses the **root domain** `kvrn.shop`: its MX records and its root SPF TXT record.
     Cloudflare adds these when you enable Email Routing; review any existing root MX/TXT records first (enabling routing replaces the domain's MX).
   - **Resend (sending)** normally uses a **return-path subdomain** (default `send.<domain>`, i.e. `send.kvrn.shop`) for its own SPF and MX records,
     plus a DKIM selector record (e.g. `resend._domainkey`). Resend does **not** normally need a root-level SPF record.
   - **KVRN already has Resend infrastructure on `send.kvrn.shop`** (the order-email sender is `orders@send.kvrn.shop`). Before adding or changing
     anything, compare what already exists in Cloudflare DNS with what the Resend dashboard shows for `kvrn.shop`. **Do not overwrite or delete existing
     records blindly**, and do not add a second SPF record on the same hostname (a hostname may have only one SPF TXT record).
   - Publish **exactly the records the Resend dashboard shows** for the domain you verify. Do **not** merge Resend's SPF into the root SPF record unless the
     Resend dashboard explicitly gives you a root-level SPF value to publish.

## 4. Resend

Replies are sent FROM `support@kvrn.shop`. In the Resend dashboard add/verify the sending domain that makes `support@kvrn.shop` an allowed sender
(Domains → Add `kvrn.shop`, or confirm the existing domain configuration covers it), publish **the exact DNS records the dashboard shows** (see §3 item 4 —
typically a return-path subdomain's SPF/MX and a DKIM selector, not root-level changes), and wait for **Verified**. The existing transactional sender
(`orders@send.kvrn.shop`) is a different address and its verification does not by itself cover `support@kvrn.shop`.
Until verified, a reply attempt shows: *"Resend refused to send from support@kvrn.shop … No email was sent and nothing was saved."*
The system never falls back to another sender address.

Safe outbound test: create a thread from your own second mailbox (or use the contact form with your own address), reply from Admin,
and confirm that mailbox receives it from `KVRN Support <support@kvrn.shop>`. A reply goes only to the thread's customer address;
the admin cannot choose a recipient, sender or subject.

## 5. End-to-end test sequence

1. From an **external** mailbox send an email to `support@kvrn.shop` (subject e.g. `Support test 1`).
2. Verify the owner mailbox received the forward (full message, X-KVRN-Support header). This is live gate 1.
3. Open **Admin → Support**: a new thread appears with an unread badge.
4. Open it: the message is shown and the thread is marked read (the badge clears; a message that arrived while you were reading stays unread).
5. Reply from Admin.
6. Verify the external mailbox received it **from `KVRN Support <support@kvrn.shop>`** (Reply-To support@kvrn.shop).
7. Reply from the external mailbox.
8. Verify the reply appears in the **same thread** (matched by In-Reply-To / References from the same sender address; check that the thread did not duplicate). This is live gate 2.
9. Submit the storefront **Contact** form (kvrn.shop/contact).
10. Verify it appears in Admin → Support as a new thread (source *Contact form*), and the owner got a notification email.
    To confirm it does not fake success: with the DB unreachable / migration not applied the form returns an error and shows
    "message not sent" — it never shows success unless the message was saved.

Also try: an email with an attachment (the owner copy has the file; Admin shows name/type/size only), and closing/reopening a thread.

## 6. Behaviour reference

- **Threading:** In-Reply-To → References → fallback (exactly one open thread, same customer address, same subject, within 14 days) → otherwise a new thread.
  **A header match is honoured only when the inbound sender's address equals the thread's customer address.** Message-IDs are not secret, so a different
  sender that quotes one cannot attach itself to someone else's conversation: it is stored as its own thread (never discarded) and the existing thread is untouched.
  Consequence: a customer who replies from a *different* mailbox than they first wrote from appears as a **separate thread**. There is no manual merge in this release.
  Ambiguous or stale matches always start a new thread; a contact-form submission always starts a new thread.
- **Ordering** follows arrival time, not the sender's Date header (which is display-only and clamped).
- **Attachments:** metadata only (name/type/size); content is never stored. The full file is in the forwarded copy.
- **Size:** messages over 10 MiB are forwarded but imported as a headers-only stub with a note.
- **Closed threads** reopen automatically on a new customer message.
- **Audit:** replies and close/reopen write `admin_audit_logs` rows (no body text). Mark-read is not audited by design.
- **Logs** contain outcome codes only — never addresses, subjects or bodies.

## 7. Live gates and known limitations

### Live gates — must be confirmed on the real path before relying on this in production
1. **Forwarding after reading `message.raw`.** The Worker reads the raw message (to store a database copy) and then calls `message.forward()`. This ordering is verified
   only in a local workerd simulation. Confirm on the real Cloudflare Email Routing path (end-to-end step 2: the owner mailbox receives the full message *and* a thread appears in Admin).
   If forwarding fails after the raw read, the Worker logs `forward failed`, the message is still stored, and (only if the database copy also fails) the sender gets an SMTP rejection.
2. **Resend's delivered RFC Message-ID / threading.** After sending, the app reads Resend's `message_id` for the sent email and stores it so the customer's reply
   (whose In-Reply-To carries the delivered Message-ID) joins the same thread. Whether Resend's reported `message_id` equals the header actually delivered has not been verified
   against live Resend. Confirm in end-to-end steps 6–8; if the reply starts a new thread instead of joining, the Message-ID does not match and threading for replies needs rework
   (the same-customer subject fallback joins it only when exactly one open thread matches).

### Known limitations
- **No SPF/DKIM/DMARC verification on inbound mail.** The From address is what the sender claims; a forged sender could create a thread that appears to come from someone else,
  and replying would email that address. Treat unexpected requests accordingly. (Cloudflare adds an `Authentication-Results` header to the forwarded copy in the owner mailbox for inspection.)
  Because header threading is restricted to the same sender address, a forged sender cannot join an *existing* customer's thread by quoting a Message-ID, but a forged From equal to the customer's own address still could.
- **No manual thread merge.** A customer writing from a second address gets a second thread.
- **No Turnstile / per-IP limit on the contact form.** There is a per-address (5/hour) and global hourly cap; a flood can exhaust the global cap
  and temporarily block real submissions. Add Turnstile if abuse appears.
- **No automatic acknowledgement** is sent to customers.
- If an inbound message cannot be stored **and** cannot be forwarded the sender gets a permanent rejection (SMTP 5xx) — they are told, the mail is not lost silently.

## 8. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Mail never reaches the owner mailbox | destination not verified; rule not pointing at Worker `kvrn`; `SUPPORT_FORWARD_TO` unset (Worker logs `SUPPORT_FORWARD_TO is not configured`) |
| Forward works, nothing in Admin | `SUPPORT_EMAIL_INGEST_SECRET` unset/mismatch, or 026 not applied (Worker logs `ingest refused`/`ingest failed: HTTP 5xx`) |
| Reply shows "Resend refused to send from support@kvrn.shop" | kvrn.shop not verified in Resend |
| Reply shows "sent but not recorded" | Email went out; retry the SAME reply (same request id) to record it without sending twice |
| Contact form says message not sent | DB unreachable or 026 missing; nothing was saved |
