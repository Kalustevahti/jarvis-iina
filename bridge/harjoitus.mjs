/**
 * Harjoituspuhelu: JARVIS esittää asiakasta, Elias myy (Eliaksen toive 6.11.2026).
 *
 * - harjoitus_aloita: arpoo asiakkaan (toimiala, koko, rooli, luonne, nykytila, piilotetut kivut, vastaväitteet,
 *   mikä saa suostumaan) ja vaikeuden 1–3. Vastaväitteet tulevat myyntiopista ja oikeista tilanteista.
 * - Joka vuorolla server.mjs liittää viestiin practiceNote(): roolin tiivistelmä, ettei malli putoa roolista.
 * - harjoitus_lopeta: paljastaa piilotiedot ja palautteen kriteerit; malli antaa palautteen.
 * - harjoitus_tallenna: Eliaksen parhaat vastaukset myyntioppiin "Eliaksen omina vastauksina" (hänen valintansa:
 *   vain parhaat vastaukset, ei koko litteraattia). Historia ~/.jarvis/harjoitukset.jsonl (pisteet, kehityskohteet).
 *
 * Asiakas on keksitty. Mitään ei lähetetä kenellekään eikä CRM:ää muuteta.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendSalesLearning } from './muisti.mjs'

const DIR = () => join(homedir(), '.jarvis')
const STATE = () => join(DIR(), 'harjoitus.json')
const HISTORY = () => join(DIR(), 'harjoitukset.jsonl')
const IDLE_MS = 30 * 60_000

// ---- Asiakkaan ainekset ---------------------------------------------------------------------
const SEGMENTS = [
  { ala: 'LVI-asennus', autot: [6, 25], auto: 'pakettiautoja', ajo: 'asentajat ajavat työmaalta toiselle koko päivän' },
  { ala: 'sähköasennus', autot: [5, 30], auto: 'pakettiautoja', ajo: 'asentajien autot ovat liikkuvia varastoja' },
  { ala: 'rakentaminen', autot: [8, 40], auto: 'pakettiautoja ja pari kuorma-autoa', ajo: 'työmaat ympäri Varsinais-Suomea' },
  { ala: 'maanrakennus', autot: [5, 20], auto: 'kuorma-autoja ja pakettiautoja', ajo: 'raskasta ajoa, autot seisovat jos koneet seisovat' },
  { ala: 'kuljetus', autot: [10, 50], auto: 'kevyitä kuorma-autoja ja pakettiautoja', ajo: 'autot ajavat kahdessa vuorossa' },
  { ala: 'jakelu ja kuriiri', autot: [8, 35], auto: 'pakettiautoja', ajo: 'jakelureitit joka päivä, auto pois = reitti ajamatta' },
  { ala: 'kiinteistöhuolto', autot: [5, 30], auto: 'pakettiautoja', ajo: 'huoltomiehet kiertävät kohteita, päivystys iltaisin' },
]
const ROLES = [
  { rooli: 'toimitusjohtaja ja omistaja', paattaa: 'päättää itse' },
  { rooli: 'toimitusjohtaja', paattaa: 'päättää, mutta haluaa kuulla työnjohtajan mielipiteen' },
  { rooli: 'työnjohtaja, joka hoitaa autot', paattaa: 'ei päätä yksin, vie asian toimitusjohtajalle jos se kuulostaa hyvältä' },
  { rooli: 'kalustovastaava', paattaa: 'suosittelee, toimitusjohtaja hyväksyy' },
]
const MOODS = [
  'kiireinen ja lyhytsanainen: vastaa lyhyesti, haluaa asiaan heti, katkaisee jos myyjä jaarittelee',
  'skeptinen ja analyyttinen: kysyy "mitä se maksaa" ja "mistä tiedätte", ei usko yleisiin lupauksiin',
  'ystävällinen mutta päättämätön: juttelee mielellään, mutta lykkää päätöksiä ("mietitään")',
  'tyytyväinen nykytilaan: "meillä toimii ihan hyvin", ei koe ongelmaa ennen kuin sitä kysytään tarkasti',
  'hintatietoinen: vertaa kaikkea hintaan, mutta arvostaa jos joku laskee hänen kanssaan',
  'huonon kokemuksen saanut: joku firma lupasi joskus paljon eikä hoitanut, epäluuloinen uusia kohtaan',
]
const SETUPS = [
  'merkkihuolto hoitaa huollot, työnjohtaja seuraa katsastuksia Excelissä',
  'toimitusjohtaja muistaa itse katsastukset ja renkaat, kaikki on hänen päässään',
  'osa autoista leasingilla: liisari hoitaa rahoituksen ja osan huolloista, katsastukset, renkaat ja korjaamot jäävät itselle',
  'tuttu korjaamo kylältä hoitaa kaiken, kun soittaa',
  'jokainen asentaja hoitaa oman autonsa huollot itse ja tuo kuitit',
  'toimistolla yksi henkilö hoitaa autoasiat muiden töiden ohessa',
]
const PAINS = [
  'viime keväänä kaksi autoa jäi katsastamatta ja seisoi ajokiellossa, asentajat odottivat',
  'työnjohtajalla menee 4–6 tuntia viikossa huoltojen ja renkaiden järjestelyyn',
  'rengasvaihtokausi sekoittaa joka kerta aikataulut, autot ovat päiviä pois',
  'korjaamolta tulee yllätyslaskuja, joita kukaan ei hyväksynyt etukäteen',
  'auto hajosi kesken työpäivän ja sijaisauton järjestämiseen meni koko päivä',
  'kukaan ei tiedä tarkalleen, paljonko autot oikeasti maksavat vuodessa',
  'firma kasvaa (rekryilmoituksia auki) ja autoja tulee lisää, nykyinen tapa ei skaalaudu',
  'vakuutukset on kilpailutettu viimeksi vuosia sitten',
]
// Myyntiopista ja oikeista tilanteista (myyntioppi.md: "liian kallista", "hoidetaan itse", "Pekka hoitaa", tuttu korjaamo, leasing).
// Strings, or [text, setup-regex]: an objection that only makes sense with a matching current setup.
const OBJECTIONS = [
  'Liian kallista, ei meillä ole tuohon budjettia.',
  'Me hoidetaan nämä ihan hyvin itse.',
  ['Pekka hoitaa meillä autot, ei me tarvita ketään.', /työnjohtaja|toimistolla|toimitusjohtaja muistaa/],
  ['Meillä on tuttu korjaamo, ei sitä vaihdeta.', /korjaamo|merkkihuolto/],
  ['Leasingyhtiö hoitaa meillä kaiken.', /leasing/],
  'Laita sähköpostia, katson sitten.',
  'Ei ole nyt aikaa tällaiseen.',
  'Mietitään ja palataan.',
  'Mitä tää maksaa? Sano nyt vaan hinta.',
  'En oo kuullutkaan teistä, kuka te ootte?',
  'Meillä on jo Excel, missä kaikki on.',
  'Miksi maksaisin jollekin siitä, minkä voin tehdä itse ilmaiseksi?',
]
// "Suostut seuraavaan askeleeseen vain, kun …"
const WINS = {
  1: 'myyjä kysyy vähintään yhden aidon kysymyksen tilanteestasi ja ehdottaa konkreettista aikaa 15 minuutin tapaamiselle',
  2: 'myyjä on löytänyt kysymällä ainakin yhden piilotetuista kivuista ja kertonut, mitä hyötyä siitä olisi sinulle (aikaa tai rahaa), ja ehdottaa aikaa',
  3: 'myyjä on löytänyt kivun, laskenut sen hinnan yhdessä kanssasi (tunnit × €/h tai seisontapäivän hinta), käsitellyt vastaväitteet väittelemättä ja ehdottanut tarkkaa aikaa. Jos hän pitää yli puolen minuutin esittelyn ennen ensimmäistä kysymystään, alat lopetella puhelua',
}
const FIRST = ['Mikko', 'Jari', 'Timo', 'Sami', 'Petri', 'Marko', 'Tiina', 'Sanna', 'Juha', 'Antti', 'Kati', 'Ville']
const LAST = ['Laaksonen', 'Heinonen', 'Salminen', 'Lehtonen', 'Mattila', 'Koskinen', 'Aaltonen', 'Rantanen', 'Jokela', 'Suominen']
const PLACES = ['Turku', 'Raisio', 'Kaarina', 'Naantali', 'Lieto', 'Salo', 'Uusikaupunki', 'Loimaa']

// Seeded random (tests: same seed → same customer).
function rng(seed = Date.now()) {
  let s = (Number(seed) >>> 0) || 1
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0), (s >>> 0) / 4294967296)
}
const pick = (r, a) => a[Math.floor(r() * a.length)]
const pickN = (r, a, n) => {
  const c = [...a]
  const out = []
  while (out.length < n && c.length) out.push(c.splice(Math.floor(r() * c.length), 1)[0])
  return out
}

/** Builds a random customer. difficulty 1–3 (random 30/40/30 when not given). fit=false = too small, tests qualifying out. */
export function buildPersona({ toimiala = '', vaikeus = null, seed } = {}) {
  const r = rng(seed ?? Date.now())
  const want = String(toimiala).toLowerCase()
  const seg = SEGMENTS.find((s) => want && s.ala.toLowerCase().includes(want.slice(0, 5))) ?? pick(r, SEGMENTS)
  const level = [1, 2, 3].includes(Number(vaikeus)) ? Number(vaikeus) : r() < 0.3 ? 1 : r() < 0.57 ? 2 : 3
  // Roughly one call in ten is a company that is not a real target (1–2 light-use cars): the right move is to qualify out politely.
  const fit = r() >= 0.1
  const cars = fit ? seg.autot[0] + Math.floor(r() * (seg.autot[1] - seg.autot[0] + 1)) : 1 + Math.floor(r() * 2)
  const role = pick(r, ROLES)
  const setup = pick(r, SETUPS)
  const objections = OBJECTIONS.filter((o) => !Array.isArray(o) || o[1].test(setup)).map((o) => (Array.isArray(o) ? o[0] : o))
  const name = `${pick(r, FIRST)} ${pick(r, LAST)}`
  const place = pick(r, PLACES)
  const company = `${seg.ala.split(' ')[0].replace(/^./, (c) => c.toUpperCase())}-${pick(r, LAST)} Oy`
  return {
    name,
    company,
    place,
    ala: seg.ala,
    autot: cars,
    autotyyppi: seg.auto,
    ajo: seg.ajo,
    rooli: role.rooli,
    paattaa: role.paattaa,
    luonne: pick(r, MOODS),
    nykytila: setup,
    kivut: fit ? pickN(r, PAINS, 2) : ['ei oikeaa ongelmaa: autoja on vähän ja ajoa vähän, itse hoitaminen vie vartin kuussa'],
    vastavaitteet: pickN(r, objections, level + 1),
    voitto: fit
      ? WINS[level]
      : 'et oikeastaan tarvitse palvelua: oikea liike myyjältä on todeta kohteliaasti, ettei se ole sinulle järkevä nyt, ja kysyä saako palata, jos kalusto kasvaa. Jos hän silti tyrkyttää, kiusaannu',
    vaikeus: level,
    sopiva: fit,
  }
}

