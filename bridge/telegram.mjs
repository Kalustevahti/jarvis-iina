/**
 * Telegram-kanava: JARVIS <-> käyttäjä yhtenä chattina.
 *
 * Asetukset ~/.jarvis/telegram.txt:
 *   rivi 1: botin token (BotFatherilta)
 *   rivi 2: käyttäjän chat id (asenna_telegram.bat täyttää automaattisesti)
 *
 * Turva:
 *   - Vain rivillä 2 oleva chat id saa komentaa. Muiden viestit ohitetaan ja
 *     kirjataan lokiin. Rivin 3 KalustoVahti-ryhmässä botti on vain neuvoja (neuvoja.mjs: luku + neuvot, ei komentoja).
 *   - Komennot ajetaan samassa puhelinsessiossa ja samalla turvakerroksella
 *     kuin ntfy-komennot ("vahvista", "lukitse" toimivat).
 *   - Token ei koskaan päädy lokiin.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { localSttAvailable, transcribeLocally } from './whisper.mjs'
// Ryhmän pysyvä keskustelumuisti (5.11.): jokainen ryhmän viesti ja JARVISin oma lähetys viesti-id:llä.
import { recordGroup } from './ryhma.mjs'

const CONFIG = join(homedir(), '.jarvis', 'telegram.txt')

function readConfig() {
  try {
    if (!existsSync(CONFIG)) return null
    const lines = readFileSync(CONFIG, 'utf8').split(/\r?\n/).map((l) => l.trim())
    const token = lines[0] ?? ''
    const chatId = lines[1] ?? ''
    const crmChatId = lines[2] ?? ''
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return null
    // rivi 3: KalustoVahti-ryhmän chat id (CRM-, liidi- ja myynti-ilmoitukset sinne; komennot vain yksityischatista).
    return { token, chatId: /^-?\d+$/.test(chatId) ? chatId : '', crmChatId: /^-?\d+$/.test(crmChatId) ? crmChatId : '' }
  } catch {
    return null
  }
}

export const telegramAvailable = () => Boolean(readConfig()?.chatId)
export const crmGroupConfigured = () => Boolean(readConfig()?.crmChatId)

/** Lataa Telegramin tiedoston (ääniviesti) puskuriksi. Max 20 MB (Bot API:n raja). */
async function fetchFile(token, fileId) {
  const f = await api(token, 'getFile', { file_id: fileId })
  if (!f?.file_path) return null
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`)
  if (!res.ok) return null
  return Buffer.from(await res.arrayBuffer())
}

/** Lataa Telegramin kuvan (suurin koko) base64:na mallille. Max ~4 MB. */
async function fetchPhoto(token, photos) {
  const best = [...(photos ?? [])].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]
  if (!best || (best.file_size ?? 0) > 4_000_000) return null
  const f = await api(token, 'getFile', { file_id: best.file_id })
  if (!f?.file_path) return null
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`)
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  const mime = /\.png$/i.test(f.file_path) ? 'image/png' : /\.webp$/i.test(f.file_path) ? 'image/webp' : 'image/jpeg'
  return { data: buf.toString('base64'), mime }
}

