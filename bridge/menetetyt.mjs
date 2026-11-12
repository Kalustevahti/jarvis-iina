/**
 * Menetetyt asiakkaat ja tarjoukset (CRM: vaihe Hävitty) eivät kuulu JARVISin muistiin — ne näkyvät CRM:ssä.
 *
 * Lista ~/.jarvis/menetetyt.json: { updated, synced, orgs: [{ id, name, legal, businessId, at, since, source, reason,
 *   ambiguous, archived: [{ file, original }], tasks: [rivi] }] }
 *  - markLost(org): heti kun JARVIS on kirjannut menetyksen CRM:ään (crm.mjs, vahvistuksen jälkeen).
 *  - syncLost(orgs): CRM:n Hävitty-vaiheiset yritykset (crm.watchCrm 30 min välein). Menetetty = VAIN vaihe "lost".
 * Kun yritys tulee listalle (purgeLost):
 *  - yrityksen kortti (tarkka nimi) ja sen ihmisten kortit (rooli "titteli, Yritys") → kortit/arkisto/menetetyt/
 *    (ei poisteta; oma yritys, Elias, Iina ja tiimi eivät koskaan);
 *  - avoimet asiat, jotka mainitsevat yrityksen → arkistoon (palautetaan, jos yritys palaa aktiiviseksi);
 *  - ryhmän seurannat (neuvoja_seuranta.json), jotka tehtiin yritykselle ennen menetystä, suljetaan.
 * muistikortit.mjs estää lisäksi uudet kortit/avoimet ja nimeää päiväkirjarivit "menetetty asiakas".
 * Samanniminen aktiivinen yritys CRM:ssä → nimeä ei käytetä tunnistukseen (ambiguous), ettei aktiivinen katoa.
 * Jos yritys palaa CRM:ssä aktiiviseen vaiheeseen, se poistuu listalta ja kortit + avoimet palautetaan.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  backup,
  cardDir,
  cardIsLost,
  companyBase,
  companyKey,
  invalidateIndex,
  invalidateLost,
  listCards,
  lostFile,
  lostMentionOrg,
  parseTasks,
  readText,
  tasksFile,
  today,
  writeAtomic,
} from './muistikortit.mjs'

const archiveDir = () => join(cardDir(), 'arkisto', 'menetetyt')
const followFile = () => join(homedir(), '.jarvis', 'neuvoja_seuranta.json')
const REVIVE_GRACE_MS = 15 * 60_000 // juuri kirjattu menetys: CRM:n tila voi päivittyä hetken viiveellä
const ACTIVE = new Set(['lead', 'prospect', 'meeting_booked', 'offered', 'decision_pending', 'customer'])
// Oma yritys ei ole koskaan "menetetty asiakas" (esim. testirivi CRM:ssä Hävitty-vaiheessa).
const OWN = new Set(['kalustovahti'])

export function readLost() {
  try {
    const j = JSON.parse(readText(lostFile()) || '{}')
    return { synced: j?.synced === true, orgs: Array.isArray(j?.orgs) ? j.orgs.filter((o) => o && typeof o === 'object' && (o.name || o.legal)) : [] }
  } catch {
    return { synced: false, orgs: [] }
  }
}
function saveLost(state) {
  const dir = join(homedir(), '.jarvis')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeAtomic(lostFile(), `${JSON.stringify({ updated: new Date().toISOString(), synced: state.synced === true, orgs: state.orgs }, null, 1)}\n`)
  invalidateLost()
  invalidateIndex()
}

const keysOf = (o) => [o.name, o.legal, o.display_name, o.legal_name].map(companyKey).filter((k) => k.length >= 3)
const entryOf = (org, extra = {}) => ({
  id: org.id ?? null,
  name: companyBase(org.display_name || org.name || org.legal_name || org.legal || ''),
  legal: org.legal_name || org.legal || '',
  businessId: org.business_id || org.businessId || '',
  at: new Date().toISOString(),
  since: new Date().toISOString(),
  archived: [],
  tasks: [],
  ...extra,
})
const isOwn = (e) => keysOf(e).some((k) => OWN.has(k))
/** Hakemisto listan riveille: id, Y-tunnus, nimiavain → rivi (ei neliöllistä vertailua). */
function indexOrgs(list) {
  const byId = new Map()
  const byBid = new Map()
  const byKey = new Map()
  for (const o of list) {
    if (o.id) byId.set(o.id, o)
    if (o.businessId) byBid.set(o.businessId, o)
    for (const k of keysOf(o)) if (!byKey.has(k)) byKey.set(k, o)
  }
  return { find: (e) => (e.id && byId.get(e.id)) || (e.businessId && byBid.get(e.businessId)) || keysOf(e).map((k) => byKey.get(k)).find(Boolean) || null }
}

