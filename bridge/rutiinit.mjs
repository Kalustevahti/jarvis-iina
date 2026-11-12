/**
 * Rutiinit: monta asiaa yhdellä sanalla, ilman että kielimalli käy jokaisen askeleen läpi.
 *
 *   leffailta   projektori päälle → Netflix (ja haku, jos nimi annettu) → valot pois → koneen näyttö kiinni
 *   hyvaa_yota  projektori valmiustilaan, kone lukkoon (EI lepotilaan, jotta JARVIS pysyy tavoitettavissa),
 *               huomisen ensimmäinen tapaaminen
 *   huomenta    päivän tapaamiset + putken asiat, joihin pitää palata
 *
 * Lisäksi Telegramin pikakomennot (/tila, /kuva, /lukitse, /peru, /tanaan, /leffa, /yo) vastataan suoraan
 * ilman mallia: nopeampi ja ei kuluta Claude-käyttöä.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { appointmentsBetween, crmConfigured, dashboard } from './crm.mjs'
import { machineCall } from './kone.mjs'
import { mediaSessions, projectorCall, projectorConfigured, projectorRecentlyUsed, spotifyPlay } from './projektori.mjs'
import { reviewDay } from './itsearvio.mjs'
import { lightsConfigured, setLights } from './valot.mjs'
import { teslaCall, teslaConfigured } from './tesla.mjs'
import { tvCall, tvConfigured } from './telkkari.mjs'
import { vacuumBusy, vacuumCall, vacuumConfigured } from './imuri.mjs'
import { healthText } from './terveys.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commandsText, sendTelegram } from './telegram.mjs'
import { movieQuick, moviesConfigured, parseRequest, suggest } from './leffat.mjs'
import { cameraConfigured, cameraToTelegram, pan as cameraPan, setCameraPrivacy } from './kamera.mjs'
import { acLearnAnswer, acLearnStart, irConfigured, irHasProjector } from './ir.mjs'

/**
 * Telegram quick paths run inside the polling loop: anything slow (camera, IR wake up to a minute) answers at once
 * and sends its result as a separate message, so other messages are not held up.
 */
function later(startText, fn) {
  void Promise.resolve()
    .then(fn)
    .then((t) => (t ? sendTelegram(String(t)) : null), (e) => sendTelegram(`Ei onnistunut: ${e?.message ?? e}`))
    .catch(() => {})
  return startText
}
const camMissing = 'Kameraa ei ole asennettu: tyokalut\\asenna_kamera.bat.'
async function panAndShoot(dir) {
  const t = await cameraPan('', dir)
  await new Promise((r) => setTimeout(r, 1500))
  return `${t}\n${await cameraToTelegram()}`
}
/** Leffailta via IR can take a minute: run it in the background when the IR wake is in play. */
async function movieNight(haku) {
  if (await irHasProjector().catch(() => false)) return later('🎬 Leffailta käynnistyy (projektorin herätys voi kestää minuutin)…', () => runRoutine('leffailta', haku ? { haku } : undefined))
  return runRoutine('leffailta', haku ? { haku } : undefined)
}

const fmt = (iso) =>
  new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

async function todayText() {
  if (!crmConfigured()) return 'CRM ei ole yhdistetty.'
  const d = await dashboard()
  const now = Date.now()
  const todayEnd = new Date()
  todayEnd.setHours(23, 59, 59, 999)
  const today = (d.meetings ?? []).filter((m) => new Date(m.at).getTime() <= todayEnd.getTime() && new Date(m.at).getTime() >= now - 3 * 3600_000)
  const next = (d.meetings ?? []).filter((m) => new Date(m.at).getTime() > todayEnd.getTime()).slice(0, 3)
  const L = []
  L.push(today.length ? `Tänään ${today.length} tapaamista:` : 'Tänään ei tapaamisia.')
  for (const m of today) L.push(`• ${fmt(m.at)} ${m.org}${m.contact ? ` – ${m.contact}` : ''}${m.seller ? ` [${m.seller}]` : ''}`)
  if (!today.length && next.length) {
    L.push('Seuraavaksi:')
    for (const m of next) L.push(`• ${fmt(m.at)} ${m.org}${m.seller ? ` [${m.seller}]` : ''}`)
  }
  if (d.issues?.length) {
    L.push('', `Palaa näihin (${d.issues.length}):`)
    for (const i of d.issues.slice(0, 8)) L.push(`• ${i}`)
  }
  const leads = (d.leads?.list ?? []).filter((l) => !l.rejected && !l.approved)
  if (leads.length) L.push('', `Liidejä tarkastettavana: ${leads.length} (vastaa "hyväksy 1" / "hylkää 2 syy")`)
  return L.join('\n')
}