async function api(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method}: ${data.description ?? res.status}`)
  }
  return data.result
}

/** JARVISin oma viesti ryhmään → ryhmän muistiin (viesti-id, jotta vastausketjut löytyvät). Ei koskaan heitä. */
function noteGroupSend(sent, text) {
  try {
    recordGroup({ at: Date.now(), who: 'JARVIS', bot: true, id: sent?.message_id, text })
  } catch {
    /* ok */
  }
}

/**
 * Claude usage limit in an error ("You've hit your 5-hour limit · resets 1:20pm (Europe/Helsinki)") →
 * milliseconds until the reset, or null when the error is something else. Exported for tests.
 * 9.11.2026: Iina's group questions failed 12.00–13.20 with a generic "kokeile hetken päästä" and were never answered.
 */
export function limitResetMs(message, now = new Date()) {
  const m = String(message ?? '').match(/hit your [^·]{0,40}limit[^·]{0,20}·\s*resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!m) return null
  let h = Number(m[1])
  if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0)
  const t = new Date(now)
  t.setHours(h, Number(m[2] ?? 0), 0, 0)
  if (t <= now) t.setDate(t.getDate() + 1)
  return t.getTime() - now.getTime()
}

/**
 * Splits a long message at paragraph, then line, then sentence boundaries (never mid-word), max `max` chars per part.
 * 9.11.2026: the 3900-char hard cut split lead lists mid-sentence across three group messages. Exported for tests.
 */
export function splitForTelegram(text, max = 3900) {
  const out = []
  let rest = String(text ?? '')
  while (rest.length > max) {
    const win = rest.slice(0, max)
    let cut = win.lastIndexOf('\n\n')
    if (cut < max * 0.4) cut = win.lastIndexOf('\n')
    if (cut < max * 0.4) cut = Math.max(win.lastIndexOf('. '), win.lastIndexOf(' '))
    if (cut < max * 0.4) cut = max
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest.trim()) out.push(rest)
  return out
}

/** Lähettää viestin käyttäjälle. Pitkät viestit pilkotaan rivien kohdalta. */
export async function sendTelegram(text, { title, kanava } = {}) {
  const cfg = readConfig()
  if (!cfg?.chatId) throw new Error('Telegram ei ole käytössä')
  // kanava 'crm' → KalustoVahti-ryhmä, jos se on asetettu; muuten Eliaksen yksityischat.
  const chat = kanava === 'crm' && cfg.crmChatId ? cfg.crmChatId : cfg.chatId
  // Blank line after the title: the title is the headline people scan in the group.
  const full = title ? `${title}\n\n${String(text ?? '').replace(/^\n+/, '')}` : String(text ?? '')
  for (const part of splitForTelegram(full)) {
    const body = { chat_id: chat, text: part, disable_web_page_preview: true }
    // Verkkokatkos (fetch failed) ei saa hukata vastausta: yritetään uudelleen 2 min ajan.
    let lastErr
    for (const wait of [0, 3000, 10_000, 30_000, 75_000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait))
      try {
        const sent = await api(cfg.token, 'sendMessage', body)
        if (chat === cfg.crmChatId && cfg.crmChatId) noteGroupSend(sent, body.text)
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        if (/Telegram sendMessage: (Bad Request|Forbidden|Unauthorized)/.test(String(err?.message))) break // ei korjaannu yrittämällä
      }
    }
    if (lastErr) throw lastErr
  }
}

/** Lähettää kuvan (esim. kuvakaappaus) käyttäjän omaan chattiin. */
export async function sendTelegramPhoto(buffer, { caption = '' } = {}) {
  const cfg = readConfig()
  if (!cfg?.chatId) throw new Error('Telegram ei ole käytössä')
  const form = new FormData()
  form.set('chat_id', cfg.chatId)
  if (caption) form.set('caption', String(caption).slice(0, 1000))
  form.set('photo', new Blob([buffer], { type: 'image/jpeg' }), 'naytto.jpg')
  let lastErr
  for (const wait of [0, 3000, 10_000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendPhoto`, { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        // Liian iso kuvaksi → dokumenttina (Telegramin kuvaraja 10 Mt / mittasuhteet).
        if (/PHOTO_INVALID_DIMENSIONS|too big|PHOTO_SAVE_FILE_INVALID/i.test(String(data.description))) {
          const doc = new FormData()
          doc.set('chat_id', cfg.chatId)
          if (caption) doc.set('caption', String(caption).slice(0, 1000))
          doc.set('document', new Blob([buffer], { type: 'image/jpeg' }), 'naytto.jpg')
          const r2 = await fetch(`https://api.telegram.org/bot${cfg.token}/sendDocument`, { method: 'POST', body: doc })
          if (r2.ok) return
        }
        throw new Error(`Telegram sendPhoto: ${data.description ?? res.status}`)
      }
      return
    } catch (err) {
      lastErr = err
      if (/Telegram sendPhoto: (Bad Request|Forbidden|Unauthorized)/.test(String(err?.message))) break
    }
  }
  throw lastErr
}

/**
 * Kuuntelee käyttäjän viestejä (long polling) ja antaa ne komentoajolle.
 * `submit(text, reply)` ajaa komennon ja kutsuu reply(vastaus).
 */
