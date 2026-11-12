/**
 * Kotikamera (TP-Link Tapo C200 / C100 tai muu RTSP-kamera) kotiverkossa: kuva, elävä kuva sovellukseen ja kääntö.
 *
 *   Asennus: tyokalut\asenna_kamera.bat — kameran IP + Tapo-sovelluksen "Kameratili" (käyttäjätunnus + salasana,
 *   DPAPI-salattuna ~/.jarvis/kamera.json). Kuva haetaan RTSP:llä suoraan kamerasta (rtsp://IP:554/stream1),
 *   ei pilvestä. Kääntö (C200) ONVIF:lla portissa 2020.
 *
 *   kamera_kuva     yksi kuva (mallille + halutessa Eliaksen Telegramiin)
 *   kamera_kaanna   vasen/oikea/ylös/alas (vain kääntyvä kamera)
 *   liveStream()    MJPEG-virta sovellukseen (server.mjs: GET /kamera.mjpg), ffmpeg pyörii vain katselun ajan
 *
 * Yksityisyys: kamera on kotona. Kuvia ei tallenneta levylle, ja niitä lähetetään vain Eliaksen omaan Telegram-chattiin.
 * Bridge kuuntelee vain tätä konetta (127.0.0.1), joten elävä kuva ei näy lähiverkkoon. Lisäksi /kamera.* vaatii
 * käynnistyskohtaisen avaimen (?t=), jonka sovellus saa vain WebSocketin kautta (kamera_tila), ja Host-otsakkeen
 * pitää olla localhost tai oma Tailscale-nimi (suoja DNS rebindingiä vastaan).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG = () => join(homedir(), '.jarvis', 'kamera.json')
const FFMPEG = () => process.env.JARVIS_FFMPEG ?? 'ffmpeg'

/** { kamerat: [{ nimi, ip, kayttaja, salasana (DPAPI), rtspPort?, polku?, onvifPort?, kaantyva? }] } */
function cfg() {
  try {
    if (!existsSync(CONFIG())) return null
    const j = JSON.parse(readFileSync(CONFIG(), 'utf8').replace(/^﻿/, ''))
    const list = Array.isArray(j?.kamerat) ? j.kamerat : j?.ip ? [j] : []
    return list.filter((c) => c && /^[\d.]+$/.test(String(c.ip ?? '')) && c.kayttaja)
  } catch {
    return null
  }
}
export const cameraConfigured = () => Boolean(cfg()?.length)
export const cameraNames = () => (cfg() ?? []).map((c) => c.nimi || 'kamera')

function pick(nimi) {
  const list = cfg() ?? []
  if (!list.length) throw new Error('Kameraa ei ole asennettu: aja tyokalut\\asenna_kamera.bat.')
  const q = String(nimi ?? '').toLowerCase().trim()
  if (!q || /^(kamera|koirakamera|koirat|koira)$/.test(q)) return list[0]
  return list.find((c) => String(c.nimi ?? '').toLowerCase() === q) ?? list.find((c) => String(c.nimi ?? '').toLowerCase().includes(q)) ?? list[0]
}