/** ~/.jarvis/rutiinit.json: { eroottinen: { valo: 'makuuhuone', vari: 'eroottinen', kirkkaus: 35, soittolista: 'spotify:playlist:…', haku: '…', ruutu: 'pimeä' } } */
function routinePrefs() {
  try {
    const f = join(homedir(), '.jarvis', 'rutiinit.json')
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) : {}
  } catch {
    return {}
  }
}

/** Projektorikutsu, joka heittää virheen (rutiini ei jatka sokkona, jos projektori ei vastaa). */
async function proj(name, args = {}) {
  const r = await projectorCall(name, args)
  if (r.error) throw new Error(r.text.replace(/^Projektori: /, ''))
  return r.text
}

export async function runRoutine(name, { haku = '' } = {}) {
  const done = []
  const fail = []
  const step = async (label, fn) => {
    try {
      const r = await fn()
      done.push(typeof r === 'string' && r ? r : label)
    } catch (err) {
      fail.push(`${label}: ${String(err?.message ?? err).slice(0, 100)}`)
    }
  }
  const projectorOn = async () => {
    await step('projektori päälle', () => proj('projektori_virta', { tila: 'paalle' }))
    return !fail.length
  }
  if (name === 'leffailta') {
    // Leffailta (Eliaksen toive 4.11.): kun projektori vastaa, valot ja koneen näyttö sammuvat SAMALLA HETKELLÄ
    // ja Netflix (profiili Elias) aukeaa rinnakkain. Projektorin tarkistus ensin, ettei jäädä pimeään.
    if (!projectorConfigured()) return 'Projektoria ei ole asennettu (tyokalut\\asenna_projektori.bat).'
    if (!(await projectorOn())) return `${fail.join('\n')}\n\nEn sammuttanut valoja enkä näyttöä, koska projektori ei ole päällä. Käynnistä projektori kaukosäätimestä (tai IR-ohjaimella, jos se on asennettu) ja sano sitten "leffailta" uudelleen.`
    await Promise.all([
      lightsConfigured() ? step('valot pois', () => setLights('kaikki', { paalle: false })) : null,
      step('koneen näyttö pois', async () => (await machineCall('kone_naytto', { tila: 'pois' })).text),
      step('Netflix', () => proj('projektori_netflix', haku ? { haku } : {})),
    ])
  } else if (name === 'hyvaa_yota') {
    if (projectorConfigured()) await step('projektori valmiustilaan', async () => (await projectorCall('projektori_virta', { tila: 'pois' })).text)
    await step('kone lukkoon', async () => (await machineCall('kone_lukitse')).text)
    if (crmConfigured()) {
      await step('huominen', async () => {
        const t = new Date()
        const from = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)
        const to = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 2)
        const list = await appointmentsBetween(from, to)
        return list.length ? `Huomenna ${list.length} tapaamista, ensimmäinen ${fmt(list[0].starts_at)} ${list[0].org}.` : 'Huomenna ei tapaamisia.'
      })
    }
  } else if (name === 'huomenta') {
    return todayText()
  } else if (name === 'nukkumaan') {
    // Kaikki tähän asti lisätyt laitteet kiinni: projektori, valot, näyttö; kone lukkoon (ei lepotilaan, JARVIS pysyy tavoitettavissa).
    if (projectorConfigured()) await step('projektori valmiustilaan', async () => (await projectorCall('projektori_virta', { tila: 'pois' })).text)
    if (tvConfigured()) await step('Samsung pois', () => tvCall('pois'))
    if (lightsConfigured()) await step('valot pois', () => setLights('kaikki', { paalle: false }))
    if (vacuumConfigured() && (await vacuumBusy())) await step('imuri kotiin', () => vacuumCall('kotiin'))
    await step('näyttö pois', async () => (await machineCall('kone_naytto', { tila: 'pois' })).text)
    await step('kone lukkoon', async () => (await machineCall('kone_lukitse')).text)
  } else if (name === 'eroottinen') {
    const pref = routinePrefs().eroottinen ?? {}
    const light = pref.valo || 'makuuhuone'
    if (lightsConfigured()) await step('valo punaiseksi', () => setLights(light, { vari: pref.vari || 'eroottinen', kirkkaus: pref.kirkkaus ?? 35 }))
    if (!projectorConfigured()) return [...done, 'Projektoria ei ole asennettu.'].join('\n')
    if (!(await projectorOn())) return [...done, ...fail, '', 'Valo on asetettu, mutta musiikki jäi soittamatta. Käynnistä projektori kaukosäätimestä ja sano sitten "eroottinen" uudelleen.'].join('\n')
    await step('Spotify', () => proj('projektori_avaa', { sovellus: 'spotify' }))
    await new Promise((r) => setTimeout(r, 3000))
    const uri = pref.soittolista || `spotify:search:${encodeURIComponent(pref.haku || 'Sex Playlist Hottest Bedroom')}`
    // Soimaan asti + tarkistus (linkki yksin avaa vain listan sivun; playpause ei käynnistä listaa Spotify TV:ssä).
    await step('soittolista soimaan', () => spotifyPlay(uri))
    if (pref.ruutu !== 'päällä' && !fail.length) await step('ruutu himmeäksi', () => proj('projektori_ruutu', { tila: 'pimea' }))
  } else return `Tuntematon rutiini ${name}.`
  return [...done, ...(fail.length ? [`Ei onnistunut: ${fail.join('; ')}`] : [])].join('\n')
}

