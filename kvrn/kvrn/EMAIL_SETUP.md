# KVRN Email Setup Guide

## Overview

KVRN uses branded email addresses on the `kvrn.shop` domain.
Customer-facing addresses forward to the Gmail inbox via Cloudflare Email Routing.
Replies can be sent from the branded address using Gmail's "Send mail as" feature.

**Public-facing addresses:**

| Address | Purpose |
|---------|---------|
| `support@kvrn.shop` | General support, order questions, sizing |
| `orders@kvrn.shop` | Order confirmations, tracking, dispatch |
| `returns@kvrn.shop` | Return requests and refund communications |

**Internal forwarding destination:** your private Gmail inbox (never expose this publicly).

---

## Part 1: Cloudflare Email Routing

Cloudflare Email Routing forwards mail arriving at `@kvrn.shop` to your Gmail inbox.
It requires the `kvrn.shop` domain to be managed in Cloudflare DNS.

### Step 1: Enable Email Routing in Cloudflare

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Select the `kvrn.shop` domain
3. In the left sidebar: **Email** → **Email Routing**
4. Click **Get started**
5. Cloudflare will automatically add the required MX and SPF DNS records

### Step 2: Create email routing rules

Navigate to **Email** → **Email Routing** → **Routing Rules** → **Create address**

Create three rules:

| Custom address | Action | Destination |
|---------------|--------|-------------|
| `support@kvrn.shop` | Send to an email | `thekvrn@gmail.com` |
| `orders@kvrn.shop`  | Send to an email | `thekvrn@gmail.com` |
| `returns@kvrn.shop` | Send to an email | `thekvrn@gmail.com` |

For each rule:
- **Custom address:** type the alias (e.g. `support`)
- **Action:** `Send to an email`
- **Destination email:** `thekvrn@gmail.com`
- Click **Save**

### Step 3: Verify the destination address

Cloudflare will send a verification email to `thekvrn@gmail.com`.
Click the link in that email to confirm the destination.

### Step 4: Confirm DNS records

After enabling Email Routing, check that Cloudflare added:
- **MX records** pointing to Cloudflare's mail servers
- **SPF TXT record:** `v=spf1 include:_spf.mx.cloudflare.net ~all`

These are added automatically — verify under **DNS** → **Records**.

### Step 5: Test

Send a test email to `support@kvrn.shop` from a different address.
It should arrive in `thekvrn@gmail.com` within a few seconds.

---

## Part 2: Gmail "Send mail as" (Reply from Branded Address)

This allows you to reply from `support@kvrn.shop` directly in Gmail,
so customers see a branded address in the From field.

### Step 1: Enable Gmail SMTP access

