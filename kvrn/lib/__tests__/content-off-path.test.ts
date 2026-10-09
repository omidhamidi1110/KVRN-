// With KVRN_FLAG_CMS_PUBLIC_CONTENT off (the default) every storefront page and shell component
// must render EXACTLY what it rendered before the content CMS existed.
//
// RE-BASELINED 2026-10-08 on the CP08 coded copy (owner October 6 drafts: support@kvrn.shop, 14-day store credit,
// $150 free shipping, Your Privacy Choices link, 1–3 day processing); the text diff against the pre-CMS goldens was
// reviewed line by line. The two /legal/* aliases are now redirects and are tested as such below.
// Original provenance: the fixtures in ./fixtures/content-off/ were produced by rendering the ORIGINAL (pre-CMS) sources
// of each page/component from git commit 4c48f29 with this same loader:
//     UPDATE_CONTENT_FIXTURES=1 npx jest lib/__tests__/content-off-path.test.ts
// (only ever re-run that against the original commit's sources; the normal run renders the CURRENT
// code with the flag off and compares byte for byte.)

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createLoader } from './helpers/tsx-loader'

const BASE_COMMIT = '4c48f29'
const FIX = path.join(__dirname, 'fixtures/content-off')

type Target = { file: string; fixture: string; kind: 'page' | 'component'; exportName?: string; providers?: boolean }
const TARGETS: Target[] = [
  { file: 'app/terms/page.tsx', fixture: 'terms.html', kind: 'page' },
  { file: 'app/privacy/page.tsx', fixture: 'privacy.html', kind: 'page' },
  { file: 'app/cookies/page.tsx', fixture: 'cookies.html', kind: 'page' },
  { file: 'app/support/shipping-returns/page.tsx', fixture: 'shipping-returns.html', kind: 'page' },
  { file: 'app/support/faq/page.tsx', fixture: 'faq.html', kind: 'page' },
  { file: 'app/about/page.tsx', fixture: 'about.html', kind: 'page' },
  { file: 'app/support/size-guide/page.tsx', fixture: 'size-guide.html', kind: 'page' },
  { file: 'app/contact/page.tsx', fixture: 'contact.html', kind: 'page' },
  { file: 'app/collections/project-kvrn/page.tsx', fixture: 'project-kvrn.html', kind: 'page' },
  { file: 'components/layout/Footer.tsx', fixture: 'footer.html', kind: 'component', exportName: 'Footer' },
  { file: 'components/layout/Nav.tsx', fixture: 'nav.html', kind: 'component', exportName: 'Nav', providers: true },
  { file: 'components/ui/AnnouncementBar.tsx', fixture: 'announcement.html', kind: 'component', exportName: 'AnnouncementBar', providers: true },
]

// Where the CURRENT page keeps its old implementation (so the baseline source can be loaded from git).
const ORIGINAL_SOURCE_PATH: Record<string, string> = {
  'app/support/size-guide/page.tsx': 'app/support/size-guide/page.tsx',
  'app/contact/page.tsx': 'app/contact/page.tsx',
}

async function renderTarget(t: Target, original: boolean): Promise<string> {
  const sources: Record<string, string> = {}
  if (original) {
    sources[t.file] = execSync(`git show ${BASE_COMMIT}:${t.file}`, { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', maxBuffer: 20_000_000 })
  }
  // next/navigation hooks need the app router; outside it they are stubbed to a plain storefront URL.
  const ext = ((spec: string) => spec === 'next/navigation'
    ? { usePathname: () => '/shop', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, replace() {}, prefetch() {} }) }
    : require(spec)) as NodeRequire
  const loader = createLoader(ext, { sources })
  const mod = loader.load(t.file)
  const C = t.kind === 'page' ? mod.default : mod[t.exportName!]
  const isAsync = C?.constructor?.name === 'AsyncFunction'
  let el = isAsync ? await C() : createElement(C)
  if (t.providers) {
    // the provider tree of app/layout.tsx, loaded through the same loader so contexts are shared
    const P = (f: string, n: string) => loader.load(f)[n]
    el = createElement(P('context/CookiePrefsContext.tsx', 'CookiePrefsProvider'), null,
      createElement(P('context/I18nContext.tsx', 'I18nProvider'), null,
        createElement(P('context/HeaderContext.tsx', 'HeaderProvider'), null,
          createElement(P('context/CurrencyContext.tsx', 'CurrencyProvider'), null,
            createElement(P('context/WishlistContext.tsx', 'WishlistProvider'), null,
              createElement(P('context/CartContext.tsx', 'CartProvider'), null, el))))))
  }
  return renderToStaticMarkup(el)
}

describe('flag OFF: pages and shell render exactly as before the CMS', () => {
  const saved = process.env.KVRN_FLAG_CMS_PUBLIC_CONTENT
  beforeAll(() => { delete process.env.KVRN_FLAG_CMS_PUBLIC_CONTENT })
  afterAll(() => { if (saved !== undefined) process.env.KVRN_FLAG_CMS_PUBLIC_CONTENT = saved })

  // Re-baseline on the CURRENT coded copy (flag off). Used once on 2026-10-08 after Checkpoint 08 replaced the
  // pre-CMS policy/contact/footer copy with the owner's October 6 drafts; the text diff was reviewed first:
  //     REBASELINE_CONTENT_FIXTURES_TO=/some/dir npx jest lib/__tests__/content-off-path.test.ts -t rebaseline
  if (process.env.REBASELINE_CONTENT_FIXTURES_TO) {
    test('rebaseline fixtures from the current sources', async () => {
      const out = process.env.REBASELINE_CONTENT_FIXTURES_TO as string
      fs.mkdirSync(out, { recursive: true })
      for (const t of TARGETS) fs.writeFileSync(path.join(out, t.fixture), await renderTarget(t, false))
    }, 120000)
  }

  if (process.env.UPDATE_CONTENT_FIXTURES === '1') {
    test('regenerate fixtures from the original sources', async () => {
      fs.mkdirSync(FIX, { recursive: true })
      for (const t of TARGETS) fs.writeFileSync(path.join(FIX, t.fixture), await renderTarget(t, true))
    }, 120000)
  }

  test.each(TARGETS.map(t => [t.file, t] as const))('%s', async (_n, t) => {
    const fixture = fs.readFileSync(path.join(FIX, t.fixture), 'utf8')
    expect(fixture.length).toBeGreaterThan(50)
    expect(await renderTarget(t, false)).toBe(fixture)
  }, 60000)

  // CP08 turned the two legacy /legal aliases into permanent redirects to the one canonical route
  // (one policy URL, no duplicate indexable copies). They no longer render a page, so they are not goldens.
  test.each([['privacy', '/privacy'], ['terms', '/terms']])('legacy alias /legal/%s permanently redirects to %s', (name, to) => {
    const src = fs.readFileSync(path.join(__dirname, `../../app/legal/${name}/page.tsx`), 'utf8')
    expect(src).toMatch(new RegExp(`permanentRedirect\\('${to}'\\)`))
    expect(src).not.toMatch(/contentPublic|PolicyView|OwnerPolicyFallback/)
  })

  test('ORIGINAL_SOURCE_PATH is documented for the two relocated client pages', () => {
    expect(Object.keys(ORIGINAL_SOURCE_PATH)).toHaveLength(2)
  })
})
