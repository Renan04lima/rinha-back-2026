import { readFileSync } from 'node:fs'

// Labeled reference vectors used for the nearest-neighbor search. Loaded once
// at module start, via a URL relative to this module so it resolves the same
// under plain Node and under Vitest.
const resourcesDir = new URL('../../resources/', import.meta.url)
const defaultReferences = JSON.parse(
  readFileSync(new URL('example-references.json', resourcesDir), 'utf8')
)

// Number of neighbors to consider and the fixed decision threshold, per
// docs/DETECTION_RULES.md.
const K = 5
const FRAUD_THRESHOLD = 0.6

// Euclidean distance over the 14 dimensions. The sqrt is monotonic, so it does
// not change neighbor ordering, but it keeps reported distances meaningful and
// matching the documented examples.
function euclideanDistance (a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

/**
 * Find the `k` references closest to `vector`, nearest first.
 *
 * @param {number[]} vector - the query vector
 * @param {{vector: number[], label: string}[]} references - labeled reference set
 * @param {number} [k=K] - number of neighbors to return
 * @returns {{label: string, distance: number}[]}
 */
export function nearestNeighbors (vector, references, k = K) {
  return references
    .map((ref) => ({ label: ref.label, distance: euclideanDistance(vector, ref.vector) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k)
}

/**
 * Score a query vector via k-NN over the reference set:
 *   fraud_score = (frauds among the k nearest) / k
 *   approved    = fraud_score < threshold (0.6)
 *
 * @param {number[]} vector - the normalized 14-dimension query vector
 * @param {object} [options]
 * @param {{vector: number[], label: string}[]} [options.references] - reference set
 * @param {number} [options.k] - number of neighbors
 * @returns {{approved: boolean, fraud_score: number}}
 */
export function score (vector, { references = defaultReferences, k = K } = {}) {
  const neighbors = nearestNeighbors(vector, references, k)
  const frauds = neighbors.reduce((count, n) => count + (n.label === 'fraud' ? 1 : 0), 0)
  const fraudScore = frauds / k
  return { approved: fraudScore < FRAUD_THRESHOLD, fraud_score: fraudScore }
}
