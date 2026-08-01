'use client'

import Image from 'next/image'
import Link  from 'next/link'

interface ProductLink {
  name:  string
  price: string
  href:  string
  desktopStyle: React.CSSProperties
}

interface CollectionHeroProps {
  desktopImage:  string
  desktopAlt:    string
  mobileImage:   string
  mobileAlt:     string
  eyebrow1:      string
  eyebrow2:      string
  headlineLines: string[]   // exactly 2 strings, each becomes a block span
  specs1:        string[]
  specs2:        string[]
  productLinks?: ProductLink[]
}

export function CollectionHero({
  desktopImage, desktopAlt,
  mobileImage,  mobileAlt,
  eyebrow1, eyebrow2,
  headlineLines,
  specs1, specs2,
  productLinks,
}: CollectionHeroProps) {
  const NAV_H = 92 // announcement bar 36px + navbar 56px

  return (
    <>
      {/* ══ Shared outer: full-viewport dark hero ══════════════════════════ */}

      {/* ── DESKTOP (≥ 901px) ──────────────────────────────────────────── */}
      <section
        aria-label="Collection hero"
        className="hidden lg:block"
        style={{
          position:   'relative',
          width:      '100%',
          minHeight:  720,
          height:     `calc(100vh - ${NAV_H}px)`,
          maxHeight:  920,
          overflow:   'hidden',
          background: '#090909',
          color:      '#fff',
        }}
      >
        {/* Desktop image */}
        <div style={{ position: 'absolute', inset: 0 }}>
          <Image
            src={desktopImage}
            alt={desktopAlt}
            fill priority sizes="100vw"
            style={{ objectFit: 'cover', objectPosition: 'center' }}
          />
        </div>

        {/* Left gradient */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background:
            'linear-gradient(90deg,rgba(0,0,0,0.78) 0%,rgba(0,0,0,0.38) 34%,rgba(0,0,0,0.04) 62%,rgba(0,0,0,0) 100%)',
        }} />

        {/* Left copy */}
        <div style={{
          position:  'absolute',
          left:      'clamp(48px, 4.5vw, 80px)',
          top:       '50%',
          transform: 'translateY(-46%)',
          maxWidth:  590,
          zIndex:    2,
        }}>
          <p style={{ fontSize:15, letterSpacing:'0.14em', lineHeight:1.45,
                      textTransform:'uppercase', color:'rgba(255,255,255,0.85)', margin:0 }}>
            {eyebrow1}
          </p>
          <p style={{ fontSize:15, letterSpacing:'0.14em', lineHeight:1.45,
                      textTransform:'uppercase', color:'rgba(255,255,255,0.85)',
                      margin:0, marginBottom:32 }}>
            {eyebrow2}
          </p>

          <h1 style={{ fontFamily:"Georgia,'Times New Roman',serif",
                       lineHeight:0.96, letterSpacing:'-0.025em', fontWeight:400,
                       margin:0, marginBottom:28,
                       fontSize:'clamp(58px, 5.2vw, 86px)' }}>
            {headlineLines.map(line => (
              <span key={line} style={{ display:'block', whiteSpace:'nowrap' }}>{line}</span>
            ))}
          </h1>

          <div style={{ width:130, height:1, background:'rgba(255,255,255,0.85)', marginBottom:32 }} />

          <div style={{ marginBottom:24 }}>
            {specs1.map(s => (
              <p key={s} style={{ fontSize:15, lineHeight:1.55, letterSpacing:'0.08em',
                                  textTransform:'uppercase', margin:0,
                                  color:'rgba(255,255,255,0.88)' }}>{s}</p>
            ))}
          </div>
          <div style={{ marginBottom:28 }}>
            {specs2.map(s => (
              <p key={s} style={{ fontSize:15, lineHeight:1.55, letterSpacing:'0.08em',
                                  textTransform:'uppercase', margin:0,
                                  color:'rgba(255,255,255,0.88)' }}>{s}</p>
            ))}
          </div>
          <p style={{ fontSize:15, letterSpacing:'0.08em', textTransform:'uppercase',
                      color:'rgba(255,255,255,0.88)', margin:0 }}>
            AVAILABLE NOW.
          </p>
        </div>

        {/* Right product links (Shop All only) */}
        {productLinks?.map(link => (
          <Link key={link.href} href={link.href}
            style={{
              position: 'absolute', zIndex: 2,
              textDecoration: 'none', color: 'rgba(255,255,255,0.92)',
              ...link.desktopStyle,
            }}
            className="group"
          >
            <p style={{ fontSize:14, lineHeight:1.55, letterSpacing:'0.07em',
                        textTransform:'uppercase', margin:0, fontWeight:300 }}>
              {link.name}
            </p>
            <p style={{ fontSize:14, lineHeight:1.55, letterSpacing:'0.07em',
                        textTransform:'uppercase', margin:0, fontWeight:300 }}>
              {link.price}
            </p>
            <p style={{ fontSize:14, lineHeight:1.55, letterSpacing:'0.07em',
                        textTransform:'uppercase', marginTop:6, fontWeight:300,
                        display:'flex', alignItems:'center', gap:6 }}>
              VIEW PIECE
              <span style={{ display:'inline-block', transition:'transform 200ms ease' }}
                className="group-hover:[transform:translateX(4px)]">→</span>
            </p>
          </Link>
        ))}

        {/* ── Single product link for Hoodies/Sweatpants desktop ── */}
        {!productLinks && (
          <div style={{
            position: 'absolute', zIndex: 2,
            right: 'clamp(48px,7vw,120px)', top: '38%',
            textDecoration: 'none', color: 'rgba(255,255,255,0.92)',
          }} />
        )}
      </section>

      {/* ── MOBILE (≤ 900px) ─────────────────────────────────────────────── */}
      <section
        aria-label="Collection hero"
        className="lg:hidden"
        style={{
          position:    'relative',
          width:       '100%',
          aspectRatio: '941/1672',
          minHeight:   `calc(100svh - ${NAV_H}px)`,
          overflow:    'hidden',
          background:  '#080808',
          color:       '#fff',
        }}
      >
        {/* Mobile image */}
        <div style={{ position: 'absolute', inset: 0 }}>
          <Image
            src={mobileImage}
            alt={mobileAlt}
            fill priority sizes="100vw"
            style={{ objectFit:'cover', objectPosition:'center top' }}
          />
        </div>

        {/* Left shade */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background:
            'linear-gradient(90deg,rgba(0,0,0,0.78) 0%,rgba(0,0,0,0.44) 40%,rgba(0,0,0,0.10) 68%,rgba(0,0,0,0) 100%)',
        }} />

        {/* Mobile copy — moved high: top: clamp(112px,17svh,158px) */}
        <div style={{
          position: 'absolute',
          zIndex:   3,
          left:     24,
          right:    20,
          top:      'clamp(112px, 17svh, 158px)',
          maxWidth: 'min(66vw, 390px)',
        }}>
          <p style={{ fontSize:13, lineHeight:1.5, letterSpacing:'0.16em',
                      textTransform:'uppercase', margin:0,
                      color:'rgba(255,255,255,0.85)' }}>
            {eyebrow1}
          </p>
          <p style={{ fontSize:13, lineHeight:1.5, letterSpacing:'0.16em',
                      textTransform:'uppercase', margin:0, marginBottom:32,
                      color:'rgba(255,255,255,0.85)' }}>
            {eyebrow2}
          </p>

          <h1 style={{ fontFamily:"Georgia,'Times New Roman',serif",
                       fontSize:'clamp(42px, 11.2vw, 58px)',
                       lineHeight:0.96, letterSpacing:'-0.025em', fontWeight:400,
                       margin:0 }}>
            {headlineLines.map(line => (
              <span key={line} style={{ display:'block', whiteSpace:'nowrap' }}>{line}</span>
            ))}
          </h1>

          <div style={{ width:76, height:1, background:'rgba(255,255,255,0.9)',
                        margin:'30px 0' }} />

          <div style={{ marginBottom:20 }}>
            {specs1.map(s => (
              <p key={s} style={{ fontSize:'clamp(13px,3.7vw,16px)', lineHeight:1.48,
                                  letterSpacing:'0.11em', textTransform:'uppercase',
                                  margin:0, color:'rgba(255,255,255,0.88)' }}>{s}</p>
            ))}
          </div>
          <div style={{ marginBottom:20 }}>
            {specs2.map(s => (
              <p key={s} style={{ fontSize:'clamp(13px,3.7vw,16px)', lineHeight:1.48,
                                  letterSpacing:'0.11em', textTransform:'uppercase',
                                  margin:0, color:'rgba(255,255,255,0.88)' }}>{s}</p>
            ))}
          </div>
          <p style={{ fontSize:'clamp(13px,3.7vw,16px)', lineHeight:1.48,
                      letterSpacing:'0.11em', textTransform:'uppercase',
                      margin:0, color:'rgba(255,255,255,0.88)' }}>
            AVAILABLE NOW.
          </p>
        </div>
      </section>

      {/* Mobile product links — dark continuation below hero */}
      {productLinks && productLinks.length > 0 && (
        <div className="lg:hidden"
          style={{ padding:'42px 28px 64px', background:'#080808' }}>
          {productLinks.map((link, i) => (
            <Link key={link.href} href={link.href}
              style={{
                display:'block', padding:'22px 0',
                color:'#fff', textDecoration:'none',
                marginTop: i > 0 ? 18 : 0,
                borderTop: i > 0 ? '1px solid rgba(255,255,255,0.1)' : 'none',
              }}>
              <p style={{ fontSize:13, letterSpacing:'0.16em', textTransform:'uppercase',
                          margin:0, marginBottom:4, fontWeight:300 }}>{link.name}</p>
              <p style={{ fontSize:13, letterSpacing:'0.08em', textTransform:'uppercase',
                          margin:0, marginBottom:8,
                          color:'rgba(255,255,255,0.65)' }}>{link.price}</p>
              <p style={{ fontSize:12, letterSpacing:'0.12em', textTransform:'uppercase',
                          margin:0, color:'rgba(255,255,255,0.75)',
                          display:'flex', alignItems:'center', gap:6 }}>
                VIEW PIECE →
              </p>
            </Link>
          ))}
        </div>
      )}

      {/* Mobile single-product link for Hoodies/Sweatpants */}
      {!productLinks && (
        <MobileSingleProductLink headlineLines={headlineLines} />
      )}
    </>
  )
}

