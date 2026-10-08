// Admin content UI: structural guards (no raw HTML injection, rendered inside the Admin shell,
// every editor wired to the API it needs) plus a real server render of every editor form so a
// broken import or a crash on a default snapshot is caught without a browser.
import fs from 'fs'
import path from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createLoader } from './helpers/tsx-loader'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const UI_DIR = 'components/admin/content'
const uiFiles = fs.readdirSync(path.join(ROOT, UI_DIR)).filter(f => /\.tsx?$/.test(f))

describe('admin content UI: structure', () => {
  test('the page exists under the Admin layout, is dynamic and noindex', () => {
    const src = read('app/admin/content/page.tsx')
    expect(fs.existsSync(path.join(ROOT, 'app/admin/layout.tsx'))).toBe(true)
    expect(src).toMatch(/dynamic = 'force-dynamic'/)
    expect(src).toMatch(/index: false/)
    expect(src).toMatch(/ContentHub/)
  })

  test.each(uiFiles)('%s injects no raw HTML and does not touch the cache or DB directly', f => {
    const src = read(`${UI_DIR}/${f}`)
    expect(src).not.toMatch(/dangerouslySetInnerHTML\s*=/)
    expect(src).not.toMatch(/\.innerHTML\s*=/)
    expect(src).not.toMatch(/from '@\/lib\/db'|revalidatePath|revalidateTag/)
  })

  test('every interactive file is a client component', () => {
    for (const f of uiFiles.filter(x => x.endsWith('.tsx'))) expect(read(`${UI_DIR}/${f}`).startsWith(`'use client'`)).toBe(true)
  })

  test('the hub offers every managed area', () => {
    const src = read(`${UI_DIR}/ContentHub.tsx`)
    for (const label of ['Policies', 'Size guides', 'Content blocks', 'FAQ', 'Pages', 'About & Contact', 'Announcement', 'Navigation', 'Footer', 'Collections', 'Site SEO'])
      expect(src).toContain(`'${label}'`)
  })

  test('the editor offers Draft, Publish, Versions and Rollback and shows invalidation failures', () => {
    const ed = read(`${UI_DIR}/EntityEditor.tsx`)
    expect(ed).toMatch(/Publish/); expect(ed).toMatch(/Unpublish/); expect(ed).toMatch(/Duplicate/); expect(ed).toMatch(/Archive/)
    expect(ed).toMatch(/InvalidationNotice/); expect(ed).toMatch(/conflict/)
    const v = read(`${UI_DIR}/VersionsPanel.tsx`)
    expect(v).toMatch(/rollback/); expect(v).toMatch(/versionNo/)
    expect(read(`${UI_DIR}/ui.tsx`)).toMatch(/cache-invalidations/)
  })

  test('collections send the optimistic version on every write', () => {
    const src = read(`${UI_DIR}/CollectionsPanel.tsx`)
    expect(src).toMatch(/version: d!\.version/)
    expect(src).toMatch(/version\b[^\n]*\}\)/)
    expect(src.match(/\bversion\b/g)?.length).toBeGreaterThanOrEqual(6)
  })
})

describe('admin content UI: forms render', () => {
  const ext = (spec: string) => {
    if (spec === 'next/navigation') return { usePathname: () => '/admin/content', useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams() }
    return require(spec)
  }
  const loader = createLoader(ext as NodeRequire)
  const { FORMS, NEW_SNAPSHOT } = loader.load('components/admin/content/forms.tsx')

  // New items start from NEW_SNAPSHOT; singletons open on the seeded (or coded default) snapshot.
  const { seedEntities } = require('../content-seed')
  const { KINDS } = require('../content-schemas')
  const seeded = (kind: string) => seedEntities().find((e: any) => e.type === KINDS[kind].type && (kind !== 'support-pages' || e.id === 'size-guide'))?.snapshot
  const kinds = ['policies', 'size-guides', 'blocks', 'faq', 'pages', 'about', 'contact', 'support-pages', 'announcement', 'navigation', 'footer']
  test.each(kinds)('%s form renders its default snapshot', kind => {
    const make = NEW_SNAPSHOT[kind]
    const snap = make ? make() : seeded(kind)
    expect(snap).toBeTruthy()
    const html = renderToStaticMarkup(createElement(FORMS[kind], { value: snap, onChange() {}, blockChoices: [], isNew: true }))
    expect(html.length).toBeGreaterThan(50)
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('[object Object]')
  })
})
