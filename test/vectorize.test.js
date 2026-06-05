import { describe, it, expect } from 'vitest'
import { vectorize } from '../src/scoring/vectorize.js'

// Base valid payload (with last_transaction filled in). Individual tests
// override only the slice they care about.
function payload (overrides = {}) {
  return {
    id: 'tx-0000000000',
    transaction: {
      amount: 384.88,
      installments: 3,
      requested_at: '2026-03-11T20:23:35Z'
    },
    customer: {
      avg_amount: 769.76,
      tx_count_24h: 3,
      known_merchants: ['MERC-009', 'MERC-001']
    },
    merchant: {
      id: 'MERC-001',
      mcc: '5912',
      avg_amount: 298.95
    },
    terminal: {
      is_online: false,
      card_present: true,
      km_from_home: 13.7090520965
    },
    last_transaction: {
      timestamp: '2026-03-11T14:58:35Z',
      km_from_current: 18.8626479774
    },
    ...overrides
  }
}

describe('vectorize - documented examples', () => {
  // Legitimate transaction from docs/DETECTION_RULES.md (flow overview).
  it('matches the legit example vector', () => {
    const vector = vectorize({
      id: 'tx-1329056812',
      transaction: { amount: 41.12, installments: 2, requested_at: '2026-03-11T18:45:53Z' },
      customer: { avg_amount: 82.24, tx_count_24h: 3, known_merchants: ['MERC-003', 'MERC-016'] },
      merchant: { id: 'MERC-016', mcc: '5411', avg_amount: 60.25 },
      terminal: { is_online: false, card_present: true, km_from_home: 29.2331036248 },
      last_transaction: null
    })

    expect(vector).toEqual([
      0.0041, 0.1667, 0.05, 0.7826, 0.3333, -1, -1, 0.0292, 0.15, 0, 1, 0, 0.15, 0.006
    ])
  })

  // Fraudulent transaction from docs/DETECTION_RULES.md.
  it('matches the fraud example vector', () => {
    const vector = vectorize({
      id: 'tx-3330991687',
      transaction: { amount: 9505.97, installments: 10, requested_at: '2026-03-14T05:15:12Z' },
      customer: { avg_amount: 81.28, tx_count_24h: 20, known_merchants: ['MERC-008', 'MERC-007', 'MERC-005'] },
      merchant: { id: 'MERC-068', mcc: '7802', avg_amount: 54.86 },
      terminal: { is_online: false, card_present: true, km_from_home: 952.2745933273 },
      last_transaction: null
    })

    expect(vector).toEqual([
      0.9506, 0.8333, 1.0, 0.2174, 0.8333, -1, -1, 0.9523, 1.0, 0, 1, 1, 0.75, 0.0055
    ])
  })
})

describe('vectorize - dimension behavior', () => {
  it('returns exactly 14 dimensions', () => {
    expect(vectorize(payload())).toHaveLength(14)
  })

  it('clamps values above their max to 1.0', () => {
    const vector = vectorize(
      payload({
        transaction: { amount: 999999, installments: 99, requested_at: '2026-03-11T20:23:35Z' },
        customer: { avg_amount: 1, tx_count_24h: 999, known_merchants: [] },
        terminal: { is_online: true, card_present: false, km_from_home: 999999 }
      })
    )
    expect(vector[0]).toBe(1) // amount
    expect(vector[1]).toBe(1) // installments
    expect(vector[2]).toBe(1) // amount_vs_avg
    expect(vector[7]).toBe(1) // km_from_home
    expect(vector[8]).toBe(1) // tx_count_24h
  })

  it('uses the -1 sentinel at indices 5 and 6 when last_transaction is null', () => {
    const vector = vectorize(payload({ last_transaction: null }))
    expect(vector[5]).toBe(-1)
    expect(vector[6]).toBe(-1)
  })

  it('normalizes indices 5 and 6 when last_transaction is present', () => {
    // 20:23:35 - 14:58:35 = 5h25m = 325 minutes; 325 / 1440 = 0.2257
    // km_from_current 18.8626479774 / 1000 = 0.0189
    const vector = vectorize(payload())
    expect(vector[5]).toBe(0.2257)
    expect(vector[6]).toBe(0.0189)
  })

  it('encodes is_online and card_present as 0/1', () => {
    const online = vectorize(payload({ terminal: { is_online: true, card_present: false, km_from_home: 10 } }))
    expect(online[9]).toBe(1)
    expect(online[10]).toBe(0)

    const present = vectorize(payload({ terminal: { is_online: false, card_present: true, km_from_home: 10 } }))
    expect(present[9]).toBe(0)
    expect(present[10]).toBe(1)
  })

  it('inverts unknown_merchant: 1 when the merchant is not known', () => {
    const known = vectorize(payload()) // MERC-001 is in known_merchants
    expect(known[11]).toBe(0)

    const unknown = vectorize(payload({ merchant: { id: 'MERC-999', mcc: '5912', avg_amount: 298.95 } }))
    expect(unknown[11]).toBe(1)
  })

  it('falls back to the default 0.5 risk for an unknown MCC', () => {
    const vector = vectorize(payload({ merchant: { id: 'MERC-001', mcc: '0000', avg_amount: 298.95 } }))
    expect(vector[12]).toBe(0.5)
  })

  it('maps mon=0 ... sun=6 for day_of_week (index 4)', () => {
    // 2026-03-09 is a Monday -> 0/6 = 0
    const monday = vectorize(payload({ transaction: { amount: 10, installments: 1, requested_at: '2026-03-09T12:00:00Z' } }))
    expect(monday[4]).toBe(0)

    // 2026-03-15 is a Sunday -> 6/6 = 1
    const sunday = vectorize(payload({ transaction: { amount: 10, installments: 1, requested_at: '2026-03-15T12:00:00Z' } }))
    expect(sunday[4]).toBe(1)
  })
})
