/**
 * Samsung-telkkari (Tizen Smart TV) kotiverkossa: kaukosäädin JARVISille.
 *
 *   Paikallinen rajapinta, ei pilveä: REST http://IP:8001/api/v2/ (tila, sovellukset) ja WebSocket wss://IP:8002 (näppäimet).
 *   Ensimmäisellä yhteydellä telkkari kysyy ruudulla "Salli" → Elias hyväksyy kaukosäätimellä → token tallentuu
 *   ~/.jarvis/telkkari.json {ip, mac, name, model, token}. Asennus: tyokalut\asenna_telkkari.bat (etsii telkkarin verkosta).
 *   Päälle: Wake-on-LAN (telkkarin asetus "Käynnistä mobiililaitteella" / "Verkon valmiustila" pitää olla päällä).
 *
 *   Turva: vain kaukosäätimen näppäimet, sovellusten avaus ja tila. Ei asetusten nollauksia, ei tehdasasetuksia.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import WebSocket from 'ws'
import { createSocket } from 'node:dgram'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG = join(homedir(), '.jarvis', 'telkkari.json')
const NAME_B64 = Buffer.from('JARVIS').toString('base64')
export const tvConfig = () => {
  try {
    if (!existsSync(CONFIG)) return null
    const c = JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^﻿/, ''))
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(c.ip ?? '')) ? c : null
  } catch {
    return null
  }
}
export const tvConfigured = () => Boolean(tvConfig())
const saveConfig = (c) => {
  if (!existsSync(join(homedir(), '.jarvis'))) mkdirSync(join(homedir(), '.jarvis'), { recursive: true })
  writeFileSync(CONFIG, JSON.stringify(c, null, 1))
}

/** Kaukosäätimen näppäimet (suomi + englanti → Samsungin koodi). */
export const KEYS = {
  virta: 'KEY_POWER', power: 'KEY_POWER',
  'ääni+': 'KEY_VOLUP', 'ääni-': 'KEY_VOLDOWN', kovemmalle: 'KEY_VOLUP', hiljemmalle: 'KEY_VOLDOWN', mykistä: 'KEY_MUTE', mykista: 'KEY_MUTE', mute: 'KEY_MUTE',
  'kanava+': 'KEY_CHUP', 'kanava-': 'KEY_CHDOWN',
  ylös: 'KEY_UP', ylos: 'KEY_UP', alas: 'KEY_DOWN', vasen: 'KEY_LEFT', oikea: 'KEY_RIGHT', ok: 'KEY_ENTER', enter: 'KEY_ENTER',
  takaisin: 'KEY_RETURN', back: 'KEY_RETURN', koti: 'KEY_HOME', home: 'KEY_HOME', valikko: 'KEY_MENU', lähde: 'KEY_SOURCE', lahde: 'KEY_SOURCE', source: 'KEY_SOURCE',
  toista: 'KEY_PLAY', play: 'KEY_PLAY', tauko: 'KEY_PAUSE', pause: 'KEY_PAUSE', playpause: 'KEY_PLAY_BACK', stop: 'KEY_STOP',
  eteen: 'KEY_FF', taakse: 'KEY_REWIND', info: 'KEY_INFO', tekstitys: 'KEY_CAPTION',
}
/** Tunnetut sovellukset (Tizen appId). Muut haetaan telkkarin asennetuista nimellä. */
const APPS = {
  netflix: '3201907018807', youtube: '111299001912', 'prime video': '3201910019365', prime: '3201910019365',
  'disney+': '3201901017640', disney: '3201901017640', spotify: '3201606009684', 'apple tv': '3201807016597', max: '3202301029760',
}

async function info(ip) {
  const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`telkkari vastasi ${res.status}`)
  return res.json()
}

