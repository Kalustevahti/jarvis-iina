/**
 * Valot: Tuya-pohjaiset lamput (Conecto, Smart Life -sovellus) Tuyan pilvirajapinnan kautta.
 *
 *   Asennus: tyokalut\asenna_valot.bat — Tuya IoT -projektin Access ID + Secret (DPAPI-salattuna ~/.jarvis/tuya.json),
 *   alue (eu), sovellustili linkitetty projektiin (QR). Lamput listataan ja nimetään ("makuuhuone", "olohuone").
 *
 *   valot          lista + tila (päällä, kirkkaus, väri)
 *   valo_aseta     nimi|kaikki: paalle, kirkkaus 1–100, lampotila 0–100 (lämmin→kylmä), vari (punainen, sininen… tai #rrggbb tai "h,s")
 *   valo_nimea     laitteen id → nimi
 *
 * Tuya-koodit vaihtelevat lamppumalleittain (switch_led/switch_1, bright_value_v2/bright_value, colour_data_v2/colour_data):
 * tila luetaan ensin ja käytetään niitä koodeja, jotka laite oikeasti ilmoittaa.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG = join(homedir(), '.jarvis', 'tuya.json')
const HOSTS = { eu: 'https://openapi.tuyaeu.com', us: 'https://openapi.tuyaus.com', cn: 'https://openapi.tuyacn.com', in: 'https://openapi.tuyain.com', 'eu-w': 'https://openapi-weaz.tuyaeu.com' }
const cfg = () => {
  try {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')) : null
  } catch {
    return null
  }
}
export const lightsConfigured = () => Boolean(cfg()?.accessId && cfg()?.secret)
const saveCfg = (c) => writeFileSync(CONFIG, JSON.stringify(c))

let secret = null
function secretKey() {
  if (secret) return Promise.resolve(secret)
  const c = cfg()
  if (!c?.secret) return Promise.reject(new Error('Valoja ei ole yhdistetty: aja tyokalut\\asenna_valot.bat.'))
  if (process.platform !== 'win32') return Promise.resolve((secret = c.secret))
  return new Promise((resolve, reject) => {
    const ps = `$s = ConvertTo-SecureString '${String(c.secret).replace(/'/g, '')}'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      if (err || !String(out).trim()) return reject(new Error('Tuya-avainta ei saatu purettua (aja asenna_valot.bat uudelleen).'))
      resolve((secret = String(out).replace(/\r?\n$/, '')))
    })
  })
}

// --- Tuya OpenAPI (HMAC-SHA256-allekirjoitus) -------------------------------------------------------
let token = { value: '', until: 0 }
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
async function call(method, path, body) {
  const c = cfg()
  const host = HOSTS[c.region] ?? HOSTS.eu
  const key = await secretKey()
  const t = String(Date.now())
  const nonce = randomUUID()
  const bodyStr = body ? JSON.stringify(body) : ''
  const needToken = !path.startsWith('/v1.0/token')
  if (needToken && Date.now() > token.until) await refreshToken()
  const stringToSign = `${method}\n${sha256(bodyStr)}\n\n${path}`
  const sign = createHmac('sha256', key).update(`${c.accessId}${needToken ? token.value : ''}${t}${nonce}${stringToSign}`).digest('hex').toUpperCase()
  const res = await fetch(`${host}${path}`, {
    method,
    headers: { client_id: c.accessId, sign, t, nonce, sign_method: 'HMAC-SHA256', ...(needToken ? { access_token: token.value } : {}), 'Content-Type': 'application/json' },
    body: bodyStr || undefined,
    signal: AbortSignal.timeout(10_000),
  })
  const j = await res.json().catch(() => ({}))
  if (!j.success) throw new Error(`Tuya ${j.code ?? res.status}: ${j.msg ?? 'virhe'}`)
  return j.result
}
async function refreshToken() {
  token = { value: '', until: 0 }
  const r = await call('GET', '/v1.0/token?grant_type=1')
  token = { value: r.access_token, until: Date.now() + (Number(r.expire_time) - 60) * 1000 }
}

// --- laitteet -----------------------------------------------------------------------------------------
let cache = { at: 0, list: [] }
export async function listLights(force = false) {
  if (!force && Date.now() - cache.at < 60_000 && cache.list.length) return cache.list
  const r = await call('GET', '/v1.0/iot-01/associated-users/devices?size=100')
  const names = cfg()?.names ?? {}
  const list = (r?.devices ?? [])
    .filter((d) => /^(dj|dd|xdd|dc|tgq|fwd|dsd)$/.test(d.category) || /lamp|led|bulb|valo|light/i.test(d.name)) // dj = valaisin
    .map((d) => ({ id: d.id, name: names[d.id] || d.name, raw: d.name, online: Boolean(d.online), category: d.category }))
  cache = { at: Date.now(), list }
  return list
}
async function status(id) {
  const r = await call('GET', `/v1.0/iot-03/devices/${id}/status`)
  return Object.fromEntries((r ?? []).map((x) => [x.code, x.value]))
}
const pick = (st, ...codes) => codes.find((c) => c in st)

const COLORS = {
  punainen: [0, 1000], eroottinen: [350, 1000], oranssi: [25, 1000], keltainen: [50, 1000], vihreä: [120, 1000], vihrea: [120, 1000], turkoosi: [180, 1000],
  sininen: [220, 1000], violetti: [275, 1000], lila: [275, 700], pinkki: [330, 800], vaaleanpunainen: [330, 500], valkoinen: null, lämmin: 'warm', lammin: 'warm', kylmä: 'cool', kylma: 'cool',
}
function parseColor(s) {
  const t = String(s ?? '').trim().toLowerCase()
  if (!t) return null
  if (COLORS[t] !== undefined) return COLORS[t]
  const hex = t.match(/^#?([0-9a-f]{6})$/)
  if (hex) {
    const r = parseInt(hex[1].slice(0, 2), 16) / 255, g = parseInt(hex[1].slice(2, 4), 16) / 255, b = parseInt(hex[1].slice(4, 6), 16) / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
    let h = 0
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h = Math.round((h * 60 + 360) % 360)
    return [h, Math.round(max ? (d / max) * 1000 : 0)]
  }
  const hs = t.match(/^(\d{1,3})\s*,\s*(\d{1,4})$/)
  if (hs) return [Number(hs[1]) % 360, Math.min(1000, Number(hs[2]))]
  return undefined
}

/**
 * Pure: Tuya commands for one lamp from its status (st) and the request. → { cmds, done } or { error }.
 * Fixes (Koti-sivu 10.11.2026): brightness in colour mode goes into colour_data.v (bright_value only affects white mode,
 * so the slider "did nothing" after picking a colour); switching white → colour (and back) keeps the current brightness
 * instead of jumping to the colour's old v (dim/wrong-looking colours).
 */
