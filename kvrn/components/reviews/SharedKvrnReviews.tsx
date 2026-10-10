'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '@/context/I18nContext'
import { REVIEW_ITEMS, REVIEW_LIMITS, reviewLength, validateReview, type ReviewFieldErrors, type ReviewFieldKey, type ReviewItem } from '@/lib/review-policy'

type Review = { id: string; display_name: string; item_label: string; rating: number; headline: string; body: string; created_at: string }
type ResponseData = { ready: boolean; reviews: Review[]; count: number; average: number | null }

type Copy = { title: string; shared: string; write: string; empty: string; count: string; submit: string; pending: string }
const WORDS: Record<string, Copy> = {
 en: { title: 'KVRN Customer Reviews', shared: 'Reviews across all KVRN hoodies, sweatpants and other items — not specific to this product.', write: 'Write a review', empty: 'Be the first to share your experience with KVRN.', count: 'KVRN-wide reviews', submit: 'Submit for review', pending: 'Thank you. Your review will appear once approved.' },
 es: { title: 'Opiniones de clientes KVRN', shared: 'Opiniones de todos los productos KVRN, no solo de este artículo.', write: 'Escribir una opinión', empty: 'Sé el primero en compartir tu experiencia.', count: 'Opiniones de KVRN', submit: 'Enviar para revisión', pending: 'Gracias. Tu opinión aparecerá cuando se apruebe.' },
 fr: { title: 'Avis des clients KVRN', shared: 'Avis sur tous les produits KVRN, pas uniquement cet article.', write: 'Laisser un avis', empty: 'Partagez votre expérience avec KVRN.', count: 'Avis sur KVRN', submit: 'Soumettre pour validation', pending: 'Merci. Votre avis paraîtra après validation.' },
 de: { title: 'KVRN Kundenbewertungen', shared: 'Bewertungen aller KVRN Produkte, nicht nur dieses Artikels.', write: 'Bewertung schreiben', empty: 'Teile als Erste:r deine Erfahrung.', count: 'KVRN Bewertungen', submit: 'Zur Prüfung senden', pending: 'Danke. Deine Bewertung erscheint nach Freigabe.' },
 pt: { title: 'Avaliações dos clientes KVRN', shared: 'Avaliações de todos os produtos KVRN, não apenas deste item.', write: 'Escrever avaliação', empty: 'Compartilhe sua experiência com a KVRN.', count: 'Avaliações KVRN', submit: 'Enviar para análise', pending: 'Obrigado. Sua avaliação será exibida após aprovação.' },
 zh: { title: 'KVRN 顾客评价', shared: '评价来自所有 KVRN 产品，不仅限于当前商品。', write: '撰写评价', empty: '成为第一个分享体验的人。', count: 'KVRN 全站评价', submit: '提交审核', pending: '谢谢。评价审核通过后将显示。' },
 ja: { title: 'KVRN お客様レビュー', shared: 'この商品だけでなく、KVRN 全商品のレビューです。', write: 'レビューを書く', empty: '最初のレビューを投稿してください。', count: 'KVRN 共通レビュー', submit: '審査に送信', pending: 'ありがとうございます。承認後に公開されます。' },
 hi: { title: 'KVRN ग्राहक समीक्षाएँ', shared: 'ये सभी KVRN उत्पादों की समीक्षाएँ हैं, केवल इस उत्पाद की नहीं।', write: 'समीक्षा लिखें', empty: 'KVRN का अनुभव सबसे पहले साझा करें।', count: 'KVRN की समीक्षाएँ', submit: 'समीक्षा भेजें', pending: 'धन्यवाद। मंज़ूरी के बाद आपकी समीक्षा दिखेगी।' },
 ko: { title: 'KVRN 고객 리뷰', shared: '이 상품만이 아닌 모든 KVRN 상품의 리뷰입니다.', write: '리뷰 작성', empty: '첫 번째 후기를 남겨주세요.', count: 'KVRN 통합 리뷰', submit: '검토를 위해 제출', pending: '감사합니다. 승인 후 게시됩니다.' },
 ar: { title: 'تقييمات عملاء KVRN', shared: 'تقييمات لجميع منتجات KVRN وليست لهذا المنتج فقط.', write: 'اكتب تقييمًا', empty: 'كن أول من يشارك تجربته.', count: 'تقييمات KVRN', submit: 'إرسال للمراجعة', pending: 'شكرًا لك. سيظهر تقييمك بعد الموافقة عليه.' },
}

