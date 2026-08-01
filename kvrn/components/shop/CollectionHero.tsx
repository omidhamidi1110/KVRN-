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
  productLinks?: ProductLink[]  // desktop: multiple right-side links (Shop All)
  desktopLink?:  ProductLink    // desktop: single right-side link (Hoodies/Sweatpants)
  mobileLinks?:  ProductLink[]  // mobile links inside hero
}

export function CollectionHero({
  desktopImage, desktopAlt,
  mobileImage,  mobileAlt,
  eyebrow1, eyebrow2,
  headlineLines,
  specs1, specs2,
  productLinks,
  desktopLink,
  mobileLinks,
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
          minHeight:  '100svh',
          height:     'auto',
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

        {/* Single desktop product link for Hoodies/Sweatpants */}
        {desktopLink && (
          <Link href={desktopLink.href}
            style={{
              position:'absolute', zIndex:5,
              right:'clamp(42px,4.6vw,82px)',
              width:'clamp(210px,17vw,265px)',
              textDecoration:'none', color:'rgba(255,255,255,0.92)',
              ...desktopLink.desktopStyle,
            }}
            className="group"
          >
            <p style={{ fontSize:'clamp(11px,0.95vw,14px)', lineHeight:1.55,
                        letterSpacing:'0.07em', textTransform:'uppercase',
                        margin:0, fontWeight:300, whiteSpace:'nowrap' }}>
              {desktopLink.name}
            </p>
            <p style={{ fontSize:'clamp(11px,0.95vw,14px)', lineHeight:1.55,
                        letterSpacing:'0.07em', textTransform:'uppercase',
                        margin:0, fontWeight:300 }}>
              {desktopLink.price}
            </p>
            <p style={{ fontSize:'clamp(11px,0.95vw,14px)', lineHeight:1.55,
                        letterSpacing:'0.07em', textTransform:'uppercase',
                        marginTop:6, fontWeight:300,
                        display:'flex', alignItems:'center', gap:6 }}>
              VIEW PIECE
              <span style={{ display:'inline-block', transition:'transform 200ms ease' }}
                className="group-hover:[transform:translateX(4px)]">→</span>
            </p>
          </Link>
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
          minHeight:   '100svh',
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
          paddingBottom: mobileLinks && mobileLinks.length >= 2 ? 220 : 180,
        }}>
          <p style={{ fontSize:'clamp(11px,3vw,13px)', lineHeight:1.45, letterSpacing:'0.15em',
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
                       fontSize:'clamp(38px, 10.4vw, 50px)',
                       lineHeight:0.96, letterSpacing:'-0.025em', fontWeight:400,
                       margin:0 }}>
            {headlineLines.map(line => (
              <span key={line} style={{ display:'block', whiteSpace:'nowrap' }}>{line}</span>
            ))}
          </h1>

          <div style={{ width:76, height:1, background:'rgba(255,255,255,0.9)',
                        margin:'25px 0' }} />

          <div style={{ marginBottom:20 }}>
            {specs1.map(s => (
              <p key={s} style={{ fontSize:'clamp(11px,3.15vw,13px)', lineHeight:1.48,
                                  letterSpacing:'0.10em', textTransform:'uppercase',
                                  margin:0, color:'rgba(255,255,255,0.88)' }}>{s}</p>
            ))}
          </div>
          <div style={{ marginBottom:20 }}>
            {specs2.map(s => (
              <p key={s} style={{ fontSize:'clamp(11px,3.15vw,13px)', lineHeight:1.48,
                                  letterSpacing:'0.10em', textTransform:'uppercase',
                                  margin:0, color:'rgba(255,255,255,0.88)' }}>{s}</p>
            ))}
          </div>
          <p style={{ fontSize:'clamp(11px,3.15vw,13px)', lineHeight:1.48,
                      letterSpacing:'0.10em', textTransform:'uppercase',
                      margin:0, color:'rgba(255,255,255,0.88)' }}>
            AVAILABLE NOW.
          </p>


        </div>

        {/* Mobile product selector rows — compact, anchored at hero bottom */}
        {mobileLinks && mobileLinks.length > 0 && (
          <div style={{
            position:'absolute', zIndex:5,
            left:24, right:24,
            bottom:'calc(16px + env(safe-area-inset-bottom))',
          }}>
            {mobileLinks.map((link) => (
              <Link key={link.href} href={link.href}
                style={{
                  display:'flex', alignItems:'center', justifyContent:'space-between',
                  gap:14, padding:'15px 0',
                  color:'#fff', textDecoration:'none',
                  borderTop:'1px solid rgba(255,255,255,0.18)',
                }}>
                <span>
                  <span style={{ display:'block', fontSize:10, lineHeight:1.35,
                                 letterSpacing:'0.12em', textTransform:'uppercase',
                                 whiteSpace:'nowrap' }}>
                    {link.name}
                  </span>
                  <span style={{ display:'block', marginTop:5, fontSize:10,
                                 letterSpacing:'0.09em' }}>
                    {link.price}
                  </span>
                </span>
                <span style={{ flexShrink:0, fontSize:10, letterSpacing:'0.13em',
                               textTransform:'uppercase', whiteSpace:'nowrap' }}>
                  VIEW →
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
