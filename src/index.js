import { buildApp } from './config/app.js'

const server = buildApp({ logger: true })

server.listen({ port: 3000, host: '0.0.0.0' }, function (err) {
if (err) {
    server.log.error(err)
    process.exit(1)
}
})
