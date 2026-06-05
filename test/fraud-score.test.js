import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../src/config/app.js'

let app

beforeAll(async () => {
  app = buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// Base valid payload (with last_transaction filled in)
function validPayload (overrides = {}) {
  return {
    id: 'tx-3576980410',
    transaction: {
      amount: 384.88,
      installments: 3,
      requested_at: '2026-03-11T20:23:35Z'
    },
    customer: {
      avg_amount: 769.76,
      tx_count_24h: 3,
      known_merchants: ['MERC-009', 'MERC-001', 'MERC-001']
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

async function post (payload) {
  return app.inject({
    method: 'POST',
    url: '/fraud-score',
    payload
  })
}

describe('GET /ready', () => {
  it('responds with 2xx when ready', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBeGreaterThanOrEqual(200)
    expect(res.statusCode).toBeLessThan(300)
  })
})

describe('POST /fraud-score - valid payloads', () => {
  it('accepts a full payload and responds in the contract format', async () => {
    const res = await post(validPayload())
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(['approved', 'fraud_score'])
    expect(typeof body.approved).toBe('boolean')
    // fraud_score is frauds / 5, so always a multiple of 0.2 in [0, 1].
    expect([0, 0.2, 0.4, 0.6, 0.8, 1]).toContain(body.fraud_score)
    expect(body.approved).toBe(body.fraud_score < 0.6)
  })

  it('approves this clearly legit payload (low fraud_score)', async () => {
    const res = await post(validPayload())
    const body = res.json()
    expect(body.approved).toBe(true)
    expect(body.fraud_score).toBeLessThan(0.6)
  })

  it('accepts last_transaction = null', async () => {
    const res = await post(validPayload({ last_transaction: null }))
    expect(res.statusCode).toBe(200)
  })

  it('accepts an empty known_merchants', async () => {
    const res = await post(
      validPayload({
        customer: {
          avg_amount: 100,
          tx_count_24h: 0,
          known_merchants: []
        }
      })
    )
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /fraud-score - missing required fields', () => {
  const topLevel = ['id', 'transaction', 'customer', 'merchant', 'terminal', 'last_transaction']

  for (const field of topLevel) {
    it(`rejects when "${field}" is missing`, async () => {
      const payload = validPayload()
      delete payload[field]
      const res = await post(payload)
      expect(res.statusCode).toBe(400)
    })
  }

  it('rejects when transaction.amount is missing', async () => {
    const payload = validPayload()
    delete payload.transaction.amount
    const res = await post(payload)
    expect(res.statusCode).toBe(400)
  })

  it('rejects when merchant.mcc is missing', async () => {
    const payload = validPayload()
    delete payload.merchant.mcc
    const res = await post(payload)
    expect(res.statusCode).toBe(400)
  })

  it('rejects an incomplete non-null last_transaction', async () => {
    const res = await post(
      validPayload({ last_transaction: { timestamp: '2026-03-11T14:58:35Z' } })
    )
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /fraud-score - invalid types', () => {
  it('rejects a non-integer installments', async () => {
    const payload = validPayload()
    payload.transaction.installments = 3.5
    const res = await post(payload)
    expect(res.statusCode).toBe(400)
  })

  it('rejects amount as a string', async () => {
    const payload = validPayload()
    payload.transaction.amount = 'abc'
    const res = await post(payload)
    expect(res.statusCode).toBe(400)
  })

  it('rejects a non-boolean is_online', async () => {
    const payload = validPayload()
    payload.terminal.is_online = 'yes'
    const res = await post(payload)
    expect(res.statusCode).toBe(400)
  })

  it('rejects known_merchants with a non-string item', async () => {
    const payload = validPayload()
    payload.customer.known_merchants = ['MERC-001', 123]
    const res = await post(payload)
    expect(res.statusCode).toBe(400)
  })

  it('rejects requested_at with an invalid format', async () => {
    const payload = validPayload()
    payload.transaction.requested_at = 'not-a-date'
    const res = await post(payload)
    expect(res.statusCode).toBe(400)
  })

  it('rejects an extra property (additionalProperties: false)', async () => {
    const res = await post(validPayload({ extra: 'field' }))
    expect(res.statusCode).toBe(400)
  })
})