// Telegramin komentovalikko (/-painike): JARVIS asettaa sen itse käynnistyessä, BotFatheria ei tarvita.
const COMMANDS = [
  // [komento, valikon kuvaus, mallille menevä pyyntö ('' = vain pikakomento), ryhmä]
  ['komennot', 'Kaikki komennot ja mitä JARVIS osaa', '', 'JARVIS'],
  ['tanaan', 'Päivän tapaamiset ja mihin palata', 'Mitä minulla on tänään? Tapaamiset ja putken asiat, joihin pitää palata.', 'MYYNTI JA CRM'],
  ['liidit', 'Hae uusia liidejä', 'Hae 3 uutta liidiä.', 'MYYNTI JA CRM'],
  ['oppi', 'Mitä liideistä on opittu', 'Mitä olet oppinut liideistä?', 'MYYNTI JA CRM'],
  ['opiskele', 'JARVIS opiskelee myyntipsykologiaa/markkinointia (tai: /opiskele hinnoittelu)', 'Opiskele seuraava myyntiaihe.', 'MYYNTI JA CRM'],
  ['kalustovahti', 'Ryhmässä: tee tästä KalustoVahti-kanava (JARVIS neuvoo siellä myynnissä)', '', 'MYYNTI JA CRM'],
  ['auto', 'Tesla: tila (tai: /auto lämmitä, /auto pois)', 'Auton tila.', 'KOTI'],
  ['tila', 'Koneen tila', 'Mikä koneen tila?', 'KONE'],
  ['kuva', 'Kuvakaappaus näytöstä', 'Ota kuvakaappaus näytöstä.', 'KONE'],
  ['naytto', 'Näyttö pois (tai: /naytto päälle)', 'Sammuta näyttö.', 'KONE'],
  ['lukitse', 'Lukitse kone', 'Lukitse kone.', 'KONE'],
  ['peru', 'Peru sammutus', 'Peru sammutus.', 'KONE'],
  ['leffa', 'Leffailta: projektori + Netflix (+ nimi) — tai /leffa kauhu: ehdotus katsomattomista (Netflix + Disney+)', 'Leffailta: projektori päälle ja Netflix.', 'KOTI'],
  ['yo', 'Hyvää yötä: projektori pois, kone lukkoon', 'Hyvää yötä.', 'KOTI'],
  ['nukkumaan', 'Kaikki laitteet kiinni (projektori, valot, näyttö, kone lukkoon)', 'Nukkumaan.', 'KOTI'],
  ['eroottinen', 'Punainen valo + Spotify projektorilla', 'Eroottinen.', 'KOTI'],
  ['valot', 'Valojen tila', 'Mikä valojen tila?', 'KOTI'],
  ['imuroi', 'Imuroi koko koti (tai: /imuroi keittiö, /imuroi kotiin, /imuroi tila)', 'Imuroi.', 'KOTI'],
  ['kamera', 'Koirakamera: kuva nyt (tai: /kamera vasen, /kamera oikea)', 'Näytä kamerakuva.', 'KOTI'],
  ['ir', 'IR-kaukosäätimet ja napit (projektori, lämpöpumppu…)', 'Mitä IR-kaukosäätimiä on?', 'KOTI'],
  ['prompt', 'ChatGPT:n seuraava prompt Claude Codeen', 'Hae ChatGPT:stä seuraava prompt ja vie se Claude Codeen.', 'KEHITYS'],
  ['claude', 'Mitä Claude Code tekee', 'Mitä Claude Code tekee nyt?', 'KEHITYS'],
  ['tarkista', 'Testaa kaikki palvelut (tekoälyt, CRM, Telegram, laitteet, VPN) ja kerro mikä ei toimi', 'Tarkista palvelut.', 'JARVIS'],
  ['arvio', 'JARVIS arvioi päivän virheensä ja oppii', 'Arvioi tämän päivän virheesi.', 'JARVIS'],
  ['skenaario', 'Tulevaisuuden skenaario: kaikki tekoälyt samalla kysymyksellä (tai: /skenaario 500 asiakasta)', 'Aja seuraava skenaario.', 'JARVIS'],
  ['minusta', 'Mitä JARVIS on oppinut minusta', 'Mitä olet oppinut minusta? Kerro myös mistä olet epävarma.', 'JARVIS'],
  ['uudelleen', 'Käynnistä JARVIS uudelleen (päivitykset käyttöön)', 'Käynnistä itsesi uudelleen.', 'JARVIS'],
  ['laitteet', 'JARVIS-sivulle kirjautuneet laitteet (tai: /laitteet pois = kaikki ulos)', '', 'JARVIS'],
]
/** /komennot: looginen lista komennoista JA vapaamuotoisista pyynnöistä (ei mallia, aina sama). */
export function commandsText() {
  const groups = {}
  for (const [c, d, , g] of COMMANDS) (groups[g] ??= []).push(`/${c} — ${d}`)
  const free = {
    'MYYNTI JA CRM': ['"hae 5 liidiä Turusta" · "hyväksy 1 ja 3" · "hylkää 2, liian pieni"', '"mikä on Hoviputken tilanne" · "kirjaa Ajan Lukon tapaamisen tulos" · "valmistele huominen tapaaminen"', '"viikon luvut" · "kenelle pitää palata" · "kirjoita liideille avaukset"'],
    'KONE': ['"avaa Steam" · "avaa claude" · "mitä näytöllä on" · "klikkaa Kyllä-nappia"', '"sammuta kone" (kysyy vahvistuksen) · "lepotilaan" · "tuo Claude Code eteen ja liitä tämä: …"'],
    'KOTI': ['"valot pois" · "makuuhuone punaiseksi" · "valot 30 prosenttiin" · "lämmin valkoinen" · "nukkumaan tunnin päästä"', '"laita Netflixistä Dead End Job päälle" · "projektori valmiustilaan" · "ääni kovemmalle"', '"mitä laitteita wifissä on" · "mikä reitittimen tila" · "käynnistä reititin uudelleen" (vahvistus)', '"sammuta telkkari 30 min päästä" · "lukitse kone klo 23" · "muistuta vartin päästä että…" · "mitä ajastimia on" · "peru ajastin"', '"lämmitä auto" · "lämmitä auto klo 7.15" · "paljonko autossa on akkua" · "missä auto on" · "lukitse auto"', '"mitä koirat tekee?" · "kamera" · "kamera vasemmalle" · "projektori päälle" (herää IR:llä) · "lämpöpumppu 22 astetta"'],
    'TEKOÄLYT': ['"mitä tekoälyjä sinulla on" · "kysy myös GPT:ltä …" · "mitä muut sanovat tästä" · "hae laajemmin"', '"mieti kunnolla: …" → neuvosto, kaikki tekoälyt + kriittinen vertailu'],
    'KEHITYS': ['"tee mulle peli / työkalu / sivu" → JARVIS kysyy ensin, sitten Claude Code rakentaa', '"miten rakennus etenee" · "lisää siihen pistelasku"'],
    'JARVIS': ['"muista että …" · "kun sanon X tarkoitan Y" · "mitä tiedät minusta" · "näytä taidot"', '"aloita kokous" · "luo tapaaminen Iinan kanssa, iina@…" · "seuraa osaketta NVDA"', 'KalustoVahti-ryhmässä (Iina mukana): lähetä asiakkaan vastaus tai kuvakaappaus → 2–3 vastausehdotusta · "missä mennään?" · "mitä X:stä tiedetään?"'],
  }
  const order = ['MYYNTI JA CRM', 'KONE', 'KOTI', 'TEKOÄLYT', 'KEHITYS', 'JARVIS']
  const out = ['JARVIS — KOMENNOT JA MITÄ VOIT PYYTÄÄ', 'Pikakomennot (/) toimivat heti ilman mallia. Kaiken muun voit sanoa omin sanoin.']
  for (const g of order) {
    out.push('', `▪ ${g}`)
    for (const l of groups[g] ?? []) out.push(l)
    for (const l of free[g] ?? []) out.push(`  ${l}`)
  }
  out.push('', 'Vahvistusta vaativat: sammutus, uudelleenkäynnistys, reitittimen käynnistys, CRM-kirjaukset, lähetykset, ostokset.', 'Automaattisesti: aamukooste 7.45, putki 8.30, liidit ma 8.00, viikkoraportti pe 15.00, itsearvio 23.15, ryhmän myyntioppi 23.30, profiili 23.40, taidot 23.50.')
  return out.join('\n')
}
const COMMAND_TEXT = Object.fromEntries(COMMANDS.map(([c, , t]) => [c, t]))