export function planLight(st, { paalle, kirkkaus, lampotila, vari } = {}) {
  const sw = pick(st, 'switch_led', 'switch_1', 'switch') ?? 'switch_led'
  const mode = pick(st, 'work_mode')
  const bright = pick(st, 'bright_value_v2', 'bright_value')
  const temp = pick(st, 'temp_value_v2', 'temp_value')
  const colour = pick(st, 'colour_data_v2', 'colour_data')
  const v2 = bright === 'bright_value_v2' || colour === 'colour_data_v2'
  const scale = v2 ? 1000 : 255
  const minV = v2 ? 10 : 25
  const cmds = []
  const done = []
  const color = vari !== undefined ? parseColor(vari) : undefined
  if (color === undefined && vari) return { error: `Tuntematon väri "${vari}". Käytä esim. punainen, sininen, lämmin, kylmä, valkoinen tai #ff0040.` }
  const hsv = (() => {
    try {
      const c = typeof st[colour] === 'string' ? JSON.parse(st[colour]) : st[colour]
      return c && typeof c === 'object' ? { h: Number(c.h) || 0, s: Number(c.s) || 0, v: Number(c.v) || 0 } : null
    } catch {
      return null
    }
  })()
  const inColour = st[mode] === 'colour'
  if (paalle === false) {
    cmds.push({ code: sw, value: false })
    done.push('pois')
    return { cmds, done }
  }
  if (paalle === true || kirkkaus != null || color !== undefined || lampotila != null) {
    cmds.push({ code: sw, value: true })
    done.push('päälle')
  }
  const reqV = kirkkaus != null ? Math.max(minV, Math.round((Math.max(1, Math.min(100, kirkkaus)) / 100) * scale)) : null
  if (Array.isArray(color)) {
    if (!colour) return { error: 'Tämä lamppu ei tue värejä (vain valkoinen).' }
    // Brightness: asked → that; already in colour → keep its v; from white → the white brightness, so the colour looks as bright.
    const v = reqV ?? (inColour && hsv?.v ? hsv.v : bright && Number(st[bright]) ? Number(st[bright]) : hsv?.v || scale)
    cmds.push({ code: 'work_mode', value: 'colour' }, { code: colour, value: JSON.stringify({ h: color[0], s: v2 ? color[1] : Math.round((color[1] / 1000) * 255), v: Math.max(minV, Math.min(scale, v)) }) })
    done.push(`väri ${vari}`)
    if (reqV != null) done.push(`kirkkaus ${kirkkaus} %`)
    return { cmds, done }
  }
  const toWhite = color === null || color === 'warm' || color === 'cool' || lampotila != null
  if (toWhite) {
    if (mode) cmds.push({ code: 'work_mode', value: 'white' })
    const tv = lampotila != null ? lampotila : color === 'warm' ? 0 : color === 'cool' ? 100 : null
    if (tv != null && temp) {
      cmds.push({ code: temp, value: Math.round((Math.max(0, Math.min(100, tv)) / 100) * scale) })
      done.push(`sävy ${tv === 0 ? 'lämmin' : tv === 100 ? 'kylmä' : `${tv} %`}`)
    } else done.push('valkoinen')
    // From colour to white without a brightness: keep the colour's brightness.
    if (reqV == null && inColour && hsv?.v && bright) cmds.push({ code: bright, value: Math.max(minV, hsv.v) })
  }
  if (reqV != null) {
    if (inColour && !toWhite && colour && hsv) {
      cmds.push({ code: colour, value: JSON.stringify({ ...hsv, v: reqV }) })
      done.push(`kirkkaus ${kirkkaus} % (värissä)`)
    } else if (bright) {
      cmds.push({ code: bright, value: reqV })
      done.push(`kirkkaus ${kirkkaus} %`)
    }
  }
  return { cmds, done }
}

