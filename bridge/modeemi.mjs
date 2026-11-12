/**
 * Kodin reititin: ZTE 5G -modeemi (192.168.32.1, ZTE:n web-hallinta /goform-rajapinta).
 *
 *   reititin_tila       verkko (5G/4G), operaattori, signaali, ulkoinen IP, datankulutus
 *   reititin_laitteet   yhdistetyt laitteet nimineen (wifi ja kaapeli)
 *   reititin_kaynnista  uudelleenkäynnistys: ESIKATSELU → Eliaksen oma "kyllä" → toteutus (netti katkeaa ~2–3 min)
 *
 * Salasana: tyokalut\asenna_reititin.bat tallentaa sen Windowsin DPAPI-salattuna (~/.jarvis/reititin.json, purettavissa vain
 * tällä käyttäjällä tällä koneella). Bridge purkaa sen muistiin kirjautumista varten. Malli EI koskaan näe salasanaa.
 * Asetuksiin (wifi-salasana, palomuuri, DHCP) ei kosketa.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG = join(homedir(), '.jarvis', 'reititin.json')
const cfg = () => {
  try {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')) : null
  } catch {
    return null
  }
}
export const routerConfigured = () => Boolean(cfg()?.host && cfg()?.pwd)

let secret = null
function password() {
  if (secret) return Promise.resolve(secret)
  const c = cfg()
  if (!c?.pwd) return Promise.reject(new Error('Reititintä ei ole yhdistetty: aja tyokalut\\asenna_reititin.bat.'))
  return new Promise((resolve, reject) => {
    const ps =
      `$s = ConvertTo-SecureString '${String(c.pwd).replace(/'/g, '')}'; ` +
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      if (err || !String(out).trim()) return reject(new Error('Reitittimen salasanaa ei saatu purettua (aja asenna_reititin.bat uudelleen).'))
      secret = String(out).replace(/\r?\n$/, '')
      resolve(secret)
    })
  })
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex').toUpperCase()
let cookie = ''
let loggedAt = 0

async function http(path, { method = 'GET', body } = {}) {
  const host = cfg()?.host ?? '192.168.32.1'
  const res = await fetch(`http://${host}${path}`, {
    method,
    headers: {
      Referer: `http://${host}/index.html`,
      'X-Requested-With': 'XMLHttpRequest',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
    signal: AbortSignal.timeout(8000),
  })
  const sc = res.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]
  const t = await res.text()
  try {
    return JSON.parse(t)
  } catch {
    return { raw: t.slice(0, 300) }
  }
}
const get = (cmd, multi = true) => http(`/goform/goform_get_cmd_process?isTest=false&cmd=${encodeURIComponent(cmd)}${multi ? '&multi_data=1' : ''}&_=${Date.now()}`)
const set = (params) => http('/goform/goform_set_cmd_process', { method: 'POST', body: new URLSearchParams({ isTest: 'false', ...params }).toString() })

/** Kirjautuminen: uudemmat ZTE:t SHA256(SHA256(salasana) + LD), vanhemmat base64(salasana). */
async function login() {
  if (Date.now() - loggedAt < 4 * 60_000) return
  const pwd = await password()
  const ld = (await get('LD', false).catch(() => ({})))?.LD
  let r = ld ? await set({ goformId: 'LOGIN', password: sha256(sha256(pwd) + ld) }) : null
  if (!r || String(r.result) !== '0') r = await set({ goformId: 'LOGIN', password: Buffer.from(pwd).toString('base64') })
  if (String(r?.result) === '3') throw new Error('Reititin hylkäsi salasanan (aja asenna_reititin.bat uudelleen).')
  if (!['0', '4'].includes(String(r?.result))) throw new Error(`Reitittimeen kirjautuminen ei onnistunut (vastaus ${JSON.stringify(r).slice(0, 80)}).`)
  loggedAt = Date.now()
}

/** Asetuskomentojen AD-tunniste (uudemmat ZTE:t vaativat). */
async function adToken() {
  const v = await get('wa_inner_version,cr_version').catch(() => ({}))
  const rd = (await get('RD', false).catch(() => ({})))?.RD
  if (!rd) return null
  return sha256(sha256(`${v.wa_inner_version ?? ''}${v.cr_version ?? ''}`) + rd)
}

const gb = (b) => (Number(b) > 0 ? `${(Number(b) / 1e9).toFixed(1)} Gt` : '?')