/** Yhteys näppäinkanavaan. Palauttaa avoimen socketin; tallentaa tokenin ensimmäisellä hyväksynnällä. */
function connect({ waitMs = 8000 } = {}) {
  const c = tvConfig()
  if (!c) return Promise.reject(new Error('Telkkaria ei ole asennettu: aja tyokalut\\asenna_telkkari.bat.'))
  const url = `wss://${c.ip}:8002/api/v2/channels/samsung.remote.control?name=${NAME_B64}${c.token ? `&token=${c.token}` : ''}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 })
    const t = setTimeout(() => {
      ws.terminate()
      reject(new Error(c.token ? 'Telkkari ei vastannut (onko se päällä ja samassa wifissä?).' : 'Telkkari ei hyväksynyt yhteyttä ajoissa: paina telkkarin ruudulla "Salli" ja kokeile uudelleen.'))
    }, waitMs)
    ws.on('message', (raw) => {
      let m
      try {
        m = JSON.parse(String(raw))
      } catch {
        return
      }
      if (m.event === 'ms.channel.connect') {
        clearTimeout(t)
        const tok = m.data?.token
        if (tok && tok !== c.token) saveConfig({ ...tvConfig(), token: tok })
        resolve(ws)
      } else if (m.event === 'ms.channel.unauthorized') {
        clearTimeout(t)
        ws.close()
        reject(new Error('Telkkari esti yhteyden: hyväksy "JARVIS" telkkarin asetuksista (Yleiset → Ulkoisten laitteiden hallinta → Laiteyhteyksien hallinta).'))
      }
    })
    ws.on('error', (e) => {
      clearTimeout(t)
      reject(new Error(`Telkkari ei vastaa (${e.code || e.message}). Onko se päällä?`))
    })
  })
}

async function sendKeys(codes, { delayMs = 350 } = {}) {
  const ws = await connect()
  try {
    for (const code of codes) {
      ws.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: code, Option: 'false', TypeOfRemote: 'SendRemoteKey' } }))
      await new Promise((r) => setTimeout(r, delayMs))
    }
  } finally {
    setTimeout(() => ws.close(), 300)
  }
}

async function installedApps() {
  const ws = await connect()
  return new Promise((resolve) => {
    const t = setTimeout(() => (ws.close(), resolve([])), 6000)
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw))
        if (m.event === 'ed.installedApp.get') {
          clearTimeout(t)
          ws.close()
          resolve((m.data?.data ?? []).map((a) => ({ id: a.appId, name: a.name })))
        }
      } catch {
        /* ok */
      }
    })
    ws.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } }))
  })
}

function magicPacket(mac, ip) {
  const hex = String(mac ?? '').replace(/[^0-9a-f]/gi, '')
  if (hex.length !== 12) return Promise.resolve(false)
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(hex, 'hex'))])
  const bcast = ip ? ip.replace(/\.\d+$/, '.255') : '255.255.255.255'
  return new Promise((resolve) => {
    const s = createSocket('udp4')
    s.once('error', () => (s.close(), resolve(false)))
    s.bind(() => {
      s.setBroadcast(true)
      const targets = [[bcast, 9], ['255.255.255.255', 9], [bcast, 7], ...(ip ? [[ip, 9]] : [])]
      const next = (i) => (i >= targets.length ? (s.close(), resolve(true)) : s.send(pkt, targets[i][1], targets[i][0], () => next(i + 1)))
      next(0)
    })
  })
}

async function powerState() {
  const c = tvConfig()
  try {
    const d = await info(c.ip)
    return String(d?.device?.PowerState ?? 'on').toLowerCase() // osa malleista ei kerro → oletus päällä, koska vastasi
  } catch {
    return 'off'
  }
}

export async function tvCall(action, a = {}) {
  const c = tvConfig()
  if (!c) throw new Error('Telkkaria ei ole asennettu: aja tyokalut\\asenna_telkkari.bat.')
  switch (action) {
    case 'tila': {
      const st = await powerState()
      if (st === 'off') return `${c.name || 'Samsung'}: ei vastaa verkossa (pois päältä tai syvässä valmiustilassa).`
      return `${c.name || 'Samsung'} (${c.model || 'Tizen'}): ${st === 'on' ? 'päällä' : st === 'standby' ? 'valmiustilassa' : st}.`
    }
    case 'paalle': {
      if ((await powerState()) === 'on') return 'Telkkari on jo päällä.'
      await magicPacket(c.mac, c.ip)
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 2500))
        const st = await powerState()
        if (st === 'on') return 'Telkkari päällä.'
        if (st === 'standby' && i === 1) await sendKeys(['KEY_POWER']).catch(() => {})
      }
      return 'Lähetin herätyksen, mutta telkkari ei vastannut. Tarkista telkkarin asetus: Yleiset → Verkko → Asiantuntija-asetukset → "Käynnistä mobiililaitteella" päälle.'
    }
    case 'pois': {
      if ((await powerState()) !== 'on') return 'Telkkari on jo pois päältä.'
      await sendKeys(['KEY_POWER'])
      return 'Telkkari pois päältä.'
    }
    case 'nappain': {
      const code = KEYS[String(a.nappi ?? '').toLowerCase()] ?? (/^KEY_[A-Z0-9_]+$/.test(String(a.nappi)) ? String(a.nappi) : null)
      if (!code) throw new Error(`Tuntematon näppäin "${a.nappi}". Käytössä: ${Object.keys(KEYS).join(', ')}`)
      const n = Math.max(1, Math.min(20, Number(a.maara) || 1))
      await sendKeys(Array(n).fill(code))
      return `Painettu ${a.nappi}${n > 1 ? ` ×${n}` : ''}.`
    }
    case 'avaa': {
      const q = String(a.sovellus ?? '').toLowerCase().trim()
      let id = APPS[q]
      if (!id) {
        const list = await installedApps().catch(() => [])
        id = list.find((x) => x.name.toLowerCase() === q)?.id ?? list.find((x) => x.name.toLowerCase().includes(q))?.id
        if (!id) return `En löytänyt sovellusta "${a.sovellus}". Asennetut: ${list.map((x) => x.name).slice(0, 30).join(', ') || '(lista ei saatavilla)'}`
      }
      const res = await fetch(`http://${c.ip}:8001/api/v2/applications/${id}`, { method: 'POST', signal: AbortSignal.timeout(6000) }).catch(() => null)
      if (!res?.ok) {
        // Vanhemmat mallit: käynnistys näppäinkanavan kautta.
        const ws = await connect()
        ws.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: id, action_type: 'NATIVE_LAUNCH' } } }))
        setTimeout(() => ws.close(), 500)
      }
      return `Avasin telkkarilla: ${a.sovellus}.`
    }
    case 'linkki': {
      const u = String(a.url ?? '')
      if (/spotify/.test(u)) {
        const { spotifyConfigured, spotifyPlay } = await import('./spotify.mjs')
        if (!spotifyConfigured()) return 'Spotify-linkkien soitto vaatii Spotify-yhteyden (tyokalut\\asenna_spotify.bat).'
        return spotifyPlay({ linkki: u, laite: 'samsung' })
      }
      const yt = u.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|live\/))([A-Za-z0-9_-]{6,20})/)
      if (!yt) return 'Samsungille osaan avata YouTube- ja Spotify-linkit. Muut: avaa sovellus ja hae sieltä.'
      const ws = await connect()
      ws.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: APPS.youtube, action_type: 'DEEP_LINK', metaTag: `v=${yt[1]}` } } }))
      setTimeout(() => ws.close(), 600)
      return 'Avasin YouTube-videon Samsungilla.'
    }
    case 'sovellukset': {
      const list = await installedApps()
      return list.length ? `Asennetut sovellukset: ${list.map((x) => x.name).join(', ')}` : 'Sovelluslistaa ei saatu.'
    }
    default:
      throw new Error(`Tuntematon toiminto ${action}`)
  }
}

