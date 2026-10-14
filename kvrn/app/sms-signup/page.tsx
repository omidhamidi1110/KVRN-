import type {Metadata} from 'next'
import Link from 'next/link'

export const dynamic='force-dynamic'
export const metadata:Metadata={
  title:'Text Updates & SMS Signup | KVRN',
  description:'How KVRN SMS marketing opt-in works, including JOIN/YES, STOP, HELP and privacy choices.',
}

export default function SmsSignupPage(){
  // Do not solicit enrollment until carrier approval, legal publication and
  // the inbound double opt-in flow are all explicitly enabled.
  const enabled=process.env.TWILIO_A2P_APPROVED==='true' &&
    process.env.TWILIO_SIGNUP_ENABLED==='true' &&
    process.env.TWILIO_KEYWORD_DOUBLE_OPTIN_ENABLED==='true' &&
    process.env.KVRN_SMS_POLICY_PUBLIC_ENABLED==='true' &&
    process.env.NEXT_PUBLIC_SMS_SIGNUP_ENABLED==='true'
  const smsNumber=process.env.NEXT_PUBLIC_KVRN_SMS_NUMBER||'+16572149996'
  const smsHref=`sms:${smsNumber}?body=${encodeURIComponent('JOIN')}`
  return <section className="container-kvrn mx-auto max-w-3xl px-5 py-12 sm:py-20" aria-labelledby="sms-heading">
    <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">KVRN PRIVATE ACCESS</p>
    <h1 id="sms-heading" className="mt-3 text-4xl font-light">Text Updates</h1>
    <p className="mt-5 text-base leading-7 text-neutral-700">Get optional recurring promotional SMS updates from KVRN about new clothing drops, early access, restocks, and special offers.</p>
    <div className="mt-8 rounded-lg border border-neutral-300 bg-white p-6 sm:p-8">
      <h2 className="text-xl font-medium">How to subscribe</h2>
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-7 text-neutral-700">
        <li>From your own mobile phone, send <strong>JOIN</strong> to <strong>{smsNumber}</strong>.</li>
        <li>When you receive KVRN&apos;s confirmation request, reply <strong>YES</strong> within 30 minutes.</li>
        <li>Only a verified YES confirmation enrolls your number. An unconfirmed JOIN does not subscribe you.</li>
      </ol>
      {enabled ? <a href={smsHref} className="mt-6 inline-block bg-neutral-900 px-7 py-4 text-sm font-semibold text-white hover:bg-neutral-700">TEXT JOIN TO KVRN</a>
        : <p role="status" className="mt-6 rounded-md bg-neutral-100 px-4 py-3 text-sm text-neutral-800">SMS enrollment is not available yet while carrier registration is being completed. Please do not send JOIN until this notice is removed.</p>}
      <p className="mt-6 text-sm leading-7 text-neutral-700">By sending JOIN and then YES, you expressly consent to recurring automated promotional texts from KVRN at your sending number. Consent is not required to purchase. Message frequency varies. Message and data rates may apply. Reply STOP to cancel or HELP for assistance. You must be 18 or older.</p>
      <p className="mt-4 text-sm leading-7 text-neutral-700">Review the <Link className="underline" href="/messaging-terms">Terms of Service</Link> and <Link className="underline" href="/messaging-privacy">Privacy Policy</Link>, or contact <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a> for support.</p>
    </div>
    <p className="mt-6 text-xs leading-6 text-neutral-500">KVRN also supports voluntary website SMS signup after carrier activation: customers enter a mobile number and explicitly check a separate, initially unchecked SMS marketing consent checkbox next to recurring-message, frequency, rates, STOP/HELP, not-required-to-purchase and policy-link disclosures. Checkout and email signups never imply SMS consent. While carrier registration is pending, neither website signup nor keyword enrollment is available.</p>
  </section>
}
