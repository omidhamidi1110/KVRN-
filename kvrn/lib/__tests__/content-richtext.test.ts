// Rich text model: sanitizer (hostile input), inline markup round-trips, renderer escaping.
import { renderToStaticMarkup } from 'react-dom/server'
import {
  validateRichText, markupToInline, inlineToMarkup, richTextToPlain, collectMediaIds, collectBlockRefs,
  para, heading, bullets, rule, moveItem, RICH_LIMITS, isRichTextEmpty, type RichText,
} from '../content-richtext'
import { renderRichText } from '../../components/content/render-richtext'
import { checkUrl, checkNavUrl, checkRichTextUrl, checkSlug, slugify, normalizeInternalPath } from '../content-urls'

const ok = (v: unknown) => { const r = validateRichText(v); if (!r.ok) throw new Error(r.errors.join('; ')); return r.value }
const bad = (v: unknown) => { const r = validateRichText(v); expect(r.ok).toBe(false); return r.ok ? [] : r.errors }
const doc = (...blocks: any[]) => ({ v: 1, blocks })
const link = (href: any, text = 'x') => doc({ t: 'p', c: [{ t: 'link', href, text }] })
const ZW = String.fromCharCode(0x200b), BIDI = String.fromCharCode(0x202e), LS = String.fromCharCode(0x2028)

describe('URL validation', () => {
  test.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'ftp://example.com/x',
    '//evil.example.com', '///evil.example.com', '/\\evil.example.com', '\\\\evil.example.com',
    'http://example.com', 'example.com', 'www.example.com', '', '   ', 'relative/path', '../up', './here',
    'https://user:pass@example.com', 'https://', 'https://localhost', 'https://exa mple.com', 'https://example.com/a b',
    `/ok${ZW}`, `/o${LS}k`, 'mailto:not-an-email', '/a/../b', '/a/./b',
  ])('refuses %j', (u) => { expect(checkRichTextUrl(u).ok).toBe(false) })

  test.each([
    ['/shop', 'internal'], ['/support/faq#returns', 'internal'], ['/shop?type=hoodies', 'internal'], ['/', 'internal'],
    ['https://instagram.com/thekvrn', 'external'], ['https://ico.org.uk', 'external'], ['mailto:support@kvrn.shop', 'mailto'],
  ])('accepts %s', (u, kind) => { const r = checkRichTextUrl(u); expect(r.ok).toBe(true); expect(r.kind).toBe(kind) })

  test('navigation links never allow mailto; footer does', () => {
    expect(checkNavUrl('mailto:support@kvrn.shop').ok).toBe(false)
    expect(checkUrl('mailto:support@kvrn.shop', { allowMailto: true }).ok).toBe(true)
    expect(checkUrl('https://example.com', { allowExternal: false }).ok).toBe(false)
  })

  test('slug rules', () => {
    expect(checkSlug('care-guide').ok).toBe(true)
    for (const s of ['Care Guide', 'care--guide', '-care', 'care-', 'ca/re', '', 'a'.repeat(81), 'é']) expect(checkSlug(s).ok).toBe(false)
    expect(checkSlug('terms', new Set(['terms'])).ok).toBe(false)
    expect(slugify('Our Story & Materials!')).toBe('our-story-and-materials')
  })

  test('normalizeInternalPath', () => {
    expect(normalizeInternalPath('/Shop/?type=a#x')).toBe('/shop')
    expect(normalizeInternalPath('/')).toBe('/')
  })
})

