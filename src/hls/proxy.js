import { isM3u8Resource, isPoisonPlaylist, shouldProxyPlaylistUri } from '../embed/media.js'
import { upstreamFetch } from '../embed/upstream.js'
import { getSession, refreshSessionToken, rewriteUrlWithNewToken } from './sessions.js'

const PROXY = '/api/hls'
const BUNNY_DOMAIN = 'https://segmental.b-cdn.net'

// In-flight dedup — prevents thundering-herd for the same upstream URL
const playlistInflight = new Map()

// ── URL helpers ─────────────────────────────────────────────────────

function absMediaUrl(uri, baseUrl) {
  return uri.startsWith('http') ? uri : new URL(uri, baseUrl).href
}

function proxyQuery(abs, embedPath, origin, sessionId) {
  const params = new URLSearchParams({ url: abs })
  if (embedPath) params.set('embed', embedPath)
  if (sessionId) params.set('session', sessionId)
  const path = `${PROXY}?${params}`
  return origin ? `${origin}${path}` : path
}

// ── Segment helpers ─────────────────────────────────────────────────

function findTsOffset(buf) {
  for (let i = 0; i < Math.min(buf.length, 65536); i++) {
    if (buf[i] === 0x47 && i + 188 < buf.length && buf[i + 188] === 0x47) return i
  }
  return -1
}

function stripSegmentPayload(buf) {
  if (buf.length < 4 || buf[0] === 0x47) return buf
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const iend = buf.indexOf(Buffer.from('IEND'))
    if (iend >= 0 && iend + 8 < buf.length) return buf.subarray(iend + 8)
  }
  const tsAt = findTsOffset(buf)
  if (tsAt >= 0) return buf.subarray(tsAt)
  return buf
}

function segmentBody(body) {
  const stripped = stripSegmentPayload(body)
  if (stripped.length >= 188 && stripped[0] === 0x47) return stripped
  throw new Error('invalid segment payload')
}

// ── Live playlist trimming ──────────────────────────────────────────

function holdBackLiveMediaPlaylist(text, holdSegments = 1) {
  if (!text.includes('#EXTINF:') || text.includes('#EXT-X-ENDLIST') || text.includes('#EXT-X-STREAM-INF')) {
    return text
  }

  const lines = text.split('\n')
  const header = []
  const entries = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('#EXTINF:')) {
      const uriLine = lines[i + 1]?.trim()
      if (uriLine && !uriLine.startsWith('#')) {
        entries.push([line, lines[i + 1]])
        i += 2
        continue
      }
    }
    if (!entries.length) header.push(line)
    i += 1
  }

  if (entries.length <= holdSegments) return text

  const kept = entries.slice(0, -holdSegments)
  const out = [...header]
  for (const [extinf, uri] of kept) {
    out.push(extinf, uri)
  }
  return out.join('\n')
}

// ── M3U8 rewriting ──────────────────────────────────────────────────

function rewriteM3u8(text, baseUrl, embedPath, origin, sessionId) {
  const synced = holdBackLiveMediaPlaylist(text)
  const lines = synced.split('\n')
  const out = []
  let segmentLines = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      out.push(line)
      continue
    }
    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#EXT-X-MAP:')) {
        out.push(
          trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
            const abs = absMediaUrl(uri, baseUrl)
            // Point MAP initialization segments directly to Bunny CDN
            const urlObj = new URL(abs)
            return `URI="${BUNNY_DOMAIN}${urlObj.pathname}${urlObj.search}"`
          }),
        )
      } else {
        out.push(line)
      }
      continue
    }
    
    const abs = absMediaUrl(trimmed, baseUrl)

    // Check if it's a playlist (.m3u8) or a media segment (.ts, .m4s)
    if (isM3u8Resource(abs)) {
      // PLAYLIST LOGIC: Check if we should proxy it through our worker
      if (!shouldProxyPlaylistUri(abs, baseUrl)) {
        out.push(abs)
      } else {
        out.push(proxyQuery(abs, embedPath, origin, sessionId))
      }
    } else {
      // SEGMENT LOGIC: ALWAYS rewrite to Bunny CDN Pull Zone
      try {
        const urlObj = new URL(abs)
        out.push(`${BUNNY_DOMAIN}${urlObj.pathname}${urlObj.search}`)
        segmentLines += 1
      } catch (e) {
        // Fallback just in case the URL parsing fails
        out.push(abs)
        segmentLines += 1
      }
    }
  }

  if (text.includes('#EXTINF:') && segmentLines === 0) {
    throw new Error(isPoisonPlaylist(Buffer.from(synced)) ? 'upstream playlist blocked' : 'playlist has no stream segments')
  }
  return out.join('\n')
}