/** Selvä laitekomento luonnollisella kielellä → suora toiminto ilman mallia JA jonon ohi (sekunnissa, vaikka iso tehtävä on kesken). */
// Quick intents run inside the Telegram polling loop: wait at most 5 s for a busy projector.
const pq = (name, args) => projectorCall(name, args, { waitMs: 5000 })
const QUICK = [
  [/^(sulje|sammuta|laita)\s+(tietokoneen\s+)?näyt(tö|öt)(\s+(pois|kiinni))?\s*[.!]?$/i, () => machineCall('kone_naytto', { tila: 'pois' })],
  [/^(laita\s+)?näyt(tö|öt)\s+(päälle|takaisin)\s*[.!]?$/i, () => machineCall('kone_naytto', { tila: 'paalle' })],
  [/^lukitse\s+(kone|tietokone|näyttö)\s*[.!]?$/i, () => machineCall('kone_lukitse')],
  [/^peru\s+sammutus\s*[.!]?$/i, () => machineCall('kone_peru')],
  [/^(mikä\s+)?koneen\s+tila\??$/i, () => machineCall('kone_tila')],
  [/^(ota\s+)?kuvakaappaus\s*[.!]?$/i, () => machineCall('kone_kuvakaappaus', { selite: 'Näyttö nyt' })],
  // "telkkari/TV" = Samsung, kun se on yhdistetty (Eliaksen päätös 4.11.); projektori omalla nimellään.
  [/^(laita\s+)?(projektori|xgimi)\s+(pois|kiinni|valmiustilaan)\s*[.!]?$/i, () => pq('projektori_virta', { tila: 'pois' })],
  [/^(laita\s+)?(projektori|xgimi)\s+päälle\s*[.!]?$/i, () => pq('projektori_virta', { tila: 'paalle' })],
  [/^((laita|sulje|sammuta)\s+)?(telkkari|tv|televisio)(\s+(pois|kiinni|valmiustilaan))?\s*[.!]?$/i, () => (tvConfigured() ? tvCall('pois').then((t) => ({ text: t })) : Promise.resolve({ text: 'Samsungia ei ole vielä yhdistetty (tyokalut\\asenna_telkkari.bat). Projektorin saat pois sanomalla "projektori pois".' }))],
  [/^((laita|avaa|käynnistä)\s+)?(telkkari|tv|televisio)\s+(päälle|auki)\s*[.!]?$/i, () => (tvConfigured() ? tvCall('paalle').then((t) => ({ text: t })) : Promise.resolve({ text: 'Samsungia ei ole vielä yhdistetty (tyokalut\\asenna_telkkari.bat).' }))],
  [/^(mykistä|hiljennä)(\s+(projektori|telkkari|tv))?\s*[.!]?$/i, () => pq('projektori_nappain', { nappi: 'mykistä' })],
  [/^(ääni|äänet|volume)\s+(kovemmalle|isommalle|ylös)\s*[.!]?$/i, () => pq('projektori_nappain', { nappi: 'ääni+', maara: 3 })],
  [/^(ääni|äänet|volume)\s+(hiljemmalle|pienemmälle|alas)\s*[.!]?$/i, () => pq('projektori_nappain', { nappi: 'ääni-', maara: 3 })],
  // Explicit pause / play (not the play-pause toggle): "jatka" must never pause something that is already playing.
  // Bare pause/play: projector when it was just used; otherwise the model decides (Samsung, Spotify on the PC…).
  [/^(tauko|pause|pysäytä)\s*[.!]?$/i, () => (projectorConfigured() && projectorRecentlyUsed(3 * 3600_000) ? pq('projektori_toisto', { toiminto: 'tauko' }) : SKIP)],
  [/^play\s*[.!]?$/i, () => (projectorConfigured() && projectorRecentlyUsed(3 * 3600_000) ? pq('projektori_toisto', { toiminto: 'jatka' }) : SKIP)],
  // "jatka" also means "continue your answer": playback only when the projector was just used and something is paused there.
  [/^jatka\s*[.!]?$/i, async () => {
    if (!projectorConfigured() || !projectorRecentlyUsed(3 * 3600_000)) return SKIP
    const s = await mediaSessions().catch(() => [])
    return s.some((x) => x.state === 2) ? pq('projektori_toisto', { toiminto: 'jatka' }) : SKIP
  }],
  // Bare "mikä soi" / "ääni 30" can mean Spotify on the PC or the Samsung: direct only when the projector is named or was just used.
  [/^(mikä|mitä)\s+(soi|pyörii)(\s+(nyt|projektorilla|projektorissa))?\s*\??$/i, (m) => (/projektori/i.test(m[0]) || projectorRecentlyUsed(3 * 3600_000) ? pq('projektori_toisto', { toiminto: 'tila' }) : SKIP)],
  [/^(projektorin\s+tila|onko\s+projektori\s+päällä)\s*\??$/i, () => pq('projektori_tila', {}).then((r) => ({ text: r.text.replace(/\n\nPROJEKTORIOPPI:[\s\S]*$/, '') }))],
  [/^(projektorin\s+)?(ääni|äänet|volume)\s+(\d{1,3})\s*(%|prosenttia|prosenttiin)?\s*[.!]?$/i, (m) => (Number(m[3]) <= 100 && (m[1] || projectorRecentlyUsed(3 * 3600_000)) ? pq('projektori_aani', { taso: Number(m[3]) }) : SKIP)],
  [/^(valot|valo)\s+(pois|kiinni)\s*[.!]?$/i, () => setLights('kaikki', { paalle: false }).then((t) => ({ text: t }))],
  [/^(valot|valo)\s+päälle\s*[.!]?$/i, () => setLights('kaikki', { paalle: true }).then((t) => ({ text: t }))],
  [/^(nukkumaan|mennään nukkumaan|hyvää yötä)\s*[.!]?$/i, () => runRoutine('nukkumaan').then((t) => ({ text: t }))],
  [/^(leffailta|elokuvailta|laita leffa|leffa)\s*[.!]?$/i, () => movieNight().then((t) => ({ text: t }))],
  [/^eroottinen(\s+tila)?\s*[.!]?$/i, () => runRoutine('eroottinen').then((t) => ({ text: t }))],
  [/^(lämmitä|lämmitys)\s+(auto|tesla|autoon?)\s*(päälle)?\s*[.!]?$/i, () => teslaCall('lammita').then((t) => ({ text: t }))],
  [/^(auton|teslan)\s+lämmitys\s+pois\s*[.!]?$/i, () => teslaCall('lammitys_pois').then((t) => ({ text: t }))],
  [/^(auton|teslan)\s+tila\??$/i, () => teslaCall('tila').then((t) => ({ text: t }))],
  [/^missä\s+(auto|tesla)(ni)?( on)?\??$/i, () => teslaCall('sijainti').then((t) => ({ text: t }))],
  [/^(laita\s+)?samsung(\s+telkkari)?\s+päälle\s*[.!]?$/i, () => tvCall('paalle').then((t) => ({ text: t }))],
  [/^(laita\s+)?samsung(\s+telkkari)?\s+(pois|kiinni)\s*[.!]?$/i, () => tvCall('pois').then((t) => ({ text: t }))],
  [/^samsung(\s+telkkari)?\s+(mykistä|hiljaiseksi)\s*[.!]?$/i, () => tvCall('nappain', { nappi: 'mykistä' }).then((t) => ({ text: t }))],
  [/^samsung(\s+telkkari)?\s+(ääni|äänet)\s+(kovemmalle|isommalle|ylös)\s*[.!]?$/i, () => tvCall('nappain', { nappi: 'ääni+', maara: 3 }).then((t) => ({ text: t }))],
  [/^samsung(\s+telkkari)?\s+(ääni|äänet)\s+(hiljemmalle|pienemmälle|alas)\s*[.!]?$/i, () => tvCall('nappain', { nappi: 'ääni-', maara: 3 }).then((t) => ({ text: t }))],
  [/^(uudelleen|käynnistä uudelleen|käynnistä itsesi uudelleen|päivitä itsesi|restart)\s*[.!]?$/i, () => machineCall('jarvis_uudelleen')],
  // Lämpöpumpun oppimistesti (vika V2): reitit yksi kerrallaan, kyllä/ei Telegramissa. Ei yöllä.
  [/^(testaa|kokeile|opeta)\s+(ilma)?(lämpöpumppu|lampopumppu|lämpöpumppua|ilp|ilpiä)\s*[.!]?$/i, () => (irConfigured() ? acLearnStart() : 'Tuya-tiliä ei ole yhdistetty (tyokalut\\asenna_valot.bat).')],
  [/^(imuroi|imurointi päälle|käynnistä imuri)\s*[.!]?$/i, () => vacuumCall('aloita').then((t) => ({ text: t }))],
  [/^imuroi\s+(?!.*\b(?:sitten|klo|päästä|kuluttua|sammuta|laita|avaa|lukitse|kun)\b)(.{2,60}?)\s*[.!]?$/i, (m) => vacuumCall('aloita', { huoneet: splitRooms(m[1]), teho: /hilja/i.test(m[1]) ? 'quiet' : /täysillä|kunnolla/i.test(m[1]) ? 'turbo' : undefined }).then((t) => ({ text: t }))],
  [/^(imuri\s+(kotiin|telakkaan)|lopeta\s+imurointi|imurointi\s+(pois|seis)|imuri\s+pois)\s*[.!]?$/i, () => vacuumCall('kotiin').then((t) => ({ text: t }))],
  [/^imuri\s+(tauko|tauolle)\s*[.!]?$/i, () => vacuumCall('tauko').then((t) => ({ text: t }))],
  [/^imuri\s+jatka\s*[.!]?$/i, () => vacuumCall('jatka').then((t) => ({ text: t }))],
  [/^(imurin\s+tila|mitä\s+imuri\s+tekee|missä\s+imuri( on)?)\??$/i, () => vacuumCall('tila').then((t) => ({ text: t }))],
  [/^(tarkista(\s+(palvelut|kaikki|yhteydet))?|toimiiko\s+kaikki|terveystarkastus|palveluiden\s+tila)\s*[.!?]?$/i, () => healthText().then((t) => ({ text: t }))],
  // Kotikamera: kuva suoraan Eliaksen Telegramiin (Telegramin pikapolku; malli ei katso kuvaa — "mitä koirat tekee?" kuvaa mallin kautta).
  [/^((näytä|nayta|avaa)\s+)?(koira)?kamera(n\s+kuva)?\s*[.!]?$/i, async () => ({ text: cameraConfigured() ? later('📷 Otan kuvan…', () => cameraToTelegram().then(() => '')) : camMissing })],
  [/^kamera\s+(vasemmalle|oikealle|ylös|ylos|alas)\s*[.!]?$/i, async (m) => {
    if (!cameraConfigured()) return { text: camMissing }
    const dir = { vasemmalle: 'vasen', oikealle: 'oikea', ylös: 'ylös', ylos: 'ylös', alas: 'alas' }[m[1].toLowerCase()]
    return { text: later('📷 Käännän kameraa…', () => panAndShoot(dir)) }
  }],
  // Yksityisyystila: "sulje kamera", "kamera kiinni/pois", "sulje kamera 2 tunniksi", "olen kotona, sulje kamera" → JARVIS ei lue kameraa.
  [/^(?:olen kotona[,.]?\s*)?(?:sulje|sammuta|laita)\s+(?:koira)?kamera(?:\s+(?:pois|kiinni))?(?:\s+(\d+)\s*(min|minuutiksi|minuutti\w*|h|t|tunniksi|tunti\w*))?(?:[,.]?\s*(?:olen|ollaan|oon)\s+kotona)?\s*[.!]?$/i, async (m) => {
    if (!cameraConfigured()) return { text: camMissing }
    const n = Number(m[1] || 0)
    const mins = n ? (/^(h|t|tun)/i.test(m[2] || '') ? n * 60 : n) : 0
    return { text: setCameraPrivacy('pois', mins) }
  }],
  [/^(?:koira)?kamera\s+(?:pois|kiinni)\s*[.!]?$/i, async () => ({ text: cameraConfigured() ? setCameraPrivacy('pois') : camMissing })],
  [/^(?:laita\s+)?(?:koira)?kamera\s+(?:päälle|paalle|takaisin|käyttöön)\s*[.!]?$/i, async () => ({ text: cameraConfigured() ? setCameraPrivacy('paalle') : camMissing })],
  // "sulje <ohjelma>" → kone_sulje suoraan (ei mallia, ei Tehtävienhallinnan klikkailua). Laitteet on käsitelty yllä, joten tänne jää ohjelman nimi.
  [/^sulje\s+(?!näyt|telkkari|tv\b|televisio|projektori|xgimi|kamera|valo|kone\b|tietokone|jarvis|itsesi|ovi|ikkuna\b)([\p{L}\d][\p{L}\d .:+_-]{1,40}?)(?:\s+väkisin)?\s*[.!]?$/iu, async (m, full) => {
    const force = /väkisin\s*[.!]?$/i.test(String(full ?? m.input ?? ''))
    return machineCall('kone_sulje', { nimi: m[1].trim(), pakota: force })
  }],
]
/** Returned by a quick intent that decides the message is not for it after all: the model handles it. */
const SKIP = Symbol('skip')
/** "keittiö ja olohuone" / "keittiö, eteinen" → huonenimet. Tehosanat (hiljaa, täysillä) eivät ole huoneita. */
const splitRooms = (s) => String(s).split(/\s*(?:,|\bja\b|&)\s*/i).map((x) => x.trim()).filter((x) => x && !/^(hiljaa|hiljaisesti|täysillä|kunnolla|nyt|heti)$/i.test(x))

