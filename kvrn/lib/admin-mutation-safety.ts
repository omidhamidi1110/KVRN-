/** Additional defense for authenticated Admin JSON mutations.
 * Cloudflare Access verifies identity; this prevents browser cross-origin form
 * submissions and requires a bounded JSON body (including chunked uploads).
 */
import type {NextRequest} from 'next/server'
import {readLimitedJson, type LimitedJsonResult} from '@/lib/limited-json-request'
export type AdminMutationRead = LimitedJsonResult | {ok:false,status:403|415,reason:'origin'|'media_type'}
export async function readAdminMutationJson(req:NextRequest,maxBytes=16000):Promise<AdminMutationRead>{
  const origin=req.headers.get('origin')
  const site=req.headers.get('sec-fetch-site')
  if(site && site!=='same-origin' && site!=='none')return {ok:false,status:403,reason:'origin'}
  if(origin){
    try{
      const submitted=new URL(origin)
      if(submitted.origin!==req.nextUrl.origin)return {ok:false,status:403,reason:'origin'}
    }catch{return {ok:false,status:403,reason:'origin'}}
  }else if(process.env.NODE_ENV==='production' && site!=='same-origin'){
    return {ok:false,status:403,reason:'origin'}
  }
  const type=req.headers.get('content-type')??''
  if(!/^application\/json(?:\s*;|\s*$)/i.test(type))return {ok:false,status:415,reason:'media_type'}
  return readLimitedJson(req,maxBytes)
}
