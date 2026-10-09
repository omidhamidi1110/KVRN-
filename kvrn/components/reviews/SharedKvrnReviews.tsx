'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '@/context/I18nContext'

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

const INITIAL = { name: '', item: 'Hoodie', rating: 5, headline: '', text: '', website: '' }
function Stars({ score }: { score: number }) { return <span aria-label={`${score} out of 5 stars`} className="text-[13px] tracking-[0.15em]" style={{ color:'#2F2A25' }}>{'★'.repeat(Math.max(0, Math.min(5, Math.round(score))))}{'☆'.repeat(Math.max(0, 5 - Math.round(score)))}</span> }

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
 const submit = async (e: React.FormEvent) => {
   e.preventDefault(); if (busy) return
   setBusy(true); setFailed(''); setNotice('')
   try {
     const r = await fetch('/api/reviews', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(form) })
     const d = await r.json()
     if (!r.ok) throw new Error(d.error ?? 'Unable to submit review.')
     setNotice(copy.pending); setForm({ ...INITIAL, item: reviewedItem }); setFormOpen(false)
   } catch(e) { setFailed(e instanceof Error ? e.message : 'Unable to submit review.') }
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
       {available && <button className="border border-[#222] px-5 py-3 text-[12px] hover:bg-[#222] hover:text-white" onClick={() => setFormOpen(!formOpen)}>{copy.write}</button>}
     </div>
     {notice && <p role="status" className="mt-5 text-sm text-[#14532D]">{notice}</p>}
     {failed && <p role="alert" className="mt-5 text-sm text-[#B91C1C]">{failed}</p>}
     {formOpen && available && <form onSubmit={submit} className="mt-7 grid max-w-[650px] grid-cols-1 gap-3 border border-[#DDD] bg-white p-5 sm:grid-cols-2">
       <div className="absolute -left-[9999px]" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={e => setForm({ ...form, website:e.target.value })}/></label></div>
       <label className="text-xs">Name<input required minLength={2} maxLength={70} value={form.name} onChange={e => setForm({ ...form, name:e.target.value })} className="mt-1 block w-full border border-[#CCC] px-3 py-2 text-sm"/></label>
       <label className="text-xs">Item reviewed<select value={form.item} onChange={e => {
  const item = e.currentTarget.value
  if (
    item === 'Hoodie' ||
    item === 'Sweatpants' ||
    item === 'Other KVRN item'
  ) {
    setForm(previous => ({ ...previous, item }))
  }
}} className="mt-1 block w-full border border-[#CCC] bg-white px-3 py-2 text-sm"><option>Hoodie</option><option>Sweatpants</option><option>Other KVRN item</option></select></label>
       <label className="text-xs">Rating<select value={form.rating} onChange={e => setForm({ ...form, rating:Number(e.target.value) })} className="mt-1 block w-full border border-[#CCC] bg-white px-3 py-2 text-sm">{[5,4,3,2,1].map(n => <option key={n} value={n}>{n} / 5</option>)}</select></label>
       <label className="text-xs">Title<input required minLength={3} maxLength={120} value={form.headline} onChange={e => setForm({ ...form, headline:e.target.value })} className="mt-1 block w-full border border-[#CCC] px-3 py-2 text-sm" /></label>
       <label className="text-xs sm:col-span-2">Your experience<textarea required minLength={20} maxLength={2000} rows={4} value={form.text} onChange={e => setForm({ ...form, text:e.target.value })} className="mt-1 block w-full border border-[#CCC] px-3 py-2 text-sm" /></label>
       <p className="text-[11px] leading-5 text-[#666] sm:col-span-2">Reviews are moderated before publication. Submissions are not labeled verified purchases.</p>
       <button disabled={busy} className="bg-[#1A1A1A] px-4 py-3 text-xs text-white disabled:opacity-50 sm:col-span-2">{busy ? 'Submitting…' : copy.submit}</button>
     </form>}
     {available && data && data.reviews.length ? <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{data.reviews.map(r => <article key={r.id} className="border border-[#E4E1DB] bg-white p-5"><Stars score={r.rating}/><h3 className="mt-3 text-[15px] font-medium">{r.headline}</h3><p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6 text-[#555]">{r.body}</p><p className="mt-4 text-[11px] text-[#777]">{r.display_name} · {r.item_label} · {new Date(r.created_at).toLocaleDateString(locale)}</p></article>)}</div>
       : <p className="mt-7 text-[13px] text-[#777]">{available ? copy.empty : 'Reviews will be available soon.'}</p>}
   </div>
 </section>
}