export async function quickIntent(text) {
  const t = String(text ?? '').trim()
  // Lämpöpumpun testi odottaa vastausta: "kyllä"/"ei" kuuluu testille, ei leffaehdotukselle eikä mallille.
  const ilp = acLearnAnswer(t)
  if (ilp) return ilp
  // Leffaehdotus ja siihen vastaaminen ("leffa kauhu" → ehdotus, "joo" → käyntiin, "seuraava", "nähty", "leffa oli hyvä").
  try {
    const mv = await movieQuick(t)
    if (mv) return mv
  } catch (err) {
    return `Leffat: ${err?.message ?? err}`
  }
  for (const [re, fn] of QUICK) {
    const m = t.match(re)
    if (!m) continue
    try {
      const r = await fn(m)
      if (r === SKIP) continue
      return r?.text ?? String(r)
    } catch (err) {
      return `Ei onnistunut: ${err?.message ?? err}`
    }
  }
  return null
}

/** Telegramin /-komennot ilman mallia. null = anna mallin hoitaa. */
export async function fastCommand(cmd, extra = '') {
  switch (cmd) {
    case 'tila':
      return (await machineCall('kone_tila')).text
    case 'kuva':
      return (await machineCall('kone_kuvakaappaus', { selite: 'Näyttö nyt' })).text
    case 'lukitse':
      return (await machineCall('kone_lukitse')).text
    case 'komennot':
      return commandsText()
    case 'uudelleen':
      return (await machineCall('jarvis_uudelleen')).text
    case 'naytto':
      return (await machineCall('kone_naytto', { tila: /p[aä]+lle/i.test(extra) ? 'paalle' : 'pois' })).text
    case 'peru':
      return (await machineCall('kone_peru')).text
    case 'tanaan':
      return todayText()
    case 'leffa':
      // "/leffa kauhu" → ehdotus katsomattomista; "/leffa <nimi>" tai pelkkä /leffa → leffailta kuten ennen.
      if (extra && moviesConfigured() && parseRequest(extra).recognized) return suggest({ genre: extra, pika: true })
      return movieNight(extra)
    case 'yo':
      return runRoutine('hyvaa_yota')
    case 'nukkumaan':
      return runRoutine('nukkumaan')
    case 'eroottinen':
      return runRoutine('eroottinen')
    case 'valot':
      return lightsConfigured() ? (await import('./valot.mjs')).lightsText() : 'Valoja ei ole yhdistetty: tyokalut\\asenna_valot.bat.'
    case 'tarkista':
      return healthText()
    case 'imuroi':
      return vacuumConfigured()
        ? /^(kotiin|pois|seis|lopeta)$/i.test(extra.trim())
          ? vacuumCall('kotiin')
          : /^tila$/i.test(extra.trim())
            ? vacuumCall('tila')
            : vacuumCall('aloita', { huoneet: extra.trim() ? splitRooms(extra) : [] })
        : 'Imuria ei ole yhdistetty: tyokalut\\asenna_imuri.bat.'
    case 'auto':
      return teslaConfigured() ? teslaCall(/pois/i.test(extra) ? 'lammitys_pois' : /lämmit|lammit/i.test(extra) ? 'lammita' : 'tila') : 'Teslaa ei ole yhdistetty: tyokalut\\asenna_tesla.bat.'
    case 'arvio':
      return (await reviewDay()) ?? 'Tänään ei ollut virheitä tai hitaita tehtäviä, joista oppia.'
    case 'kamera': {
      if (!cameraConfigured()) return camMissing
      const dir = { vasen: 'vasen', vasemmalle: 'vasen', oikea: 'oikea', oikealle: 'oikea', ylös: 'ylös', ylos: 'ylös', alas: 'alas' }[extra.trim().toLowerCase()]
      if (dir) return later('📷 Käännän kameraa…', () => panAndShoot(dir))
      return later('📷 Otan kuvan…', () => cameraToTelegram().then(() => ''))
    }
    case 'ir':
      return irConfigured() ? (await import('./ir.mjs')).irText() : 'Tuya-tiliä ei ole yhdistetty: tyokalut\\asenna_valot.bat.'
    case 'laitteet':
      // JARVIS-sivun PIN-laitteet: lista tai kaikki ulos (vain Eliaksen yksityischat: telegram.mjs suodattaa).
      return (await import('./sivu_pin.mjs')).devicesCommand(extra)
    default:
      return null
  }
}

