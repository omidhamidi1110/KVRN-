/** Offline tests: no Neon DB or external provider is called. */
jest.mock('../db', () => ({ sql: jest.fn() }))
import { sql } from '../db'
import { suppressMarketingEmailFromSupport, getVerifiedResendOptIn, getMarketingSyncState } from '../marketing-subscribers'
const query = sql as unknown as jest.Mock
const id = '123e4567-e89b-42d3-a456-426614174000'
const statement = (n: number) => (query.mock.calls[n]?.[0] as TemplateStringsArray).join('?')
beforeEach(() => query.mockReset())

describe('Support opt-out is suppression-only', () => {
  test('persists suppression for an address not already in marketing list', async () => {
    query.mockResolvedValueOnce([{id}]).mockResolvedValueOnce([])
    await suppressMarketingEmailFromSupport('  TEST@EXAMPLE.INVALID  ')
    expect(query).toHaveBeenCalledTimes(2)
    expect(statement(0)).toContain("VALUES(?,'unsubscribed','manual_admin'")
    expect(statement(0)).toContain("status='unsubscribed'")
    expect(statement(0)).not.toContain("status='subscribed'")
    expect(query.mock.calls[0]).toContain('test@example.invalid')
    expect(statement(1)).toContain('marketing_email_consent_events')
  })
  test('rejects invalid email without a database write', async () => {
    await expect(suppressMarketingEmailFromSupport('bad string')).rejects.toThrow('INVALID_EMAIL')
    expect(query).not.toHaveBeenCalled()
  })
  test('never claims success when no suppression record was stored', async () => {
    query.mockResolvedValueOnce([])
    await expect(suppressMarketingEmailFromSupport('test@example.invalid')).rejects.toThrow('SUPPRESSION_NOT_SAVED')
  })
})

describe('Resend consent-recheck', () => {
  test('checks local consent evidence before external opt-in', async () => {
    query.mockResolvedValueOnce([])
    expect(await getVerifiedResendOptIn(id)).toBeNull()
    expect(statement(0)).toContain("e.event_type = 'affirmative_checkbox'")
    expect(statement(0)).toContain("e.event_type = 'unsubscribed'")
    expect(statement(0)).toContain("ms.status = 'subscribed'")
  })
  test('returns current status, not earlier cached state', async () => {
    query.mockResolvedValueOnce([{status:'unsubscribed'}])
    expect(await getMarketingSyncState(id)).toBe('unsubscribed')
  })
})
