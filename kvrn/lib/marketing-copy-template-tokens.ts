/** Browser-safe static template rendering: NO customer data or secret access. */
export const STATIC_BRAND_TOKENS:Readonly<Record<string,string>>=Object.freeze({
  brand:'KVRN',site_url:'https://kvrn.shop',support_email:'support@kvrn.shop'
})
export const TEMPLATE_TOKEN=/\{\{\s*([^{}\s]+)\s*\}\}/g
/** No arbitrary placeholder interpolation, dynamic PII, or unsafe remote URL substitution. */
export function renderStaticBrandCopy(input:string):string{
 const rendered=input.replace(TEMPLATE_TOKEN,(_all,name:string)=>{
  const value=STATIC_BRAND_TOKENS[name]
  if(!Object.prototype.hasOwnProperty.call(STATIC_BRAND_TOKENS,name)||typeof value!=='string')throw Error('UNSUPPORTED_MARKETING_PLACEHOLDER')
  return value
 })
 if(/[{}]/.test(rendered))throw Error('UNSUPPORTED_MARKETING_PLACEHOLDER')
 return rendered
}