// Salasana DPAPI:lla (sama tapa kuin valot.mjs:ssä); ei koskaan lokiin eikä mallille.
const secrets = new Map()
function password(c) {
  if (secrets.has(c.ip)) return Promise.resolve(secrets.get(c.ip))
  if (process.platform !== 'win32' || c.salasana_selko) {
    secrets.set(c.ip, String(c.salasana_selko ?? c.salasana ?? ''))
    return Promise.resolve(secrets.get(c.ip))
  }
  const enc = String(c.salasana ?? '')
  // DPAPI output is hex; anything else would be spliced into a PowerShell command.
  if (!/^[0-9a-f]+$/i.test(enc)) return Promise.reject(new Error('Kameran salasana on väärässä muodossa (aja asenna_kamera.bat uudelleen).'))
  return new Promise((resolve, reject) => {
    const ps = `$s = ConvertTo-SecureString '${enc}'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      if (err || !String(out).trim()) return reject(new Error('Kameran salasanaa ei saatu purettua (aja asenna_kamera.bat uudelleen).'))
      const pw = String(out).replace(/\r?\n$/, '')
      secrets.set(c.ip, pw)
      resolve(pw)
    })
  })
}
async function rtspUrl(c, { low = false } = {}) {
  const pw = await password(c)
  const path = c.polku || (low ? 'stream2' : 'stream1')
  return `rtsp://${encodeURIComponent(c.kayttaja)}:${encodeURIComponent(pw)}@${c.ip}:${c.rtspPort ?? 554}/${path}`
}
/** Virheteksteistä pois tunnukset. */
const scrub = (s) => String(s ?? '').replace(/rtsp:\/\/[^@\s]*@/gi, 'rtsp://***@').slice(0, 300)

let spawnImpl = spawn
/** Testeille: korvaa ffmpeg-prosessin käynnistys. */
export function _setSpawn(fn) {
  spawnImpl = fn
}

// --- Yksityisyystila ---------------------------------------------------------------------------------------------
// "Sulje kamera, olen kotona" (7.11.2026): JARVIS does not read the camera at all while privacy mode is on — no snapshot,
// no live stream, no Telegram photo. The camera itself keeps recording to its own card/app; this gate is on JARVIS's side.
const PRIVACY = () => join(homedir(), '.jarvis', 'kamera_tila.json')
function privacyState() {
  try {
    if (!existsSync(PRIVACY())) return { privacy: false }
    const j = JSON.parse(readFileSync(PRIVACY(), 'utf8').replace(/^﻿/, ''))
    if (j?.privacy && j.until && Date.parse(j.until) < Date.now()) return { privacy: false, expired: true }
    return { privacy: Boolean(j?.privacy), until: j?.until ?? null, since: j?.since ?? null }
  } catch {
    return { privacy: false }
  }
}
export function cameraPrivacy() {
  return privacyState()
}
/** tila 'pois' = privacy ON (camera closed for JARVIS); 'paalle' = privacy OFF. minuutit = auto-reopen. Returns text. */
export function setCameraPrivacy(tila, minuutit = 0) {
  const on = /^(pois|kiinni|suljettu|yksityinen|privacy)$/i.test(String(tila))
  const until = on && Number(minuutit) > 0 ? new Date(Date.now() + Number(minuutit) * 60_000).toISOString() : null
  try {
    writeFileSync(PRIVACY(), JSON.stringify({ privacy: on, since: new Date().toISOString(), until }))
  } catch (err) {
    return `Kameran tilaa ei voitu tallentaa: ${err?.message ?? err}`
  }
  if (on) {
    for (const [ip, live] of lives) {
      try {
        live.proc?.kill?.()
      } catch {
        /* ok */
      }
      lives.delete(ip)
    }
    console.log(`[jarvis] kamera: yksityisyystila päällä${until ? ` (${minuutit} min)` : ''}`)
    return `Kamera suljettu JARVISilta${until ? ` ${minuutit} minuutiksi` : ''}: en ota kuvia, en lähetä niitä enkä näytä elävää kuvaa ennen kuin sanot "kamera päälle". (Kamera itse tallentaa yhä omaan sovellukseensa; sen saa pois Tapo-sovelluksen yksityisyystilasta.)`
  }
  console.log('[jarvis] kamera: yksityisyystila pois')
  return 'Kamera taas käytössä: voin ottaa kuvia pyynnöstä.'
}
const PRIVACY_MSG = 'Kamera on suljettu (yksityisyystila: olet kotona). Sano "kamera päälle", jos haluat kuvan.'

/** Yksi JPEG-kuva kamerasta (Buffer). Samanaikaiset pyynnöt jakavat saman ffmpeg-ajon. */
const inflight = new Map() // ip → Promise<{buf, cam}>
export function snapshot(nimi) {
  if (privacyState().privacy) return Promise.reject(new Error(PRIVACY_MSG))
  const c = pick(nimi)
  // Elävä kuva auki: käytä sen uusinta ruutua (ei toista RTSP-yhteyttä).
  const live = lives.get(c.ip)
  if (live?.last && Date.now() - live.lastAt < 3000) return Promise.resolve({ buf: live.last, cam: c })
  if (inflight.has(c.ip)) return inflight.get(c.ip)
  const p = grab(c).finally(() => inflight.delete(c.ip))
  inflight.set(c.ip, p)
  return p
}
async function grab(c) {
  const url = await rtspUrl(c)
  const buf = await new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']
    let p
    try {
      p = spawnImpl(FFMPEG(), args, { windowsHide: true })
    } catch (err) {
      return reject(new Error(`ffmpeg ei käynnisty: ${scrub(err?.message)}`))
    }
    const out = []
    const errOut = []
    const timer = setTimeout(() => {
      try {
        p.kill()
      } catch {
        /* ok */
      }
      reject(new Error('Kamera ei vastannut 15 sekunnissa (onko se päällä ja samassa wifissä? Yksityisyystila päällä?).'))
    }, 15_000)
    p.stdout.on('data', (d) => out.push(d))
    p.stderr?.on('data', (d) => errOut.push(d))
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(/ENOENT/.test(String(e?.message)) ? 'ffmpeg puuttuu (sama, jota puheentunnistus käyttää: JARVIS_FFMPEG tai PATH).' : `ffmpeg: ${scrub(e?.message)}`))
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      const b = Buffer.concat(out)
      if (b.length > 1000 && b[0] === 0xff && b[1] === 0xd8) return resolve(b)
      const e = scrub(Buffer.concat(errOut).toString())
      reject(new Error(/401|unauthori/i.test(e) ? 'Kamera hylkäsi tunnukset: tarkista Tapo-sovelluksen Kameratili (asenna_kamera.bat).' : `Kuvaa ei saatu (${code}): ${e || 'ei vastausta'}`))
    })
  })
  return { buf, cam: c }
}