Gmail requires an App Password for this (standard Gmail password won't work).

1. Go to [myaccount.google.com](https://myaccount.google.com)
2. **Security** → enable **2-Step Verification** (required)
3. **Security** → **App passwords** → Generate a new app password
4. Select **Mail** and **Other (custom name)** → type "KVRN"
5. Copy the 16-character app password shown — you will not see it again

### Step 2: Add the alias in Gmail

1. Open Gmail → **Settings** (gear icon) → **See all settings**
2. **Accounts and Import** tab → **Send mail as** → **Add another email address**
3. In the dialog:
   - **Name:** KVRN
   - **Email address:** `support@kvrn.shop`
   - Uncheck "Treat as an alias"
   - Click **Next Step**
4. **SMTP Server:** `smtp.gmail.com`
5. **Port:** `587`
6. **Username:** `thekvrn@gmail.com`
7. **Password:** the 16-character App Password from Step 1
8. **Secured connection:** TLS
9. Click **Add Account**

### Step 3: Verify

Gmail sends a confirmation to `support@kvrn.shop`.
Since Email Routing is active, this arrives in `thekvrn@gmail.com`.
Click the verification link or enter the code provided.

### Step 4: Repeat for other addresses (optional)

Repeat Part 2 for `orders@kvrn.shop` and `returns@kvrn.shop` if you want to reply from those addresses too.

### Step 5: Set as default (optional)

In Gmail Settings → Accounts and Import → Send mail as:
- Click **make default** next to `support@kvrn.shop` if you want it as your primary from address
- Or leave `thekvrn@gmail.com` as default and manually select the alias when replying to customers

---

## Part 3: Transactional Email via Resend

For automated transactional emails (order confirmations, shipping notifications),
KVRN uses **Resend** with the `kvrn.shop` domain.

### Step 1: Verify kvrn.shop in Resend

1. Log in to [resend.com](https://resend.com)
2. **Domains** → **Add domain** → enter `kvrn.shop`
3. Resend provides DNS records to add in Cloudflare:
   - DKIM record (TXT)
   - SPF record (TXT) — merge with existing SPF if one exists
   - DMARC record (TXT)

**Important:** Cloudflare Email Routing already adds an SPF record.
If there is a conflict, combine them:
```
v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all
```
(Replace `amazonses.com` with Resend's SPF include — Resend will specify this.)

### Step 2: Set environment variables

In Cloudflare Workers secrets (via `wrangler secret put`) or `.env.local`:

```bash
# Resend API key — from resend.com/api-keys
npx wrangler secret put RESEND_API_KEY

# Email addresses
npx wrangler secret put EMAIL_FROM      # support@kvrn.shop
npx wrangler secret put SUPPORT_EMAIL   # support@kvrn.shop
npx wrangler secret put ORDERS_EMAIL    # orders@kvrn.shop
npx wrangler secret put RETURNS_EMAIL   # returns@kvrn.shop
```

### Step 3: Activate email sending in code

In `lib/email.ts`, uncomment the Resend block (marked with `// ACTIVATION`).

In `app/api/waitlist/route.ts`, uncomment the Resend confirmation email block.

In `app/api/contact/route.ts`, uncomment the Resend notification block.

In `app/api/webhooks/stripe/route.ts`, add `sendEmail()` calls in `onPaymentSucceeded()`.

### Step 4: DMARC policy

Once Resend is verified, set a DMARC policy in Cloudflare DNS:

```
Type: TXT
Name: _dmarc
Value: v=DMARC1; p=quarantine; rua=mailto:support@kvrn.shop
```

This protects the domain from spoofing and improves deliverability.

---

## Part 4: Email Deliverability Checklist

Before sending production emails, verify at [mail-tester.com](https://mail-tester.com):

- [ ] SPF record present and valid
- [ ] DKIM record present and valid
- [ ] DMARC record present
- [ ] MX records configured (Cloudflare Email Routing)
- [ ] Mail-tester score: 9/10 minimum
- [ ] Test email received in Gmail without spam flag
- [ ] Reply-to address set to `support@kvrn.shop` on all outbound emails
- [ ] List-Unsubscribe header present on marketing emails
- [ ] Unsubscribe link functional (`/api/unsubscribe`)

---

## Summary: Email Flow

```
Customer sends to support@kvrn.shop
         ↓
Cloudflare Email Routing
         ↓
thekvrn@gmail.com (inbox)
         ↓
Reply from Gmail using "Send mail as" support@kvrn.shop
         ↓
Customer sees: From: KVRN <support@kvrn.shop>
```

```
KVRN system sends order confirmation
         ↓
lib/email.ts → sendEmail({ from: 'orders@kvrn.shop', ... })
         ↓
Resend API (verified kvrn.shop domain)
         ↓
Customer inbox
```

---

## Address Reference

| Address | Use | Managed via |
|---------|-----|-------------|
| `support@kvrn.shop` | Customer support, general queries | Cloudflare Email Routing → Gmail |
| `orders@kvrn.shop` | Order confirmations, dispatch | Resend (transactional) |
| `returns@kvrn.shop` | Return instructions | Cloudflare Email Routing → Gmail |
| `thekvrn@gmail.com` | Internal inbox — NEVER expose publicly | Gmail |

---

*Do not expose `thekvrn@gmail.com` in any public-facing code, email template, or UI element.*
*All public email references in the codebase use `@kvrn.shop` addresses only.*