const copyErr = { fix: 'Please fix the highlighted fields.', generic: 'We could not submit your review. Please try again.', network: 'Connection problem — your review was not sent. Your text is still here; please try again.' }
const INITIAL = { name: '', item: 'Hoodie', rating: 5, headline: '', text: '', website: '' }
function Stars({ score }: { score: number }) { return <span aria-label={`${score} out of 5 stars`} className="text-[13px] tracking-[0.15em]" style={{ color:'#2F2A25' }}>{'★'.repeat(Math.max(0, Math.min(5, Math.round(score))))}{'☆'.repeat(Math.max(0, 5 - Math.round(score)))}</span> }

const fieldCls = 'box-border block h-11 w-full min-w-0 rounded-[10px] border border-[#CFCAC2] bg-white px-3.5 text-[16px] leading-tight text-[#1A1A1A] placeholder:text-[#A5A5A0] focus:border-[#1A1A1A] focus:outline-none focus:ring-1 focus:ring-[#1A1A1A] aria-[invalid=true]:border-[#B91C1C] aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-[#B91C1C] sm:text-[14px]'
const selectCls = 'cursor-pointer appearance-none bg-no-repeat pr-9 [background-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%23555\' stroke-width=\'2.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><path d=\'M6 9l6 6 6-6\'/></svg>")] [background-position:right_12px_center]'

/** Label + control + (helper | inline error) + optional live counter, wired with aria-invalid / aria-describedby. */
function RField({ id, label, error, hint, counter, children }: {
  id: string; label: string; error?: string; hint?: string; counter?: React.ReactNode
  children: (p: { id: string; 'aria-invalid': boolean; 'aria-describedby': string }) => React.ReactNode
}) {
  const descId = `${id}-desc`
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-[12px] font-medium text-[#3A3935]">{label}</label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': descId })}
      <div id={descId} className="mt-1.5 flex min-h-[16px] items-start justify-between gap-3 text-[11px] leading-4">
        {error ? <p role="alert" className="text-[#B91C1C]">{error}</p> : <p className="text-[#6B6B66]">{hint}</p>}
        {counter && <span className="shrink-0 tabular-nums">{counter}</span>}
      </div>
    </div>
  )
}

