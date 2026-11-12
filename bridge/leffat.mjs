/**
 * Leffat: "leffa komedia" → JARVIS ehdottaa elokuvan, jota Elias ei ole nähnyt (Netflix tai Disney+ Suomessa),
 * ja hyväksynnän jälkeen laittaa sen pyörimään projektorille (leffailta: projektori päälle → toisto → valot pois → näyttö kiinni).
 *
 *   Elokuvat: TMDB-rajapinta (themoviedb.org, ilmainen avain). Haku genren, palvelun (Netflix 8, Disney+ 337) ja Suomen
 *   tarjonnan mukaan, suomenkieliset nimet ja kuvaukset. Avain DPAPI-salattuna ~/.jarvis/tmdb.json; malli ei näe sitä.
 *   Asennus: tyokalut\asenna_leffat.bat.
 *
 *   Mitä on nähty:
 *     1. JARVISin oma loki: kaikki mitä JARVIS käynnistää + "nähty"-merkinnät (muisti/leffat.json).
 *     2. Netflixin katseluhistoria: netflix.com/viewingactivity → "Lataa kaikki" → NetflixViewingHistory.csv
 *        Lataukset- tai Documents\JARVIS\tuonti-kansioon. Luetaan automaattisesti, kun tiedosto on uudempi kuin edellinen.
 *        Myös Netflixin koko datan vienti (ViewingActivity.csv) käy.
 *
 *   Makuoppi: "leffa oli hyvä/huono" → genrepainotus seuraaviin ehdotuksiin. Ohitetut ehdotukset eivät tule 60 päivään.
 *
 *   Turva: vain TMDB:n lukukyselyt ja projektorin valmiit toistotyökalut (projektori_netflix / projektori_disney).
 *   Ei ostoksia eikä vuokrauksia: haetaan vain tilauspalveluiden (flatrate) sisältöä.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { machineCall } from './kone.mjs'
import { projectorCall, projectorConfigured } from './projektori.mjs'
import { lightsConfigured, setLights } from './valot.mjs'

const KEY_FILE = join(homedir(), '.jarvis', 'tmdb.json')
const MEMORY_DIR = join(homedir(), 'Documents', 'JARVIS', 'muisti')
const STATE_FILE = join(MEMORY_DIR, 'leffat.json')
const HISTORY_DIRS = [join(homedir(), 'Documents', 'JARVIS', 'tuonti'), join(homedir(), 'Downloads')]
const BASE = 'https://api.themoviedb.org/3'
const PROVIDERS = { netflix: { id: 8, name: 'Netflix' }, disney: { id: 337, name: 'Disney+' } }
const SKIP_DAYS = 60
const ANSWER_WINDOW_MS = 15 * 60_000

// --- avain (DPAPI, sama malli kuin tesla.mjs) ------------------------------------------------------
const keyCfg = () => {
  try {
    return existsSync(KEY_FILE) ? JSON.parse(readFileSync(KEY_FILE, 'utf8').replace(/^﻿/, '')) : null
  } catch {
    return null
  }
}
export const moviesConfigured = () => Boolean(keyCfg()?.key)
let plainKey = null
function apiKey() {
  if (plainKey) return Promise.resolve(plainKey)
  const c = keyCfg()
  if (!c?.key) return Promise.reject(new Error('TMDB-avainta ei ole: aja tyokalut\\asenna_leffat.bat.'))
  if (process.platform !== 'win32') return Promise.resolve((plainKey = c.key))
  return new Promise((resolve, reject) => {
    const ps = `$s = ConvertTo-SecureString '${String(c.key).replace(/'/g, '')}'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      if (err || !String(out).trim()) return reject(new Error('TMDB-avainta ei saatu purettua (aja asenna_leffat.bat uudelleen).'))
      resolve((plainKey = String(out).replace(/\r?\n$/, '').trim()))
    })
  })
}

async function tmdb(path, params = {}) {
  const k = await apiKey()
  const bearer = k.startsWith('eyJ') // v4 "API Read Access Token"; muuten v3 api_key
  const q = new URLSearchParams(Object.entries({ ...params, ...(bearer ? {} : { api_key: k }) }).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([a, b]) => [a, String(b)]))
  const res = await fetch(`${BASE}${path}?${q}`, {
    headers: { accept: 'application/json', ...(bearer ? { authorization: `Bearer ${k}` } : {}) },
    signal: AbortSignal.timeout(12_000),
  })
  if (res.status === 401) throw new Error('TMDB ei hyväksynyt avainta: aja tyokalut\\asenna_leffat.bat uudelleen.')
  if (!res.ok) throw new Error(`TMDB ${res.status}`)
  return res.json()
}

// --- tila ----------------------------------------------------------------------------------------
const EMPTY = () => ({ nahty: {}, netflix: { titles: [], file: '', mtime: 0, at: '' }, arviot: {}, ohitettu: {}, profiilit: {}, viimeisin: null, ehdotus: null })
function load() {
  try {
    if (!existsSync(STATE_FILE)) return EMPTY()
    return { ...EMPTY(), ...JSON.parse(readFileSync(STATE_FILE, 'utf8').replace(/^﻿/, '')) }
  } catch {
    return EMPTY()
  }
}
function save(s) {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1))
}

/** Nimien vertailu: pienet kirjaimet, ei aksentteja eikä välimerkkejä ("Amélie" = "amelie", "Ocean's Eleven" = "oceans eleven"). */
export const norm = (t) =>
  String(t ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// --- genret ja tarkennukset ----------------------------------------------------------------------
const GENRES = [
  [28, 'toiminta', /toimin|action/],
  [12, 'seikkailu', /seikkail|adventure/],
  [16, 'animaatio', /animaat|piirret|anime\b|animation/],
  [35, 'komedia', /komedi|hauska|huumori|naurat|comedy|romcom/],
  [80, 'rikos', /rikos|gangster|mafia|crime/],
  [99, 'dokumentti', /dokum|dokkari|documentar/],
  [18, 'draama', /draam|drama/],
  [10751, 'perhe', /perhe|lasten|lapsille|family/],
  [14, 'fantasia', /fantas/],
  [36, 'historia', /histori/],
  [27, 'kauhu', /kauhu|horror/],
  [10402, 'musiikki', /musiik|musikaal|musical/],
  [9648, 'mysteeri', /myster|salapoli/],
  [10749, 'romantiikka', /romant|romcom|rakkaus/],
  [878, 'scifi', /sci-?fi|scifi|tieteis|avaruus/],
  [53, 'trilleri', /trill|jännit|jännär|jannit|jannar|thriller/],
  [10752, 'sota', /\bsota|sodan|war\b/],
  [37, 'western', /western|lännen/],
]
const GENRE_NAME = Object.fromEntries(GENRES.map(([id, name]) => [id, name]))
export const GENRE_WORDS = GENRES.map(([, n]) => n)

/** "komedia lyhyt netflix" → { genres:[35], runtimeMax:100, palvelu:'netflix', recognized:true } */
export function parseRequest(text) {
  const t = String(text ?? '').toLowerCase()
  const genres = GENRES.filter(([, , re]) => re.test(t)).map(([id]) => id)
  const year = new Date().getFullYear()
  const r = { genres, palvelu: /netflix/.test(t) && !/disney/.test(t) ? 'netflix' : /disney/.test(t) && !/netflix/.test(t) ? 'disney' : 'molemmat' }
  if (/lyhy|nopea|alle\s*(puolitoista|1[,.]5|90|100)/.test(t)) r.runtimeMax = 100
  if (/\buus|tuore|uutuu/.test(t)) r.from = `${year - 3}-01-01`
  if (/klassik|vanha|ysäri|80-|90-/.test(t)) r.to = '1999-12-31'
  if (/hyv[aä]|paras|parhai|huippu|arvostettu/.test(t)) r.minVote = 7.3
  if (/suomalai|kotimai/.test(t)) r.lang = 'fi'
  r.recognized = genres.length > 0 || Boolean(r.runtimeMax || r.from || r.to || r.minVote || r.lang || r.palvelu !== 'molemmat')
  return r
}

// --- katseluhistoria -----------------------------------------------------------------------------
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (ch === '"') q = false
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') row.push(cell), (cell = '')
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell), rows.push(row), (row = []), (cell = '')
    } else cell += ch
  }
  if (cell || row.length) row.push(cell), rows.push(row)
  return rows.filter((r) => r.some((c) => c.trim()))
}
const EPISODE = /:\s*(season|kausi|series|sarja|limited series|minisarja|episode|jakso|chapter|luku|osa|part|volume|book)\b/i

