/**
 * Microsoft Teams -tapaamiset.
 *
 * Kaksi tapaa:
 *
 *  A) SELAIN (oletus) — käyttäjän henkilökohtainen / ilmainen Teams
 *     (teams.live.com). Henkilökohtaisille Microsoft-tileille Graph-rajapinta
 *     ei luo Teams-kokouksia, joten JARVIS tekee sen Teamsin verkkoversiossa
 *     käyttäjän omassa Chromessa playwright-työkaluilla. `teams_tapaaminen`
 *     laskee ajat valmiiksi ja palauttaa mallille tarkan askelreseptin, jonka
 *     se suorittaa selaimessa. Kirjautumista ei tarvita: Chrome on jo
 *     kirjautunut käyttäjän tiliin. JARVIS ei koskaan kirjoita salasanoja.
 *
 *  B) GRAPH — työ-/koulutili (Microsoft 365). Käytössä vain, kun
 *     JARVIS_TEAMS_GRAPH=1 ja ~/.jarvis/msgraph_client.txt sisältää OMAN
 *     sovellusrekisteröinnin id:n (Entra: "any organization + personal",
 *     public client flows = Yes). Device code -kirjautuminen tallentaa
 *     tokenin ~/.jarvis/msgraph_token.json (turvakerros estää sen lukemisen).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { preApprove } from './turva.mjs'

const DIR = join(homedir(), '.jarvis')
const CLIENT_FILE = join(DIR, 'msgraph_client.txt')
const TOKEN_FILE = join(DIR, 'msgraph_token.json')
const TENANT = 'common'
const SCOPES = 'offline_access openid profile User.Read Calendars.ReadWrite OnlineMeetings.ReadWrite'
const GRAPH = 'https://graph.microsoft.com/v1.0'
export const TEAMS_WEB = 'https://teams.live.com/v2/'
/** Ilmaisen Teamsin kokouksen enimmäiskesto. */
const FREE_MAX_MIN = 60

/** Microsoftin omia sovellus-id:itä, jotka on helppo kopioida vahingossa portaalista. */
const NOT_YOUR_APP = new Set([
  '74658136-14ec-4630-ad9b-26e160ff0fc6', // ADIbizaUX (Entra-portaali)
  'c44b4083-3bb0-49c1-b47d-974e53cbdf3c', // Azure Portal
  '1950a258-227b-4e31-a9cf-717495945fc2', // Azure PowerShell
  '04b07795-8ddb-461a-bbee-02f9e1bf7b46', // Azure CLI
  '14d82eec-204b-4c2f-b7e8-296a70dab67e', // Graph PowerShell
  'de8bc8b5-d9f9-48b1-a8ad-b748da725064', // Graph Explorer
])

const clientId = () => {
  try {
    const id = existsSync(CLIENT_FILE) ? readFileSync(CLIENT_FILE, 'utf8').split(/\r?\n/)[0].trim() : ''
    return NOT_YOUR_APP.has(id.toLowerCase()) ? '' : id
  } catch {
    return ''
  }
}
const loadToken = () => {
  try {
    return existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) : null
  } catch {
    return null
  }
}
const saveToken = (t) => {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
  writeFileSync(TOKEN_FILE, JSON.stringify({ ...t, saved_at: Date.now() }))
}

export const teamsGraphEnabled = () => process.env.JARVIS_TEAMS_GRAPH === '1' && Boolean(clientId())
export const teamsConfigured = () => true
export const teamsSignedIn = () => Boolean(loadToken()?.refresh_token)
/** Lyhyt tila käynnistyslokiin. */
export const teamsStatus = () =>
  teamsGraphEnabled()
    ? teamsSignedIn()
      ? 'Graph (työtili, kirjauduttu)'
      : 'Graph (työtili) — kirjautuminen puuttuu: "kirjaudu Microsoftiin"'
    : 'selain (teams.live.com käyttäjän Chromessa)'

let pendingDevice = null

