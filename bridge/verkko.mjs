/**
 * Kotiverkko: mitä laitteita wifissä on ja niiden ohjaus paikallisverkon kautta.
 *
 *   verkko_tila        koneen IP, reititin, nettiyhteys
 *   verkko_laitteet    skannaa verkon (ARP + porttikoettimet): IP, MAC, nimi, mitä laite todennäköisesti on
 *   verkko_nimea       antaa laitteelle nimen ("olohuoneen valo") → ~/.jarvis/laitteet.json
 *   verkko_pyynto      HTTP GET/POST kotiverkon laitteen omaan rajapintaan (esim. Shelly, WLED, Hue-silta, Tasmota)
 *   verkko_heratys     Wake-on-LAN-paketti laitteelle (MAC)
 *
 * Turva: pyynnöt vain yksityisiin osoitteisiin (192.168.x, 10.x, 172.16–31.x), EI reitittimeen (reitittimen hallinta
 * vaatii salasanan ja väärä asetus katkaisee koko kodin netin) eikä tähän koneeseen. Ei salasanoja pyynnöissä.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { reverse } from 'node:dns/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

const NAMES = join(homedir(), '.jarvis', 'laitteet.json')
const loadNames = () => {
  try {
    return existsSync(NAMES) ? JSON.parse(readFileSync(NAMES, 'utf8').replace(/^\uFEFF/, '')) : {}
  } catch {
    return {}
  }
}
const saveNames = (n) => {
  const dir = join(homedir(), '.jarvis')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(NAMES, JSON.stringify(n, null, 1))
}

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)

function localNet() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && isPrivate(a.address) && a.netmask === '255.255.255.0') {
        return { ip: a.address, prefix: a.address.replace(/\.\d+$/, ''), mac: a.mac }
      }
    }
  }
  return null
}

function cmd(file, args, timeoutMs = 15_000) {
  return new Promise((resolve) => execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, out) => resolve(err ? '' : String(out))))
}

async function gateway() {
  if (process.platform !== 'win32') return ''
  const out = await cmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop"])
  return out.trim()
}

/** Herättää ARP-taulun: pieni UDP-paketti jokaiseen osoitteeseen (ei vaadi järjestelmänvalvojaa). */
function touchAll(prefix) {
  return new Promise((resolve) => {
    const s = createSocket('udp4')
    s.once('error', () => (s.close(), resolve()))
    s.bind(() => {
      let n = 0
      for (let i = 1; i < 255; i++) s.send(Buffer.from([0]), 9, `${prefix}.${i}`, () => ++n === 254 && setTimeout(() => (s.close(), resolve()), 1500))
    })
  })
}

async function arpTable(prefix) {
  const out = await cmd('arp', ['-a'])
  const rows = []
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}([-:][0-9a-f]{2}){5})\s+(\w+)/i)
    if (!m || !m[1].startsWith(`${prefix}.`) || /ff-ff-ff|^01-00-5e/i.test(m[2]) || m[1].endsWith('.255')) continue
    rows.push({ ip: m[1], mac: m[2].replace(/-/g, ':').toLowerCase() })
  }
  return rows
}

function portOpen(ip, port, ms = 700) {
  return new Promise((resolve) => {
    const s = new Socket()
    const done = (v) => (s.destroy(), resolve(v))
    s.setTimeout(ms)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
    s.connect(port, ip)
  })
}

const PORTS = [
  [5555, 'Android TV / ADB'], [8008, 'Chromecast / Google Cast'], [8009, 'Google Cast'], [1400, 'Sonos'], [8060, 'Roku'],
  [8001, 'Samsung TV'], [3000, 'LG webOS TV'], [55443, 'Yeelight-valo'], [6668, 'Tuya-älylaite'], [9123, 'Elgato'], [80, 'web'], [443, 'https'],
]

async function httpTitle(ip) {
  try {
    const res = await fetch(`http://${ip}/`, { signal: AbortSignal.timeout(1500), redirect: 'manual' })
    const t = (await res.text()).slice(0, 4000)
    const title = t.match(/<title>([^<]{1,80})<\/title>/i)?.[1]?.trim() ?? ''
    const server = res.headers.get('server') ?? ''
    return [title, server].filter(Boolean).join(' · ')
  } catch {
    return ''
  }
}

