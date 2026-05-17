/** @type {import('next').NextConfig} */
const nextConfig = {
  // ── Image optimisation ──────────────────────────────────────────────────────
  // Cloudflare Workers (via OpenNext) handles image serving.
  // Set unoptimized: false to let OpenNext/Cloudflare optimise.
  // Switch to unoptimized: true ONLY if using static export (output: 'export').
  images: {
    unoptimized: false,
    formats:     ['image/avif', 'image/webp'],
    // Add external image domains here if using a CDN or external images:
    // remotePatterns: [{ protocol: 'https', hostname: 'your-cdn.com' }],
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
