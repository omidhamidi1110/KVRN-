// GET /api/affiliate/documents/{docType} — the CURRENT published version of a program document (plain text/markdown).
// Read-only accounts may still read the rules.
import { type NextRequest } from 'next/server'
import { sql } from '@/lib/db'
import { requireAffiliate, jsonError } from '@/lib/affiliate-auth-guard'
import { getCurrentDocumentBody, PORTAL_VISIBLE_DOCS } from '@/lib/affiliate-portal-bridge'
import { portalJson } from '@/lib/affiliate-portal-http'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ docType: string }> }) {
  const { error } = await requireAffiliate(req, { allowReadOnly: true })
  if (error) return error
  const { docType } = await params
  if (!(PORTAL_VISIBLE_DOCS as readonly string[]).includes(docType)) return jsonError(404, 'Document not found.')
  try {
    const d = await getCurrentDocumentBody(sql, docType)
    if (!d) return jsonError(404, 'Document not found.')
    return portalJson({ document: { docType: d.docType, title: d.title, version: d.version, effectiveAt: d.effectiveAt, body: d.body } })
  } catch (err: any) {
    console.error('[affiliate/documents]', String(err?.message ?? '').slice(0, 120))
    return jsonError(500, 'Could not load the document.')
  }
}
