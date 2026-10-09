import { calculateStoreCredit, type CreditLedgerEvent } from '../store-credit-domain'
const issue: CreditLedgerEvent = {type:'issue',idempotencyKey:'return:1',amountCents:5000,approvedReturnId:'r1'}
const hold: CreditLedgerEvent = {type:'hold',idempotencyKey:'hold:1',amountCents:3000,holdId:'h1'}
test('issue, hold, release and capture preserve cents and liabilities',()=>{
 expect(calculateStoreCredit([issue,hold]).availableCents).toBe(2000)
 expect(calculateStoreCredit([issue,hold,{type:'release',idempotencyKey:'release:1',amountCents:3000,holdId:'h1'}]).availableCents).toBe(5000)
 expect(calculateStoreCredit([issue,hold,{type:'capture',idempotencyKey:'capture:1',amountCents:3000,holdId:'h1',orderId:'o1'}]).outstandingCents).toBe(2000)
})
test('repeated idempotency key is a no-op only when payload matches',()=>{
 expect(calculateStoreCredit([issue,issue]).issuedCents).toBe(5000)
 expect(()=>calculateStoreCredit([issue,{...issue,amountCents:9000}])).toThrow('IDEMPOTENCY_CONFLICT')
})
test('same approved return cannot issue again with another event key',()=>{
 expect(()=>calculateStoreCredit([issue,{...issue,idempotencyKey:'return:2'}])).toThrow('DUPLICATE_RETURN_CREDIT')
})
test('holds never overdraw or double spend',()=>{
 expect(()=>calculateStoreCredit([issue,hold,{...hold,idempotencyKey:'hold:2',holdId:'h2'}])).toThrow('INSUFFICIENT_CREDIT')
})
test('cannot capture unknown or mismatched reservations',()=>{
 expect(()=>calculateStoreCredit([issue,{type:'capture',idempotencyKey:'capture:1',amountCents:1000,holdId:'h1',orderId:'o1'}])).toThrow('UNKNOWN_CREDIT_HOLD')
 expect(()=>calculateStoreCredit([issue,hold,{type:'capture',idempotencyKey:'capture:1',amountCents:2000,holdId:'h1',orderId:'o1'}])).toThrow('CREDIT_HOLD_MISMATCH')
})
