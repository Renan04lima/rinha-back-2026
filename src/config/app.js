import Fastify from 'fastify'
import { fraudScoreSchema } from '../validation/fraud-score-schema.js'
import { vectorize } from '../scoring/vectorize.js'
import { score } from '../scoring/knn.js'

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
    reply.send({ status: 'ok' })
  })

  fastify.post('/fraud-score', { schema: fraudScoreSchema }, function (request, reply) {
    // Step 1: turn the validated payload into its normalized 14-dim vector.
    const vector = vectorize(request.body)

    // Step 2: k-NN over the reference set -> { approved, fraud_score }.
    reply.send(score(vector))
  })

  return fastify
}
