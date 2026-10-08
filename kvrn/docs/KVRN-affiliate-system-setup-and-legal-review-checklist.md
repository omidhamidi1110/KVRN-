# KVRN — Affiliate System: Setup and Legal Review Checklist

**KVRN does not give legal advice.** The affiliate documents shipped in this batch are placeholders, clearly marked "Pending attorney review". They exist so the workflow, versioning and re-acceptance can be tested; they must be replaced by attorney-approved text before the public application form is opened.

## 1. What the system does (and deliberately does not)

* Public application at `/affiliates/apply` → owner approval in Admin → profile → invitation/onboarding → terms acceptance → portal access at `/affiliate`.
* **No auto-approval, ever.** Applications stay `pending` until an Admin approves; approval calls the existing `create_affiliate()` so there is exactly one affiliate row.
* **Eligibility:** 18+ attestation required (a checkbox/attestation recorded with the application; the database refuses an application without it). **No government ID, selfie, SSN/TIN, bank account, routing number or tax form is collected or stored** — no such columns exist.
* **Consents** are six separate boxes, all unchecked by default: age (18+) attestation, accuracy of the information, electronic-signature consent, program terms, disclosure policy and privacy notice. The database refuses an application without the age attestation and e-sign consent.
* **Versioned documents** with a material-change flag and **re-acceptance** (affiliates must re-accept before continuing).
* **UGC / content rights are separate** from program terms and from payout readiness; an affiliate can be payable without granting content rights, and vice versa.
* **Portal auth is separate from Admin auth** (magic link, hashed tokens/sessions, peppered; Cloudflare Access is not involved). Every portal query is scoped by the signed-in affiliate id (no IDOR) and returns no customer PII.
* **Payout readiness gate** (`canPayAffiliate`): blocks creating a payout while terms/readiness are incomplete, the affiliate is paused/terminated, commissions are foreign/incomplete/unresolved, or the order has an active fraud hold. Applies only when the portal or applications flag is on.
* **Commission math is unchanged.** Payouts remain manual by default; the Stripe Connect adapter is an unconfigured skeleton and no Stripe Connect resource is created.

## 2. Owner setup checklist (in order)

1. Apply migrations 033 and 034 (see rollout plan). Existing affiliates receive a backfilled profile; they are **not** forced to re-accept and are **not** blocked.
2. Set secrets: `AFFILIATE_HASH_PEPPER` and `AFFILIATE_AUTH_PEPPER` (≥ 32 random chars each). Without the hash pepper the form's anti-bot token can be forged and IP/UA/email hashes are unsalted.
3. Admin → Financials → Affiliates → **Terms & settings**: review program settings (default commission terms, cookie window, minimum payout, whether invitations are required, etc.).
4. **Replace all five placeholder documents** with attorney-reviewed text and publish new versions (see §3).
5. Decide duplicate-email behavior (program "activated" email vs portal "payout-ready" email).
6. Publish a Privacy/Cookie disclosure describing the affiliate-portal session cookie and affiliate-form data (see §4).
7. Optional: add a Pushover/owner notification for new applications (not implemented in this batch).
8. Turn on `KVRN_FLAG_AFFILIATE_APPLICATIONS` on staging; test apply → approve → invite → accept terms → activate → suspend → reinstate → terminate.
9. Turn on `KVRN_FLAG_AFFILIATE_PORTAL` on staging; test magic-link sign-in, own-data-only views, documents, onboarding, statements.
10. Keep `KVRN_FLAG_AFFILIATE_AUTO_PAYOUTS` OFF. Pay manually and mark paid in Admin.

## 3. Documents to have reviewed by counsel

| Document | Why it matters | Items for counsel |
|---|---|---|
| Affiliate Program Terms | Contract with the affiliate | Independent-contractor status; commission rate, base (net merchandise?), clawbacks for refunds/returns/disputes/fraud; payment timing/minimums; termination and suspension; governing law/venue (note the existing site has conflicting USD/Delaware vs GBP/England wording — resolve first); arbitration/limitation clauses; assignment; changes to terms and re-acceptance mechanics |
| Affiliate Disclosure Policy | Endorsement disclosure rules (e.g. FTC Endorsement Guides in the US, ASA/CAP in the UK, equivalents elsewhere) | Required wording/placement of #ad/affiliate disclosures; platform-specific rules; enforcement consequences |
| Privacy Notice (affiliates) | Personal data processed about affiliates | Lawful basis, retention, hashing of IP/UA, international transfers, rights requests, children (18+) |
| Program Rules / acceptable conduct | Brand safety | Prohibited claims, coupon/trademark bidding, cookie stuffing, self-referral, spam, sensitive categories |
| UGC / Content Rights Agreement (separate) | License to reuse an affiliate's content | Scope, duration, territory, attribution, moral rights, removal, minors, music/third-party rights, revocation |

Also confirm with counsel: whether 18+ self-attestation is sufficient in your markets (the system intentionally does **not** verify identity or store ID); tax-form handling (W-9/W-8 or equivalents) happens **outside** KVRN — decide the process and storage before paying US/foreign affiliates above any reporting threshold; consumer-protection and e-mail marketing rules for the program's own emails; data-processing terms with Resend (email) and Cloudflare (hosting).

## 4. Disclosures to add to the public Privacy / Cookie pages

* The affiliate portal sets a first-party, HttpOnly, secure session cookie after magic-link sign-in; it is strictly necessary for the portal and is not used for tracking.
* The portal is excluded from Google Analytics and the funnel tracker.
* Application data collected: name, email, country, channel URLs, audience description, consents, hashed IP/user-agent for abuse prevention, timestamps.
* Retention period for rejected/anonymized applications (Admin has an "anonymize" action; define the schedule).

## 5. Compliance controls available in Admin

Applications (approve with commercial config, reject, request info, internal notes, anonymize) · Invitations (create/resend/revoke; tokens are never stored, only a hash; resend rotates the token) · Profiles (activate, suspend, terminate, reinstate with reason; suspend/terminate disable the discount code and referral link and keep commissions/attributions/payouts intact) · Documents (versioned publish, material-change flag, re-acceptance list and request) · Compliance tab (UGC rights, disclosure tracking) · Payout readiness tab (blockers listed visibly) · Audit tab · Email outbox.

## 6. Known limitations to be aware of

Placeholder documents; request-info flow is by email reply (no applicant-side edit); invitations only pre-fill the form (invitees still need approval); manually created affiliates need a matching discount code added separately in Discounts; rate limits count valid submissions only (rely on Cloudflare for floods); `create_affiliate_payout` is frozen so the readiness gate can be bypassed by direct SQL; legacy affiliates are not flagged for re-acceptance; no Pushover for new applications.

## 7. Go/no-go criteria for opening applications

- [ ] Attorney-approved documents published (no "Pending attorney review" text remains)
- [ ] Privacy/Cookie pages updated
- [ ] Peppers set; staging walkthrough passed
- [ ] Payout process (manual) and tax-form handling decided outside KVRN
- [ ] Owner notification/inbox process for new applications defined
- [ ] Support contacts for affiliates published