/** Siirtää menetettyjen yritysten kortit, avoimet asiat ja vanhat ryhmäseurannat pois muistista. Idempotentti. Kirjaa siirrot state-olioon. */
export function purgeLost(state = readLost()) {
  const out = { cards: [], tasks: [], follows: 0 }
  if (!state.orgs.length) return out
  // muistikortit lukee listan levyltä → vastaava state-olion rivi (siihen kirjataan siirrot)
  const idx = indexOrgs(state.orgs)
  const own = (o) => (o ? idx.find(o) : null)
  // 1) Kortit → kortit/arkisto/menetetyt/
  try {
    for (const c of listCards()) {
      const org = own(cardIsLost(c))
      if (!org) continue
      const from = join(cardDir(), c.file)
      if (!existsSync(from)) continue
      if (!existsSync(archiveDir())) mkdirSync(archiveDir(), { recursive: true })
      let to = join(archiveDir(), c.file)
      for (let i = 2; existsSync(to) || existsSync(`${to}.palautettu`); i++) to = join(archiveDir(), c.file.replace(/\.md$/, `.${i}.md`))
      try {
        renameSync(from, to)
      } catch (err) {
        console.warn(`[jarvis] menetetyt: kortin ${c.file} siirto epäonnistui:`, err?.message ?? err)
        continue
      }
      org.archived = [...(org.archived ?? []), { file: to.split(/[\\/]/).pop(), original: c.file }]
      out.cards.push(c.name)
    }
  } catch (err) {
    console.warn('[jarvis] menetetyt: korttien siirto keskeytyi:', err?.message ?? err)
  }
  // 2) Avoimet asiat, jotka mainitsevat menetetyn yrityksen → arkistoon (palautetaan, jos yritys palaa)
  try {
    const cur = readText(tasksFile())
    const lostTasks = cur ? parseTasks(cur).filter((t) => !t.done).map((t) => [t, own(lostMentionOrg(t.text))]).filter(([, o]) => o) : []
    if (lostTasks.length) {
      backup(tasksFile())
      let next = cur
      for (const [t] of lostTasks) next = next.replace(`${t.line}\n`, '').replace(t.line, '')
      if (!existsSync(archiveDir())) mkdirSync(archiveDir(), { recursive: true })
      appendFileSync(join(archiveDir(), 'avoimet.md'), `${lostTasks.map(([t]) => `${t.line} · siirretty ${today()} (menetetty asiakas)`).join('\n')}\n`)
      writeAtomic(tasksFile(), next)
      for (const [t, o] of lostTasks) o.tasks = [...(o.tasks ?? []), t.line]
      out.tasks.push(...lostTasks.map(([t]) => t.text))
    }
  } catch (err) {
    console.warn('[jarvis] menetetyt: avoimien siirto epäonnistui:', err?.message ?? err)
  }
  // 3) Ryhmän seurannat, jotka tehtiin tälle yritykselle ENNEN menetystä → suljetaan (uusi, tietoinen paluumuistutus saa jäädä)
  try {
    const p = followFile()
    const list = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
    if (Array.isArray(list)) {
      let n = 0
      for (const f of list) {
        if (!f || f.done) continue
        const org = own(lostMentionOrg(String(f.yritys ?? '').trim() || f.mita))
        // since puuttuu = menetys havaittiin ensimmäisessä CRM-tarkistuksessa (ajankohta tuntematon) → ei suljeta
        if (!org?.since || !(Number(f.created) < Date.parse(org.since))) continue
        f.done = true
        f.suljettu = 'menetetty asiakas'
        n++
      }
      if (n) {
        writeFileSync(p, JSON.stringify(list))
        out.follows = n
      }
    }
  } catch (err) {
    console.warn('[jarvis] menetetyt: seurantojen sulkeminen epäonnistui:', err?.message ?? err)
  }
  if (out.cards.length || out.tasks.length) invalidateIndex()
  return out
}

