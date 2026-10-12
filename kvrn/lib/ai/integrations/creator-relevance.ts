/** Temporary public leads. Never claim verified identity or consent. */
export type BraveHit={
 url?:unknown;title?:unknown;description?:unknown;extra_snippets?:unknown
}
export type CreatorLead={url:string;title:string;snippet:string}

const BAD=/\b(?:roblox|bloxburg|minecraft|fortnite|gameplay|gaming|gamepass|fakeheadless|headless|bloxfruits|avatar)\b|dress to impress|pet simulator/i

const STORE=/\b(?:b2b|wholesale|marketplace|manufacturer|retailer|online shop|online store|official store|shop now|shop our|buy now|fast shipping|shipping worldwide|designer wear|holdings|fashion network|fashion house|our products|100k\+? products|discount code at checkout|shop the collection)\b/i

const STORE_HANDLE=/(?:shop|store|boutique|marketplace|wholesale|retail|official|network)/i

const GENERIC=/^(?:fashion|clothing|streetwear|menswear|style|outfits?|apparel|trends?|gfashion)$/i

const CREATOR=/\b(?:ugc\s*(?:creator|portfolio|content)|content creator|digital creator|fashion creator|style creator|micro[ -]?influencer|creator portfolio|work with me|brand collabs?|paid partnerships?|pr packages?|open to collabs?|available for collabs?)\b/i

const PERSONAL=/\b(?:grwm|ootd|fit[ -]?check|my outfits?|daily outfits?|fashion (?:haul|tips|vlog)|outfit (?:inspo|ideas|styling)|try[ -]?on|style with me|styling tips|lookbook|what i wore|get ready with me|haul video)\b/i

const STYLE=/\b(?:streetwear|street[ -]?style|menswear|fashion|outfits?|hoodies?|clothing|apparel|wardrobe|styling|styles?|grwm|ootd|try[ -]?on|lookbook|fitness|gymwear|activewear)\b/i

function niche(topic:string):string{
 if(/\bstreetwear\b/i.test(topic))return 'streetwear'
 if(/\bmenswear\b|men.s fashion/i.test(topic))return 'menswear'
 if(/\bhoodies?\b/i.test(topic))return 'hoodie'
 if(/\b(?:outfits?|ootd)\b/i.test(topic))return 'outfit'
 if(/\b(?:gymwear|fitness|activewear|workout)\b/i.test(topic))return 'activewear'
 return 'fashion'
}

export function buildBraveCreatorQuery(topic:string):string{
 return `site:tiktok.com/@ "ugc creator" ${niche(topic)} -roblox -gaming -minecraft -fortnite -headless`
}

function clean(value:unknown,max:number):string{
 if(typeof value!=='string')return ''
 return value
  .replace(/<[^>]*>/g,' ')
  .replace(/&(?:amp|lt|gt|quot|#39|#x27);/gi,' ')
  .replace(/\s+/g,' ')
  .trim()
  .slice(0,max)
}

export function rankBraveCreatorHits(
 raw:BraveHit[],topic:string
):CreatorLead[]{
 const best=new Map<string,{score:number;lead:CreatorLead}>()
 const focus=niche(topic)

 for(const hit of (Array.isArray(raw)?raw:[]).slice(0,20)){
  if(typeof hit.url!=='string'||hit.url.length>900)continue

  let url:URL
  try{url=new URL(hit.url)}catch{continue}

  if(url.protocol!=='https:'||url.username||url.password||
   !['tiktok.com','www.tiktok.com','m.tiktok.com']
    .includes(url.hostname.toLowerCase()))continue

  const match=url.pathname.match(/^\/@([a-z0-9._]{2,24})(?:\/(?:video|photo)\/\d{10,22})?\/?$/i)
  if(!match)continue

  const handle=match[1].toLowerCase()
  const direct=/^\/@[^/]+\/?$/.test(url.pathname)

  const title=clean(hit.title,160)
  const snippet=clean(hit.description,280)

  const extra=Array.isArray(hit.extra_snippets)?
   hit.extra_snippets.map(v=>clean(v,200)).join(' '):''

  const context=`${title} ${snippet} ${extra}`

  if(BAD.test(context)||BAD.test(handle)||
   STORE.test(context)||STORE_HANDLE.test(handle))continue

  const creator=CREATOR.test(context)
  const personal=PERSONAL.test(context)
  const fashion=STYLE.test(context)

  if(!creator&&!personal)continue
  if(!fashion&&!creator)continue
  if(GENERIC.test(handle)&&!creator)continue

  const matching=focus==='fashion'?
   fashion:
   new RegExp(`\\b${focus}s?\\b`,'i').test(context)

  const score=
   (creator?12:0)+
   (personal?8:0)+
   (fashion?6:0)+
   (matching?4:0)+
   (direct?3:0)

  const label=creator&&fashion?
   'Fashion UGC creator — review profile':
   creator?
   'UGC creator — verify clothing fit':
   'Fashion content creator — verify UGC fit'

  const lead={
   url:`https://www.tiktok.com/@${handle}`,
   title:`@${handle} · ${label}`,
   snippet:snippet||title
  }

  const previous=best.get(handle)
  if(!previous||previous.score<score)
   best.set(handle,{lead,score})
 }

 return [...best.values()]
  .sort((a,b)=>b.score-a.score)
  .slice(0,12)
  .map(x=>x.lead)
}
