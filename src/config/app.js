import Fastify from 'fastify'
import { fraudScoreSchema } from '../validation/fraud-score-schema.js'
import { vectorize } from '../scoring/vectorize.js'
import { score, isReady, ensureInitialized } from '../scoring/knn.js'

export function buildApp (opts = {}) {
  const fastify = Fastify({
    ajv: {
      customOptions: {
        // Strict validation: reject unknown props and don't coerce types
        removeAdditional: false,
        coerceTypes: false
      }
    },
    ...opts
  })

  fastify.get('/ready', function (request, reply) {
    // Kick off (idempotent) index loading and report status: 503 while the
    // binaries/workers are still coming up, 200 once the pool can serve queries.
    ensureInitialized()
    if (isReady()) reply.code(200).send({ status: 'ok' })
    else reply.code(503).send({ status: 'loading' })
  })

  fastify.post('/fraud-score', { schema: fraudScoreSchema }, async function (request, reply) {
    // Step 1: turn the validated payload into its normalized 14-dim vector.
    const vector = vectorize(request.body)

    // Step 2: k-NN over the reference set -> { approved, fraud_score }.
    // score() is sync in naive mode and a Promise on the worker-pool path;
    // awaiting handles both.
    reply.send(await score(vector))
  })

  return fastify
}
