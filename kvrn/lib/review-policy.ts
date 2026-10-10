// Shared review field policy — used by BOTH the browser form and POST /api/reviews so the two can never disagree.
// The numeric bounds mirror the CHECK constraints in migration 067 (kvrn_product_reviews). Lowering a minimum here WITHOUT a new
// migration would make the database reject the insert, so the limits below are the narrowest the existing schema allows:
//   display_name 2–70, headline 3–120, body 20–2000.
// Lengths are counted in Unicode code points (what PostgreSQL length() counts), after trimming — an emoji is 1, not 2.

export const REVIEW_ITEMS = ['Hoodie', 'Sweatpants', 'Other KVRN item'] as const
export type ReviewItem = (typeof REVIEW_ITEMS)[number]
export const REVIEW_LIMITS = {
  name: { min: 2, max: 70 },
  headline: { min: 3, max: 120 },
  text: { min: 20, max: 2000 },
  rating: { min: 1, max: 5 },
} as const

export type ReviewFieldKey = 'name' | 'item' | 'rating' | 'headline' | 'text'
export type ReviewFieldErrors = Partial<Record<ReviewFieldKey, string>>

export const reviewLength = (s: string) => Array.from(s.trim()).length

export function validateReview(input: { name?: unknown; item?: unknown; rating?: unknown; headline?: unknown; text?: unknown }): ReviewFieldErrors {
  const errors: ReviewFieldErrors = {}
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const L = REVIEW_LIMITS
  const n = reviewLength(str(input.name))
  if (n === 0) errors.name = 'Enter your name.'
  else if (n < L.name.min) errors.name = `Name needs at least ${L.name.min} characters.`
  else if (n > L.name.max) errors.name = `Name can be at most ${L.name.max} characters.`

  if (!REVIEW_ITEMS.includes(str(input.item) as ReviewItem)) errors.item = 'Choose the item you are reviewing.'

  const r = input.rating
  if (typeof r !== 'number' || !Number.isInteger(r) || r < L.rating.min || r > L.rating.max) errors.rating = 'Choose a rating from 1 to 5.'

  const h = reviewLength(str(input.headline))
  if (h === 0) errors.headline = 'Add a short title.'
  else if (h < L.headline.min) errors.headline = `Title needs at least ${L.headline.min} characters.`
  else if (h > L.headline.max) errors.headline = `Title can be at most ${L.headline.max} characters.`

  const t = reviewLength(str(input.text))
  if (t === 0) errors.text = 'Tell us about your experience.'
  else if (t < L.text.min) errors.text = `Add ${L.text.min - t} more character${L.text.min - t === 1 ? '' : 's'} — reviews need at least ${L.text.min}.`
  else if (t > L.text.max) errors.text = `Your experience can be at most ${L.text.max.toLocaleString('en-US')} characters (${t - L.text.max} over).`
  return errors
}
