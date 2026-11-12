/**
 * Contact register (yhteydet): every person/company KalustoVahti (Iina) has contacted, its status, certainty and bookings.
 * Elias 6.11.: "valmista infra mihin voit lisätä kaikki Iinan buukit niin tiedämme kehen olemme olleet yhteydessä".
 *
 *   File: muisti/yhteydet.json  { version, paivitetty, kontaktit: [...] }
 *   Entry: { id, henkilo, yritys, varmuus, todiste, lahde, kanava, profiili, cid, ensikontakti, viimeisin, vastasi,
 *            tila, rooli, autot, buukit: [{ pvm, aika, pitaja, tila, kuka, kirjattu, lisatieto }], muistiinpanot: [{ pvm, kuka, teksti }] }
 *   varmuus: varma (company named in the conversation and the customer replied / named it), lahes_varma (Iina named it,
 *            no reply), todennakoinen (inferred), tuntematon. Never present anything below "varma" as a fact.
 *
 * CRM stays the system of record for companies in the pipeline; this register covers everyone contacted (also those who
 * never entered the CRM) so nobody is contacted twice by accident. The lead finder skips companies found here.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MEMORY_DIR = join(homedir(), 'Documents', 'JARVIS', 'muisti')
export const CONTACTS_DB = join(MEMORY_DIR, 'yhteydet.json')
export const LINKEDIN_DIR = join(homedir(), 'Documents', 'JARVIS', 'linkedin_vienti')
const BACKUP_DIR = join(MEMORY_DIR, 'varmuuskopiot')
const ME = 'Yrittäjä Nimi'

export const STATES = {
  ei_vastausta: 'avaus lähetetty, ei vastausta',
  kuulumisvastaus: 'kuulumisvastaus',
  keskustelu_kesken: 'keskustelu kesken',
  kiinnostunut: 'kiinnostunut',
  tapaaminen_ehdotettu: 'tapaaminen ehdotettu',
  tapaaminen_sovittu: 'tapaaminen sovittu',
  tapaaminen_pidetty: 'tapaaminen pidetty',
  ohjasi_toiselle: 'ohjasi toiselle',
  ei_tarvetta: 'ei tarvetta',
  menetetty: 'menetetty',
  asiakas: 'asiakas',
  ei_myynti: 'ei myyntiä',
}
export const CERTAINTY = { varma: 'varma', lahes_varma: 'lähes varma (vahvistamaton)', todennakoinen: 'todennäköinen', tuntematon: 'tuntematon' }

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki' }).format(new Date())
const clean = (s, n = 300) =>
  String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '[sähköposti]')
    .replace(/(\+?\d[\d ()-]{7,}\d)/g, '[numero]')
    .trim()
    .slice(0, n)
export const norm = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\b(oy|oyj|ab|ltd|ky|tmi|ay|group|finland)\b/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export function loadContacts() {
  try {
    if (!existsSync(CONTACTS_DB)) return { version: 1, paivitetty: '', kontaktit: [] }
    const d = JSON.parse(readFileSync(CONTACTS_DB, 'utf8'))
    return { version: 1, paivitetty: d.paivitetty ?? '', kontaktit: Array.isArray(d.kontaktit) ? d.kontaktit : [] }
  } catch (err) {
    console.warn('[jarvis] yhteydet: rekisterin luku epäonnistui:', err?.message ?? err)
    return { version: 1, paivitetty: '', kontaktit: [] }
  }
}

function saveContacts(db) {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true })
  try {
    if (existsSync(CONTACTS_DB)) {
      if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true })
      copyFileSync(CONTACTS_DB, join(BACKUP_DIR, `yhteydet.${today()}.json.bak`))
    }
  } catch {
    /* backup must not block the write */
  }
  db.paivitetty = new Date().toISOString()
  writeFileSync(CONTACTS_DB, JSON.stringify(db, null, 1))
}

const newId = (db) => {
  const used = new Set(db.kontaktit.map((c) => c.id))
  let id
  do id = `y${Math.floor(Math.random() * 0x100000).toString(16).padStart(5, '0')}`
  while (used.has(id))
  return id
}

