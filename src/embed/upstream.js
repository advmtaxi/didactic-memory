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

function getClient() {
  if (!client) client = new Impit({ browser: 'chrome' })
  return client
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
  const res = await getClient().fetch(url, {
    headers: upstreamHeaders(embedPath),
    redirect: 'follow',
  })
  const result = {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: Buffer.from(await res.arrayBuffer()),
  }
  if (result.status >= 200 && result.status < 300 && okBody(result.body, url)) return result
  if (isPoisonPlaylist(result.body)) throw new Error('upstream playlist blocked')
  throw new Error(`upstream ${result.status}`)
}
