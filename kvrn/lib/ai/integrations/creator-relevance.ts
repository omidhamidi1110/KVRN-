/** Temporary public-index leads, never verified creators or imported identities. */
export type BraveHit={url?:unknown;title?:unknown;description?:unknown}
export type CreatorLead={url:string;title:string;snippet:string}

const BAD=/\b(?:roblox|bloxburg|minecraft|fortnite|gaming|gameplay|gamepass|fakeheadless|headless|avatar|bloxfruits|blox)\b|dress to impress|pet simulator/i
const STYLE=/\b(?:streetwear|street[ -]?style|menswear|fashion|outfits?|ootd|lookbook|hoodies?|clothing|apparel|wardrobe|styling|stylist|styled|styles?|fit[ -]?check|daily fits|try[ -]?on|haul|grwm|activewear|gymwear|fitness|workout)\b/i

const FOCUS:[RegExp,string][]= [
 [/\bstreetwear\b/i,'streetwear'],
 [/\bmenswear\b/i,'menswear'],
 [/\bhoodies?\b/i,'hoodie'],
 [/\b(?:activewear|fitness|gymwear|workout)\b/i,'activewear'],
 [/\b(?:outfits?|ootd)\b/i,'outfits'],
 [/\b(?:clothing|apparel)\b/i,'fashion'],
 [/\b(?:fashion|styling|style)\b/i,'fashion']
]

export function buildBraveCreatorQuery(topic:string):string{
 const niche=FOCUS.find(([re])=>re.test(topic))?.[1]??'fashion'
 // One broad niche per request instead of requiring every keyword.
 return `site:tiktok.com ${niche} -roblox -minecraft -fortnite -headless`
}

export function rankBraveCreatorHits(raw:BraveHit[],topic:string):CreatorLead[]{
 const best=new Map<string,{score:number;lead:CreatorLead}>()
 const niche=FOCUS.find(([re])=>re.test(topic))?.[1]??'fashion'

 for(const item of (Array.isArray(raw)?raw:[]).slice(0,20)){
  if(typeof item.url!=='string'||item.url.length>900)continue

  let u:URL
  try{u=new URL(item.url)}catch{continue}

  if(u.protocol!=='https:'||u.username||u.password||
   !['tiktok.com','www.tiktok.com','m.tiktok.com'].includes(u.hostname.toLowerCase()))continue

  const profile=u.pathname.match(/^\/@([A-Za-z0-9._]{2,24})\/?$/)
  const video=u.pathname.match(/^\/@([A-Za-z0-9._]{2,24})\/video\/\d{10,22}\/?$/)
  if(!profile&&!video)continue

  const handle=(profile??video)![1].toLowerCase()
  const title=typeof item.title==='string'?item.title.slice(0,160):''
  const snippet=typeof item.description==='string'?item.description.slice(0,280):''
  const content=`${title} ${snippet} ${handle}`

  if(BAD.test(content))continue

  const fashion=STYLE.test(content)

  // Videos need fashion evidence; direct profiles may be tentative leads.
  if(!profile&&!fashion)continue

  const topicMatch=new RegExp(`\\b${niche}\\b`,'i').test(content)
  const score=(fashion?8:0)+(topicMatch?4:0)+(profile?3:0)

  const prefix=fashion?
   (profile?'Fashion profile':'Fashion video → profile'):
   'Possible creator — verify niche'

  const lead={
   url:`https://www.tiktok.com/@${handle}`,
   title:`@${handle} · ${prefix}`,
   snippet:snippet||title
  }

  const prev=best.get(handle)
  if(!prev||prev.score<score)best.set(handle,{lead,score})
 }

 return [...best.values()]
  .sort((a,b)=>b.score-a.score)
  .slice(0,12)
  .map(x=>x.lead)
}
