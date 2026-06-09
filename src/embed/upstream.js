import { Impit } from 'impit'
import { EMBED_ORIGIN, USER_AGENT } from '../config.js'
import {
  isM3u8Resource,
  isPlayablePlaylist,
  isPoisonPlaylist,
  isSegmentBody,
  sniffMedia,
} from './media.js'

let client = null
const FETCH_TIMEOUT_MS = Number(process.env.HLS_FETCH_TIMEOUT_MS || 12000)
const FETCH_RETRIES = Math.max(0, Number(process.env.HLS_FETCH_RETRIES || 2))

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527])

function getClient() {
  if (!client) client = new Impit({ browser: 'chrome' })
  return client
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`upstream timeout after ${ms}ms`)), ms)),
  ])
}

function isTransientError(error) {
  const msg = String(error?.message || error || '').toLowerCase()
  return (
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('socket') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('ehostunreach') ||
    msg.includes('etimedout')
  )
}

function upstreamHeaders(embedPath) {
  const referer = embedPath ? `${EMBED_ORIGIN}/embed/${embedPath}` : `${EMBED_ORIGIN}/`
  return {
    Referer: referer,
    Origin: EMBED_ORIGIN,
    'User-Agent': USER_AGENT,
    Accept: '*/*',
  }
}

function isHtmlBody(body) {
  const head = body.toString('utf8', 0, 200).toLowerCase()
  return head.includes('<html') || head.includes('403 forbidden')
}

function okBody(body, url) {
  if (!body?.length || isHtmlBody(body)) return false
  if (isM3u8Resource(url) || sniffMedia(body).kind === 'playlist') {
    return isPlayablePlaylist(body) && !isPoisonPlaylist(body)
  }
  return isSegmentBody(body) || sniffMedia(body).kind === 'binary'
}

export async function upstreamFetch(url, embedPath) {
  let lastResult = null
  let lastError = null
  const attempts = FETCH_RETRIES + 1

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await withTimeout(
        getClient().fetch(url, {
          headers: upstreamHeaders(embedPath),
          redirect: 'follow',
        }),
        FETCH_TIMEOUT_MS,
      )

      const result = {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: Buffer.from(await res.arrayBuffer()),
      }
      lastResult = result

      if (result.status >= 200 && result.status < 300) {
        if (okBody(result.body, url)) return result
        if (isPoisonPlaylist(result.body)) throw new Error('upstream playlist blocked')
      }

      if (attempt < attempts - 1 && (TRANSIENT_STATUS.has(result.status) || isHtmlBody(result.body))) {
        await wait(150 * (attempt + 1))
        continue
      }

      if (isPoisonPlaylist(result.body)) throw new Error('upstream playlist blocked')
      throw new Error(`upstream ${result.status}`)
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1 && isTransientError(error)) {
        await wait(150 * (attempt + 1))
        continue
      }
      throw error
    }
  }

  if (lastResult) {
    if (isPoisonPlaylist(lastResult.body)) throw new Error('upstream playlist blocked')
    throw new Error(`upstream ${lastResult.status}`)
  }
  throw lastError || new Error('upstream unavailable')
}
