import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import pg from 'pg'

const { Client } = pg
const fail = message => { throw new Error(`SAFE STOP: ${message}`) }

if (process.env.DATABASE_URL || process.env.NEON_DATABASE_URL)
  fail('Production database variables must be unset')

const raw = process.env.TEST_DATABASE_URL
const expectedDir = process.env.KVRN_TEST_DB_DATA_DIRECTORY

if (!raw || !expectedDir || !path.isAbsolute(expectedDir))
  fail('Test URL and expected PostgreSQL directory are required')

const u = new URL(raw)
const socket = u.searchParams.get('host')
const port = Number(u.port || u.searchParams.get('port') || 5432)
const github = process.env.GITHUB_ACTIONS === 'true'

// Explicit authorization is required for destructive test DB resets.
if (process.env.KVRN_CONFIRM_TEST_DB_RESET !== 'YES')
  fail('Explicit test database reset authorization required')

// Codespaces must use the dedicated isolated PostgreSQL cluster.
if (!github &&
    expectedDir !== path.join(os.homedir(), '.local', 'share', 'kvrn-audit2-pg16'))
  fail('Unapproved Codespaces database directory')


if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
    u.pathname !== '/reservationtest' ||
    !Number.isInteger(port) || port < 1 || port > 65535)
  fail('Invalid test database configuration')

if (github
  ? (socket || u.hostname !== '127.0.0.1' || port !== 5432)
  : (socket !== '/tmp' || u.hostname !== 'localhost' || port !== 5433))
  fail('Unapproved test PostgreSQL endpoint')

const config = {
  host: socket || u.hostname,
  port,
  user: decodeURIComponent(u.username) || 'postgres',
  password: decodeURIComponent(u.password) || undefined,
  ssl: false,
}

const dir = path.resolve('db/migrations')
const migrations = fs.readdirSync(dir)
  .filter(f => /^\d{3}_.*\.sql$/.test(f))
  .filter(f => Number(f.slice(0, 3)) <= 20)
  .sort()

if (migrations.length !== 20 ||
    migrations.some((f, i) => Number(f.slice(0, 3)) !== i + 1))
  fail('Migrations 001–020 are incomplete')

const sql25 = fs.readFileSync(
  path.join(dir, '025_preshipment_refund_cancellation.sql'), 'utf8'
)
const table = sql25.match(
  /CREATE TABLE IF NOT EXISTS order_cancellations\s*\([\s\S]*?^\);[ \t]*$/m
)
if (!table) fail('Cancellation table definition missing')

const admin = new Client({ ...config, database: 'postgres' })
await admin.connect()

try {
  const result = await admin.query('SHOW data_directory')
  if (result.rows[0].data_directory !== expectedDir)
    fail('Wrong PostgreSQL server — nothing changed')

  console.log('Verified isolated test PostgreSQL server')

  for (const name of ['httptest', 'webhooktest', 'reservationtest']) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${name}"`)

    const db = new Client({ ...config, database: name })
    try {
      await db.connect()
      for (const file of migrations)
        await db.query(fs.readFileSync(path.join(dir, file), 'utf8'))

      if (name === 'reservationtest')
        await db.query(table[0])

      console.log(`${name}: READY`)
    } finally {
      await db.end().catch(() => {})
    }
  }

  console.log('TEST_DATABASE_SETUP_PASSED')
} finally {
  await admin.end()
}
