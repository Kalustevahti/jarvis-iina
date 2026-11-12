/**
 * Merkityshaku muistiin paikallisella Ollamalla (valinnainen, ei verkkoa, ei kustannusta).
 *
 * Sanahaku (muistikortit.mjs) löytää nimet ja samat sanat. Merkityshaku löytää myös osiot, joissa
 * asia sanotaan toisin ("asiakas sanoi että liian kallis" → osio "vastaväitteet: Mihin vertaat?").
 *
 * Käyttöön automaattisesti, kun Ollamassa on upotusmalli (bge-m3 suositus: monikielinen, toimii
 * suomella; myös nomic-embed-text, mxbai-embed-large, snowflake-arctic-embed2 kelpaavat).
 * Asennus: tyokalut\asenna_muistihaku.bat (ollama pull bge-m3, n. 1,2 Gt).
 *
 * Turva: kaikki tapahtuu tällä koneella (127.0.0.1:11434). Jokainen kutsu aikakatkaistaan; jos Ollama
 * ei vastaa, käytetään pelkkää sanahakua (ei virhettä käyttäjälle).
 * Välimuisti ~/.jarvis/muisti_vektorit.json (tekstin tiiviste → vektori), päivitetään taustalla.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildIndex } from './muistikortit.mjs'

const BASE = process.env.JARVIS_OLLAMA_URL || 'http://127.0.0.1:11434'
const CACHE = () => join(homedir(), '.jarvis', 'muisti_vektorit.json')
const PREFERRED = ['bge-m3', 'snowflake-arctic-embed2', 'mxbai-embed-large', 'nomic-embed-text', 'all-minilm']
const QUERY_TIMEOUT_MS = Number(process.env.JARVIS_EMBED_TIMEOUT_MS || 700)

let model = null // null = ei tarkistettu, '' = ei saatavilla
let checkedAt = 0
let cache = null
let warming = null
let failures = 0
let lastFailureAt = 0
let refreshing = null

/** Mallin tarkistus taustalla: viestin käsittely ei koskaan odota /api/tags-kutsua. */
function refreshModelInBackground() {
  if (refreshing || (model != null && Date.now() - checkedAt < 10 * 60_000)) return
  refreshing = embedModel({ force: true }).finally(() => {
    refreshing = null
  })
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16)

function loadCache() {
  if (cache) return cache
  try {
    cache = existsSync(CACHE()) ? JSON.parse(readFileSync(CACHE(), 'utf8')) : null
  } catch {
    cache = null
  }
  if (!cache || typeof cache !== 'object' || !cache.items) cache = { model: '', items: {} }
  return cache
}
function saveCache() {
  try {
    const dir = join(homedir(), '.jarvis')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(CACHE(), JSON.stringify(cache))
  } catch {
    /* ok */
  }
}

async function fetchJson(path, body, timeoutMs) {
  const r = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) throw new Error(`ollama ${r.status}`)
  return r.json()
}

/** Etsii asennetun upotusmallin (tarkistus enintään 10 min välein). */
export async function embedModel({ force = false } = {}) {
  if (process.env.JARVIS_EMBED === '0') return ''
  if (!force && model != null && Date.now() - checkedAt < 10 * 60_000) return model
  checkedAt = Date.now()
  try {
    const tags = await fetchJson('/api/tags', null, 1500)
    const names = (tags?.models ?? []).map((m) => String(m.name ?? m.model ?? ''))
    const want = process.env.JARVIS_EMBED_MODEL
    const pick = want ? names.find((n) => n.startsWith(want)) : PREFERRED.map((p) => names.find((n) => n.startsWith(p))).find(Boolean)
    model = pick || names.find((n) => /embed/i.test(n)) || ''
  } catch {
    model = ''
  }
  return model
}

async function embed(texts, timeoutMs) {
  const m = await embedModel()
  if (!m) return null
  const res = await fetchJson('/api/embed', { model: m, input: texts, keep_alive: '30m', truncate: true }, timeoutMs)
  const vecs = res?.embeddings
  return Array.isArray(vecs) && vecs.length === texts.length ? vecs : null
}

const docText = (d) => `${d.title}\n${d.text}`.slice(0, 2000)

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Laskee puuttuvat vektorit taustalla (16 kerrallaan). Ei koskaan kahta yhtä aikaa. */
export function warmUp() {
  if (warming) return warming
  warming = (async () => {
    const m = await embedModel()
    if (!m) return 0
    const c = loadCache()
    if (c.model !== m) {
      c.model = m
      c.items = {}
    }
    const docs = buildIndex().docs
    const need = docs.filter((d) => !c.items[hash(docText(d))])
    let done = 0
    for (let i = 0; i < need.length; i += 16) {
      const batch = need.slice(i, i + 16)
      let vecs = null
      try {
        vecs = await embed(batch.map(docText), 60_000)
      } catch (err) {
        console.warn('[jarvis] muistivektori: upotus epäonnistui:', err?.message ?? err)
        break
      }
      if (!vecs) break
      batch.forEach((d, j) => {
        c.items[hash(docText(d))] = vecs[j].map((x) => Math.round(x * 1e4) / 1e4)
      })
      done += batch.length
    }
    // Siivous: vain nykyisten osioiden vektorit säilyvät.
    const live = new Set(docs.map((d) => hash(docText(d))))
    for (const k of Object.keys(c.items)) if (!live.has(k)) delete c.items[k]
    if (done) {
      saveCache()
      console.log(`[jarvis] muistivektori: ${done} uutta vektoria (${m})`)
    }
    return done
  })().finally(() => {
    warming = null
  })
  return warming
}

/**
 * Merkitysosumat viestille. Palauttaa indeksin dokumentteja (kynnys 0,55), tai [] jos ei käytössä / ei ehdi.
 * Ei koskaan heitä virhettä.
 */
export async function semanticHits(text, { limit = 3, kinds = ['oppi', 'taito', 'keskustelu', 'kortti', 'paivakirja'], min = 0.55 } = {}) {
  try {
    // Toistuvat aikakatkaisut → 10 min tauko, sitten yritetään taas.
    if (failures >= 5) {
      if (Date.now() - lastFailureAt < 10 * 60_000) return []
      failures = 0
    }
    refreshModelInBackground()
    const m = model
    if (!m) return []
    const c = loadCache()
    if (c.model !== m || !Object.keys(c.items).length) {
      void warmUp()
      return []
    }
    const q = await embed([String(text).slice(0, 1500)], QUERY_TIMEOUT_MS).catch(() => null)
    if (!q) {
      failures++
      lastFailureAt = Date.now()
      return []
    }
    failures = 0
    const docs = buildIndex().docs.filter((d) => kinds.includes(d.kind))
    const scored = []
    let missing = 0
    for (const d of docs) {
      const v = c.items[hash(docText(d))]
      if (!v) {
        missing++
        continue
      }
      const s = cosine(q[0], v)
      if (s >= min) scored.push({ d, s })
    }
    if (missing) void warmUp()
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.d)
  } catch {
    failures++
    lastFailureAt = Date.now()
    return []
  }
}

export const vectorStatus = async () => {
  const m = await embedModel({ force: true })
  const c = loadCache()
  return m ? `käytössä (${m}, ${Object.keys(c.items).length} vektoria)` : 'ei käytössä (aja tyokalut\\asenna_muistihaku.bat)'
}

/** Viestikohtainen muistihuomautus: sanahaku + (jos käytössä) merkityshaku. Ei koskaan heitä. */
export async function memoryNote(recall, text) {
  let extra = []
  try {
    extra = await semanticHits(text)
  } catch {
    extra = []
  }
  return recall(text, { extra })
}
