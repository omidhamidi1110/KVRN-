'use client'
import { useState } from 'react'
import { AdminCard, AdminSectionHeader, AdminButton, AdminNotice } from '@/components/admin/ui/AdminUI'
import { GALLERY_SIZE, emptySlot, type ImageSlot, type ColorMedia } from '@/lib/product-model'
import { type SectionProps, SlotEditor, Toggle, IssueList, slotUrl } from '../editor-shared'

const issuesFor = (all: SectionProps['issues'], field: string) => all.filter(i => i.field === field)

function padGallery(g: ImageSlot[]): ImageSlot[] {
  const a = g.slice(0, GALLERY_SIZE); while (a.length < GALLERY_SIZE) a.push(emptySlot()); return a
}
function moveItem<T>(a: T[], from: number, to: number): T[] {
  if (to < 0 || to >= a.length || from === to) return a
  const c = a.slice(); const [x] = c.splice(from, 1); c.splice(to, 0, x); return c
}

/** Five ordered gallery slots (01–05) with drag-and-drop and up/down buttons. */
function GalleryEditor({ slots, onChange, props, desktopFallback, mobileFallback, prefix }: {
  slots: ImageSlot[]; onChange: (g: ImageSlot[]) => void; props: SectionProps
  desktopFallback: string; mobileFallback: string; prefix: string
}) {
  const [drag, setDrag] = useState<number | null>(null)
  const g = padGallery(slots)
  return (
    <ol className="space-y-3">
      {g.map((slot, i) => (
        <li key={i} draggable={!props.locked} onDragStart={() => setDrag(i)} onDragOver={e => e.preventDefault()}
          onDrop={() => { if (drag !== null) onChange(moveItem(g, drag, i)); setDrag(null) }}
          className={drag === i ? 'opacity-50' : undefined}>
          <SlotEditor title={`Image ${String(i + 1).padStart(2, '0')}`} slot={slot} assets={props.assets} addAsset={props.addAsset}
            disabled={props.locked} desktopFallback={desktopFallback} mobileFallback={mobileFallback}
            issues={issuesFor(props.issues, `${prefix}.${i + 1}`)}
            onChange={s => onChange(g.map((x, k) => (k === i ? s : x)))}
            extra={<>
              <AdminButton size="sm" variant="ghost" aria-label={`Move image ${i + 1} up`} disabled={props.locked || i === 0} onClick={() => onChange(moveItem(g, i, i - 1))}>↑</AdminButton>
              <AdminButton size="sm" variant="ghost" aria-label={`Move image ${i + 1} down`} disabled={props.locked || i === GALLERY_SIZE - 1} onClick={() => onChange(moveItem(g, i, i + 1))}>↓</AdminButton>
            </>} />
        </li>
      ))}
    </ol>
  )
}

export function MediaSection(props: SectionProps) {
  const { snap, update, issues, locked, assets } = props
  const hero = snap.media.hero ?? emptySlot()
  const filled = padGallery(snap.media.gallery).filter(s => s.ref).length
  return (
    <div className="space-y-4">
      <AdminCard>
        <AdminSectionHeader title="Hero image" description="The first image visitors see. Separate from the gallery."
          info="The hero is its own image: changing the gallery never changes it. Mobile and desktop can crop it differently." />
        <SlotEditor title="Hero" slot={hero} assets={assets} addAsset={props.addAsset} disabled={locked}
          desktopFallback="center 30%" mobileFallback="center 15%" issues={issuesFor(issues, 'media.hero')}
          onChange={s => update(d => { d.media.hero = s })} />
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Gallery" description={`Exactly ${GALLERY_SIZE} images, shared by the gallery and the product details.`}
          info="Drag to reorder or use the arrows. The same five images appear in the full-screen gallery and in the product details section." />
        {filled !== GALLERY_SIZE && <AdminNotice tone="warning" className="mb-3">{filled} of {GALLERY_SIZE} images added.</AdminNotice>}
        <IssueList issues={issues.filter(i => i.field === 'media.gallery')} />
        <GalleryEditor slots={snap.media.gallery} props={props} prefix="media.gallery" desktopFallback="center 30%" mobileFallback="center 15%"
          onChange={g => update(d => { d.media.gallery = g })} />
      </AdminCard>

      {snap.colors.length > 1 && (
        <AdminCard>
          <AdminSectionHeader title="Colour images" description="Optional. Colours without their own images use the shared gallery."
            info="Give a colour its own hero and five gallery images. Leave off to show the shared gallery for that colour." />
          <div className="space-y-4">
            {snap.colors.map((c, ci) => {
              const own: ColorMedia | null = c.media
              return (
                <div key={c.key + ci} className="rounded-[12px] border border-black/[0.08] p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="h-4 w-4 rounded-full border border-black/20" style={{ background: c.hex }} aria-hidden="true" />
                    <Toggle label={`${c.name} has its own images`} checked={!!own} disabled={locked}
                      onChange={v => update(d => { d.colors[ci].media = v ? { hero: emptySlot(), gallery: padGallery([]) } : null })} />
                  </div>
                  {own && (
                    <div className="space-y-3">
                      <SlotEditor title={`${c.name} hero`} slot={own.hero} assets={assets} addAsset={props.addAsset} disabled={locked}
                        desktopFallback="center 30%" mobileFallback="center 15%" issues={[...issuesFor(issues, `colors.${ci + 1}.media`), ...issuesFor(issues, `colors.${ci + 1}.media.hero`)]}
                        onChange={s => update(d => { d.colors[ci].media!.hero = s })} />
                      <GalleryEditor slots={own.gallery} props={props} prefix={`colors.${ci + 1}.media.gallery`} desktopFallback="center 30%" mobileFallback="center 15%"
                        onChange={g => update(d => { d.colors[ci].media!.gallery = g })} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </AdminCard>
      )}
    </div>
  )
}

export { slotUrl }
