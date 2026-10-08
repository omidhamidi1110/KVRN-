// lib/content-size-guide.ts — pure helpers for the public size guide tables.

const NUM = /^\d+(\.\d+)?$/

/** Convert one table cell between cm and inches. Only plain numbers are converted; text is left alone. */
export function convertCell(value: string, from: 'cm' | 'in', showInches: boolean): string {
  if (!NUM.test(value.trim())) return value
  const n = Number(value)
  if (from === 'cm') return showInches ? `${(n / 2.54).toFixed(1)}"` : `${n}`
  return showInches ? `${n}"` : `${+(n * 2.54).toFixed(1)}`
}
