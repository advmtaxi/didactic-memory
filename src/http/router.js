import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeProxyHlsResponse } from '../hls/proxy.js'
import { resolveStream } from '../stream/resolve.js'

const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/index.html')

function requestOrigin(req) {
  const host = req.headers.host || '127.0.0.1:8788'
  const forwarded = req.headers['x-forwarded-proto']
  const proto =
    typeof forwarded === 'string'
      ? forwarded.split(',')[0].trim()
      : host.startsWith('127.0.0.1') || host.startsWith('localhost')
        ? 'http'
        : 'https'
  return `${proto}://${host}`
}

function json(res, status, body) {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(body))
}

function text(res, status, message) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'text/plain' })
  res.end(message)
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return JSON.parse(body)
}

export async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1:8788'}`)
  const origin = requestOrigin(req)

  try {
    if (url.pathname === '/api/hls') {
      const target = url.searchParams.get('url')
      if (!target) return json(res, 400, { error: 'url required' })
      try {
        await writeProxyHlsResponse(res, target, url.searchParams.get('embed') || undefined, origin)
      } catch (err) {
        text(res, 502, String(err.message || 'upstream error'))
      }
      return
    }

    if (url.pathname === '/api/stream') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' })
      const payload = await readJson(req).catch(() => null)
      return json(res, 200, await resolveStream(payload, origin))
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      fs.createReadStream(indexPath).pipe(res)
      return
    }

    text(res, 404, 'not found')
  } catch (err) {
    json(res, 500, { ok: false, error: String(err.message || err) })
  }
}
