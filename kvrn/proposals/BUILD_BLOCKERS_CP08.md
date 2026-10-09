# CP08 build blockers (found 2026-10-08 while running `next build` locally)

`next build` (and therefore the OpenNext build) **fails to compile** on the CP08 source for four independent reasons. Two are in Claude-owned files and are **fixed** in this branch; two are in ChatGPT-owned files and are only **proposed** here (not edited).

| # | File | Error | Owner | Status |
|---|---|---|---|---|
| 1 | `components/admin/content/forms.tsx:71` | ESLint **error** `react/no-unescaped-entities` (`draft's` in JSX) — lint errors fail `next build` | Claude | **Fixed** (`&apos;`) |
| 2 | `app/api/admin/content/policy-audit/route.ts:19` | TS2345 `Record<string, any>[]` not assignable to `PublishedContentAuditRow[]` | Claude (CMS API folder) | **Fixed** (typed cast) |
| 3 | `lib/store-credit-domain.ts`, `lib/store-credit-ledger-integrity.ts`, `lib/store-credit-proposal.ts` (8 sites) | TS2737 *BigInt literals are not available when targeting lower than ES2020* — `tsconfig.json` has `"target": "ES2017"` | ChatGPT (store credit) / shared `tsconfig.json` | **Proposed** — see patch A |
| 4 | `lib/resend-webhook-suppression.ts:40,42` | TS2769/TS2345 `Uint8Array<ArrayBufferLike>` not assignable to `BufferSource` (newer TypeScript lib typings) | ChatGPT (Resend) | **Proposed** — see patch B |

Also failing type-check only inside tests (not part of `next build`): `lib/__tests__/admin-mutation-safety.test.ts` (3), `lib/__tests__/marketing-suppression.test.ts` (1) — same BigInt/target cause is likely; re-check after patch A.

## Patch A — `tsconfig.json` (shared; one line)
```diff
-    "target": "ES2017"
+    "target": "ES2020"
```
Type-check target only; Next/SWC still does the real transpile, and Cloudflare Workers support BigInt. This clears all of #3. (Alternative: replace `0n`-style literals with `BigInt(0)`, a wider edit in financial code — not recommended.)

## Patch B — `lib/resend-webhook-suppression.ts`
```diff
-      const key=await crypto.subtle.importKey('raw',keyData,{name:'HMAC',hash:'SHA-256'},false,['verify'])
+      const key=await crypto.subtle.importKey('raw',keyData as unknown as BufferSource,{name:'HMAC',hash:'SHA-256'},false,['verify'])
       for(const bytes of signatures){
-        if(await crypto.subtle.verify('HMAC',key,bytes,signed))return id
+        if(await crypto.subtle.verify('HMAC',key,bytes as unknown as BufferSource,signed as unknown as BufferSource))return id
```
Type-only; no runtime change. (Verify against the exact TypeScript version in `package.json` before merging.)

## How this was found
`bash /home/claude/kvrn-tools/prod-build.sh`-style build in a scratch copy (patches A and B applied to the **copy only**). The Claude branch itself keeps ChatGPT's files byte-identical to CP08.