// --- Elävä kuva: yksi ffmpeg per kamera, ruudut jaetaan kaikille katsojille, sammuu kun kukaan ei katso ----------
const lives = new Map() // ip → { proc, last, lastAt, listeners:Set, idleTimer }
function startLive(c) {
  let L = lives.get(c.ip)
  if (L) return L
  L = { proc: null, last: null, lastAt: 0, listeners: new Set(), idleTimer: null, error: '', stopped: false }
  lives.set(c.ip, L)
  void (async () => {
    try {
      const url = await rtspUrl(c, { low: false })
      // The idle timer may have fired while the password was being decrypted.
      if (L.stopped) return
      const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-an', '-vf', 'fps=4,scale=1280:-2', '-q:v', '6', '-f', 'mjpeg', 'pipe:1']
      const p = spawnImpl(FFMPEG(), args, { windowsHide: true })
      L.proc = p
      let acc = Buffer.alloc(0)
      p.stdout.on('data', (d) => {
        acc = Buffer.concat([acc, d])
        // JPEG-ruudut virrasta: SOI FFD8 … EOI FFD9
        for (;;) {
          const s = acc.indexOf(Buffer.from([0xff, 0xd8]))
          if (s < 0) {
            // Keep a trailing 0xFF: it may be the first half of the next SOI.
            acc = acc.length && acc[acc.length - 1] === 0xff ? Buffer.from([0xff]) : Buffer.alloc(0)
            break
          }
          const e = acc.indexOf(Buffer.from([0xff, 0xd9]), s + 2)
          if (e < 0) {
            if (s > 0) acc = acc.subarray(s)
            break
          }
          const frame = acc.subarray(s, e + 2)
          acc = acc.subarray(e + 2)
          L.last = Buffer.from(frame)
          L.lastAt = Date.now()
          for (const fn of L.listeners) fn(L.last)
        }
        if (acc.length > 8 * 1024 * 1024) acc = Buffer.alloc(0)
      })
      p.stderr?.on('data', (d) => (L.error = scrub(d.toString())))
      p.on('error', (e) => (L.error = scrub(e?.message)))
      p.on('close', () => {
        if (lives.get(c.ip) === L) lives.delete(c.ip)
        for (const fn of L.listeners) fn(null)
      })
    } catch (err) {
      L.error = scrub(err?.message)
      lives.delete(c.ip)
      for (const fn of L.listeners) fn(null)
    }
  })()
  return L
}
function stopIfIdle(c, L) {
  clearTimeout(L.idleTimer)
  L.idleTimer = setTimeout(() => {
    if (L.listeners.size) return
    L.stopped = true
    try {
      L.proc?.kill()
    } catch {
      /* ok */
    }
    if (lives.get(c.ip) === L) lives.delete(c.ip)
  }, 15_000)
  L.idleTimer.unref?.()
}

/**
 * HTTP-käsittelijä (server.mjs): GET /kamera.mjpg?nimi=… → multipart/x-mixed-replace (selaimen <img> näyttää suoraan),
 * GET /kamera.jpg?nimi=… → yksi kuva.
 */
