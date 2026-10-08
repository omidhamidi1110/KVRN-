import { readLimitedJson, readLimitedText } from '../limited-json-request'

const post = (data: string, headers: Record<string, string> = {}) =>
  new Request('https://kvrn.test/api/x', { method: 'POST', body: data, headers })

describe('bounded public request reading', () => {
  test('parses valid JSON and preserves signed webhook text', async () => {
    const body = '{"qty":1,"sku":"KVRN"}'
    expect(await readLimitedJson(post(body), 100)).toEqual({ ok: true, value: { qty:1, sku:'KVRN' } })
    expect(await readLimitedText(post(body), 100)).toEqual({ ok: true, value: body })
  })
  test('rejects body beyond limit, even without Content-Length', async () => {
    const out = await readLimitedJson(post(' '.repeat(200)), 100)
    expect(out).toMatchObject({ ok: false, status: 413 })
  })
  test('rejects a lying Content-Length header', async () => {
    const out = await readLimitedText(post(' '.repeat(200), { 'content-length': '1' }), 100)
    expect(out).toMatchObject({ ok: false, status: 413 })
  })
  test('rejects malformed JSON and bogus lengths', async () => {
    expect(await readLimitedJson(post('{'), 100)).toMatchObject({ ok: false, status: 400 })
    expect(await readLimitedJson(post('{}', { 'content-length':'-1' }), 100)).toMatchObject({ ok: false, status:400 })
  })
  test('rejects invalid UTF-8', async () => {
    const bad = new Request('https://kvrn.test/x', { method: 'POST', body: new Uint8Array([0xff, 0xfe]) })
    expect(await readLimitedText(bad, 100)).toMatchObject({ ok:false, status:400 })
  })
})