function guessKind(d) {
  const s = `${d.title} ${d.host} ${d.services.join(' ')}`.toLowerCase()
  if (/hue/.test(s)) return 'Philips Hue -silta (valot)'
  if (/shelly/.test(s)) return 'Shelly (rele/valo/pistorasia)'
  if (/wled/.test(s)) return 'WLED-valonauha'
  if (/tasmota/.test(s)) return 'Tasmota-älylaite'
  if (/dirigera|tradfri|ikea/.test(s)) return 'IKEA-älykeskus'
  if (/xgimi|xk03h/.test(s) || d.mac?.startsWith('50:e4:78')) return 'XGIMI-projektori'
  if (/android tv|adb/.test(s)) return 'Android TV -laite'
  if (/cast/.test(s)) return 'Chromecast / Google-laite'
  if (/samsung/.test(s)) return 'Samsung TV'
  if (/webos|lg/.test(s)) return 'LG TV'
  if (/sonos/.test(s)) return 'Sonos-kaiutin'
  if (/yeelight/.test(s)) return 'Yeelight-valo'
  if (/tuya/.test(s)) return 'Tuya-älylaite (esim. halpa pistorasia/lamppu)'
  if (/iphone|ipad|macbook|android-|galaxy|pixel/.test(s)) return 'puhelin/tabletti/kannettava'
  if (/printer|tulostin|hp|epson|canon|brother/.test(s)) return 'tulostin'
  return ''
}

export async function scanNetwork() {
  const net = localNet()
  if (!net) throw new Error('Koneen kotiverkkoa ei tunnistettu.')
  const gw = await gateway()
  await touchAll(net.prefix)
  const rows = await arpTable(net.prefix)
  const names = loadNames()
  const out = []
  for (let i = 0; i < rows.length; i += 12) {
    const batch = await Promise.all(
      rows.slice(i, i + 12).map(async (r) => {
        const [host, open] = await Promise.all([
          reverse(r.ip).then((h) => h[0] ?? '').catch(() => ''),
          Promise.all(PORTS.map(([p, label]) => portOpen(r.ip, p).then((o) => (o ? label : null)))),
        ])
        const services = open.filter(Boolean)
        const title = services.includes('web') ? await httpTitle(r.ip) : ''
        const d = { ...r, host, services: services.filter((x) => x !== 'web' && x !== 'https'), title, router: r.ip === gw }
        d.kind = d.router ? 'reititin (5G Gateway)' : guessKind(d)
        d.name = names[r.mac]?.name ?? ''
        return d
      }),
    )
    out.push(...batch)
  }
  return { me: net.ip, gateway: gw, devices: out.sort((a, b) => Number(a.ip.split('.').pop()) - Number(b.ip.split('.').pop())) }
}

function magic(mac, prefix) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, '')
  if (hex.length !== 12) return Promise.resolve(false)
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(hex, 'hex'))])
  return new Promise((resolve) => {
    const s = createSocket('udp4')
    s.once('error', () => (s.close(), resolve(false)))
    s.bind(() => {
      s.setBroadcast(true)
      s.send(pkt, 9, `${prefix}.255`, () => s.send(pkt, 9, '255.255.255.255', () => (s.close(), resolve(true))))
    })
  })
}

/** Nimi laitteelle MAC-osoitteella (myös käyttöliittymästä). */
export function nameDevice(mac, name, note = '') {
  const m = String(mac).toLowerCase().replace(/-/g, ':')
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m) || String(name).trim().length < 2) throw new Error('MAC tai nimi ei kelpaa.')
  const n = loadNames()
  n[m] = { name: String(name).trim().slice(0, 60), note: String(note).slice(0, 300), at: new Date().toISOString() }
  saveNames(n)
  return `Tallennettu: ${n[m].name}.`
}