async function tokenRequest(params) {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), ...params }),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, data }
}

/** Aloittaa device code -kirjautumisen ja pollaa taustalla tokenia (vain Graph-tila). */
export async function startDeviceLogin() {
  if (!clientId()) return 'Microsoft-sovelluksen id puuttuu tai se on Microsoftin oma portaalisovellus: aja asenna_teams.bat koneella ensin.'
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), scope: SCOPES }),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok || !d.device_code) return `Kirjautumisen aloitus epäonnistui: ${d.error_description ?? res.status}`
  pendingDevice = { code: d.user_code, url: d.verification_uri, until: Date.now() + d.expires_in * 1000 }
  ;(async () => {
    const interval = Math.max(5, Number(d.interval) || 5) * 1000
    while (Date.now() < pendingDevice.until) {
      await new Promise((r) => setTimeout(r, interval))
      const { ok, data } = await tokenRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code })
      if (ok && data.access_token) {
        saveToken(data)
        pendingDevice = null
        console.log('[jarvis] teams: Microsoft-kirjautuminen onnistui')
        return
      }
      if (data.error && data.error !== 'authorization_pending' && data.error !== 'slow_down') {
        console.warn('[jarvis] teams: kirjautuminen keskeytyi:', data.error)
        pendingDevice = null
        return
      }
    }
  })()
  return `Avaa ${d.verification_uri} ja syötä koodi ${d.user_code}. Kirjaudu Microsoft-tilillä, jota käytät Teamsissa. Koodi on voimassa ${Math.round(d.expires_in / 60)} minuuttia.`
}

async function accessToken() {
  const t = loadToken()
  if (!t?.refresh_token) throw new Error('Microsoft-tiliä ei ole kirjattu sisään. Sano "kirjaudu Microsoftiin".')
  const fresh = t.saved_at && Date.now() - t.saved_at < (Number(t.expires_in) - 120) * 1000
  if (fresh && t.access_token) return t.access_token
  const { ok, data } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, scope: SCOPES })
  if (!ok || !data.access_token) throw new Error(`Microsoft-kirjautuminen vanheni (${data.error_description ?? 'tuntematon'}). Sano "kirjaudu Microsoftiin".`)
  saveToken({ ...t, ...data })
  return data.access_token
}