const brief = (p) =>
  `${p.name}, ${p.rooli}, ${p.company} (${p.place}), ${p.ala}, ${p.autot} ${p.autot === 1 ? 'auto' : 'autoa'} (${p.autotyyppi}). Luonne: ${p.luonne}. Vaikeus ${p.vaikeus}/3.`

export function roleText(p) {
  return (
    `ASIAKKAASI (keksitty, älä kerro näitä Eliakselle ennen lopetusta):\n` +
    `- Kuka: ${p.name}, ${p.rooli} (${p.paattaa}). Yritys ${p.company}, ${p.place}. Ala: ${p.ala}.\n` +
    `- Kalusto: ${p.autot} ${p.autot === 1 ? 'auto' : 'autoa'}, ${p.autotyyppi}; ${p.ajo}.\n` +
    `- Nyt: ${p.nykytila}.\n` +
    `- Luonne: ${p.luonne}.\n` +
    `- Piilotetut kivut (kerro VAIN jos myyjä kysyy niistä hyvin, avoimella kysymyksellä; muuten "ei meillä mitään ongelmia"): ${p.kivut.join('; ')}.\n` +
    `- Vastaväitteet (käytä luontevasti, yksi kerrallaan, kun tilanne antaa syyn): ${p.vastavaitteet.map((v) => `"${v}"`).join(' ')}\n` +
    `- Suostut seuraavaan askeleeseen vain, kun: ${p.voitto}.\n`
  )
}