// Finnish inflection: "Sähkö-Jokisella" ~ "Sähkö-Jokinen" → compare word stems (first 5 letters of longer words).
const stems = (s) => norm(s).split(' ').filter((w) => w.length >= 3).map((w) => (w.length > 5 ? w.slice(0, 5) : w))
function matchScore(c, q) {
  const nq = norm(q)
  if (!nq) return 0
  const nh = norm(c.henkilo)
  const ny = norm(c.yritys)
  if (nq === nh || (ny && nq === ny)) return 10
  if (nh && (nh.includes(nq) || nq.includes(nh))) return 8
  if (ny && ny.length >= 3 && (ny.includes(nq) || nq.includes(ny))) return 7
  const qs = stems(q)
  if (!qs.length) return 0
  const cs = new Set([...stems(c.henkilo), ...stems(c.yritys)])
  const hit = qs.filter((w) => cs.has(w)).length
  return hit ? (hit / qs.length) * 6 : 0
}

export function findContacts(q, { max = 8 } = {}) {
  const db = loadContacts()
  return db.kontaktit
    .map((c) => ({ c, s: matchScore(c, q) }))
    .filter((x) => x.s >= 3)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.c)
}

const fiDate = (d) => (d ? `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.` : '?')
export function describeContact(c) {
  const parts = [
    `${c.henkilo}${c.yritys ? `, ${c.yritys}` : ', yritys tuntematon'}${c.yritys && c.varmuus !== 'varma' ? ` (${CERTAINTY[c.varmuus] ?? c.varmuus})` : ''}`,
    `tila: ${STATES[c.tila] ?? c.tila}`,
    `ensikontakti ${fiDate(c.ensikontakti)}, viimeisin ${fiDate(c.viimeisin)}${c.vastasi ? '' : ', ei vastannut'}`,
  ]
  if (c.autot) parts.push(`autoja: ${c.autot}`)
  if (c.rooli) parts.push(`rooli: ${c.rooli}`)
  if (c.buukit?.length) parts.push(`buukit: ${c.buukit.map((b) => `${fiDate(b.pvm)}${b.aika ? ` klo ${b.aika}` : ''} ${b.tila}${b.pitaja ? ` (${b.pitaja})` : ''}`).join('; ')}`)
  if (c.muistiinpanot?.length) parts.push(`viimeisin muistiinpano: ${c.muistiinpanot.at(-1).teksti}`)
  return parts.join(' | ')
}

/** Company names for lead-finder de-duplication (all named contacts, any certainty: a skipped lead is cheaper than a double contact). */
export function contactedCompanyNames() {
  return loadContacts()
    .kontaktit.map((c) => c.yritys)
    .filter((y) => y && norm(y).length >= 3)
}

function upsert(db, { henkilo, yritys }) {
  let c = null
  if (henkilo) c = db.kontaktit.find((x) => norm(x.henkilo) === norm(henkilo))
  if (!c && yritys) c = db.kontaktit.find((x) => x.yritys && norm(x.yritys) === norm(yritys) && (!henkilo || !x.henkilo))
  if (!c) {
    c = { id: newId(db), henkilo: clean(henkilo, 80) || '', yritys: clean(yritys, 120) || null, varmuus: yritys ? 'varma' : 'tuntematon', todiste: null, lahde: ['ryhmä'], kanava: 'LinkedIn', ensikontakti: today(), viimeisin: today(), vastasi: true, tila: 'keskustelu_kesken', buukit: [], muistiinpanot: [] }
    db.kontaktit.push(c)
  }
  // A company the user states directly is certain.
  if (yritys && (!c.yritys || c.varmuus !== 'varma')) {
    c.yritys = clean(yritys, 120)
    c.varmuus = 'varma'
    c.todiste = 'kerrottu ryhmässä'
  }
  return c
}