export const cameraToken = randomBytes(24).toString('hex')
function hostAllowed(host) {
  const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '')
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(h)
}
function tokenOk(t) {
  const a = Buffer.from(String(t ?? ''))
  const b = Buffer.from(cameraToken)
  return a.length === b.length && timingSafeEqual(a, b)
}
export async function handleCameraHttp(req, res, cors = {}) {
  const u = new URL(req.url, 'http://x')
  if (!hostAllowed(req.headers.host) || !tokenOk(u.searchParams.get('t'))) {
    res.writeHead(403, { ...cors, 'content-type': 'text/plain; charset=utf-8' })
    return res.end('Ei oikeutta (avaa kamera JARVIS-sovelluksesta).')
  }
  if (!cameraConfigured()) {
    res.writeHead(404, { ...cors, 'content-type': 'text/plain; charset=utf-8' })
    return res.end('Kameraa ei ole asennettu (tyokalut\\asenna_kamera.bat).')
  }
  if (privacyState().privacy) {
    res.writeHead(423, { ...cors, 'content-type': 'text/plain; charset=utf-8' })
    return res.end(PRIVACY_MSG)
  }
  const c = pick(u.searchParams.get('nimi'))
  if (u.pathname === '/kamera.jpg') {
    try {
      const { buf } = await snapshot(c.nimi)
      res.writeHead(200, { ...cors, 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
      return res.end(buf)
    } catch (err) {
      res.writeHead(502, { ...cors, 'content-type': 'text/plain; charset=utf-8' })
      return res.end(String(err?.message ?? err))
    }
  }
  const L = startLive(c)
  const boundary = 'jarviskamera'
  res.writeHead(200, { ...cors, 'content-type': `multipart/x-mixed-replace; boundary=${boundary}`, 'cache-control': 'no-store', connection: 'close' })
  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(cap)
    L.listeners.delete(send)
    stopIfIdle(c, L)
    if (!res.writableEnded && !res.destroyed) res.end()
  }
  const send = (frame) => {
    if (done || res.writableEnded || res.destroyed) return
    if (!frame) return finish()
    // Slow viewer: drop frames instead of buffering without limit.
    if (res.writableLength > 1024 * 1024) return
    res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`)
    res.write(frame)
    res.write('\r\n')
  }
  // Viimeinen katsoja pois → ffmpeg sammuu 15 s päästä. Turvaraja: 30 min yhtäjaksoista katselua.
  const cap = setTimeout(finish, 30 * 60_000)
  cap.unref?.()
  res.on('close', finish)
  res.on('error', finish)
  L.listeners.add(send)
  if (L.last && Date.now() - L.lastAt < 5000) send(L.last)
}
export function liveStatus() {
  return [...lives.entries()].map(([ip, L]) => ({ ip, katsojia: L.listeners.size, viimeisin: L.lastAt, virhe: L.error }))
}

// --- Kääntö (ONVIF PTZ, Tapo C200: portti 2020) ----------------------------------------------------------------
let fetchImpl = (...a) => fetch(...a)
/** Testeille: korvaa fetch. */
export function _setFetch(fn) {
  fetchImpl = fn
}
async function onvif(c, body) {
  const pw = await password(c)
  const nonce = randomBytes(16)
  const created = new Date().toISOString()
  const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(pw)])).digest('base64')
  const esc = (s) => String(s).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch])
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Header>' +
    '<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken>' +
    `<Username>${esc(c.kayttaja)}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security>` +
    `</s:Header><s:Body>${body}</s:Body></s:Envelope>`
  const res = await fetchImpl(`http://${c.ip}:${c.onvifPort ?? 2020}/onvif/service`, {
    method: 'POST',
    headers: { 'content-type': 'application/soap+xml; charset=utf-8' },
    body: xml,
    signal: AbortSignal.timeout(8000),
  })
  const text = await res.text()
  if (!res.ok || /<\w*:?Fault>/.test(text)) throw new Error(/NotAuthorized|Sender/i.test(text) ? 'kamera hylkäsi tunnukset' : `ONVIF ${res.status}`)
  return text
}
const profileTokens = new Map()
async function profileToken(c) {
  if (profileTokens.has(c.ip)) return profileTokens.get(c.ip)
  const xml = await onvif(c, '<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>')
  const m = xml.match(/<\w*:?Profiles[^>]*\stoken="([^"]+)"/)
  if (!m) throw new Error('kameran profiilia ei löytynyt')
  profileTokens.set(c.ip, m[1])
  return m[1]
}
const DIRS = { vasen: [-0.5, 0], oikea: [0.5, 0], ylös: [0, 0.5], ylos: [0, 0.5], alas: [0, -0.5] }
export async function pan(nimi, suunta, askel = 1) {
  const c = pick(nimi)
  if (c.kaantyva === false) return `${c.nimi || 'Kamera'} ei käänny.`
  const d = DIRS[String(suunta ?? '').toLowerCase()]
  if (!d) return 'Suunta: vasen, oikea, ylös tai alas.'
  const token = await profileToken(c)
  const ms = Math.max(200, Math.min(2000, Math.round(400 * (Number(askel) || 1))))
  await onvif(
    c,
    `<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${token}</ProfileToken><Velocity><PanTilt x="${d[0]}" y="${d[1]}" xmlns="http://www.onvif.org/ver10/schema"/></Velocity></ContinuousMove>`,
  )
  await new Promise((r) => setTimeout(r, ms))
  await onvif(c, `<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${token}</ProfileToken><PanTilt>true</PanTilt><Zoom>false</Zoom></Stop>`)
  return `${c.nimi || 'Kamera'} käännetty: ${suunta}.`
}

