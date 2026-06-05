import { buildApp } from './config/app.js'

const server = buildApp({ logger: true })

server.listen({ port: 9999, host: '0.0.0.0' }, function (err) {
if (err) {
    server.log.error(err)
    process.exit(1)
}
})