/** Palauttaa yrityksen kortit ja avoimet muistiin (yritys palasi CRM:ssä aktiiviseksi). */
function restore(entry) {
  const back = []
  for (const a of entry.archived ?? []) {
    if (!a?.file) continue
    const from = join(archiveDir(), a.file)
    const to = join(cardDir(), a.original || a.file)
    if (!existsSync(from)) continue
    try {
      if (!existsSync(to)) renameSync(from, to)
      else {
        // Samanniminen kortti on syntynyt välillä → arkistoitu sisältö liitetään sen loppuun (ei tuplakorttia, ei katoa).
        const have = new Set(readText(to).split('\n').map((l) => l.trim()).filter(Boolean))
        const add = readText(from).split('\n').filter((l) => l.trim() && !have.has(l.trim()) && !/^# /.test(l))
        if (add.length) appendFileSync(to, `\n## Palautettu arkistosta (${today()})\n${add.join('\n')}\n`)
        renameSync(from, `${from}.palautettu`)
      }
      back.push(a.original || a.file)
    } catch {
      /* jää arkistoon */
    }
  }
  if (entry.tasks?.length) {
    try {
      const cur = readText(tasksFile())
      const have = new Set(parseTasks(cur).map((t) => t.id))
      const lines = entry.tasks.filter((l) => !have.has(parseTasks(l)[0]?.id))
      if (lines.length) writeAtomic(tasksFile(), `${(cur || '# Avoimet asiat (JARVIS seuraa näitä; merkitse [x] kun tehty)\n').replace(/\s*$/, '\n')}${lines.join('\n')}\n`)
    } catch (err) {
      console.warn('[jarvis] menetetyt: avoimien palautus epäonnistui:', err?.message ?? err)
    }
  }
  if (back.length || entry.tasks?.length) invalidateIndex()
  return back
}

/**
 * JARVIS kirjasi menetyksen CRM:ään (vahvistettu). org = CRM:n organisaatiorivi tai { name }.
 * others = CRM:n muut yritykset (samannimisen aktiivisen yrityksen tunnistukseen).
 */
export function markLost(org, { reason = '', source = 'kirjaus', others = [] } = {}) {
  let state = null
  let r = null
  try {
    state = readLost()
    const e = entryOf(org, { source, reason: String(reason ?? '').slice(0, 200) })
    if (!e.name || isOwn(e)) return null
    const activeKeys = new Set((Array.isArray(others) ? others : []).filter((o) => o && o.id !== e.id && o.lifecycle_stage !== 'lost').flatMap(keysOf))
    e.ambiguous = keysOf(e).some((k) => activeKeys.has(k))
    const old = indexOrgs(state.orgs).find(e)
    if (old) Object.assign(old, { id: old.id ?? e.id, businessId: old.businessId || e.businessId, reason: e.reason || old.reason, since: old.since || e.since, ambiguous: e.ambiguous })
    else state.orgs.push(e)
    saveLost(state)
    r = purgeLost(state)
    console.log(`[jarvis] menetetyt: ${e.name} merkitty menetetyksi (kortteja arkistoon ${r.cards.length}, avoimia ${r.tasks.length}, seurantoja ${r.follows})`)
    return r
  } catch (err) {
    console.warn('[jarvis] menetetyt: merkintä epäonnistui:', err?.message ?? err)
    return null
  } finally {
    // Arkistoitujen korttien/avoimien kirjanpito talteen (palautusta varten)
    if (state && r && (r.cards.length || r.tasks.length)) {
      try {
        saveLost(state)
      } catch {
        /* ok */
      }
    }
  }
}

/** CRM:n tila → lista. orgs = allOrganizations({ fresh: true }). Menetetty = vaihe "lost". */
export function syncLost(orgs = []) {
  if (!Array.isArray(orgs) || !orgs.length) return null // CRM ei vastannut: ei muuteta mitään
  const state = readLost()
  const first = !state.synced
  const sig = () => JSON.stringify(state.orgs.map((o) => [o.id, o.name, Boolean(o.ambiguous)]))
  const before = sig()
  const idx = indexOrgs(state.orgs)
  const activeKeys = new Set(orgs.filter((o) => o.lifecycle_stage !== 'lost').flatMap(keysOf))
  const added = []
  for (const org of orgs) {
    if (org.lifecycle_stage !== 'lost') continue
    // Ensimmäisellä tarkistuksella menetyksen ajankohta on tuntematon → ryhmän seurantoja ei suljeta (since null).
    const e = entryOf(org, { source: 'crm', since: first ? null : new Date().toISOString() })
    if (!e.name || isOwn(e)) continue
    const old = idx.find(e)
    if (old) {
      if (!old.id) old.id = e.id
      old.ambiguous = keysOf(old).some((k) => activeKeys.has(k))
      continue
    }
    e.ambiguous = keysOf(e).some((k) => activeKeys.has(k))
    state.orgs.push(e)
    added.push(e.name)
  }
  // Palasi aktiiviseen vaiheeseen CRM:ssä → pois listalta, kortit ja avoimet takaisin (vain jos yritys löytyy CRM:stä)
  const byId = new Map(orgs.filter((x) => x.id).map((x) => [x.id, x]))
  const byBid = new Map(orgs.filter((x) => x.business_id).map((x) => [x.business_id, x]))
  const revived = []
  state.orgs = state.orgs.filter((o) => {
    const org = (o.id && byId.get(o.id)) || (o.businessId && byBid.get(o.businessId))
    if (!org || !ACTIVE.has(org.lifecycle_stage)) return true
    if (Date.now() - Date.parse(o.at || 0) < REVIVE_GRACE_MS) return true
    revived.push({ name: o.name, cards: restore(o) })
    return false
  })
  state.synced = true
  let r = { cards: [], tasks: [], follows: 0 }
  try {
    if (first || sig() !== before) saveLost(state)
    r = purgeLost(state)
  } finally {
    if (r.cards.length || r.tasks.length) saveLost(state)
  }
  if (added.length || revived.length || r.cards.length || r.tasks.length || r.follows)
    console.log(`[jarvis] menetetyt: CRM-tarkistus +${added.length} (${added.slice(0, 5).join(', ')}${added.length > 5 ? ', …' : ''}), palasi ${revived.length}, kortteja arkistoon ${r.cards.length} (${r.cards.slice(0, 8).join(', ')}), avoimia ${r.tasks.length}, seurantoja ${r.follows}`)
  return { added, revived, ...r }
}
