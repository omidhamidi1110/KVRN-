// /checkout/recover?t=<token> — resume a saved bag from the single recovery email.
// Public, force-dynamic, noindex. The server only checks that the link is usable (no side
// effects, so a mail scanner pre-fetching it records nothing); the browser then asks
// /api/checkout/recover for the rebuilt, revalidated bag.
import type { Metadata } from 'next'
import { abandonedService } from '@/lib/abandoned-checkout-runtime'
import { RECOVER_STATUS_COPY, type RecoverFailure } from '@/lib/abandoned-checkout-ui'
import { RecoverClient } from './RecoverClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
  title: 'Your saved bag — KVRN',
  robots: { index: false, follow: false, nocache: true },
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div data-nav-theme="light"
      style={{ minHeight: '100vh', background: '#F9F8F6', paddingTop: 'calc(36px + 56px + 48px)', paddingBottom: 64 }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '0 24px' }}>{children}</div>
    </div>
  )
}

function Message({ failure }: { failure: RecoverFailure }) {
  const c = RECOVER_STATUS_COPY[failure]
  return (
    <Shell>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 26, marginBottom: 16, fontWeight: 400, color: '#1A1A1A' }}>{c.title}</h1>
        <p style={{ color: '#6b7280', lineHeight: 1.7, fontSize: 15, maxWidth: 440, margin: '0 auto' }}>{c.body}</p>
        {failure !== 'already_ordered' && (
          <p style={{ marginTop: 24 }}><a href="/shop" style={{ color: '#1A1A1A', fontSize: 14 }}>Go to the shop</a></p>
        )}
      </div>
    </Shell>
  )
}

export default async function RecoverPage({ searchParams }: { searchParams: Promise<{ t?: string | string[] }> }) {
  const sp = await searchParams
  const token = Array.isArray(sp.t) ? sp.t[0] : sp.t
  const res = await abandonedService.resolveRecovery(token)
  if (res.status !== 'ok') return <Message failure={res.status} />
  return <Shell><RecoverClient token={token as string} /></Shell>
}