describe('sanitizer: hostile input', () => {
  test('rejects unknown block and inline node types', () => {
    bad(doc({ t: 'html', html: '<script>alert(1)</script>' }))
    bad(doc({ t: 'script', src: 'x' }))
    bad(doc({ t: 'p', c: [{ t: 'html', text: '<b>x</b>' }] }))
    bad(doc({ t: 'p', c: [{ t: 'img', src: 'x' }] }))
    bad(doc({ t: 'embed', kind: 'iframe' }))
    bad(doc({ t: 'embed', kind: '<script>' }))
  })
  test('rejects unsafe links inside rich text (never rewrites silently)', () => {
    bad(link('javascript:alert(1)'))
    bad(link('data:text/html;base64,AAAA'))
    bad(link('//evil.example'))
    bad(link(undefined as any)); bad(link(42 as any)); bad(link({ toString: () => '/x' } as any))
  })
  test('strips unknown keys (rebuilds from a whitelist)', () => {
    const v = ok(doc({ t: 'p', c: [{ t: 'text', text: 'hi', onclick: 'alert(1)', style: 'x', b: true }], onmouseover: 'x', style: 'color:red' }))
    expect(v.blocks[0]).toEqual({ t: 'p', c: [{ t: 'text', text: 'hi', b: true }] })
    const l = ok(link('/shop', 'go')); expect((l.blocks[0] as any).c[0]).toEqual({ t: 'link', href: '/shop', text: 'go' })
  })
  test('HTML-looking text is kept as TEXT and escaped by the renderer', () => {
    const v = ok(doc({ t: 'p', c: [{ t: 'text', text: '<script>alert(1)</script><img src=x onerror=alert(1)>' }] }))
    const html = renderToStaticMarkup(renderRichText(v) as any)
    expect(html).not.toContain('<script'); expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;')
  })
  test('control and bidi-override characters are stripped', () => {
    const v = ok(doc({ t: 'p', c: [{ t: 'text', text: `a\u0000b${BIDI}c\u0007d` }] }))
    expect((v.blocks[0] as any).c[0].text).toBe('abcd')
  })
  test('rejects non-documents', () => {
    for (const x of [null, undefined, 'x', 1, [], {}, { v: 2, blocks: [] }, { v: 1 }, { v: 1, blocks: 'x' }, { v: 1, blocks: {} }]) bad(x)
  })
  test('size caps', () => {
    bad({ v: 1, blocks: Array.from({ length: RICH_LIMITS.blocks + 1 }, () => ({ t: 'hr' })) })
    bad(doc({ t: 'p', c: [{ t: 'text', text: 'x'.repeat(RICH_LIMITS.textNode + 1) }] }))
    bad(doc({ t: 'ul', items: Array.from({ length: RICH_LIMITS.listItems + 1 }, () => []) }))
    bad(doc({ t: 'table', label: '', headers: ['a'], rows: Array.from({ length: RICH_LIMITS.tableRows + 1 }, () => [[{ t: 'text', text: 'x' }]]) }))
    bad(doc({ t: 'table', label: '', headers: Array.from({ length: RICH_LIMITS.tableCols + 1 }, () => 'h'), rows: [] }))
    bad(doc({ t: 'cards', items: Array.from({ length: RICH_LIMITS.cards + 1 }, () => ({ label: 'a', text: 'b' })) }))
    bad(doc(...Array.from({ length: 30 }, () => ({ t: 'p', c: [{ t: 'text', text: 'y'.repeat(4900) }] }))))   // > totalChars
  })
  test('media blocks need a library uuid; reusable-block refs need a uuid', () => {
    bad(doc({ t: 'media', assetId: 'https://evil.example/x.png' }))
    bad(doc({ t: 'media', assetId: '../../etc/passwd' }))
    bad(doc({ t: 'blockref', blockId: 'x' }))
    const id = '123e4567-e89b-12d3-a456-426614174000'
    const v = ok(doc({ t: 'media', assetId: id.toUpperCase(), caption: 'Cap' }, { t: 'blockref', blockId: id }))
    expect(collectMediaIds(v)).toEqual([id]); expect(collectBlockRefs(v)).toEqual([id])
  })
  test('option flags: block refs / media can be disallowed', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000'
    expect(validateRichText(doc({ t: 'blockref', blockId: id }), { allowBlockRefs: false }).ok).toBe(false)
    expect(validateRichText(doc({ t: 'media', assetId: id }), { allowMedia: false }).ok).toBe(false)
  })
  test('prototype pollution keys are inert', () => {
    const payload = JSON.parse('{"v":1,"blocks":[{"t":"p","c":[{"t":"text","text":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"p":1}}}]}]}')
    const v = ok(payload)
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.keys((v.blocks[0] as any).c[0])).toEqual(['t', 'text'])
  })
})

describe('inline markup', () => {
  test('parse + print basics', () => {
    expect(markupToInline('a **b** *c* ***d***')).toEqual([
      { t: 'text', text: 'a ' }, { t: 'text', text: 'b', b: true }, { t: 'text', text: ' ' },
      { t: 'text', text: 'c', i: true }, { t: 'text', text: ' ' }, { t: 'text', text: 'd', b: true, i: true },
    ])
    expect(markupToInline('see [Terms](/terms) now')).toEqual([
      { t: 'text', text: 'see ' }, { t: 'link', href: '/terms', text: 'Terms' }, { t: 'text', text: ' now' },
    ])
  })
  test.each([
    'plain', 'a **b** c', 'x *y* z', '[link](/shop)', '**[bold link](https://example.com/a)**', 'literal \\* star and \\[bracket\\]',
    'price: 400 GSM* (see note)', 'a \\\\ backslash', 'mail [support@kvrn.shop](mailto:support@kvrn.shop).',
    'url with parens [x](https://example.com/a%28b%29)',
  ])('round-trips %j', (src) => {
    const a = markupToInline(src)
    const printed = inlineToMarkup(a)
    expect(markupToInline(printed)).toEqual(a)
  })
  test('nodes survive print→parse exactly', () => {
    const nodes = [{ t: 'text' as const, text: 'a*b[c]\\' }, { t: 'link' as const, href: 'https://x.example/p(1)', text: 'l[1]', b: true as const }]
    expect(markupToInline(inlineToMarkup(nodes))).toEqual(nodes)
  })
  test('lenient on garbage and never throws', () => {
    for (const s of ['**', '***', '[', '[]', '[](', '[a](', '[a](b', '\\', '*', '**a', 'a]b)', '[a]b']) expect(() => markupToInline(s)).not.toThrow()
  })
  test('a parsed link with an unsafe href is rejected by the validator', () => {
    const d = doc({ t: 'p', c: markupToInline('[click](javascript:alert(1))') })
    bad(d)
  })
})

