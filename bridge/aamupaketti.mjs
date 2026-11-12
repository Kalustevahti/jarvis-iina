/**
 * Myynnin aamupaketti (Elias 10.11.2026, suunnitelmat/03): joka arkiaamu jokaiselle myyjälle 3 tärkeintä tehtävää
 * valmiin viestiluonnoksen kanssa, ja JARVIS oppii, mitkä viestit ja tehtävät johtavat vastauksiin ja tapaamisiin.
 *
 *   Järjestys (myyjää kohden enintään 3):
 *     1. tapaaminen pidetty, tulos kirjaamatta (vanhin ensin)
 *     2. tarjous vanhenee ≤ 3 pv tai ei vastausta seurantarytmissä
 *     3. seuranta seurantarytmin mukaan (#5e7a): vastasi ja hiljeni → 3 työpv, toinen 10 pv päästä, ei kolmatta;
 *        avaus ilman vastausta → yksi muistutus 7–10 pv kohdekokoiselle; "ei tarvetta" → ei seurantaa
 *     4. liidi otettu ≥ 7 pv sitten, ei kontaktoitu
 *
 *   Vain luku: CRM:n rivit tulevat crm.mjs:n morningRows()-funktiosta, tämä tiedosto ei koskaan kirjoita CRM:ään eikä
 *   lähetä mitään asiakkaille. Ryhmään menee vain myyjän etunimi, tehtävien määrä ja yritysten nimet (groupSummaryText).
 *
 *   Oppiminen: ~/.jarvis/aamupaketti.json — annettu luonnos (tyyppi, avaustapa), käyttö ("lähetin 2" tai kopio
 *   sovelluksesta) ja tulos CRM:stä 14 päivän sisällä (vastaus, tapaaminen, vaihe eteni, hävitty). Luonnosten tekstejä
 *   eikä henkilöiden nimiä tallenneta lokiin; vain tämän päivän paketti on tallessa, jotta numerot pysyvät samoina.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_FILE = join(homedir(), '.jarvis', 'aamupaketti.json')
const MEMORY_DIR = join(homedir(), 'Documents', 'JARVIS', 'muisti')
const TZ = 'Europe/Helsinki'
const DAY = 86_400_000
/** Tapa on "vakiintunut", kun sillä on vähintään näin monta lähetettyä viestiä. */
export const MIN_CASES = 5
const PER_SELLER = 3
const WINDOW_DAYS = 14

// --- aika (Suomen aika) --------------------------------------------------------------------------------------

export const hkDay = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(d))
const WD = ['su', 'ma', 'ti', 'ke', 'to', 'pe', 'la']
const noonOf = (dayStr) => new Date(`${dayStr}T12:00:00Z`)
export function fiShort(d) {
  const t = new Date(d)
  if (Number.isNaN(t.getTime())) return '?'
  const s = hkDay(t)
  const x = noonOf(s)
  return `${WD[x.getUTCDay()]} ${x.getUTCDate()}.${x.getUTCMonth() + 1}.`
}
export const daysSince = (from, now = new Date()) => Math.floor((new Date(now).getTime() - new Date(from).getTime()) / DAY)
/** Arkipäivät (ma–pe) from-päivän JÄLKEEN to-päivään asti (Suomen kalenteripäivinä). */
export function workingDaysBetween(from, to) {
  let d = noonOf(hkDay(from))
  const end = noonOf(hkDay(to))
  let n = 0
  for (let i = 0; i < 800 && d < end; i++) {
    d = new Date(d.getTime() + DAY)
    const wd = d.getUTCDay()
    if (wd >= 1 && wd <= 5) n++
  }
  return n
}
/** Kaksi konkreettista aikaa ensi viikolle (ti klo 9, to klo 14), kuten liidien seurannassa. */
export function twoSlots(now = new Date()) {
  const today = noonOf(hkDay(now))
  const wd = today.getUTCDay() || 7
  const monday = new Date(today.getTime() + (8 - wd) * DAY)
  const fmt = (off, h) => {
    const x = new Date(monday.getTime() + off * DAY)
    return `${WD[x.getUTCDay()]} ${x.getUTCDate()}.${x.getUTCMonth() + 1}. klo ${h}`
  }
  return [fmt(1, 9), fmt(3, 14)]
}

// --- seurantarytmi (#5e7a), puhtaat säännöt ------------------------------------------------------------------

/** Kohdekokoinen = vähintään 5 autoa tai tuntematon (myyntioppi, 7.11. työsääntö). */
export const targetSized = (fleet) => fleet == null || !Number.isFinite(Number(fleet)) || Number(fleet) >= 5
/** Liidikoneen perustelusta automääräarvio ("arvio 5–10 autoa" → 10); null = tuntematon. */
export function fleetFromText(t) {
  const s = String(t ?? '')
  // Lead texts since 10.11.: "Autoja arviolta 5–10 (verkkosivu)." — the number comes after the word.
  const lead = s.match(/arviolta\s+(\d{1,3})(?:\s*[–-]\s*(\d{1,3}))?/i)
  if (lead) return Math.max(Number(lead[1]), Number(lead[2] ?? 0))
  const r = s.match(/(\d{1,3})\s*[–-]\s*(\d{1,3})[^.\n]{0,24}?\bauto/i)
  if (r) return Math.max(Number(r[1]), Number(r[2]))
  const one = s.match(/(\d{1,3})\s*(?:\([^)]*\)\s*)?auto/i)
  return one ? Number(one[1]) : null
}
const NO_NEED = /not_interested|no_need|ei_tarvetta|declined|lost|rejected/i