/** Iina (or Elias) reports a booking. Returns the updated contact. */
export function addBooking({ henkilo = '', yritys = '', pvm, aika = '', pitaja = '', tila = 'sovittu', kuka = '', lisatieto = '' }) {
  if (!henkilo && !yritys) throw new Error('Kerro henkilö tai yritys.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pvm ?? ''))) throw new Error('Päivämäärä muodossa VVVV-KK-PP.')
  const db = loadContacts()
  const c = upsert(db, { henkilo, yritys })
  c.buukit ??= []
  const same = c.buukit.find((b) => b.pvm === pvm && (b.aika || '') === (aika || ''))
  if (same) Object.assign(same, { tila, pitaja: clean(pitaja, 40) || same.pitaja, lisatieto: clean(lisatieto, 200) || same.lisatieto })
  else c.buukit.push({ pvm, aika: clean(aika, 10), pitaja: clean(pitaja, 40), tila, kuka: clean(kuka, 40), kirjattu: today(), lisatieto: clean(lisatieto, 200) })
  c.tila = tila === 'pidetty' ? 'tapaaminen_pidetty' : tila === 'peruttu' || tila === 'siirtyi' ? 'tapaaminen_ehdotettu' : 'tapaaminen_sovittu'
  c.viimeisin = today()
  saveContacts(db)
  return c
}

export function updateContact({ haku, tila, yritys, muistiinpano, kuka = '' }) {
  const db = loadContacts()
  const hits = db.kontaktit.map((c) => ({ c, s: matchScore(c, haku) })).filter((x) => x.s >= 6).sort((a, b) => b.s - a.s)
  if (!hits.length) return { error: `"${haku}" ei löytynyt rekisteristä.` }
  if (hits.length > 1 && hits[0].s === hits[1].s) return { error: `Useampi osuma: ${hits.slice(0, 4).map((x) => x.c.henkilo + (x.c.yritys ? ` (${x.c.yritys})` : '')).join(', ')}. Tarkenna.` }
  const c = hits[0].c
  if (tila && STATES[tila]) c.tila = tila
  if (yritys) {
    c.yritys = clean(yritys, 120)
    c.varmuus = 'varma'
    c.todiste = 'kerrottu ryhmässä'
  }
  if (muistiinpano) (c.muistiinpanot ??= []).push({ pvm: today(), kuka: clean(kuka, 40), teksti: clean(muistiinpano, 300) })
  c.viimeisin = today()
  saveContacts(db)
  return { contact: c }
}

export function registerSummary() {
  const k = loadContacts().kontaktit
  if (!k.length) return 'Kontaktirekisteri on tyhjä.'
  const by = (f) => k.reduce((m, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {})
  const st = by((c) => STATES[c.tila] ?? c.tila)
  const ce = by((c) => CERTAINTY[c.varmuus] ?? c.varmuus)
  const books = k.flatMap((c) => (c.buukit ?? []).map((b) => ({ ...b, c })))
  const upcoming = books.filter((b) => b.pvm >= today() && b.tila === 'sovittu').sort((a, b) => a.pvm.localeCompare(b.pvm))
  return [
    `Kontaktirekisteri: ${k.length} henkilöä, ${new Set(k.map((c) => norm(c.yritys)).filter(Boolean)).size} nimettyä yritystä.`,
    `Tila: ${Object.entries(st).map(([a, b]) => `${a} ${b}`).join(' · ')}`,
    `Yrityksen varmuus: ${Object.entries(ce).map(([a, b]) => `${a} ${b}`).join(' · ')}`,
    `Buukit: ${books.length} kirjattu${upcoming.length ? `, tulossa: ${upcoming.slice(0, 6).map((b) => `${fiDate(b.pvm)}${b.aika ? ` ${b.aika}` : ''} ${b.c.henkilo}${b.c.yritys ? ` (${b.c.yritys})` : ''}`).join(', ')}` : ''}.`,
  ].join('\n')
}

/**
 * LinkedIn funnel from the contact register, for the Friday report and "/iina-kooste".
 * Cumulative (all contacts) and this week (first contact within [start, end)). Rates are plain counts, no model.
 * Exported for tests: pass `contacts` to avoid disk.
 */
export function funnelSummary({ start, end, contacts = null } = {}) {
  const k = contacts ?? loadContacts().kontaktit
  if (!k.length) return null
  const s = start ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki' }).format(start) : ''
  const e = end ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki' }).format(end) : ''
  const INTEREST = new Set(['kiinnostunut', 'tapaaminen_ehdotettu', 'tapaaminen_sovittu', 'tapaaminen_pidetty', 'asiakas'])
  const MEETING = new Set(['tapaaminen_sovittu', 'tapaaminen_pidetty', 'asiakas'])
  const count = (list) => {
    const replied = list.filter((c) => c.vastasi).length
    const interested = list.filter((c) => INTEREST.has(c.tila)).length
    const meeting = list.filter((c) => MEETING.has(c.tila) || (c.buukit ?? []).some((b) => b.tila === 'sovittu' || b.tila === 'pidetty')).length
    const noNeed = list.filter((c) => c.tila === 'ei_tarvetta').length
    const stuck = list.filter((c) => c.vastasi && ['keskustelu_kesken', 'kuulumisvastaus'].includes(c.tila)).length
    return { n: list.length, replied, interested, meeting, noNeed, stuck }
  }
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '–')
  const all = count(k)
  const week = s ? count(k.filter((c) => c.ensikontakti && c.ensikontakti >= s && (!e || c.ensikontakti < e))) : null
  const lines = [
    `LINKEDIN-SUPPILO (Iinan kontaktit, ${all.n} hlö): vastasi ${all.replied} (${pct(all.replied, all.n)}) → kiinnostui ${all.interested} (${pct(all.interested, all.replied)} vastanneista) → tapaaminen ${all.meeting} (${pct(all.meeting, all.interested)} kiinnostuneista) · ei tarvetta ${all.noNeed}`,
    all.stuck ? `Vastasi mutta keskustelu jäi kesken: ${all.stuck} hlö (näistä syntyy nopeimmin tapaamisia: seuranta 3–4 työpäivän päästä)` : '',
  ]
  if (week) lines.push(week.n ? `Tällä viikolla uusia avauksia ${week.n}, vastasi ${week.replied}, tapaamiseen ${week.meeting}` : 'Tällä viikolla ei uusia LinkedIn-avauksia rekisterissä')
  return { all, week, text: lines.filter(Boolean).join('\n') }
}

export function bookingsText() {
  const k = loadContacts().kontaktit
  const books = k.flatMap((c) => (c.buukit ?? []).map((b) => ({ ...b, c }))).sort((a, b) => b.pvm.localeCompare(a.pvm))
  if (!books.length) return 'Buukkeja ei ole vielä kirjattu. Kerro esim. "buukkasin Henri Timosen ma 9.11. klo 14.30".'
  return books
    .slice(0, 30)
    .map((b) => `- ${fiDate(b.pvm)}${b.aika ? ` klo ${b.aika}` : ''} ${b.c.henkilo}${b.c.yritys ? `, ${b.c.yritys}` : ''}: ${b.tila}${b.pitaja ? `, pitää ${b.pitaja}` : ''}`)
    .join('\n')
}

// ---- LinkedIn export import (messages.csv) ------------------------------------------------------------------------
export function parseCsv(text) {
  const rows = []
  let row = []
  let cur = ''
  let q = false
  const s = String(text).replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cur += '"'
          i++
        } else q = false
      } else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      row.push(cur)
      cur = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
    } else cur += ch
  }
  if (cur || row.length) {
    row.push(cur)
    rows.push(row)
  }
  const head = rows.shift() ?? []
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])))
}