async function graph(method, path, body) {
  const token = await accessToken()
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Graph ${method} ${path}: ${data?.error?.message ?? res.status}`)
  return data
}

const p2 = (n) => String(n).padStart(2, '0')
const nowHelsinki = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Helsinki' }))
const isoLocal = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00`
const WEEKDAYS = ['sunnuntaina', 'maanantaina', 'tiistaina', 'keskiviikkona', 'torstaina', 'perjantaina', 'lauantaina']

/**
 * Tulkitsee "2026-10-29T10:00", "huomenna 10:00", "29.10. klo 14:30", "heti",
 * "5 minuutin päästä" ym. Palauttaa { date: Date (Suomen aikaa), immediate }.
 */
export function parseWhen(text) {
  const t = String(text ?? '').trim()
  const now = nowHelsinki()
  const low = t.toLowerCase()
  if (!t || /^(heti|nyt|välittömästi|now|asap)\b/.test(low)) {
    const d = new Date(now.getTime() + 3 * 60_000)
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0)
    return { date: d, immediate: true }
  }
  const rel = low.match(/(\d{1,2})\s*(min|minuut)/)
  if (rel && /päästä|kuluttua|in\b/.test(low)) {
    const d = new Date(now.getTime() + Number(rel[1]) * 60_000)
    d.setSeconds(0, 0)
    return { date: d, immediate: Number(rel[1]) <= 10 }
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return { date: new Date(t.slice(0, 16) + ':00'), immediate: false }
  const d = new Date(now)
  if (/ylihuomenna/.test(low)) d.setDate(d.getDate() + 2)
  else if (/huomenna/.test(low)) d.setDate(d.getDate() + 1)
  const dm = low.match(/(\d{1,2})\.(\d{1,2})\.?(\d{4})?/)
  if (dm) {
    d.setMonth(Number(dm[2]) - 1, Number(dm[1]))
    if (dm[3]) d.setFullYear(Number(dm[3]))
  }
  const hm = low.match(/(?:klo\s*)?(\d{1,2})[.:](\d{2})/) ?? low.match(/klo\s*(\d{1,2})/)
  if (!hm) return null
  d.setHours(Number(hm[1]), Number(hm[2] ?? 0), 0, 0)
  if (d <= now && !dm && !/huomenna/.test(low)) d.setDate(d.getDate() + 1)
  return { date: d, immediate: false }
}

const fiDate = (d) => `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`
const fiTime = (d) => `${p2(d.getHours())}.${p2(d.getMinutes())}`
const spoken = (d) => `${WEEKDAYS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}. klo ${d.getHours()}.${p2(d.getMinutes())}`

/** Graph-polku (työtili). */
export async function createTeamsMeeting({ subject, when, minutes = 60, attendees = [], note = '' }) {
  const w = parseWhen(when)
  if (!w) throw new Error('En saanut ajasta selvää. Anna esim. "huomenna klo 10" tai "29.10. klo 14:30".')
  const start = w.date
  const end = new Date(start.getTime() + Math.max(15, Number(minutes) || 60) * 60_000)
  const emails = attendees.map((a) => String(a).trim()).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))

  const meeting = await graph('POST', '/me/onlineMeetings', {
    subject,
    startDateTime: new Date(start.getTime() - start.getTimezoneOffset() * 60_000).toISOString(),
    endDateTime: new Date(end.getTime() - end.getTimezoneOffset() * 60_000).toISOString(),
  })
  const joinUrl = meeting.joinWebUrl ?? meeting.joinUrl
  const event = await graph('POST', '/me/events', {
    subject,
    body: {
      contentType: 'HTML',
      content: `${note ? `<p>${note.replace(/</g, '&lt;')}</p>` : ''}<p>Liity Teams-kokoukseen: <a href="${joinUrl}">${joinUrl}</a></p>`,
    },
    start: { dateTime: isoLocal(start), timeZone: 'FLE Standard Time' },
    end: { dateTime: isoLocal(end), timeZone: 'FLE Standard Time' },
    location: { displayName: 'Microsoft Teams' },
    attendees: emails.map((address) => ({ emailAddress: { address }, type: 'required' })),
    isOnlineMeeting: false,
  })
  return { joinUrl, start: isoLocal(start), end: isoLocal(end), attendees: emails, eventId: event.id }
}

/**
 * Selainpolku: laskee kentät ja rakentaa askelreseptin, jonka malli suorittaa
 * playwright-työkaluilla käyttäjän Chromessa (Teamsin verkkoversio, suomeksi;
 * englanninkieliset nimet suluissa varalta).
 */
