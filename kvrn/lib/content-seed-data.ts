// lib/content-seed-data.ts — the CODED long-form content (policies, FAQ, size guides) as
// structured data, used to SEED the CMS (migration 030) so enabling CMS_PUBLIC_CONTENT shows
// the same words that the coded pages show today.
//
// The text here is a transcription of app/terms, app/privacy, app/cookies,
// app/support/shipping-returns, app/support/faq and app/support/size-guide. The equivalence
// test (lib/__tests__/content-seed-equivalence.test.ts) checks every string against the coded
// source so a transcription slip or a later edit to a coded page is caught.

import { para, heading, bullets, rule, type RichBlock, type RichText } from './content-richtext'
import type { PolicySnapshot, FaqSnapshot, SizeGuideSnapshot } from './content-schemas'

const doc = (blocks: RichBlock[]): RichText => ({ v: 1, blocks })
const MAIL = (a: string) => `[${a}](mailto:${a})`

// ── Terms ─────────────────────────────────────────────────────────────────────

export const SEED_TERMS: PolicySnapshot = {
  slug: 'terms', title: 'Terms of Service', heroTitle: 'Terms', heroBreadcrumb: 'Terms',
  effectiveDate: '2026-08-12', lastUpdatedLabel: 'Last updated', style: 'legal',
  seo: {},
  body: doc([
    heading('Who you are contracting with'),
    para('These terms govern your use of kvrn.shop and any purchase you make from KVRN, operated by Omid Hamidi as a sole proprietor in the United States. By using the site or placing an order, you agree to these terms.'),
    rule(),
    heading('Orders and contract formation'),
    para('Placing an order is an offer to buy. A contract between you and KVRN is formed when we confirm your order by email — not at the point of placing it.'),
    para('We reserve the right to cancel any order before dispatch. If we cancel your order, we will refund you in full within 5 business days. We will notify you by email.'),
    rule(),
    heading('Pricing and payment'),
    bullets([
      'All prices are displayed in GBP and include UK VAT at 20%.',
      'International orders may be subject to import duties and taxes payable by you.',
      'We accept payment via Stripe (card, Apple Pay, Google Pay).',
      'Payment is taken immediately on order confirmation.',
      'If a pricing error occurs, we will notify you and give you the option to reorder at the correct price or cancel.',
    ]),
    rule(),
    heading('Delivery'),
    para('Delivery timescales are estimates and not guaranteed. We are not liable for delays caused by customs, weather, carrier issues, or events outside our control.'),
    para('Risk of loss passes to you when the carrier accepts the parcel. If your order is lost in transit, contact us and we will investigate with the carrier.'),
    rule(),
    heading('Returns and consumer rights'),
    para('You have the right to cancel your order within 14 days of delivery under the Consumer Contracts Regulations 2013. Our 30-day returns window exceeds this statutory minimum.'),
    para(`Faulty or incorrectly shipped goods are covered regardless of our returns window. Contact us at ${MAIL('support@kvrn.shop')} for all warranty and fault claims.`),
    para('See our full [Shipping & Returns policy](/support/shipping-returns).'),
    rule(),
    heading('Intellectual property'),
    para('All content on this site — including text, photography, design, and brand elements — is owned by or licensed to KVRN. You may not reproduce, distribute, or use any content without our prior written permission.'),
    rule(),
    heading('Limitation of liability'),
    para("To the maximum extent permitted by law, KVRN's liability for any claim arising from your use of this site or any purchase is limited to the value of the goods you purchased. We are not liable for indirect, consequential, or economic losses."),
    para('Nothing in these terms affects your statutory rights as a consumer.'),
    rule(),
    heading('Governing law'),
    para('These terms are governed by the laws of England and Wales. Any disputes will be subject to the exclusive jurisdiction of the courts of England and Wales.'),
    rule(),
    heading('SMS marketing program'),
    para('By affirmatively opting in to the KVRN SMS program, you agree to receive recurring automated marketing text messages about KVRN product launches, drops, restocks, early access, and promotional offers at the mobile number you provide.'),
    para('Message frequency varies. Msg & data rates may apply. Consent to receive marketing text messages is not a condition of purchasing goods or services from KVRN.'),
    para(`Reply STOP at any time to cancel. Reply HELP for help or contact ${MAIL('support@kvrn.shop')}.`),
    para('Mobile carriers are not responsible for delayed or undelivered messages. See our [Privacy Policy](/privacy) for information about how we handle mobile information.'),
    rule(),
    heading('Contact'),
    para(`For any queries relating to these terms, contact us at ${MAIL('support@kvrn.shop')}.`),
  ]),
}

