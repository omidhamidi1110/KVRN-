# KVRN — Launch Website

Luxury ecommerce for KVRN heavyweight fleece. Built on Next.js, Tailwind CSS, and Cloudflare Pages.

---

## Tech Stack

| Layer       | Technology                      |
|-------------|----------------------------------|
| Framework   | Next.js 14 (App Router)         |
| Language    | TypeScript                       |
| Styling     | Tailwind CSS                     |
| Hosting     | Cloudflare Pages                 |
| Database    | Neon Postgres (connect to activate) |
| Payments    | Stripe Elements (connect to activate) |
| Email       | Resend (connect to activate)     |
| SMS         | Twilio (connect to activate)     |
| Shipping    | Shippo (connect to activate)     |

---

## Quick Start

### 1. Prerequisites

- Node.js 18.17+ (check: `node --version`)
- npm 9+ (check: `npm --version`)

### 2. Clone and install

```bash
git clone https://github.com/your-org/kvrn.git
cd kvrn
npm install
```

### 3. Environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and add your keys. For local development, the site works without any keys — API routes return mock responses. Add keys to activate each service.

### 4. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 5. Type check

```bash
npm run type-check
```

### 6. Build for production

```bash
npm run build
npm run start
```

---

## Project Structure

```
kvrn/
├── app/
│   ├── layout.tsx              # Root layout, fonts, nav, footer, cart
│   ├── globals.css             # Base styles, CSS custom properties
│   ├── page.tsx                # Homepage
│   ├── not-found.tsx           # 404 page
│   ├── shop/page.tsx           # Collection page
│   ├── products/[slug]/
│   │   ├── page.tsx            # PDP server component (metadata)
│   │   └── PDPClient.tsx       # PDP interactive client component
│   ├── waitlist/page.tsx       # Waitlist capture page
│   ├── about/page.tsx          # Brand story page
│   ├── contact/page.tsx        # Contact form
│   ├── checkout/page.tsx       # Checkout (Stripe scaffold)
│   ├── order-confirmation/     # Post-purchase page
│   ├── admin/page.tsx          # Admin dashboard (placeholder data)
│   └── api/
│       ├── waitlist/route.ts   # Waitlist API
│       ├── contact/route.ts    # Contact form API
│       └── checkout/route.ts   # Stripe session API
│
├── components/
│   ├── layout/
│   │   ├── Nav.tsx             # Sticky nav with scroll state
│   │   └── Footer.tsx          # Site footer
│   ├── ui/
│   │   ├── Button.tsx          # All button variants
│   │   ├── Accordion.tsx       # Expandable content
│   │   └── Toast.tsx           # Toast notification system
│   ├── product/
│   │   ├── ProductCard.tsx     # Collection grid card
│   │   ├── ProductGallery.tsx  # PDP image gallery (swipe + thumbnails)
│   │   ├── ColorSelector.tsx   # Color swatch selector
│   │   └── SizeSelector.tsx    # Size tile selector
│   ├── cart/
│   │   └── CartDrawer.tsx      # Slide-in cart drawer
│   ├── forms/
│   │   └── WaitlistForm.tsx    # Email + SMS waitlist form
│   └── sections/
│       └── TrustBlock.tsx      # Shipping/returns trust signals
│
├── context/
│   └── CartContext.tsx         # Cart state (localStorage-persisted)
│
├── data/
│   └── products.ts             # Product catalog data
│
├── lib/
│   └── utils.ts                # Utility functions
│
├── types/
│   └── index.ts                # TypeScript types
│
├── public/
│   └── images/                 # Add product images here
│       ├── campaign/           # Hero, editorial images
│       ├── products/           # Product photography
│       └── construction/       # Construction detail shots
│
├── tailwind.config.ts          # Design tokens
├── next.config.js              # Next.js config
└── .env.example                # Environment variables template
```

---

## Adding Product Images

Images are referenced in `data/products.ts`. Add your images to `public/images/products/` following this naming convention:

```
/public/images/products/hoodie-stone-front.webp
/public/images/products/hoodie-stone-back.webp
/public/images/products/hoodie-stone-hood.webp
/public/images/products/hoodie-stone-fabric.webp
/public/images/products/hoodie-stone-zip-closed.webp
/public/images/products/hoodie-stone-zip-open.webp
/public/images/products/hoodie-stone-lifestyle.webp

/public/images/products/sweatpants-stone-front.webp
... etc
```

