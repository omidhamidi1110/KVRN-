
import type { Metadata } from 'next'
import Link from 'next/link'
import { AiOperationsClient } from './AiOperationsClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'AI Operations — KVRN Admin',
  robots: { index: false, follow: false },
}

export default function Page() {
  return (
    <>
      <div className="mx-auto flex max-w-7xl justify-end px-4 pt-4 sm:px-6">
        <Link
          href="/admin/ai/creators"
          className="inline-flex h-10 items-center rounded-lg border border-black/[0.10] bg-white px-4 text-[12px] font-medium text-black/65 shadow-sm hover:border-black/20"
        >
          Creator Recruiting →
        </Link>
      </div>

      <AiOperationsClient />
    </>
  )
}

