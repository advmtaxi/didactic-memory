import http from 'node:http'
import { handleRequest } from './http/router.js'

const port = Number(process.env.PORT || 8788)
const host = process.env.HOST || '127.0.0.1'

http.createServer(handleRequest).listen(port, host, () => {
  console.log(`ppv-stream-resolver http://${host}:${port}`)
})
