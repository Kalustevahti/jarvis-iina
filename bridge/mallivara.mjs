/**
 * Model fallback for JARVIS's learning jobs (night memory consolidation, evening self-review, profile, skills).
 *
 * Why (8.11.2026): the night run failed 3 times with "Claude Code 2.1.220 does not support this model" — Opus was
 * unavailable to the installed SDK while Sonnet worked fine, so the whole night was lost. Now a learning call that fails
 * because the MODEL is unavailable (unsupported, not found, usage/rate limit, overloaded, or a timeout) is retried once with
 * the fallback model, and the switch is recorded so the morning report can say so.
 *
 * No project imports on purpose (used by muistiuni, tunne, itsearvio, taidot).
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

export const FALLBACK_MODEL = process.env.JARVIS_LEARN_FALLBACK_MODEL || 'claude-sonnet-5'

/** Errors where another model can help. A plain empty answer or a JSON problem is NOT one of these. Exported for tests. */
export const SWITCH_ERROR =
  /does not support this model|model[^.]{0,40}(not found|not_found|unavailable|does not exist|deprecated|retired|not supported)|not_found_error|invalid model|unknown model|usage limit|session limit|hit your (session |usage )?limit|rate.?limit|\b429\b|overloaded|\b529\b|capacity|aikakatkaisu|aborted/i

const notes = []
/** Fallback switches since the last call (for the morning report). */
export function takeFallbackNotes() {
  return notes.splice(0, notes.length)
}

/** One model call. Returns { text, error, aborted }. Never throws. */
export async function askOnce({ prompt, options, timeoutMs }) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  let text = ''
  let error = ''
  try {
    const s = query({ prompt, options: { ...options, abortController: abort } })
    for await (const m of s) {
      if (m.type !== 'result') continue
      if (m.subtype === 'success' && !m.is_error) text = String(m.result ?? '')
      else error = String(m.result ?? m.error ?? m.subtype ?? 'error')
    }
  } catch (err) {
    error = String(err?.message ?? err)
  } finally {
    clearTimeout(timer)
  }
  if (abort.signal.aborted && !text) error = `aikakatkaisu ${Math.round(timeoutMs / 60_000) || '<1'} min${error ? ` (${error.slice(0, 80)})` : ''}`
  return { text: text.trim(), error, aborted: abort.signal.aborted }
}

/**
 * Model call with one fallback. `label` goes to the log ("muisti-uni", "tunne", …).
 * Returns the text, or '' when both failed (callers treat '' as "not done" and retry later).
 */
export async function askWithFallback({ prompt, options, timeoutMs, label, fallback = FALLBACK_MODEL }) {
  const first = await askOnce({ prompt, options, timeoutMs })
  if (first.text) return first.text
  const primary = options?.model ?? ''
  const why = (first.error || 'tyhjä vastaus').replace(/\s+/g, ' ').slice(0, 160)
  if (!first.error || !SWITCH_ERROR.test(first.error) || !fallback || primary === fallback) {
    if (first.error) console.warn(`[jarvis] ${label}: mallikutsu epäonnistui (${primary}): ${why}`)
    return ''
  }
  console.warn(`[jarvis] ${label}: ${primary} ei käytettävissä (${why}) → varamalli ${fallback}`)
  const second = await askOnce({ prompt, options: { ...options, model: fallback }, timeoutMs })
  if (second.text) {
    notes.push({ label, primary, fallback, why, at: new Date().toISOString() })
    console.log(`[jarvis] ${label}: varamalli ${fallback} vastasi`)
    return second.text
  }
  console.warn(`[jarvis] ${label}: myös varamalli ${fallback} epäonnistui: ${(second.error || 'tyhjä vastaus').slice(0, 160)}`)
  return ''
}
