'use client'

import Image from 'next/image'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────
interface ProductLink {
  name:  string
  price: string
  href:  string
  style: React.CSSProperties
}

interface CollectionHeroProps {
  // Desktop
  desktopImage: string
  desktopAlt:   string
  // Mobile
  mobileImage:  string
  mobileAlt:    string
  // Copy
  eyebrow1:     string
  eyebrow2:     string
  headline:     React.ReactNode   // can be JSX for line breaks
  specs1:       string[]
  specs2:       string[]
  available?:   string
  // Optional Shop All product links (desktop right + mobile below)
  productLinks?: ProductLink[]
}

const NAV_H = 92 // 36px bar + 56px nav — both fixed

export function CollectionHero({
  desktopImage, desktopAlt,
  mobileImage,  mobileAlt,
  eyebrow1, eyebrow2,
  headline, specs1, specs2,
  available = 'AVAILABLE NOW.',
  productLinks,
}: CollectionHeroProps) {
  return (
    <>
      {/* ════════════════ DESKTOP HERO (≥ 901px) ════════════════ */}
      <section
        aria-label="Collection hero"
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
        className="hidden lg:block"
      >
        {/* Hero image */}
        <Image
          src={desktopImage}
          alt={desktopAlt}
          fill
          priority
          sizes="100vw"
          style={{ objectFit: 'cover', objectPosition: 'center' }}
        />

        {/* Left-side gradient for text readability */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            background:
              'linear-gradient(90deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.38) 34%, rgba(0,0,0,0.04) 62%, rgba(0,0,0,0) 100%)',
          }}
        />

        {/* Left copy */}
        <div style={{
          position:  'absolute',
          left:      'clamp(48px, 4.5vw, 80px)',
          top:       '50%',
          transform: 'translateY(-46%)',
          maxWidth:  590,
          zIndex:    2,
        }}>
          {/* Eyebrow */}
          <p style={{ fontSize:15, letterSpacing:'0.14em', lineHeight:1.45, textTransform:'uppercase',
                      color:'rgba(255,255,255,0.85)', marginBottom:0 }}>
            {eyebrow1}
          </p>
          <p style={{ fontSize:15, letterSpacing:'0.14em', lineHeight:1.45, textTransform:'uppercase',
                      color:'rgba(255,255,255,0.85)', marginBottom:32 }}>
            {eyebrow2}
          </p>

          {/* Headline */}
          <h1 style={{ fontFamily:"Georgia,'Times New Roman',serif", fontSize:'clamp(58px,5.2vw,86px)',
                       lineHeight:0.96, letterSpacing:'-0.025em', fontWeight:400,
                       margin:0, marginBottom:28 }}>
            {headline}
          </h1>

          {/* Divider */}
          <div style={{ width:130, height:1, background:'rgba(255,255,255,0.85)', marginBottom:32 }} />

          {/* Specs block 1 */}
          <div style={{ marginBottom:24 }}>
            {specs1.map(s => (
              <p key={s} style={{ fontSize:15, lineHeight:1.55, letterSpacing:'0.08em',
                                  textTransform:'uppercase', margin:0,
                                  color:'rgba(255,255,255,0.88)' }}>{s}</p>
            ))}
          </div>

          {/* Specs block 2 */}
          <div style={{ marginBottom:28 }}>
            {specs2.map(s => (
              <p key={s} style={{ fontSize:15, lineHeight:1.55, letterSpacing:'0.08em',
                                  textTransform:'uppercase', margin:0,
                                  color:'rgba(255,255,255,0.88)' }}>{s}</p>
            ))}
          </div>

          <p style={{ fontSize:15, letterSpacing:'0.08em', textTransform:'uppercase',
                      color:'rgba(255,255,255,0.88)', margin:0 }}>
            {available}
          </p>
        </div>

        {/* Right product links (Shop All only) */}
        {productLinks?.map(link => (
          <Link
            key={link.href}
            href={link.href}
            style={{
              position:       'absolute',
              zIndex:         2,
              textDecoration: 'none',
              color:          'rgba(255,255,255,0.92)',
              ...link.style,
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
              <span
                style={{ display:'inline-block', transition:'transform 200ms ease' }}
                className="group-hover:[transform:translateX(4px)]"
              >→</span>
            </p>
          </Link>
        ))}
      </section>

      {/* ════════════════ MOBILE HERO (≤ 900px) ════════════════ */}
      <section
        aria-label="Collection hero"
        style={{
          position:   'relative',
          width:      '100%',
          aspectRatio:'941/1672',
          minHeight:  `calc(100svh - ${NAV_H}px)`,
          overflow:   'hidden',
          background: '#080808',
          color:      '#fff',
        }}
        className="lg:hidden"
      >
        {/* Mobile hero image */}
        <Image
          src={mobileImage}
          alt={mobileAlt}
          fill
          priority
          sizes="100vw"
          style={{ objectFit:'cover', objectPosition:'center top' }}
        />

        {/* Left-side shade */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0, pointerEvents:'none',
            background:
              'linear-gradient(90deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.44) 40%, rgba(0,0,0,0.10) 68%, rgba(0,0,0,0) 100%)',
          }}
        />

        {/* Mobile copy */}
        <div style={{
          position: 'absolute',
          zIndex:   2,
          left:     28,
          right:    24,
          top:      'clamp(170px, 26vh, 250px)',
          maxWidth: 'min(64vw, 390px)',
        }}>
          <p style={{ fontSize:13, lineHeight:1.5, letterSpacing:'0.16em',
                      textTransform:'uppercase', margin:0, color:'rgba(255,255,255,0.85)' }}>
            {eyebrow1}
          </p>
          <p style={{ fontSize:13, lineHeight:1.5, letterSpacing:'0.16em',
                      textTransform:'uppercase', margin:0, marginBottom:32,
                      color:'rgba(255,255,255,0.85)' }}>
            {eyebrow2}
          </p>

          <h1 style={{ fontFamily:"Georgia,'Times New Roman',serif",
                       fontSize:'clamp(44px,12.5vw,60px)', lineHeight:0.96,
                       letterSpacing:'-0.025em', fontWeight:400, margin:0 }}>
            {headline}
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
            {available}
          </p>
        </div>
      </section>

      {/* Mobile product links (Shop All only) — below hero, dark surface */}
      {productLinks && productLinks.length > 0 && (
        <div
          className="lg:hidden"
          style={{ padding:'42px 28px 64px', background:'#080808' }}
        >
          {productLinks.map((link, i) => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                display:'block', padding:'22px 0',
                color:'#fff', textDecoration:'none',
                marginTop: i > 0 ? 18 : 0,
                borderTop: i > 0 ? '1px solid rgba(255,255,255,0.1)' : 'none',
              }}
            >
              <p style={{ fontSize:13, letterSpacing:'0.16em', textTransform:'uppercase',
                          margin:0, marginBottom:4, fontWeight:300 }}>
                {link.name}
              </p>
              <p style={{ fontSize:13, letterSpacing:'0.08em', textTransform:'uppercase',
                          margin:0, marginBottom:8, color:'rgba(255,255,255,0.65)' }}>
                {link.price}
              </p>
              <p style={{ fontSize:12, letterSpacing:'0.12em', textTransform:'uppercase',
                          margin:0, color:'rgba(255,255,255,0.75)', display:'flex',
                          alignItems:'center', gap:6 }}>
                VIEW PIECE →
              </p>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