export function startTelegram(submit, { announce, fast, quick, advise, addressed, groupCommand, groupCommands } = {}) {
  const cfg = readConfig()
  if (!cfg?.chatId) return () => {}
  let botUsername = ''
  api(cfg.token, 'getMe', {}).then((me) => (botUsername = me?.username ?? '')).catch(() => {})
  // Ryhmäneuvoja: yksi kerrallaan, ettei sama kysymys mene kahdesti; jonossa max 3.
  let advising = Promise.resolve()
  // Usage limit: one notice per limit window, questions asked meanwhile are answered automatically after the reset.
  let limitNoticeUntil = 0
  let pendingPhotos = null
  const flushPhotos = () => {
    const p = pendingPhotos
    pendingPhotos = null
    if (!p?.images.length) return
    const typingOn = () => api(cfg.token, 'sendChatAction', { chat_id: cfg.chatId, action: 'typing' }).catch(() => {})
    void typingOn()
    const typing = setInterval(typingOn, 4500)
    const typingStop = setTimeout(() => clearInterval(typing), 16 * 60_000)
    const n = p.images.length
    const text = p.caption || `Katso ${n > 1 ? `${n} kuvaa` : 'kuva'}: mitä siinä on ja mitä minun kannattaa tehdä seuraavaksi? Jos olemme kesken jonkin asetuksen tai sivun, kerro tarkalleen mitä painan seuraavaksi. Jos se on asiakkaan viesti, ehdota vastaus.`
    console.log(`[jarvis] telegram: ${n} kuvaa → yksi pyyntö${p.caption ? `: ${p.caption.slice(0, 60)}` : ''}`)
    submit({ text, images: p.images.slice(0, 5) }, async (reply) => {
      clearInterval(typing)
      clearTimeout(typingStop)
      announce?.(reply)
      await sendTelegram(reply).catch(() => {})
    })
  }
  // Ryhmän oma komentovalikko (Iina näkee vain nämä ryhmässä); yksityischatin valikko alla.
  if (cfg.crmChatId && groupCommands?.length)
    api(cfg.token, 'setMyCommands', { commands: groupCommands.map(([command, description]) => ({ command, description })), scope: { type: 'chat', chat_id: Number(cfg.crmChatId) } }).catch((err) =>
      console.warn('[jarvis] telegram: ryhmän komentovalikkoa ei asetettu:', err?.message ?? err),
    )
  api(cfg.token, 'setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }).catch((err) =>
    console.warn('[jarvis] telegram: komentovalikkoa ei asetettu:', err?.message ?? err),
  )
  let stopped = false
  let offset = 0
  const groupHandled = new Set() // ryhmäviestit, joihin neuvoja on jo vastannut (muokkaus ei tuota toista vastausta)
  const started = Date.now()
  const at = (ms) => new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))
  // "Käynnistä kone" -tyyppinen pyyntö: JARVIS pyörii tällä koneella, joten jos viesti tuli perille, kone on jo päällä.
  const WAKE = /^(?!.*(uudelleen|kiinni|sammu|pois|nukkumaan))(?=.*(?<!\p{L})(käynnistä|herätä|laita|kytke|wake|start|boot)(?!\p{L}))(?=.*(?<!\p{L})(kone|koneeni|konetta|tietokone|tietokoneeni|tietokonetta|pc|computer)(?!\p{L}))/iu
  const wakeReply = () =>
    `Kone on päällä ja olen käynnissä (klo ${at(started)} alkaen).\n\n` +
    `Kun kone on sammuksissa, en pysty herättämään sitä itse, koska pyörin samalla koneella. Herätys: puhelimen Wake Me Up -sovellus ` +
    `kotiverkossa (laite "Kone"). Telegramiin kone kiinni ollessa lähetetyt viestit tulevat perille vasta, kun kone käynnistyy.`
  ;(async () => {
    let backoff = 2000
    while (!stopped) {
      try {
        const updates = await api(cfg.token, 'getUpdates', {
          offset,
          timeout: 30,
          allowed_updates: ['message', 'edited_message'],
        })
        backoff = 2000
        const missed = []
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1)
          let m = u.message
          // Muokattu ryhmäviesti (esim. Iina lisää perään "Jarvis"): käsitellään kuin uusi, jos siihen ei ole vielä vastattu.
          // Yksityischatin muokkauksia ei käsitellä.
          if (!m && u.edited_message) {
            const e = u.edited_message
            const fresh = Date.now() / 1000 - Number(e.edit_date ?? e.date ?? 0) <= 900
            const fromOwner = String(e.from?.id ?? '') === String(cfg.chatId)
            if (advise && cfg.crmChatId && String(e.chat?.id ?? '') === cfg.crmChatId && fresh && !groupHandled.has(e.message_id) && (!fromOwner || /jarvis/i.test(String(e.text ?? e.caption ?? '')))) {
              m = { ...e, date: e.edit_date ?? e.date, __edited: true }
            }
          }
          if (!m) continue
          const from = String(m.chat?.id ?? '')
          // Ryhmä muuttui superryhmäksi (esim. kun botista tehtiin ylläpitäjä): chat id vaihtuu → päivitetään rivi 3 automaattisesti.
          const migrated = m.migrate_to_chat_id && from === cfg.crmChatId ? String(m.migrate_to_chat_id) : m.migrate_from_chat_id && String(m.migrate_from_chat_id) === cfg.crmChatId ? from : ''
          if (migrated) {
            try {
              const lines = readFileSync(CONFIG, 'utf8').split(/\r?\n/)
              lines[2] = migrated
              writeFileSync(CONFIG, lines.slice(0, 3).join('\n'))
              cfg.crmChatId = migrated
              console.log(`[jarvis] telegram: KalustoVahti-ryhmä siirtyi superryhmäksi (${migrated})`)
            } catch (err) {
              console.warn('[jarvis] telegram: ryhmän siirron tallennus epäonnistui:', err?.message ?? err)
            }
            continue
          }
          // KalustoVahti-ryhmä: neuvoja (vain luku) — Elias ja Iina voivat kysyä, lähettää asiakkaan viestin tai kuvakaappauksen.
          if (advise && cfg.crmChatId && from === cfg.crmChatId && m.chat?.type !== 'private' && !/^\/kalustovahti/i.test(m.text ?? '')) {
            const who = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || 'joku'
            const isOwner = String(m.from?.id ?? '') === String(cfg.chatId)
            const rowBase = { at: Number(m.date ?? 0) * 1000 || Date.now(), who, fromId: m.from?.id, owner: isOwner, id: m.message_id, replyTo: m.reply_to_message?.message_id }
            // Pysyvä ryhmämuisti: KAIKKI viestit (myös vanhat, kun kone oli kiinni, ja ne joihin ei vastata). Ääniviesti tallennetaan tunnistuksen jälkeen.
            if (!(m.voice || m.audio) && !m.__edited) {
              try {
                recordGroup({ ...rowBase, text: String(m.text ?? m.caption ?? '').replace(new RegExp(`@${botUsername}\\b`, 'gi'), '').trim(), kind: m.photo?.length ? 'kuva' : undefined })
              } catch {
                /* ok */
              }
            }
            if (Date.now() / 1000 - Number(m.date ?? 0) > 900) continue
            let text = String(m.text ?? m.caption ?? '').trim().replace(new RegExp(`@${botUsername}\\b`, 'gi'), '').trim().slice(0, 3000)
            // "lähetin 2" ilman kauttaviivaa = aamupaketin kuittaus (sama kuin /lahetin 2), ei mallille.
            if (/^l[äa]hetin\s+\d{1,2}\s*[ab]?\s*[.!]*$/i.test(text)) text = `/lahetin ${text.replace(/^l[äa]hetin\s+/i, '').replace(/[.!]+$/, '')}`
            // Ryhmän pikakomento (/tanaan, /putki, /yritys X, /vastaa …): suora vastaus ilman mallia tai tarkennettu pyyntö neuvojalle.
            const gc = text.match(/^\/([a-zåäö_]+)(?:@\w+)?\s*([\s\S]*)$/i)
            if (gc && groupCommand) {
              const firstName = m.from?.first_name || ''
              const r = await Promise.resolve(groupCommand(gc[1].toLowerCase().replace('ä', 'a'), gc[2] ?? '', firstName)).catch((err) => ({ text: `Ei onnistunut: ${String(err?.message ?? err).slice(0, 120)}` }))
              if (r?.text) {
                console.log(`[jarvis] neuvoja: /${gc[1]} (${who}, ilman mallia)`)
                const sent = await api(cfg.token, 'sendMessage', { chat_id: from, text: String(r.text).slice(0, 3900), reply_to_message_id: m.message_id, disable_web_page_preview: true }).catch(() => null)
                if (sent) noteGroupSend(sent, String(r.text).slice(0, 3900))
                continue
              }
              if (r?.advise) text = r.advise
              else if (!r) {
                await api(cfg.token, 'sendMessage', { chat_id: from, text: 'Tuota komentoa ei ole ryhmässä. /apua näyttää mitä täällä voi kysyä.', reply_to_message_id: m.message_id }).catch(() => {})
                continue
              }
            }
            const isCommand = Boolean(gc && groupCommand)
            // Päätös ja ääniviestin tunnistus jonossa, EI kyselysilmukassa: hidas luokittelu tai Whisper ei pysäytä Eliaksen yksityischattia.
            const decideAndRun = async () => {
              if (!isCommand && (m.voice || m.audio) && !m.text) {
                const v = m.voice ?? m.audio
                if (!localSttAvailable() || (v.duration ?? 0) > 180 || (v.file_size ?? 0) > 8_000_000) return
                try {
                  const buf = await fetchFile(cfg.token, v.file_id)
                  const heard = buf ? String((await Promise.race([transcribeLocally(buf, v.mime_type || 'audio/ogg'), new Promise((r) => setTimeout(() => r(''), 60_000))])) ?? '').trim() : ''
                  try {
                    recordGroup({ ...rowBase, text: heard, kind: 'ääni' })
                  } catch {
                    /* ok */
                  }
                  if (!heard) return
                  m.text = heard
                  m.__voice = true
                  text = heard.slice(0, 3000)
                  console.log(`[jarvis] neuvoja: ääniviesti (${v.duration ?? '?'} s) → "${heard.slice(0, 80)}"`)
                } catch (err) {
                  console.warn('[jarvis] neuvoja: ääniviestin tunnistus epäonnistui:', err?.message ?? err)
                  return
                }
              }
              if (!isCommand) {
                let yes = false
                try {
                  m.__owner = isOwner
                  yes = await Promise.resolve(addressed?.(m, botUsername))
                } catch {
                  yes = false
                }
                if (!yes) return
              }
              console.log(`[jarvis] neuvoja: ${who}: ${text.slice(0, 80)}${m.photo?.length ? ' (kuva)' : ''}${m.__voice ? ' (ääni)' : ''}`)
              await run()
            }
            const run = async () => {
              const typingOn = () => api(cfg.token, 'sendChatAction', { chat_id: from, action: 'typing' }).catch(() => {})
              await typingOn()
              const typing = setInterval(typingOn, 4500)
              try {
                const image = m.photo?.length ? await fetchPhoto(cfg.token, m.photo).catch(() => null) : null
                const rt = m.reply_to_message
                const replyTo = rt ? { id: rt.message_id, text: String(rt.text ?? rt.caption ?? '').slice(0, 1500), who: rt.from?.is_bot ? 'JARVIS' : [rt.from?.first_name, rt.from?.last_name].filter(Boolean).join(' ') } : null
                groupHandled.add(m.message_id)
                if (groupHandled.size > 500) groupHandled.delete(groupHandled.values().next().value)
                const reply = await advise({ who, text, image, messageId: m.message_id, replyTo, voice: Boolean(m.__voice), owner: isOwner })
                if (reply) {
                  const sent = await api(cfg.token, 'sendMessage', { chat_id: from, text: reply.slice(0, 3900), reply_to_message_id: m.message_id, disable_web_page_preview: true })
                  noteGroupSend(sent, reply.slice(0, 3900))
                }
              } catch (err) {
                console.warn('[jarvis] neuvoja: epäonnistui:', err?.message ?? err)
                const wait = limitResetMs(err?.message ?? err)
                if (wait != null && wait < 12 * 3600_000 && !m.__limitRetry) {
                  // Käyttöraja: kysymys jää jonoon ja vastataan itse, kun raja aukeaa (ei "kokeile myöhemmin").
                  m.__limitRetry = true
                  const at = new Date(Date.now() + wait)
                  const hhmm = `${at.getHours()}.${String(at.getMinutes()).padStart(2, '0')}`
                  console.log(`[jarvis] neuvoja: käyttöraja — vastataan automaattisesti klo ${hhmm} jälkeen (${who})`)
                  if (Date.now() > limitNoticeUntil) {
                    limitNoticeUntil = Date.now() + wait
                    await api(cfg.token, 'sendMessage', { chat_id: from, text: `Tekoälyni käyttöraja täyttyi hetkeksi, se aukeaa klo ${hhmm}. Kysymyksesi ovat tallessa: vastaan niihin tähän automaattisesti heti kun raja aukeaa, sinun ei tarvitse kysyä uudelleen.`, reply_to_message_id: m.message_id }).catch(() => {})
                  }
                  const retry = () => {
                    advising = advising.then(run, run)
                  }
                  setTimeout(retry, wait + 90_000).unref?.()
                } else {
                  await api(cfg.token, 'sendMessage', { chat_id: from, text: 'En saanut neuvoa valmiiksi juuri nyt. Kokeile hetken päästä uudelleen.', reply_to_message_id: m.message_id }).catch(() => {})
                }
              } finally {
                clearInterval(typing)
              }
            }
            advising = advising.then(decideAndRun, decideAndRun)
            continue
          }
          // Yksityischat: kuva(t) → mallille. Albumi (useampi kuva kerralla) ja heti perään kirjoitettu teksti yhdistetään YHDEKSI pyynnöksi,
          // ettei sama asia mene mallille kahdesti (4.11.: kaksi kuvaa = kaksi päällekkäistä vastausta).
          if (!m.text && m.photo?.length && from === cfg.chatId && m.chat?.type === 'private' && Date.now() / 1000 - Number(m.date ?? 0) <= 600) {
            const caption = String(m.caption ?? '').trim().slice(0, 2000)
            const image = await fetchPhoto(cfg.token, m.photo).catch(() => null)
            if (!image) {
              await sendTelegram('Kuvaa ei saatu ladattua (liian iso?).').catch(() => {})
              continue
            }
            if (!pendingPhotos) pendingPhotos = { images: [], caption: '', timer: null }
            pendingPhotos.images.push(image)
            if (caption) pendingPhotos.caption = [pendingPhotos.caption, caption].filter(Boolean).join('\n')
            clearTimeout(pendingPhotos.timer)
            // Odotetaan hetki: lisää albumin kuvia tai saateteksti.
            pendingPhotos.timer = setTimeout(() => flushPhotos(), caption ? 2500 : 6000)
            console.log(`[jarvis] telegram: kuva ${pendingPhotos.images.length}${caption ? `: ${caption.slice(0, 80)}` : ''}`)
            continue
          }
          // Teksti heti kuvan perään → kuvan saate (yksi pyyntö).
          if (pendingPhotos && m.text && from === cfg.chatId && m.chat?.type === 'private' && !m.text.startsWith('/')) {
            pendingPhotos.caption = [pendingPhotos.caption, m.text.trim().slice(0, 2000)].filter(Boolean).join('\n')
            clearTimeout(pendingPhotos.timer)
            flushPhotos()
            continue
          }
          // Ääniviesti Eliakselta yksityischatissa → paikallinen Whisper (ääni ei lähde koneelta) → käsitellään kuin kirjoitettu viesti.
          let heard = ''
          if (!m.text && (m.voice || m.audio) && from === cfg.chatId && m.chat?.type === 'private' && Date.now() / 1000 - Number(m.date ?? 0) <= 600) {
            const v = m.voice ?? m.audio
            if (!localSttAvailable()) {
              await sendTelegram('Ääniviestejä en vielä ymmärrä: paikallinen puheentunnistus (Whisper) ei ole käynnissä. Kirjoita viesti, tai käynnistä JARVIS uudelleen.').catch(() => {})
              continue
            }
            if ((v.file_size ?? 0) > 20_000_000 || (v.duration ?? 0) > 600) {
              await sendTelegram('Ääniviesti on liian pitkä (yli 10 min). Lähetä lyhyempi.').catch(() => {})
              continue
            }
            await api(cfg.token, 'sendChatAction', { chat_id: cfg.chatId, action: 'typing' }).catch(() => {})
            try {
              const buf = await fetchFile(cfg.token, v.file_id)
              heard = buf ? (await transcribeLocally(buf, v.mime_type || 'audio/ogg')).trim() : ''
            } catch (err) {
              console.warn('[jarvis] telegram: ääniviestin tunnistus epäonnistui:', err?.message ?? err)
            }
            if (!heard) {
              await sendTelegram('En saanut ääniviestistä selvää. Kokeile uudelleen tai kirjoita.').catch(() => {})
              continue
            }
            console.log(`[jarvis] telegram: ääniviesti (${v.duration ?? '?'} s) → "${heard.slice(0, 80)}"`)
            m.text = heard
          }
          if (!m.text) continue
          // Ryhmä, jossa Elias itse sanoo "/kalustovahti": se ryhmä rekisteröidään CRM-ilmoitusten kanavaksi (rivi 3).
          if (m.chat?.type !== 'private' && String(m.from?.id ?? '') === cfg.chatId && /^\/kalustovahti(?:@\w+)?\b/i.test(m.text ?? '')) {
            try {
              const lines = readFileSync(CONFIG, 'utf8').split(/\r?\n/)
              lines[2] = from
              writeFileSync(CONFIG, lines.slice(0, 3).join('\n'))
              cfg.crmChatId = from
              console.log(`[jarvis] telegram: KalustoVahti-ryhmä asetettu (${from})`)
              await api(cfg.token, 'sendMessage', { chat_id: from, text: 'Tämä ryhmä on nyt KalustoVahdin kanava: aamukoosteet, putki, liidit, viikkoraportit ja kotisivun yhteydenotot tulevat tänne. Täällä neuvon myynnissä: Iina, kirjoita vain kysymys tai lähetä asiakkaan vastaus (teksti tai kuvakaappaus), "jarvis"-sanaa ei tarvita. Elias: "jarvis …". En kirjaa täältä mitään enkä ohjaa laitteita — ne vain Eliaksen omasta chatista.' })
            } catch (err) {
              console.warn('[jarvis] telegram: ryhmän tallennus epäonnistui:', err?.message ?? err)
            }
            continue
          }
          if (from !== cfg.chatId || m.chat?.type !== 'private') {
            console.warn(`[jarvis] telegram: ohitettu viesti vieraalta chatilta ${from}${m.chat?.type !== 'private' ? ` (ryhmä "${m.chat?.title ?? ''}" — jos tämä on KalustoVahti, kirjoita siellä /kalustovahti)` : ''}`)
            continue
          }
          let text = m.text.trim()
          if (!text || text.length > 2000) continue
          // /komento (myös "/prompt lisäohje" tai "/tila@botin_nimi") → luonnollinen pyyntö.
          const cmd = text.match(/^\/([a-z_]+)(?:@\w+)?\s*([\s\S]*)$/i)
          // Pikakomento ilman mallia (fast palauttaa tekstin) → vastaus heti; muuten luonnollinen pyyntö mallille.
          if (cmd && fast && cmd[1].toLowerCase() in COMMAND_TEXT) {
            const direct = await Promise.resolve(fast(cmd[1].toLowerCase(), cmd[2] ?? '')).catch((err) => `Ei onnistunut: ${err?.message ?? err}`)
            if (direct) {
              console.log(`[jarvis] telegram: /${cmd[1]} (pikakomento, ei mallia)`)
              await sendTelegram(`${heard ? `Kuulin: "${heard.slice(0, 300)}"\n\n` : ''}${String(direct)}`.slice(0, 12000)).catch(() => {})
              continue
            }
          }
          if (cmd && COMMAND_TEXT[cmd[1].toLowerCase()]) text = `${COMMAND_TEXT[cmd[1].toLowerCase()]}${cmd[2] ? ` ${cmd[2]}` : ''}`
          // Selvä laitekomento ("sulje näyttö", "lukitse kone", "mykistä"): suoraan ilman mallia ja jonon ohi.
          if (quick && Date.now() / 1000 - Number(m.date ?? 0) <= 600) {
            const direct = await Promise.resolve(quick(text)).catch((err) => `Ei onnistunut: ${err?.message ?? err}`)
            if (direct) {
              console.log(`[jarvis] telegram: pikatoiminto ilman mallia: ${text.slice(0, 40)}`)
              await sendTelegram(`${heard ? `Kuulin: "${heard.slice(0, 300)}"\n\n` : ''}${String(direct)}`.slice(0, 4000)).catch(() => {})
              continue
            }
          }
          if (WAKE.test(text) && text.length < 120) {
            console.log(`[jarvis] telegram: herätyspyyntö (${Number(m.date) * 1000 < started ? 'lähetetty koneen ollessa kiinni' : 'kone jo päällä'})`)
            await sendTelegram(wakeReply()).catch(() => {})
            continue
          }
          // Vanhat viestit (kone oli kiinni) ohitetaan 10 min jälkeen — mutta niistä kerrotaan, ettei mitään katoa huomaamatta.
          if (Date.now() / 1000 - Number(m.date ?? 0) > 600) {
            missed.push(text)
            continue
          }
          if (text === '/start') {
            await sendTelegram('Kuulolla. Kirjoita mitä tarvitset.')
            continue
          }
          console.log(`[jarvis] telegram: ${text.slice(0, 120)}`)
          // "kirjoittaa…" pysyy näkyvissä koko työn ajan (Telegram näyttää sen vain 5 s kerrallaan).
          const typingOn = () => api(cfg.token, 'sendChatAction', { chat_id: cfg.chatId, action: 'typing' }).catch(() => {})
          await typingOn()
          const typing = setInterval(typingOn, 4500)
          const typingStop = setTimeout(() => clearInterval(typing), 16 * 60_000)
          submit(text, async (reply) => {
            clearInterval(typing)
            clearTimeout(typingStop)
            announce?.(reply)
            await sendTelegram(heard ? `Kuulin: "${heard.slice(0, 300)}"\n\n${reply}` : reply).catch((err) =>
              console.warn('[jarvis] telegram: vastaus ei mennyt perille:', err?.message ?? err),
            )
          })
        }
        if (missed.length) {
          const list = missed.slice(-5).map((t) => `• ${t.slice(0, 120)}`).join('\n')
          await sendTelegram(`Kone oli kiinni, kun lähetit nämä, joten en tehnyt niitä:\n${list}\n\nLähetä uudelleen, jos tarvitset vielä.`).catch(() => {})
        }
      } catch (err) {
        if (stopped) break
        console.warn(`[jarvis] telegram: yhteys epäonnistui (${err?.message ?? err}${err?.cause?.code ? ` ${err.cause.code}` : ""}), uusi yritys ${Math.round(backoff / 1000)} s`)
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 15_000)
      }
    }
  })()
  return () => {
    stopped = true
  }
}