const RULES =
  'NÄIN ESITÄT ASIAKASTA: puhut kuin puhelimessa, suomeksi puhekieltä, 1–3 lyhyttä lausetta kerrallaan. Et ole JARVIS etkä avustaja: ' +
  'et auta myyjää, et kehu hänen myyntitapaansa, et kerro tietoja joita ei kysytty, et käytä "johtaja"-puhuttelua. ' +
  'Et tiedä KalustoVahdista mitään muuta kuin sen, minkä myyjä tässä puhelussa kertoo (älä käytä muistisi hintoja tai myyntioppia asiakkaana). ' +
  'Reagoi aidosti: hyvä kysymys avaa sinua vähän, oletus tai pitkä esittely sulkee. Jos myyjä lupaa säästöjä ilman perustetta, epäile. ' +
  'Jos myyjä väittelee, kiristy. Älä suostu liian helposti. Jos ehdot täyttyvät, suostu luontevasti ja sovi aika.'

// ---- Tila ------------------------------------------------------------------------------------
function readState() {
  try {
    const s = JSON.parse(readFileSync(STATE(), 'utf8').replace(/^﻿/, ''))
    if (!s?.active) return null
    if (Date.now() - Number(s.lastAt ?? 0) > IDLE_MS) {
      clearState()
      notify(false, { ended: true })
      return null
    }
    return s
  } catch {
    return null
  }
}
function writeState(s) {
  mkdirSync(DIR(), { recursive: true })
  writeFileSync(STATE(), JSON.stringify(s, null, 1))
}
function clearState() {
  try {
    if (existsSync(STATE())) unlinkSync(STATE())
  } catch {
    /* ok */
  }
}
export const practiceActive = () => Boolean(readState())
/** What the call screen may show: the person you called and the company, never the hidden details. */
const callInfo = (s) => ({ name: s.persona.name, company: s.persona.company, startedAt: s.startedAt })
export function practiceInfo() {
  const s = readState()
  return s ? callInfo(s) : null
}

