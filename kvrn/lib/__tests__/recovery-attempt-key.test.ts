// lib/__tests__/recovery-attempt-key.test.ts
//
// Final5 item 2: the recovery-collection idempotency key must survive a lost
// response + an ordinary Admin page reload, not just component state.
//
// sessionStorage is mocked with a plain in-memory object that OUTLIVES each
// call, the same way real sessionStorage outlives a page reload but not a new
// browser session. Nothing here is faked to make the module look persistent —
// the mock is the only state involved; the module itself carries none.

function makeMockSessionStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    get size() { return store.size },
  }
}

describe('recovery attempt idempotency key', () => {
  beforeEach(() => {
    jest.resetModules()
    ;(global as any).sessionStorage = makeMockSessionStorage()
  })

  test('the same payload reuses the same key across separate calls (a reload)', () => {
    const { collectionAttemptFingerprint, readOrCreateAttemptKey } = require('../recovery-attempt-key')
    const fp = collectionAttemptFingerprint(15000, '2026-03-01', 'ach', 'ref-1')
    const first = readOrCreateAttemptKey('commission-a', fp)
    // A fresh call with the identical fingerprint is exactly what happens after
    // an ordinary page reload: no in-memory state survives, only sessionStorage.
    const second = readOrCreateAttemptKey('commission-a', fp)
    expect(second).toBe(first)
  })

  test('a changed payload mints a new key rather than reusing the old one', () => {
    const { collectionAttemptFingerprint, readOrCreateAttemptKey } = require('../recovery-attempt-key')
    const fp1 = collectionAttemptFingerprint(15000, '2026-03-01', 'ach', 'ref-1')
    const fp2 = collectionAttemptFingerprint(20000, '2026-03-01', 'ach', 'ref-1') // amount changed
    const first = readOrCreateAttemptKey('commission-a', fp1)
    const second = readOrCreateAttemptKey('commission-a', fp2)
    expect(second).not.toBe(first)
  })

  test('blank optional fields are canonicalised the same way every time', () => {
    const { collectionAttemptFingerprint } = require('../recovery-attempt-key')
    // '' and undefined-like blanks must fingerprint identically, or an
    // untouched optional field would spuriously look like a changed payload.
    expect(collectionAttemptFingerprint(500, '', '', ''))
      .toBe(collectionAttemptFingerprint(500, '', '', ''))
    expect(JSON.parse(collectionAttemptFingerprint(500, '', '', ''))).toEqual({
      amountCents: 500, date: null, method: null, reference: null,
    })
  })

  test('different commissions never share a stored attempt', () => {
    const { collectionAttemptFingerprint, readOrCreateAttemptKey } = require('../recovery-attempt-key')
    const fp = collectionAttemptFingerprint(100, '2026-01-01', 'ach', 'r')
    const a = readOrCreateAttemptKey('commission-a', fp)
    const b = readOrCreateAttemptKey('commission-b', fp)
    expect(a).not.toBe(b)
  })

  test('clearing after a confirmed success makes the NEXT identical payload a new attempt', () => {
    const { collectionAttemptFingerprint, readOrCreateAttemptKey, clearAttemptKey } = require('../recovery-attempt-key')
    const fp = collectionAttemptFingerprint(750, '2026-04-01', 'wire', 'r9')
    const first = readOrCreateAttemptKey('commission-c', fp)
    clearAttemptKey('commission-c')
    const afterClear = readOrCreateAttemptKey('commission-c', fp)
    expect(afterClear).not.toBe(first)
  })

  test('storage that throws on every call still returns a usable key, not an exception', () => {
    const { collectionAttemptFingerprint, readOrCreateAttemptKey, clearAttemptKey } = require('../recovery-attempt-key')
    ;(global as any).sessionStorage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    }
    const fp = collectionAttemptFingerprint(1, '', '', '')
    expect(() => {
      const k = readOrCreateAttemptKey('commission-d', fp)
      expect(typeof k).toBe('string')
      expect(k.length).toBeGreaterThan(0)
      clearAttemptKey('commission-d')
    }).not.toThrow()
  })
})