/**
 * Onko seuranta nyt vuorossa? kind: 'vastasi' (asiakas vastasi ja hiljeni, myös tarjous ilman vastausta),
 * 'avaus' (avaus ilman vastausta), 'ei_tarvetta'. used = lähetetyt muistutukset tähän asiaan (aikajärjestyksessä).
 * Palauttaa { due, round } — round 1 tai 2 (toinen on viimeinen, helpolla ulospääsyllä).
 */
export function followUpDue({ kind, lastTouch, used = [], fleet = null, now = new Date() }) {
  if (kind === 'ei_tarvetta' || !lastTouch) return { due: false, round: 0 }
  if (kind === 'avaus') {
    if (used.length || !targetSized(fleet)) return { due: false, round: 0 }
    const d = daysSince(lastTouch, now)
    return d >= 7 && d <= 10 ? { due: true, round: 1 } : { due: false, round: 0 }
  }
  if (used.length >= 2) return { due: false, round: 0 }
  if (used.length === 1) return daysSince(used[0], now) >= 10 ? { due: true, round: 2 } : { due: false, round: 0 }
  return workingDaysBetween(lastTouch, now) >= 3 ? { due: true, round: 1 } : { due: false, round: 0 }
}

// --- luonnokset ----------------------------------------------------------------------------------------------

/** Avaustapojen nimet ihmiselle (Perjantain osio, sovellus). */
export const STYLE_LABEL = {
  kiitos_aika: 'kiitos + kaksi aikaa',
  kiitos_kysymys: 'kiitos + kysymys',
  kaksi_aikaa: 'kaksi konkreettista aikaa',
  kysymys: 'avoin kysymys',
  hyoty: 'yksi konkreettinen hyöty',
  aika_kysymys: 'kysymys ajankäytöstä',
  muistutus_kysymys: 'lyhyt kysymys perään',
  muistutus_kuvaus: 'lyhyt kuvaus + automäärä',
  crm_avaus: 'CRM:n räätälöity avaus',
  arki_kysymys: 'arkeen liittyvä kysymys',
  kalusto_kysymys: 'kalustokysymys',
}
export const TYPE_LABEL = { tulos: 'tapaamisen tulos', tarjous: 'tarjous', seuranta: 'seuranta', avaus: 'avaus' }

/** Asiakasviestin siistiminen: ei ajatusviivoja (myyntioppi 4.11.), ei tuplavälejä. */
export const clean = (t) => String(t ?? '').replace(/\s*[–—]\s*/g, ', ').replace(/[ \t]{2,}/g, ' ').trim()

const DRAFTS = {
  tulos: {
    kiitos_aika: (c) => `${c.hi} Kiitos vielä tapaamisesta${c.e} Sovitaan seuraava askel, niin asia etenee teidän aikataulussa. Sopisiko ${c.slots[0]} tai ${c.slots[1]}?`,
    kiitos_kysymys: (c) => `${c.hi} Kiitos vielä tapaamisesta${c.e} Jäikö jotain mietittävää, mihin voin vastata? Voin myös koota teidän autoista lyhyen yhteenvedon, niin päätös on helpompi tehdä.`,
  },
  tarjous: {
    kaksi_aikaa: (c) =>
      `${c.hi} Palaan vielä tarjoukseen, jonka lähetin.${c.valid ? ` Se on voimassa ${c.valid} asti, joten halusin varmistaa, että ehdit katsoa sen rauhassa.` : ''} Käydäänkö se läpi 15 minuutissa? Lasketaan samalla teidän omilla luvuilla, paljonko autojen hoitoon menee aikaa ja rahaa. Sopisiko ${c.slots[0]} tai ${c.slots[1]}?${c.second ? c.out : ''}`,
    kysymys: (c) =>
      `${c.hi} Palaan vielä tarjoukseen, jonka lähetin${c.e}${c.valid ? ` Se on voimassa ${c.valid} asti.` : ''} Heräsikö siitä kysymyksiä, tai onko jotain, mitä haluaisit muuttaa? Sisältöä ja autojen määrää voi vielä tarkentaa teidän tilanteen mukaan.${c.second ? c.out : ''}`,
  },
  seuranta: {
    kaksi_aikaa: (c) => `${c.hi} Palaan vielä meidän keskusteluun${c.e} Ehtisitkö 15 min Teamsiin, jossa katsotaan, mitä kaikkea voisimme teidän autojen osalta hoitaa puolestanne? Sopisiko ${c.slots[0]} tai ${c.slots[1]}?${c.second ? c.out : ''}`,
    hyoty: (c) => `${c.hi} Tuli vielä mieleen meidän keskustelusta: meillä yksi yhteyshenkilö hoitaa huollot, katsastukset ja renkaat koko kalustolle, ja te päätätte aina isot asiat. Kiinnostaisiko katsoa 15 minuutissa, miltä se näyttäisi teillä?${c.second ? c.out : ''}`,
    aika_kysymys: (c) => `${c.hi} Kysyisin vielä yhden asian: paljonko teillä menee suunnilleen työaikaa vuodessa autojen huoltoihin, katsastuksiin ja rengasvaihtoihin? Siitä näkee nopeasti, olisiko meistä teille hyötyä.${c.second ? c.out : ''}`,
    muistutus_kysymys: (c) => `${c.hi} Laitan vielä lyhyesti perään: miten teillä autojen huollot ja katsastukset hoidetaan, onko se jonkun yhden ihmisen pöydällä?`,
    muistutus_kuvaus: (c) => `${c.hi} Lyhyesti mitä teemme: hoidamme yritysten autojen huollot, korjaukset, katsastukset ja renkaat yhden kumppanin kautta, ettei yrittäjän tai työnjohdon aika mene niihin. Kuinka monta autoa teillä suurin piirtein on?`,
  },
  avaus: {
    crm_avaus: (c) => c.script,
    arki_kysymys: (c) => `${c.hi} Kiitos verkostoitumisesta${c.e} Kiinnostaisi kuulla, miten teillä keikat ja autot jaetaan porukan kesken?\n\n${c.sign}`,
    kalusto_kysymys: (c) => `${c.hi} Kiitos verkostoitumisesta${c.e} Kuinka monta autoa teillä suurin piirtein on käytössä, ja onko niiden huollot ja katsastukset yhden ihmisen hoidettavana?\n\n${c.sign}`,
  },
}

