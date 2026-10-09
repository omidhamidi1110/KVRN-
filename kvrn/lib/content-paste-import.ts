/**
 * Convert owner-supplied plain-text policy drafts to the existing constrained CMS
 * rich-text JSON. Does NOT save, publish, translate or contact the database.
 * Preserves words/punctuation verbatim in text nodes; headings and list bullets
 * become semantic blocks. The server must still validate the result.
 */
import type { RichText, RichBlock, Inline } from './content-richtext'
export type PolicyPasteResult = {
  body: RichText
  sourceTitle?: string
  effectiveDate?: string
  blockCount: number
}
const inline=(v:string):Inline=>[{t:'text',text:v}]
export function parsePolicyPaste(raw:string):PolicyPasteResult {
  if(raw.length>120_000) throw new Error('Policy text exceeds 120,000 characters')
  const lines=raw.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n').map(line=>line.trim())
  const blocks:RichBlock[]=[]
  let index=0, sourceTitle: string|undefined, effectiveDate: string|undefined
  while(index<lines.length && !lines[index]) index++
  if(/^KVRN\s*[—–-]\s*[^\n]+$/i.test(lines[index]??''))sourceTitle=lines[index++]
  while(index<lines.length && !lines[index])index++
  const dateLine=lines[index]??''
  const matched=/^Last updated:\s*(.+)$/i.exec(dateLine)
  if(matched){
    const date=new Date(matched[1])
    if(Number.isNaN(date.getTime())) throw new Error('Invalid last-updated date')
    effectiveDate=date.toISOString().slice(0,10)
    index++
  }
  let listItems:string[]=[]
  function flushList(){if(listItems.length){blocks.push({t:'ul',items:listItems.map(inline)});listItems=[]}}
  for(;index<lines.length;index++){
    const text=lines[index]
    if(!text){flushList();continue}
    const bullet=/^(?:•|[-*])\s+(.*)$/.exec(text)
    if(bullet){listItems.push(bullet[1]);if(listItems.length>80)throw new Error('One list exceeds 80 items');continue}
    flushList()
    if(/^(?:\d{1,2}\.\s+[A-Z][A-Z &/,()\-]+|[A-Z][A-Z &/,()\-]{2,})$/.test(text)){
      blocks.push({t:'h2',c:inline(text)})
    }else if(text.length<=70 && /^[A-Z]/.test(text) && !/[.!?:;,]$/.test(text) && !text.startsWith('http')){
      blocks.push({t:'h3',c:inline(text)})
    } else {
      // Keep each supplied line as a separate paragraph so no words disappear.
      // Source copy should use blank lines to separate paragraphs.
      blocks.push({t:'p',c:inline(text)})
    }
    if(blocks.length>200)throw new Error('Policy exceeds 200 CMS blocks; split long lists or consolidate paragraphs')
  }
  flushList()
  if(blocks.length===0)throw new Error('No policy body found')
  if(blocks.length>200)throw new Error('Policy exceeds 200 CMS blocks')
  return {body:{v:1,blocks},sourceTitle,effectiveDate,blockCount:blocks.length}
}
