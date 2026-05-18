// ─── OpenNext Cloudflare Workers Configuration ─────────────────────────────────
// Deploy: npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy
// Docs:   https://opennext.js.org/cloudflare

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