/** Newest messages.csv in Documents\JARVIS\linkedin_vienti (or the given path) → update the register. Never removes data. */
export function importLinkedIn(path = '') {
  let file = path
  if (!file) {
    if (!existsSync(LINKEDIN_DIR)) return { error: `Kansiota ${LINKEDIN_DIR} ei ole. Tallenna LinkedInin viestivienti (messages.csv) sinne.` }
    const cands = []
    const walk = (d, depth = 0) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        const st = statSync(p)
        if (st.isDirectory() && depth < 2) walk(p, depth + 1)
        else if (/^messages.*\.csv$/i.test(f)) cands.push({ p, t: st.mtimeMs })
      }
    }
    walk(LINKEDIN_DIR)
    if (!cands.length) return { error: `messages.csv ei löytynyt kansiosta ${LINKEDIN_DIR}.` }
    file = cands.sort((a, b) => b.t - a.t)[0].p
  }
  const rows = parseCsv(readFileSync(file, 'utf8'))
  const convs = new Map()
  for (const r of rows) {
    const id = r['CONVERSATION ID']
    if (!id) continue
    if (!convs.has(id)) convs.set(id, [])
    convs.get(id).push(r)
  }
  const db = loadContacts()
  let added = 0
  let updated = 0
  for (const [cid, ms] of convs) {
    ms.sort((a, b) => String(a.DATE).localeCompare(String(b.DATE)))
    const other = ms.map((r) => (r.FROM !== ME ? r.FROM : r.TO)).find((n) => n && n !== ME) ?? ''
    if (!other || /linkedin team/i.test(other)) continue
    const replied = ms.some((r) => r.FROM && r.FROM !== ME)
    const first = String(ms[0].DATE).slice(0, 10)
    const last = String(ms.at(-1).DATE).slice(0, 10)
    let c = db.kontaktit.find((x) => x.cid === cid) ?? db.kontaktit.find((x) => norm(x.henkilo) === norm(other))
    if (!c) {
      c = { id: newId(db), henkilo: clean(other, 80), yritys: null, varmuus: 'tuntematon', todiste: null, lahde: ['linkedin'], kanava: 'LinkedIn', cid, ensikontakti: first, viimeisin: last, vastasi: replied, tila: replied ? 'keskustelu_kesken' : 'ei_vastausta', buukit: [], muistiinpanot: [] }
      db.kontaktit.push(c)
      added++
      continue
    }
    const before = `${c.viimeisin}|${c.vastasi}|${c.tila}`
    c.cid ??= cid
    if (!c.lahde?.includes('linkedin')) c.lahde = [...(c.lahde ?? []), 'linkedin']
    if (!c.ensikontakti || first < c.ensikontakti) c.ensikontakti = first
    if (!c.viimeisin || last > c.viimeisin) c.viimeisin = last
    if (replied && !c.vastasi) {
      c.vastasi = true
      if (c.tila === 'ei_vastausta') c.tila = 'keskustelu_kesken' // never overrides a status set by people
    }
    if (before !== `${c.viimeisin}|${c.vastasi}|${c.tila}`) updated++
  }
  saveContacts(db)
  return { file, conversations: convs.size, added, updated, total: db.kontaktit.length }
}

