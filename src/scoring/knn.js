import { readFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'

// Number of neighbors to consider and the fixed decision threshold, per
// docs/DETECTION_RULES.md.
const K = 5
const FRAUD_THRESHOLD = 0.6

const resourcesDir = new URL('../../resources/', import.meta.url)

// ---------------------------------------------------------------------------
// Naive path (test/dev): brute force over a small JSON reference set.
//
// This is kept verbatim so the existing tests — which call score()/
// nearestNeighbors() synchronously with `references` — keep passing, and so
// any environment *without* the preprocessed binaries still works.
// ---------------------------------------------------------------------------

// Loaded once at module start via a URL relative to this module so it resolves
// the same under plain Node and under Vitest.
const defaultReferences = JSON.parse(
  readFileSync(new URL('example-references.json', resourcesDir), 'utf8')
)

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

function scoreNaive (vector, references, k) {
  const neighbors = nearestNeighbors(vector, references, k)
  const frauds = neighbors.reduce((count, n) => count + (n.label === 'fraud' ? 1 : 0), 0)
  const fraudScore = frauds / k
  return { approved: fraudScore < FRAUD_THRESHOLD, fraud_score: fraudScore }
}

// ---------------------------------------------------------------------------
// Production path: IVF index in SharedArrayBuffers + a reusable worker pool.
// ---------------------------------------------------------------------------

// 'idle'    -> not yet probed
// 'naive'   -> no binaries on disk; stay on the brute-force path
// 'loading' -> binaries found, SABs/workers initializing
// 'ready'   -> pool can serve queries
// 'error'   -> initialization failed
let state = 'idle'
let initPromise = null

const workers = []
const freeWorkers = []
const queue = [] // { id, vector } waiting for a free worker
const pendingResolvers = new Map() // id -> resolve(count)
let nextId = 1

function toSAB (buf) {
  const sab = new SharedArrayBuffer(buf.byteLength)
  new Uint8Array(sab).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  return sab
}

function onWorkerMessage (worker, { id, count }) {
  const resolve = pendingResolvers.get(id)
  pendingResolvers.delete(id)
  // Worker is free: hand it the next queued job, or return it to the pool.
  const next = queue.shift()
  if (next) worker.postMessage(next)
  else freeWorkers.push(worker)
  if (resolve) resolve(count)
}

async function loadAndStart () {
  const [vecBuf, labBuf, ivfBuf] = await Promise.all([
    readFile(new URL('vectors.bin', resourcesDir)),
    readFile(new URL('labels.bin', resourcesDir)),
    readFile(new URL('ivf.bin', resourcesDir))
  ])
  // Move the bytes into shared memory once; the source Buffers are then GC'd,
  // so steady-state resident size is ~one copy of the index, shared by all
  // workers (not duplicated per worker).
  const workerData = {
    vectorsSAB: toSAB(vecBuf),
    labelsSAB: toSAB(labBuf),
    ivfSAB: toSAB(ivfBuf)
  }

  const size = Math.max(1, availableParallelism() - 1)
  const workerUrl = new URL('./worker.js', import.meta.url)
  for (let i = 0; i < size; i++) {
    const worker = new Worker(workerUrl, { workerData })
    worker.on('message', (msg) => onWorkerMessage(worker, msg))
    worker.on('error', (err) => { state = 'error'; console.error('worker error:', err) })
    workers.push(worker)
    freeWorkers.push(worker)
  }
}

/**
 * Idempotent. On first call, decides naive vs production synchronously (cheap
 * existsSync) so /ready can report status immediately, then kicks off the async
 * load when binaries are present. Returns a promise that settles when init is
 * done (resolves immediately in naive mode).
 */
export function ensureInitialized () {
  if (initPromise) return initPromise
  if (!existsSync(new URL('vectors.bin', resourcesDir))) {
    state = 'naive'
    initPromise = Promise.resolve()
    return initPromise
  }
  state = 'loading'
  initPromise = loadAndStart()
    .then(() => { state = 'ready' })
    .catch((err) => { state = 'error'; throw err })
  return initPromise
}

/** True when the service can serve queries (pool ready, or naive fallback). */
export function isReady () {
  return state === 'ready' || state === 'naive'
}

function dispatch (vector) {
  return new Promise((resolve) => {
    const id = nextId++
    pendingResolvers.set(id, resolve)
    const worker = freeWorkers.pop()
    if (worker) worker.postMessage({ id, vector })
    else queue.push({ id, vector })
  })
}

async function scoreWithPool (vector) {
  const frauds = await dispatch(vector)
  const fraudScore = frauds / K
  return { approved: fraudScore < FRAUD_THRESHOLD, fraud_score: fraudScore }
}

/**
 * Score a query vector via k-NN:
 *   fraud_score = (frauds among the k nearest) / k
 *   approved    = fraud_score < threshold (0.6)
 *
 * Returns a plain object on the naive path (explicit `references`, or no
 * binaries on disk) and a Promise on the production path. The route handler
 * awaits the result, so both shapes are transparent to callers.
 *
 * @param {number[]} vector - the normalized 14-dimension query vector
 * @param {object} [options]
 * @param {{vector: number[], label: string}[]} [options.references] - reference set
 * @param {number} [options.k] - number of neighbors
 * @returns {{approved: boolean, fraud_score: number} | Promise<{approved: boolean, fraud_score: number}>}
 */
export function score (vector, { references, k = K } = {}) {
  // Explicit references, or an environment without the preprocessed index:
  // keep the synchronous brute-force behavior the tests rely on.
  if (references !== undefined || state === 'naive') {
    return scoreNaive(vector, references ?? defaultReferences, k)
  }

  return ensureInitialized().then(() => {
    if (state === 'naive') return scoreNaive(vector, defaultReferences, k)
    return scoreWithPool(vector)
  })
}

// Probe the environment as soon as this module is imported: in production this
// starts loading the index right away (so /ready can flip to 200 sooner); in
// test/dev it just sets state = 'naive' synchronously.
ensureInitialized()
