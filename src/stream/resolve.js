import { resolveEmbedStreamUrl } from '../embed/decrypt.js'

const fail = (stage, error, extra = {}) => ({ ok: false, stage, error, ...extra })

function parseEmbedInput(input) {
  const raw =
    typeof input === 'string'
      ? input
      : input?.url || input?.embedPath || input?.path || ''
  if (!raw) return { error: 'embed url or path required' }

  let embedPath = String(raw).trim()

  // Accept full embedindia.st URLs — extract path after /embed/
  if (/^https?:\/\//i.test(embedPath)) {
    try {
      const u = new URL(embedPath)
      const m = u.pathname.match(/^\/embed\/(.+)/)
      if (m) {
        embedPath = m[1]
      } else {
        embedPath = u.pathname.replace(/^\/+/, '')
      }
    } catch {
      return { error: 'invalid url' }
    }
  } else {
    // Strip leading /embed/ if passed as a path string
    embedPath = embedPath.replace(/^\/embed\//, '').replace(/^\/+/, '')
  }

  if (!embedPath) return { error: 'embed path required' }
  return { embedPath }
}

function proxiedHlsUrl(origin, streamUrl, embedPath) {
  const params = new URLSearchParams({ url: streamUrl })
  if (embedPath) params.set('embed', embedPath)
  return `${origin}/api/hls?${params}`
}

export async function resolveStream(input, origin) {
  const parsed = parseEmbedInput(input)
  if (parsed.error) return fail('input', parsed.error)

  const { embedPath } = parsed
  try {
    const streamUrl = await resolveEmbedStreamUrl(embedPath)
    const result = { ok: true, embedPath, streamUrl }
    if (origin) result.proxiedUrl = proxiedHlsUrl(origin, streamUrl, embedPath)
    return result
  } catch (err) {
    return fail('decrypt', String(err.message || err), { embedPath })
  }
}
