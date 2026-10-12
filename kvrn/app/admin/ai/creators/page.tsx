
import type { Metadata } from 'next'
import { CreatorRecruitingClient } from './CreatorRecruitingClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Creator Recruiting — KVRN Admin',
  robots: {
    index: false,
    follow: false,
  },
}

export default function Page() {
  return <CreatorRecruitingClient />
}
