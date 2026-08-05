// lib/us-states.ts — valid US state and territory codes

export const US_STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP',
])

export function isValidUSState(code: string): boolean {
  return US_STATE_CODES.has(code.trim().toUpperCase())
}

export function isValidUSZip(zip: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(zip.trim())
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.length <= 254
}
