// Server wrapper for /contact. The form itself (validation, /api/contact submission, success and
// error states) lives UNCHANGED in ContactClient.tsx. With KVRN_FLAG_CMS_PUBLIC_CONTENT off the
// client renders exactly the coded text; with it on, the published Admin text slots are passed in.
import type { Metadata } from 'next'
import { cmsContentEnabled, contentPublic } from '@/lib/content-public'
import { pageMetadata } from '@/lib/content-seo'
import { ContactClient, type ContactSlots } from './ContactClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  if (!cmsContentEnabled()) return {}
  const view = await contentPublic().getContact()
  if (!view) return {}
  const seo = view.variants.en.data.seo
  const m = pageMetadata({ title: 'Contact — KVRN' }, seo, seo.shareImageId ? view.media[seo.shareImageId]?.url ?? null : null)
  // Without any SEO override the page keeps inheriting the site title (as it always did).
  return seo.title || seo.description || seo.noindex || seo.shareTitle || seo.shareImageId ? m : {}
}

export default async function ContactPage() {
  if (cmsContentEnabled()) {
    const view = await contentPublic().getContact()
    if (view) {
      const slots: Record<string, ContactSlots> = {}
      for (const [locale, v] of Object.entries(view.variants)) {
        const { heroTitle, intro, successTitle, successBody, supportHours, helpNote } = v.data
        slots[locale] = { heroTitle, intro, successTitle, successBody, supportHours, helpNote }
      }
      return <ContactClient slots={slots} />
    }
  }
  return <ContactClient />
}
