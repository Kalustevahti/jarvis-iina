/**
 * Viat: JARVIS muistaa omat ongelmansa — mitä meni pieleen, mitä kokeiltiin, mikä auttoi — ja käyttää sitä seuraavalla
 * kerralla (myös kun Claude Code rakentaa JARVISia tai JARVIS rakentaa ohjelman).
 *
 *   muisti/viat.md          yksi vika = "## V<n> · <alue> · avoin|ratkaistu" + Oire / Kokeiltu / Epäily / Tarvitaan / Ratkaisu.
 *                           Sama alue + samankaltainen oire → sama vika päivittyy (toistumiskerta kasvaa), ei uutta riviä.
 *                           Avoimet (≤5) näkyvät istunnon alussa; Muisti 2.0 -haku tuo osuvat viat viestin yhteyteen.
 *   muisti/rakennusoppi.md  rakennus-opit: mitä Claude Code oppi rakentaessaan tällä koneella (rakenna.mjs lisää,
 *                           ja seuraava rakennus saa ne promptiinsa).
 *
 * Ei koskaan salasanoja, avaimia, koodeja, puhelinnumeroita tai henkilötunnuksia (scrub).
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MEMORY_DIR = () => process.env.JARVIS_MEMORY_DIR || join(homedir(), 'Documents', 'JARVIS', 'muisti')
const FILE = () => join(MEMORY_DIR(), 'viat.md')
const BUILD_FILE = () => join(MEMORY_DIR(), 'rakennusoppi.md')
const MAX_FAULTS = 80
const HEAD =
  '# JARVISin viat — mitä on mennyt pieleen, mitä kokeiltiin, mikä auttoi\n\n' +
  'JARVIS kirjaa tähän itse (vika_kirjaa). Claude Code -istunnot: lue avoimet ennen rakentamista ja merkitse korjatut ratkaistuiksi.\n'
const SECRET = [/\b(sk|gsk|AIza|xox[bp]|ghp)[-_A-Za-z0-9]{12,}/g, /\b\d{6}[-+A]\d{3}[0-9A-Y]\b/g, /\b(?:\d[ -]?){13,19}\b/g, /(\+358|\b0)[ -]?4\d[ -]?\d{3}[ -]?\d{3,4}\b/g, /(salasana|password|token|api[_ -]?key)\s*[:=]\s*\S+/gi]
const scrub = (s) => SECRET.reduce((t, re) => t.replace(re, '[poistettu]'), String(s ?? ''))
const oneLine = (s, n) => scrub(s).replace(/\s*\n\s*/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, n)
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9åäö ]+/g, ' ').replace(/\s+/g, ' ').trim()
const stamp = () => new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'numeric', year: 'numeric' }).format(new Date())
const FIELDS = [
  ['oire', 'Oire'],
  ['kokeiltu', 'Kokeiltu'],
  ['epaily', 'Epäily'],
  ['tarvitaan', 'Tarvitaan'],
  ['ratkaisu', 'Ratkaisu'],
]

