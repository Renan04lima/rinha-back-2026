import Fastify from 'fastify'
import { fraudScoreSchema } from '../validation/fraud-score-schema.js'

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
    reply.send({
      approved: false,
      fraud_score: 1.0
    })
  })

  return fastify
}
