'use client'
// Entry point for Messaging Terms and Messaging Privacy. These two are not seeded by a migration, so they do not appear in the
// policy list until a draft exists. The editor opens a blank draft and "Load October 6 draft" fills it from the owner's text.
// Nothing here publishes anything, and nothing here touches the SMS consent flow.
import { AdminButton } from '@/components/admin/ui/AdminUI'

const ITEMS = [
  { id: 'messaging-terms', label: 'Messaging Terms & Conditions', path: '/messaging-terms' },
  { id: 'messaging-privacy', label: 'Messaging Privacy Policy', path: '/messaging-privacy' },
] as const

export function MessagingPoliciesCard({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <section aria-labelledby="msg-policies-h" className="mb-4 rounded-[14px] border border-black/[0.07] bg-white p-4">
      <h2 id="msg-policies-h" className="text-[13px] font-medium text-[#171717]">Text-message (SMS) policies</h2>
      <p className="mt-1 text-[12px] leading-[1.5] text-[#6B6B66]">
        These two pages are kept hidden from visitors (they show “not found”) until a developer switches the text-message policy pages on.
        Open one to write it here, or start from the owner’s October 6 draft. Nothing goes live until a person publishes it after owner approval and legal review.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {ITEMS.map(i => <AdminButton key={i.id} size="sm" variant="secondary" onClick={() => onOpen(i.id)}>{i.label}</AdminButton>)}
      </div>
    </section>
  )
}
