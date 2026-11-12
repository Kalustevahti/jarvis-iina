/**
 * Kokoustila: JARVIS kuuntelee palaveria, analysoi ja antaa vinkkejä näytölle.
 *
 * Kun kokoustila on päällä, käyttöliittymä lähettää kaiken kuulemansa (ilman
 * herätyssanaa) bridgelle 'meeting'-viesteinä sen sijaan, että JARVIS
 * vastaisi niihin. Bridge kokoaa litteraatin ja analysoi sen noin 40 sekunnin
 * välein erillisellä mallikutsulla. Vinkit piirretään bladelle (ei puhuta),
 * jotta ne eivät kuulu puheluun. "Jarvis, vinkki" lukee tuoreimmat vinkit
 * ääneen, "Jarvis, lopeta kokous" tekee yhteenvedon ja lähettää sen puhelimeen.
 *
 * Liikeidea: jos ~/.jarvis/liikeidea.md (tai Documents/JARVIS/liikeidea.md) on
 * olemassa, se annetaan analyysille pohjaksi, ja JARVIS seuraa, mitkä sen
 * osat on jo käyty läpi.
 */
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_DIR, appendSalesLearning, readSalesLearning } from './muisti.mjs'
import { spawn } from 'node:child_process'
import process from 'node:process'

const UI_URL = process.env.JARVIS_UI_URL ?? 'http://localhost:5190/'

/**
 * Avaa JARVISin käyttöliittymän omana Edge-ikkunana valmiiksi kokoustilaan.
 * Oma profiili (JARVIS-kokous), jotta käynnistysliput tulevat aina voimaan:
 * autoplay-lupa antaa äänianalyysin käynnistyä ilman klikkausta. Mikrofonin
 * lupa kysytään tässä profiilissa kerran.
 */
export function openMeetingWindow(description, { direct = false } = {}) {
  // direct: kokous on jo käynnistetty bridgessä (sovelluksen valikosta) — ikkuna vain liittyy, ei mallikutsua.
  const url = direct
    ? `${UI_URL}?auto=1&mini=1`
    : `${UI_URL}?kokous=${encodeURIComponent(String(description ?? '').trim() || 'Tapaaminen')}&auto=1&mini=1`
  const profile = join(process.env.LOCALAPPDATA ?? homedir(), 'JARVIS', 'edge-kokous')
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required',
    // Mikrofonin lupa myönnetään tässä profiilissa automaattisesti (oikeat
    // laitteet, ei lupakyselyä), jotta kuuntelu alkaa ilman klikkausta.
    '--use-fake-ui-for-media-stream',
    '--window-size=400,560',
    '--window-position=20,20',
    '--no-first-run',
    '--no-default-browser-check',
  ]
  // Pieni ikkuna nostetaan oikeaan alakulmaan ja aina päällimmäiseksi
  // (SetWindowPos HWND_TOPMOST) heti, kun Edge on avannut sen.
  setTimeout(() => pinWindowTopRight(), 2500)
  setTimeout(() => pinWindowTopRight(), 7000)
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', 'msedge', ...args.map((a) => `"${a}"`)], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
        : spawn('msedge', args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch (err) {
    console.warn('[jarvis] kokous: ikkunan avaus epäonnistui:', err?.message ?? err)
    return false
  }
}

function pinWindowTopRight() {
  if (process.platform !== 'win32') return
  const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
"@
$w = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'JARVIS vinkit*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($w) {
  Add-Type -AssemblyName System.Windows.Forms
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $cx = 400; $cy = 560
  # Oikea ALAkulma: Teamsin puhelupainikkeet (Poistu, mikrofoni) ovat ylhäällä oikealla.
  [W]::SetWindowPos($w.MainWindowHandle, [IntPtr](-1), $wa.Right - $cx - 12, $wa.Bottom - $cy - 12, $cx, $cy, 0x0040) | Out-Null
}
`
  try {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch {
    /* ei kriittinen */
  }
}

/** Ajastettu avaus: "14:30" (Suomen aikaa, tänään tai huomenna, jos aika on jo mennyt). */
const scheduled = []
export function scheduleMeeting(timeStr, description, notify) {
  const m = /^(\d{1,2})[.:](\d{2})$/.exec(String(timeStr).trim())
  if (!m) return 'Anna aika muodossa HH:MM, esim. 14:30.'
  const now = new Date()
  const fi = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Helsinki' }))
  const target = new Date(fi)
  target.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (target <= fi) target.setDate(target.getDate() + 1)
  const delay = target.getTime() - fi.getTime()
  const label = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`
  const t = setTimeout(() => {
    openMeetingWindow(description)
    notify?.(`Kokoustila avattu: ${description}`)
  }, delay)
  t.unref?.()
  if (delay > 5 * 60_000) {
    const r = setTimeout(() => notify?.(`Muistutus: tapaaminen "${description}" alkaa 5 minuutin päästä. Avaan JARVISin silloin.`), delay - 5 * 60_000)
    r.unref?.()
  }
  scheduled.push({ at: label, description })
  return `Ajastettu: avaan JARVISin kokoustilaan klo ${label} (${description}). Muistutan 5 minuuttia ennen.`
}