// ── Privacy ───────────────────────────────────────────────────────────────────

export const SEED_PRIVACY: PolicySnapshot = {
  slug: 'privacy', title: 'Privacy Policy', heroTitle: 'Privacy Policy', heroBreadcrumb: 'Privacy Policy',
  effectiveDate: '2026-08-12', lastUpdatedLabel: 'Last updated', style: 'legal',
  seo: { description: 'How KVRN collects, uses, and protects your personal data.' },
  body: doc([
    heading('Who we are'),
    para('KVRN is operated by Omid Hamidi as a sole proprietor in the United States. We are responsible for the personal information we collect through kvrn.shop and the KVRN SMS program.'),
    para(`For questions about this policy, contact us at ${MAIL('support@kvrn.shop')}.`),
    rule(),
    heading('What data we collect and why'),
    { t: 'defs', items: [
      { title: 'Name, email address, shipping address', lines: ['To process and fulfil your order.', 'Contract — processing is necessary to deliver what you ordered.'] },
      { title: 'Payment details (card number, CVV)', lines: ['To take payment.', 'Contract — processed and tokenised by Stripe. We never see or store your card number.'] },
      { title: 'Phone number (optional)', lines: ['To send shipping notifications or drop alerts by SMS, if you opt in.', 'Consent — you can opt out at any time by replying STOP.'] },
      { title: 'Email address (waitlist)', lines: ['To notify you when new drops go live.', 'Consent — you can unsubscribe at any time via any email we send.'] },
      { title: 'IP address, device type, browser, pages visited', lines: ['To understand how our site is used (via Google Analytics 4 and Microsoft Clarity).', 'Consent — only collected if you accept analytics cookies.'] },
      { title: 'IP address (fraud signals)', lines: ['To detect and prevent fraudulent orders.', 'Legitimate interest — protecting our business and genuine customers.'] },
    ] },
    rule(),
    heading('Who we share data with'),
    para('We never sell your personal data. We share it only with the services required to operate:'),
    { t: 'table', label: 'Service providers', headers: [], rows: [
      ['Stripe', 'Payment processing (PCI DSS Level 1 certified)'],
      ['Shipping partner', 'Shipping label generation and order tracking'],
      ['Email service', 'Transactional email delivery'],
      ['SMS service', 'SMS notifications (opt-in only)'],
      ['Neon', 'Database hosting (encrypted at rest)'],
      ['Cloudflare', 'Hosting, CDN, and security'],
      ['Google Analytics 4', 'Anonymous website analytics (consent-gated)'],
      ['Microsoft Clarity', 'Session recordings (consent-gated)'],
    ].map(r => r.map(c => [{ t: 'text' as const, text: c }])) },
    rule(),
    heading('SMS and mobile information'),
    para('If you opt in to the KVRN SMS program, we may use your mobile number and SMS consent information to send recurring automated marketing text messages about product launches, drops, restocks, early access, and promotional offers.'),
    para('Message frequency varies. Msg & data rates may apply. Reply STOP to cancel or HELP for help. Consent to receive marketing text messages is not a condition of purchase.'),
    para('We do not sell or share mobile phone numbers, SMS opt-in data, or SMS consent information with third parties or affiliates for their marketing or promotional purposes. Mobile information may be provided to service providers only as necessary to operate and deliver the KVRN SMS program.'),
    rule(),
    heading('How long we keep data'),
    bullets([
      'Order data: 7 years (required by HMRC for tax purposes)',
      'Marketing preferences (email/SMS consent): Until you withdraw consent',
      'Analytics data: 14 months (Google Analytics default)',
      'Session recordings: 30 days (Microsoft Clarity default)',
    ]),
    rule(),
    heading('Your rights'),
    para('Under UK GDPR, you have the right to:'),
    bullets([
      'Access the personal data we hold about you',
      'Correct inaccurate data',
      'Request erasure of your data (subject to legal retention obligations)',
      'Restrict or object to how we process your data',
      'Data portability — receive your data in a structured format',
      'Withdraw consent at any time (for consent-based processing)',
    ]),
    para(`To exercise any of these rights, email ${MAIL('support@kvrn.shop')}. We will respond within 30 days. If you are unhappy with our response, you may contact the ICO: [ico.org.uk](https://ico.org.uk).`),
    rule(),
    heading('Cookies'),
    para('We use essential cookies (required for the site to function) and optional analytics cookies (only with your consent). See our [Cookie Policy](/cookies) for full details.'),
    rule(),
    heading('Changes to this policy'),
    para('We may update this policy. We will notify customers of material changes by email. The “Last updated” date at the top of this page reflects the most recent revision.'),
  ]),
}