/** Netflixin CSV → normalisoidut elokuvien nimet (jaksot ja trailerit pois). */
export function netflixTitles(csvText) {
  const rows = parseCsv(String(csvText).replace(/^﻿/, ''))
  if (!rows.length) return []
  const head = rows[0].map((h) => h.trim().toLowerCase())
  const ti = head.indexOf('title')
  if (ti < 0) return []
  const sup = head.indexOf('supplemental video type') // ViewingActivity.csv: trailerit ym.
  const out = new Set()
  for (const r of rows.slice(1)) {
    if (sup >= 0 && String(r[sup] ?? '').trim()) continue
    const title = String(r[ti] ?? '').trim()
    if (!title || EPISODE.test(title)) continue
    out.add(norm(title))
  }
  return [...out]
}

function findHistoryFile() {
  let best = null
  for (const dir of HISTORY_DIRS) {
    let names = []
    try {
      names = existsSync(dir) ? readdirSync(dir) : []
    } catch {
      continue
    }
    for (const n of names) {
      if (!/^(netflixviewinghistory.*|viewingactivity)\.csv$/i.test(n)) continue
      const p = join(dir, n)
      try {
        const m = statSync(p).mtimeMs
        if (!best || m > best.mtime) best = { path: p, mtime: m }
      } catch {
        /* ok */
      }
    }
  }
  return best
}