export function routineServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  return createSdkMcpServer({
    name: 'jarvis_rutiini',
    version: '1.0.0',
    instructions: 'Rutiinit yhdellä kutsulla: leffailta (projektori + Netflix, valot pois, näyttö kiinni), hyvaa_yota, huomenta, nukkumaan (kaikki laitteet kiinni), eroottinen (punainen valo + Spotify projektorilla).',
    tools: [
      tool(
        'rutiini_asetus',
        'Tallentaa rutiinin asetukset (~/.jarvis/rutiinit.json). eroottinen: soittolista = Spotify-linkki (https://open.spotify.com/playlist/… tai spotify:playlist:…), ' +
          'valo (lampun nimi, oletus makuuhuone), vari, kirkkaus 1–100, ruutu (pimeä|päällä). Käytä kun Elias lähettää soittolistan linkin tai muuttaa rutiinia.',
        {
          rutiini: z.enum(['eroottinen']),
          soittolista: z.string().max(300).optional(),
          valo: z.string().max(40).optional(),
          vari: z.string().max(20).optional(),
          kirkkaus: z.number().int().min(1).max(100).optional(),
          ruutu: z.enum(['pimeä', 'päällä']).optional(),
        },
        async (a) => {
          try {
            const f = join(homedir(), '.jarvis', 'rutiinit.json')
            const all = routinePrefs()
            const cur = { ...(all[a.rutiini] ?? {}) }
            if (a.soittolista) {
              const m = String(a.soittolista).match(/(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?|spotify:)(playlist|album)[/:]([A-Za-z0-9]{10,40})/)
              if (!m) return ok('En tunnistanut Spotify-soittolistan linkkiä. Spotify: soittolista → ⋯ → Jaa → Kopioi linkki.')
              cur.soittolista = `spotify:${m[1]}:${m[2]}`
            }
            for (const k of ['valo', 'vari', 'kirkkaus', 'ruutu']) if (a[k] !== undefined) cur[k] = a[k]
            all[a.rutiini] = cur
            if (!existsSync(join(homedir(), '.jarvis'))) mkdirSync(join(homedir(), '.jarvis'), { recursive: true })
            writeFileSync(f, JSON.stringify(all, null, 1))
            return ok(`Tallennettu rutiiniin ${a.rutiini}: ${Object.entries(cur).map(([k, v]) => `${k} ${v}`).join(', ')}.`)
          } catch (err) {
            return ok(`Ei tallentunut: ${err?.message ?? err}`)
          }
        },
      ),
      tool(
        'rutiini',
        'Ajaa rutiinin: leffailta ("leffailta", "laita leffa", "elokuvailta" + valinnainen sarjan/elokuvan nimi: projektori päälle + Netflix, valot pois, koneen näyttö kiinni), hyvaa_yota ("hyvää yötä", "menen nukkumaan"), ' +
          'huomenta ("huomenta", "mitä tänään"), nukkumaan ("nukkumaan", "mennään nukkumaan": KAIKKI laitteet kiinni — projektori, valot, näyttö, kone lukkoon), ' +
          'eroottinen ("eroottinen", "romanttinen tunnelma": makuuhuoneen valo punaiseksi, projektori + Spotify-soittolista, ruutu himmeäksi). Yksi kutsu tekee kaikki vaiheet.',
        { nimi: z.enum(['leffailta', 'hyvaa_yota', 'huomenta', 'nukkumaan', 'eroottinen']), haku: z.string().max(80).optional() },
        async (a) => {
          try {
            return ok(await runRoutine(a.nimi, { haku: a.haku ?? '' }))
          } catch (err) {
            return ok(`Rutiini epäonnistui: ${err?.message ?? err}`)
          }
        },
      ),
    ],
  })
}