// On Hoodies/Sweatpants mobile: show a single "VIEW PIECE →" below the hero
function MobileSingleProductLink({ headlineLines }: { headlineLines: string[] }) {
  const isHoodie = headlineLines[0] === 'STRUCTURE'
  const href  = isHoodie ? '/products/kvrn-phantom-hoodie' : '/products/kvrn-phantom-sweatpants'
  const name  = isHoodie ? 'HEAVYWEIGHT HOODIE' : 'HEAVYWEIGHT SWEATPANTS'

  return (
    <div className="lg:hidden" style={{ padding:'0 28px 64px', background:'#080808' }}>
      <Link href={href} style={{
        display:'block', padding:'28px 0',
        color:'#fff', textDecoration:'none',
      }}>
        <p style={{ fontSize:13, letterSpacing:'0.16em', textTransform:'uppercase',
                    margin:0, marginBottom:4, fontWeight:300 }}>{name}</p>
        <p style={{ fontSize:13, letterSpacing:'0.08em', textTransform:'uppercase',
                    margin:0, marginBottom:8, color:'rgba(255,255,255,0.65)' }}>$80</p>
        <p style={{ fontSize:12, letterSpacing:'0.12em', textTransform:'uppercase',
                    margin:0, color:'rgba(255,255,255,0.75)',
                    display:'flex', alignItems:'center', gap:6 }}>
          VIEW PIECE →
        </p>
      </Link>
    </div>
  )
}
