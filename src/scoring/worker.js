// Worker thread: answers one k-NN query at a time against the shared,
// memory-mapped index. The big arrays live in SharedArrayBuffers passed via
// workerData, so every worker in the pool reads the *same* ~45 MB — no
// per-worker copy, which is what keeps us inside the 350 MB budget.
//
// Protocol:
//   in:  { id, vector }   vector = normalized 14-dim number[] (a query)
//   out: { id, count }    count  = frauds among the K nearest neighbors

import { parentPort, workerData } from 'node:worker_threads'
import { D, distSqInt8 } from '../../scripts/ivf-core.js'

const K = 5 // neighbors voted on
const N_PROBE = 5 // clusters scanned per query

const { vectorsSAB, labelsSAB, ivfSAB } = workerData

// Whole-dataset views over shared memory (1 byte each -> no alignment issue).
const vectors = new Int8Array(vectorsSAB) // N * D
const labels = new Uint8Array(labelsSAB) // N

// Parse the IVF header. Int8 centroids can be viewed in place; offsets/counts
// sit at a non-4-aligned byte offset, so we copy them out once via DataView.
const ivfView = new DataView(ivfSAB)
const KCLUSTERS = ivfView.getUint32(0, true)
const centroids = new Int8Array(ivfSAB, 4, KCLUSTERS * D)
const offBase = 4 + KCLUSTERS * D
const offsets = new Uint32Array(KCLUSTERS)
const counts = new Uint32Array(KCLUSTERS)
for (let c = 0; c < KCLUSTERS; c++) offsets[c] = ivfView.getUint32(offBase + c * 4, true)
for (let c = 0; c < KCLUSTERS; c++) counts[c] = ivfView.getUint32(offBase + KCLUSTERS * 4 + c * 4, true)

// Preallocated scratch — nothing in knnFraudCount allocates.
const qi = new Int8Array(D) // quantized query
const probeDist = new Float64Array(N_PROBE) // nearest clusters, ascending
const probeIdx = new Int32Array(N_PROBE)
const nnDist = new Float64Array(K) // nearest neighbors, ascending
const nnFraud = new Uint8Array(K)

/**
 * Count frauds among the K nearest neighbors of `query`, searching only the
 * N_PROBE nearest clusters.
 *
 * @param {number[]} query - normalized 14-dim vector
 * @returns {number} frauds in [0, K]
 */
function knnFraudCount (query) {
  // Quantize the query into the same Int8 space as the stored vectors.
  for (let d = 0; d < D; d++) {
    const v = query[d]
    qi[d] = v === -1 ? -128 : Math.round(v * 127)
  }

  // Select the N_PROBE nearest centroids (insertion into a sorted window).
  for (let i = 0; i < N_PROBE; i++) { probeDist[i] = Infinity; probeIdx[i] = -1 }
  for (let c = 0; c < KCLUSTERS; c++) {
    const dist = distSqInt8(qi, 0, centroids, c * D)
    if (dist < probeDist[N_PROBE - 1]) {
      let p = N_PROBE - 1
      while (p > 0 && probeDist[p - 1] > dist) {
        probeDist[p] = probeDist[p - 1]; probeIdx[p] = probeIdx[p - 1]; p--
      }
      probeDist[p] = dist; probeIdx[p] = c
    }
  }

  // Scan the probed clusters, keeping the K nearest neighbors sorted.
  for (let i = 0; i < K; i++) { nnDist[i] = Infinity; nnFraud[i] = 0 }
  for (let pi = 0; pi < N_PROBE; pi++) {
    const c = probeIdx[pi]
    if (c < 0) continue
    const start = offsets[c]
    const end = start + counts[c]
    for (let idx = start; idx < end; idx++) {
      const dist = distSqInt8(vectors, idx * D, qi, 0)
      if (dist < nnDist[K - 1]) {
        const fraud = labels[idx]
        let p = K - 1
        while (p > 0 && nnDist[p - 1] > dist) {
          nnDist[p] = nnDist[p - 1]; nnFraud[p] = nnFraud[p - 1]; p--
        }
        nnDist[p] = dist; nnFraud[p] = fraud
      }
    }
  }

  // Tally frauds among the filled neighbor slots.
  let frauds = 0
  for (let i = 0; i < K; i++) {
    if (nnDist[i] === Infinity) break
    frauds += nnFraud[i]
  }
  return frauds
}

parentPort.on('message', (msg) => {
  const count = knnFraudCount(msg.vector)
  parentPort.postMessage({ id: msg.id, count })
})