/**
 * Myyjän oma tyyli: jos muistissa on <etunimi>_tyyli.md (esim. iina_tyyli.md), käytetään hänen tapaansa
 * ("Moi", 😊, avauksen allekirjoitus "Yt. Iina"). Muuten neutraali "Hei" ilman emojeita.
 */
export function sellerStyle(first, dir = MEMORY_DIR) {
  const f = String(first ?? '').trim()
  const own = f && existsSync(join(dir, `${f.toLowerCase()}_tyyli.md`))
  return own ? { own: true, greet: 'Moi', e: ' 😊', sign: `Yt. ${f}` } : { own: false, greet: 'Hei', e: '.', sign: f || '' }
}

export function draftText(type, style, ctx) {
  const fn = DRAFTS[type]?.[style]
  if (!fn) return ''
  const st = ctx.style ?? sellerStyle('')
  const c = {
    ...ctx,
    hi: ctx.first ? `${st.greet} ${ctx.first}!` : `${st.greet}!`,
    e: st.e === '.' ? '.' : `!${st.e}`,
    sign: st.sign,
    out: ` Jos tämä ei ole teille tarpeen, sekin on ihan ok, kuittaa vaan niin en vaivaa enempää${st.e === '.' ? '.' : st.e}`,
  }
  return clean(fn(c))
}

