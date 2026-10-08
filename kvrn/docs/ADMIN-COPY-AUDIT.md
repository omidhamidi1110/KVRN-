# Admin copy and visual audit (ui workstream)

Scope: the existing Admin pages, `AdminShell`, `FinancialUI` and `components/admin/ui/*`.
Not covered here (other workstreams): Orders, Affiliates, Products, Content, Abandoned checkouts, Media, System.

## Rules applied

- Page description: 2-8 words. Section description only when it changes what the user should do.
- Visible: current warnings and states (Exception, Incomplete, Failed, Unresolved, Unknown, Partial, Missing, destructive notices, "this does not create a backup").
- InfoTip: definitions, accounting and analytics method, units (cents / BPS), provider caveats, backup responsibilities.
- One status vocabulary (`STATUS_TONES`); `lib/admin-status.ts` maps raw strings; unmapped values stay neutral, never invented.
- Unknown money is never shown as $0 (`moneyOrUnknown` semantics unchanged).
- Words "authoritative", "deterministic", "canonical" are not used in rendered prose. One exception: the Financials order-contribution InfoTip keeps "Canonical order contribution = ..." because an existing test pins that sentence; it is inside a tooltip, not page copy.

## Per page

| Page | Description now | Kept visible | Moved to InfoTip | Shortened / reworded |
|---|---|---|---|---|
| Overview | Orders, fulfillment, and stock. | Low-stock / unfulfilled counts and statuses | - | Long intro removed; status words normalised |
| Inventory | Stock, reservations, and availability. | Out-of-stock and reserved warnings, destructive confirms | Definitions of reserved / available / on hand | Column headers shortened |
| Discounts | Codes and checkout offers. | Validation errors (inline notice replaces `alert()`) | Min-subtotal and stacking rules | Min-subtotal shows 2 decimals |
| Analytics | Funnel for consenting visitors. | Consent / sampling limits, "separate system" notice | GA comparison caveat, method notes | Chart captions shortened |
| Financials | Revenue, costs, and profit. | "Some costs are not yet reconciled", per-metric Incomplete / Partial flags | Order-contribution rule, tax scenario method, margin definitions | Intro and per-card sentences removed; tax scenario sub says "Known so far, not exact" when not reconciled |
| Shipping | Shipping revenue, carrier cost, and margin. | Missing-cost flags | Margin and promo-shipping method | Shortened |
| Product costs | Landed cost per production batch. | Missing-cost warnings | Landed-cost components | Shortened |
| Advertising | Media buying and creative production. | Unattributed spend flags | Attribution method | Shortened |
| Infrastructure | Provider costs, usage, and forecasts. | "Estimated and projected figures are forecasts, not invoices"; unit-mismatch warning | Cash vs recognised, cumulative usage, provider caveats | Shortened |
| Inventory value | FIFO value, receipts, and write-offs. | Unknown-cost layers, write-off confirms | FIFO method, valuation rules | Shortened |
| Returns | Returns affect stock and COGS, not revenue. | "Fee returned is unknown, not $0", "Refund split is unknown" | Allocation method | Shortened |
| Disputes | Chargebacks and their revenue impact. | Unresolved / open dispute states | "Never inferred" rule, fee treatment | Shortened |
| Reconciliation | Money checks against source records. | Exception / Incomplete / Failed per-state words | Scan method | Per-state wording uses fixed vocabulary |
| Expenses | Billed invoices and expected costs. | Packaging double-count warning (both forms), "expectations, not bills" notice, voided date / by / reason | Expected vs actual rule, service-period recognition, monthly-equivalent note | Delete obligation now asks for confirmation; void keeps a prompt for the required reason |
| SMS | Text-message opt-ins. | "Promotional sending is off - A2P approval pending." | What A2P 10DLC is | Intro paragraph replaced by one line |
| Backups | Backup and recovery status. | "Recording a backup does not create one", form notices ("does not create a backup", "does not restore anything"), readiness reasons, FAILED / STALE / UNKNOWN states | pg_dump / Neon limits, Verified vs Stale meaning, stale thresholds, responsibilities, document location | Heading "Canonical recovery documents" -> "Recovery documents" |
| Support | Customer conversations. | Attachment note (original file in forwarded mailbox), send errors, "sent but not recorded" handling | Mailbox / reply-from explanation | Header sentence moved to InfoTip; all logic unchanged |

## Visual system changes

- Neutral palette, dark sidebar, warm off-white canvas, white cards, 14px card radius, subtle borders; no gradients anywhere.
- Body text 11-13px; 9-10px only for short uppercase eyebrows, table headers and tags; headings and figures 15-20px.
- Shared primitives added or extended in `AdminUI.tsx`: AdminPage, AdminStat / AdminStatGrid, AdminTag, AdminSegmented, AdminDisclosure, button / select / textarea / checkbox classes; AdminTabs has roving tabindex and arrow keys; AdminTable `minWidth` (tables scroll in their own wrapper, never the page); AdminTh `info`; confirm dialog closes on Escape and focuses Cancel.
- InfoTip: portalled, fixed-position, viewport-clamped, flips above when needed; keeps button / aria-label / aria-expanded / aria-controls / Escape / outside-click contract; touch area padded.
- AdminShell: compact mobile menu panel; new routes linked (Products, Abandoned checkouts under Marketing, Content, Media, System).
- Legacy inline-style pages (`FONT` / `BORDER` constants) replaced by the primitives on every page in scope.
