/**
 * Regression guard for the Admin Shipping "black right strip" (2026-10-08).
 *
 * MEASURED ROOT CAUSE (qa/admin-responsive/measure.mjs, iPhone viewport, headless Chromium):
 * AdminTable's `overflow-x-auto` wrapper was not a positioned box. `.sr-only` is
 * position:absolute, so the table's sr-only caption / "Notes" / "Save" header text escaped the
 * wrapper's clip, landed at its static position on the table's far-right edge (x≈637 for a
 * 640px table) and widened the DOCUMENT (innerWidth 390 -> 637). Mobile browsers then shrink the
 * layout viewport to fit; the admin shell stayed phone-width and the dark html/body background
 * showed to its right. Hiding <thead> (the sr-only cells) returned the page to 390.
 *
 * The fix is a containing block (`relative`), NOT global overflow-x:hidden. These guards fail if
 * a horizontally-scrolling wrapper in admin/affiliate UI loses it, or if overflow is masked globally.
 */
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) walk(rel, out)
    else if (/\.tsx$/.test(e.name)) out.push(rel)
  }
  return out
}

// Scroll wrappers owned by this workstream (ai/ belongs to the other workstream: see SHARED_FILES_CHANGED.md).
const SCOPE = [...walk('components/admin'), ...walk('app/admin'), ...walk('app/affiliate')]
  .filter(f => !f.startsWith('app/admin/ai/') && !f.startsWith('app/admin/marketing/') && !f.startsWith('app/admin/store-credit/') && !f.startsWith('app/admin/live/'))

describe('horizontal scroll containers are containing blocks (black-strip root cause)', () => {
  test('every className with overflow-x-auto/scroll is positioned (relative/absolute/fixed/sticky)', () => {
    const offenders: string[] = []
    for (const f of SCOPE) {
      const src = read(f)
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = m[1] ?? m[2] ?? ''
        if (/\boverflow-x-(auto|scroll)\b/.test(cls) && !/(^|\s)(relative|absolute|fixed|sticky)(\s|$)/.test(cls)) {
          offenders.push(`${f}: ${cls.slice(0, 80)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('AdminTable wrapper is relative, contained, keyboard-focusable and labelled', () => {
    const src = read('components/admin/ui/AdminUI.tsx')
    const m = src.match(/export function AdminTable[\s\S]*?<div className="([^"]+)"([^>]*)>/)
    expect(m).toBeTruthy()
    expect(m![1]).toMatch(/(^|\s)relative(\s|$)/)
    expect(m![1]).toMatch(/overflow-x-auto/)
    expect(m![1]).toMatch(/overscroll-x-contain/)
    expect(m![2]).toMatch(/tabIndex=\{0\}/)      // WCAG 2.1.1: scrollable region reachable by keyboard
    expect(m![2]).toMatch(/role="region"/)
    expect(m![2]).toMatch(/aria-label=/)
  })

  test('no global overflow-x masking was introduced', () => {
    const css = read('app/globals.css')
    expect(css).not.toMatch(/(html|body)[^{}]*\{[^}]*overflow-x\s*:\s*(hidden|clip)/)
    expect(read('app/layout.tsx')).not.toMatch(/overflow-x-(hidden|clip)/)
    expect(read('components/admin/AdminShell.tsx')).not.toMatch(/overflow-x-(hidden|clip)/)
  })
})

describe('landmarks: the admin shell never nests a second <main> inside the root layout main', () => {
  const read = (p: string) => require('fs').readFileSync(require('path').join(__dirname, '../..', p), 'utf8')
  test('app/layout.tsx owns the only <main>; AdminShell renders a focusable div', () => {
    expect(read('app/layout.tsx')).toMatch(/<main id="main-content"/)
    const shell = read('components/admin/AdminShell.tsx')
    expect(shell).not.toMatch(/<main[\s>]/)
    expect(shell).toMatch(/<div id="admin-main" tabIndex=\{-1\}/)
  })
})