export function tvServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const safe = (fn) => async (a) => {
    try {
      const r = await fn(a ?? {})
      console.log(`[jarvis] telkkari: ${String(r).slice(0, 120)}`)
      return ok(r)
    } catch (err) {
      console.log(`[jarvis] telkkari: virhe ${String(err?.message ?? err).slice(0, 160)}`)
      return { ...ok(`Telkkari: ${err?.message ?? err}`), isError: true }
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_telkkari',
    version: '1.0.0',
    instructions: 'Samsung Smart TV (Tizen) in the home network: power, remote keys, open apps, status. Different device from the XGIMI projector.',
    tools: [
      tool('samsung_tila', 'Samsung-telkkarin tila (päällä / valmiustila / ei verkossa).', {}, safe(() => tvCall('tila'))),
      tool('samsung_virta', 'Samsung-telkkari päälle (Wake-on-LAN) tai pois.', { tila: z.enum(['paalle', 'pois']) }, safe((a) => tvCall(a.tila))),
      tool(
        'samsung_nappain',
        `Samsung-telkkarin kaukosäätimen näppäin: ${Object.keys(KEYS).join(', ')}. maara = montako kertaa (esim. ääni+ 5).`,
        { nappi: z.string().max(30), maara: z.number().int().min(1).max(20).optional() },
        safe((a) => tvCall('nappain', a)),
      ),
      tool('samsung_avaa', 'Avaa sovelluksen Samsung-telkkarilla nimellä (Netflix, YouTube, Prime Video, Disney+, Spotify, Yle Areena tai muu asennettu).', { sovellus: z.string().max(40) }, safe((a) => tvCall('avaa', a))),
      tool('samsung_linkki', 'Avaa linkin Samsung-telkkarilla: YouTube-video (youtube.com/watch?v=…, youtu.be/…) tai Spotify-linkki (soittaa Spotify Connectilla).', { url: z.string().max(400) }, safe((a) => tvCall('linkki', a))),
      tool('samsung_sovellukset', 'Listaa Samsung-telkkarin asennetut sovellukset.', {}, safe(() => tvCall('sovellukset'))),
    ],
  })
}

// Asennusohjelma: node bridge/telkkari.mjs --pair IP [MAC] → yhdistää, telkkari kysyy "Salli", token talteen.
if (process.argv[2] === '--pair') {
  const ip = process.argv[3]
  const mac = process.argv[4] || ''
  ;(async () => {
    try {
      const d = await info(ip)
      const dev = d?.device ?? {}
      const prev = tvConfig() ?? {}
      saveConfig({ ...prev, ip, mac: mac || dev.wifiMac || prev.mac || '', name: dev.name || d?.name || 'Samsung', model: dev.modelName || '', os: dev.OS || 'Tizen', token: prev.ip === ip ? prev.token : undefined })
      console.log(`Löytyi: ${dev.name || d?.name} (${dev.modelName || '?'}, ${dev.OS || '?'})`)
      console.log('Paina nyt telkkarin ruudulla "Salli" (Allow), kun JARVIS kysyy lupaa...')
      const ws = await connect({ waitMs: 45_000 })
      ws.close()
      console.log(tvConfig()?.token ? 'Yhdistetty ja hyväksytty. Token tallennettu.' : 'Yhdistetty (tämä malli ei käytä tokenia).')
      process.exit(0)
    } catch (err) {
      console.log(`Ei onnistunut: ${err?.message ?? err}`)
      process.exit(1)
    }
  })()
}