/** Lukee uusimman Netflix-historian, jos se on uudempi kuin edellinen tuonti. Palauttaa viestin tai null. */
function importHistory(s, { force = false } = {}) {
  const f = findHistoryFile()
  if (!f) return null
  if (!force && f.mtime <= (s.netflix?.mtime ?? 0)) return null
  const raw = readFileSync(f.path, 'utf8')
  const titles = netflixTitles(raw)
  const merged = new Set([...titles, ...subtitleHeads(raw), ...(s.netflix?.titles ?? [])]) // uusimmat ensin
  s.netflix = { titles: [...merged], recent: titles.slice(0, 60), ids: s.netflix?.ids ?? [], file: f.path, mtime: f.mtime, at: new Date().toISOString() }
  s.historiaMaku = null // lasketaan uudelleen seuraavassa ehdotuksessa
  return `Luin Netflixin katseluhistorian (${titles.length} elokuvaa tiedostosta ${f.path.split(/[\\/]/).pop()}).`
}

/**
 * Mieltymykset katseluhistoriasta: viimeisimmät ~40 Netflix-elokuvaa haetaan TMDB:stä → genrejakauma, keskiarvo, vuosikymmenet.
 * Lasketaan kerran tuonnin jälkeen (n. 10 s) ja tallennetaan; tunnistetut id:t estävät samojen ehdottamisen varmemmin kuin nimi.
 */
async function historyTaste(s) {
  if (s.historiaMaku || !(s.netflix?.recent ?? s.netflix?.titles ?? []).length) return s.historiaMaku
  const titles = (s.netflix.recent?.length ? s.netflix.recent : s.netflix.titles).slice(0, 40)
  const genres = {}
  const ids = new Set(s.netflix.ids ?? [])
  const decades = {}
  let n = 0
  let voteSum = 0
  for (const t of titles) {
    const r = await tmdb('/search/movie', { query: t, language: 'fi-FI' }).catch(() => null)
    const m = (r?.results ?? []).find((x) => norm(x.title) === t || norm(x.original_title) === t)
    if (!m) continue
    n++
    ids.add(m.id)
    voteSum += Number(m.vote_average) || 0
    for (const g of m.genre_ids ?? []) genres[g] = (genres[g] ?? 0) + 1
    const y = Number(String(m.release_date ?? '').slice(0, 4))
    if (y) decades[`${Math.floor(y / 10) * 10}`] = (decades[`${Math.floor(y / 10) * 10}`] ?? 0) + 1
  }
  s.netflix.ids = [...ids]
  s.historiaMaku = { n, genres, decades, avgVote: n ? voteSum / n : 0, seeds: [...ids].slice(0, 5), at: new Date().toISOString() }
  return s.historiaMaku
}

/** Netflixin alaotsikolliset nimet: myös alku talteen ("Glass Onion: A Knives Out Mystery" → "glass onion"). */
function subtitleHeads(csvText) {
  const rows = parseCsv(String(csvText).replace(/^\uFEFF/, ''))
  const ti = (rows[0] ?? []).map((h) => h.trim().toLowerCase()).indexOf('title')
  if (ti < 0) return []
  const out = new Set()
  for (const r of rows.slice(1)) {
    const t = String(r[ti] ?? '')
    if (EPISODE.test(t) || !t.includes(':')) continue
    const head = norm(t.split(':')[0])
    if (head.length >= 6) out.add(head)
  }
  return [...out]
}

function seenSet(s) {
  const set = new Set(s.netflix?.titles ?? [])
  for (const x of Object.values(s.nahty ?? {})) set.add(norm(x.t))
  return set
}
function seen(s, c, set = seenSet(s)) {
  if (s.nahty?.[String(c.id)] || (s.netflix?.ids ?? []).includes(c.id)) return true
  return [norm(c.title), norm(c.original_title)].some((n) => n.length >= 2 && set.has(n))
}