// UI: the app keeps the microphone open longer during practice (no wake word between lines).
const listeners = new Set()
export function subscribePractice(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function notify(on, info = {}) {
  for (const fn of listeners) {
    try {
      fn(on, info)
    } catch {
      /* ok */
    }
  }
}

/** Per-turn reminder for the app session (server.mjs). Empty when no practice is running. */
export function practiceNote() {
  const s = readState()
  if (!s) return ''
  s.turns = Number(s.turns ?? 0) + 1
  s.lastAt = Date.now()
  writeState(s)
  return (
    `\n\n[Järjestelmä: HARJOITUSPUHELU käynnissä (Eliaksen ${s.turns}. repliikki). Olet asiakas: ${brief(s.persona)} ` +
    `Pysy roolissa (piilotiedot ja ehdot harjoitus_aloita-tuloksessa). ${RULES} ` +
    `Poistu roolista vain jos Elias sanoo "lopeta harjoitus", "harjoitus loppu", "aikalisä" tai puhuu selvästi JARVISille ("Jarvis, …"): ` +
    `lopetus → harjoitus_lopeta; aikalisä → vastaa JARVISina lyhyesti ja kysy jatketaanko. Jos tapaaminen sovittiin, voit lopettaa puhelun asiakkaana ja kutsua harjoitus_lopeta.]`
  )
}

function startPractice(args = {}, { isMeetingActive = () => false } = {}) {
  if (isMeetingActive()) return 'Kokoustila on päällä — harjoituspuhelu ei voi alkaa samaan aikaan. Lopeta kokous ensin.'
  const persona = buildPersona({ toimiala: args.toimiala, vaikeus: args.vaikeus })
  const state = { active: true, startedAt: Date.now(), lastAt: Date.now(), turns: 0, persona }
  writeState(state)
  notify(true, callInfo(state))
  console.log(`[jarvis] harjoitus: alkoi (${persona.ala}, ${persona.autot} autoa, vaikeus ${persona.vaikeus}${persona.sopiva ? '' : ', ei kohde'})`)
  return (
    `Harjoituspuhelu alkoi.\n${roleText(persona)}\n${RULES}\n\n` +
    `ALOITA NYT: sano ensin JARVISina yksi lyhyt lause ("Harjoituspuhelu alkaa. Soitat asiakkaalle, lopetus: sano lopeta harjoitus.") ` +
    `ja vastaa sitten puhelimeen asiakkaana yhdellä repliikillä (esim. "${persona.company.split(' ')[0]}, ${persona.name.split(' ')[0]}."). ` +
    `Älä kerro toimialaa, autojen määrää tai mitään muuta asiakkaasta — myyjä selvittää ne itse.`
  )
}

function endPractice() {
  const s = readState()
  if (!s) return 'Harjoituspuhelua ei ole käynnissä.'
  const p = s.persona
  const min = Math.max(1, Math.round((Date.now() - s.startedAt) / 60_000))
  clearState()
  notify(false, { ended: true })
  writeFileSync(join(DIR(), 'harjoitus_viimeisin.json'), JSON.stringify({ ...s, endedAt: Date.now() }, null, 1))
  console.log(`[jarvis] harjoitus: päättyi (${s.turns} repliikkiä, ${min} min)`)
  return (
    `Harjoituspuhelu päättyi (${s.turns} repliikkiä, noin ${min} min). Poistu roolista ja ole taas JARVIS.\n\n` +
    `KERRO ELIAKSELLE (lyhyesti, puhuttavaksi, suomeksi):\n` +
    `1. Kuka asiakas oli: ${brief(p)}${p.sopiva ? '' : ' HUOM: tämä EI ollut kohde (liian pieni) — oikea liike oli kohtelias karsinta.'}\n` +
    `2. Mitä hänellä oli piilossa: ${p.kivut.join('; ')}. Mitkä Elias löysi kysymällä, mitkä jäivät löytämättä.\n` +
    `3. Mikä olisi riittänyt: ${p.voitto}. Saiko hän sen (tapaaminen sovittu / ei)?\n` +
    `4. Palaute Eliaksen omaa myyntilinjaa vasten (myyntioppi): avaus ilman oletuksia; kysymykset ennen esittelyä; ` +
    `arvo laskettiin yhdessä vai väitettiin; ei luvattu säästöjä ilman dataa; hinta oikein (30 €/auto/kk alkaen, tarkka kartoituksessa); ` +
    `vastaväitteet nimeä-kysy-vastaa ilman väittelyä; konkreettinen aikaehdotus. Kaksi asiaa jotka toimivat, yksi tärkein kehityskohde. Arvosana 1–10.\n` +
    `5. Kutsu sitten harjoitus_tallenna: parhaat vastaukset (enintään 3) Eliaksen OMIN SANOIN siitä mitä hän tässä puhelussa sanoi ` +
    `(puheentunnistuksen virheet saa korjata, sisältöä ei saa parannella), sekä arvosana, tulos ja kehityskohde. Jos mikään vastaus ei ollut hyvä, anna tyhjä lista.`
  )
}

function savePractice(a = {}) {
  const last = (() => {
    try {
      return JSON.parse(readFileSync(join(DIR(), 'harjoitus_viimeisin.json'), 'utf8'))
    } catch {
      return null
    }
  })()
  const p = last?.persona
  const tag = p ? `${p.ala}, ${p.autot} ${p.autot === 1 ? 'auto' : 'autoa'}, ${p.rooli}, vaikeus ${p.vaikeus}/3` : 'harjoitus'
  const good = (a.vastaukset ?? []).filter((x) => x?.vastavaite && x?.vastaus).slice(0, 3)
  mkdirSync(DIR(), { recursive: true })
  appendFileSync(
    HISTORY(),
    `${JSON.stringify({ at: new Date().toISOString(), asiakas: tag, arvosana: a.arvosana ?? null, tulos: a.tulos ?? '', kehitys: a.kehitys ?? '', vastauksia: good.length })}\n`,
  )
  if (!good.length) return `Harjoitus kirjattu historiaan (${tag}). Myyntioppiin ei tallennettu vastauksia.`
  const lines = good.map(
    (x) => `- Asiakas: "${String(x.vastavaite).trim().slice(0, 200)}" → Elias: "${String(x.vastaus).trim().slice(0, 600)}"${x.miksi ? ` (toimi, koska ${String(x.miksi).trim().slice(0, 200)})` : ''}`,
  )
  appendSalesLearning(
    `### Eliaksen omat vastaukset harjoituspuhelusta (${tag})\n` +
      `Lähde: harjoituspuhelu, jossa JARVIS esitti keksittyä asiakasta; vastaukset ovat Eliaksen omia. Käytä niitä mallina, kun vastaava vastaväite tulee oikealta asiakkaalta.\n` +
      lines.join('\n'),
  )
  console.log(`[jarvis] harjoitus: ${good.length} vastausta myyntioppiin`)
  return `Tallennettu myyntioppiin ${good.length} vastausta (Eliaksen omat vastaukset, ${tag}) ja harjoitus historiaan.`
}

function historyText() {
  try {
    const rows = readFileSync(HISTORY(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-10)
    if (!rows.length) return 'Harjoituspuheluita ei ole vielä.'
    return rows
      .map((r) => `- ${new Date(r.at).toLocaleDateString('fi-FI', { timeZone: 'Europe/Helsinki' })}: ${r.asiakas} · ${r.tulos || '—'} · arvosana ${r.arvosana ?? '—'}${r.kehitys ? ` · kehitys: ${r.kehitys}` : ''}`)
      .join('\n')
  } catch {
    return 'Harjoituspuheluita ei ole vielä.'
  }
}

/**
 * Opens the app straight into the call screen (Edge app window, same flags as the meeting window: autoplay without a
 * click and the microphone allowed in its own profile), which starts the practice call by itself.
 */
export function openPracticeWindow() {
  const url = `${process.env.JARVIS_UI_URL ?? 'http://localhost:5190/'}?harjoitus=1&auto=1`
  const profile = join(process.env.LOCALAPPDATA ?? homedir(), 'JARVIS', 'edge-harjoitus')
  const args = [`--app=${url}`, `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--window-size=1180,780', '--no-first-run', '--no-default-browser-check']
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', 'msedge', ...args.map((a) => `"${a}"`)], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
        : spawn('msedge', args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch (err) {
    console.warn('[jarvis] harjoitus: ikkunan avaus epäonnistui:', err?.message ?? err)
    return false
  }
}

/** deps.windowOnly: Telegram — only the window opener and history (the call itself needs the app's voice and per-turn role note). */
export function practiceServer(deps = {}) {
  if (deps.windowOnly) return windowOnlyServer()
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  return createSdkMcpServer({
    name: 'jarvis_harjoitus',
    version: '1.0.0',
    instructions:
      'Harjoituspuhelu: JARVIS esittää asiakasta ja Elias harjoittelee myyntiä ja vastaväitteitä. "Harjoituspuhelu", "harjoitellaan myyntiä", ' +
      '"esitä asiakasta" → harjoitus_aloita. "Lopeta harjoitus" → harjoitus_lopeta → palaute → harjoitus_tallenna. "Miten harjoitukset ovat menneet" → harjoitus_historia.',
    tools: [
      tool(
        'harjoitus_aloita',
        'Aloittaa harjoituspuhelun: arpoo keksityn asiakkaan (toimiala, koko, rooli, luonne, piilotetut kivut, vastaväitteet, vaikeus 1–3) ja palauttaa roolin. ' +
          'Elias valitsi, että asiakas ja vaikeus arvotaan; anna toimiala tai vaikeus vain jos hän pyytää niitä erikseen.',
        { toimiala: z.string().max(40).optional(), vaikeus: z.number().int().min(1).max(3).optional() },
        async (a) => ok(startPractice(a ?? {}, deps)),
      ),
      tool('harjoitus_lopeta', 'Lopettaa harjoituspuhelun, paljastaa asiakkaan piilotiedot ja kertoo palautteen kriteerit.', {}, async () => ok(endPractice())),
      tool(
        'harjoitus_tallenna',
        'Tallentaa harjoituksen: Eliaksen parhaat vastaukset (enintään 3, hänen omin sanoin) myyntioppiin sekä arvosanan, tuloksen ja kehityskohteen historiaan.',
        {
          vastaukset: z
            .array(z.object({ vastavaite: z.string().max(200), vastaus: z.string().max(600), miksi: z.string().max(200).optional() }))
            .max(3)
            .optional(),
          arvosana: z.number().int().min(1).max(10).optional(),
          tulos: z.string().max(120).optional().describe('esim. "tapaaminen sovittu ti klo 10" tai "ei tapaamista"'),
          kehitys: z.string().max(200).optional(),
        },
        async (a) => ok(savePractice(a ?? {})),
      ),
      tool('harjoitus_historia', 'Viimeisimmät harjoituspuhelut: asiakas, tulos, arvosana ja kehityskohde.', {}, async () => ok(historyText())),
      tool(
        'harjoitus_ikkuna',
        'Avaa koneelle erillisen puhelunäkymän (videopuhelun näköinen ikkuna), joka aloittaa harjoituspuhelun itse. Käytä kun Elias pyytää "avaa harjoituspuhelu" Telegramista tai haluaa puheluikkunan; ' +
          'älä kutsu harjoitus_aloita samalla — ikkuna aloittaa puhelun.',
        {},
        async () => ok(practiceActive() ? 'Harjoituspuhelu on jo käynnissä — lopeta se ensin ("lopeta harjoitus").' : openPracticeWindow() ? 'Avasin harjoituspuhelun ikkunan koneelle. Puhelu alkaa itsestään muutamassa sekunnissa.' : 'Ikkunan avaus epäonnistui (Edge?).'),
      ),
    ],
  })
}

function windowOnlyServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  return createSdkMcpServer({
    name: 'jarvis_harjoitus',
    version: '1.0.0',
    instructions: 'Harjoituspuhelu käydään koneella puheella. Telegramista: "avaa harjoituspuhelu" → harjoitus_ikkuna; "miten harjoitukset ovat menneet" → harjoitus_historia.',
    tools: [
      tool('harjoitus_ikkuna', 'Avaa koneelle harjoituspuhelun ikkunan, joka aloittaa puhelun itse (Elias puhuu koneen mikrofoniin).', {}, async () =>
        ok(practiceActive() ? 'Harjoituspuhelu on jo käynnissä koneella.' : openPracticeWindow() ? 'Avasin harjoituspuhelun ikkunan koneelle. Puhelu alkaa itsestään, puhu koneen mikrofoniin.' : 'Ikkunan avaus epäonnistui (Edge?).'),
      ),
      tool('harjoitus_historia', 'Viimeisimmät harjoituspuhelut: asiakas, tulos, arvosana ja kehityskohde.', {}, async () => ok(historyText())),
    ],
  })
}

export const _test = { startPractice, endPractice, savePractice, historyText, readState }
