import { parseShippingQuoteInput } from '../shipping-quote-input'

const base = { city: 'Long Beach', state: 'CA', zip: '90802', country: 'US', items: [{ sku:'KVRN-BLK-M', quantity:2 }] }
describe('shipping quote public input', () => {
  test('accepts valid minimal cart', () => {
    expect(parseShippingQuoteInput(base)).toMatchObject({ ok:true, value:base })
  })
  test.each([
    null, [], 'foo',
    { ...base, country:'US<script>' },
    { ...base, city:'x'.repeat(101) },
    { ...base, items:{ sku:'BAD' } },
    { ...base, items:[{ sku:'KVRN', quantity:0 }] },
    { ...base, items:[{ sku:'KVRN', quantity:1.1 }] },
    { ...base, items:[{ sku:'KVRN', quantity:11 }] },
    { ...base, items:[{ sku:'bad/exploit', quantity:1 }] },
    { ...base, items:[{ sku:'A', quantity:1 },{ sku:'A', quantity:2 }] },
    { ...base, items: Array.from({length:21},(_,i)=>({sku:'S'+i, quantity:1})) },
    { ...base, items:[{ sku:'A', quantity:10 },{sku:'B',quantity:10},{sku:'C',quantity:10},{sku:'D',quantity:1}] },
  ])('rejects malformed or abusive input %#', (value) => {
    expect(parseShippingQuoteInput(value).ok).toBe(false)
  })
})
