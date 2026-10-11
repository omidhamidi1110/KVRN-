import type { Metadata } from 'next'
import { ChiefChatClient } from './ChiefChatClient'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
  title: 'Chat with Chief — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <ChiefChatClient />
}