/** One brand-wide stream is used by EVERY product detail page. An item label is shown on each review. */
export function SharedKvrnReviews({ compact = false, preview = false, reviewedItem = 'Hoodie' }: { compact?: boolean; preview?: boolean; reviewedItem?: 'Hoodie' | 'Sweatpants' | 'Other KVRN item' }) {
 const { locale } = useI18n()
 const copy = WORDS[locale] ?? WORDS.en
 const [data, setData] = useState<ResponseData | null>(null)
 const [formOpen, setFormOpen] = useState(false)
 const [form, setForm] = useState(() => ({ ...INITIAL, item: reviewedItem }))
 const [busy, setBusy] = useState(false)
 const [notice, setNotice] = useState('')
 const [failed, setFailed] = useState('')
 const [errors, setErrors] = useState<ReviewFieldErrors>({})
 const [touched, setTouched] = useState<Partial<Record<ReviewFieldKey, boolean>>>({})
 const uid = useId()
 const formRef = useRef<HTMLFormElement>(null)
 useEffect(() => {
   if (preview) return
   let alive = true
   fetch('/api/reviews', { cache:'no-store' }).then(r => r.json()).then((d: ResponseData) => { if (alive) setData(d) }).catch(() => {})
   return () => { alive = false }
 }, [preview])
 const available = data?.ready === true
 if (compact) {
   if (!available || !data || data.count === 0) return null // never invent ratings before real approved reviews
   return <a href="#kvrn-reviews" className="mb-5 inline-flex items-center gap-2 text-[12px] text-[#3A3935] underline-offset-4 hover:underline" aria-label={`Read ${data.count} ${copy.count}`}>
     <Stars score={data.average ?? 0}/><span>{Number(data.average ?? 0).toFixed(1)} · {data.count} {copy.count}</span>
   </a>
 }
const FIELD_ORDER: ReviewFieldKey[] = ['name', 'item', 'rating', 'headline', 'text']
 const fid = (k: ReviewFieldKey) => `${uid}-${k}`
 const validateNow = (f: typeof form) => validateReview({ name: f.name, item: f.item, rating: f.rating, headline: f.headline, text: f.text })
 const update = (patch: Partial<typeof form>) => {
   const next = { ...form, ...patch }
   setForm(next)
   if (failed) setFailed('')
   setErrors(validateNow(next)) // live: an error clears the moment the field becomes valid
 }
 const touch = (k: ReviewFieldKey) => setTouched(t => ({ ...t, [k]: true }))
 const focusFirst = (errs: ReviewFieldErrors) => {
   const k = FIELD_ORDER.find(key => errs[key])
   if (k) requestAnimationFrame(() => (formRef.current?.querySelector(`#${CSS.escape(fid(k))}`) as HTMLElement | null)?.focus())
 }
 const submit = async (e: React.FormEvent) => {
   e.preventDefault(); if (busy) return
   setNotice(''); setFailed('')
   const errs = validateNow(form)
   setErrors(errs); setTouched({ name: true, item: true, rating: true, headline: true, text: true })
   if (Object.keys(errs).length) { setFailed(copyErr.fix); focusFirst(errs); return }
   setBusy(true)
   try {
     const r = await fetch('/api/reviews', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(form) })
     const d = await r.json().catch(() => ({}))
     if (!r.ok || d?.ok !== true) {
       const serverFields = (d?.fields ?? null) as ReviewFieldErrors | null
       if (serverFields && Object.keys(serverFields).length) { setErrors(serverFields); setTouched({ name: true, item: true, rating: true, headline: true, text: true }); setFailed(copyErr.fix); focusFirst(serverFields) }
       else setFailed(d?.error ?? copyErr.generic)
       return // the form stays open with every value preserved
     }
     // Confirmed saved (pending moderation) — only now do we say so and clear the form.
     setNotice(copy.pending); setForm({ ...INITIAL, item: reviewedItem }); setErrors({}); setTouched({}); setFormOpen(false)
   } catch { setFailed(copyErr.network) }
   finally { setBusy(false) }
 }
 return <section id="kvrn-reviews" aria-labelledby="kvrn-reviews-heading" className="bg-[#F9F8F6] border-t border-[#DDD9D2] px-5 py-12 sm:px-8 sm:py-16 scroll-mt-24">
   <div className="mx-auto max-w-[1160px]">
     <div className="flex flex-wrap items-end justify-between gap-5">
       <div><p className="text-[10px] tracking-[0.22em] uppercase text-[#777]">KVRN COMMUNITY</p>
         <h2 id="kvrn-reviews-heading" className="mt-3 text-2xl sm:text-3xl font-light">{copy.title}</h2>
         <p className="mt-2 max-w-2xl text-[12px] leading-6 text-[#666]">{copy.shared}</p>
         {available && data && data.count > 0 && <p className="mt-3 flex items-center gap-3 text-[13px]"><Stars score={data.average ?? 0}/><span>{Number(data.average ?? 0).toFixed(1)} / 5 · {data.count} {copy.count}</span></p>}
       </div>
       {available && <button type="button" aria-expanded={formOpen} className="h-11 rounded-[10px] border border-[#222] px-5 text-[12px] transition-colors hover:bg-[#222] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#222] focus-visible:ring-offset-2" onClick={() => setFormOpen(!formOpen)}>{copy.write}</button>}
     </div>
     {notice && <p role="status" className="mt-5 text-sm text-[#14532D]">{notice}</p>}
     {formOpen && available && <form ref={formRef} onSubmit={submit} noValidate aria-label={copy.write} className="mt-7 w-full max-w-[760px] rounded-[14px] border border-[#DDD9D2] bg-white p-5 sm:p-6">
       {failed && <p role="alert" className="mb-4 rounded-[10px] border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-[13px] text-[#991B1B]">{failed}</p>}
       <div className="absolute -left-[9999px]" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={e => setForm({ ...form, website:e.target.value })}/></label></div>
       <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
         <RField id={fid('name')} label="Name" error={touched.name ? errors.name : undefined} hint={`${REVIEW_LIMITS.name.min}–${REVIEW_LIMITS.name.max} characters`}>
           {(p) => <input {...p} className={fieldCls} autoComplete="name" maxLength={REVIEW_LIMITS.name.max} value={form.name} onBlur={() => touch('name')} onChange={e => update({ name: e.target.value })} />}
         </RField>
         <RField id={fid('item')} label="Item reviewed" error={touched.item ? errors.item : undefined}>
           {(p) => <select {...p} className={fieldCls + ' ' + selectCls} value={form.item} onBlur={() => touch('item')} onChange={e => { const item = e.currentTarget.value as ReviewItem; if (REVIEW_ITEMS.includes(item)) update({ item }) }}>
             {REVIEW_ITEMS.map(i => <option key={i} value={i}>{i}</option>)}
           </select>}
         </RField>
         <RField id={fid('rating')} label="Rating" error={touched.rating ? errors.rating : undefined}>
           {(p) => <select {...p} className={fieldCls + ' ' + selectCls} value={form.rating} onBlur={() => touch('rating')} onChange={e => update({ rating: Number(e.target.value) })}>
             {[5,4,3,2,1].map(n => <option key={n} value={n}>{n} / 5</option>)}
           </select>}
         </RField>
         <RField id={fid('headline')} label="Title" error={touched.headline ? errors.headline : undefined} hint={`${REVIEW_LIMITS.headline.min}–${REVIEW_LIMITS.headline.max} characters`}>
           {(p) => <input {...p} className={fieldCls} maxLength={REVIEW_LIMITS.headline.max} value={form.headline} onBlur={() => touch('headline')} onChange={e => update({ headline: e.target.value })} />}
         </RField>
         <div className="sm:col-span-2">
           <RField id={fid('text')} label="Your experience" error={touched.text ? errors.text : undefined}
             hint={`At least ${REVIEW_LIMITS.text.min} characters — a sentence or two about fit, fabric or quality.`}
             counter={<span aria-live="polite" className={reviewLength(form.text) >= REVIEW_LIMITS.text.min ? 'text-[#166534]' : 'text-[#6B6B66]'}>{reviewLength(form.text).toLocaleString('en-US')} / {REVIEW_LIMITS.text.max.toLocaleString('en-US')}{reviewLength(form.text) < REVIEW_LIMITS.text.min ? ` · min ${REVIEW_LIMITS.text.min}` : ''}</span>}>
             {(p) => <textarea {...p} rows={5} className={fieldCls + ' h-auto min-h-[128px] resize-y py-3 leading-6'} maxLength={REVIEW_LIMITS.text.max + 200} value={form.text} onBlur={() => touch('text')} onChange={e => update({ text: e.target.value })} />}
           </RField>
         </div>
       </div>
       <p className="mt-4 text-[11px] leading-5 text-[#666]">Reviews are moderated before publication. Submissions are not labeled verified purchases.</p>
       <button type="submit" disabled={busy} className="mt-4 h-12 w-full rounded-[10px] bg-[#1A1A1A] px-4 text-[12px] font-medium uppercase tracking-[0.12em] text-white transition-colors hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1A1A1A] focus-visible:ring-offset-2 disabled:opacity-50">{busy ? 'Submitting…' : copy.submit}</button>
     </form>}
     {available && data && data.reviews.length ? <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{data.reviews.map(r => <article key={r.id} className="border border-[#E4E1DB] bg-white p-5"><Stars score={r.rating}/><h3 className="mt-3 text-[15px] font-medium">{r.headline}</h3><p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6 text-[#555]">{r.body}</p><p className="mt-4 text-[11px] text-[#777]">{r.display_name} · {r.item_label} · {new Date(r.created_at).toLocaleDateString(locale)}</p></article>)}</div>
       : <p className="mt-7 text-[13px] text-[#777]">{available ? copy.empty : 'Reviews will be available soon.'}</p>}
   </div>
 </section>
}