const DOC_PATHS = [
  join(homedir(), '.jarvis', 'liikeidea.md'),
  join(homedir(), 'Documents', 'JARVIS', 'liikeidea.md'),
]
/** Lisäaineisto: kaikki .md/.txt näistä kansioista (Documents/JARVIS/kokous_aineisto on helpoin pudotuspaikka). */
const CONTEXT_DIRS = [join(homedir(), 'Documents', 'JARVIS', 'kokous_aineisto'), join(homedir(), '.jarvis', 'konteksti')]
/** Projektikansiot: ~/.jarvis/projektit.json  {"kalustovahti": "C:\\polku\\kalustovahti"} */
const PROJECTS_FILE = join(homedir(), '.jarvis', 'projektit.json')
const ANALYSIS_EVERY_MS = 60_000
/** Koulutustila: ei välivinkkejä joka minuutti — JARVIS kuuntelee ja oppii, väliyhteenveto 5 min välein (säästää krediittejä). */
const TRAINING_EVERY_MS = 5 * 60_000
const QUICK_ANALYSIS_MS = 8_000
const MIN_NEW_WORDS = 20
const MAX_TRANSCRIPT_WORDS = 6000
const MAX_DOC_CHARS = 60_000
const PROJECT_FILES = ['README.md', 'CLAUDE.md', 'LIIKEIDEA.md', 'liikeidea.md', 'docs/README.md']

function readCapped(p, cap) {
  try {
    return readFileSync(p, 'utf8').slice(0, cap)
  } catch {
    return ''
  }
}

/** Liikeidea + konteksti-kansio + projektien README:t yhdeksi aineistoksi. */
function loadDoc() {
  const parts = []
  for (const p of DOC_PATHS) {
    if (existsSync(p)) {
      parts.push(`### Liikeidea (${p})\n${readCapped(p, 30_000)}`)
      break
    }
  }
  for (const dir of CONTEXT_DIRS) {
    try {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir).sort()) {
        if (!/\.(md|txt|csv)$/i.test(name)) continue
        parts.push(`### ${name}\n${readCapped(join(dir, name), 25_000)}`)
      }
    } catch {
      /* ei kansiota */
    }
  }
  try {
    if (existsSync(PROJECTS_FILE)) {
      const projects = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'))
      for (const [name, dir] of Object.entries(projects)) {
        for (const f of PROJECT_FILES) {
          const p = join(String(dir), f)
          if (existsSync(p)) parts.push(`### Projekti ${name}: ${f}\n${readCapped(p, 15_000)}`)
        }
        const docs = join(String(dir), 'docs')
        if (existsSync(docs)) {
          for (const name2 of readdirSync(docs).slice(0, 12)) {
            if (/\.md$/i.test(name2)) parts.push(`### Projekti ${name}: docs/${name2}\n${readCapped(join(docs, name2), 8_000)}`)
          }
        }
      }
    }
  } catch (err) {
    console.warn('[jarvis] kokous: projektit.json ei kelpaa:', err?.message ?? err)
  }
  return parts.join('\n\n').slice(0, MAX_DOC_CHARS)
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Mallin vastaus (otsikot + luettelot) -> HUD-markup. */
function toHtml(text, stamp) {
  const lines = String(text).split(/\r?\n/)
  let html = ''
  let open = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const h = line.match(/^#{0,3}\s*([A-ZÅÄÖ][A-ZÅÄÖ\s]{2,30}):?\s*$/)
    if (h) {
      if (open) html += '</div>'
      html += `<div class="hud-note hud-hot">${esc(h[1])}</div><div class="hud-rows">`
      open = true
      continue
    }
    const b = line.replace(/^[-•*]\s*/, '')
    html += `<div class="hud-row"><span class="hud-main"><span class="hud-label">${esc(b)}</span></span></div>`
  }
  if (open) html += '</div>'
  return `${html}<div class="hud-sub">päivitetty ${stamp}</div>`
}