/** Parse muisti/viat.md → [{ id, n, area, state, date, count, oire, kokeiltu, epaily, tarvitaan, ratkaisu, body }] */
export function readFaults() {
  try {
    if (!existsSync(FILE())) return []
    return readFileSync(FILE(), 'utf8')
      .replace(/^﻿/, '')
      .split(/\n(?=## )/)
      .filter((b) => /^## V\d+ · /.test(b))
      .map((b) => {
        const head = b.split('\n')[0].slice(3).split(' · ').map((x) => x.trim())
        const f = { id: head[0], n: Number(head[0].slice(1)), area: head[1] ?? '', state: /ratkaistu/i.test(head[2] ?? '') ? 'ratkaistu' : 'avoin' }
        const meta = (b.match(/\*\*Pvm:\*\*\s*(.+)/) || [])[1] ?? ''
        f.date = (meta.match(/^[\d.]+/) || [''])[0]
        f.count = Number((meta.match(/toistunut (\d+)×/) || [])[1] ?? 1)
        f.last = (meta.match(/viimeksi ([\d.]+)/) || [])[1] ?? f.date
        for (const [k, label] of FIELDS) f[k] = ((b.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`)) || [])[1] ?? '').trim()
        return f
      })
  } catch {
    return []
  }
}

function render(f) {
  return (
    `## ${f.id} · ${f.area} · ${f.state}\n` +
    `**Pvm:** ${f.date}${f.count > 1 ? ` (toistunut ${f.count}×, viimeksi ${f.last})` : ''}\n` +
    FIELDS.filter(([k]) => f[k]).map(([k, label]) => `**${label}:** ${f[k]}`).join('\n')
  )
}

function writeFaults(list) {
  if (!existsSync(MEMORY_DIR())) mkdirSync(MEMORY_DIR(), { recursive: true })
  if (existsSync(FILE())) copyFileSync(FILE(), join(MEMORY_DIR(), 'viat.edellinen.md'))
  // Over the cap: drop the oldest solved ones first (an open fault is never forgotten silently).
  let keep = list.slice().sort((a, b) => a.n - b.n)
  while (keep.length > MAX_FAULTS) {
    const i = keep.findIndex((x) => x.state === 'ratkaistu')
    keep.splice(i >= 0 ? i : 0, 1)
  }
  writeFileSync(FILE(), HEAD + '\n' + keep.map(render).join('\n\n') + '\n')
}

const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 3).map((w) => w.slice(0, 6)))
function similar(a, b) {
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / Math.min(A.size, B.size)
}

/**
 * Record or update a fault. Same open fault (same area, similar symptom) or the given id → updated, count +1 when it
 * recurred. Returns { id, action: 'uusi' | 'päivitetty' | 'ratkaistu', count }.
 */
export function logFault({ id, alue, oire, kokeiltu, epaily, tarvitaan, ratkaisu, tila } = {}) {
  const list = readFaults()
  const area = oneLine(alue, 40).toLowerCase()
  let f = id ? list.find((x) => x.id.toLowerCase() === String(id).trim().toLowerCase()) : null
  if (id && !f) throw new Error(`vikaa ${id} ei löydy (viat listaa)`)
  const solved = tila === 'ratkaistu' || (!!ratkaisu && tila !== 'avoin')
  let matched = false
  if (!f && area && oire) {
    // Same area + similar symptom = the same fault again (an open one, or a "solved" one that came back).
    const same = (x) => norm(x.area) === norm(area) && similar(x.oire, oire) >= (x.state === 'avoin' ? 0.5 : 0.6)
    f = list.filter(same).sort((a, b) => (a.state === 'avoin') - (b.state === 'avoin') || a.n - b.n).pop() ?? null
    matched = !!f
  }
  if (!f) {
    if (!area || !oire) throw new Error('alue ja oire tarvitaan uuteen vikaan')
    f = { id: `V${list.reduce((m, x) => Math.max(m, x.n), 0) + 1}`, area, date: stamp(), last: stamp(), count: 1, state: 'avoin' }
    f.n = Number(f.id.slice(1))
    list.push(f)
    f._new = true
  } else if (matched && !solved) {
    // Recurrence: the same thing failed again (a solved fault re-opens).
    f.count = (f.count || 1) + 1
    f.last = stamp()
    f.state = 'avoin'
  } else if (tila === 'avoin') f.state = 'avoin'
  if (oire && (f._new || !f.oire)) f.oire = oneLine(oire, 300)
  if (kokeiltu) f.kokeiltu = oneLine(f.kokeiltu && !f._new ? `${f.kokeiltu} · ${stamp()}: ${kokeiltu}` : kokeiltu, 600)
  if (epaily) f.epaily = oneLine(epaily, 300)
  if (tarvitaan) f.tarvitaan = oneLine(tarvitaan, 300)
  if (ratkaisu) f.ratkaisu = oneLine(`${ratkaisu} (${stamp()})`, 400)
  if (solved) {
    f.state = 'ratkaistu'
    f.tarvitaan = ''
  }
  const action = f._new ? 'uusi' : solved ? 'ratkaistu' : 'päivitetty'
  delete f._new
  writeFaults(list)
  console.log(`[jarvis] viat: ${action} ${f.id} (${f.area})`)
  return { id: f.id, action, count: f.count, area: f.area }
}

export function findFaults(q, n = 3) {
  const ws = norm(q).split(' ').filter((w) => w.length > 2)
  if (!ws.length) return []
  return readFaults()
    .map((f) => {
      const head = norm(`${f.area} ${f.oire}`)
      const hay = norm(`${f.area} ${f.oire} ${f.kokeiltu} ${f.epaily} ${f.ratkaisu}`)
      const score = ws.reduce((a, w) => a + (head.includes(w.slice(0, 6)) ? 3 : hay.includes(w.slice(0, 6)) ? 1 : 0), 0)
      return { f, score }
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score || b.f.n - a.f.n)
    .slice(0, n)
    .map((x) => x.f)
}

export const faultText = (f) => render(f)

/** Session start: open faults (max 5, newest first), one line each. */
export function faultsBlock() {
  const open = readFaults()
    .filter((f) => f.state === 'avoin')
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
  if (!open.length) return ''
  return (
    `\n\nAVOIMET VIAT (muisti/viat.md; kun sama asia tulee vastaan, kokeile silti — ehkä se on jo korjattu — ja päivitä vika_kirjaa):\n` +
    open.map((f) => `- ${f.id} ${f.area}: ${f.oire.slice(0, 120)}${f.tarvitaan ? ` → tarvitaan: ${f.tarvitaan.slice(0, 100)}` : ''}${f.count > 1 ? ` (${f.count}×)` : ''}`).join('\n')
  )
}

// ---- Rakennusoppi: mitä rakentaessa opittiin (rakenna.mjs) ----

/** Last n build lessons as lines ("- 8.11.2026 (peli): …"). */
export function readBuildLessons(n = 15) {
  try {
    if (!existsSync(BUILD_FILE())) return []
    return readFileSync(BUILD_FILE(), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .slice(-n)
  } catch {
    return []
  }
}

/** Append lessons (deduplicated against what is already there). Returns how many were added. */
export function addBuildLessons(project, lessons) {
  const have = new Set(readBuildLessons(400).map((l) => norm(l.replace(/^- [\d.]+ \([^)]*\):\s*/, ''))))
  const fresh = (Array.isArray(lessons) ? lessons : [lessons])
    .map((l) => oneLine(String(l).replace(/^[-*•\d.)\s]+/, ''), 300))
    .filter((l) => l.length > 10 && l !== '—' && !have.has(norm(l)))
    .slice(0, 5)
  if (!fresh.length) return 0
  if (!existsSync(MEMORY_DIR())) mkdirSync(MEMORY_DIR(), { recursive: true })
  if (!existsSync(BUILD_FILE()))
    writeFileSync(BUILD_FILE(), '# Rakennusoppi — mitä Claude Code on oppinut rakentaessaan ohjelmia tällä koneella\n\nrakenna.mjs lisää nämä jokaiseen uuteen rakennukseen.\n\n')
  appendFileSync(BUILD_FILE(), fresh.map((l) => `- ${stamp()} (${oneLine(project, 40)}): ${l}`).join('\n') + '\n')
  return fresh.length
}

/** Pull "OPIT:" lines out of a Claude Code final report. */
export function parseLessons(report) {
  const m = String(report ?? '').match(/(?:^|\n)\s*\**OPIT\**\s*:?\s*\**([\s\S]*)$/i)
  if (!m) return []
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*•\d]/.test(l) || (l && !/^[A-ZÅÄÖ ]{4,}:/.test(l)))
    .map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((l) => l.length > 10 && l !== '—')
    .slice(0, 5)
}
