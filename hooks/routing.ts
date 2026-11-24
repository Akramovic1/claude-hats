// Sending a model request out as another account: which requests count (only
// those to Anthropic's own API), and what their headers become. No I/O.

// The one place another account's token may ever be sent.
const API_HOST = 'api.anthropic.com'
const MODEL_PATHS = ['/v1/messages', '/v1/messages/count_tokens']

/**
 * A model request to Anthropic's own API: the Messages API and its token
 * counter, over https, on Anthropic's host and no other. Where Claude Code is
 * pointed at another base URL (a gateway, a proxy, a cloud provider), nothing
 * is rerouted: a token must never travel to a host it was not issued for.
 */
export function isInference(url: string): boolean {
  try {
    const u = new URL(url)

    return u.protocol === 'https:' && u.hostname === API_HOST && u.port === '' && MODEL_PATHS.includes(u.pathname)
  } catch {
    return false
  }
}

/** Headers with Authorization set to `token`, any other credential header dropped. */
export function withAccount(
  headers: Record<string, string> | undefined,
  token: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (!/^(authorization|x-api-key)$/i.test(k)) out[k] = v
  }
  out.Authorization = `Bearer ${token}`
  return out
}

/** An account id is also a file name (its token's), so it holds nothing a path could abuse. */
export function isAccountId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)
}

/** A new account's id, from the moment it is added. */
export function newAccountId(t: number): string {
  return `acct-${Math.floor(t).toString(36)}`
}

/** A name as the person typed it, tidied: one line, trimmed, at most 32 characters. */
export function cleanName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 32)
}