// --- haku ----------------------------------------------------------------------------------------
const cache = new Map() // avain → { at, list }
async function pool(req) {
  const services = req.palvelu === 'molemmat' ? ['netflix', 'disney'] : [req.palvelu]
  const key = JSON.stringify({ ...req, services, recognized: undefined })
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.list
  const base = {
    language: 'fi-FI',
    region: 'FI',
    watch_region: 'FI',
    with_watch_monetization_types: 'flatrate',
    include_adult: 'false',
    with_genres: req.genres?.length ? req.genres.join(',') : undefined,
    'with_runtime.lte': req.runtimeMax,
    'with_runtime.gte': 60,
    'primary_release_date.gte': req.from,
    'primary_release_date.lte': req.to,
    'vote_average.gte': req.minVote,
    with_original_language: req.lang,
  }
  const minVotes = req.lang === 'fi' ? 20 : req.genres?.some((g) => g === 99 || g === 16) ? 80 : 150
  const byId = new Map()
  for (const sv of services) {
    const p = { ...base, with_watch_providers: PROVIDERS[sv].id }
    const first = await tmdb('/discover/movie', { ...p, sort_by: 'popularity.desc', 'vote_count.gte': minVotes, page: 1 })
    const pages = [first]
    const total = Math.min(Number(first.total_pages) || 1, 20)
    const extra = [{ sort_by: 'vote_average.desc', 'vote_count.gte': Math.max(minVotes, 300), page: 1 }]
    if (total >= 2) extra.push({ sort_by: 'popularity.desc', 'vote_count.gte': minVotes, page: 2 })
    if (total >= 4) extra.push({ sort_by: 'popularity.desc', 'vote_count.gte': minVotes, page: 3 + Math.floor(Math.random() * Math.min(total - 2, 6)) })
    for (const e of extra) pages.push(await tmdb('/discover/movie', { ...p, ...e }).catch(() => ({ results: [] })))
    for (const pg of pages) {
      for (const m of pg.results ?? []) {
        const prev = byId.get(m.id)
        if (prev) {
          if (!prev.palvelut.includes(sv)) prev.palvelut.push(sv)
          continue
        }
        byId.set(m.id, {
          id: m.id,
          title: m.title,
          original_title: m.original_title,
          year: String(m.release_date ?? '').slice(0, 4),
          vote: Number(m.vote_average) || 0,
          votes: Number(m.vote_count) || 0,
          pop: Number(m.popularity) || 0,
          genres: m.genre_ids ?? [],
          overview: m.overview ?? '',
          palvelut: [sv],
        })
      }
    }
  }
  const list = [...byId.values()]
  cache.set(key, { at: Date.now(), list })
  return list
}

/** Genrepainot: Eliaksen arviot (hyvä +1 / huono −1) + katseluhistorian genrejakauma (max ±2). */
function taste(s) {
  const g = {}
  for (const a of Object.values(s.arviot ?? {})) {
    const w = a.arvio === 'hyva' ? 1 : a.arvio === 'huono' ? -1 : 0
    for (const id of a.genres ?? []) g[id] = (g[id] ?? 0) + w
  }
  const h = s.historiaMaku
  if (h?.n >= 5) {
    for (const [id, cnt] of Object.entries(h.genres)) g[id] = (g[id] ?? 0) + Math.min(2, (cnt / h.n) * 4)
  }
  return g
}

/** "Tämän tyyppisistä pidit": TMDB-suositukset hyviksi arvioiduista ja viimeksi katsotuista. */
const recCache = new Map()
async function recommended(s) {
  const liked = Object.entries(s.arviot ?? {}).filter(([k, a]) => a.arvio === 'hyva' && /^\d+$/.test(k)).map(([k]) => Number(k))
  const recent = Object.values(s.nahty ?? {}).filter((x) => x.id && x.src === 'jarvis' && !(s.arviot?.[String(x.id)]?.arvio === 'huono')).sort((a, b) => String(b.at).localeCompare(String(a.at))).map((x) => x.id)
  const seeds = [...new Set([...liked.slice(-4), ...recent.slice(0, 2), ...(s.historiaMaku?.seeds ?? []).slice(0, 3)])].slice(0, 6)
  const out = new Set()
  for (const id of seeds) {
    let ids = recCache.get(id)
    if (!ids) {
      const r = await tmdb(`/movie/${id}/recommendations`, { language: 'fi-FI' }).catch(() => null)
      ids = (r?.results ?? []).map((m) => m.id)
      recCache.set(id, ids)
    }
    for (const x of ids) out.add(x)
  }
  return out
}