// One lamp at a time, in order: the Koti-sivu sends many commands while a slider is dragged, and parallel
// status-read + write pairs could land in Tuya out of order (an older colour/white command winning).
const lanes = new Map()
function inLane(id, fn) {
  const prev = lanes.get(id) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  lanes.set(id, run.catch(() => {}))
  return run
}
// Tuya's status lags a moment behind a command: what we just sent overrides the read for 15 s.
const sent = new Map()
const SENT_TTL = 15_000

/** Asettaa yhden lampun. Palauttaa kuvauksen. */
function setLight(dev, opts) {
  return inLane(dev.id, async () => {
    const st = await status(dev.id)
    const recent = sent.get(dev.id)
    if (recent && Date.now() - recent.at < SENT_TTL) Object.assign(st, recent.values)
    const plan = planLight(st, opts)
    if (plan.error) return `${dev.name}: ${plan.error}`
    if (!plan.cmds.length) return `${dev.name}: ei muutosta.`
    await call('POST', `/v1.0/iot-03/devices/${dev.id}/commands`, { commands: plan.cmds })
    const values = { ...(recent && Date.now() - recent.at < SENT_TTL ? recent.values : {}) }
    for (const c of plan.cmds) values[c.code] = c.value
    sent.set(dev.id, { at: Date.now(), values })
    return `${dev.name}: ${plan.done.join(', ')}`
  })
}

function match(list, nimi) {
  const q = String(nimi ?? 'kaikki').toLowerCase().trim()
  if (!q || q === 'kaikki' || q === 'valot') return list
  const hit = list.filter((d) => d.name.toLowerCase().includes(q) || d.raw.toLowerCase().includes(q))
  return hit.length ? hit : null
}

export async function setLights(nimi, opts) {
  const list = await listLights()
  if (!list.length) return 'Lamppuja ei löytynyt Tuya-tililtä. Onko sovellustili linkitetty projektiin (asenna_valot.bat)?'
  const targets = match(list, nimi)
  if (!targets) return `Valoa "${nimi}" ei ole. Valot: ${list.map((d) => d.name).join(', ')}. Nimeä: valo_nimea.`
  // Kaikki lamput samaan aikaan (ei yksi kerrallaan): komennot lähtevät rinnakkain.
  const out = await Promise.all(
    targets.map((d) =>
      !d.online ? `${d.name}: offline (katkaisija pois tai ei wifissä)` : setLight(d, opts).catch((err) => `${d.name}: ${err.message}`),
    ),
  )
  return out.join('\n')
}

