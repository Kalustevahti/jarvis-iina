/**
 * JARVIS-sivun PIN-kirjautuminen (9.11.2026, Eliaksen hyväksymä).
 *
 * - PIN tarkistetaan scrypt-tiivisteestä (asetukset\sivu_pin.json: alg, N, r, p, keylen, salt, hash). PINiä ei
 *   tallenneta eikä lokiteta selväkielisenä missään.
 * - Oikea PIN → satunnainen 32-tavuinen laitetunniste. Vain sen SHA-256 tallennetaan (~/.jarvis/sivu_laitteet.json)
 *   luontiajan ja laitekuvauksen kanssa. Voimassa 30 päivää.
 * - Väärä PIN: enintään 5 / IP / 15 min, sitten 15 min lukitus. Lukitus koskee vain PIN-yrityksiä; jo kirjautuneen
 *   laitteen tunniste toimii (sitä ei voi arvata).
 * - PIN-tiedosto puuttuu tai on rikki → kaikki estetään (fail closed), myös tunnisteet.
 *
 * Testattavissa: createPinAuth({ pinFile, devicesFile, now, notify }).
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PIN_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'asetukset', 'sivu_pin.json')
export const DEFAULT_DEVICES_FILE = join(homedir(), '.jarvis', 'sivu_laitteet.json')

const TOKEN_DAYS = 30
const MAX_FAILS = 5
const WINDOW_MS = 15 * 60_000
const LOCK_MS = 15 * 60_000

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex')

/** Lyhyt laitekuvaus user-agentista: "iPhone · Safari", "Windows · Edge". */
export function deviceLabel(ua = '') {
  const u = String(ua)
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Macintosh|Mac OS/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'Tuntematon'
  const br = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'selain'
  return `${os} · ${br}`
}