function rank(list, s, recs = new Set(), { best = false } = {}) {
  const tg = taste(s)
  const now = Date.now()
  const set = seenSet(s)
  const skipped = (id) => {
    const at = s.ohitettu?.[String(id)]
    return at && now - new Date(at).getTime() < SKIP_DAYS * 86400_000
  }
  return list
    .filter((c) => !seen(s, c, set) && !skipped(c.id))
    .map((c) => {
      const t = Math.max(-4, Math.min(4, c.genres.reduce((sum, id) => sum + (tg[id] ?? 0), 0)))
      // "parhaimmat": arvosana ja äänten määrä painavat, satunnaisuutta vähemmän.
      const quality = c.vote + (best ? 0.4 : 0.25) * Math.log10(c.votes + 1)
      const score = quality + 0.3 * Math.log10(c.pop + 1) + 0.25 * t + (recs.has(c.id) ? 0.8 : 0) + Math.random() * (best ? 0.6 : 1.4)
      return { ...c, score, sinulle: recs.has(c.id) }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
}

async function details(c) {
  const d = await tmdb(`/movie/${c.id}`, { language: 'fi-FI' }).catch(() => null)
  let overview = d?.overview || c.overview
  if (!overview) overview = (await tmdb(`/movie/${c.id}`, { language: 'en-US' }).catch(() => null))?.overview ?? ''
  return { ...c, runtime: Number(d?.runtime) || null, overview }
}

const hm = (min) => (min ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : '')
const svName = (c) => c.palvelut.map((p) => PROVIDERS[p].name).join(' ja ')
const firstSentence = (t) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim()
  const m = s.match(/^(.{20,200}?[.!?])(\s|$)/)
  return (m ? m[1] : s.slice(0, 180)).trim()
}
function describe(c) {
  const g = c.genres.map((id) => GENRE_NAME[id]).filter(Boolean).slice(0, 3).join(', ')
  const orig = c.original_title && norm(c.original_title) !== norm(c.title) ? ` / ${c.original_title}` : ''
  const facts = [c.year, g, hm(c.runtime), c.vote ? `arvio ${c.vote.toFixed(1).replace('.', ',')}/10` : '', svName(c)].filter(Boolean).join(' · ')
  const plot = firstSentence(c.overview)
  return `${c.title}${orig} (${facts}).${plot ? ` ${plot}` : ''}`
}

function ratePrompt(s) {
  const v = s.viimeisin
  if (!v || v.arvioitu) return ''
  const age = Date.now() - new Date(v.at).getTime()
  if (age < 2 * 3600_000 || age > 14 * 86400_000) return ''
  return `Muuten, miten ${v.t} oli? Sano "hyvä" tai "huono", niin opin makusi.\n\n`
}

// --- toiminnot -----------------------------------------------------------------------------------
const shortLine = (c) => `${c.title} (${[c.year, c.vote ? c.vote.toFixed(1).replace('.', ',') : '', svName(c)].filter(Boolean).join(', ')})`

export async function suggest({ genre = '', palvelu, tarkennus = '', parhaat = true, pika = false } = {}) {
  const s = load()
  const note = importHistory(s)
  const req = parseRequest(`${genre} ${tarkennus} ${palvelu && palvelu !== 'molemmat' ? palvelu : ''}`)
  if (genre && !req.genres.length && !req.recognized) {
    return `En tunnistanut genreä "${genre}". Osaan: ${GENRE_WORDS.join(', ')} (myös yhdistelmät, esim. toimintakomedia, ja tarkennukset lyhyt, uusi, klassikko, hyvä, suomalainen).`
  }
  const firstTaste = !s.historiaMaku && (s.netflix?.titles ?? []).length
  await historyTaste(s).catch(() => null)
  const recs = await recommended(s).catch(() => new Set())
  const ranked = rank(await pool(req), s, recs, { best: parhaat })
  if (!ranked.length) {
    save(s)
    return `${note ? `${note}\n` : ''}En löytänyt ${req.genres.map((g) => GENRE_NAME[g]).join('+') || ''} -elokuvaa, jota et olisi nähnyt tai ohittanut (${req.palvelu === 'molemmat' ? 'Netflix ja Disney+' : PROVIDERS[req.palvelu].name}). Kokeile väljempää hakua.`
  }
  const cur = await details(ranked[0])
  s.ehdotus = { current: cur, queue: ranked.slice(1), req, at: new Date().toISOString(), awaiting: pika }
  save(s)
  const why = cur.sinulle ? ' Se on samantyyppinen kuin leffat, joita olet katsonut tai pitänyt.' : ''
  const alt = ranked.slice(1, 3)
  const head = [note, firstTaste && s.historiaMaku?.n ? `Kävin läpi katseluhistoriasi (${s.historiaMaku.n} elokuvaa) ja otin mieltymyksesi huomioon.` : ''].filter(Boolean).join(' ')
  return (
    `${head ? `${head}\n\n` : ''}${ratePrompt(s)}Ehdotan: ${describe(cur)}${why}` +
    `${alt.length ? `\n\nMuut kärkivaihtoehdot: ${alt.map((c, i) => `${i + 2}) ${shortLine(c)}`).join(', ')}.` : ''}` +
    `\n\nLaitanko pyörimään? ("joo"${alt.length ? `, ${alt.length > 1 ? '"2" tai "3"' : '"2"'}` : ''}, "seuraava" tai "nähty")`
  )
}

export async function next({ nahty = false } = {}) {
  const s = load()
  const e = s.ehdotus
  if (!e?.current) return 'Minulla ei ole ehdotusta kesken. Sano esim. "leffa komedia".'
  const at = new Date().toISOString()
  if (nahty) s.nahty[String(e.current.id)] = { t: e.current.title, y: e.current.year, id: e.current.id, at, src: 'elias' }
  else s.ohitettu[String(e.current.id)] = at
  const queue = (e.queue ?? []).filter((c) => !seen(s, c))
  if (!queue.length) {
    s.ehdotus = null
    save(s)
    return `${nahty ? `Merkitsin ${e.current.title} nähdyksi. ` : ''}Tämän haun ehdotukset loppuivat. Sano uusi genre tai tarkennus.`
  }
  const cur = await details(queue[0])
  s.ehdotus = { ...e, current: cur, queue: queue.slice(1), at }
  save(s)
  return `${nahty ? `Merkitsin ${e.current.title} nähdyksi. ` : ''}Entä: ${describe(cur)}\n\nLaitanko tämän?`
}

export async function markSeen(nimi) {
  const s = load()
  const q = String(nimi ?? '').trim()
  if (!q) return next({ nahty: true })
  let hit = null
  const found = await tmdb('/search/movie', { query: q, language: 'fi-FI', region: 'FI' }).catch(() => null)
  const m = found?.results?.[0]
  if (m) hit = { t: m.title, y: String(m.release_date ?? '').slice(0, 4), id: m.id }
  const id = hit?.id ? String(hit.id) : `t:${norm(q)}`
  s.nahty[id] = { t: hit?.t ?? q, y: hit?.y ?? '', id: hit?.id ?? null, at: new Date().toISOString(), src: 'elias' }
  save(s)
  return `Merkitty nähdyksi: ${hit ? `${hit.t}${hit.y ? ` (${hit.y})` : ''}` : q}. En ehdota sitä enää.`
}

export function rate({ arvio, nimi } = {}) {
  const s = load()
  const a = arvio === 'hyva' || arvio === 'huono' ? arvio : 'ok'
  let target = s.viimeisin
  if (nimi) {
    const n = norm(nimi)
    const own = Object.values(s.nahty).find((x) => norm(x.t) === n || norm(x.t).includes(n))
    target = own ? { id: own.id, t: own.t, genres: own.genres ?? [] } : { id: null, t: nimi, genres: [] }
  }
  if (!target) return 'En tiedä mitä leffaa tarkoitat: anna nimi.'
  const key = target.id ? String(target.id) : `t:${norm(target.t)}`
  s.arviot[key] = { t: target.t, arvio: a, genres: target.genres ?? s.nahty[key]?.genres ?? [], at: new Date().toISOString() }
  if (s.viimeisin && (!nimi || String(s.viimeisin.id) === String(target.id))) s.viimeisin.arvioitu = true
  save(s)
  return a === 'hyva' ? `Kirjattu: ${target.t} oli hyvä. Ehdotan jatkossa enemmän samantyyppisiä.` : a === 'huono' ? `Kirjattu: ${target.t} ei ollut hyvä. Painotan sen tyylisiä vähemmän.` : `Kirjattu arvio: ${target.t}.`
}

export async function launch({ id, valinta, palvelu, profiili } = {}) {
  const s = load()
  const e = s.ehdotus
  let c = e?.current
  if (valinta && valinta > 1) c = e?.queue?.[valinta - 2] ?? null
  if (id) c = [e?.current, ...(e?.queue ?? [])].find((x) => x && String(x.id) === String(id)) ?? null
  if (!c) return 'Ei ehdotusta käynnistettäväksi. Sano ensin esim. "leffa komedia".'
  if (!projectorConfigured()) return 'Projektoria ei ole asennettu (tyokalut\\asenna_projektori.bat).'
  const sv = palvelu && c.palvelut.includes(palvelu) ? palvelu : c.palvelut.includes('netflix') ? 'netflix' : c.palvelut[0]
  if (profiili) s.profiilit[sv] = profiili
  const prof = s.profiilit[sv] || undefined
  const done = []
  const fail = []

  const on = await projectorCall('projektori_virta', { tila: 'paalle' }).catch((err) => ({ text: String(err?.message ?? err), error: true }))
  if (on.error) {
    if (s.ehdotus) s.ehdotus.awaiting = false
    save(s)
    return `${on.text}\n\nKun projektori on päällä, sano "laita se" (muistan ehdotuksen: ${c.title}).`
  }
  done.push('projektori päällä')

  // Valot ja näyttö pois samalla hetkellä kuin toisto alkaa (rinnakkain), kun projektori vastaa.
  const darkness = Promise.all([
    lightsConfigured()
      ? setLights('kaikki', { paalle: false }).then(() => done.push('valot pois')).catch((err) => fail.push(`valot: ${String(err?.message ?? err).slice(0, 80)}`))
      : null,
    machineCall('kone_naytto', { tila: 'pois' }).then(() => done.push('koneen näyttö pois')).catch((err) => fail.push(`näyttö: ${String(err?.message ?? err).slice(0, 80)}`)),
  ])
  const clean = (t) => String(t ?? '').replace(/['"`$\\;&|<>]/g, '').trim()
  const tool = sv === 'disney' ? 'projektori_disney' : 'projektori_netflix'
  let play = await projectorCall(tool, { haku: clean(c.title), ...(prof ? { profiili: prof } : {}) }).catch((err) => ({ text: String(err?.message ?? err), error: true }))
  const missed = (r) => r.error || /en löytänyt|ei löytynyt|ei näy asennettuna|ei avautunut|kysyy profiilia|ei ole asennettuna|ei saatu/i.test(r.text)
  if (missed(play) && c.original_title && norm(c.original_title) !== norm(c.title)) {
    play = await projectorCall(tool, { haku: clean(c.original_title), ...(prof ? { profiili: prof } : {}) }).catch((err) => ({ text: String(err?.message ?? err), error: true }))
  }
  await darkness
  if (missed(play)) {
    fail.push(`${PROVIDERS[sv].name}: ${play.text}`)
  } else {
    done.push(`${PROVIDERS[sv].name}: ${play.text}`)
    const at = new Date().toISOString()
    s.nahty[String(c.id)] = { t: c.title, y: c.year, id: c.id, at, src: 'jarvis', palvelu: sv, genres: c.genres }
    s.viimeisin = { id: c.id, t: c.title, y: c.year, palvelu: sv, at, genres: c.genres, arvioitu: false }
    s.ehdotus = null
  }
  if (s.ehdotus) s.ehdotus.awaiting = false
  save(s)
  if (missed(play)) return `En saanut ${c.title} käyntiin (${done.join(', ')}).\n${fail.join('\n')}\n\nVoit jatkaa projektorin ruutua lukemalla (projektori_lue) tai sanoa "seuraava".`
  return `Leffailta: ${c.title}.\n${done.map((d) => `✓ ${d}`).join('\n')}${fail.length ? `\n${fail.map((f) => `✗ ${f}`).join('\n')}` : ''}`
}

export function historyText({ tuo = false } = {}) {
  const s = load()
  const note = tuo ? importHistory(s, { force: true }) : importHistory(s)
  save(s)
  const own = Object.values(s.nahty).sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const rated = Object.values(s.arviot)
  const L = []
  if (note) L.push(note)
  L.push(
    s.netflix?.titles?.length
      ? `Netflix-historia: ${s.netflix.titles.length} elokuvaa (luettu ${String(s.netflix.at).slice(0, 10)}).`
      : 'Netflix-historiaa ei ole luettu. Lataa se: netflix.com/viewingactivity → "Lataa kaikki" (tiedosto menee Latauksiin, luen sen itse).',
  )
  L.push(`JARVISin loki: ${own.length} nähtyä elokuvaa, ${rated.length} arviota.`)
  if (own.length) L.push(`Viimeisimmät: ${own.slice(0, 8).map((x) => `${x.t}${x.y ? ` (${x.y})` : ''}`).join(', ')}.`)
  const h = s.historiaMaku
  if (h?.n) {
    const top = Object.entries(h.genres).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, n]) => `${GENRE_NAME[id] ?? id} ${Math.round((n / h.n) * 100)} %`)
    const dec = Object.entries(h.decades).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => `${d}-luku`)
    L.push(`Historiasta (${h.n} tunnistettua elokuvaa): eniten ${top.join(', ')}; useimmiten ${dec.join(' ja ')}; keskiarvo ${h.avgVote.toFixed(1).replace('.', ',')}/10.`)
  }
  const tg = Object.entries(taste(s)).sort((a, b) => b[1] - a[1])
  if (tg.length) L.push(`Makuprofiili: ${tg.filter(([, v]) => v !== 0).map(([id, v]) => `${GENRE_NAME[id] ?? id} ${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`).join(', ') || 'ei vielä suuntaa'}.`)
  return L.join('\n')
}

