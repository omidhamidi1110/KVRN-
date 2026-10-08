import { Pool } from 'pg'

let pool: Pool | undefined

function createLocalPool(url: string): Pool {
  if (!process.env.TEST_DATABASE_URL ||
      url !== process.env.TEST_DATABASE_URL ||
      process.env.DATABASE_URL) {
    throw new Error('Refusing an unapproved test database')
  }

  const parsed = new URL(url)
  const localHosts = ['localhost', '127.0.0.1', '[::1]', '::1']

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !localHosts.includes(parsed.hostname.toLowerCase()) ||
      decodeURIComponent(parsed.pathname) !== '/reservationtest') {
    throw new Error('Reservation tests require a local reservationtest database')
  }

  const socketHost = parsed.searchParams.get('host')
  if (socketHost &&
      !socketHost.startsWith('/') &&
      !localHosts.includes(socketHost.toLowerCase())) {
    throw new Error('Refusing a non-local PostgreSQL host')
  }

  const port = Number(parsed.port || parsed.searchParams.get('port') || 5432)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid test database port')
  }

  return new Pool({
    host: socketHost || parsed.hostname,
    port,
    user: decodeURIComponent(parsed.username) || 'postgres',
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: 'reservationtest',
    max: 10,
    allowExitOnIdle: true,
  })
}

export function localTestNeon(url: string) {
  if (!process.env.TEST_DATABASE_URL ||
      url !== process.env.TEST_DATABASE_URL ||
      process.env.DATABASE_URL) {
    throw new Error('Refusing an unapproved test database')
  }

  const safePool = pool ?? (pool = createLocalPool(url))

  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = ''
    strings.forEach((part, i) => {
      text += part
      if (i < values.length) text += '$' + (i + 1)
    })
    const result = await safePool.query(text, values)
    return result.rows
  }
}
