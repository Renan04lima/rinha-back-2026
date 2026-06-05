import { readFileSync } from 'node:fs'

// Normalization constants and per-MCC risk weights live in resources/.
// Read them once at module load (small files) using a URL relative to this
// module so it resolves the same under plain Node and under Vitest.
const resourcesDir = new URL('../../resources/', import.meta.url)
const normalization = JSON.parse(readFileSync(new URL('normalization.json', resourcesDir), 'utf8'))
const mccRisk = JSON.parse(readFileSync(new URL('mcc_risk.json', resourcesDir), 'utf8'))

const {
  max_amount: MAX_AMOUNT,
  max_installments: MAX_INSTALLMENTS,
  amount_vs_avg_ratio: AMOUNT_VS_AVG_RATIO,
  max_minutes: MAX_MINUTES,
  max_km: MAX_KM,
  max_tx_count_24h: MAX_TX_COUNT_24H,
  max_merchant_avg_amount: MAX_MERCHANT_AVG_AMOUNT
} = normalization

// Risk used when a merchant's MCC is absent from mcc_risk.json.
const DEFAULT_MCC_RISK = 0.5

// Sentinel for the two "previous transaction" dimensions when this is the
// customer's first transaction (last_transaction === null). It is the only
// value allowed outside [0, 1], distinguishing "missing data" from a real 0.
const MISSING = -1

const MS_PER_MINUTE = 60000

// Keep each dimension within [0, 1]: below 0 -> 0, above 1 -> 1.
function clamp (x) {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

// Round to 4 decimals so query vectors share the precision of the reference
// dataset (and match the documented examples exactly).
function round4 (x) {
  return Math.round(x * 10000) / 10000
}

/**
 * Turn a /fraud-score payload into its normalized 14-dimension vector,
 * following the order and formulas in docs/DETECTION_RULES.md.
 *
 * @param {object} payload - a validated /fraud-score request body
 * @returns {number[]} the 14-dimension vector
 */
export function vectorize (payload) {
  const { transaction, customer, merchant, terminal, last_transaction } = payload

  const requestedAt = new Date(transaction.requested_at)

  // index 3: hour of day in UTC (0-23), normalized to [0, 1].
  const hourOfDay = requestedAt.getUTCHours() / 23

  // index 4: day of week with mon=0 ... sun=6 (JS getUTCDay has sun=0), /6.
  const dayOfWeek = ((requestedAt.getUTCDay() + 6) % 7) / 6

  // indices 5 & 6: derived from the previous transaction; -1 when there is none.
  let minutesSinceLast = MISSING
  let kmFromLast = MISSING
  if (last_transaction !== null) {
    const minutes = (requestedAt.getTime() - new Date(last_transaction.timestamp).getTime()) / MS_PER_MINUTE
    minutesSinceLast = clamp(minutes / MAX_MINUTES)
    kmFromLast = clamp(last_transaction.km_from_current / MAX_KM)
  }

  // index 11: inverted — 1 when the merchant is NOT among the customer's known ones.
  const unknownMerchant = customer.known_merchants.includes(merchant.id) ? 0 : 1

  // index 12: per-MCC risk weight, falling back to the default for unknown MCCs.
  const mccRiskValue = merchant.mcc in mccRisk ? mccRisk[merchant.mcc] : DEFAULT_MCC_RISK

  return [
    round4(clamp(transaction.amount / MAX_AMOUNT)), // 0  amount
    round4(clamp(transaction.installments / MAX_INSTALLMENTS)), // 1  installments
    round4(clamp((transaction.amount / customer.avg_amount) / AMOUNT_VS_AVG_RATIO)), // 2  amount_vs_avg
    round4(hourOfDay), // 3  hour_of_day
    round4(dayOfWeek), // 4  day_of_week
    round4(minutesSinceLast), // 5  minutes_since_last_tx (round4(-1) === -1)
    round4(kmFromLast), // 6  km_from_last_tx (round4(-1) === -1)
    round4(clamp(terminal.km_from_home / MAX_KM)), // 7  km_from_home
    round4(clamp(customer.tx_count_24h / MAX_TX_COUNT_24H)), // 8  tx_count_24h
    terminal.is_online ? 1 : 0, // 9  is_online
    terminal.card_present ? 1 : 0, // 10 card_present
    unknownMerchant, // 11 unknown_merchant
    round4(mccRiskValue), // 12 mcc_risk
    round4(clamp(merchant.avg_amount / MAX_MERCHANT_AVG_AMOUNT)) // 13 merchant_avg_amount
  ]
}