// ── Cookies ───────────────────────────────────────────────────────────────────

const cell = (s: string) => [{ t: 'text' as const, text: s }]

export const SEED_COOKIES: PolicySnapshot = {
  slug: 'cookies', title: 'Cookie Policy', heroTitle: 'Cookie Policy', heroBreadcrumb: 'Cookies',
  effectiveDate: '2025-01-01', lastUpdatedLabel: 'Last updated', style: 'legal',
  seo: {},
  body: doc([
    para('This policy explains what cookies are, what we use them for, and how to control them. Under PECR (Privacy and Electronic Communications Regulations), we need your consent before placing non-essential cookies on your device.'),
    rule(),
    heading('Essential cookies'),
    para('Required for the site to function. Cannot be opted out of.'),
    { t: 'table', label: 'Essential cookies', headers: ['Cookie', 'Purpose', 'Expires'], mono: true, rows: [
      ['kvrn_cart', 'Stores your shopping bag contents', '30 days'].map(cell),
      ['kvrn_cookie_consent', 'Remembers your cookie preferences', '1 year'].map(cell),
    ] },
    rule(),
    heading('Analytics cookies (optional)'),
    para('Only set if you accept. Used to understand how visitors use our site.'),
    { t: 'table', label: 'Analytics cookies', headers: ['Cookie', 'Provider', 'Purpose', 'Expires'], mono: true, rows: [
      ['_ga, _ga_*', 'Google Analytics 4', 'Distinguishes users and sessions', '2 years'].map(cell),
      ['_clck, _clsk', 'Microsoft Clarity', 'Session recordings', '1 year / 1 day'].map(cell),
    ] },
    rule(),
    heading('Advertising cookies'),
    para('We do not use advertising or tracking cookies. KVRN does not run paid advertising.'),
    rule(),
    heading('Manage your preferences'),
    { t: 'embed', kind: 'cookie-controls' },
    rule(),
    para(`For more information, see our [Privacy Policy](/privacy). Questions? Email ${MAIL('support@kvrn.shop')}.`),
  ]),
}

// ── Shipping & Returns ────────────────────────────────────────────────────────

export const SEED_SHIPPING_RETURNS: PolicySnapshot = {
  slug: 'shipping-returns', title: 'Shipping & Returns', heroTitle: 'Shipping & Returns', heroBreadcrumb: 'Shipping & Returns',
  effectiveDate: null, style: 'support',
  seo: { description: 'KVRN shipping and returns policy. Store credit returns. Orders ship within 1–3 business days.' },
  body: doc([
    heading('Shipping'),
    para('Orders are processed within approximately **1–3 business days** of payment confirmation. Products are not available for preorder unless explicitly stated on the product page.'),
    para('Shipping costs depend on your destination and the shipping method selected at checkout. Actual costs are calculated at checkout before payment.'),
    { t: 'cards', items: [
      { label: 'Domestic', text: '2–7 business days (approx.)' },
      { label: 'International', text: '5–14+ business days (approx.)' },
    ] },
    para('Delivery estimates are not guarantees. Carrier delays and customs processing can affect timelines.'),
    para('All orders include tracking. You will receive a shipping confirmation with tracking information when your order dispatches.'),
    rule(),
    heading('Returns'),
    para('We accept returns for **store credit** on eligible items within our return window.'),
    { t: 'callout', title: 'Why store credit?', paras: [[{ t: 'text', text: 'Store credit allows us to continue investing in product quality. You retain full value to use on any future order.' }]] },
    para('To be eligible for return, items must be:'),
    bullets(['Unworn and unwashed', 'In original condition with tags attached', 'Returned within 14 days of delivery']),
    para('Customer is responsible for return shipping costs unless the item arrives damaged, faulty, or incorrect.'),
    para('Final sale items are not eligible for return.'),
    para(`To initiate a return, email ${MAIL('returns@kvrn.shop')} with your order number.`),
    para('**Questions?**'),
    para(`Email ${MAIL('support@kvrn.shop')} we respond within 1–2 business days.`),
  ]),
}

