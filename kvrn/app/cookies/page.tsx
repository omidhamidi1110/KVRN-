/** KVRN Cookie Policy. October 6, 2026 owner-supplied replacement copy.
 * The CMS published version takes precedence when explicitly enabled.
 * The preferences widget always uses the REAL CookiePrefsContext state.
 */
import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { PolicyView } from '@/components/content/cms-views'
import { policyMetadata } from '@/lib/content-storefront'
import { PageHero } from '@/components/layout/PageHero'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CookieControls } from './CookieControls'

const FALLBACK_METADATA: Metadata = {
  title: 'Cookie Policy — KVRN',
  description: 'How KVRN uses cookies, local storage, and analytics, and how you can manage your choices.',
  alternates: { canonical: '/cookies' },
}
const lists = {
  essential: [
    ['Cart storage','KVRN stores cart contents in your browser so your bag can persist between pages and visits.'],
    ['Privacy preferences','KVRN stores your cookie and privacy choices so the website can remember them. The current preference record is designed to expire after approximately 12 months.'],
    ['Language and currency','KVRN may store your selected language and currency so the website can remember those choices.'],
    ['Wishlist and product preferences','KVRN may store wishlist or product-preference information in your browser.'],
    ['SMS signup and discount state','If you interact with an SMS signup offer, KVRN may temporarily store signup, claim, or discount information in the browser so the signup and checkout flows can work correctly.'],
    ['Security and sessions','KVRN may use first-party identifiers needed for security, temporary sessions, order processing, or other essential server-side functions.'],
  ],
  analytics: [
    'Session starts','Product views','Add-to-cart events','Checkout starts','Purchases',
    'Landing pages','Referral sources','Campaign parameters','Coarse device category',
  ],
  choices: [
    'Keep only essential/functional storage','Enable or disable personalization',
    'Enable or disable analytics','Keep advertising technologies disabled',
    'Record a do-not-sell/share preference',
  ],
  clearing: [
    'Cart contents','Saved language or currency','Wishlist information',
    'Cookie preferences','SMS signup state','Affiliate attribution','Other saved storefront preferences',
  ],
}
function Section({heading,children}:{heading:string,children:React.ReactNode}){
  return <section className="space-y-3"><h2 className="text-lg font-medium text-[#1A1A1A]">{heading}</h2>{children}</section>
}
function List({items}:{items:readonly string[]}){
  return <ul className="list-outside list-disc space-y-1 pl-5">{items.map(t=><li key={t}>{t}</li>)}</ul>
}
function Fallback(){
  return <div>
    <PageHero title="Cookie Policy" breadcrumb="Cookie Policy" />
    <article data-nav-theme="light" className="container-kvrn max-w-3xl section-padding min-w-0 space-y-9 text-[14px] leading-relaxed text-[#6B6B6B]">
      <p className="text-xs uppercase tracking-wider">Last updated: October 6, 2026</p>
      <p>This Cookie Policy explains how KVRN uses cookies, local storage, session storage, and similar browser technologies on kvrn.shop.</p>
      <p>These technologies are collectively referred to as “browser technologies” in this policy.</p>
      <Section heading="1. WHAT THESE TECHNOLOGIES ARE">
        <p>Cookies are small pieces of information stored by a website in your browser.</p>
        <p>Local storage and session storage are browser features that can store information on your device without using a traditional cookie.</p>
        <p>KVRN uses a combination of these technologies to operate the storefront, remember preferences, support affiliate attribution, and, when permitted, measure site usage.</p>
      </Section>
      <Section heading="2. ESSENTIAL AND FUNCTIONAL STORAGE">
        <p>KVRN uses browser storage that is necessary or useful for core storefront functions.</p>
        <p>Examples may include:</p>
        <dl className="space-y-4">{lists.essential.map(([term,definition])=><div key={term}><dt className="font-medium text-[#1A1A1A]">{term}</dt><dd>{definition}</dd></div>)}</dl>
      </Section>
      <Section heading="3. AFFILIATE ATTRIBUTION">
        <p>If you enter KVRN through an approved affiliate referral link, KVRN may set a first-party affiliate-attribution cookie.</p>
        <p>The current affiliate cookie is an opaque random identifier. It does not itself contain your name, email address, affiliate identity, payment information, or other readable personal details.</p>
        <p>The cookie is used to connect a referral visit with server-side affiliate-attribution records if a qualifying order is later placed.</p>
        <p>The current technical maximum lifetime for this referral cookie is approximately 400 days, although the actual affiliate attribution window may be shorter.</p>
        <p>Where applicable law requires consent for non-essential referral or measurement technologies, KVRN will apply the required consent controls.</p>
      </Section>
      <Section heading="4. ANALYTICS">
        <p>KVRN uses first-party analytics designed to measure basic storefront activity such as:</p>
        <List items={lists.analytics}/>
        <p>KVRN’s browser-side first-party analytics are designed to run only when analytics consent is active and no supported browser opt-out signal is blocking analytics.</p>
        <p>A random analytics session identifier may be kept in session storage for the current browser tab/session. It is not intended to identify you personally.</p>
        <p>KVRN may also use third-party analytics tools, such as Google Analytics, if they are enabled. Any optional analytics provider must be subject to the site’s applicable consent controls.</p>
      </Section>
      <Section heading="5. ADVERTISING AND TARGETED-ADVERTISING TECHNOLOGIES">
        <p>KVRN does not currently run cross-context targeted-advertising tracking through the storefront.</p>
        <p>The cookie-preferences interface may include an Advertising or Targeted Advertising category so KVRN can maintain a consistent privacy-control structure.</p>
        <p>If KVRN later enables advertising technologies that require notice, consent, or an opt-out, the Cookie Policy and privacy controls will be updated before or when required.</p>
      </Section>
      <Section heading="6. GLOBAL PRIVACY CONTROL AND DO NOT TRACK">
        <p>Where applicable, KVRN recognizes supported browser privacy signals such as Global Privacy Control.</p>
        <p>KVRN’s current analytics logic is designed to disable optional analytics when Global Privacy Control is enabled.</p>
        <p>KVRN also treats an enabled browser Do Not Track signal as a reason not to run optional analytics under the current implementation.</p>
      </Section>
      <Section heading="7. MANAGING YOUR PREFERENCES">
        <p>You can use KVRN’s Cookie Preferences control to manage optional categories.</p>
        <p>You can generally:</p><List items={lists.choices}/>
        <CookieControls/>
        <p>You may also clear cookies, local storage, and site data through your browser settings.</p>
        <p>Clearing browser storage may remove:</p><List items={lists.clearing}/>
      </Section>
      <Section heading="8. RETENTION">
        <p>Different browser technologies have different lifetimes.</p>
        <p>Some are session-only and disappear after the session or tab ends.</p>
        <p>Others remain until:</p><List items={['Their configured expiration date','You change a preference','You clear browser data','KVRN replaces or removes the storage']}/>
      </Section>
      <Section heading="9. THIRD-PARTY PROVIDERS">
        <p>Third-party services may set or read browser technologies when they are enabled and permitted.</p>
        <p>Those providers’ own privacy notices may also apply.</p>
        <p>KVRN will not intentionally enable optional analytics or advertising technologies in a manner that contradicts the choices presented through KVRN’s privacy controls.</p>
      </Section>
      <Section heading="10. MORE INFORMATION">
        <p>For more information about KVRN’s data practices, see:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><Link className="underline" href="/privacy">Privacy Policy</Link></li>
          <li><Link className="underline" href="/privacy-choices">Your Privacy Choices</Link></li>
          <li><Link className="underline" href="/messaging-privacy">KVRN Messaging Privacy Policy, if you participate in SMS</Link></li>
        </ul>
        <p>Questions may be sent to: <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a></p>
      </Section>
    </article>
  </div>
}
export const dynamic='force-dynamic'
export async function generateMetadata():Promise<Metadata>{
  if(!cmsContentEnabled())return FALLBACK_METADATA
  const view=await contentPublic().getPolicyById('cookies')
  return view?policyMetadata(view,FALLBACK_METADATA):FALLBACK_METADATA
}
export default async function CookiesPage(){
  if(cmsContentEnabled()){
    const view=await contentPublic().getPolicyById('cookies')
    if(view)return <><PolicyView view={view}/><div className="container-kvrn max-w-3xl pb-10"><CookieControls/></div></>
  }
  return <Fallback/>
}
