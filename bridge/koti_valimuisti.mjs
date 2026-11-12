/**
 * Kodin laitetilan välimuisti (9.11.2026): stale-while-revalidate laitekohtaisesti. Puhdas moduuli ilman
 * laiteyhteyksiä (koti.mjs antaa laitefunktiot), jotta sen voi testata ilman laitteita.
 *
 *   devices[laite] = { on: () => bool, ms: aikaraja, ttl: kuinka vanha tila kelpaa ilman taustahakua, fn: () => Promise<tila>,
 *                      offline?: (tila) => bool — true = "pois", seuraava tarkistus vasta offlineMs:n päästä }
 *
 * Välimuistin osissa on `paivitetty` (ms epoch) ja `kesto` (montako ms laite vastasi): "päivitetty 12 s sitten".
 */

export const withTimeout = (p, ms, label) => {
  let t
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${label} ei vastannut ${Math.round(ms / 1000)} s:ssa`)), ms)))]).finally(() =>
    clearTimeout(t),
  )
}
/** Resolves when p settles or after ms, whichever is first; the timer never outlives the wait. */
const settledWithin = (p, ms) => {
  let t
  return Promise.race([p, new Promise((r) => (t = setTimeout(r, ms)))]).finally(() => clearTimeout(t))
}
export const errMsg = (e) => String(e?.message ?? e).slice(0, 160)

const pick = (st, ...codes) => codes.find((c) => c in st)
/** Tuya status codes → lamp row for the UI. */
export function lampFromStatus(d, st) {
  const b = st[pick(st, 'bright_value_v2', 'bright_value') ?? '']
  const scale = 'bright_value_v2' in st ? 1000 : 255
  return {
    nimi: d.name,
    online: true,
    paalla: Boolean(st[pick(st, 'switch_led', 'switch_1', 'switch') ?? '']),
    kirkkaus: b != null ? Math.round((Number(b) / scale) * 100) : null,
    vari: st.work_mode === 'colour',
  }
}

export function createHomeCache({ devices, now = Date.now, log = (s) => console.log(s), firstWaitMs = 1500, offlineMs = 60_000, waitCapMs = 20_000 }) {
  const cache = new Map()
  const inflight = new Map()
  const backoffUntil = new Map()
  const subs = new Set()
  const emit = (laite, tila) => {
    for (const fn of subs) {
      try {
        fn({ laite, tila, at: tila.paivitetty ?? now() })
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  }

  const installed = (laite) => {
    try {
      return Boolean(devices[laite]?.on())
    } catch {
      return false
    }
  }

  function refresh(laite, { force = false } = {}) {
    const d = devices[laite]
    if (!d || !installed(laite)) return Promise.resolve(null)
    if (inflight.has(laite)) return inflight.get(laite)
    const prev = cache.get(laite)
    if (!force && prev) {
      if ((backoffUntil.get(laite) ?? 0) > now()) return Promise.resolve(prev)
      if (now() - prev.paivitetty < (d.ttl ?? 5000)) return Promise.resolve(prev)
    }
    const t0 = now()
    const p = (async () => {
      let tila
      try {
        tila = { ...(await withTimeout(Promise.resolve().then(d.fn), d.ms, laite)), asennettu: true }
      } catch (e) {
        // Offline-type devices (projector, TV) read as "pois"; others keep their last known state with the error.
        const { virhe: _old, ...rest } = prev ?? {}
        tila = d.offline ? { tila: 'pois', asennettu: true, virhe: errMsg(e) } : { ...rest, asennettu: true, virhe: errMsg(e) }
      }
      const kesto = now() - t0
      tila.paivitetty = now()
      tila.kesto = kesto
      if (d.offline?.(tila)) backoffUntil.set(laite, now() + offlineMs)
      else backoffUntil.delete(laite)
      cache.set(laite, tila)
      log(`[jarvis] koti: ${laite} ${kesto} ms`)
      emit(laite, tila)
      return tila
    })().finally(() => inflight.delete(laite))
    inflight.set(laite, p)
    return p
  }

  const partOf = (laite) => (!installed(laite) ? { asennettu: false } : (cache.get(laite) ?? { asennettu: true, haetaan: true }))

  return {
    refresh,
    /** Snapshot of every device (or the listed ones) without waiting. */
    snapshot(laitteet = Object.keys(devices)) {
      return Object.fromEntries(laitteet.map((l) => [l, partOf(l)]))
    },
    /**
     * Answer from the cache and refresh in the background. Waits only when this call starts a device's very first
     * fetch (at most firstWaitMs), or when odota=true (until the refresh finishes, at most waitCapMs).
     * Without laite, imuri is never forced: only vacuum commands and laite:'imuri' force the slow Roborock query.
     */
    async get({ laite, force = false, odota = false } = {}) {
      const list = laite ? [laite].filter((l) => l in devices) : Object.keys(devices)
      const missing = list.some((l) => installed(l) && !cache.has(l) && !inflight.has(l))
      const jobs = list.map((l) => refresh(l, { force: force && (Boolean(laite) || l !== 'imuri') }))
      if (odota || missing) await settledWithin(Promise.allSettled(jobs), odota ? waitCapMs : firstWaitMs)
      return Object.fromEntries(Object.keys(devices).map((l) => [l, partOf(l)]))
    },
    /** A command to the device: check it on the next request even if it was marked offline. */
    clearBackoff(laite) {
      backoffUntil.delete(laite)
    },
    /** Next request fetches fresh (vacuum command). */
    invalidate(laite) {
      const c = cache.get(laite)
      if (c) cache.set(laite, { ...c, paivitetty: 0 })
    },
    /** Merge fields into a device's cached part and push it now (e.g. projector "heraa"), without a device query. */
    patch(laite, fields) {
      const tila = { ...(cache.get(laite) ?? { asennettu: installed(laite) }), ...fields }
      if (cache.has(laite)) cache.set(laite, tila)
      emit(laite, tila)
      return tila
    },
    /** Push a part that is not a cached device (routine progress), straight to the listeners. */
    publish(laite, tila) {
      emit(laite, { ...tila, paivitetty: now() })
    },
    backedOff: (laite) => (backoffUntil.get(laite) ?? 0) > now(),
    onUpdate(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}