export function webRecipe({ subject, when, minutes, attendees = [], note = '' }) {
  const w = parseWhen(when)
  if (!w) return { error: 'En saanut ajasta selvää. Anna esim. "huomenna klo 10", "29.10. klo 14:30" tai "heti".' }
  const start = w.date
  const wanted = Math.max(15, Number(minutes) || 60)
  const dur = Math.min(FREE_MAX_MIN, wanted)
  const end = new Date(start.getTime() + dur * 60_000)
  const emails = attendees.map((a) => String(a).trim().toLowerCase()).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))
  const bad = attendees.filter((a) => !emails.includes(String(a).trim().toLowerCase()))
  const title = String(subject).trim().slice(0, 120)

  const common1 = `1. browser_navigate "${TEAMS_WEB}". Ota browser_snapshot (ÄLÄ käytä browser_take_screenshot-työkalua tässä tehtävässä). Jos näkyy tervetulosivu painikkeella "Jatka" (Continue), klikkaa sitä. Jos näkyy kirjautumislomake (sähköposti/salasana), LOPETA ja kerro käyttäjälle: "Kirjaudu Teamsiin Chromessa, niin jatkan." Älä koskaan kirjoita salasanaa. Jos avoinna on vanha "Uusi kokous" -lomake, klikkaa "Sulje" ja sitten "Hylkää".`
  const common2 = `2. Klikkaa vasemman palkin painiketta "Kalenteri" (Calendar). Odota, että kalenteri näkyy (browser_snapshot).`
  const linkStep = (n) =>
    `${n}. Lähetä linkki heti käyttäjän puhelimeen: ilmoita_puhelimeen("Teams-linkki${emails.length ? ` (${emails.join(', ')})` : ''}: <linkki sanatarkasti>"). HUOM: ilmainen Teams ei lähetä sähköpostikutsua luotettavasti (gmail-pohjainen Microsoft-tili) — osallistuja saa ilmoituksen vain, jos hänellä on Teams-tili. Siksi linkki menee aina käyttäjälle, joka välittää sen WhatsAppilla tai tekstiviestillä.`
  const meetNow = [
    common1,
    common2,
    `3. Klikkaa painiketta "Pikakokous" (Meet now). Avautuu pieni ruutu "Aloita kokous nyt", jossa on tekstikenttä "Kokouksen nimi".`,
    `4. Klikkaa kenttää "Kokouksen nimi", valitse kaikki (browser_press_key "Control+a") ja kirjoita ${JSON.stringify(title)}.`,
    `5. Klikkaa painiketta "Hanki linkki jakamista varten" (Get a link to share). Ota browser_snapshot: ruudussa on nyt tekstikenttä "Kokouksen linkki", jonka arvo on muotoa https://teams.live.com/meet/…?p=… — lue koko arvo TÄSMÄLLEEN snapshotista.`,
    linkStep(6),
    `7. Klikkaa painiketta "Aloita kokous" (Start meeting). Jätä välilehti auki — käyttäjä jatkaa siitä (kamera/mikki, Liity nyt).`,
    `8. Käynnistä kokoustila: kokous(aloita, aihe=${JSON.stringify(title)}, osallistujat=${JSON.stringify(emails.join(', '))}, tyyppi sen mukaan mitä käyttäjä kertoi) — kysy tavoite vain, jos käyttäjä ei sanonut sitä.`,
  ]
  const scheduled = [
    common1,
    common2,
    `3. Klikkaa painiketta "Uusi kokous" (New meeting). Ota browser_snapshot: lomakkeessa on tekstikenttä "Lisää otsikko", yhdistelmäruutu "Lisää pakollisia osallistujia", kentät "Alkamispäivämäärä", "Aloitusaika", "Päättymispäivämäärä", "Päättymisaika" ja painike "Tallenna".`,
    `4. Kirjoita otsikkokenttään "Lisää otsikko" (Add title) teksti: ${JSON.stringify(title)}.`,
    emails.length
      ? `5. Osallistujat: klikkaa kenttää "Lisää pakollisia osallistujia" (Add required attendees) ja kirjoita YKSI osoite kerrallaan browser_type-työkalulla submit=true (Enter lisää osoitteen): ${emails.map((e) => JSON.stringify(e)).join(', ')}. Jos ehdotuslistassa näkyy henkilö, klikkaa sitä. Jos lukee "Vastaavuuksia ei löytynyt", tyhjennä kenttä ja jatka ilman osallistujaa (linkki lähetetään käyttäjälle joka tapauksessa).`
      : `5. Osallistujia ei annettu: ohita osallistujakenttä.`,
    `6. Aika (PAKOLLINEN askel): klikkaa kenttää "Alkamispäivämäärä" (Start date), valitse kaikki (browser_press_key "Control+a") ja kirjoita ${JSON.stringify(fiDate(start))} + Enter. Klikkaa "Aloitusaika" (Start time), Control+a, kirjoita ${JSON.stringify(fiTime(start))} + Enter. Sama "Päättymispäivämäärä": ${JSON.stringify(fiDate(end))} ja "Päättymisaika": ${JSON.stringify(fiTime(end))}. Ota snapshot ja tarkista arvot (jos aikakenttä avasi listan, valitse listasta lähin oikea aika).`,
    note ? `7. Klikkaa kuvauskenttää "Kirjoita uuden kokouksen tiedot" (Type details) ja kirjoita: ${JSON.stringify(String(note).slice(0, 800))}.` : `7. Kuvaus: ohita.`,
    `8. Klikkaa painiketta "Tallenna" (Save); jos sen jälkeen näkyy "Lähetä" (Send), klikkaa sitä kerran. Ota browser_snapshot. ONNISTUI, jos lomake sulkeutui ja kokous ${JSON.stringify(title)} näkyy kalenterissa ${fiDate(start)} klo ${fiTime(start)}. Jos lomake on yhä auki tai kalenterissa lukee "Synkronointi ei onnistu", Teamsin kalenteri on rikki: klikkaa "Sulje" → "Hylkää" ja tee sen sijaan PIKAKOKOUS: "Pikakokous" → nimi ${JSON.stringify(title)} → "Hanki linkki jakamista varten" → lue linkki "Kokouksen linkki" -kentästä. Kerro käyttäjälle, että kalenterimerkintä ei onnistunut mutta linkki toimii.`,
    `8b. LIITTYMISLINKKI (pakollinen): klikkaa kalenterissa kokousta ${JSON.stringify(title)}. Avautuvassa tietoruudussa on linkki muotoa https://teams.live.com/meet/…?p=… — lue se browser_snapshotista TÄSMÄLLEEN.`,
    linkStep('9'),
    `10. Ajasta kokoustila: kokous(ajasta, aika="${isoLocal(start)}", aihe=${JSON.stringify(title)}, osallistujat=${JSON.stringify(emails.join(', '))}) ja kerro käyttäjälle lyhyesti: kokous ${spoken(start)}, linkki lähetetty puhelimeen.`,
  ]
  const steps = w.immediate ? meetNow : scheduled
  const notes = []
  if (wanted > FREE_MAX_MIN) notes.push(`Ilmainen Teams sallii enintään ${FREE_MAX_MIN} min kokouksen: kesto lyhennetty ${dur} minuuttiin.`)
  if (bad.length) notes.push(`Nämä eivät ole kelvollisia sähköposteja, kysy käyttäjältä: ${bad.join(', ')}.`)
  if (!emails.length) notes.push('Yhtään osallistujaa ei annettu — kysy sähköposti, jos käyttäjä halusi kutsua jonkun.')
  return { steps, notes, start, end, emails, title, immediate: w.immediate }
}

