import Fastify from 'fastify'

const fastify = Fastify({
  logger: true
})

fastify.get('/ready', function (request, reply) {
  reply.send({ hello: 'world' })
})


fastify.post('/fraud-score', function (request, reply) {
  reply.send({
    "approved": false,
    "fraud_score": 1.0
})
})

fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})