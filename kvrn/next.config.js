/** @type {import('next').NextConfig} */
const nextConfig = {
  // ── Image optimisation ──────────────────────────────────────────────────────
  // Cloudflare Workers (OpenNext) has no /_next/image optimiser here, and `unoptimized: true` made next/image serve the ORIGINAL
  // file at every size (a half-width product card on a phone fetched a 1.3-5 MB image). Instead a custom loader points static
  // images at pre-built WebP renditions (scripts/generate-image-renditions.mjs -> public/images-r/<width>/, listed in
  // lib/image-renditions.generated.json). Anything without a rendition (R2 /media/ assets, remote URLs, small files) is served as-is.
  images: {
    loader:     'custom',
    loaderFile: './lib/image-loader.ts',
  },

  // ── Strict mode ─────────────────────────────────────────────────────────────
  reactStrictMode: true,

  // ── Security headers ────────────────────────────────────────────────────────
  // Applied at the Next.js level. Cloudflare can add additional headers.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options',          value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options',   value: 'nosniff' },
          { key: 'Referrer-Policy',          value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',       value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // 1-year cache on hashed static assets
        source: '/_next/static/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        // Responsive renditions of public images (regenerated only when an original changes)
        source: '/images-r/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=604800, stale-while-revalidate=86400' },
        ],
      },
      {
        // Cache public images for 7 days
        source: '/images/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=604800, stale-while-revalidate=86400' },
        ],
      },
    ]
  },

  // ── Redirects ───────────────────────────────────────────────────────────────
  async redirects() {
    return [
      // Normalise old URL patterns if they ever change
      { source: '/faq',         destination: '/support/faq',               permanent: true },
      { source: '/returns',     destination: '/support/shipping-returns',   permanent: true },
      { source: '/track',       destination: '/support/track',              permanent: true },
      { source: '/size-guide',  destination: '/support/size-guide',         permanent: true },
    ]
  },
}

module.exports = nextConfig
