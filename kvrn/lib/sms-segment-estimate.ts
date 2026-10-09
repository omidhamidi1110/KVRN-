/** Advisory GSM-7/UCS-2 segment calculation for draft previews ONLY.
 * Not a price quote or transport decision: recipient country, provider, message
 * service, concatenation, Smart Encoding, and MMS conversion can change billing.
 */
const BASIC = new Set(Array.from(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ' +
  ' !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
))
const EXTENDED = new Set(Array.from('^{}\\[~]|€\f'))

export type SmsEstimate = Readonly<{
  encoding: 'GSM-7' | 'UCS-2'
  units: number
  segments: number
  estimatedOnly: true
}>

export function estimateSmsSegments(message: string): SmsEstimate {
  if (typeof message !== 'string') throw Error('SMS_TEXT_REQUIRED')
  let gsmUnits = 0
  let gsm = true
  for (const char of message) {
    if (BASIC.has(char)) gsmUnits++
    else if (EXTENDED.has(char)) gsmUnits += 2
    else { gsm = false; break }
  }
  if (gsm) {
    const limit = gsmUnits <= 160 ? 160 : 153
    return {encoding:'GSM-7',units:gsmUnits,segments:Math.ceil(gsmUnits / limit),estimatedOnly:true}
  }
  // UCS-2 uses UTF-16 code units; astral emoji occupy two units each.
  const units=message.length
  const limit=units <= 70 ? 70 : 67
  return {encoding:'UCS-2',units,segments:Math.ceil(units/limit),estimatedOnly:true}
}