**Image specs (from V3 Blueprint):**
- Format: WebP (AVIF optional)
- Product shots: 1500×2000px (3:4), 85% quality
- Macro shots: 1200×1200px (1:1), 90% quality
- Hero campaign: 1920×1080px (16:9) + 1080×1920px (9:16 mobile crop)

---

## Service Integration

### Stripe (Payments)

1. Create account at [stripe.com](https://stripe.com)
2. Get keys from Dashboard → API Keys
3. Add to `.env.local`
4. In `app/checkout/page.tsx`, uncomment the Stripe Elements integration
5. In `app/api/checkout/route.ts`, uncomment the PaymentIntent creation
6. Set up webhook at [dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks):
   - Endpoint: `https://kvrn.com/api/webhooks/stripe`
   - Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.dispute.created`

### Neon Postgres (Database)

1. Create project at [neon.tech](https://neon.tech)
2. Copy connection string → `DATABASE_URL` in `.env.local`
3. Run the schema migration: (schema file to be added in next sprint)
4. Uncomment DB code in `app/api/waitlist/route.ts`

### Resend (Email)

1. Create account at [resend.com](https://resend.com)
2. Verify your domain (kvrn.com) — adds DNS records to Cloudflare
3. Create API key → `RESEND_API_KEY`
4. Uncomment email code in API routes

### Shippo (Shipping Labels)

1. Create account at [goshippo.com](https://goshippo.com)
2. Get API key → `SHIPPO_API_KEY`
3. Configure carriers in Shippo dashboard
4. Use Shippo SDK to generate labels (add to admin fulfillment flow)

---

## Deployment to Cloudflare Pages

### First deploy

1. Push code to GitHub
2. Go to [Cloudflare Pages](https://pages.cloudflare.com)
3. Connect GitHub repository
4. Build settings:
   - Framework: Next.js
   - Build command: `npm run build`
   - Output directory: `.next`
5. Add environment variables (from `.env.example`) in Pages settings
6. Deploy

### Custom domain

1. Cloudflare Pages → Custom domains → Add domain
2. Follow DNS verification steps (automatic if domain is on Cloudflare)

### Deployment pipeline

Every push to `main` auto-deploys to production.
Pull requests create preview deployments.

---

## Admin Dashboard

The admin at `/admin` currently shows placeholder data.

**To protect it before going live:**

Option A (recommended): Cloudflare Access
- Free for personal projects
- Go to Cloudflare → Zero Trust → Access → Applications
- Add an application protecting `kvrn.com/admin`
- Requires email authentication — no code changes needed

Option B: Next.js middleware
```typescript
// middleware.ts
import { NextResponse, NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/admin')) {
    // Add your auth check here
  }
  return NextResponse.next()
}
```

---

## Performance Targets

From V3 Blueprint:
- Mobile PageSpeed: 95+
- LCP: <2.0s
- CLS: <0.05
- Total page weight (homepage): <500KB

Run locally: `npx lighthouse http://localhost:3000 --only-categories=performance`

---

## Brand Rules (Quick Reference)

From the Brand Bible (V3 Blueprint Part 6):

**Never:**
- Discount language ("Sale", "% off", "Limited time")
- Emoji in any UI or copy
- Exclamation marks
- "Curated", "elevated", "artisanal", "stunning"
- Bold typography for urgency

**Always:**
- Warm off-white background (#FAFAF8)
- Light weight typography (300–400)
- Generous spacing (80px mobile / 160px desktop between sections)
- Specific copy ("400 GSM+" not "premium materials")
- Direct verbs in CTAs ("Shop the drop", "Add to bag")

---

## Next Steps (Post-Launch)

Priority order from V4 Blueprint:

1. **Connect Stripe** — activate payment processing
2. **Connect Neon** — store orders and waitlist
3. **Connect Resend** — order confirmation emails
4. **Add product images** — replace placeholders
5. **Set up Cloudflare Access** — protect admin
6. **Configure Stripe webhook** — order automation
7. **Connect Shippo** — label generation in admin
8. **Set up GA4** — add measurement ID to env
9. **Add review form** — post Day 14 emails
10. **Connect Twilio** — SMS shipping notifications

---

## Support

Questions about the build: review V1–V4 Blueprint documents.  
Technical issues: hello@kvrn.com
