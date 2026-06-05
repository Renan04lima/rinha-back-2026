import { describe, it, expect } from 'vitest'
import { nearestNeighbors, score } from '../src/scoring/knn.js'

// A constant 14-dim vector. Distance between fill(v) and fill(w) is
// sqrt(14) * |v - w|, so ordering is driven purely by |v - w| — handy for
// building deterministic neighbor sets.
const fill = (v) => Array(14).fill(v)

// Synthetic references: three legit clustered low, three fraud clustered high.
const refs = [
  { vector: fill(0.0), label: 'legit' },
  { vector: fill(0.1), label: 'legit' },
  { vector: fill(0.2), label: 'legit' },
  { vector: fill(0.8), label: 'fraud' },
  { vector: fill(0.9), label: 'fraud' },
  { vector: fill(1.0), label: 'fraud' }
]

describe('nearestNeighbors', () => {
  it('returns k neighbors sorted nearest-first', () => {
    const neighbors = nearestNeighbors(fill(0.05), refs, 3)
    expect(neighbors).toHaveLength(3)
    expect(neighbors.map((n) => n.label)).toEqual(['legit', 'legit', 'legit'])
    // distances must be non-decreasing
    expect(neighbors[0].distance).toBeLessThanOrEqual(neighbors[1].distance)
    expect(neighbors[1].distance).toBeLessThanOrEqual(neighbors[2].distance)
  })

  it('reports distance 0 for an exact match', () => {
    const [closest] = nearestNeighbors(fill(0.8), refs, 1)
    expect(closest.label).toBe('fraud')
    expect(closest.distance).toBe(0)
  })
})

describe('score', () => {
  it('approves a transaction near the legit cluster', () => {
    // k=5 nearest to 0.05: 0.0, 0.1, 0.2 (legit), 0.8, 0.9 (fraud) -> 2/5 = 0.4
    const result = score(fill(0.05), { references: refs })
    expect(result).toEqual({ approved: true, fraud_score: 0.4 })
  })

  it('rejects a transaction near the fraud cluster', () => {
    // k=5 nearest to 0.85: 0.8, 0.9, 1.0 (fraud), 0.2, 0.1 (legit) -> 3/5 = 0.6
    // approved = 0.6 < 0.6 -> false (threshold is exclusive)
    const result = score(fill(0.85), { references: refs })
    expect(result).toEqual({ approved: false, fraud_score: 0.6 })
  })

  it('respects a custom k', () => {
    // k=3 nearest to 0.95: 1.0, 0.9, 0.8 -> all fraud -> 3/3 = 1.0
    const result = score(fill(0.95), { references: refs, k: 3 })
    expect(result).toEqual({ approved: false, fraud_score: 1.0 })
  })
})

describe('score - against the real reference set', () => {
  it('returns a contract-shaped result with a valid fraud_score', () => {
    const result = score(fill(0.1))
    expect(typeof result.approved).toBe('boolean')
    // fraud_score is frauds / 5, so it is always a multiple of 0.2 in [0, 1].
    expect([0, 0.2, 0.4, 0.6, 0.8, 1]).toContain(result.fraud_score)
    expect(result.approved).toBe(result.fraud_score < 0.6)
  })
})
