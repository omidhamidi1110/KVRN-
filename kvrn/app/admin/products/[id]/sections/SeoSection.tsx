'use client'
import { useState } from 'react'
import { AdminCard, AdminSectionHeader, AdminField, AdminButton, adminInputClass } from '@/components/admin/ui/AdminUI'
import { MediaPicker } from '@/components/admin/media/MediaPicker'
import { LIMITS, GUIDANCE } from '@/lib/product-model'
import { type SectionProps, IssueList, CharCount, textareaClass, Row } from '../editor-shared'

export function SeoSection({ snap, update, issues, locked, assets, addAsset }: SectionProps) {
  const seo = snap.seo
  const [pick, setPick] = useState(false)
  const og = seo.ogImage
  const ogUrl = og ? (og.kind === 'static' ? og.src : assets[og.assetId.toLowerCase()]?.url ?? null) : null
  const title = seo.title || `${snap.name || 'Product'} | KVRN`
  const desc = seo.description || snap.shortDescription
  return (
    <div className="space-y-4">
      <AdminCard>
        <AdminSectionHeader title="Search and sharing" description="Leave blank to use the product name and short description." />
        <div className="space-y-3">
          <AdminField label="Search title" htmlFor="seo-title" info={`Over ${GUIDANCE.seoTitle} characters may be cut off in search results.`}>
            <input id="seo-title" className={adminInputClass} value={seo.title} disabled={locked} maxLength={LIMITS.seoTitle}
              onChange={e => update(s => { s.seo.title = e.target.value })} />
            <div className="mt-1 text-right"><CharCount value={seo.title} soft={GUIDANCE.seoTitle} hard={LIMITS.seoTitle} /></div>
            <IssueList issues={issues.filter(i => i.field === 'seo.title')} tone="warning" />
          </AdminField>
          <AdminField label="Search description" htmlFor="seo-desc" info={`Over ${GUIDANCE.seoDescription} characters may be cut off.`}>
            <textarea id="seo-desc" rows={3} className={textareaClass} value={seo.description} disabled={locked} maxLength={LIMITS.seoDescription}
              onChange={e => update(s => { s.seo.description = e.target.value })} />
            <div className="mt-1 text-right"><CharCount value={seo.description} soft={GUIDANCE.seoDescription} hard={LIMITS.seoDescription} /></div>
            <IssueList issues={issues.filter(i => i.field === 'seo.description' || i.field === 'seo')} tone="warning" />
          </AdminField>
          <div className="rounded-[10px] border border-black/[0.08] bg-[#FAFAF8] p-3" aria-label="Search preview">
            <p className="truncate text-[13px] text-[#1A0DAB]">{title}</p>
            <p className="text-[11px] text-[#006621]">/products/{snap.slug || '…'}</p>
            <p className="line-clamp-2 text-[11px] text-[#545454]">{desc}</p>
          </div>
          <AdminField label="Canonical URL (optional)" htmlFor="seo-canon" info="Only set this if another page is the main version of this product. Must start with https://.">
            <input id="seo-canon" className={adminInputClass} value={seo.canonicalUrl ?? ''} disabled={locked} maxLength={LIMITS.url} placeholder="https://"
              onChange={e => update(s => { s.seo.canonicalUrl = e.target.value || null })} />
          </AdminField>
          <Row>
            <AdminField label="Share title (optional)" htmlFor="seo-og-title">
              <input id="seo-og-title" className={adminInputClass} value={seo.ogTitle ?? ''} disabled={locked} maxLength={LIMITS.ogTitle}
                onChange={e => update(s => { s.seo.ogTitle = e.target.value || null })} />
            </AdminField>
            <AdminField label="Share description (optional)" htmlFor="seo-og-desc">
              <input id="seo-og-desc" className={adminInputClass} value={seo.ogDescription ?? ''} disabled={locked} maxLength={LIMITS.ogDescription}
                onChange={e => update(s => { s.seo.ogDescription = e.target.value || null })} />
            </AdminField>
          </Row>
          <div>
            <p className="mb-1 text-[11px] font-medium text-[#4A4A46]">Share image</p>
            <div className="flex items-center gap-3">
              {ogUrl && /* eslint-disable-next-line @next/next/no-img-element */ <img src={ogUrl} alt="" className="h-16 w-16 rounded-[8px] border border-black/10 object-cover" />}
              <AdminButton size="sm" disabled={locked} onClick={() => setPick(true)}>{og ? 'Replace' : 'Choose image'}</AdminButton>
              {og && <AdminButton size="sm" variant="ghost" disabled={locked} onClick={() => update(s => { s.seo.ogImage = null })}>Remove</AdminButton>}
              {!og && <span className="text-[11px] text-[#8A8A85]">Defaults to the hero image.</span>}
            </div>
            <MediaPicker open={pick} onClose={() => setPick(false)} title="Share image"
              onSelect={a => { addAsset(a); update(s => { s.seo.ogImage = { kind: 'media', assetId: a.id.toLowerCase() } }) }} />
          </div>
        </div>
      </AdminCard>
    </div>
  )
}
