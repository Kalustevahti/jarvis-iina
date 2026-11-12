/**
 * Ajastin: "sammuta telkkari 30 minuutin päästä", "lukitse kone klo 23", "muistuta puolen tunnin päästä soitosta".
 *
 *   ajasta      toiminto + viive (minuutteina) TAI kellonaika → tallennetaan ~/.jarvis/ajastimet.json (säilyy uudelleenkäynnistyksen yli)
 *   ajastimet   lista
 *   peru_ajastin
 *
 * Toiminnot ovat kiinteitä (ei vapaata komentoa): projektori valmiustilaan/päälle, projektorin tauko/mykistys, kone lukkoon,
 * hyvää yötä -rutiini, muistutus Telegramiin. Sammutus/lepotila EI ole ajastettavissa: ne vaativat vahvistuksen juuri silloin
 * (kone_virta). Kun ajastin laukeaa, tulos ilmoitetaan Telegramiin.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { machineCall } from './kone.mjs'
import { projectorCall, projectorConfigured } from './projektori.mjs'
import { runRoutine } from './rutiinit.mjs'
import { teslaCall, teslaConfigured } from './tesla.mjs'
import { tvCall, tvConfigured } from './telkkari.mjs'

const FILE = join(homedir(), '.jarvis', 'ajastimet.json')
const TZ = 'Europe/Helsinki'

export const ACTIONS = {
  samsung_pois: { label: 'Samsung-telkkari pois', run: () => tvCall('pois') },
  projektori_pois: { label: 'projektori valmiustilaan', run: () => projectorCall('projektori_virta', { tila: 'pois' }).then((r) => r.text) },
  // pause (not play/pause toggle): a timer must never resume something that is already paused.
  projektori_tauko: { label: 'projektorin toisto tauolle', run: () => projectorCall('projektori_toisto', { toiminto: 'tauko' }).then((r) => r.text) },
  projektori_mykista: { label: 'projektori mykistykseen', run: () => projectorCall('projektori_nappain', { nappi: 'mykistä' }).then((r) => r.text) },
  kone_lukitse: { label: 'kone lukkoon', run: () => machineCall('kone_lukitse').then((r) => r.text) },
  naytto_pois: { label: 'koneen näyttö pois', run: () => machineCall('kone_naytto', { tila: 'pois' }).then((r) => r.text) },
  hyvaa_yota: { label: 'hyvää yötä -rutiini (projektori pois, kone lukkoon)', run: () => runRoutine('hyvaa_yota') },
  nukkumaan: { label: 'nukkumaan: kaikki laitteet kiinni (projektori, valot, näyttö, kone lukkoon)', run: () => runRoutine('nukkumaan') },
  valot_pois: { label: 'valot pois', run: async () => (await import('./valot.mjs')).setLights('kaikki', { paalle: false }) },
  tesla_lammita: { label: 'auton lämmitys päälle', run: (t) => teslaCall('lammita', { lampotila: Number(t.viesti) || undefined }) },
  muistutus: { label: 'muistutus', run: async (t) => `Muistutus: ${t.viesti || '(ei tekstiä)'}` },
}

let timers = []
let notify = async () => {}
const seq = () => `a${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`

function save() {
  try {
    const dir = join(homedir(), '.jarvis')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(FILE, JSON.stringify(timers.map(({ handle, ...t }) => t)))
  } catch {
    /* ok */
  }
}
const fmt = (ms) => new Intl.DateTimeFormat('fi-FI', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(ms))
const left = (ms) => {
  const m = Math.round((ms - Date.now()) / 60_000)
  return m < 1 ? 'alle minuutti' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

async function fire(t) {
  timers = timers.filter((x) => x.id !== t.id)
  save()
  let out
  try {
    out = await ACTIONS[t.toiminto].run(t)
  } catch (err) {
    out = `ei onnistunut: ${err?.message ?? err}`
  }
  console.log(`[jarvis] ajastin: ${ACTIONS[t.toiminto].label} → ${String(out).slice(0, 80)}`)
  await notify(t.toiminto === 'muistutus' ? String(out) : `Ajastin (${fmt(t.at)}): ${ACTIONS[t.toiminto].label} — ${out}`).catch(() => {})
}

function arm(t) {
  const delay = Math.max(0, t.at - Date.now())
  if (delay > 2 ** 31 - 1) return
  t.handle = setTimeout(() => void fire(t), delay)
  t.handle.unref?.()
}

/** Kellonaika "23:15" / "23.15" / "23" → seuraava sellainen hetki Helsingin ajassa. */
function parseClock(s) {
  const m = String(s).trim().match(/^(\d{1,2})(?:[:.](\d{2}))?$/)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2] ?? 0)
  if (hh > 23 || mm > 59) return null
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map((p) => [p.type, p.value]))
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute)
  let diff = hh * 60 + mm - nowMin
  if (diff <= 0) diff += 24 * 60
  return Date.now() + diff * 60_000 - (Date.now() % 60_000)
}