describe('introspection + helpers', () => {
  test('plain text + empty detection', () => {
    const d = ok(doc({ t: 'h2', c: [{ t: 'text', text: 'Head' }] }, { t: 'p', c: [{ t: 'text', text: 'Body' }] }, { t: 'ul', items: [[{ t: 'text', text: 'one' }]] }))
    expect(richTextToPlain(d)).toBe('Head\nBody\none')
    expect(isRichTextEmpty({ v: 1, blocks: [] })).toBe(true)
    expect(isRichTextEmpty(d)).toBe(false)
  })
  test('moveItem', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1])
    expect(moveItem([1, 2, 3], 5, 0)).toEqual([1, 2, 3])
  })
})

describe('renderer', () => {
  const render = (d: RichText, ctx: any = {}) => renderToStaticMarkup(renderRichText(d, ctx) as any)
  test('safe links: https gets rel=noopener, internal does not, bad href renders text only', () => {
    const html = render(ok(doc({ t: 'p', c: [
      { t: 'link', href: 'https://ico.org.uk', text: 'ICO' }, { t: 'link', href: '/terms', text: 'Terms' }] })))
    expect(html).toContain('href="https://ico.org.uk"'); expect(html).toContain('rel="noopener noreferrer"'); expect(html).toContain('target="_blank"')
    expect(html).toContain('href="/terms"')
    // a row that bypassed validation still cannot emit a javascript: link
    const evil = render({ v: 1, blocks: [{ t: 'p', c: [{ t: 'link', href: 'javascript:alert(1)', text: 'click' }] }] } as any)
    expect(evil).not.toContain('javascript:'); expect(evil).not.toContain('<a '); expect(evil).toContain('click')
  })
  test('quotes in text cannot break out of attributes', () => {
    const html = render({ v: 1, blocks: [{ t: 'table', label: '"><script>x</script>', headers: ['h'], rows: [] }] } as any)
    expect(html).not.toContain('<script>')
  })
  test('missing media / block refs render nothing; blocks never nest', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000'
    expect(render(ok(doc({ t: 'media', assetId: id })))).toBe('<div class="space-y-10 text-[14px] text-kvrn-muted leading-relaxed"></div>'.replace(/<div[^>]*><\/div>/, m => m))
    const inner: RichText = { v: 1, blocks: [{ t: 'blockref', blockId: id }, para('inner text')] }
    const html = render(ok(doc({ t: 'blockref', blockId: id })), { blocks: { [id]: inner } })
    expect(html).toContain('inner text')
    expect((html.match(/inner text/g) ?? []).length).toBe(1)      // the self-reference inside was dropped
  })
  test('media renders the server-resolved URL + alt only', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000'
    const html = render(ok(doc({ t: 'media', assetId: id, caption: 'Cap' })), { media: { [id]: { url: '/media/ab/' + 'a'.repeat(64) + '/original.webp', alt: 'A "quoted" alt' } } })
    expect(html).toContain('alt="A &quot;quoted&quot; alt"'); expect(html).toContain('<figcaption')
  })
  test('sections: h2 starts a section, hr renders a divider, anchors from heading text', () => {
    const d = ok(doc(heading('Returns'), para('Body'), rule(), heading('Other'), para('B2')))
    const html = render(d)
    expect((html.match(/<section/g) ?? []).length).toBe(2)
    expect(html).toContain('class="rule"')
  })
  test('embeds only render when the page supplies them', () => {
    const d = ok(doc({ t: 'embed', kind: 'cookie-controls' }))
    expect(render(d)).not.toContain('EMBED')
    expect(render(d, { embeds: { 'cookie-controls': 'EMBED' } })).toContain('EMBED')
  })
  test('bullets variant for support pages', () => {
    const html = render(ok(doc(bullets(['a', 'b']))), { variant: 'support' })
    expect(html).toContain('rounded-full')
  })
})
