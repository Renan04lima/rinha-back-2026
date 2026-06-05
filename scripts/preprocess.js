// Build-time preprocessor (runs in the Docker build, never at runtime).
//
// Reads resources/references.json.gz (~3M labeled 14-dim vectors) and emits
// three compact binary artifacts in resources/:
//
//   vectors.bin  Int8Array  [N x 14]   quantized vectors, reordered by cluster
//   labels.bin   Uint8Array [N]        1 = fraud, 0 = legit, same order
//   ivf.bin      IVF index, K = 500 clusters:
//                  uint32  K
//                  int8    K x 14   quantized centroids
//                  uint32  K        offsets (start of each cluster)
//                  uint32  K        counts  (size of each cluster)
//
// Two problems this solves:
//   1. Memory/time of loading: the naive readFileSync + JSON.parse of the gz
//      peaks ~1.3 GB and ~2.9 s. Here we *stream* the gunzip and parse one
//      object at a time, writing straight into growable typed arrays. Peak
//      heap is dominated by the ~45 MB of output, not the source text.
//   2. Query speed: the IVF partitions the space so the worker probes only a
//      handful of clusters instead of scanning all N vectors.
//
// Run: node scripts/preprocess.js

import { createReadStream } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import {
  D,
  quantizeValue,
  kmeans,
  quantizeCentroids,
  assignAll,
  buildOrder
} from './ivf-core.js'

const K = 500
const KMEANS_SUBSAMPLE = 50000
const KMEANS_ITERS = 15

const resourcesDir = new URL('../resources/', import.meta.url)
const gzPath = new URL('references.json.gz', resourcesDir)

/**
 * Stream the gzipped JSON array and yield one parsed `{vector, label}` object
 * at a time. The scanner tracks brace depth (ignoring braces inside strings)
 * so it can slice out each top-level object and JSON.parse just that slice —
 * never materializing the whole array.
 */
async function * streamEntries (path) {
  const stream = createReadStream(path).pipe(createGunzip())
  let buf = ''
  let pos = 0
  let depth = 0
  let inStr = false
  let esc = false
  let objStart = -1

  for await (const chunk of stream) {
    buf += chunk.toString('utf8')
    const len = buf.length
    while (pos < len) {
      const c = buf[pos]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
      } else if (c === '"') {
        inStr = true
      } else if (c === '{') {
        if (depth === 0) objStart = pos
        depth++
      } else if (c === '}') {
        depth--
        if (depth === 0) {
          yield JSON.parse(buf.slice(objStart, pos + 1))
          objStart = -1
        }
      }
      pos++
    }
    // Compact: drop everything we no longer need so `buf` stays bounded to at
    // most one in-flight object.
    if (objStart >= 0) {
      buf = buf.slice(objStart)
      pos -= objStart
      objStart = 0
    } else {
      buf = ''
      pos = 0
    }
  }
}

async function main () {
  console.time('total')
  console.log('Streaming + quantizing %s ...', gzPath.pathname)

  // Growable Int8/Uint8 buffers (double on overflow) so we make a single pass
  // without knowing N up front and without a giant intermediate JS array.
  let cap = 1 << 20 // 1,048,576 vectors to start
  let vectors = new Int8Array(cap * D)
  let labels = new Uint8Array(cap)
  let n = 0

  console.time('load')
  for await (const entry of streamEntries(gzPath)) {
    if (n === cap) {
      cap *= 2
      const v2 = new Int8Array(cap * D); v2.set(vectors); vectors = v2
      const l2 = new Uint8Array(cap); l2.set(labels); labels = l2
    }
    const vec = entry.vector
    const base = n * D
    for (let d = 0; d < D; d++) vectors[base + d] = quantizeValue(vec[d])
    labels[n] = entry.label === 'fraud' ? 1 : 0
    n++
  }
  console.timeEnd('load')

  // Trim to exact size.
  vectors = vectors.subarray(0, n * D)
  labels = labels.subarray(0, n)
  console.log('Parsed %d vectors (%d MB of Int8 data)', n, ((n * D) / 1e6).toFixed(1))

  // K-means on a subsample, then quantize centroids to the Int8 query space.
  console.time('kmeans')
  const centF = kmeans(vectors, n, K, KMEANS_SUBSAMPLE, KMEANS_ITERS)
  const centI8 = quantizeCentroids(centF, K)
  console.timeEnd('kmeans')

  // Assign every vector to its nearest (quantized) centroid and group them.
  console.time('assign')
  const assign = assignAll(vectors, n, centI8, K)
  const { offsets, counts, order } = buildOrder(assign, n, K)
  console.timeEnd('assign')

  // Reorder vectors + labels so each cluster is contiguous (sequential,
  // cache-friendly scans at query time).
  console.time('reorder')
  const outVec = new Int8Array(n * D)
  const outLab = new Uint8Array(n)
  for (let dst = 0; dst < n; dst++) {
    const src = order[dst]
    const sBase = src * D
    const dBase = dst * D
    for (let d = 0; d < D; d++) outVec[dBase + d] = vectors[sBase + d]
    outLab[dst] = labels[src]
  }
  console.timeEnd('reorder')

  // Serialize.
  writeFileSync(new URL('vectors.bin', resourcesDir), Buffer.from(outVec.buffer, outVec.byteOffset, outVec.byteLength))
  writeFileSync(new URL('labels.bin', resourcesDir), Buffer.from(outLab.buffer, outLab.byteOffset, outLab.byteLength))
  writeFileSync(new URL('ivf.bin', resourcesDir), buildIvfBuffer(K, centI8, offsets, counts))

  const minCount = counts.reduce((a, b) => Math.min(a, b), Infinity)
  const maxCount = counts.reduce((a, b) => Math.max(a, b), 0)
  console.log('Wrote vectors.bin, labels.bin, ivf.bin')
  console.log('Clusters: K=%d, min=%d, max=%d, avg=%d', K, minCount, maxCount, Math.round(n / K))
  console.timeEnd('total')
}

/** Pack the IVF index into a single Buffer in the documented layout. */
function buildIvfBuffer (k, centI8, offsets, counts) {
  const headerBytes = 4
  const centBytes = k * D
  const offBytes = k * 4
  const cntBytes = k * 4
  const out = Buffer.allocUnsafe(headerBytes + centBytes + offBytes + cntBytes)

  out.writeUInt32LE(k, 0)
  let p = headerBytes
  for (let i = 0; i < centBytes; i++) out.writeInt8(centI8[i], p + i)
  p += centBytes
  for (let c = 0; c < k; c++) out.writeUInt32LE(offsets[c], p + c * 4)
  p += offBytes
  for (let c = 0; c < k; c++) out.writeUInt32LE(counts[c], p + c * 4)

  return out
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
