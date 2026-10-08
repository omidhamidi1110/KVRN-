import { Pool } from 'pg'

const EXPECTED =
  'postgresql://postgres@localhost:5433/reservationtest?host=/tmp'

const pool = new Pool({
  host: '/tmp',
  port: 5433,
  user: 'postgres',
  database: 'reservationtest',
  max: 10,
  allowExitOnIdle: true,
})

export function localTestNeon(url: string) {
  if (url !== EXPECTED || process.env.DATABASE_URL) {
    throw new Error('Refusing a non-isolated reservation test database')
  }

  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = ''
    strings.forEach((part, i) => {
      text += part
      if (i < values.length) text += '$' + (i + 1)
    })
    const result = await pool.query(text, values)
    return result.rows
  }
}