export function createPinAuth({ pinFile = DEFAULT_PIN_FILE, devicesFile = DEFAULT_DEVICES_FILE, now = () => Date.now(), notify = () => {} } = {}) {
  /** IP → { fails: number[], lockedUntil } */
  const tries = new Map()
  const revokeListeners = new Set()

  /** Reads and validates the PIN file. null = no access (reason logged). */
  function loadPin() {
    try {
      if (!existsSync(pinFile)) throw new Error('tiedosto puuttuu')
      const c = JSON.parse(readFileSync(pinFile, 'utf8'))
      const ok =
        c?.alg === 'scrypt' &&
        Number.isInteger(c.N) && c.N >= 1024 && (c.N & (c.N - 1)) === 0 &&
        Number.isInteger(c.r) && c.r > 0 && Number.isInteger(c.p) && c.p > 0 &&
        Number.isInteger(c.keylen) && c.keylen >= 16 && c.keylen <= 128 &&
        /^[0-9a-f]{16,}$/i.test(String(c.salt)) && /^[0-9a-f]+$/i.test(String(c.hash)) && String(c.hash).length === c.keylen * 2
      if (!ok) throw new Error('kentät puuttuvat tai ovat virheellisiä')
      return c
    } catch (err) {
      console.warn(`[jarvis] sivu-PIN: ${pinFile} ei kelpaa (${err?.message ?? err}) — pääsy estetty kaikilta.`)
      return null
    }
  }

  function readDevices() {
    try {
      if (!existsSync(devicesFile)) return []
      const list = JSON.parse(readFileSync(devicesFile, 'utf8'))
      return Array.isArray(list) ? list.filter((d) => d && typeof d.hash === 'string') : []
    } catch {
      return []
    }
  }
  function writeDevices(list) {
    mkdirSync(dirname(devicesFile), { recursive: true })
    const tmp = devicesFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(list, null, 1))
    renameSync(tmp, devicesFile)
  }
  const alive = (d) => now() - Number(d.at ?? 0) < TOKEN_DAYS * 86_400_000

  function verifyPin(pin, c) {
    const got = scryptSync(String(pin), Buffer.from(c.salt, 'hex'), c.keylen, { N: c.N, r: c.r, p: c.p, maxmem: 256 * c.N * c.r + 1024 * 1024 })
    const want = Buffer.from(c.hash, 'hex')
    return got.length === want.length && timingSafeEqual(got, want)
  }

  /**
   * PIN attempt from ip. Returns { ok, token?, syy?, lukittuMs? }.
   * syy: 'ei_pinia' (file missing/broken), 'lukittu', 'vaara'.
   */
  function checkPin(pin, ip = '?', label = 'selain') {
    const c = loadPin()
    if (!c) return { ok: false, syy: 'ei_pinia' }
    const t = tries.get(ip) ?? { fails: [], lockedUntil: 0 }
    tries.set(ip, t)
    const n = now()
    if (t.lockedUntil > n) return { ok: false, syy: 'lukittu', lukittuMs: t.lockedUntil - n }
    t.fails = t.fails.filter((x) => n - x < WINDOW_MS)
    const valid = /^\d{4,8}$/.test(String(pin ?? '')) && verifyPin(pin, c)
    if (!valid) {
      t.fails.push(n)
      if (t.fails.length >= MAX_FAILS) {
        t.lockedUntil = n + LOCK_MS
        t.fails = []
        console.warn(`[jarvis] sivu-PIN: väärä PIN ${MAX_FAILS} kertaa (${ip}) — lukittu 15 min.`)
        void Promise.resolve()
          .then(() => notify(`Väärä PIN 5 kertaa: ${ip}`))
          .catch(() => {})
        return { ok: false, syy: 'lukittu', lukittuMs: LOCK_MS }
      }
      return { ok: false, syy: 'vaara', jaljella: MAX_FAILS - t.fails.length }
    }
    t.fails = []
    const token = randomBytes(32).toString('hex')
    const laite = String(label).slice(0, 80)
    const list = readDevices().filter(alive)
    list.push({ hash: sha256(token), at: n, laite })
    writeDevices(list)
    console.log(`[jarvis] sivu-PIN: uusi laite kirjautui (${laite}).`)
    void Promise.resolve()
      .then(() => notify(`Uusi laite kirjautui JARVIS-sivulle: ${laite}`))
      .catch(() => {})
    return { ok: true, token, hash: sha256(token), laite }
  }

  /** Device token from the browser. Returns { ok, hash?, laite?, syy? }. */
  function checkToken(token) {
    if (!loadPin()) return { ok: false, syy: 'ei_pinia' }
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return { ok: false, syy: 'tuntematon' }
    const h = sha256(token)
    const list = readDevices()
    const d = list.find((x) => x.hash.length === h.length && timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)))
    if (!d) return { ok: false, syy: 'tuntematon' }
    if (!alive(d)) {
      writeDevices(list.filter((x) => x !== d))
      return { ok: false, syy: 'vanhentunut' }
    }
    return { ok: true, hash: h, laite: d.laite }
  }

  function revoke(hash) {
    writeDevices(readDevices().filter((x) => x.hash !== hash))
    for (const fn of revokeListeners) fn(hash)
  }
  function revokeAll() {
    const n = readDevices().length
    writeDevices([])
    for (const fn of revokeListeners) fn(null)
    return n
  }
  function listDevices() {
    return readDevices().filter(alive)
  }
  function devicesText() {
    const list = listDevices()
    if (!list.length) return 'JARVIS-sivulle ei ole kirjautunut yhtään laitetta.'
    const fmt = (t) => new Date(t).toLocaleString('fi-FI', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
    return [`JARVIS-sivulle kirjautuneet laitteet (${list.length}):`, ...list.map((d, i) => `${i + 1}. ${d.laite || 'selain'} — kirjautui ${fmt(d.at)}, voimassa ${fmt(Number(d.at) + TOKEN_DAYS * 86_400_000)} asti`), '', '/laitteet pois = kirjaa kaikki ulos (PIN kysytään uudelleen).'].join('\n')
  }
  /** fn(hash | null) when a device (or all devices = null) is revoked: the bridge closes those sockets. */
  const onRevoke = (fn) => (revokeListeners.add(fn), () => revokeListeners.delete(fn))

  return { checkPin, checkToken, revoke, revokeAll, listDevices, devicesText, onRevoke, loadPin }
}

/** Before login only these two message types are handled; everything else is ignored (null). */
export const preAuthKind = (msg) => (msg?.type === 'pin' ? 'pin' : msg?.type === 'laite_token' ? 'token' : null)

/** Bridge-wide instance (server.mjs + the Telegram /laitteet command). notify is set by server.mjs. */
let notifier = () => {}
export const pinAuth = createPinAuth({ notify: (t) => notifier(t) })
export const setPinNotifier = (fn) => {
  notifier = typeof fn === 'function' ? fn : () => {}
}

/** Telegram /laitteet [pois]. */
export function devicesCommand(extra = '') {
  if (/^\s*pois\s*$/i.test(extra)) {
    const n = pinAuth.revokeAll()
    return `Kaikki JARVIS-sivun laitteet kirjattu ulos (${n}). Avoimet sivut sulkeutuivat; PIN kysytään uudelleen.`
  }
  return pinAuth.devicesText()
}
