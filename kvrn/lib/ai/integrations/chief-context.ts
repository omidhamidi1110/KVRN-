import type { ChiefEvidence } from '../chief-evidence'

/**
 * Bounded, deterministic evidence projection for paid Chief chat.
 * The canonical reports returned when paid AI is unavailable are intentionally
 * NOT compressed. Only already-reviewed operational metadata may cross to AI.
 */
export type ChiefModelEvidence = {
  topic: string
  worker: string
  asOf: string
  source: string
  summary: string
  lines: Array<{ label: string; value: string; state?: string }>
  warnings: string[]
  omittedLines: number
}

export const CHIEF_MAX_MODEL_EVIDENCE_CHARS = 11_000
export const CHIEF_MAX_MODEL_HISTORY_CHARS = 1_800

const trim = (value: string, max: number) => String(value).slice(0, max)

/**
 * Prioritize operational failures and high-priority signals, but keep registered
 * agent rows when possible so a workforce answer does not hide employees.
 */
function prioritizedLines(evidence: ChiefEvidence) {
  const lines = evidence.lines.map((line, index) => ({ line, index }))
  if (evidence.topic === 'ai-workforce') {
    return lines.sort((a, b) => {
      const score = (entry: typeof a) => entry.line.label.startsWith('Agent ') ? 1 : entry.line.label.startsWith('Discarded ') ? 2 : 0
      return score(a) - score(b) || a.index - b.index
    })
  }
  return lines
}

export function compactChiefModelEvidence(evidence: ChiefEvidence[]): ChiefModelEvidence[] {
  // A global limit is necessary: six individually bounded sources can still
  // create one expensive, slow or over-limit multi-department prompt.
  let remaining = CHIEF_MAX_MODEL_EVIDENCE_CHARS
  const output: ChiefModelEvidence[] = []
  for (const e of evidence.slice(0, 6)) {
    const head = {
      topic: trim(e.topic, 64), worker: trim(e.worker, 100), asOf: trim(e.asOf, 50),
      source: trim(e.source, 180), summary: trim(e.summary, 400),
      lines: [] as ChiefModelEvidence['lines'], warnings: e.warnings.slice(0, 2).map(w => trim(w, 220)),
      omittedLines: 0,
    }
    // Reserve more detail for 11-agent workforce than small scalar reports.
    // All weights add to one global cap; no source can force unbounded spending.
    const future = evidence.slice(output.length, 6)
    const totalWeight = future.reduce((sum, src) => sum + (src.topic === 'ai-workforce' ? 2 : 1), 0)
    const weight = e.topic === 'ai-workforce' ? 2 : 1
    const budget = Math.floor(remaining * weight / Math.max(1, totalWeight))
    if (budget < JSON.stringify(head).length + 80) {
      head.summary = trim(head.summary, 80)
      head.warnings = []
    }
    let spent = JSON.stringify(head).length
    const prioritized = prioritizedLines(e)
    // Preserve a useful number of agents and concise warning rows. We never
    // interpolate unbounded DB values into paid inference.
    for (const {line} of prioritized) {
      const item = {label: trim(line.label, 90), value: trim(line.value, e.topic === 'ai-workforce' ? 145 : 140),
        ...(line.state ? {state: trim(line.state, 20)} : {})}
      const cost = JSON.stringify(item).length + 1
      if (spent + cost + 16 > budget) continue
      head.lines.push(item)
      spent += cost
    }
    head.omittedLines = Math.max(0, e.lines.length - head.lines.length)
    remaining = Math.max(0, remaining - JSON.stringify(head).length)
    output.push(head)
  }
  return output
}

export function compactChiefConversation(history: Array<{who: 'owner' | 'chief'; text: string}>) {
  // Keep only recent context; older lengthy database fallback answers should
  // not be forwarded back to a paid model on every turn.
  let remaining = CHIEF_MAX_MODEL_HISTORY_CHARS
  const kept: typeof history = []
  for (const turn of history.slice(-4).reverse()) {
    if (remaining <= 30) break
    const text = trim(turn.text, Math.min(450, remaining))
    remaining -= text.length
    kept.push({who:turn.who,text})
  }
  return kept.reverse()
}