// ---- CRM transfer (Elias 6.11.: "rupee rakentamaan pikkuhiljaa sitä siirtoa CRM:ään ... näkyvät Iinan liideinä") ------
const CRM_DONE = new Set(['siirretty', 'jo_crm', 'ohitettu'])
/**
 * Next contacts to move into the CRM as Iina's leads: named company with certainty "varma", not yet handled. Meetings first.
 * arviot=true: instead the contacts whose company the AI vote (puuttuvat.mjs) resolved with a strong result (arvio.tila "vahva").
 */
/**
 * Y-tunnus that may go to the CRM from the AI review, or null. After the second pass (puuttuvat.mjs) the combined class
 * decides: varmistettu / vahva / perusteltu go, ristiriita and arvaus do not. Before it: pass 1 vahva / perusteltu.
 */
export function effectiveYt(a) {
  if (!a) return null
  if (a.lopullinen) {
    if (!['varmistettu', 'vahva', 'perusteltu'].includes(a.lopullinen)) return null
    if (a.lopullinen !== 'varmistettu' && a.toinen && ['vahva', 'perusteltu'].includes(a.toinen.tila) && !['vahva', 'perusteltu'].includes(a.tila)) return a.toinen.ytunnus ?? null
    return a.ytunnus ?? a.toinen?.ytunnus ?? null
  }
  return ['vahva', 'perusteltu'].includes(a.tila) ? a.ytunnus ?? null : null
}
// Claude's critical review of the two AI passes (Elias 10.11.: "Siirrä katselmasi"): muisti/ryhma/puuttuvat_katselmointi.json
// { lisaa: [{ id, ytunnus, yritys, peruste }], pois: [{ id, syy }] } overrides the AI vote for exactly those contacts.
const REVIEW_FILE = join(MEMORY_DIR, 'ryhma', 'puuttuvat_katselmointi.json')
export function loadReview() {
  try {
    const r = JSON.parse(readFileSync(REVIEW_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return { add: new Map((r.lisaa ?? []).map((x) => [x.id, x])), drop: new Map((r.pois ?? []).map((x) => [x.id, x])) }
  } catch {
    return { add: new Map(), drop: new Map() }
  }
}
export const crmRank = (c) => ({ tapaaminen_sovittu: 0, tapaaminen_pidetty: 0, tapaaminen_ehdotettu: 1, kiinnostunut: 1, keskustelu_kesken: 2, ohjasi_toiselle: 2, kuulumisvastaus: 3, ei_vastausta: 4, ei_tarvetta: 5 })[c.tila] ?? 6
/**
 * Pure: the contacts that may go to the CRM, sorted (meetings first, newest first). Exported for tests.
 * arviot: a contact skipped as "ei YTJ:ssä" is looked at again only when its Y-tunnus has changed since (second pass,
 * review); "ytj_epaselva" (YTJ did not answer) is retried every time.
 */
export function pickForCrm(kontaktit, { arviot = false, review = { add: new Map(), drop: new Map() } } = {}) {
  const ytFor = (c) => (review.drop.has(c.id) ? null : review.add.get(c.id)?.ytunnus ?? effectiveYt(c.arvio))
  // Sole trader without a Y-tunnus, approved by Elias 10.11. ("lisää ilman Y-tunnusta, kirjoita toiminimi").
  const tradeNameFor = (c) => (review.drop.has(c.id) ? null : review.add.get(c.id)?.toiminimi || null)
  const pick = arviot
    ? (c) => {
        if (!c.arvio) return false
        const yt = ytFor(c)
        if ((c.arvio.tila_arvio || c.tila) === 'ei_myynti') return false
        if (!yt || !/^\d{7}-\d$/.test(yt)) return Boolean(tradeNameFor(c)) && !CRM_DONE.has(c.crm?.tila)
        if (c.crm?.tila === 'ohitettu' && c.crm.syy === 'ei YTJ:ssä') return c.crm.kokeiltu !== yt
        return !CRM_DONE.has(c.crm?.tila)
      }
    : (c) => c.yritys && c.varmuus === 'varma' && c.tila !== 'ei_myynti' && !CRM_DONE.has(c.crm?.tila) && !(c.crm?.tila === 'ytj_epaselva' && !c.ytunnus)
  return kontaktit
    .filter(pick)
    // AI-resolved: the state from the conversation vote (tila_arvio) decides the CRM tab; the register keeps its own value.
    .map((c) => (arviot && c.arvio ? { ...c, tila: c.arvio.tila_arvio || c.tila, seuraava: c.arvio.seuraava || c.seuraava, kooste: c.arvio.yhteenveto || c.kooste, arvio: { ...c.arvio, ytunnus: ytFor(c), ...(review.add.has(c.id) ? { aanet: ['ristiintarkistus'], peruste: review.add.get(c.id).peruste, yritys: review.add.get(c.id).yritys, toiminimi: tradeNameFor(c) } : {}) } } : c))
    .sort((a, b) => crmRank(a) - crmRank(b) || String(b.viimeisin).localeCompare(String(a.viimeisin)))
}
/** max = Infinity takes every eligible contact (crm_siirra_kontaktit arviot=true, Elias 10.11.: "kaikki 204"). */
export function contactsForCrm({ max = 10, arviot = false } = {}) {
  return pickForCrm(loadContacts().kontaktit, { arviot, review: arviot ? loadReview() : undefined }).slice(0, max)
}
/** Record many CRM results with one read and one write (the full transfer marks ~200 contacts at once). */
export function markCrmMany(marks) {
  if (!marks?.length) return 0
  const db = loadContacts()
  let n = 0
  for (const { id, info } of marks) {
    const c = db.kontaktit.find((x) => x.id === id)
    if (!c) continue
    c.crm = { ...(c.crm ?? {}), ...info, pvm: today() }
    if (info.ytunnus) c.ytunnus = info.ytunnus
    n++
  }
  saveContacts(db)
  return n
}
/** Record the CRM transfer result on a contact (tila: siirretty | jo_crm | ohitettu | ytj_epaselva). */
export function markCrm(id, info) {
  const db = loadContacts()
  const c = db.kontaktit.find((x) => x.id === id)
  if (!c) return null
  c.crm = { ...(c.crm ?? {}), ...info, pvm: today() }
  if (info.ytunnus) c.ytunnus = info.ytunnus
  saveContacts(db)
  return c
}
/** Contacts still missing from the CRM (not transferred, not already there, not a non-sales contact). */
export function contactsMissingFromCrm() {
  return loadContacts().kontaktit.filter((c) => c.tila !== 'ei_myynti' && !['siirretty', 'jo_crm'].includes(c.crm?.tila) && !(c.crm?.tila === 'ohitettu' && /sama yritys/.test(String(c.crm?.syy ?? ''))))
}
/** Store the AI company estimate on a contact (never overwrites the original yritys/varmuus fields). */
export function setEstimate(id, arvio) {
  const db = loadContacts()
  const c = db.kontaktit.find((x) => x.id === id)
  if (!c) return null
  c.arvio = { ...arvio, pvm: today() }
  saveContacts(db)
  return c
}
export function crmTransferStatus() {
  const k = loadContacts().kontaktit.filter((c) => c.tila !== 'ei_myynti')
  const by = k.reduce((m, c) => ((m[c.crm?.tila ?? (c.yritys && c.varmuus === 'varma' ? 'odottaa' : 'yritys varmistamatta')] = (m[c.crm?.tila ?? (c.yritys && c.varmuus === 'varma' ? 'odottaa' : 'yritys varmistamatta')] ?? 0) + 1), m), {})
  return `CRM-siirto: ${Object.entries(by).map(([a, b]) => `${a} ${b}`).join(' · ')}`
}
