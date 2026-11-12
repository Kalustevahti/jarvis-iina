/**
 * Weekly "what did I learn and from where" digest (Elias 8.11.2026: "kysy sunnuntaisin mitä opit ja mistä, vertaa CRM:ään").
 *
 * Deterministic, no model: compares the learning files against last week's snapshot (~/.jarvis/viikko_oppi.json) and lists
 * the NEW lines per file, with the source/date the line itself carries. Sent with the Sunday memory self-test so Elias can
 * correct anything wrong ("unohda …", "korjaa …"). First run only stores the baseline.
 * No project imports (used by muistiuni.mjs).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MEM = () => join(homedir(), 'Documents', 'JARVIS', 'muisti')
const SNAP = () => join(homedir(), '.jarvis', 'viikko_oppi.json')

/** label, file, what counts as an item: 'lines' = "- " lines, 'sections' = "## " headings */
const FILES = [
  ['Toimintasäännöt ja toiveet', 'jarvis_muisti.md', 'lines'],
  ['Profiili (miten ymmärrän sinut)', 'elias.md', 'lines'],
  ['Myyntioppi', 'myyntioppi.md', 'sections'],
  ['Liidioppi', 'liidioppi.md', 'lines'],
  ['Taidot', 'taidot.md', 'sections'],
  ['Tutkittu myyntitieto', 'myyntitieto.md', 'sections'],
  ['Viat (omat ongelmat)', 'viat.md', 'sections'],
]

const norm = (l) =>
  String(l)
    .replace(/^[-*]\s+/, '')
    .replace(/^#+\s+/, '')
    .replace(/\((varma|todennäköinen|arvaus|epävarma)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
// Stored as normalized text (not a hash): the profile is rewritten nightly, so a reworded line must not count as new.
const key = (l) => norm(l).slice(0, 200)
const tokens = (s) => new Set(String(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))
const similar = (a, b) => {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size || !B.size) return a === b
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return n / Math.min(A.size, B.size) >= 0.7
}

export function items(text, kind) {
  const out = []
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trim()
    if (kind === 'sections' ? /^##\s+\S/.test(l) : /^-\s+\S/.test(l) && !/^-\s+\[[ x]\]/.test(l)) {
      if (norm(l).length >= 6) out.push(l)
    }
  }
  return out
}

/** Pure: new items between two snapshots. Exported for tests. */
export function diffItems(prevKeys = [], curItems = []) {
  const prev = new Set(prevKeys)
  return curItems.filter((l) => {
    const k = key(l)
    if (prev.has(k)) return false
    for (const p of prevKeys) if (similar(p, k)) return false
    return true
  })
}

const short = (l, n = 150) => {
  const t = String(l).replace(/^[-#\s]+/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * Builds the digest and stores the new snapshot. Returns the text ('' if nothing new) or the baseline notice.
 * `read` and `snapPath` are injectable for tests.
 */
export function weeklyLearningDigest({ read = (f) => (existsSync(join(MEM(), f)) ? readFileSync(join(MEM(), f), 'utf8') : ''), snapPath = SNAP(), now = new Date() } = {}) {
  let snap = null
  try {
    snap = existsSync(snapPath) ? JSON.parse(readFileSync(snapPath, 'utf8')) : null
  } catch {
    snap = null
  }
  const next = { at: now.toISOString(), files: {} }
  const parts = []
  let total = 0
  for (const [label, file, kind] of FILES) {
    const cur = items(read(file), kind)
    next.files[file] = cur.map(key)
    if (!snap?.files?.[file]) continue
    const added = diffItems(snap.files[file], cur)
    if (!added.length) continue
    total += added.length
    parts.push(`${label} (+${added.length}):\n${added.slice(0, 5).map((l) => `  - ${short(l)}`).join('\n')}${added.length > 5 ? `\n  - … ja ${added.length - 5} muuta (muisti/${file})` : ''}`)
  }
  try {
    const dir = join(homedir(), '.jarvis')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(snapPath, JSON.stringify(next))
  } catch {
    /* digest still useful without the snapshot */
  }
  if (!snap) return 'VIIKON OPIT: lähtötilanne tallennettu. Ensi sunnuntaina kerron tässä, mitä opin viikon aikana ja mistä.'
  const since = new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'numeric' }).format(new Date(snap.at))
  if (!total) return `VIIKON OPIT (${since} jälkeen): ei uusia oppeja. Jos opetit jotain, mitä en kirjannut, sano "muista: …".`
  return (
    `VIIKON OPIT (${since} jälkeen, ${total} uutta) — tarkista, ovatko nämä oikein:\n${parts.join('\n')}\n\n` +
    `Väärä oppi: sano "unohda …" tai "korjaa: …". Lähde: kysy "mistä opit X", niin näytän keskustelun tai lokin.`
  )
}
