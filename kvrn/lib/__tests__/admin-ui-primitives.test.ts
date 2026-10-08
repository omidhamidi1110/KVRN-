// Source-guard tests for the shared Admin UI primitives (no jsdom in this repo's jest setup).
import fs from 'fs'
import path from 'path'
const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8')

describe('InfoTip accessibility contract', () => {
  const src = read('components/admin/ui/InfoTip.tsx')
  test('is a real button with aria-label, aria-expanded, aria-controls', () => {
    expect(src).toMatch(/<button[\s\S]*type="button"/)
    expect(src).toMatch(/aria-label=\{label\}/)
    expect(src).toMatch(/aria-expanded=\{open\}/)
    expect(src).toMatch(/aria-controls=/)
  })
  test('Escape and outside click/tap close it; not hover-only', () => {
    expect(src).toMatch(/e\.key === 'Escape'/)
    expect(src).toMatch(/addEventListener\('mousedown'/)
    expect(src).toMatch(/addEventListener\('touchstart'/)
    expect(src).not.toMatch(/onMouseEnter|onMouseLeave|:hover\s*\{/)
  })
  test('touch target is at least 28px', () => { expect(src).toMatch(/h-7 w-7/) })
})

describe('status vocabulary and notices', () => {
  const src = read('components/admin/ui/AdminUI.tsx')
  test('the required status labels all exist', () => {
    for (const s of ['Live','Draft','Active','Inactive','Paid','Refunded','Fulfilled','Unfulfilled','Reconciled','Incomplete','Exception','Pending','Unknown','Failed'])
      expect(src).toContain(`${s}:`)
  })
  test('Exception / Incomplete / Failed / Unknown are not rendered as success', () => {
    expect(src).toMatch(/Exception: 'danger'/); expect(src).toMatch(/Failed: 'danger'/)
    expect(src).toMatch(/Incomplete: 'warning'/); expect(src).toMatch(/Unknown: 'warning'/)
  })
  test('badge always renders visible text (no color-only meaning)', () => { expect(src).toMatch(/\{label \?\? status\}/) })
  test('no gradients', () => { expect(src).not.toMatch(/gradient/i) })
  test('warnings/errors use role=alert', () => { expect(src).toMatch(/role=\{tone === 'danger' \|\| tone === 'warning' \? 'alert'/) })
})

// ── Admin refresh additions ──────────────────────────────────────────────────

describe('refresh additions to the shared primitives', () => {
  const ui = read('components/admin/ui/AdminUI.tsx')
  test('page, stat, tag, segmented and disclosure primitives exist', () => {
    for (const n of ['AdminPage', 'AdminStat', 'AdminStatGrid', 'AdminTag', 'AdminSegmented', 'AdminDisclosure'])
      expect(ui).toMatch(new RegExp(`export function ${n}\\b`))
  })
  test('tabs support arrow-key navigation with a roving tabindex', () => {
    expect(ui).toMatch(/ArrowRight/); expect(ui).toMatch(/ArrowLeft/); expect(ui).toMatch(/tabIndex=\{active \? 0 : -1\}/)
  })
  test('the confirm dialog closes on Escape', () => { expect(ui).toMatch(/e\.key === 'Escape'/) })
  test('Cancelled is part of the fixed status vocabulary', () => { expect(ui).toMatch(/Cancelled: 'neutral'/) })
  test('InfoTip is portalled so a table or card never clips it', () => {
    expect(read('components/admin/ui/InfoTip.tsx')).toMatch(/createPortal/)
  })
})
