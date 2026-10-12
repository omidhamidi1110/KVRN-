/** Temporary, unverified public-index leads; never imported automatically. */
export type BraveHit={url?:unknown;title?:unknown;description?:unknown;extra_snippets?:unknown}
export type CreatorLead={title:string;url:string;snippet:string}
export type CreatorDiagnostics={providerPages:number;accountLinks:number;gamingExcluded:number;businessExcluded:number;strongMatches:number;reviewCandidates:number}

const GAME=/\b(?:roblox|bloxburg|minecraft|fortnite|gaming|gameplay|gamepass|fakeheadless|headless|bloxfruits|avatar|pet simulator)\b|dress to impress/i
const BIZ=/\b(?:b2b|wholesale|marketplace|manufacturer|retailer|fashion network|fashion house|online store|official store|shop now|shop our|buy now|fast shipping|worldwide shipping|designer wear|holdings|100k\+? products|our products|shop the collection|new arrivals|wholesale pricing)\b/i
const BIZ_HANDLE=/(?:wholesale|marketplace|boutique|retail|fashionnetwork|fashionshop|officialstore)/i
const GENERIC=/^(?:fashion|clothing|streetwear|menswear|style|outfits?|apparel|trends?)$/i
const STYLE=/\b(?:streetwear|street[ -]?style|menswear|fashion|outfits?|hoodies?|clothing|apparel|wardrobe|styling|styled|lookbook|ootd|grwm|try[ -]?on|activewear|gymwear|fitness|haul|fit[ -]?check)\b/i
const PERSONAL=/\b(?:grwm|ootd|fit[ -]?check|my outfits?|daily outfits?|outfit ideas|outfit inspo|try[ -]?on|clothing haul|fashion haul|styling tips|style with me|what i wore|get ready with me|lookbook|haul video|day in my life)\b/i
const CREATOR=/\b(?:ugc creator|content creator|fashion creator|digital creator|style creator|micro[ -]?influencer|creator portfolio|open to collabs?|brand collabs?|paid partnership|my portfolio|work with me)\b/i

function focus(topic:string):[string,string]{
 if(/streetwear/i.test(topic))return ['streetwear outfits','streetwear']
 if(/menswear|men.s fashion/i.test(topic))return ['menswear outfits','menswear']
 if(/hoodie/i.test(topic))return ['hoodie styling','hoodie']
 if(/activewear|gymwear|fitness|workout/i.test(topic))return ['activewear try on','activewear']
 if(/outfit|styling|ootd/i.test(topic))return ['outfit ideas','outfit']
 if(/lifestyle/i.test(topic))return ['daily outfits','outfit']
 return ['clothing haul','clothing']
}

export function buildBraveCreatorQuery(topic:string):string{
 // Discover clothing content instead of requiring "UGC creator" in a bio.
 // One broad search per click. No automatic additional provider requests.
 return `site:tiktok.com ${focus(topic)[0]} -roblox -minecraft -fortnite -gaming`
}

function clean(x:unknown,n:number):string{
 if(typeof x!=='string')return ''
 return x.replace(/<[^>]*>/g,' ')
  .replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/gi,' ')
  .replace(/\s+/g,' ').trim().slice(0,n)
}

export function analyzeBraveCreatorHits(
 raw:BraveHit[],topic:string
):{results:CreatorLead[];diagnostics:CreatorDiagnostics}{
 const hits=Array.isArray(raw)?raw.slice(0,20):[]
 const d:CreatorDiagnostics={
  providerPages:hits.length,accountLinks:0,
  gamingExcluded:0,businessExcluded:0,
  strongMatches:0,reviewCandidates:0
 }
 const best=new Map<string,{score:number;strong:boolean;lead:CreatorLead}>()
 const target=focus(topic)[1]

 for(const hit of hits){
  if(typeof hit.url!=='string'||hit.url.length>1000)continue

  let u:URL
  try{u=new URL(hit.url)}catch{continue}

  if(u.protocol!=='https:'||u.username||u.password||
   !['tiktok.com','www.tiktok.com','m.tiktok.com']
    .includes(u.hostname.toLowerCase()))continue

  let path:string
  try{path=decodeURIComponent(u.pathname)}catch{continue}

  const match=path.match(
   /^\/@([a-z0-9._]{2,24})(?:\/(?:video|photo)\/\d{10,22})?\/?$/i
  )
  if(!match)continue

  d.accountLinks++

  const handle=match[1].toLowerCase()
  const title=clean(hit.title,150)
  const snippet=clean(hit.description,260)
  const extra=Array.isArray(hit.extra_snippets)?
   hit.extra_snippets.slice(0,5).map(v=>clean(v,170)).join(' '):''
  const content=`${title} ${snippet} ${extra} ${handle}`

  if(GAME.test(content)){
   d.gamingExcluded++
   continue
  }

  if(BIZ.test(content)||BIZ_HANDLE.test(handle)||GENERIC.test(handle)){
   d.businessExcluded++
   continue
  }

  const style=STYLE.test(content)
  const personal=PERSONAL.test(content)
  const creator=CREATOR.test(content)
  const direct=/^\/@[^/]+\/?$/i.test(path)
  const niche=new RegExp(`\\b${target}(?:s)?\\b`,'i').test(content)
  const strong=style&&(personal||creator)

  const score=
   (strong?30:0)+(personal?10:0)+(creator?9:0)+
   (style?6:0)+(niche?4:0)+(direct?2:0)

  const lead={
   url:`https://www.tiktok.com/@${handle}`,
   title:`@${handle} · ${strong?
    'Likely fashion creator':'Possible creator — review profile'}`,
   snippet:snippet||title||
    'Public TikTok profile or video. Review clothing content before contacting.'
  }

  const prior=best.get(handle)
  if(!prior||score>prior.score)
   best.set(handle,{score,strong,lead})
 }

 const sorted=[...best.values()]
  .sort((a,b)=>b.score-a.score).slice(0,12)

 d.strongMatches=sorted.filter(x=>x.strong).length
 d.reviewCandidates=sorted.length-d.strongMatches

 return {results:sorted.map(x=>x.lead),diagnostics:d}
}

// Maintain compatibility with the earlier helper.
export function rankBraveCreatorHits(
 raw:BraveHit[],topic:string
):CreatorLead[]{
 return analyzeBraveCreatorHits(raw,topic).results
}
