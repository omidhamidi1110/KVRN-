import {readAdminMutationJson} from '../admin-mutation-safety'
const rejectedStatus=(result:Awaited<ReturnType<typeof readAdminMutationJson>>)=>result.ok?null:result.status
const req=(origin:string|null,fetchSite:string|null,contentType:string,body:string)=>({
  headers:new Headers({...origin?{origin}:{},...fetchSite?{'sec-fetch-site':fetchSite}:{},'content-type':contentType}),
  nextUrl:new URL('https://kvrn.shop/api/admin/marketing/campaigns'),
  body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(body));controller.close()}}),
}) as any

describe('Admin campaign mutation boundary',()=>{
 it('allows same-origin bounded JSON',async()=>{
   const result=await readAdminMutationJson(req('https://kvrn.shop','same-origin','application/json','{"title":"draft"}'))
   expect(result.ok).toBe(true)
 })
 it('rejects cross-origin and unsupported media type',async()=>{
   expect(rejectedStatus(await readAdminMutationJson(req('https://evil.invalid','cross-site','application/json','{}')))).toBe(403)
   expect(rejectedStatus(await readAdminMutationJson(req('https://kvrn.shop','same-origin','text/plain','{}')))).toBe(415)
 })
 it('rejects chunked bodies that exceed configured cap',async()=>{
   expect(rejectedStatus(await readAdminMutationJson(req('https://kvrn.shop','same-origin','application/json',JSON.stringify({body:'x'.repeat(17000)}))))).toBe(413)
 })
})