export async function lightsText() {
  const list = await listLights(true)
  if (!list.length) return 'Lamppuja ei löytynyt. Linkitä sovellustili Tuya-projektiin (asenna_valot.bat) ja tarkista, että lamput ovat online Smart Life -sovelluksessa.'
  const lines = []
  for (const d of list) {
    if (!d.online) {
      lines.push(`• ${d.name}: offline`)
      continue
    }
    try {
      const st = await status(d.id)
      const on = st[pick(st, 'switch_led', 'switch_1', 'switch') ?? ''] ? 'päällä' : 'pois'
      const b = st[pick(st, 'bright_value_v2', 'bright_value') ?? '']
      const scale = 'bright_value_v2' in st ? 1000 : 255
      lines.push(`• ${d.name}: ${on}${b != null ? `, kirkkaus ${Math.round((Number(b) / scale) * 100)} %` : ''}${st.work_mode ? `, tila ${st.work_mode === 'colour' ? 'väri' : st.work_mode}` : ''}`)
    } catch (err) {
      lines.push(`• ${d.name}: tila ei saatavilla (${err.message})`)
    }
  }
  return `Valot (${list.length}):\n${lines.join('\n')}`
}

export function nameLight(idOrName, nimi) {
  const c = cfg() ?? {}
  const list = cache.list
  const d = list.find((x) => x.id === idOrName) ?? list.find((x) => x.name.toLowerCase() === String(idOrName).toLowerCase()) ?? list.find((x) => x.raw.toLowerCase().includes(String(idOrName).toLowerCase()))
  if (!d) return `Lamppua "${idOrName}" ei löydy. Listaa ensin: valot.`
  c.names = { ...(c.names ?? {}), [d.id]: String(nimi).trim().slice(0, 40) }
  saveCfg(c)
  d.name = c.names[d.id]
  return `Nimetty: ${d.raw} → ${d.name}.`
}

export function lightsServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const safe = (fn) => async (a) => {
    try {
      return ok(await fn(a ?? {}))
    } catch (err) {
      return ok(`Valot: ${err?.message ?? err}`)
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_valot',
    version: '1.0.0',
    instructions: 'Kodin lamput (Tuya/Smart Life). Nimet: valo_nimea. "kaikki" = kaikki lamput. Offline-lamppu = virta pois katkaisijasta.',
    tools: [
      tool('valot', 'Listaa lamput ja niiden tilan (päällä/pois, kirkkaus, tila).', {}, safe(lightsText)),
      tool(
        'valo_aseta',
        'Säätää lampun tai kaikki: nimi ("makuuhuone", "kaikki"), paalle true/false, kirkkaus 1–100 %, lampotila 0 (lämmin) – 100 (kylmä), ' +
          'vari (punainen, eroottinen, oranssi, keltainen, vihreä, sininen, violetti, pinkki, valkoinen, lämmin, kylmä, #rrggbb). Yhdistelmät sallittu: vari + kirkkaus.',
        {
          nimi: z.string().max(40).optional(),
          paalle: z.boolean().optional(),
          kirkkaus: z.number().int().min(1).max(100).optional(),
          lampotila: z.number().int().min(0).max(100).optional(),
          vari: z.string().max(20).optional(),
        },
        safe((a) => setLights(a.nimi ?? 'kaikki', a)),
      ),
      tool('valo_nimea', 'Antaa lampulle nimen ("makuuhuone", "olohuone"). laite = nykyinen nimi tai id (valot-listasta).', { laite: z.string().max(60), nimi: z.string().min(2).max(40) }, safe(async (a) => {
        await listLights()
        return nameLight(a.laite, a.nimi)
      })),
    ],
  })
}

/** Muille Tuya-moduuleille (ir.mjs): sama allekirjoitettu kutsu ja koko laitelista (myös muut kuin lamput). */
export const tuyaCall = (method, path, body) => call(method, path, body)
export async function tuyaDevices() {
  const r = await call('GET', '/v1.0/iot-01/associated-users/devices?size=100')
  return r?.devices ?? []
}