export function networkServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  return createSdkMcpServer({
    name: 'jarvis_verkko',
    version: '1.0.0',
    instructions:
      'Kotiverkon laitteet: verkko_laitteet näyttää mitä wifissä on, verkko_nimea muistaa nimet, verkko_pyynto ohjaa laitteita niiden omalla ' +
      'paikallisella HTTP-rajapinnalla (Shelly, WLED, Tasmota, Hue-silta ym.), verkko_heratys herättää laitteen (WoL). Projektorille on omat ' +
      'projektori_*-työkalut. Reitittimen hallintaan sinulla ei ole pääsyä.',
    tools: [
      tool('verkko_tila', 'Koneen IP, reitittimen osoite ja toimiiko nettiyhteys.', {}, async () => {
        const net = localNet()
        const gw = await gateway()
        const online = await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(4000) }).then((r) => r.status === 204).catch(() => false)
        return ok(`Kone ${net?.ip ?? '?'} · reititin ${gw || '?'} · netti ${online ? 'toimii' : 'EI toimi'}`)
      }),
      tool('verkko_laitteet', 'Skannaa kotiverkon laitteet (n. 20–40 s): IP, MAC, nimi, mitä laite todennäköisesti on ja mitkä ohjausportit ovat auki.', {}, async () => {
        try {
          const r = await scanNetwork()
          const lines = r.devices.map(
            (d) =>
              `• ${d.ip}${d.ip === r.me ? ' (tämä kone)' : ''}  ${d.mac}${d.name ? `  "${d.name}"` : ''}${d.kind ? `  — ${d.kind}` : ''}${d.host ? `  [${d.host}]` : ''}` +
              `${d.services.length ? `  portit: ${d.services.join(', ')}` : ''}${d.title ? `  web: ${d.title}` : ''}`,
          )
          return ok(`Kotiverkko (${r.devices.length} laitetta, reititin ${r.gateway}):\n${lines.join('\n')}\n\nJos laitteen tyyppi on epäselvä, kysy käyttäjältä mikä se on ja tallenna nimi verkko_nimea-työkalulla.`)
        } catch (err) {
          return ok(`Skannaus epäonnistui: ${err?.message ?? err}`)
        }
      }),
      tool(
        'verkko_nimea',
        'Tallentaa laitteelle nimen ja tyypin MAC-osoitteella (pysyy vaikka IP vaihtuu), esim. "olohuoneen valo", "Shelly", ohjausohje.',
        { mac: z.string().regex(/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/), nimi: z.string().min(2).max(60), muistiinpano: z.string().max(300).optional() },
        async (a) => ok(nameDevice(a.mac, a.nimi, a.muistiinpano ?? '')),
      ),
      tool(
        'verkko_pyynto',
        'HTTP-pyyntö kotiverkon laitteen omaan rajapintaan, esim. Shelly http://192.168.32.50/relay/0?turn=on, WLED /json/state, Tasmota /cm?cmnd=Power%20On. ' +
          'Vain kotiverkon osoitteisiin, ei reitittimeen.',
        {
          url: z.string().url().max(600),
          menetelma: z.enum(['GET', 'POST', 'PUT']).optional(),
          runko: z.string().max(4000).optional().describe('JSON-runko POST/PUT-pyynnölle'),
        },
        async (a) => {
          let u
          try {
            u = new URL(a.url)
          } catch {
            return ok('Osoite ei kelpaa.')
          }
          if (!/^https?:$/.test(u.protocol) || !isPrivate(u.hostname)) return ok('Estetty: vain kotiverkon laitteisiin (192.168.x.x ym.).')
          const gw = await gateway()
          if (u.hostname === gw) return ok('Estetty: reitittimen asetuksiin en koske (vaatii salasanan, ja väärä asetus katkaisee kodin netin). Käyttäjä voi tehdä sen itse.')
          if (u.hostname === localNet()?.ip) return ok('Estetty: tähän koneeseen ei tehdä verkkopyyntöjä tätä kautta.')
          if (/pass(word)?=|token=|apikey=|key=/i.test(u.search)) return ok('Estetty: en lähetä salasanoja tai avaimia osoitteessa.')
          try {
            const res = await fetch(u, {
              method: a.menetelma ?? 'GET',
              headers: a.runko ? { 'content-type': 'application/json' } : undefined,
              body: a.runko && a.menetelma && a.menetelma !== 'GET' ? a.runko : undefined,
              signal: AbortSignal.timeout(6000),
              redirect: 'manual',
            })
            const t = (await res.text()).slice(0, 3000)
            return ok(`HTTP ${res.status}\n${t}`)
          } catch (err) {
            return ok(`Laite ei vastannut: ${err?.message ?? err}`)
          }
        },
      ),
      tool('verkko_heratys', 'Lähettää Wake-on-LAN-paketin laitteelle MAC-osoitteella (toimii laitteille, jotka tukevat herätystä verkosta).', { mac: z.string() }, async (a) => {
        const net = localNet()
        const sent = await magic(a.mac, net?.prefix ?? '192.168.1')
        return ok(sent ? 'Herätyspaketti lähetetty.' : 'MAC-osoite ei kelpaa.')
      }),
    ],
  })
}
