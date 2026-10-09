import {deriveStoreCreditAccountKey,normalizeCreditAccountEmail} from '../store-credit-identity'
const pepper='a'.repeat(64)
test('email normalized but aliases preserved',()=>{
 expect(normalizeCreditAccountEmail(' Alice+shop@Example.Com ')).toBe('alice+shop@example.com')
 expect(normalizeCreditAccountEmail('alice@example.com')).not.toBe(normalizeCreditAccountEmail('alice+shop@example.com'))
})
test('key is keyed, stable, and not raw email',async()=>{
 const a=await deriveStoreCreditAccountKey('Alice@example.com',pepper)
 expect(a).toMatch(/^[0-9a-f]{64}$/)
 expect(a).toBe(await deriveStoreCreditAccountKey('alice@EXAMPLE.com',pepper))
 expect(a).not.toBe(await deriveStoreCreditAccountKey('alice@example.com','b'.repeat(64)))
 expect(a).not.toContain('alice')
})
test('weak pepper and invalid addresses rejected',async()=>{
 await expect(deriveStoreCreditAccountKey('x@y.com','short')).rejects.toThrow('INVALID_CREDIT_ACCOUNT_SECRET')
 await expect(deriveStoreCreditAccountKey('invalid',pepper)).rejects.toThrow('INVALID_EMAIL')
})
