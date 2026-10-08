// lib/admin-status.ts — pure mapping from raw status strings to the Admin's fixed status vocabulary.
//
// The Admin uses ONE set of status words (see STATUS_TONES in components/admin/ui/AdminUI.tsx) so the
// same state never looks different between pages. Unmapped values return null: callers render the raw
// text in a neutral tag instead of inventing a new status word. No money, no I/O.

import type { StatusLabel } from '@/components/admin/ui/AdminUI'

const TABLE: Record<string, StatusLabel> = {
  // fulfilment
  unfulfilled: 'Unfulfilled',
  processing: 'Processing',
  shipped: 'Fulfilled',
  delivered: 'Fulfilled',
  fulfilled: 'Fulfilled',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
  // payment
  paid: 'Paid',
  pending: 'Pending',
  failed: 'Failed',
  refunded: 'Refunded',
  // generic
  active: 'Active',
  inactive: 'Inactive',
  draft: 'Draft',
  live: 'Live',
  open: 'Open',
  resolved: 'Resolved',
  unknown: 'Unknown',
}

export function statusForRaw(raw: string | null | undefined): StatusLabel | null {
  if (!raw) return null
  return TABLE[raw.trim().toLowerCase()] ?? null
}