export const SEED_POLICIES: Array<{ id: string; snapshot: PolicySnapshot }> = [
  { id: 'terms', snapshot: SEED_TERMS },
  { id: 'privacy', snapshot: SEED_PRIVACY },
  { id: 'cookies', snapshot: SEED_COOKIES },
  { id: 'shipping-returns', snapshot: SEED_SHIPPING_RETURNS },
]

// ── FAQ ───────────────────────────────────────────────────────────────────────

const ans = (...paras: string[]): RichText => ({ v: 1, blocks: paras.map(para) })

export const SEED_FAQ: FaqSnapshot = {
  heroTitle: 'FAQ',
  footerTitle: 'Still have a question?',
  footerBody: ans(`Email ${MAIL('support@kvrn.shop')} and we will get back to you within 1 to 2 business days.`),
  seo: { description: 'Frequently asked questions about KVRN products, sizing, shipping and returns.' },
  categories: [
    { id: 'products', heading: 'Products', active: true, items: [
      { id: 'gsm', question: 'What does GSM mean?', active: true, answer: ans(
        'GSM stands for grams per square metre. It measures how dense and heavy a fabric is. The higher the number, the heavier the material.',
        'Most hoodies on the market sit around 280 to 320 GSM. At that weight the fabric feels light. At 400 GSM and above the structure changes noticeably — the garment holds its shape, drapes differently, and has real weight when you hold it.',
        'Full material specifications are listed on each product page.') },
      { id: 'no-drawstring', question: 'Why is there no drawstring on the hoodie?', active: true, answer: ans(
        'The Heavyweight hood is structured across three panels so it holds its shape on its own. A drawstring is usually needed because the hood collapses without it. The construction here eliminates that problem. There is nothing to pull, nothing to lose, and nothing to interrupt the silhouette.') },
      { id: 'zippers', question: 'How do the hidden interior pockets work?', active: true, answer: ans(
        'The kangaroo pocket has two concealed zippers running inside it, one on each side. From the outside they are invisible. Open the zip and you access a secure interior compartment. They work in all positions and stay closed without looking closed.') },
      { id: 'project-kvrn', question: 'What is the Project KVRN collection?', active: true, answer: ans(
        'The Project KVRN collection uses a 500 GSM French terry blend rather than the brushed fleece of the Heavyweight collection. Both are heavy. The difference is in the construction and the proportion.',
        'Project KVRN pieces are enzyme washed and pre-shrunk before shipping, so they arrive with immediate softness and a more relaxed hand feel. They are also cut with a cropped, oversized proportion rather than a longer oversized one.') },
      { id: 'care', question: 'How do I care for the garments?', active: true, answer: ans(
        'Machine wash cold, inside out, gentle cycle. Air dry. Do not tumble dry on high heat.',
        'The fleece will continue to soften over the first few washes. This is normal and expected. The structure of the hood and the zippers are not affected by regular washing.') },
    ] },
    { id: 'sizing', heading: 'Sizing', active: true, items: [
      { id: 'fit', question: 'How does KVRN fit?', active: true, answer: ans(
        'KVRN is designed to be oversized. The proportions are intentional, not incidental. If you want the intended silhouette, order your usual size. If you want a slightly cleaner look, size down by one.',
        '[View the size guide](/support/size-guide)') },
      { id: 'measurements', question: 'Where can I find measurements?', active: true, answer: ans(
        'The size guide has full measurements for both the hoodie and sweatpants, in centimetres and inches.',
        '[Open size guide](/support/size-guide)') },
    ] },
    { id: 'shipping', heading: 'Shipping', active: true, items: [
      { id: 'processing', question: 'How long does processing take?', active: true, answer: ans(
        'Orders are processed within approximately 1 to 3 business days of payment. Products are in stock and ship promptly unless a product page states otherwise.') },
      { id: 'delivery', question: 'How long does delivery take?', active: true, answer: ans(
        'Domestic orders typically arrive within 2 to 7 business days after dispatch. International orders typically take 5 to 14 business days or more, depending on the destination and customs.',
        'Delivery estimates are not guarantees. All orders include tracking, sent when your order dispatches.') },
      { id: 'free-shipping', question: 'Is there free shipping?', active: true, answer: ans(
        'Complimentary shipping is available on U.S. orders over $150. Shipping costs for all other orders are calculated at checkout based on destination and method selected.') },
      { id: 'tracking', question: 'How do I track my order?', active: true, answer: ans(
        'You will receive a tracking number by email once your order ships. You can also use the track order page.',
        '[Track your order](/support/track)') },
    ] },
    { id: 'returns', heading: 'Returns', active: true, items: [
      { id: 'returns', question: 'What is the returns policy?', active: true, answer: ans(
        'We accept returns for store credit on unworn, unwashed items with tags still attached, within our return window. The return window is shown in your order confirmation.',
        'Customer covers return shipping unless the item arrives damaged, faulty, or incorrect.',
        '[Full returns policy](/support/shipping-returns#returns)') },
      { id: 'initiate-return', question: 'How do I start a return?', active: true, answer: ans(
        `Email ${MAIL('returns@kvrn.shop')} with your order number and the items you would like to return. We will respond within 24 hours with next steps.`) },
      { id: 'wrong-item', question: 'What if my order arrived wrong or damaged?', active: true, answer: ans(
        `Email ${MAIL('support@kvrn.shop')} with your order number and photos. If the item is faulty, incorrect, or damaged on arrival, we will cover the return shipping and resolve it at no cost to you.`) },
    ] },
  ],
}