const hash = (s) => [...String(s)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

/**
 * Pää- ja vaihtoehtotyyli. Kun jollain tavalla on ≥ MIN_CASES lähetettyä, paras vastausosuus on pääluonnos;
 * vaihtoehto on aina toinen tapa (vähiten kokeiltu), ettei oppi kapene yhteen tapaan.
 */
export function chooseStyles(type, candidates, stats, seed = 0) {
  if (candidates.length < 2) return [candidates[0], candidates[0]]
  const rate = (s) => {
    const x = stats.get(`${type}:${s}`)
    return x && x.sent ? (x.replies + x.meetings * 0.5) / x.sent : 0
  }
  const proven = candidates.filter((s) => (stats.get(`${type}:${s}`)?.sent ?? 0) >= MIN_CASES)
  if (proven.length) {
    const main = [...proven].sort((a, b) => rate(b) - rate(a))[0]
    const alt = candidates.filter((s) => s !== main).sort((a, b) => (stats.get(`${type}:${a}`)?.sent ?? 0) - (stats.get(`${type}:${b}`)?.sent ?? 0))[0]
    return [main, alt]
  }
  const i = seed % candidates.length
  return [candidates[i], candidates[(i + 1) % candidates.length]]
}

// --- työjono ---------------------------------------------------------------------------------------------------

const SYSTEM_USER = /^(asiakashankinta|jarvis|testi)\b/i
const STAGE_RANK = { lead: 0, prospect: 1, meeting_booked: 2, offered: 3, decision_pending: 4, customer: 5 }
const firstOf = (name) => String(name ?? '').trim().split(/\s+/)[0] || ''

/**
 * Päivän työjono myyjittäin. rows = crm.morningRows(); log = aiemmat merkinnät (seurantarytmin laskentaan ja oppiin).
 * Palauttaa { day, at, sellers: [{ id, name, first, items }], count } — items numeroitu koko paketin läpi (1, 2, 3 …).
 */
export function buildPackage(rows, { now = new Date(), log = [], styleOf = sellerStyle } = {}) {
  const t = new Date(now).getTime()
  const orgs = new Map((rows.orgs ?? []).map((o) => [o.id, o]))
  const people = new Map((rows.people ?? []).map((p) => [p.id, p.name]))
  const stats = learningStats(log)
  const usedFor = (key) =>
    log
      .filter((e) => e.key === key && e.used && (e.type === 'seuranta' || e.type === 'tarjous'))
      .map((e) => e.used.at)
      .sort()
  const recentlyUsed = (key, days) => log.some((e) => e.key === key && e.used && daysSince(e.used.at, now) < days)
  const slots = twoSlots(now)
  const cand = [] // { prio, sort, seller, key, type, company, orgId, leadId, why, todo, styles, ctx, snap }
  const busyOrgs = new Set()

  // 1. Tapaaminen pidetty (alkanut yli 2 h sitten), tulos kirjaamatta — vanhin ensin.
  for (const m of rows.meetings ?? []) {
    const at = new Date(m.starts_at).getTime()
    if (m.meeting_status === 'cancelled' || m.meeting_result || !(at < t - 2 * 3600_000) || at < t - 30 * DAY) continue
    const org = orgs.get(m.organization_id)
    if (!org || ['lost', 'customer'].includes(org.stage)) continue
    busyOrgs.add(org.id)
    cand.push({
      prio: 1, sort: at, seller: m.seller_user_id || org.owner, key: `tulos:${m.id}`, type: 'tulos', company: org.name, orgId: org.id,
      why: `Tapaaminen oli ${fiShort(m.starts_at)}, tulos kirjaamatta (${daysSince(m.starts_at, now)} pv).`,
      todo: 'Kirjaa tulos ja seuraava askel CRM:ään (myös jos tapaaminen ei toteutunut), sitten kiitosviesti asiakkaalle.',
      styles: ['kiitos_aika', 'kiitos_kysymys'], ctx: {}, snap: { stage: org.stage },
    })
  }
  // 2. Tarjoukset: vanhenee ≤ 3 pv tai ei vastausta rytmissä.
  for (const o of rows.offers ?? []) {
    if (o.status !== 'sent' || !o.sent_at) continue
    const org = orgs.get(o.organization_id)
    if (!org || ['lost', 'customer'].includes(org.stage)) continue
    const key = `tarjous:${o.id}`
    const vu = o.valid_until ? new Date(o.valid_until).getTime() : null
    const expiring = vu != null && vu >= t - DAY && vu <= t + 3 * DAY
    const r = followUpDue({ kind: 'vastasi', lastTouch: o.sent_at, used: usedFor(key), now })
    if (!(expiring && !recentlyUsed(key, 3)) && !r.due) continue
    busyOrgs.add(org.id)
    cand.push({
      prio: 2, sort: expiring ? vu - 1e13 : new Date(o.sent_at).getTime(), seller: o.seller_user_id || org.owner, key, type: 'tarjous', company: org.name, orgId: org.id,
      why: expiring
        ? `Tarjous vanhenee ${fiShort(o.valid_until)}.`
        : `Tarjous lähetetty ${daysSince(o.sent_at, now)} pv sitten, ei päätöstä${r.round === 2 ? ' (toinen ja viimeinen muistutus)' : ''}.`,
      todo: 'Viesti ja perään soitto: käykää tarjous läpi asiakkaan omilla luvuilla. Päätös CRM:ään.',
      styles: ['kaksi_aikaa', 'kysymys'], ctx: { valid: expiring ? fiShort(o.valid_until) : '', second: r.round === 2 }, snap: { stage: org.stage },
    })
  }
  // 3a. CRM:ään sovittu seuranta (next_follow_up_at tänään tai myöhässä, enintään 14 pv).
  for (const m of rows.meetings ?? []) {
    if (!m.next_follow_up_at) continue
    const due = new Date(m.next_follow_up_at).getTime()
    if (hkDay(due) > hkDay(now) || due < t - 14 * DAY) continue
    const org = orgs.get(m.organization_id)
    if (!org || busyOrgs.has(org.id) || ['lost', 'customer'].includes(org.stage)) continue
    busyOrgs.add(org.id)
    cand.push({
      prio: 3, sort: -2e13 + due, seller: m.seller_user_id || org.owner, key: `sovittu:${m.id}:${hkDay(due)}`, type: 'seuranta', company: org.name, orgId: org.id,
      why: `Sovittu seuranta ${fiShort(m.next_follow_up_at)}.`,
      todo: 'Ota yhteyttä sovitusti ja kirjaa seuraava askel CRM:ään.',
      styles: ['kaksi_aikaa', 'hyoty', 'aika_kysymys'], ctx: {}, snap: { stage: org.stage },
    })
  }
  // 3b. Liidit: vastasi ja hiljeni / avaus ilman vastausta. 4. Otettu ≥ 7 pv, ei kontaktoitu.
  for (const l of rows.leads ?? []) {
    if (l.status === 'rejected' || l.status === 'converted' || NO_NEED.test(String(l.contact_outcome ?? ''))) continue
    if (l.organization_id && busyOrgs.has(l.organization_id)) continue
    const fleet = (l.organization_id && orgs.get(l.organization_id)?.fleet) || fleetFromText(l.reason)
    const base = { seller: l.claimed_by_user_id, company: l.name, leadId: l.id, orgId: l.organization_id ?? null, snap: { outcome: l.contact_outcome ?? null, status: l.status } }
    const ctxBase = { first: l.contact_first || '' }
    if (l.status === 'contacted' && l.contacted_at) {
      const replied = l.contact_outcome === 'in_progress' || l.contact_outcome === 'interested'
      const key = `liidi:${l.id}`
      const r = followUpDue({ kind: replied ? 'vastasi' : 'avaus', lastTouch: l.contacted_at, used: usedFor(key), fleet, now })
      if (!r.due) continue
      const d = daysSince(l.contacted_at, now)
      cand.push({
        ...base, prio: 3, key, type: 'seuranta',
        // Kiinnostuneet ensin, sitten vastanneet, sitten muistutukset; tuoreet ennen vanhoja.
        sort: (l.contact_outcome === 'interested' ? -1e13 : replied ? 0 : 1e13) - new Date(l.contacted_at).getTime(),
        why: replied
          ? `${l.contact_outcome === 'interested' ? 'Kiinnostunut' : 'Vastasi'}, hiljaa ${d} pv (${r.round === 2 ? 'toinen ja viimeinen muistutus' : 'ensimmäinen muistutus'}).`
          : `Avaus ${d} pv sitten, ei vastausta (yksi muistutus, ei enempää).`,
        todo: replied ? 'Lähetä muistutus samaan ketjuun ja kirjaa CRM:ään.' : 'Lähetä yksi lyhyt muistutus samaan ketjuun. Jos ei vastausta, ei enää muistutuksia.',
        styles: replied ? ['kaksi_aikaa', 'hyoty', 'aika_kysymys'] : ['muistutus_kysymys', 'muistutus_kuvaus'], ctx: { ...ctxBase, second: r.round === 2 },
      })
    } else if (l.status === 'claimed' && l.claimed_at && !l.contacted_at && daysSince(l.claimed_at, now) >= 7) {
      const script = clean(l.opening_script ?? '')
      cand.push({
        ...base, prio: 4, sort: new Date(l.claimed_at).getTime(), key: `avaus:${l.id}`, type: 'avaus',
        why: `Liidi otettu ${daysSince(l.claimed_at, now)} pv sitten, ei kontaktoitu.`,
        todo: 'Lähetä avaus (lisää yksi tuore havainto yrityksen sivuilta) tai vapauta liidi toiselle.',
        styles: script.length > 40 ? ['crm_avaus', 'arki_kysymys', 'kalusto_kysymys'] : ['arki_kysymys', 'kalusto_kysymys'], ctx: { ...ctxBase, script },
      })
    }
  }

  // Myyjittäin: prioriteetti, sitten järjestys; sama yritys kerran; enintään 3.
  const bySeller = new Map()
  for (const c of cand.sort((a, b) => a.prio - b.prio || a.sort - b.sort)) {
    if (!c.seller || !people.has(c.seller) || SYSTEM_USER.test(people.get(c.seller))) continue
    const list = bySeller.get(c.seller) ?? bySeller.set(c.seller, []).get(c.seller)
    if (list.length >= PER_SELLER || list.some((x) => x.company === c.company)) continue
    list.push(c)
  }
  const day = hkDay(now)
  let n = 0
  const sellers = [...bySeller.entries()]
    .map(([id, list]) => ({ id, name: people.get(id), first: firstOf(people.get(id)), list }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fi'))
    .map(({ id, name, first, list }) => {
      const style = styleOf(first)
      const items = list.map((c) => {
        n += 1
        const [main, alt] = chooseStyles(c.type, c.styles, stats, hash(`${c.key}|${day}`))
        const ctx = { ...c.ctx, slots, style }
        return {
          n, key: c.key, type: c.type, company: c.company, orgId: c.orgId ?? null, leadId: c.leadId ?? null, why: c.why, todo: c.todo,
          draft: { style: main, label: STYLE_LABEL[main] ?? main, text: draftText(c.type, main, ctx) },
          alt: { style: alt, label: STYLE_LABEL[alt] ?? alt, text: draftText(c.type, alt, ctx) },
          snap: c.snap ?? {},
        }
      })
      return { id, name, first, items }
    })
  return { day, at: new Date(now).toISOString(), sellers, count: n }
}

// --- tekstit -------------------------------------------------------------------------------------------------

/** Eliaksen yksityischattiin: jokaisen myyjän lista luonnoksineen. */
export function privateText(pkg) {
  if (!pkg?.count) return ''
  const one = (t) => `"${t.replace(/\n+/g, ' / ')}"`
  const blocks = [`${pkg.count} tehtävää, tärkein ensin. Luonnokset ovat ehdotuksia: myyjä lähettää itse, JARVIS ei lähetä asiakkaille mitään.`]
  for (const s of pkg.sellers) {
    const L = [`${s.first.toUpperCase()} (${s.items.length})`]
    for (const x of s.items) {
      L.push(`${x.n}. ${x.company} · ${TYPE_LABEL[x.type].toUpperCase()}`, `Miksi nyt: ${x.why}`, `Tee: ${x.todo}`, `Luonnos (${x.draft.label}): ${one(x.draft.text)}`)
      if (x.alt.style !== x.draft.style) L.push(`Vaihtoehto ${x.n}b (${x.alt.label}): ${one(x.alt.text)}`)
    }
    blocks.push(L.join('\n'))
  }
  blocks.push('Kun viesti lähti, kirjoita "lähetin 2" (tai "lähetin 2b" vaihtoehdolle). Sovelluksen Kopioi viesti -nappi kirjautuu itsestään. Seuraan CRM:stä 14 pv, mikä johtaa vastaukseen.')
  return blocks.join('\n\n')
}

/** Toiminimi on usein ihmisen nimi: ryhmään vain "toiminimi". */
const groupCompany = (name) => (/(^|\s)(tmi|toiminimi|t:mi)\b/i.test(String(name)) ? 'toiminimi' : String(name).replace(/\s+/g, ' ').trim().slice(0, 60))

/**
 * Ryhmään (vain kun crm.json: "ryhma_aamupaketti": "on"): myyjän etunimi, määrä ja yritysten nimet — EI yhteystietoja,
 * henkilöiden nimiä, luonnoksia eikä perusteluja.
 */
export function groupSummaryText(pkg) {
  if (!pkg?.count) return ''
  const parts = pkg.sellers.map((s) => `${s.first}: ${s.items.length} ${s.items.length === 1 ? 'tehtävä' : 'tehtävää'} (${s.items.map((x) => groupCompany(x.company)).join(', ')})`)
  return `Aamupaketti ${fiShort(pkg.at)}\n${parts.join('\n')}\nLuonnokset ja perustelut: sovelluksen Työpäivä-sivu.`
}

/** Käyttöliittymälle: sama paketti + käyttötieto. */
export function packageForUi(pkg, log = []) {
  if (!pkg) return null
  const used = new Map(log.filter((e) => e.day === pkg.day && e.used).map((e) => [e.n, e.used]))
  return {
    day: pkg.day,
    count: pkg.count,
    sellers: pkg.sellers.map((s) => ({ id: s.id, name: s.name, items: s.items.map(({ snap, ...x }) => ({ ...x, typeLabel: TYPE_LABEL[x.type], used: used.get(x.n) ?? null })) })),
  }
}

// --- loki ja oppiminen ---------------------------------------------------------------------------------------

export function loadLog(file = DEFAULT_FILE) {
  try {
    const j = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    return { entries: Array.isArray(j.entries) ? j.entries : [], today: j.today ?? null, sent: j.sent ?? {} }
  } catch {
    return { entries: [], today: null, sent: {} }
  }
}
export function saveLog(state, file = DEFAULT_FILE) {
  try {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
    const cutoff = Date.now() - 180 * DAY
    const out = { ...state, entries: state.entries.filter((e) => new Date(e.given).getTime() > cutoff) }
    writeFileSync(`${file}.tmp`, JSON.stringify(out, null, 1))
    renameSync(`${file}.tmp`, file)
  } catch (err) {
    console.warn('[jarvis] aamupaketti: tallennus epäonnistui:', err?.message ?? err)
  }
}

/** Paketin luonnokset lokiin (ei tekstejä, ei henkilöiden nimiä). */
export function entriesFor(pkg) {
  return pkg.sellers.flatMap((s) =>
    s.items.map((x) => ({
      id: `${pkg.day}#${x.n}`, day: pkg.day, n: x.n, key: x.key, seller: s.first, sellerId: s.id, company: x.company, type: x.type,
      style: x.draft.style, altStyle: x.alt.style, orgId: x.orgId, leadId: x.leadId, snap: x.snap, given: pkg.at, used: null, result: null,
    })),
  )
}

/**
 * Tulos CRM:stä 14 pv sisällä käytöstä: vastaus / uusi toiminta, tapaaminen sovittu, vaihe eteni, hävitty.
 * Merkit pysyvät, kun ne on kerran nähty; 14 pv jälkeen tulos on lopullinen.
 */
export function evaluateOutcomes(entries, rows, now = new Date()) {
  const t = new Date(now).getTime()
  const leads = new Map((rows.leads ?? []).map((l) => [l.id, l]))
  const orgs = new Map((rows.orgs ?? []).map((o) => [o.id, o]))
  const IGNORE = /owner_changed|lead_opening_set/
  return entries.map((e) => {
    if (!e.used || e.result?.final) return e
    const from = new Date(e.used.at).getTime()
    const end = Math.min(t, from + WINDOW_DAYS * DAY)
    const r = { reply: false, meeting: false, forward: false, lost: false, ...(e.result ?? {}) }
    const lead = e.leadId ? leads.get(e.leadId) : null
    const orgId = e.orgId || lead?.organization_id || null
    const org = orgId ? orgs.get(orgId) : null
    const inWin = (x) => {
      const v = new Date(x).getTime()
      return v > from && v <= end
    }
    if (lead) {
      if (e.snap?.outcome === 'no_reply' && /in_progress|interested/.test(String(lead.contact_outcome))) r.reply = true
      if (e.snap?.outcome !== 'interested' && lead.contact_outcome === 'interested') r.forward = true
      if (lead.status === 'converted' && e.snap?.status !== 'converted') r.reply = r.forward = true
      if (lead.status === 'rejected' || NO_NEED.test(String(lead.contact_outcome ?? ''))) r.lost = true
    }
    if (orgId) {
      if ((rows.activity ?? []).some((a) => a.organization_id === orgId && !IGNORE.test(String(a.action)) && inWin(a.created_at))) r.reply = true
      if ((rows.meetings ?? []).some((m) => m.organization_id === orgId && inWin(m.created_at))) r.reply = r.meeting = true
      if ((rows.offers ?? []).some((o) => o.organization_id === orgId && o.status === 'accepted' && inWin(o.accepted_at ?? o.updated_at))) r.reply = r.forward = true
      if ((rows.offers ?? []).some((o) => o.organization_id === orgId && o.status === 'rejected' && inWin(o.updated_at))) r.lost = true
    }
    if (org) {
      const before = STAGE_RANK[e.snap?.stage] ?? (lead ? 1 : -1)
      const nowRank = STAGE_RANK[org.stage]
      if (nowRank != null && before >= 0 && nowRank > before) r.forward = true
      if (org.stage === 'meeting_booked' && before < 2) r.meeting = true
      if (org.stage === 'lost') r.lost = true
    }
    r.final = t >= from + WINDOW_DAYS * DAY
    r.checkedAt = new Date(now).toISOString()
    return { ...e, result: r }
  })
}

/** Tyyppi ja avaustapa: lähetetty → vastauksia → tapaamisia (käytetty tyyli: pää- tai vaihtoehto). */
export function learningStats(entries, { since = null } = {}) {
  const m = new Map()
  for (const e of entries) {
    if (!e.used || (since && new Date(e.used.at) < new Date(since))) continue
    const style = e.used.variant === 'b' ? e.altStyle : e.style
    const k = `${e.type}:${style}`
    const x = m.get(k) ?? { type: e.type, style, sent: 0, replies: 0, meetings: 0, forward: 0, lost: 0, final: 0 }
    x.sent += 1
    if (e.result?.reply) x.replies += 1
    if (e.result?.meeting) x.meetings += 1
    if (e.result?.forward) x.forward += 1
    if (e.result?.lost) x.lost += 1
    if (e.result?.final) x.final += 1
    m.set(k, x)
  }
  return m
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0)
const describe = (x) => `${TYPE_LABEL[x.type]} · ${STYLE_LABEL[x.style] ?? x.style}: ${x.replies}/${x.sent} vastasi, tapaamisia ${x.meetings}`

/** Perjantairaportin osio "Mikä toimi tällä viikolla": 3 riviä (paras, heikoin, suositus). */
export function fridaySection(entries, now = new Date()) {
  const t = new Date(now).getTime()
  const week = entries.filter((e) => e.used && t - new Date(e.used.at).getTime() < 7 * DAY)
  const given = entries.filter((e) => t - new Date(e.given).getTime() < 7 * DAY).length
  const stats = [...learningStats(entries, { since: new Date(t - 42 * DAY) }).values()].filter((x) => x.sent >= 3)
  const head = `MIKÄ TOIMI TÄLLÄ VIIKOLLA (aamupaketti: annettu ${given}, lähetetty ${week.length}; vertailu 6 vk, tapa mukana kun lähetetty ≥ 3)`
  if (!stats.length) {
    return [
      head,
      `- Paras: ei vielä vertailukelpoista dataa (${entries.filter((e) => e.used).length} lähetettyä luonnosta yhteensä).`,
      '- Heikoin: ei vielä dataa.',
      '- Suositus: merkitse lähetetyt ("lähetin 2" tai sovelluksen Kopioi viesti), niin näen 14 pv:ssä, mikä johtaa vastaukseen.',
    ].join('\n')
  }
  const score = (x) => (x.replies + x.meetings * 0.5) / x.sent
  const sorted = [...stats].sort((a, b) => score(b) - score(a) || b.sent - a.sent)
  const best = sorted[0]
  const worst = sorted.length > 1 ? sorted.at(-1) : null
  const sure = (x) => (x.sent >= MIN_CASES ? '' : ' (alustava)')
  return [
    head,
    `- Paras: ${describe(best)}${sure(best)}.`,
    `- Heikoin: ${worst ? `${describe(worst)}${sure(worst)}` : 'vain yksi tapa vertailussa'}.`,
    `- Suositus: ${best.sent >= MIN_CASES ? `nojaa tapaan "${STYLE_LABEL[best.style] ?? best.style}" ${TYPE_LABEL[best.type]}viesteissä; vaihtoehto pysyy mukana, ettei oppi kapene.` : `kokeile tapaa "${STYLE_LABEL[best.style] ?? best.style}" lisää, vakiintunut tulos vaatii ${MIN_CASES} lähetettyä.`}`,
  ].join('\n')
}

/**
 * Kuukausittain myyntiopin "Omat tulokset" -osioon: vain vakiintuneet (≥ MIN_CASES lopullista tapausta), ei mitään
 * henkilökohtaista (ei yrityksiä, ei nimiä, ei yhteystietoja). Palauttaa rivit tai [].
 */
export function ownResultsLines(entries, now = new Date()) {
  const finals = entries.filter((e) => e.used && e.result?.final)
  return [...learningStats(finals).values()]
    .filter((x) => x.sent >= MIN_CASES)
    .sort((a, b) => a.type.localeCompare(b.type) || b.replies / b.sent - a.replies / a.sent)
    .map((x) => `- ${TYPE_LABEL[x.type]} · ${STYLE_LABEL[x.style] ?? x.style}: vastaus ${pct(x.replies, x.sent)} %, tapaaminen ${pct(x.meetings, x.sent)} %, vaihe eteni ${pct(x.forward, x.sent)} % (${x.sent} tapausta, tilanne ${fiShort(now)})`)
}

// --- päivän paketti ja käyttö ----------------------------------------------------------------------------------

let inflight = null
/**
 * Päivän paketti: tehdään kerran päivässä (aamun ajo tai sovellus, kumpi ensin), kirjataan lokiin ja pidetään samana
 * koko päivän, jotta "lähetin 2" osuu oikeaan. getRows = crm.morningRows (vain luku).
 */
export async function todayPackage({ getRows, now = new Date(), file = DEFAULT_FILE, styleOf = sellerStyle } = {}) {
  const state = loadLog(file)
  if (state.today?.day === hkDay(now)) return state.today
  if (inflight) return inflight
  inflight = (async () => {
    const rows = await getRows()
    const fresh = loadLog(file)
    if (fresh.today?.day === hkDay(now)) return fresh.today
    fresh.entries = evaluateOutcomes(fresh.entries, rows, now)
    const pkg = buildPackage(rows, { now, log: fresh.entries, styleOf })
    fresh.entries.push(...entriesFor(pkg))
    fresh.today = pkg
    saveLog(fresh, file)
    return pkg
  })().finally(() => {
    inflight = null
  })
  return inflight
}

/** Päivitä tulokset ilman uutta pakettia (esim. perjantain raporttia varten). */
export async function refreshOutcomes({ getRows, now = new Date(), file = DEFAULT_FILE } = {}) {
  const state = loadLog(file)
  if (!state.entries.some((e) => e.used && !e.result?.final)) return state.entries
  state.entries = evaluateOutcomes(state.entries, await getRows(), now)
  saveLog(state, file)
  return state.entries
}

/**
 * Luonnos käytetty: how = 'lahetin' (Elias/ryhmä sanoi) tai 'kopio' (sovelluksen nappi, "todennäköisesti käytetty").
 * Sanottu "lähetin" voittaa kopion. Palauttaa merkinnän tai null.
 */
export function markUsed(n, variant = 'a', how = 'lahetin', who = '', { now = new Date(), file = DEFAULT_FILE } = {}) {
  const state = loadLog(file)
  const day = state.today?.day
  const e = state.entries.find((x) => x.day === day && x.n === Number(n))
  if (!e) return null
  if (e.used?.how === 'lahetin' && how === 'kopio') return e
  e.used = { at: e.used?.at && how === 'kopio' ? e.used.at : new Date(now).toISOString(), variant: variant === 'b' ? 'b' : 'a', how, who: String(who).slice(0, 40) }
  saveLog(state, file)
  return e
}

/** "lähetin 2" / "/lahetin 2b" yksityischatissa tai ryhmässä → kuittausteksti, tai null jos ei koske aamupakettia. */
export function usedFromText(text, who = '', opts = {}) {
  const m = String(text ?? '').trim().match(/^\/?l[äa]hetin\s+(\d{1,2})\s*([ab])?\s*[.!]*$/i)
  if (!m) return null
  const e = markUsed(Number(m[1]), (m[2] ?? 'a').toLowerCase(), 'lahetin', who, opts)
  if (!e) return `Numeroa ${m[1]} ei ole tämän päivän aamupaketissa.`
  const style = e.used.variant === 'b' ? e.altStyle : e.style
  return `Kirjattu: ${e.n}${e.used.variant === 'b' ? 'b' : ''}. ${e.company} (${TYPE_LABEL[e.type]}, ${STYLE_LABEL[style] ?? style}). Seuraan CRM:stä 14 pv, johtaako se vastaukseen tai tapaamiseen.`
}