const ok = (text) => ({ content: [{ type: 'text', text }] })

export function teamsServer({ onMeetingCreated } = {}) {
  return createSdkMcpServer({
    name: 'jarvis_teams',
    version: '2.0.0',
    instructions: 'Microsoft Teams: tapaamisten luonti kutsuineen (selain tai Graph).',
    alwaysLoad: true,
    tools: [
      tool(
        'microsoft_kirjaudu',
        'Kirjaa JARVIS käyttäjän Microsoft-työtiliin device code -koodilla (vain Graph-tila, JARVIS_TEAMS_GRAPH=1). Henkilökohtaisella Teamsilla tätä ei tarvita.',
        {},
        async () => {
          if (!teamsGraphEnabled()) return ok('Graph-tila ei ole käytössä. Teams-kutsut tehdään suoraan Teamsin verkkoversiossa käyttäjän Chromessa (teams_tapaaminen) — kirjautumista ei tarvita.')
          if (teamsSignedIn()) return ok('Microsoft-tili on jo kirjattu sisään.')
          if (pendingDevice && Date.now() < pendingDevice.until) return ok(`Kirjautuminen on kesken: avaa ${pendingDevice.url} ja syötä koodi ${pendingDevice.code}.`)
          return ok(await startDeviceLogin())
        },
      ),
      tool(
        'teams_tapaaminen',
        'Luo Teams-tapaaminen ja lähetä kutsut sähköpostiin. Käytä, kun käyttäjä pyytää ajastamaan, luomaan tai lähettämään Teams-kutsun tai aloittamaan Teams-kokouksen jonkun kanssa. ' +
          'Oletustilassa työkalu palauttaa TARKAN askelreseptin, joka suoritetaan heti playwright-työkaluilla käyttäjän Chromessa; noudata sitä kohta kohdalta.',
        {
          aihe: z.string().min(2).max(120),
          aika: z.string().describe('Alkamisaika Suomen aikaa: "heti", "huomenna klo 10", "29.10. klo 14:30", "2026-10-29T10:00"'),
          kesto_min: z.number().optional().describe('Kesto minuutteina, oletus 60 (ilmainen Teams: enintään 60)'),
          osallistujat: z.array(z.string()).optional().describe('Sähköpostiosoitteet'),
          viesti: z.string().max(1000).optional().describe('Kutsun saateteksti'),
        },
        async (args) => {
          if (teamsGraphEnabled()) {
            if (!teamsSignedIn()) return ok('Microsoft-tiliä ei ole kirjattu sisään. Kutsu ensin microsoft_kirjaudu.')
            try {
              const m = await createTeamsMeeting({ subject: args.aihe, when: args.aika, minutes: args.kesto_min, attendees: args.osallistujat ?? [], note: args.viesti ?? '' })
              onMeetingCreated?.(m)
              return ok(
                `Teams-tapaaminen luotu: ${args.aihe}, ${m.start.replace('T', ' klo ').slice(0, 16)}–${m.end.slice(11, 16)}. ` +
                  `Kutsu lähetetty: ${m.attendees.join(', ') || 'ei osallistujia'}. Linkki: ${m.joinUrl}`,
              )
            } catch (err) {
              return ok(`Tapaamisen luonti epäonnistui: ${err?.message ?? err}`)
            }
          }
          const r = webRecipe({ subject: args.aihe, when: args.aika, minutes: args.kesto_min, attendees: args.osallistujat ?? [], note: args.viesti ?? '' })
          if (r.error) return ok(r.error)
          // Käyttäjä pyysi kutsun itse: Tallenna/Lähetä-painike sallitaan ilman erillistä vahvistusta.
          preApprove(/(?<!\p{L})(lähetä|send|tallenna|save|liity|join)(?!\p{L})/iu, { ttlMs: 15 * 60_000, uses: 4, label: 'teams-kutsu' })
          onMeetingCreated?.({ start: isoLocal(r.start), end: isoLocal(r.end), attendees: r.emails, subject: r.title, web: true })
          return ok(
            [
              `TEAMS-KUTSU SELAIMESSA — suorita nämä askeleet heti playwright-työkaluilla (käyttäjän Chrome, Teamsin verkkoversio). Sano käyttäjälle ensin yhdellä lauseella: "Luon kutsun: ${r.title}, ${spoken(r.start)}${r.emails.length ? `, ${r.emails.join(' ja ')}` : ''}." ja aloita sitten heti.`,
              ...r.steps,
              ...(r.notes.length ? ['HUOMIOT: ' + r.notes.join(' ')] : []),
              'Vastauksessasi käyttäjälle kerro: kutsu luotu, kenelle, milloin, JA liittymislinkki sanatarkasti (Telegramissa se on klikattava). Jos jokin askel epäonnistuu kahdesti, lopeta ja kerro käyttäjälle lyhyesti, mikä jäi kesken (esim. "Chrome ei ole auki" tai "Teams ei ole kirjautunut"). Onnistuminen = liittymislinkki luettu sivulta ja lähetetty käyttäjän puhelimeen; älä väitä muuta.',
            ].join('\n'),
          )
        },
      ),
    ],
  })
}