// ── Size guides ───────────────────────────────────────────────────────────────

const rowsOf = (cols: string[], data: Array<[string, ...Array<number | string>]>) =>
  data.map(([label, ...vals], i) => ({
    id: `r${i + 1}`, label,
    values: Object.fromEntries(cols.map((c, j) => [c, String(vals[j])])) as Record<string, string>,
  }))

export const SEED_SIZE_GUIDE_HOODIE: SizeGuideSnapshot = {
  name: 'Hoodie', garment: 'Hoodie', shopLink: { label: 'Shop Hoodies', href: '/shop?type=hoodies' },
  unit: 'cm', rowHeader: 'Size',
  columns: [{ id: 'length', label: 'Length' }, { id: 'chest', label: 'Chest' }, { id: 'shoulder', label: 'Shoulder' }, { id: 'sleeve', label: 'Sleeve' }],
  rows: rowsOf(['length', 'chest', 'shoulder', 'sleeve'], [
    ['XS', 62, 62, 64, 52], ['S', 65, 65, 67, 55], ['M', 68, 68, 70, 58], ['L', 70.5, 70.5, 72.5, 60.5],
    ['XL', 73, 73, 75, 63], ['2XL', 75.5, 75.5, 77.5, 65.5], ['3XL', 78, 78, 80, 68],
  ]),
  notes: ['Chest measured flat across the chest under the arms.', 'Length from highest point of shoulder to hem.'],
  fit: { v: 1, blocks: [] }, showOnGuidePage: true, order: 1,
}

export const SEED_SIZE_GUIDE_SWEATPANTS: SizeGuideSnapshot = {
  name: 'Sweatpants', garment: 'Sweatpants', shopLink: { label: 'Shop Sweatpants', href: '/shop?type=sweatpants' },
  unit: 'cm', rowHeader: 'Size',
  columns: [{ id: 'waist', label: 'Waist' }, { id: 'hip', label: 'Hip' }, { id: 'length', label: 'Length' }],
  rows: rowsOf(['waist', 'hip', 'length'], [
    ['XS', 66, 112, 97], ['S', 70, 114, 99], ['M', 74, 116, 101], ['L', 78, 118, 103],
    ['XL', 82, 120, 105], ['2XL', 86, 122, 107], ['3XL', 90, 124, 109],
  ]),
  notes: ['Waist measured flat across the waistband.', 'Length measured from waistband to hem.'],
  fit: { v: 1, blocks: [] }, showOnGuidePage: true, order: 2,
}

export const SEED_SIZE_GUIDES: Array<{ id: string; snapshot: SizeGuideSnapshot }> = [
  { id: 'kvrn-hoodie', snapshot: SEED_SIZE_GUIDE_HOODIE },
  { id: 'kvrn-sweatpants', snapshot: SEED_SIZE_GUIDE_SWEATPANTS },
]
