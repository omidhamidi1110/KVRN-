import type { Metadata } from 'next'
import Link from 'next/link'
export const metadata:Metadata={title:'Email Preferences — KVRN',robots:{index:false,follow:false},referrer:'no-referrer'}
export const dynamic='force-dynamic'
export default async function EmailPreferencesPage({searchParams}:{searchParams:Promise<{token?:string;done?:string;error?:string}>}){
  const p=await searchParams
  const token=typeof p.token==='string'&&/^v1\.[A-Za-z0-9._-]{70,150}$/.test(p.token)?p.token:''
  return <main className="mx-auto max-w-xl px-5 py-24 text-center text-[#1A1A1A]">
    <h1 className="text-3xl font-light tracking-tight">KVRN email preferences</h1>
    {p.done==='1'?<><p className="mt-6 text-sm">Your marketing email subscription has been cancelled. This does not affect order confirmations or important service messages.</p><Link className="mt-8 inline-block underline" href="/">Return to KVRN</Link></>
    :<><p className="mt-6 text-sm leading-relaxed">You can stop receiving promotional KVRN emails. This change does not stop transactional order, security, or support emails.</p>
    {token?<form className="mt-8" action="/api/marketing/unsubscribe" method="post"><input type="hidden" name="token" value={token}/><button className="rounded bg-black px-6 py-3 text-sm text-white" type="submit">Unsubscribe from marketing emails</button></form>
    :<p className="mt-8 text-sm" role="status">{p.error==='1'?'This preference link is invalid or no longer available.':'To unsubscribe, open the unsubscribe link from a KVRN marketing email.'} You can also request removal at <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a>.</p>}</>}
  </main>
}
