// labelStackCells: header text -> data-label on body cells (the mobile stacked-card mode). Pure DOM logic, tested with a minimal stub (no jsdom in this repo).
import fs from 'fs'
import path from 'path'

// AdminUI.tsx is a client component with CSS import; extract the pure function instead of importing the module.
const src = fs.readFileSync(path.join(__dirname, '../../components/admin/ui/AdminUI.tsx'), 'utf8')
const m = src.match(/export function labelStackCells[\s\S]*?\n}\n/)
if (!m) throw new Error('labelStackCells not found')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require('typescript')
const js: string = ts.transpileModule(m[0].replace('export function', 'function'), { compilerOptions: { target: 'ES2020' } }).outputText
// eslint-disable-next-line no-new-func
const labelStackCells: (t: any) => void = new Function(`${js}; return labelStackCells`)()

type Cell = { textContent: string; colSpan: number; attrs: Record<string, string>; getAttribute(k: string): string | null; setAttribute(k: string, v: string): void; removeAttribute(k: string): void; hasAttribute(k: string): boolean; querySelector(sel: string): unknown }
const cell = (text: string, colSpan = 1, attrs: Record<string, string> = {}): Cell => {
  const c: Cell = { textContent: text, colSpan, attrs: { ...attrs },
    getAttribute: k => (k in c.attrs ? c.attrs[k] : null), setAttribute: (k, v) => { c.attrs[k] = v }, removeAttribute: k => { delete c.attrs[k] }, hasAttribute: k => k in c.attrs, querySelector: () => null }
  return c
}
const table = (head: Cell[], rows: Cell[][]) => ({ tHead: { rows: [{ cells: head }] }, tBodies: [{ rows: rows.map(cells => ({ cells })) }] })

describe('labelStackCells', () => {
  test('copies header text onto each cell of the column', () => {
    const r = [cell('1'), cell('Paid'), cell('$5')]
    labelStackCells(table([cell(' Order '), cell('Status'), cell('Total')], [r]))
    expect(r.map(c => c.attrs['data-label'])).toEqual(['Order', 'Status', 'Total'])
  })
  test('the first cell and long values span the card (data-wide); short values pair up', () => {
    const r = [cell('SKU-1'), cell('Project KVRN Heavyweight Hoodie'), cell('10')]
    labelStackCells(table([cell('SKU'), cell('Product'), cell('On hand')], [r]))
    expect(r.map(c => 'data-wide' in c.attrs)).toEqual([true, true, false])
  })
  test('full-width cells (empty / detail rows) are never labelled, and do not shift later cells', () => {
    const empty = [cell('No rows', 3)]
    labelStackCells(table([cell('A'), cell('B'), cell('C')], [empty]))
    expect(empty[0].attrs['data-label']).toBeUndefined()
  })
  test('an explicit label is kept; auto labels refresh when the header changes', () => {
    const r = [cell('x', 1, { 'data-label': 'Custom' }), cell('y')]
    const t = table([cell('A'), cell('B')], [r])
    labelStackCells(t); expect(r[0].attrs['data-label']).toBe('Custom'); expect(r[1].attrs['data-label']).toBe('B')
    ;(t.tHead.rows[0].cells[1] as Cell).textContent = 'Renamed'; labelStackCells(t)
    expect(r[1].attrs['data-label']).toBe('Renamed')
  })
  test('empty headers (checkbox / action columns) get no label', () => {
    const r = [cell('[ ]'), cell('Name')]
    labelStackCells(table([cell(''), cell('Name')], [r]))
    expect(r[0].attrs['data-label']).toBeUndefined(); expect(r[1].attrs['data-label']).toBe('Name')
  })
  test('a header colSpan covers the columns beneath it', () => {
    const r = [cell('a'), cell('b'), cell('c')]
    labelStackCells(table([cell('Group', 2), cell('Other')], [r]))
    expect(r.map(c => c.attrs['data-label'])).toEqual(['Group', 'Group', 'Other'])
  })
})

describe('stack mode wiring', () => {
  test('stack tables use the shared CSS and never hide cells (no display:none on td)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../components/admin/ui/admin-stack.css'), 'utf8')
    expect(css).toMatch(/@media \(max-width: 639px\)/)
    expect(css).not.toMatch(/td[^{]*\{[^}]*display:\s*none/)
    expect(src).toMatch(/import '\.\/admin-stack\.css'/)
  })
})
