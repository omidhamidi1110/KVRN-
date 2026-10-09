import { parsePolicyPaste } from '../content-paste-import'
test('recognizes supplied dates, headings and bullets without losing text',()=>{
 const r=parsePolicyPaste('KVRN — Privacy Policy\n\nLast updated: October 6, 2026\n\n1. DATA WE COLLECT\n\nWe collect order details.\n\n• Email\n• Name')
 expect(r.effectiveDate).toBe('2026-10-06')
 expect(r.body.blocks.map(b=>b.t)).toEqual(['h2','p','ul'])
 expect(r.body.blocks[1]).toEqual({t:'p',c:[{t:'text',text:'We collect order details.'}]})
})
test('does not publish, convert to HTML or silently discard content',()=>{
 const r=parsePolicyPaste('KVRN — Terms\n\n1. CONDITIONS\n\n<script>bad</script>')
 expect(JSON.stringify(r.body)).toContain('<script>bad</script>')
 expect(JSON.stringify(r.body)).not.toContain('dangerouslySetInnerHTML')
})
test('rejects empty policy body',()=>{expect(()=>parsePolicyPaste('')).toThrow('No policy body')})
