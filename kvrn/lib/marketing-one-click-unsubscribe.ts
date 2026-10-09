/** RFC 8058 one-click request validation for KVRN marketing email only.
 * Link preview / GET must NEVER change consent. This only validates the wire
 * contract; the signed token and DB suppression are checked by the route.
 */
export function validMarketingOneClickBody(contentType:string|null,body:string):boolean{
 if(!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType??''))return false
 if(typeof body!=='string'||body.length>128)return false
 const fields=new URLSearchParams(body)
 const names=[...fields.keys()]
 return names.length===1&&names[0]==='List-Unsubscribe'&&fields.get('List-Unsubscribe')==='One-Click'
}
export function oneClickMarketingUrl(confirmationUrl:string):string{
 let u:URL
 try{u=new URL(confirmationUrl)}catch{throw Error('MARKETING_UNSUBSCRIBE_LINK_INVALID')}
 if(u.origin!=='https://kvrn.shop'||u.pathname!=='/email-preferences'||u.searchParams.size!==1)
  throw Error('MARKETING_UNSUBSCRIBE_LINK_INVALID')
 const token=u.searchParams.get('token')??''
 if(!/^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token))throw Error('MARKETING_UNSUBSCRIBE_LINK_INVALID')
 return `https://kvrn.shop/api/marketing/one-click-unsubscribe?token=${encodeURIComponent(token)}`
}