export function createMeeting({ model, effort, liveModel, liveEffort, emitBlade, announce, notifyPhone, onEnd = null, log = console }) {
  let active = false
  let topic = ''
  let goal = ''
  let people = ''
  let notes = ''
  /** 'asiakas' | 'koulutus' | 'muu' */
  let kind = 'muu'
  let quickTimer = null
  let transcript = []
  let analysedWords = 0
  let lastTips = ''
  let lastSummary = ''
  let timer = null
  let busy = false
  /** Litteraatti tallennetaan jatkuvasti levylle, jotta mikään ei katoa (esim. Claude-tilin raja, kaatuminen). */
  let transcriptFile = null
  /** Claude-tilin raja tms.: analyysit tauolla tähän asti, ilmoitus puhelimeen kerran. */
  let pausedUntil = 0
  let limitNotified = false

  const words = () => transcript.reduce((n, t) => n + t.text.split(/\s+/).length, 0)
  const stamp = () => new Date().toLocaleTimeString('fi-FI', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' })

  function transcriptText() {
    let items = transcript
    let n = words()
    while (n > MAX_TRANSCRIPT_WORDS && items.length > 1) {
      n -= items[0].text.split(/\s+/).length
      items = items.slice(1)
    }
    return items.map((t) => `[${t.at}] ${t.text}`).join('\n')
  }

  /** heavy=true: yhteenveto ja opit (laadukkain malli); muuten kevyempi malli, joka säästää Claude-tilin rajaa. */
  async function askModel(prompt, { heavy = false } = {}) {
    let out = ''
    const session = query({
      prompt,
      options: {
        systemPrompt:
          'Olet JARVIS, suomenkielinen kokousassistentti. Vastaat pelkällä tekstillä: otsikot ' +
          'ISOILLA KIRJAIMILLA omalla rivillään, niiden alla lyhyet luettelokohdat (- alku). Ei markdownia, ' +
          'ei johdantoa, ei toistoa. Ole konkreettinen ja lyhyt. Ajattelet kriittisesti: erotat faktan (aineisto, litteraatti) ' +
          'omasta arviostasi, et keksi lukuja etkä mielistele.',
        model: heavy ? model : liveModel ?? model,
        effort: heavy ? effort : liveEffort ?? effort,
        maxTurns: 1,
        settingSources: [],
        mcpServers: {},
        tools: [],
        permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'deny', message: 'Ei työkaluja.' }),
        cwd: homedir(),
      },
    })
    for await (const msg of session) {
      if (msg.type === 'result') out = msg.subtype === 'success' ? String(msg.result ?? '') : ''
    }
    return out.trim()
  }

  const isLimitError = (err) => /limit|rate|429|overloaded|quota|usage/i.test(String(err?.message ?? err))
  function noteLimit(err) {
    const m = /resets?\s+([^\n(]+)/i.exec(String(err?.message ?? err))
    pausedUntil = Date.now() + 10 * 60_000
    if (!limitNotified) {
      limitNotified = true
      const when = m ? ` (nollautuu ${m[1].trim()})` : ''
      log.warn(`[jarvis] kokous: Claude-tilin raja täynnä${when} — analyysit tauolla, litteraatti tallentuu: ${transcriptFile ?? '-'}`)
      notifyPhone?.({ title: 'Kokousanalyysi tauolla', body: `Claude-tilin käyttöraja on täynnä${when}. Kuuntelen ja tallennan litteraatin silti; sano rajan nollauduttua "analysoi viimeisin kokous".`, tags: 'warning' }).catch(() => {})
      emitBlade({ id: 'kokous-vinkit', title: 'KOKOUS', kind: 'markup', html: `<div class="hud-note hud-hot">ANALYYSI TAUOLLA</div><div class="hud-note">Claude-tilin raja täynnä${esc(when)}. Litteraatti tallentuu — analysoin jälkikäteen.</div>`, size: 'wide', hold: 'sticky' })
    }
  }

  async function analyse(quick = false) {
    if (!active || busy) return
    if (Date.now() < pausedUntil) return
    const total = words()
    if (total - analysedWords < (quick ? 4 : MIN_NEW_WORDS)) return
    busy = true
    try {
      const doc = loadDoc()
      const learned = readSalesLearning()
      const roleIntro =
        kind === 'koulutus'
          ? `Myyntikoulutus on käynnissä: käyttäjä (Elias, joka neuvoo KalustoVahdin myyntiä; omistaja on Iina) kouluttaa myyjää${people ? ` (${people})` : ''} myymään Kalustovahtia. ` +
            `Sinä olet Eliaksen hiljainen apuopettaja JA oppilas: autat häntä kouluttamaan paremmin ja opit samalla hänen tavastaan myydä.\n`
          : `Palaveri on käynnissä. Käyttäjä (johtaja, yrittäjä) keskustelee${people ? ` osallistujien kanssa: ${people}` : ' työntekijänsä kanssa'}.\n`
      const sections =
        kind === 'koulutus'
          ? `VASTAUSEHDOTUS (vain jos myyjä kysyi juuri jotain vaikeaa, johon Elias ei vielä vastannut: 2–3 lausetta, jotka Elias voi sanoa)\n` +
            `SEURAAVAKSI (2–3 kohtaa: mitä Eliaksen kannattaa opettaa, kysyä tai harjoituttaa seuraavaksi — esim. roolipeli, vastaväiteharjoitus, tarkistuskysymys myyjälle)\n` +
            `HUOMIOT (1–3 kohtaa: mitä myyjä näyttää ymmärtävän ja mitä ei, väärinkäsitykset, Eliaksen tärkeät opetukset lainattuna)\n` +
            `OPIN (1 kohta: mitä sinä JARVIS opit juuri nyt Eliaksen tavasta myydä tai kouluttaa — periaate, sanamuoto tai syy)\n` +
            (doc ? `KÄSITTELEMÄTTÄ (korkeintaan 3 ASIAA, joita ei ole vielä käsitelty SISÄLLÖLLISESTI — Elias käyttää omia sanojaan, ei pelikirjan otsikoita; jos asia on selitetty eri sanoin, se on käsitelty. Jätä otsikko pois, jos kaikki olennainen on käyty)\n` : '')
          : `VASTAUSEHDOTUS (vain jos toinen osapuoli esitti vaikean tai suoran kysymyksen viime minuutin aikana: ` +
            `yhdellä rivillä kysymys lyhyesti, sitten 2–3 lausetta, jotka käyttäjä voi sanoa sellaisenaan, lainausmerkeissä)\n` +
            `SEURAAVAKSI (2–3 kohtaa: mitä sanoa tai kysyä juuri nyt, konkreettinen muotoilu)\n` +
            `HUOMIOT (1–3 kohtaa: sovitut asiat, avoimet kysymykset, riskit, tunnelma)\n` +
            (doc ? `KÄSITTELEMÄTTÄ (tavoitteen tai aineiston osat, joita ei ole vielä käyty läpi, korkeintaan 5 lyhyttä)\n` : '')
      const prompt =
        roleIntro +
        (topic ? `AIHE: ${topic}\n` : '') +
        (goal ? `KÄYTTÄJÄN TAVOITE TÄSSÄ PALAVERISSA: ${goal}\n` : '') +
        (notes ? `MUUT TIEDOT: ${notes}\n` : '') +
        (doc ? `\nTAUSTA-AINEISTO (liiketoimintasuunnitelma, myynnin pelikirja):\n${doc}\n` : '') +
        (learned ? `\nMITÄ OLET JO OPPINUT ELIAKSEN MYYNTITAVASTA (myyntioppi):\n${learned}\n` : '') +
        `\nLITTERAATTI (puhujia ei ole eroteltu; päättele asiayhteydestä, kuka puhuu; uusin lopussa):\n${transcriptText()}\n` +
        (lastTips ? `\nEDELLINEN ANALYYSI:\n${lastTips}\n` : '') +
        `\nOlet huippuluokan neuvonantaja käyttäjän korvassa. Lue tilanne tarkasti: mitä toinen osapuoli oikeasti kysyy tai haluaa, ` +
        `mikä on jännite, mitä käyttäjä on jättämässä sanomatta. Anna käyttäjälle näytölle, tässä järjestyksessä:\n` +
        sections +
        `\nELIAS SELITTÄÄ OMALLA TAVALLAAN: kertoen, perustellen ja esimerkein, ei luettelona. Seuraa HÄNEN rakennettaan ja tunnista asiat sisällöstä, älä otsikoista tai avainsanoista. Älä ehdota hänelle, että hän 'kävisi läpi' jotain, minkä hän on jo selittänyt omin sanoin — ehdota sen sijaan, miten varmistaa, että myyjä ymmärsi (tarkistuskysymys, harjoitus). Jos litteraatissa toistuu yksinäinen "Kiitos." tai muu irrallinen sana, se on puheentunnistuksen harha — ohita.\nAJATTELE KRIITTISESTI ennen kuin kirjoitat. Lähteesi tärkeysjärjestyksessä: (1) mitä Elias sanoo tässä keskustelussa, ` +
        `(2) Kalustovahdin aineisto, (3) aiemmin opittu myyntioppi, (4) yleinen myyntiosaaminen (konsultoiva myynti, SPIN, vastaväitteiden käsittely). ` +
        `Älä toista aineistoa sellaisenaan vaan sovella sitä juuri tähän hetkeen ja tähän myyjään. Jos lähteet ovat ristiriidassa tai jokin ` +
        `opetus vaikuttaa kyseenalaiselta, sano se HUOMIOISSA lyhyesti perustellen — ei mielistelyä. Merkitse oma arviosi sanalla "arvio:" ja ` +
        `pidä faktat (aineisto, litteraatti) erillään. Älä keksi lukuja, hintoja, asiakkaita tai lupauksia, joita aineistossa ei ole. ` +
        `Jos litteraatissa on epäselvä kohta (puheentunnistus), älä rakenna sen varaan.\n` +
        `Ole täsmällinen ja käytä aineiston faktoja. Älä toista edellistä analyysia, ellei se ole yhä tärkein asia. Ei tyhjiä otsikoita.`
      const text = await askModel(prompt)
      if (text) {
        lastTips = text
        analysedWords = total
        emitBlade({
          id: 'kokous-vinkit',
          title: 'KOKOUS',
          kind: 'markup',
          html: toHtml(text, stamp()),
          size: 'wide',
          hold: 'sticky',
        })
      }
    } catch (err) {
      if (isLimitError(err)) noteLimit(err)
      else log.warn('[jarvis] kokous: analyysi epäonnistui:', err?.message ?? err)
    } finally {
      busy = false
    }
  }

  /** Puheentunnistuksen harhat hiljaisuudessa ("Kiitos.", "Joo." yksinään) eivät kuulu litteraattiin. */
  const HALLUCINATION = /^(kiitos|joo|jau|yep|yop|yoh|ok|okei|mm+h?|yhe+h|he+|tjau|niin)[.!…\s]*$/i
  const slug = (t) => String(t || 'kokous').toLowerCase().replace(/[^a-z0-9äöå]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  function openTranscriptFile() {
    try {
      const dir = join(MEMORY_DIR, 'kokoukset')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Helsinki' }))
      const p = (n) => String(n).padStart(2, '0')
      transcriptFile = join(dir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}_${slug(topic)}.txt`)
      writeFileSync(transcriptFile, `# ${topic || 'Kokous'}\nTavoite: ${goal}\nOsallistujat: ${people}\nTyyppi: ${kind}\n${notes ? `Muuta: ${notes}\n` : ''}\n`)
    } catch (err) {
      log.warn('[jarvis] kokous: litteraattitiedostoa ei voitu luoda:', err?.message ?? err)
      transcriptFile = null
    }
  }
  /** Viimeisin tallennettu litteraatti (tiedosto), uusin ensin. */
  function latestTranscriptFile() {
    try {
      const dir = join(MEMORY_DIR, 'kokoukset')
      if (!existsSync(dir)) return null
      const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => join(dir, f))
      files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      return files[0] ?? null
    } catch {
      return null
    }
  }
  const ROLES = 'Roolit: Yrittäjä Nimi omistaa KalustoVahti Oy:n ja päättää hinnat, ehdot ja tuotteet; Elias on ulkopuolinen auttaja (rakensi CRM:n, neuvoo myyntiä); Myyjä1, Myyjä2 ja Myyjä3 ovat myyjiä.'
  function lessonPrompt(text) {
    if (kind === 'muu') {
      // Team / weekly meeting: several people talk. Nothing anyone says becomes "Elias's principle" unless Elias says it himself.
      return (
        `Tiimipalaveri${topic ? ` (${topic})` : ''} päättyi${people ? `. Osallistujat: ${people}` : ''}. ${ROLES}\n` +
        (readSalesLearning() ? `\nAIEMMIN OPITTU (älä toista):\n${readSalesLearning().slice(-12_000)}\n` : '') +
        `\nLITTERAATTI (puheentunnistus, puhujaa ei ole merkitty; osa riveistä voi olla harhaa — älä rakenna epäselvän varaan):\n${text}\n\n` +
        `Poimi vain UUTTA ja vain sitä, mikä litteraatissa oikeasti sanottiin. Puhujaa ei tunnisteta automaattisesti: nimeä puhuja vain, jos se selviää ` +
        `puheesta itsestään (esim. "Iina, sinä hoidat…"), muuten kirjoita "joku sanoi" / "tiimi sopi". Älä koskaan kirjaa mitään Eliaksen periaatteeksi, ` +
        `ellei hän itse selvästi linjaa sitä. Hinta-, ehto- ja tuotepäätökset kuuluvat Iinalle: kirjaa ne "Iinan päätös" vain jos se selvästi sanottiin.\n` +
        `Kirjoita:\nPÄÄTÖKSET (mitä sovittiin ja kuka päätti, jos tiedossa)\nTEHTÄVÄT (kuka tekee mitä ja milloin, jos sanottiin)\n` +
        `MYYNTIHAVAINNOT (asiakkaista, vastaväitteistä, liideistä tai tavasta myydä, mitä tiimi kertoi; merkitse "(yksi tapaus)" jos se on yksittäinen)\n` +
        `JARVISIN AJATUKSET (2–3 kohtaa: mikä jäi auki, mitä kysyisit seuraavaksi; merkitse epävarmat "(epävarma)")\n` +
        `Jos jokin kohta jää tyhjäksi, jätä otsikko pois.`
      )
    }
    return (
      `${kind === 'koulutus' ? 'Myyntikoulutus' : 'Myyntitapaaminen'}${topic ? ` (${topic})` : ''} päättyi. ${ROLES}\n` +
      (readSalesLearning() ? `\nAIEMMIN OPITTU:\n${readSalesLearning()}\n` : '') +
      `\nLITTERAATTI (puheentunnistus; osa riveistä voi olla katkenneita tai harhaa — älä rakenna epäselvän varaan):\n${text}\n\n` +
      `Elias selittää asiat omalla tavallaan, kertoen ja perustellen — seuraa HÄNEN rakennettaan, älä pelikirjan otsikoita, äläkä merkitse käsittelemättömäksi mitään, minkä hän on sanonut omin sanoin.\n` +
      `Poimi vain UUTTA, mitä ei vielä ole aiemmin opitussa. Kirjoita:\n` +
      `ELIAKSEN PERIAATTEET (mitä hän opettaa tai tekee myynnissä: säännöt, sanamuodot, mitä välttää — lainaa hänen omia sanojaan, 3–8 kohtaa)\n` +
      `ESIMERKIT (konkreettiset tilanteet, skriptit, laskelmat tai tarinat, joita hän käytti, 1–4 kohtaa)\n` +
      `MYYJÄN KEHITYS (mitä koulutettava osaa jo ja mitä ei, 1–3 kohtaa nimellä, jos nimi tiedossa)\n` +
      `JARVISIN AJATUKSET (omat päätelmäsi: mikä toimi, miksi, mitä kokeilisit tai kysyisit ensi kerralla, mitä myyjä tarvitsee seuraavaksi; 2–4 kohtaa, rehellisesti ja omin sanoin. ` +
      `Ole kriittinen: erota Eliaksen periaate omasta päätelmästäsi; jos jokin opetus on ristiriidassa aineiston tai yleisen myyntiopin kanssa, kirjaa ristiriita ja kysymys, jonka esittäisit Eliakselle; merkitse epävarmat päätelmät "(epävarma)". Älä keksi mitään, mitä litteraatissa ei ole.)\n` +
      `Jos jokin kohta jää tyhjäksi, jätä otsikko pois.`
    )
  }

  async function summarise() {
    const doc = loadDoc()
    const prompt =
      `Palaveri${topic ? ` aiheesta "${topic}"` : ''} päättyi.${goal ? ` Käyttäjän tavoite oli: ${goal}.` : ''} ` +
      (doc ? `\nLIIKEIDEA / TAUSTA-AINEISTO:\n${doc}\n` : '') +
      `\nLITTERAATTI:\n${transcriptText() || '(ei puhetta tallessa)'}\n\n` +
      `Kirjoita:\nYHTEENVETO (3–5 kohtaa)\nTAVOITE (toteutuiko käyttäjän tavoite, miksi)\nPÄÄTÖKSET (sovitut asiat)\nTEHTÄVÄT (kuka tekee mitä, jos sanottiin)\nAVOIMET (mitä jäi auki)\nSEURAAVA ASKEL (mitä käyttäjän kannattaa tehdä seuraavaksi)` +
      (doc ? `\nLIIKEIDEA (mitkä osat käytiin läpi, mitkä jäivät käymättä)` : '') +
      (kind === 'asiakas'
        ? `\nCRM-KIRJAUS (valmis kopioitavaksi CRM:n tapaamiseen, vain litteraatissa sanottu, tuntematon = "?"):\n` +
          `- Tulos: kiinnostunut / tarjous pyydetty / harkitsee / ei kiinnostunut / muu\n- Autoja: \n- Kuka hoitaa autot nyt: \n- Kipu / tarve: \n` +
          `- Vastaväitteet: \n- Sovittu seuraava askel: \n- Seuraava yhteydenotto (pvm, jos sovittiin): \n- Muistiinpano (2–3 riviä): ` +
          `\nSEURANTAVIESTI (sähköpostiluonnos asiakkaalle Eliaksen nimissä, suomeksi, sinutellen, 4–7 lausetta: kiitos tapaamisesta, ` +
          `asiakkaan oma tilanne hänen sanoillaan, sovittu seuraava askel ja aika. Ei myyntipuhetta, ei hintaa jos siitä ei sovittu, ` +
          `ei mainintaa JARVISista tai tekoälystä. Jos litteraatista ei selviä sovittua seuraavaa askelta, ehdota yksi konkreettinen.)`
        : '')
    return askModel(prompt, { heavy: true })
  }

  return {
    isActive: () => active,
    start(ctx = {}) {
      if (active) {
        // Jo käynnissä (esim. "aloita" tuli toistamiseen puhelimesta ja
        // ikkunasta): päivitä vain tiedot, älä nollaa litteraattia.
        if (ctx.aihe) topic = String(ctx.aihe).trim()
        if (ctx.tavoite) goal = String(ctx.tavoite).trim()
        if (ctx.osallistujat) people = String(ctx.osallistujat).trim()
        if (ctx.muuta) notes = String(ctx.muuta).trim()
        return `Kokoustila on jo päällä (kuultu ${words()} sanaa), jatkan samaa kokousta.`
      }
      active = true
      topic = String(ctx.aihe ?? '').trim()
      goal = String(ctx.tavoite ?? '').trim()
      people = String(ctx.osallistujat ?? '').trim()
      notes = String(ctx.muuta ?? '').trim()
      kind = ['asiakas', 'koulutus', 'muu'].includes(ctx.tyyppi)
        ? ctx.tyyppi
        : /koulut|opet|harjoit/i.test(`${topic} ${goal}`)
          ? 'koulutus'
          : // 9.11.2026: an untyped weekly team meeting was treated as a customer meeting (CRM entry + follow-up e-mail "to the customer").
            /palaveri|viikko|tiimi|sisäinen|myyntikokous|katsaus|suunnittelu|kehityskeskustelu/i.test(`${topic} ${goal}`)
            ? 'muu'
            : 'asiakas'
      transcript = []
      analysedWords = 0
      lastTips = ''
      lastSummary = ''
      pausedUntil = 0
      limitNotified = false
      openTranscriptFile()
      if (timer) clearInterval(timer)
      timer = setInterval(() => void analyse(), kind === 'koulutus' ? TRAINING_EVERY_MS : ANALYSIS_EVERY_MS)
      timer.unref?.()
      emitBlade({
        id: 'kokous-vinkit',
        title: 'KOKOUS',
        kind: 'markup',
        html: `<div class="hud-note hud-hot">KOKOUSTILA</div><div class="hud-rows"><div class="hud-row"><span class="hud-main"><span class="hud-label">${kind === 'koulutus' ? `Koulutustila${topic ? `: ${esc(topic)}` : ''}. Kuuntelen ja opin tapasi myydä — en keskeytä. Väliyhteenveto 5 min välein, opit tallentuvat lopuksi.` : `Kuuntelen${topic ? `: ${esc(topic)}` : ''}. Vinkit päivittyvät tähän noin minuutin välein.`}</span></span></div></div>`,
        size: 'wide',
        hold: 'sticky',
      })
      const doc = loadDoc()
      return `Kokoustila päällä${doc ? `, tausta-aineistoa ladattu ${Math.round(doc.length / 1000)} kt` : ', tausta-aineistoa ei löytynyt (Documents/JARVIS/kokous_aineisto on tyhjä)'}.`
    },
    add(text) {
      if (!active) return
      const t = String(text ?? '').trim()
      if (!t || HALLUCINATION.test(t)) return
      transcript.push({ at: stamp(), text: t })
      if (transcriptFile) {
        try {
          appendFileSync(transcriptFile, `[${stamp()}] ${t}\n`)
        } catch {
          /* levy ei kriittinen */
        }
      }
      // Suora kysymys toiselta osapuolelta: analysoidaan nopeasti, ei odoteta 40 s.
      if (kind !== 'koulutus' && /\?\s*$|^(mitä|miten|miksi|milloin|kuka|paljonko|kuinka|onko|voitko|voisitko|oletko|entä)\b/i.test(t) && !quickTimer) {
        quickTimer = setTimeout(() => {
          quickTimer = null
          void analyse(true)
        }, QUICK_ANALYSIS_MS)
        quickTimer.unref?.()
      }
    },
    tips: () => lastTips || 'Vinkkejä ei ole vielä, keskustelua on kuultu liian vähän.',
    status: () => (active ? `Kokoustila päällä, kuultu ${words()} sanaa, vinkkejä päivitetty ${lastTips ? 'viimeksi ' + stamp() : 'ei vielä'}.` : 'Kokoustila ei ole päällä.'),
    async stop() {
      if (!active) return 'Kokoustila ei ollut päällä.'
      active = false
      if (timer) clearInterval(timer)
      timer = null
      if (quickTimer) clearTimeout(quickTimer)
      quickTimer = null
      let summary = ''
      let failed = false
      try {
        summary = await summarise()
      } catch (err) {
        failed = true
        summary = isLimitError(err)
          ? `Yhteenvetoa ei saatu: Claude-tilin käyttöraja on täynnä. Litteraatti (${words()} sanaa) on tallessa${transcriptFile ? ` tiedostossa ${transcriptFile}` : ''}. Sano rajan nollauduttua "analysoi viimeisin kokous", niin teen yhteenvedon ja opit jälkikäteen.`
          : `Yhteenveto epäonnistui: ${err?.message ?? err}. Litteraatti on tallessa${transcriptFile ? ` tiedostossa ${transcriptFile}` : ''}.`
      }
      lastSummary = summary
      emitBlade({ id: 'kokous-vinkit', title: 'KOKOUS – YHTEENVETO', kind: 'markup', html: toHtml(summary, stamp()), size: 'wide', hold: 'sticky' })
      // Oppiminen: mitä Elias opetti tai teki myynnissä, ja JARVISin omat ajatukset.
      // Tallennetaan myyntioppiin, jota JARVIS lukee jatkossa joka istunnon alussa.
      if (words() > 60 && !failed) {
        try {
          const lesson = await askModel(lessonPrompt(transcriptText()), { heavy: true })
          if (lesson) appendSalesLearning(lesson)
        } catch (err) {
          log.warn('[jarvis] kokous: oppien tallennus epäonnistui:', err?.message ?? err)
        }
      }
      try {
        await notifyPhone?.({ title: `Kokous${topic ? `: ${topic}` : ''} – yhteenveto`, body: summary.slice(0, 3500), priority: 'default', tags: 'memo' })
      } catch (err) {
        log.warn('[jarvis] kokous: yhteenveto ei mennyt puhelimeen:', err?.message ?? err)
      }
      // Tulosoppiminen: kokous talteen, jotta JARVIS voi myöhemmin verrata, mitkä tapaamiset johtivat kauppaan.
      try {
        if (!failed && words() > 60) await onEnd?.({ kind, topic, people, goal, summary, transcriptFile, words: words(), at: new Date().toISOString() })
      } catch (err) {
        log.warn('[jarvis] kokous: kokousmuistiin tallennus epäonnistui:', err?.message ?? err)
      }
      return summary
    },
    lastSummary: () => lastSummary,
    /** Jälkikäteinen analyysi viimeisimmästä tallennetusta litteraatista (esim. kun Claude-raja oli täynnä kokouksen aikana). */
    async analyseSaved() {
      const file = latestTranscriptFile()
      if (!file) return 'Tallennettuja litteraatteja ei löytynyt (Documents/JARVIS/muisti/kokoukset).'
      const raw = readFileSync(file, 'utf8')
      const head = raw.split('\n').slice(0, 5).join(' ')
      const savedTopic = (/^# (.+)$/m.exec(raw) ?? [])[1] ?? ''
      const savedKind = (/^Tyyppi: (\w+)/m.exec(raw) ?? [])[1] ?? ''
      const prevTopic = topic, prevKind = kind, prevGoal = goal
      topic = savedTopic || topic
      if (savedKind) kind = savedKind
      goal = (/^Tavoite: (.*)$/m.exec(raw) ?? [])[1] ?? goal
      const body = raw.split('\n').filter((l) => /^\[\d/.test(l)).join('\n')
      try {
        if (!body.trim()) return `Litteraatti ${file} on tyhjä.`
        const doc = loadDoc()
        const summary = await askModel(
          `Palaveri${topic ? ` aiheesta "${topic}"` : ''} on päättynyt; tämä on jälkikäteinen analyysi tallennetusta litteraatista.${goal ? ` Käyttäjän tavoite oli: ${goal}.` : ''} ` +
            (doc ? `\nTAUSTA-AINEISTO:\n${doc}\n` : '') +
            `\nLITTERAATTI (puhujia ei ole eroteltu):\n${body.slice(-60_000)}\n\n` +
            `Kirjoita: YHTEENVETO (3–6 kohtaa, mitä käytiin läpi Eliaksen omassa järjestyksessä), SOVITTU (mitä sovittiin), SEURAAVAT ASKELEET (kenelle mitä), HUOMIOT (arvio: mikä meni hyvin, mikä jäi epäselväksi). Ei tyhjiä otsikoita.`,
          { heavy: true },
        )
        let lessonNote = ''
        try {
          const lesson = await askModel(lessonPrompt(body.slice(-60_000)), { heavy: true })
          if (lesson) {
            appendSalesLearning(`(jälkikäteen litteraatista ${file.split(/[\\/]/).pop()})\n${lesson}`)
            lessonNote = ' Opit tallennettu myyntioppiin.'
          }
        } catch (err) {
          lessonNote = ` Oppien tallennus epäonnistui: ${err?.message ?? err}`
        }
        lastSummary = summary
        emitBlade({ id: 'kokous-vinkit', title: 'KOKOUS – YHTEENVETO', kind: 'markup', html: toHtml(summary, stamp()), size: 'wide', hold: 'sticky' })
        notifyPhone?.({ title: `Kokous${topic ? `: ${topic}` : ''} – jälkianalyysi`, body: summary.slice(0, 3500), tags: 'memo' }).catch(() => {})
        return `${summary}\n${lessonNote}`
      } finally {
        topic = prevTopic
        kind = prevKind
        goal = prevGoal
      }
    },
  }
}

const ok = (text) => ({ content: [{ type: 'text', text }] })

export function meetingServer(meeting, setMeetingUi, { hasUi = () => true, notify = null } = {}) {
  return createSdkMcpServer({
    name: 'jarvis_kokous',
    version: '1.0.0',
    instructions: 'Kokoustila: kuuntele palaveria, anna vinkkejä näytölle, tee yhteenveto.',
    alwaysLoad: true,
    tools: [
      tool(
        'kokous',
        'Kokoustilan hallinta. aloita = ala kuunnella palaveria ja antaa vinkkejä näytölle; ' +
          'vinkki = palauta tuoreimmat vinkit (lue ne lyhyesti ääneen); tilanne = tila; ' +
          'lopeta = tee yhteenveto, lähetä se puhelimeen ja lopeta kuuntelu; ' +
          'analysoi = tee yhteenveto ja opit jälkikäteen viimeisimmästä tallennetusta litteraatista ("analysoi viimeisin kokous", esim. kun Claude-raja oli täynnä kokouksen aikana).',
        {
          toiminto: z.enum(['aloita', 'vinkki', 'tilanne', 'lopeta', 'ajasta', 'analysoi']),
          aika: z.string().optional().describe('ajasta: kellonaika HH:MM Suomen aikaa'),
          aihe: z.string().optional().describe('Mistä palaverissa on kyse, esim. "Kalustovahdin myyntistrategia"'),
          tavoite: z.string().optional().describe('Mitä käyttäjä haluaa saada palaverista irti, esim. "sopia Matin rooli ja aikataulu"'),
          osallistujat: z.string().optional().describe('Ketkä osallistuvat ja missä roolissa, esim. "Matti, myyjä"'),
          muuta: z.string().optional().describe('Muut taustatiedot, esim. aiemmat sopimukset, herkät aiheet'),
          tyyppi: z.enum(['asiakas', 'koulutus', 'muu']).optional().describe('asiakas = myyntitapaaminen, koulutus = käyttäjä kouluttaa myyjää, muu'),
        },
        async (args) => {
          switch (args.toiminto) {
            case 'aloita': {
              if (!args.aihe || !args.tavoite) {
                return ok(
                  'Ennen aloitusta tarvitaan konteksti. Kysy käyttäjältä LYHYESTI (yksi lause, korkeintaan kaksi kysymystä): ' +
                    'mistä palaverissa on kyse ja mitä hän haluaa saada siitä irti; kysy myös kuka on mukana, jos ei tiedossa. ' +
                    'Kutsu sitten kokous(aloita) uudelleen täytetyillä kentillä aihe, tavoite ja osallistujat.',
                )
              }
              const desc = [args.aihe, args.tavoite ? `Tavoite: ${args.tavoite}` : '', args.osallistujat ? `Osallistujat: ${args.osallistujat}` : '', args.tyyppi ? `Tyyppi: ${args.tyyppi}` : '']
                .filter(Boolean)
                .join('. ')
              if (!hasUi()) {
                // Komento tuli puhelimesta eikä käyttöliittymää ole auki: avataan
                // ikkuna, joka käynnistää kokoustilan itse (?kokous=...&auto=1).
                const opened = openMeetingWindow(desc)
                return ok(
                  opened
                    ? 'JARVISin vinkki-ikkuna avataan koneen oikeaan alakulmaan ja kokoustila käynnistyy siinä itsestään. Kerro käyttäjälle: paina ikkunan painiketta "Jaa puhelun ääni" ja valitse Koko näyttö + Jaa järjestelmän ääni, jotta JARVIS kuulee myös toisen osapuolen.'
                    : 'Ikkunan avaus epäonnistui. Pyydä käyttäjää avaamaan kokous.bat koneella.',
                )
              }
              const msg = meeting.start(args)
              setMeetingUi(true)
              return ok(`${msg} Sano käyttäjälle yhdellä lauseella, että kuuntelet ja ehdotukset tulevat näytölle; sitten hiljene.`)
            }
            case 'ajasta': {
              if (!args.aika) return ok('Kysy kellonaika (HH:MM).')
              const desc = [args.aihe, args.tavoite ? `Tavoite: ${args.tavoite}` : '', args.osallistujat ? `Osallistujat: ${args.osallistujat}` : '', args.tyyppi ? `Tyyppi: ${args.tyyppi}` : '']
                .filter(Boolean)
                .join('. ')
              return ok(scheduleMeeting(args.aika, desc || 'Tapaaminen', notify))
            }
            case 'vinkki':
              return ok(meeting.tips())
            case 'tilanne':
              return ok(meeting.status())
            case 'analysoi': {
              const out = await meeting.analyseSaved()
              return ok(`Jälkianalyysi valmis (näytöllä ja puhelimessa). Kerro ääneen vain 2–3 tärkeintä kohtaa:\n${out}`)
            }
            case 'lopeta': {
              setMeetingUi(false)
              const summary = await meeting.stop()
              return ok(`Yhteenveto on näytöllä ja puhelimessa. Kerro ääneen vain 1–2 tärkeintä kohtaa:\n${summary}`)
            }
          }
          return ok('Tuntematon toiminto.')
        },
      ),
    ],
  })
}
