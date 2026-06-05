// Shared IVF building blocks used by both scripts/preprocess.js (build time)
// and benchmark/recall.js (validation). Keeping a single implementation here
// guarantees the benchmark measures the exact algorithm that ships in the
// generated index — there is no second, drifting copy of the math.
//
// Everything works in the quantized Int8 space:
//   - a normalized value v in [0, 1]      -> Math.round(v * 127)  (0..127)
//   - the "missing data" sentinel v === -1 -> -128
// Centroids are kept as Float64 only while k-means iterates; they are
// quantized back to Int8 before any query/centroid distance is computed, so
// queries and centroids are always compared in the same space.

export const D = 14

/** Quantize a single normalized dimension to Int8. */
export function quantizeValue (v) {
  return v === -1 ? -128 : Math.round(v * 127)
}

// Squared Euclidean distance, unrolled over the 14 dimensions. We compare
// rows inside flat typed arrays, so callers pass the base offset of each row.
// Squared distance preserves ordering (the sqrt is monotonic) and avoids the
// per-comparison Math.sqrt entirely.

/** Int8 row `a[ai..]` vs Int8 row `b[bi..]`. */
export function distSqInt8 (a, ai, b, bi) {
  let d
  let s = 0
  d = a[ai] - b[bi]; s += d * d
  d = a[ai + 1] - b[bi + 1]; s += d * d
  d = a[ai + 2] - b[bi + 2]; s += d * d
  d = a[ai + 3] - b[bi + 3]; s += d * d
  d = a[ai + 4] - b[bi + 4]; s += d * d
  d = a[ai + 5] - b[bi + 5]; s += d * d
  d = a[ai + 6] - b[bi + 6]; s += d * d
  d = a[ai + 7] - b[bi + 7]; s += d * d
  d = a[ai + 8] - b[bi + 8]; s += d * d
  d = a[ai + 9] - b[bi + 9]; s += d * d
  d = a[ai + 10] - b[bi + 10]; s += d * d
  d = a[ai + 11] - b[bi + 11]; s += d * d
  d = a[ai + 12] - b[bi + 12]; s += d * d
  d = a[ai + 13] - b[bi + 13]; s += d * d
  return s
}

/** Int8 row `vec[vi..]` vs Float64 centroid row `cent[ci..]`. */
function distSqMixed (vec, vi, cent, ci) {
  let d
  let s = 0
  d = vec[vi] - cent[ci]; s += d * d
  d = vec[vi + 1] - cent[ci + 1]; s += d * d
  d = vec[vi + 2] - cent[ci + 2]; s += d * d
  d = vec[vi + 3] - cent[ci + 3]; s += d * d
  d = vec[vi + 4] - cent[ci + 4]; s += d * d
  d = vec[vi + 5] - cent[ci + 5]; s += d * d
  d = vec[vi + 6] - cent[ci + 6]; s += d * d
  d = vec[vi + 7] - cent[ci + 7]; s += d * d
  d = vec[vi + 8] - cent[ci + 8]; s += d * d
  d = vec[vi + 9] - cent[ci + 9]; s += d * d
  d = vec[vi + 10] - cent[ci + 10]; s += d * d
  d = vec[vi + 11] - cent[ci + 11]; s += d * d
  d = vec[vi + 12] - cent[ci + 12]; s += d * d
  d = vec[vi + 13] - cent[ci + 13]; s += d * d
  return s
}

/**
 * Pick `m` distinct indices in [0, n) using a partial Fisher-Yates shuffle.
 * O(n) memory, O(m) swaps — exact (no collisions) and uniform.
 */
export function sampleIndices (n, m, rng = Math.random) {
  const take = Math.min(m, n)
  const pool = new Int32Array(n)
  for (let i = 0; i < n; i++) pool[i] = i
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (n - i))
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t
  }
  return pool.subarray(0, take)
}

