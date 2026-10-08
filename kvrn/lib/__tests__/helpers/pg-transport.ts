// lib/__tests__/helpers/pg-transport.ts
//
// TRANSPORT SHIM ONLY.
//
// lib/db.ts uses the Neon serverless driver, which speaks HTTP to Neon and
// cannot reach a local PostgreSQL server. This provides a tagged-template `sql`
// with the same call signature, backed by node-postgres against a throwaway
// local database.
//
// WHAT IS REAL IN TESTS THAT USE THIS:
//   the route handlers, the service layer, every SQL statement, every migration,
//   every constraint, trigger and PL/pgSQL function, and the data.
//
// WHAT IS SUBSTITUTED:
//   the network transport, and nothing else. This is the same category as
//   mocking Stripe's HTTP client: an external boundary, not application logic.

import { Client } from 'pg'

export type SqlFn = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>)
  & { unsafe?: (text: string) => Promise<unknown[]> }

/**
 * Held on globalThis, not in module scope.
 *
 * jest.resetModules() gives a re-imported route handler a FRESH copy of this
 * module, which would otherwise have no connection — the handler would then fail
 * with "pg transport not connected" and be misread as an application bug.
 */
const G = globalThis as any
G.__kvrnPgClient ??= null
function getClient(): Client | null { return G.__kvrnPgClient }
function setClient(c: Client | null) { G.__kvrnPgClient = c }

export async function connectPg(database: string) {
  // Only the two dedicated legacy integration-test databases are allowed.
  if (![
    'httptest',
    'webhooktest',
    `kvrn_ga4mp_${process.pid}`,
    `kvrn_funnelmp_${process.pid}`,
  ].includes(database)) {
    throw new Error('Refusing an unapproved test database')
  }

  const rawUrl = process.env.TEST_DATABASE_URL

  if (!rawUrl || process.env.DATABASE_URL || process.env.NEON_DATABASE_URL) {
    throw new Error('Tests require an isolated TEST_DATABASE_URL')
  }

  const parsed = new URL(rawUrl)

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Invalid PostgreSQL test URL')
  }

  const localHosts = ['localhost', '127.0.0.1', '[::1]', '::1']

  if (!localHosts.includes(parsed.hostname.toLowerCase())) {
    throw new Error('Refusing a non-local PostgreSQL server')
  }

  if (decodeURIComponent(parsed.pathname) !== '/reservationtest') {
    throw new Error('Unexpected test database configuration')
  }

  const socketHost = parsed.searchParams.get('host')

  if (socketHost && socketHost !== '/tmp') {
    throw new Error('Unapproved PostgreSQL socket')
  }

  const port = Number(
    parsed.port || parsed.searchParams.get('port') || 5432
  )

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid test PostgreSQL port')
  }

  const c = new Client({
    host: socketHost || parsed.hostname,
    port,
    user: decodeURIComponent(parsed.username) || 'postgres',
    password: parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined,
    database,
    ssl: false,
  })

  await c.connect()
  setClient(c)
  return c
}

export async function disconnectPg() {
  const c = getClient()
  if (c) { await c.end(); setClient(null) }
}

/** Raw escape hatch for fixture setup. Not used by application code. */
export async function raw(text: string, params: unknown[] = []) {
  const c = getClient()
  if (!c) throw new Error('pg transport not connected')
  const r = await c.query(text, params)
  return r.rows
}

/**
 * Neon's tagged-template API rendered onto node-postgres.
 *
 * Neon interpolates values as $1..$n in order, which is exactly what pg expects,
 * so the SQL text the application wrote is sent verbatim.
 */
export const pgSql: SqlFn = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const c = getClient()
    if (!c) throw new Error('pg transport not connected')
    let text = ''
    strings.forEach((part, i) => {
      text += part
      if (i < values.length) text += `$${i + 1}`
    })
    const result = await c.query(text, values as any[])
    return result.rows
  },
  { unsafe: async (text: string) => raw(text) },
)

/**
 * Force the NEXT application query matching a pattern to fail.
 *
 * Used to prove fail-closed behaviour by making the real persistence write fail
 * at the transport layer, rather than by calling an error path directly.
 */
// Also on globalThis: a fault armed before jest.resetModules() must still be
// visible to the module copy the route handler ends up using.
G.__kvrnFail ??= { pattern: null as RegExp | null, once: false }

export function failNextMatching(pattern: RegExp, once = true) {
  G.__kvrnFail = { pattern, once }
}
export function clearFailures() { G.__kvrnFail = { pattern: null, once: false } }

export const pgSqlWithFaults: SqlFn = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const c = getClient()
    if (!c) throw new Error('pg transport not connected')
    let text = ''
    strings.forEach((part, i) => {
      text += part
      if (i < values.length) text += `$${i + 1}`
    })
    const f = G.__kvrnFail
    if (f?.pattern && f.pattern.test(text)) {
      if (f.once) G.__kvrnFail = { pattern: null, once: false }
      throw new Error('SIMULATED_TRANSPORT_FAILURE')
    }
    const result = await c.query(text, values as any[])
    return result.rows
  },
  { unsafe: async (text: string) => raw(text) },
)
