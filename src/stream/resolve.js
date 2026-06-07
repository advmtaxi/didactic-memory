import { API_BASE, USER_AGENT } from '../config.js'
import { resolveEmbedStreamUrl } from '../embed/decrypt.js'

const fail = (stage, error, extra = {}) => ({ ok: false, stage, error, ...extra })

function parseStreamInput(input) {
  const raw =
    typeof input === 'string'
      ? input
      : input?.url || input?.contentPath || input?.path || input?.uri || ''
  if (!raw) return { error: 'url required' }

  let pathname = String(raw).trim()
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname
    } catch {
      return { error: 'invalid url' }
    }
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`

  let uri = pathname.replace(/^\/+/, '')
  if (uri.startsWith('live/')) uri = uri.slice(5)
  uri = uri.replace(/^24\/7-/i, '247-')
  if (!uri) return { error: 'url required' }

  return { uri, contentPath: pathname }
}

async function fetchStreamMeta(uri) {
  const res = await fetch(`${API_BASE}/streams/${uri}`, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) return { error: `upstream ${res.status}` }
  let json
  try {
    json = await res.json()
  } catch {
    return { error: 'invalid stream metadata response' }
  }
  if (!json?.success || !json?.data) return { error: json?.error || 'empty stream payload' }
  return { data: json.data }
}

function pickEmbedSource(data) {
  const sources = data?.sources || []
  return sources.find((s) => s.default) || sources.find((s) => s.type === 'iframe') || sources[0] || null
}

function embedPathFromSource(source, uri) {
  const raw = String(source?.data || '')
  if (raw.includes('/embed/')) {
    const path = new URL(raw).pathname.replace(/^\/embed\//, '')
    if (path) return path
  }
  return uri
}

function proxiedHlsUrl(origin, streamUrl, embedPath) {
  const params = new URLSearchParams({ url: streamUrl })
  if (embedPath) params.set('embed', embedPath)
  return `${origin}/api/hls?${params}`
}

export async function resolveStream(input, origin) {
  const parsed = parseStreamInput(input)
  if (parsed.error) return fail('input', parsed.error)

  const { uri, contentPath } = parsed
  const meta = await fetchStreamMeta(uri)
  if (meta.error) return fail('meta', meta.error, { uri, contentPath })

  const source = pickEmbedSource(meta.data)
  if (!source?.data) return fail('source', 'no embed source in api response', { uri, contentPath })

  const embedPath = embedPathFromSource(source, uri)
  try {
    const streamUrl = await resolveEmbedStreamUrl(embedPath)
    const result = { ok: true, uri, contentPath, embedPath, streamUrl }
    if (origin) result.proxiedUrl = proxiedHlsUrl(origin, streamUrl, embedPath)
    return result
  } catch (err) {
    return fail('decrypt', String(err.message || err), { uri, contentPath, embedPath })
  }
}