/**
 * Lloyd's k-means over the Int8 vectors, run on a random subsample for speed.
 * Returns Float64 centroids (K * D). Empty clusters are re-seeded from a random
 * subsample point so K stays full.
 *
 * @param {Int8Array} vectors - flat N*D Int8 vectors
 * @param {number} n - number of vectors
 * @param {number} k - number of clusters
 * @param {number} subSize - subsample size for the iterations
 * @param {number} iters - Lloyd iterations
 * @param {() => number} [rng]
 * @returns {Float64Array} K*D centroids
 */
export function kmeans (vectors, n, k, subSize, iters, rng = Math.random) {
  const sub = sampleIndices(n, subSize, rng)
  const subN = sub.length

  const cent = new Float64Array(k * D)
  // Seed centroids from K distinct subsample points.
  const seeds = sampleIndices(subN, k, rng)
  for (let c = 0; c < k; c++) {
    const src = sub[seeds[c]] * D
    const dst = c * D
    for (let d = 0; d < D; d++) cent[dst + d] = vectors[src + d]
  }

  const assign = new Int32Array(subN)
  const sums = new Float64Array(k * D)
  const counts = new Int32Array(k)

  for (let it = 0; it < iters; it++) {
    // Assignment step.
    for (let s = 0; s < subN; s++) {
      const base = sub[s] * D
      let best = Infinity
      let bestK = 0
      for (let c = 0; c < k; c++) {
        const dist = distSqMixed(vectors, base, cent, c * D)
        if (dist < best) { best = dist; bestK = c }
      }
      assign[s] = bestK
    }

    // Update step.
    sums.fill(0)
    counts.fill(0)
    for (let s = 0; s < subN; s++) {
      const base = sub[s] * D
      const c = assign[s]
      const cb = c * D
      for (let d = 0; d < D; d++) sums[cb + d] += vectors[base + d]
      counts[c]++
    }
    for (let c = 0; c < k; c++) {
      const cb = c * D
      if (counts[c] > 0) {
        const inv = 1 / counts[c]
        for (let d = 0; d < D; d++) cent[cb + d] = sums[cb + d] * inv
      } else {
        // Re-seed a dead cluster from a random subsample point.
        const src = sub[Math.floor(rng() * subN)] * D
        for (let d = 0; d < D; d++) cent[cb + d] = vectors[src + d]
      }
    }
  }

  return cent
}

/** Quantize Float64 centroids to Int8 (same space as quantized queries). */
export function quantizeCentroids (cent, k) {
  const out = new Int8Array(k * D)
  for (let i = 0; i < k * D; i++) {
    let v = Math.round(cent[i])
    if (v > 127) v = 127
    else if (v < -128) v = -128
    out[i] = v
  }
  return out
}

/**
 * Assign every one of the N vectors to its nearest Int8 centroid. Done against
 * the *quantized* centroids so the partition matches what the worker sees at
 * query time.
 *
 * @returns {Int32Array} length-N cluster id per vector
 */
export function assignAll (vectors, n, centInt8, k) {
  const assign = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const base = i * D
    let best = Infinity
    let bestK = 0
    for (let c = 0; c < k; c++) {
      const dist = distSqInt8(vectors, base, centInt8, c * D)
      if (dist < best) { best = dist; bestK = c }
    }
    assign[i] = bestK
  }
  return assign
}

/**
 * Turn per-vector cluster ids into the IVF layout: contiguous offsets/counts
 * plus an `order` array listing original vector indices grouped by cluster.
 *
 * @returns {{offsets: Uint32Array, counts: Uint32Array, order: Int32Array}}
 */
export function buildOrder (assign, n, k) {
  const counts = new Uint32Array(k)
  for (let i = 0; i < n; i++) counts[assign[i]]++

  const offsets = new Uint32Array(k)
  let acc = 0
  for (let c = 0; c < k; c++) { offsets[c] = acc; acc += counts[c] }

  const cursor = Uint32Array.from(offsets)
  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const c = assign[i]
    order[cursor[c]++] = i
  }
  return { offsets, counts, order }
}