// --- Telegramin pikavastaukset ilman mallia --------------------------------------------------------
const YES = /^(joo|juu|kyllä|kylla|jep|ok|okei|laita|laita (se|tuo|tää|tämä|päälle|pyörimään)|käynnistä|kaynnista|katsotaan( se| tuo)?|sopii|mennään( sillä)?|tuo käy|se käy)\s*[.!]*$/i
const NEXT = /^(seuraava|toinen|joku muu|jotain muuta|ei|ei tuo|ei se|ohita|skip)(\s+leffa)?\s*[.!]*$/i
const SEEN = /^(nähty|nahty|olen nähnyt( sen| tuon)?|oon nähny?t?( sen| tuon)?|nähnyt jo|jo nähty)\s*[.!]*$/i
const RATE = /^(?:(?:leffa|elokuva|se|tuo|(.{2,60}?))\s+oli\s+)?(hyvä|hyva|huono|tylsä|tylsa|mahtava|loistava|paska|surkea|ok)\s*[.!]*$/i

/** null = ei leffa-asia (anna muiden pikakomentojen / mallin hoitaa). */
export async function movieQuick(text) {
  const t = String(text ?? '').trim()
  const s = load()
  const awaiting = s.ehdotus?.awaiting && Date.now() - new Date(s.ehdotus.at).getTime() < ANSWER_WINDOW_MS
  const r = t.match(RATE)
  // "Dune oli hyvä" vain jos nimi on JARVISin lokissa; "leffa/se oli hyvä" = viimeksi käynnistetty.
  const named = r?.[1] && Object.values(s.nahty).some((x) => norm(x.t) === norm(r[1]) || (norm(r[1]).length >= 4 && norm(x.t).includes(norm(r[1]))))
  if (r && s.viimeisin && (named || (!r[1] && /^(leffa|elokuva|se|tuo)\s+oli/i.test(t)))) {
    const good = /hyv|mahtav|loistav/i.test(r[2])
    const bad = /huono|tyls|paska|surkea/i.test(r[2])
    return rate({ arvio: good ? 'hyva' : bad ? 'huono' : 'ok', nimi: r[1] })
  }
  const m = t.match(/^(?:(?:aloita|laita|käynnistä)\s+)?(?:leffa\s*ilta|elokuvailta|leffa|leffaa|elokuva|ehdota leffa|ehdota elokuva)\s+(.{3,60}?)\s*[.!?]*$/i)
  if (m && moviesConfigured()) {
    const req = parseRequest(m[1])
    if (req.recognized) return suggest({ genre: m[1], pika: true })
  }
  if (awaiting) {
    if (YES.test(t)) return launch()
    const pick = t.match(/^(?:laita\s+|numero\s+|nro\s+)?([123])\s*[.!]*$/i)
    if (pick) return launch({ valinta: Number(pick[1]) })
    if (NEXT.test(t)) return next()
    if (SEEN.test(t)) return next({ nahty: true })
    // Muu viesti: ehdotukseen ei enää vastata pikakomennoilla (malli hoitaa, jos Elias palaa siihen).
    s.ehdotus.awaiting = false
    save(s)
  }
  return null
}

