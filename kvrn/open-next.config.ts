// ─── OpenNext Cloudflare Workers Configuration ─────────────────────────────────
//
// This file configures how OpenNext deploys the Next.js app to Cloudflare Workers.
//
// ACTIVATION (run these commands once):
//   npm install --save-dev @opennextjs/cloudflare wrangler
//   Then uncomment the import and config block below.
//
// DEPLOY:
//   npm run cf:build   →  builds with OpenNext
//   npm run deploy     →  builds + deploys to Cloudflare Workers
//
// DOCS: https://opennext.js.org/cloudflare

// Uncomment once @opennextjs/cloudflare is installed:
// import type { OpenNextConfig } from '@opennextjs/cloudflare'
//
// const config: OpenNextConfig = {
//   default: {
//     override: {
//       wrapper:         'cloudflare-node',
//       converter:       'edge',
//       incrementalCache:'fetch',
//       tagCache:        'dummy',
//       queue:           'dummy',
//     },
//   },
//   middleware: {
//     external: true,
//   },
// }
//
// export default config

const config = {
  default: {
    override: {
      wrapper:         'cloudflare-node',
      converter:       'edge',
      incrementalCache:'fetch',
      tagCache:        'dummy',
      queue:           'dummy',
    },
  },
  middleware: {
    external: true,
  },
}

export default config