export async function routerStatus() {
  await login()
  const d = await get(
    'network_type,network_provider,signalbar,Z5g_rsrp,Z5g_SINR,Z5g_rsrq,lte_rsrp,lte_snr,rssi,wan_ipaddr,ppp_status,modem_main_state,' +
      'monthly_rx_bytes,monthly_tx_bytes,realtime_rx_thrpt,realtime_tx_thrpt,model_name,wa_inner_version,hardware_version,sta_count,battery_charging',
  )
  const five = d.Z5g_rsrp && d.Z5g_rsrp !== ''
  const sig = five ? `5G RSRP ${d.Z5g_rsrp} dBm, SINR ${d.Z5g_SINR ?? '?'} dB` : d.lte_rsrp ? `4G RSRP ${d.lte_rsrp} dBm, SNR ${d.lte_snr ?? '?'} dB` : `palkkeja ${d.signalbar ?? '?'}/5`
  const rate = (x) => (Number(x) > 0 ? `${((Number(x) * 8) / 1e6).toFixed(1)} Mbit/s` : '0')
  return [
    `Reititin ${d.model_name || 'ZTE'}${d.wa_inner_version ? ` (${d.wa_inner_version})` : ''}`,
    `Verkko: ${d.network_type || '?'} · ${d.network_provider || '?'} · ${d.ppp_status === 'ppp_connected' || d.wan_ipaddr ? 'yhteys päällä' : `tila ${d.ppp_status || d.modem_main_state || '?'}`}`,
    `Signaali: ${sig}`,
    `Nyt: alas ${rate(d.realtime_rx_thrpt)}, ylös ${rate(d.realtime_tx_thrpt)} · tässä kuussa ${gb(d.monthly_rx_bytes)} alas / ${gb(d.monthly_tx_bytes)} ylös`,
    d.sta_count ? `Wifi-laitteita: ${d.sta_count}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function routerDevices() {
  await login()
  const d = await get('station_list,lan_station_list,wifi_station_list').catch(() => ({}))
  const rows = [...(d.station_list ?? []), ...(d.lan_station_list ?? []), ...(d.wifi_station_list ?? [])]
  if (!rows.length) {
    const alt = await http(`/goform/goform_get_cmd_process?isTest=false&cmd=station_list&_=${Date.now()}`).catch(() => ({}))
    rows.push(...(alt.station_list ?? []))
  }
  const seen = new Set()
  const list = []
  for (const r of rows) {
    const mac = String(r.mac_addr ?? r.mac ?? '').toLowerCase()
    if (!mac || seen.has(mac)) continue
    seen.add(mac)
    list.push(`• ${r.hostname || r.host_name || '(nimetön)'} · ${r.ip_addr ?? r.ip ?? '?'} · ${mac}${r.connect_type ? ` · ${r.connect_type}` : ''}`)
  }
  return list.length ? `Reitittimeen yhdistetyt (${list.length}):\n${list.join('\n')}` : 'Reititin ei antanut laitelistaa (malli voi käyttää eri nimeä). Käytä verkko_laitteet.'
}

// --- uudelleenkäynnistys vahvistuksella ---------------------------------------------------------
let lastUser = { text: '', at: 0 }
export function noteUserMessage(text) {
  lastUser = { text: String(text ?? ''), at: Date.now() }
}
const YES = /^\s*(kyllä|kyl|joo|juu|ok|okei|tee se|käynnistä|käynnistä uudelleen|sopii|yes|go)(?!\p{L})/iu
let pending = null

export function routerServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const safe = (fn) => async (a) => {
    try {
      return ok(await fn(a ?? {}))
    } catch (err) {
      return ok(`Reititin: ${err?.message ?? err}`)
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_reititin',
    version: '1.0.0',
    instructions:
      'Kodin ZTE 5G -reititin: tila (signaali, verkko, datankulutus), yhdistetyt laitteet ja uudelleenkäynnistys vahvistuksella. ' +
      'Et näe salasanaa etkä muuta asetuksia (wifi, palomuuri, DHCP).',
    tools: [
      tool('reititin_tila', 'Reitittimen tila: 5G/4G, operaattori, signaalin vahvuus, nopeus nyt ja kuukauden datankulutus. Käytä kun netti on hidas.', {}, safe(routerStatus)),
      tool('reititin_laitteet', 'Reitittimeen yhdistetyt laitteet nimineen (luotettavampi kuin verkkoskannaus).', {}, safe(routerDevices)),
      tool(
        'reititin_kaynnista',
        'Reitittimen uudelleenkäynnistys. vahvista=false → esikatselu (kysy käyttäjältä); vahvista=true vasta kun käyttäjä on vastannut myöntävästi. ' +
          'Koko kodin netti ja JARVISin Telegram-yhteys katkeaa 2–3 minuutiksi.',
        { vahvista: z.boolean().optional() },
        safe(async (a) => {
          if (!a.vahvista) {
            pending = { at: Date.now() }
            return 'ESIKATSELU: käynnistän reitittimen uudelleen. Koko kodin netti (myös projektori ja Telegram-yhteys minuun) katkeaa noin 2–3 minuutiksi. Kysy käyttäjältä "Käynnistänkö reitittimen uudelleen?" ja kutsu vahvista=true vasta hänen myöntävän vastauksensa jälkeen.'
          }
          if (!pending || Date.now() - pending.at > 3 * 60_000) return 'Tee ensin esikatselu (vahvista=false) ja kysy käyttäjältä.'
          if (!(lastUser.at > pending.at && YES.test(lastUser.text))) return 'Käyttäjä ei ole vielä vahvistanut omalla viestillään.'
          pending = null
          await login()
          const AD = await adToken()
          const r = await set({ goformId: 'REBOOT_DEVICE', ...(AD ? { AD } : {}) })
          console.log(`[jarvis] reititin: uudelleenkäynnistys (${JSON.stringify(r).slice(0, 60)})`)
          return String(r?.result) === 'success' || String(r?.result) === '0'
            ? 'Reititin käynnistyy uudelleen. Netti palaa noin 2–3 minuutissa; vastaan Telegramissa taas sen jälkeen.'
            : `Reititin ei hyväksynyt komentoa (${JSON.stringify(r).slice(0, 80)}).`
        }),
      ),
    ],
  })
}
