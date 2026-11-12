/**
 * Shared scheduler for the evening learners (itsearvio 23.15, tunne 23.40, taidot 23.50).
 * No project imports on purpose: muisti.mjs ↔ tunne.mjs ↔ itsearvio.mjs would otherwise form an import cycle.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const day = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki' }).format(d)

// ---------------------------------------------------------------------------------------------
// Why this exists.
// Old behaviour: "if lastDay !== today and it is past HH:MM, mark today done and run" → a PC that was
// asleep at that time never learned that day (6.11.2026: all three skipped). New behaviour:
//   - every day from lastDay+1 up to yesterday is due at ANY time of day (catch-up, max 3 days back),
//   - today is due only after the start time,
//   - a day is marked done only after the job finished (returned without throwing); a throwing job
//     is retried on the next tick, at most 2 attempts per day, then the day is skipped with a log line.
// ---------------------------------------------------------------------------------------------

const EVENING_MAX_BACK = 3
const EVENING_MAX_ATTEMPTS = 2
const addDays = (ymd, n) => day(new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400_000))

/** Days due for processing, oldest first. Exported for tests. */
const EVENING_RETRY_MS = 30 * 60_000
export function dueDays(st, { today = day(), hh, mm, startH, startM, maxBack = EVENING_MAX_BACK, nowMs = Date.now() } = {}) {
  const earliest = addDays(today, -maxBack)
  let from = st.lastDay && /^\d{4}-\d{2}-\d{2}$/.test(st.lastDay) ? addDays(st.lastDay, 1) : addDays(today, -1)
  if (from < earliest) from = earliest
  const out = []
  for (let d = from; d <= today; d = addDays(d, 1)) {
    if (d === today && (hh < startH || (hh === startH && mm < startM))) break
    if ((st.attempts?.[d] ?? 0) >= EVENING_MAX_ATTEMPTS) continue
    // A failed attempt (model limit, timeout) is retried after 30 min, not on the very next tick.
    if ((st.attempts?.[d] ?? 0) > 0 && st.attemptAt?.[d] && nowMs - Date.parse(st.attemptAt[d]) < EVENING_RETRY_MS) break
    out.push(d)
  }
  return out
}

/** Runs `job(date)` for each due day and keeps the state file honest. Returns the number of days completed. */
export function makeEveningWatcher({ name, stateFile, startH, startM, job, tickMs = 10 * 60_000 }) {
  const load = () => {
    try {
      return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
    } catch {
      return {}
    }
  }
  const save = (st) => {
    try {
      writeFileSync(stateFile, JSON.stringify(st))
    } catch {
      /* ok */
    }
  }
  let running = false
  const tick = async (now = new Date()) => {
    if (running) return 0
    running = true
    let done = 0
    try {
      const today = day(now)
      const hh = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', hour12: false }).format(now)) % 24
      const mm = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', minute: '2-digit' }).format(now))
      for (const d of dueDays(load(), { today, hh, mm, startH, startM, nowMs: now.getTime() })) {
        const st = load()
        st.attempts = { ...(st.attempts ?? {}), [d]: (st.attempts?.[d] ?? 0) + 1 }
        st.attemptAt = { ...(st.attemptAt ?? {}), [d]: now.toISOString() }
        for (const k of Object.keys(st.attempts)) if (k < addDays(today, -EVENING_MAX_BACK - 1)) delete st.attempts[k]
        for (const k of Object.keys(st.attemptAt)) if (k < addDays(today, -EVENING_MAX_BACK - 1)) delete st.attemptAt[k]
        save(st)
        const late = d !== today
        try {
          await job(d)
          const st2 = load()
          if (!st2.lastDay || st2.lastDay < d) st2.lastDay = d
          save(st2)
          done++
          if (late) console.log(`[jarvis] ${name}: päivä ${d} opittu jälkikäteen (kone ei ollut päällä illalla)`)
        } catch (err) {
          const n = st.attempts[d]
          console.warn(`[jarvis] ${name}: päivä ${d} epäonnistui (yritys ${n}/${EVENING_MAX_ATTEMPTS}):`, err?.message ?? err)
          if (n >= EVENING_MAX_ATTEMPTS) {
            const st3 = load()
            if (!st3.lastDay || st3.lastDay < d) st3.lastDay = d
            save(st3)
          }
          break // the next day would run against the same failing cause; try again on the next tick
        }
      }
    } finally {
      running = false
    }
    return done
  }
  const t = setInterval(() => void tick(), tickMs)
  t.unref?.()
  return { stop: () => clearInterval(t), tick }
}

