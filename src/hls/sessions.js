import crypto from 'node:crypto'
import { resolveEmbedStreamUrl } from '../embed/decrypt.js'

const SESSION_TTL_MS = 4 * 60 * 60 * 1000   // 4 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000   // 10 minutes
const MIN_REFRESH_INTERVAL_MS = 30_000        // 30s between refreshes per session

const sessions = new Map()

// ── Periodic cleanup of expired sessions ────────────────────────────
const cleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      sessions.delete(id)
    }
  }
}, CLEANUP_INTERVAL_MS)
cleanupTimer.unref()

// ── Public API ──────────────────────────────────────────────────────

export function createSession(embedPath, streamUrl) {
  const id = crypto.randomUUID()
  sessions.set(id, {
    embedPath,
    streamUrl,
    resolvedAt: Date.now(),
    lastAccess: Date.now(),
    _refreshLock: null,
  })
  return id
}

export function getSession(id) {
  if (!id) return null
  const session = sessions.get(id)
  if (!session) return null
  session.lastAccess = Date.now()
  return session
}

export function sessionCount() {
  return sessions.size
}

/**
 * Refresh the stream URL for a session by re-resolving the embed path.
 *
 * - Rate-limited: at most one refresh per MIN_REFRESH_INTERVAL_MS per session.
 * - Concurrent callers share the same in-flight refresh promise.
 * - On failure, returns the current (stale) URL so the caller can decide.
 */
export async function refreshSessionToken(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return null

  const now = Date.now()

  // Rate limit — don't re-resolve too frequently
  if (now - session.resolvedAt < MIN_REFRESH_INTERVAL_MS) {
    return session.streamUrl
  }

  // Coalesce concurrent refresh calls
  if (session._refreshLock) {
    return session._refreshLock
  }

  session._refreshLock = (async () => {
    try {
      console.log(`[session ${sessionId.slice(0, 8)}] refreshing token for "${session.embedPath}"`)
      const newStreamUrl = await resolveEmbedStreamUrl(session.embedPath)
      const oldUrl = session.streamUrl
      session.streamUrl = newStreamUrl
      session.resolvedAt = Date.now()
      session.lastAccess = Date.now()
      console.log(`[session ${sessionId.slice(0, 8)}] token refreshed (changed=${oldUrl !== newStreamUrl})`)
      return newStreamUrl
    } catch (err) {
      console.error(`[session ${sessionId.slice(0, 8)}] token refresh failed:`, err.message)
      return session.streamUrl   // return stale URL as fallback
    } finally {
      session._refreshLock = null
    }
  })()

  return session._refreshLock
}

/**
 * Rewrite a URL by swapping the old /secure/<token> prefix for the new one.
 * Also handles the case where the upstream CDN domain changes.
 *
 * Returns null if rewriting is not possible or no change occurred.
 */
export function rewriteUrlWithNewToken(failedUrl, oldStreamUrl, newStreamUrl) {
  try {
    const oldUrl = new URL(oldStreamUrl)
    const newUrl = new URL(newStreamUrl)

    const oldMatch = oldUrl.pathname.match(/\/secure\/[^/]+/)
    const newMatch = newUrl.pathname.match(/\/secure\/[^/]+/)
    if (!oldMatch || !newMatch || oldMatch[0] === newMatch[0]) return null

    let rewritten = failedUrl

    // Domain may change between resolutions
    if (oldUrl.origin !== newUrl.origin) {
      rewritten = rewritten.replace(oldUrl.origin, newUrl.origin)
    }

    // Swap the secure token segment
    rewritten = rewritten.replace(oldMatch[0], newMatch[0])

    return rewritten !== failedUrl ? rewritten : null
  } catch {
    return null
  }
}
