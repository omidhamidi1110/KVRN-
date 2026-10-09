import { orderWord, noCostKnown, costSub, marginSub, missingCostTitle, missingCostBody } from '@/components/admin/shippingCopy'
import fs from 'fs'
import path from 'path'

const t = (orders: number, known: number) => ({ orders, ordersWithKnownCost: known, ordersMissingCost: orders - known })

describe('Shipping unknown-vs-zero copy ("unknown is not zero", singular/plural)', () => {
  test('singular/plural', () => {
    expect(orderWord(1)).toBe('order')
    expect(orderWord(0)).toBe('orders')
    expect(orderWord(2)).toBe('orders')
  })
  test('the reported screenshot case reads "1 order", never "1 orders known"', () => {
    const s = t(2, 1)
    expect(costSub(s)).toBe('Recorded on 1 of 2 orders')
    expect(missingCostTitle(s)).toBe('1 of 2 orders has no recorded label cost.')
    expect(missingCostBody(s)).toContain('only the 1 order where')
    expect(marginSub(s)).toContain('the 1 order with a recorded cost')
    for (const x of [costSub(s), missingCostTitle(s), missingCostBody(s), marginSub(s)]) expect(x).not.toMatch(/\b1 orders\b/)
  })
  test('no known cost => unknown wording, never a bare zero claim', () => {
    const s = t(3, 0)
    expect(noCostKnown(s)).toBe(true)
    expect(costSub(s)).toBe('No carrier cost recorded yet')
    expect(marginSub(s)).toMatch(/Needs a recorded carrier cost/)
    expect(missingCostBody(s)).toMatch(/unknown for this period\. They are not \$0/)
  })
  test('an empty period is not "unknown"', () => {
    expect(noCostKnown(t(0, 0))).toBe(false)
    expect(costSub(t(0, 0))).toBe('No paid orders in this period')
  })
  test('ShippingClient renders unknown instead of $0.00 when no cost is known, and keeps money math in the API', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/admin/financials/shipping/ShippingClient.tsx'), 'utf8')
    expect(src).toMatch(/noCostKnown\(t\) \? 'Not recorded' : money\(t\.shippingCostCents\)/)
    expect(src).toMatch(/noCostKnown\(t\) \? 'Unknown' : money\(t\.shippingMarginCents\)/)
    expect(src).not.toMatch(/orders known/)
    expect(src).not.toMatch(/reduce\(/)       // no client-side money arithmetic
  })
})