export function schedule({ toiminto, minuutit, kello, viesti }) {
  if (!ACTIONS[toiminto]) throw new Error(`Tuntematon toiminto ${toiminto}`)
  if (toiminto.startsWith('projektori') && !projectorConfigured()) throw new Error('Projektoria ei ole yhdistetty.')
  if (toiminto.startsWith('samsung') && !tvConfigured()) throw new Error('Samsungia ei ole yhdistetty (asenna_telkkari.bat).')
  if (toiminto.startsWith('tesla') && !teslaConfigured()) throw new Error('Teslaa ei ole yhdistetty (asenna_tesla.bat).')
  let at
  if (kello) {
    at = parseClock(kello)
    if (!at) throw new Error(`En ymmärtänyt kellonaikaa "${kello}" (esim. 23:15).`)
  } else {
    const m = Number(minuutit)
    if (!Number.isFinite(m) || m < 1 || m > 24 * 60) throw new Error('Viive 1–1440 minuuttia.')
    at = Date.now() + m * 60_000
  }
  const t = { id: seq(), toiminto, at, viesti: String(viesti ?? '').slice(0, 300), created: Date.now() }
  timers.push(t)
  arm(t)
  save()
  console.log(`[jarvis] ajastin: ${ACTIONS[toiminto].label} klo ${fmt(at)}`)
  return `Ajastettu: ${ACTIONS[toiminto].label}${t.viesti ? ` ("${t.viesti}")` : ''} klo ${fmt(at)} (${left(at)}). Peru: "peru ajastin".`
}

export function listTimers() {
  if (!timers.length) return 'Ei ajastimia.'
  return timers
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((t, i) => `${i + 1}. klo ${fmt(t.at)} (${left(t.at)}): ${ACTIONS[t.toiminto].label}${t.viesti ? ` — ${t.viesti}` : ''}`)
    .join('\n')
}

export function cancelTimers(which = 'kaikki') {
  if (!timers.length) return 'Ei peruttavia ajastimia.'
  const sorted = timers.slice().sort((a, b) => a.at - b.at)
  const n = Number(which)
  const gone = which === 'kaikki' ? sorted : Number.isFinite(n) && sorted[n - 1] ? [sorted[n - 1]] : sorted.filter((t) => t.toiminto.startsWith(String(which)))
  if (!gone.length) return `Ei ajastinta "${which}".`
  for (const t of gone) clearTimeout(t.handle)
  timers = timers.filter((t) => !gone.includes(t))
  save()
  return `Peruttu: ${gone.map((t) => `${ACTIONS[t.toiminto].label} klo ${fmt(t.at)}`).join(', ')}.`
}

/** Käynnistyksessä: ladataan tallennetut, laukaistaan myöhästyneet (max 2 h vanhat) heti. */
export function startTimers({ notify: n } = {}) {
  if (n) notify = n
  try {
    const saved = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []
    for (const t of saved) {
      if (!ACTIONS[t.toiminto]) continue
      if (t.at < Date.now() - 2 * 3600_000) continue
      timers.push(t)
      arm(t)
    }
    if (timers.length) console.log(`[jarvis] ajastin: ${timers.length} ajastinta ladattu`)
  } catch {
    /* ok */
  }
}

export function timerServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const safe = (fn) => async (a) => {
    try {
      return ok(await fn(a ?? {}))
    } catch (err) {
      return ok(`Ajastin: ${err?.message ?? err}`)
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_ajastin',
    version: '1.0.0',
    instructions:
      'Ajastetut toiminnot: "sammuta telkkari 30 min päästä" (samsung_pois), "projektori pois 30 min päästä", "laita projektori pois klo 23", "lukitse kone tunnin päästä", "sammuta näyttö 10 min päästä", "nukkumaan tunnin päästä", "valot pois klo 23", ' +
      '"lämmitä auto klo 7.15" (tesla_lammita, viesti = lämpötila °C valinnainen), "muistuta puolen tunnin päästä että soitan Myyjä1lle". Telkkari/TV = samsung_pois (kun Samsung on yhdistetty), projektori = projektori_pois. Koneen sammutusta ei voi ajastaa (vaatii vahvistuksen silloin).',
    tools: [
      tool(
        'ajasta',
        'Ajastaa toiminnon. minuutit = viive nyt-hetkestä ("30 minuutin päästä" → 30, "tunnin päästä" → 60, "puolen tunnin" → 30, "vartin" → 15) ' +
          'TAI kello = kellonaika "23:15" (seuraava sellainen hetki). viesti: muistutuksen teksti, tai tesla_lammita: lämpötila °C. Toiminnot: ' +
          Object.entries(ACTIONS).map(([k, v]) => `${k} (${v.label})`).join(', ') + '.',
        {
          toiminto: z.enum(Object.keys(ACTIONS)),
          minuutit: z.number().int().min(1).max(1440).optional(),
          kello: z.string().max(5).optional(),
          viesti: z.string().max(300).optional(),
        },
        safe((a) => schedule(a)),
      ),
      tool('ajastimet', 'Listaa voimassa olevat ajastimet.', {}, safe(() => listTimers())),
      tool(
        'peru_ajastin',
        'Peruu ajastimen: mika = "kaikki", listan numero ("2") tai toiminnon alku ("projektori", "kone", "muistutus").',
        { mika: z.string().max(20).optional() },
        safe((a) => cancelTimers(a.mika || 'kaikki')),
      ),
    ],
  })
}