// ── Content detection ───────────────────────────────────────────────

function isPlaylist(targetUrl, contentType, body) {
  const text = body.toString('utf8', 0, Math.min(body.length, 256))
  if (text.includes('#EXTM3U')) return true
  return (
    isM3u8Resource(targetUrl, contentType) ||
    (contentType.includes('text/plain') && text.includes('#EXT'))
  )
}

// ── Response headers ────────────────────────────────────────────────

const corsHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Access-Control-Allow-Origin': '*',
}

const segmentHeaders = () => ({
  ...corsHeaders,
  'Content-Type': 'video/mp2t',
})

// ── Token-expiry detection ──────────────────────────────────────────

const TOKEN_EXPIRY_RE = /\b(403|401|410|blocked|forbidden)\b/i

function isTokenExpiryError(err) {
  return TOKEN_EXPIRY_RE.test(String(err?.message || ''))
}

// ── Core fetching ───────────────────────────────────────────────────

async function proxySegment(targetUrl, embedPath) {
  const upstream = await upstreamFetch(targetUrl, embedPath)
  if (upstream.status < 200 || upstream.status >= 300) throw new Error(`upstream ${upstream.status}`)
  return { status: 200, headers: segmentHeaders(), body: segmentBody(upstream.body) }
}

/**
 * Fetch a playlist from upstream, rewrite it, and return the proxied response.
 * Uses in-flight dedup so concurrent requests for the same URL share one fetch.
 */
async function fetchPlaylist(targetUrl, embedPath, origin, sessionId) {
  const inflightKey = targetUrl

  if (playlistInflight.has(inflightKey)) {
    return playlistInflight.get(inflightKey)
  }

  const request = (async () => {
    const upstream = await upstreamFetch(targetUrl, embedPath)
    if (upstream.status < 200 || upstream.status >= 300) throw new Error(`upstream ${upstream.status}`)
    const contentType = upstream.headers['content-type'] || upstream.headers['Content-Type'] || ''

    if (isPlaylist(targetUrl, contentType, upstream.body)) {
      return {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/vnd.apple.mpegurl',
        },
        body: rewriteM3u8(upstream.body.toString('utf8'), targetUrl, embedPath, origin, sessionId),
      }
    }
    return { status: 200, headers: segmentHeaders(), body: segmentBody(upstream.body) }
  })()

  playlistInflight.set(inflightKey, request)
  try {
    return await request
  } finally {
    playlistInflight.delete(inflightKey)
  }
}

/**
 * Main entry point for proxying an HLS request.
 *
 * If the upstream fetch fails with a token-expiry error and a session is
 * available, automatically re-resolves a fresh stream URL for the embed path,
 * rewrites the failing URL with the new token, and retries transparently.
 */
async function proxyHlsRequest(targetUrl, embedPath, origin, sessionId) {
  if (!isM3u8Resource(targetUrl)) return proxySegment(targetUrl, embedPath)

  try {
    return await fetchPlaylist(targetUrl, embedPath, origin, sessionId)
  } catch (err) {
    // ── Auto-refresh on token expiry ──────────────────────────────
    if (sessionId && isTokenExpiryError(err)) {
      const session = getSession(sessionId)
      if (session) {
        const oldStreamUrl = session.streamUrl
        const newStreamUrl = await refreshSessionToken(sessionId)

        if (newStreamUrl && newStreamUrl !== oldStreamUrl) {
          const newTargetUrl = rewriteUrlWithNewToken(targetUrl, oldStreamUrl, newStreamUrl)
          if (newTargetUrl && newTargetUrl !== targetUrl) {
            console.log(`[session ${sessionId.slice(0, 8)}] retrying with refreshed token`)
            return await fetchPlaylist(newTargetUrl, embedPath, origin, sessionId)
          }
        }
      }
    }
    throw err
  }
}

export async function writeProxyHlsResponse(res, targetUrl, embedPath, origin, sessionId) {
  const proxied = await proxyHlsRequest(targetUrl, embedPath, origin, sessionId)
  if (res.headersSent) return
  res.writeHead(proxied.status, proxied.headers)
  res.end(proxied.body)
}