// --- Telegram ja malli -------------------------------------------------------------------------------------------
let sendPhoto = null
/** server.mjs antaa Telegramin kuvanlähetyksen (Eliaksen oma chat). */
export function setCameraPhotoSender(fn) {
  sendPhoto = fn
}
/** Kuva Eliaksen Telegramiin. Palauttaa tekstin. */
export async function cameraToTelegram(nimi, caption = '') {
  if (!sendPhoto) return 'Telegram ei ole käytössä.'
  const { buf, cam } = await snapshot(nimi)
  const stamp = new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' }).format(new Date())
  await sendPhoto(buf, { caption: caption || `📷 ${cam.nimi || 'Kamera'} klo ${stamp}` })
  return `📷 Kuva lähetetty (${cam.nimi || 'kamera'}).`
}

export function cameraServer() {
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  return createSdkMcpServer({
    name: 'jarvis_kamera',
    version: '1.0.0',
    instructions:
      'Kotikamera (koirat). Vain Eliaksen omasta pyynnöstä. Kuvaa ei tallenneta; Telegramiin vain Eliaksen omaan chattiin. Kuvaile näkymä lyhyesti (esim. "koirat nukkuvat sohvalla").',
    tools: [
      tool(
        'kamera_kuva',
        'Ottaa kuvan kotikamerasta ja näyttää sen sinulle (kuvaile mitä näkyy, esim. mitä koirat tekevät). telegramiin=true lähettää kuvan myös Eliaksen Telegramiin (käytä aina kun pyyntö tuli Telegramista/puhelimesta).',
        { nimi: z.string().max(40).optional(), telegramiin: z.boolean().optional() },
        async (a) => {
          try {
            const { buf, cam } = await snapshot(a.nimi)
            let note = ''
            if (a.telegramiin && sendPhoto) {
              await sendPhoto(buf, { caption: `📷 ${cam.nimi || 'Kamera'}` }).then(() => (note = ' Kuva lähetetty Telegramiin.')).catch((e) => (note = ` Telegram-lähetys epäonnistui: ${e?.message ?? e}`))
            }
            return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `Kuva: ${cam.nimi || 'kamera'}.${note}` }] }
          } catch (err) {
            return text(`Kamera: ${err?.message ?? err}`)
          }
        },
      ),
      tool(
        'kamera_tila',
        'Kameran yksityisyystila. tila "pois" = SULJE kamera JARVISilta ("sulje kamera", "olen kotona", "kamera kiinni"): ei kuvia, ei livekuvaa, ei Telegram-kuvia; minuutit = avautuu itsestään. ' +
          'tila "paalle" = kamera taas käyttöön. tila "tila" = kerro nykyinen tila. Kun Elias sanoo olevansa kotona ja pyytää sulkemaan kameran, käytä tätä, älä sano ettei työkalua ole.',
        { tila: z.enum(['pois', 'paalle', 'tila']), minuutit: z.number().int().min(1).max(1440).optional() },
        async (a) => {
          if (a.tila === 'tila') {
            const st = privacyState()
            return text(st.privacy ? `Kamera on suljettu JARVISilta${st.until ? ` klo ${new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' }).format(new Date(st.until))} asti` : ''}.` : 'Kamera on käytössä (kuvia pyynnöstä).')
          }
          return text(setCameraPrivacy(a.tila, a.minuutit))
        },
      ),
      tool(
        'kamera_kaanna',
        'Kääntää kääntyvää kameraa (Tapo C200): suunta vasen/oikea/ylös/alas, askel 1–5 (oletus 1 ≈ pieni käännös). Ota sen jälkeen uusi kuva.',
        { nimi: z.string().max(40).optional(), suunta: z.enum(['vasen', 'oikea', 'ylös', 'alas']), askel: z.number().min(1).max(5).optional() },
        async (a) => {
          try {
            return text(await pan(a.nimi, a.suunta, a.askel))
          } catch (err) {
            return text(`Kääntö ei onnistunut: ${String(err?.message ?? err)} (kääntö toimii vain kääntyvällä kameralla, ONVIF portissa 2020).`)
          }
        },
      ),
    ],
  })
}