// --- MCP-palvelin ---------------------------------------------------------------------------------
export function moviesServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const safe = (fn) => async (a) => {
    try {
      const r = await fn(a ?? {})
      console.log(`[jarvis] leffat: ${String(r).split('\n')[0].slice(0, 140)}`)
      return ok(r)
    } catch (err) {
      console.log(`[jarvis] leffat: virhe ${String(err?.message ?? err).slice(0, 160)}`)
      return { ...ok(`Leffat: ${err?.message ?? err}`), isError: true }
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_leffat',
    version: '1.0.0',
    instructions:
      'Elokuvaehdotukset Eliakselle: elokuva, jota hän ei ole nähnyt, Netflixistä tai Disney+:sta (Suomi), ja hyväksynnän jälkeen toisto projektorille. ' +
      '"Aloita leffailta kauhu", "leffa komedia" = leffa_ehdota (genre). Työkalu ottaa huomioon katseluhistorian, arviot ja niistä lasketut mieltymykset; ' +
      'voit lisäksi käyttää mitä tiedät Eliaksesta (tarkennus-kenttä). ' +
      'Kulku: leffa_ehdota → kerro pääehdotus lyhyesti + kaksi muuta nimeltä ja kysy "laitanko?" → "joo" = leffa_kaynnista, "kakkonen" = valinta 2, "seuraava/joku muu" = leffa_seuraava, ' +
      '"olen nähnyt" = leffa_seuraava nahty=true. ÄLÄ käynnistä ilman Eliaksen hyväksyntää. Älä keksi elokuvia itse: ehdota vain työkalun antamia.',
    tools: [
      tool(
        'leffa_ehdota',
        `Ehdottaa elokuvan, jota Elias ei ole nähnyt (oma loki + Netflix-historia), genren mukaan. Genret: ${GENRE_WORDS.join(', ')} (yhdistelmät käyvät). ` +
          'tarkennus = vapaa teksti: lyhyt, uusi, klassikko, hyvä, suomalainen. palvelu: netflix, disney tai molemmat (oletus).',
        {
          genre: z.string().max(60).optional(),
          palvelu: z.enum(['netflix', 'disney', 'molemmat']).optional(),
          tarkennus: z.string().max(80).optional(),
          parhaat: z.boolean().optional().describe('true (oletus) = parhaiten arvioidut ensin; false = enemmän vaihtelua'),
        },
        safe((a) => suggest(a)),
      ),
      tool(
        'leffa_kaynnista',
        'Käynnistää hyväksytyn ehdotuksen projektorilla: projektori päälle → Netflix/Disney+ → haku ja toisto → valot pois → koneen näyttö kiinni. ' +
          'Kirjaa elokuvan nähdyksi. Ilman id:tä käynnistää viimeisimmän ehdotuksen. profiili = suoratoistopalvelun profiilin nimi (muistetaan).',
        { valinta: z.number().int().min(1).max(3).optional().describe('1 = pääehdotus, 2–3 = muut kärkivaihtoehdot'), id: z.number().int().optional(), palvelu: z.enum(['netflix', 'disney']).optional(), profiili: z.string().max(30).optional() },
        safe((a) => launch(a)),
      ),
      tool('leffa_seuraava', 'Seuraava ehdotus samalla haulla. nahty=true merkitsee nykyisen nähdyksi ensin (muuten se ohitetaan 60 päiväksi).', { nahty: z.boolean().optional() }, safe((a) => next(a))),
      tool('leffa_nahty', 'Merkitsee elokuvan nähdyksi nimellä (esim. Elias kertoo nähneensä jonkin), jotta sitä ei ehdoteta.', { nimi: z.string().min(1).max(100) }, safe((a) => markSeen(a.nimi))),
      tool(
        'leffa_arvio',
        'Eliaksen arvio katsotusta elokuvasta (makuoppi painottaa genrejä). Ilman nimeä = viimeksi käynnistetty.',
        { arvio: z.enum(['hyva', 'ok', 'huono']), nimi: z.string().max(100).optional() },
        safe((a) => rate(a)),
      ),
      tool('leffa_historia', 'Katseluhistorian tila: Netflix-historia, JARVISin loki, viimeisimmät ja makuprofiili. tuo=true lukee Netflix-historian uudelleen.', { tuo: z.boolean().optional() }, safe((a) => historyText(a))),
    ],
  })
}
