import type {Metadata} from 'next'
import {notFound} from 'next/navigation'
import {creditIdentityConfigured} from '@/lib/store-credit-customer-identity'
import CreditVerifyClient from './CreditVerifyClient'

export const dynamic = 'force-dynamic'
export const metadata:Metadata={robots:{index:false,follow:false,nocache:true}}

/** Verification link is sent only when the owner has enabled identity mail. */
export default function CreditVerifyPage() {
  if (!creditIdentityConfigured()) notFound()
  return <CreditVerifyClient />
}
