/**
 * IR-ohjain (Nedis SmartLife / muu Tuya-yhteensopiva infrapunalähetin) Tuyan pilven kautta.
 *
 * Kaukosäätimet tehdään Smart Life -sovelluksessa IR-ohjaimen alle (valmis merkki, esim. "Fujitsu" ilmalämpöpumpulle,
 * tai "DIY" = opetetut napit, esim. projektorin virtanappi). JARVIS lukee ne samalta tililtä kuin valot (valot.mjs),
 * joten erillistä asennusta ei tarvita. Tuya IoT -projektiin pitää lisätä API-palvelu "IR Control Hub Open Service".
 *
 *   ir_laitteet        IR-ohjaimet, niiden kaukosäätimet ja napit
 *   ir_nappi           painaa nappia: laite ("projektori"), nappi ("virta", "ääni+", "ok")
 *   ir_lampopumppu     ilmalämpöpumppu/ilmastointi: virta, lämpötila, tila, puhallus (kokeellinen)
 *   ir_asetus          mikä kaukosäädin + nappi käynnistää projektorin (jos automaattinen tunnistus ei osu)
 *   ilp_opi            "testaa lämpöpumppu": kokeilee komentoreitit A/B/C, Elias vastaa kyllä/ei, toimiva tallentuu
 *                      (~/.jarvis/ilp_tila.json reitti). Ei yöllä 23–07.
 *
 * irProjectorPower() käytetään projektori.mjs:ssä: kun projektori on syvässä valmiustilassa (ei vastaa verkossa),
 * IR-virtanappi herättää sen.
 * Asetukset: ~/.jarvis/ir.json { projektori: { remote, nappi } }
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lightsConfigured, tuyaCall, tuyaDevices } from './valot.mjs'
import { readAc, readAcRoute, rememberAc, saveAcDiag, saveAcRoute } from './ilp_tila.mjs'

const CONFIG = () => join(homedir(), '.jarvis', 'ir.json')
let call = tuyaCall
let devices = tuyaDevices
/** Testeille: korvaa Tuya-kutsut. */
export function _setTuya(fnCall, fnDevices) {
  call = fnCall
  devices = fnDevices
  cache = { at: 0, list: null }
  acSpecCache = null
  acMode = null
}
const readCfg = () => {
  try {
    return existsSync(CONFIG()) ? JSON.parse(readFileSync(CONFIG(), 'utf8').replace(/^﻿/, '')) : {}
  } catch {
    return {}
  }
}
const saveCfg = (c) => {
  const dir = join(homedir(), '.jarvis')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(CONFIG(), JSON.stringify(c, null, 1))
}

/** Tuya-tili on yhdistetty (sama kuin valoilla). IR-ohjaimia ei välttämättä vielä ole. */
export const irConfigured = () => lightsConfigured()

const PERMISSION_HINT =
  'Tuya-projektista puuttuu IR-oikeus: iot.tuya.com → Cloud → oma projekti → Service API → Go to Authorize → lisää "IR Control Hub Open Service" (ilmainen) ja yritä uudelleen.'
const explain = (err) => {
  const m = String(err?.message ?? err)
  return /1106|28841101|permission|no access|not authorized|uri path invalid/i.test(m) ? `${m}. ${PERMISSION_HINT}` : m
}

// IR-ohjain Tuyassa: kategoria wnykq (Wi-Fi IR), myös nimi kertoo.
// Ohjaimen alle tehdyt kaukosäätimet näkyvät tilillä omina laitteinaan (kategoria infrared_*): ne eivät ole ohjaimia.
const isHub = (d) => {
  const cat = String(d.category ?? '')
  if (/^infrared|^hwkt/i.test(cat)) return false
  return /^wnykq/i.test(cat) || /(^|[^\p{L}])(ir|infra|infrapuna|kaukosäädin|kaukosaadin|remote|universal)([^\p{L}]|$)/iu.test(String(d.name ?? ''))
}

let cache = { at: 0, list: null }
/** Kaikki kaukosäätimet napit mukaan: [{ hub, hubName, hubOnline, remote, name, category_id, brand, keys:[{key,key_id,key_name,code}] }] */
export async function irRemotes(force = false) {
  if (!force && cache.list && Date.now() - cache.at < 10 * 60_000) return cache.list
  const hubs = (await devices()).filter(isHub)
  const out = []
  for (const h of hubs) {
    let remotes = []
    try {
      remotes = (await call('GET', `/v2.0/infrareds/${h.id}/remotes`)) ?? []
    } catch (err) {
      out.push({ hub: h.id, hubName: h.name, hubOnline: Boolean(h.online), error: explain(err) })
      continue
    }
    for (const r of Array.isArray(remotes) ? remotes : []) {
      const keys = []
      try {
        const k = await call('GET', `/v2.0/infrareds/${h.id}/remotes/${r.remote_id}/keys`)
        for (const x of k?.key_list ?? []) keys.push({ key: String(x.key ?? ''), key_id: x.key_id, key_name: String(x.key_name ?? x.key ?? ''), code: null })
      } catch {
        /* DIY-kaukosäätimellä ei aina ole vakionappeja */
      }
      try {
        const learned = await call('GET', `/v2.0/infrareds/${h.id}/remotes/${r.remote_id}/learning-codes`)
        for (const x of Array.isArray(learned) ? learned : []) {
          const name = String(x.key_name ?? x.key ?? '').trim()
          if (!x.code || !name) continue
          const same = keys.find((k) => norm(k.key_name) === norm(name) || norm(k.key) === norm(x.key ?? ''))
          if (same) same.code = x.code
          else keys.push({ key: String(x.key ?? name), key_id: x.id ?? null, key_name: name, code: x.code })
        }
      } catch {
        /* ei opetettuja nappeja */
      }
      out.push({ hub: h.id, hubName: h.name, hubOnline: Boolean(h.online), remote: r.remote_id, name: String(r.remote_name ?? r.brand_name ?? 'kaukosäädin'), category_id: r.category_id, brand: r.brand_name ?? '', keys })
    }
    if (!remotes.length) out.push({ hub: h.id, hubName: h.name, hubOnline: Boolean(h.online), empty: true })
  }
  cache = { at: Date.now(), list: out }
  return out
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFC').replace(/[\s_-]+/g, ' ').trim()
// Suomenkieliset nimet → Tuyan vakionapit.
const KEY_ALIASES = {
  power: ['virta', 'päälle', 'paalle', 'pois', 'on/off', 'on', 'off', 'käynnistä', 'sammuta', 'power', 'power on', 'power off', 'virtanappi'],
  volume_up: ['ääni+', 'aani+', 'kovemmalle', 'vol+', 'volume up', 'äänet ylös'],
  volume_down: ['ääni-', 'aani-', 'hiljemmalle', 'vol-', 'volume down', 'äänet alas'],
  mute: ['mykistä', 'mykista', 'hiljaiseksi', 'mute'],
  ok: ['ok', 'enter', 'valitse'],
  up: ['ylös', 'ylos', 'up'],
  down: ['alas', 'down'],
  left: ['vasen', 'left'],
  right: ['oikea', 'right'],
  back: ['takaisin', 'back', 'return'],
  home: ['koti', 'home'],
  menu: ['valikko', 'menu', 'asetukset'],
  input: ['lähde', 'lahde', 'syöte', 'input', 'source'],
}
const DEVICE_ALIASES = {
  projektori: ['projektori', 'projector', 'xgimi', 'beamer', 'horizon'],
  lämpöpumppu: ['lämpöpumppu', 'lampopumppu', 'ilmalämpöpumppu', 'ilp', 'ilmastointi', 'air', 'ac', 'fujitsu', 'airstage', 'aircon'],
  telkkari: ['telkkari', 'tv', 'televisio', 'samsung'],
  kaiutin: ['kaiutin', 'soundbar', 'speaker', 'vahvistin'],
  tuuletin: ['tuuletin', 'fan'],
}

/** Kaukosäädin nimellä tai tyypillä ("projektori" osuu myös "XGIMI DIY":hyn). */
export function findRemote(list, query) {
  const q = norm(query)
  const ok = list.filter((r) => r.remote)
  if (!q) return ok.length === 1 ? ok[0] : null
  const direct = ok.find((r) => norm(r.name) === q) ?? ok.find((r) => norm(r.name).includes(q) || q.includes(norm(r.name)))
  if (direct) return direct
  for (const words of Object.values(DEVICE_ALIASES)) {
    if (!words.some((w) => q.includes(w))) continue
    const hit = ok.find((r) => words.some((w) => new RegExp(`(^|\\W)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\W)`, 'i').test(`${r.name} ${r.brand}`)))
    if (hit) return hit
  }
  return null
}
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Whole-word match ("on" must not hit "Function" or "Mute on" via substring). */
const hasWord = (name, w) => new RegExp(`(^|[\\s/,()])${esc(w)}($|[\\s/,()])`, 'i').test(name)
/** Nappi nimellä: tarkka key/key_name, sitten suomenkielinen alias, sitten kokonainen sana. */
export function findKey(remote, query) {
  const q = norm(query)
  const keys = remote?.keys ?? []
  if (!q) return null
  const exact = keys.find((k) => norm(k.key) === q || norm(k.key_name) === q)
  if (exact) return exact
  for (const [std, words] of Object.entries(KEY_ALIASES)) {
    if (!words.includes(q) && std !== q) continue
    const hit = keys.find((k) => norm(k.key) === std || norm(k.key_name) === std || words.includes(norm(k.key_name)))
    if (hit) return hit
    // Opetetuissa napeissa nimi on vapaa ("Virta", "Power", "On/Off"): vain selvät sanat, kokonaisina.
    const strong = [std, ...words].filter((w) => w.length >= 4)
    const loose = keys.find((k) => strong.some((w) => hasWord(norm(k.key_name), w)))
    if (loose) return loose
  }
  return keys.find((k) => hasWord(norm(k.key_name), q)) ?? null
}

/** hubOnline comes from a 10-min cache: refresh once before refusing an "offline" hub. */
async function onlineCheck(r) {
  if (r.hubOnline) return r
  const fresh = await irRemotes(true)
  return fresh.find((x) => x.hub === r.hub && x.remote === r.remote) ?? r
}

async function sendKey(r, k) {
  if (k.code) {
    try {
      await call('POST', `/v2.0/infrareds/${r.hub}/remotes/${r.remote}/learning-codes`, { code: k.code })
    } catch (err) {
      // Vanhempi rajapinta (sama runko)
      await call('POST', `/v1.0/infrareds/${r.hub}/remotes/${r.remote}/learning-codes`, { code: k.code }).catch(() => {
        throw err
      })
    }
    return
  }
  const body = { category_id: Number(r.category_id) || 0, key: k.key, ...(k.key_id != null ? { key_id: Number(k.key_id) } : {}) }
  try {
    await call('POST', `/v2.0/infrareds/${r.hub}/remotes/${r.remote}/raw/command`, body)
  } catch (err) {
    await call('POST', `/v2.0/infrareds/${r.hub}/remotes/${r.remote}/command`, body).catch(() => {
      throw err
    })
  }
}

/** Painaa nappia. Palauttaa kuvauksen (suomeksi). */
export async function irPress(laite, nappi, kertaa = 1) {
  const list = await irRemotes()
  if (!list.length) return 'IR-ohjainta ei löydy Smart Life -tililtä. Lisää Nedis-IR-ohjain Smart Life -sovellukseen samalle tilille kuin valot.'
  const errs = list.filter((r) => r.error)
  let r = findRemote(list, laite)
  if (!r) {
    const fresh = await irRemotes(true)
    r = findRemote(fresh, laite)
    if (!r) {
      const names = fresh.filter((x) => x.remote).map((x) => x.name)
      if (!names.length && errs.length) return `IR: ${errs[0].error}`
      return names.length
        ? `Kaukosäädintä "${laite}" ei löytynyt. Kaukosäätimet: ${names.join(', ')}.`
        : 'IR-ohjaimella ei ole vielä kaukosäätimiä. Lisää Smart Life -sovelluksessa: IR-ohjain → Lisää kaukosäädin (esim. DIY → opeta projektorin virtanappi).'
    }
  }
  const k = findKey(r, nappi)
  if (!k) return `Kaukosäätimessä ${r.name} ei ole nappia "${nappi}". Napit: ${r.keys.map((x) => x.key_name).slice(0, 30).join(', ') || '(ei nappeja — opeta ne Smart Life -sovelluksessa)'}.`
  r = await onlineCheck(r)
  if (!r.hubOnline) return `IR-ohjain ${r.hubName} on offline (ei virtaa tai ei wifissä).`
  const n = Math.max(1, Math.min(10, Number(kertaa) || 1))
  try {
    for (let i = 0; i < n; i++) {
      await sendKey(r, k)
      if (i < n - 1) await new Promise((res) => setTimeout(res, 350))
    }
  } catch (err) {
    return `IR-nappi ${r.name}/${k.key_name} ei lähtenyt: ${explain(err)}`
  }
  return `${r.name}: ${k.key_name}${n > 1 ? ` ×${n}` : ''} lähetetty.`
}

/** Projektorin herätys IR:llä (projektori.mjs kutsuu, kun projektori ei vastaa verkossa). Heittää virheen, jos ei onnistu. */
export async function irProjectorPower() {
  const c = readCfg().projektori ?? {}
  const list = await irRemotes()
  let r = (c.remote && list.find((x) => x.remote === c.remote)) || findRemote(list, c.laite || 'projektori')
  if (!r) throw new Error('IR-kaukosäädintä projektorille ei ole (Smart Life: IR-ohjain → Lisää kaukosäädin → DIY, nimeksi "Projektori", opeta virtanappi).')
  const k = findKey(r, c.nappi || 'virta')
  if (!k) throw new Error(`Projektorin IR-kaukosäätimessä ${r.name} ei ole virtanappia.`)
  r = await onlineCheck(r)
  if (!r.hubOnline) throw new Error(`IR-ohjain ${r.hubName} on offline.`)
  await sendKey(r, k)
  return `${r.name}: ${k.key_name}`
}
export async function irHasProjector() {
  try {
    const c = readCfg().projektori ?? {}
    const list = await irRemotes()
    return Boolean((c.remote && list.find((x) => x.remote === c.remote)) || findRemote(list, c.laite || 'projektori'))
  } catch {
    return false
  }
}

// --- Ilmalämpöpumppu / ilmastointi (Tuyan AC-rajapinta, kaukosäädin valmiista merkkilistasta) ---------------------
const AC_MODE = { jäähdytys: 0, jaahdytys: 0, cool: 0, lämmitys: 1, lammitys: 1, heat: 1, auto: 2, puhallus: 3, fan: 3, kuivaus: 4, dry: 4 }
const AC_FAN = { auto: 0, hiljainen: 1, low: 1, pieni: 1, keski: 2, medium: 2, kova: 3, high: 3, suuri: 3 }
/** The AC remote: by name/alias, else the only air-conditioner remote (Tuya category 5, e.g. Smart Life's default name "Air conditioner"). */
function findAc(list, laite) {
  const named = findRemote(list, laite || 'lämpöpumppu')
  if (named) return named
  const acs = list.filter((x) => x.remote && Number(x.category_id) === 5)
  return acs.length === 1 ? acs[0] : null
}

export async function irAc(laite, { virta, lampotila, tila, puhallus } = {}) {
  let list = await irRemotes()
  let r = findAc(list, laite)
  // Remote added in Smart Life within the 10-min cache: fetch again before saying it does not exist.
  if (!r) {
    list = await irRemotes(true)
    r = findAc(list, laite)
  }
  if (!r) {
    const errs = list.filter((x) => x.error)
    if (errs.length) return `IR: ${errs[0].error}`
    if (!list.length) return 'IR-ohjainta ei löydy Smart Life -tililtä (sama tili kuin valot).'
    const names = list.filter((x) => x.remote).map((x) => `${x.name}${Number(x.category_id) === 5 ? ' (ilmastointi)' : ''}`)
    return `Ilmalämpöpumpun IR-kaukosäädintä ei löytynyt${laite ? ` nimellä "${laite}"` : ''}. ${names.length ? `Kaukosäätimet: ${names.join(', ')}.` : 'IR-ohjaimella ei ole kaukosäätimiä.'} Lisää Smart Life -sovelluksessa: IR-ohjain → Lisää → Ilmastointilaite → merkki (esim. Fujitsu).`
  }
  r = await onlineCheck(r)
  if (!r.hubOnline) return `IR-ohjain ${r.hubName} on offline.`
  const cmds = []
  if (virta !== undefined) cmds.push(['power', virta ? 1 : 0])
  // Eliaksen Fujitsu-pumpussa EI ole lämmitystilaa (Elias 9.11.2026). Jos joskus on: ~/.jarvis/ir.json { "lampopumppu": { "lammitys": true } }.
  const heatOk = readCfg().lampopumppu?.lammitys === true
  if (tila) {
    const m = AC_MODE[norm(tila)]
    if (m === undefined) return `Tuntematon tila "${tila}" (jäähdytys, auto, puhallus, kuivaus).`
    if (m === 1 && !heatOk) return 'Lämpöpumpussa ei ole lämmitystilaa, joten se ei lämmitä huonetta. Vaihtoehdot: puhallus (kierrättää ilmaa, ei lämmitä), kuivaus (poistaa kosteutta, viilentää hieman), jäähdytys tai auto.'
    cmds.push(['mode', m])
  }
  if (lampotila != null) cmds.push(['temp', Math.max(16, Math.min(30, Math.round(Number(lampotila))))])
  if (puhallus) {
    const f = AC_FAN[norm(puhallus)]
    if (f === undefined) return `Tuntematon puhallus "${puhallus}" (auto, hiljainen, keski, kova).`
    cmds.push(['wind', f])
  }
  if (!cmds.length) return 'Kerro mitä muutetaan: virta, lämpötila, tila tai puhallus.'
  // Ilmalämpöpumpun kaukosäädin lähettää AINA koko tilan (virta + tila + lämpö + puhallus) yhtenä IR-viestinä:
  // muuttuneet arvot + viimeksi asetetut (~/.jarvis/ilp_tila.json).
  const prev = readAc() ?? {}
  const state = {
    power: virta !== undefined ? (virta ? 1 : 0) : 1,
    mode: tila ? AC_MODE[norm(tila)] : lastMode(prev, heatOk),
    temp: Math.max(16, Math.min(30, Math.round(Number(lampotila ?? prev.lampotila ?? 21)))),
    wind: puhallus ? AC_FAN[norm(puhallus)] : AC_FAN[norm(prev.puhallus ?? 'auto')] ?? 0,
  }
  const what = cmds.map(([code, value]) => (code === 'power' ? (value ? 'päälle' : 'pois') : code === 'temp' ? `${value} °C` : code === 'mode' ? `tila ${tila}` : `puhallus ${puhallus}`))
  if (virta === undefined) what.unshift('päällä')
  const onlyPower = virta !== undefined && !tila && lampotila == null && !puhallus
  const route = readAcRoute()
  let notes = []
  try {
    notes = (await sendAc(route, r, state, { onlyPower, prev: prevState(prev, heatOk) })) ?? []
  } catch (err) {
    // Rajapintavirhe (ei hiljainen epäonnistuminen): toinen reitti kerran — ja Elias näkee sen vastauksesta.
    const alt = route === 'A' ? 'B' : 'A'
    console.warn(`[jarvis] ir: reitti ${route} epäonnistui, kokeillaan ${alt}:`, err?.message ?? err)
    try {
      notes = [...((await sendAc(alt, r, state, { onlyPower, prev: prevState(prev, heatOk) })) ?? []), `Reitti ${route} ei kelvannut Tuyalle (${String(err?.message ?? err).slice(0, 80)}), joten lähetin varareitillä ${alt}.`]
    } catch (err2) {
      return `${r.name}: ei lähtenyt: ${explain(err2)}`
    }
  }
  const extra = notes.length ? ` ${notes.join(' ')}` : ''
  return `${r.name}: ${what.join(', ')} (${state.temp} °C, ${modeName(state.mode)}).${extra} (IR ei kerro laitteen todellista tilaa — tarkista, että laite reagoi.)`
}

/** Last sent state (ilp_tila.json) in the same numbers as `state`; power null = unknown. */
const prevState = (prev, heatOk) =>
  prev && Object.keys(prev).length
    ? { power: prev.virta === true ? 1 : prev.virta === false ? 0 : null, mode: lastMode(prev, heatOk), temp: Math.round(Number(prev.lampotila ?? 21)), wind: AC_FAN[norm(prev.puhallus ?? 'auto')] ?? 0 }
    : null
const modeName = (m) => Object.keys(AC_MODE).find((k) => AC_MODE[k] === m) ?? ''
const lastMode = (prev, heatOk) => {
  const pm = AC_MODE[norm(prev.tila ?? 'puhallus')] ?? 3
  return pm === 1 && !heatOk ? 3 : pm
}

// --- Lämpöpumpun komentoreitit (vika V2, 10.11.2026) ------------------------------------------------------------
// Tuyan laiteloki: Smart Life käynnisti Fujitsun tilalla mode 3 / temp 16 / wind 3. JARVISin scenes/command puhallustilassa
// pudotti lämpötilan (IR-koodikirjastossa lämpö 18–30, puhallustilassa ei lämpöä) eikä pumppu käynnistynyt.
// Kaukosäätimen omat vakiokomennot (switch/mode/temp/fan, lämpö 16–30) ovat sovelluksen reitti → oletus A.
export const AC_ROUTES = {
  A: 'Smart Life -sovelluksen tapa (kaukosäätimen vakiokomennot switch/mode/temp/fan, lämpötila aina mukana)',
  B: 'koko tila yhtenä IR-viestinä (scenes/command, lämpötila aina mukana)',
  C: 'kaukosäätimen omat PowerOn/PowerOff-napit',
}
const STD_MODE = ['cold', 'heat', 'auto', 'wind_dry', 'dehumidification'] // AC_MODE 0–4 → laitteen oma enum
const STD_FAN = ['auto', 'low', 'mid', 'high'] // AC_FAN 0–3

// Route A answered Tuya 2008 "command or value not support" (10.11.2026 14.26, Koti-sivu). Instead of guessing which code or
// value the Fujitsu remote refuses, JARVIS reads the device's own spec, fits the commands to it and sends them one per
// request (IR virtual devices may refuse batches). What it learned goes to ~/.jarvis/ilp_diag.json for the next session.
// Eliaksen Fujitsu (Tuya infrared_ac, ilp_diag.json 10.11.2026 15.08): PowerOn/PowerOff (String), M 0–4, T 16–30, F 0–3.
const CODE_SYN = { switch: ['switch', 'power', 'switch_1'], mode: ['mode', 'work_mode', 'M'], temp: ['temp', 'temp_set', 'temperature', 'T'], fan: ['fan', 'wind', 'fan_speed_enum', 'windspeed', 'F'] }
const POWER_CODES = ['switch', 'power', 'switch_1', 'PowerOn', 'PowerOff']
const SETTING_KEY = (code) => (CODE_SYN.mode.includes(code) ? 'mode' : CODE_SYN.temp.includes(code) ? 'temp' : CODE_SYN.fan.includes(code) ? 'wind' : null)

/**
 * Pure: what the Smart Life app would send for this change, one key press per request (10.11.2026 15.14: the four
 * commands as one batch were accepted by Tuya but the Fujitsu ignored them). commands = fitted [power, ...settings].
 * Off → PowerOff only. Turning on → PowerOn, then only the settings that differ from the last sent state.
 * Already on → only the changed settings (none changed → PowerOn again, Elias pressed "on" again).
 */
export function acAppPlan(commands, state, { onlyPower = false, prev = null } = {}) {
  const [power, ...settings] = commands
  if (!power) return []
  if (!state.power || power.code === 'PowerOff') return [power]
  if (onlyPower) return [power]
  const changed = settings.filter((c) => {
    const k = SETTING_KEY(c.code)
    return !prev || prev[k] == null || Number(prev[k]) !== Number(state[k])
  })
  if (prev?.power !== 1) return [power, ...changed]
  return changed.length ? changed : [power]
}
const MODE_SYN = { cold: ['cold', 'cool'], heat: ['heat', 'hot'], auto: ['auto'], wind_dry: ['wind_dry', 'wind', 'fan', 'fan_only', 'air_supply', 'ventilation'], dehumidification: ['dehumidification', 'dry', 'wet'] }
const FAN_SYN = { auto: ['auto'], low: ['low', 'level_1', 'small', '1'], mid: ['mid', 'middle', 'medium', 'level_2', '2'], high: ['high', 'strong', 'level_3', 'big', '3'] }
const parseValues = (v) => {
  try {
    return (typeof v === 'string' ? JSON.parse(v) : v) ?? {}
  } catch {
    return {}
  }
}

/**
 * Pure: fit route-A commands to the device spec ({ functions: [{ code, type, values }] } from /functions).
 * Unknown codes and values outside the spec are dropped and explained. No spec → commands unchanged.
 * → { commands, dropped: [Finnish text] }
 */
export function fitAcCommands(commands, spec) {
  const fns = Array.isArray(spec?.functions) ? spec.functions : []
  if (!fns.length) return { commands, dropped: [] }
  const out = []
  const dropped = []
  for (const c of commands) {
    // IR AC remote: power is two String keys, not a switch: PowerOn/PowerOff with its own name as value.
    if (c.code === 'switch') {
      const key = c.value ? 'PowerOn' : 'PowerOff'
      if (!fns.some((f) => CODE_SYN.switch.includes(f.code)) && fns.some((f) => f.code === key)) {
        out.push({ code: key, value: key })
        continue
      }
    }
    const fn = (CODE_SYN[c.code] ?? [c.code]).map((n) => fns.find((f) => f.code === n)).find(Boolean)
    if (!fn) {
      dropped.push(`${c.code} (pumpulla ei ole)`)
      continue
    }
    const v = parseValues(fn.values)
    const type = String(fn.type ?? '').toLowerCase()
    let value = c.value
    // "ENUM" with min/max (no range) = numeric index: M 0–4 = AC_MODE, F 0–3 = AC_FAN.
    const numeric = !Array.isArray(v.range) && (v.min !== undefined || v.max !== undefined)
    if (numeric && typeof value === 'string') {
      const idx = (c.code === 'mode' ? STD_MODE : c.code === 'fan' ? STD_FAN : []).indexOf(value)
      if (idx < 0) {
        dropped.push(`${c.code}=${value} (pumppu hyväksyy: ${v.min}–${v.max})`)
        continue
      }
      value = idx
    }
    if (numeric) {
      const n = Math.round(Number(value))
      value = Math.min(Number(v.max ?? n), Math.max(Number(v.min ?? n), n))
    } else if (type === 'enum') {
      const range = (Array.isArray(v.range) ? v.range : []).map(String)
      const syn = (c.code === 'mode' ? MODE_SYN : c.code === 'fan' ? FAN_SYN : {})[String(value)] ?? [String(value)]
      const hit = syn.find((x) => range.includes(x)) ?? range.find((x) => syn.some((y) => y.length > 2 && x.toLowerCase().includes(y)))
      if (!hit) {
        dropped.push(`${c.code}=${value} (pumppu hyväksyy: ${range.join('/') || '?'})`)
        continue
      }
      value = hit
    } else if (type === 'integer' || type === 'value') {
      const scale = Number(v.scale) || 0
      let n = Math.round(Number(value) * 10 ** scale)
      const step = Number(v.step) || 1
      if (step > 1) n = Math.round(n / step) * step
      if (Number.isFinite(Number(v.min)) && v.min !== '') n = Math.max(Number(v.min), n)
      if (Number.isFinite(Number(v.max)) && v.max !== '') n = Math.min(Number(v.max), n)
      value = n
    } else if (type === 'boolean' || type === 'bool') value = Boolean(value)
    out.push({ code: fn.code, value })
  }
  return { commands: out, dropped }
}

let acSpecCache = null // { remote, spec }
let acMode = null // learned this run for route A: 'fit' = device's own codes as a batch, 'single' = one command per request
async function acSpec(r) {
  if (acSpecCache?.remote === r.remote) return acSpecCache.spec
  let spec = null
  for (const p of [`/v1.0/iot-03/devices/${r.remote}/functions`, `/v1.0/devices/${r.remote}/functions`]) {
    try {
      spec = await call('GET', p)
      if (Array.isArray(spec?.functions) && spec.functions.length) break
    } catch {
      /* next path */
    }
  }
  acSpecCache = { remote: r.remote, spec }
  return spec
}
const isUnsupported = (err) => /\b2008\b|not support/i.test(String(err?.message ?? err))
async function postWithAlt(q, body) {
  try {
    await call(q.method, q.path, body)
  } catch (err) {
    if (!q.alt) throw err
    await call(q.method, q.alt, body).catch(() => {
      throw err
    })
  }
}

/** Route A: batch first; on Tuya 2008 fit to the device spec and send one by one. Throws if power itself is refused. → notes */
async function sendRouteA(r, state, opts) {
  const [q] = acRequests('A', r, state, opts)
  let firstErr = null
  if (!acMode) {
    try {
      await postWithAlt(q, q.body)
      return []
    } catch (err) {
      if (!isUnsupported(err)) throw err
      firstErr = err
    }
  }
  const spec = await acSpec(r)
  const { commands, dropped } = fitAcCommands(q.body.commands, spec)
  const diag = {
    at: Date.now(),
    virhe: firstErr ? String(firstErr?.message ?? firstErr) : 'yksittäin (opittu)',
    spec: (spec?.functions ?? []).map((f) => ({ code: f.code, type: f.type, values: parseValues(f.values) })),
    pyydetty: q.body.commands,
    lahetetty: [],
    pudotettu: dropped,
    hylatty: [],
  }
  const power = commands[0]
  if (!power || !POWER_CODES.includes(power.code)) {
    saveAcDiag({ ...diag, tulos: 'virtakomento puuttuu laitteen speksistä' })
    throw firstErr ?? new Error('Tuya: lämpöpumpun virtakomentoa ei löytynyt laitteen speksistä')
  }
  // IR remote with its own PowerOn/PowerOff keys: behave like the Smart Life app — one key per request, only what changed.
  if (power.code === 'PowerOn' || power.code === 'PowerOff') {
    const plan = acAppPlan(commands, state, opts)
    const gap = Number(process.env.JARVIS_AC_GAP_MS ?? 1500)
    for (let i = 0; i < plan.length; i++) {
      const c = plan[i]
      try {
        await postWithAlt(q, { commands: [c] })
        diag.lahetetty.push(c)
      } catch (err) {
        if (i === 0 && POWER_CODES.includes(c.code)) {
          saveAcDiag({ ...diag, hylatty: [`${c.code}=${c.value}: ${err?.message ?? err}`], tulos: 'virtanappi hylätty' })
          throw err
        }
        diag.hylatty.push(`${c.code}=${c.value}: ${err?.message ?? err}`)
      }
      if (i < plan.length - 1) await new Promise((res) => setTimeout(res, gap))
    }
    acMode = 'fit'
    saveAcDiag({ ...diag, tulos: 'sovelluksen tapa: yksi komento kerrallaan, vain muuttuneet' })
    console.warn(`[jarvis] ir: reitti A sovelluksen tapaan: ${diag.lahetetty.map((c) => `${c.code}=${c.value}`).join(' → ')}`)
    const skipped = [...dropped, ...diag.hylatty.map((x) => x.split(':')[0])]
    return skipped.length ? [`Pumppu ei hyväksynyt kaikkia asetuksia (${skipped.join(', ')}).`] : []
  }
  // Fitted commands as one batch first (one IR blast); only if that is refused too, one by one.
  if (acMode !== 'single' && commands.length > 1) {
    try {
      await postWithAlt(q, { commands })
      acMode = 'fit'
      diag.lahetetty = commands
      saveAcDiag({ ...diag, tulos: 'lähetetty laitteen omilla koodeilla yhtenä eränä' })
      console.warn(`[jarvis] ir: reitti A laitteen omilla koodeilla: ${commands.map((c) => `${c.code}=${c.value}`).join(', ')}`)
      return dropped.length ? [`Pumppu ei hyväksynyt kaikkia asetuksia (${dropped.join(', ')}).`] : []
    } catch (err) {
      if (!isUnsupported(err)) throw err
    }
  }
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i]
    try {
      await postWithAlt(q, { commands: [c] })
      diag.lahetetty.push(c)
    } catch (err) {
      if (i === 0) {
        saveAcDiag({ ...diag, hylatty: [`${c.code}=${c.value}: ${err?.message ?? err}`], tulos: 'virtakomento hylätty → reitti A ei toimi' })
        throw err
      }
      diag.hylatty.push(`${c.code}=${c.value}: ${err?.message ?? err}`)
    }
    if (i < commands.length - 1) await new Promise((res) => setTimeout(res, 600))
  }
  acMode = commands.length > 1 ? 'single' : acMode ?? 'fit'
  saveAcDiag({ ...diag, tulos: 'lähetetty yksittäin' })
  const skipped = [...dropped, ...diag.hylatty.map((x) => x.split(':')[0])]
  console.warn(`[jarvis] ir: reitti A yksittäin (${diag.virhe}). Lähetetty: ${diag.lahetetty.map((c) => `${c.code}=${c.value}`).join(', ')}${skipped.length ? `; ei kelvannut: ${skipped.join(', ')}` : ''}`)
  return skipped.length ? [`Pumppu ei hyväksynyt kaikkia asetuksia (${skipped.join(', ')}).`] : []
}

/**
 * Pure: the Tuya requests one route makes for a full AC state { power, mode, temp, wind } (numbers as in AC_MODE/AC_FAN).
 * onlyPower: only on/off was asked (route C then presses just the power key). → [{ method, path, body, alt? }]
 */
export function acRequests(route, r, s, { onlyPower = false } = {}) {
  const temp = Math.max(16, Math.min(30, Math.round(Number(s.temp) || 21)))
  if (route === 'A') {
    const commands = s.power
      ? [
          { code: 'switch', value: true },
          { code: 'mode', value: STD_MODE[s.mode] ?? 'wind_dry' },
          { code: 'temp', value: temp },
          { code: 'fan', value: STD_FAN[s.wind] ?? 'auto' },
        ]
      : [{ code: 'switch', value: false }]
    return [{ method: 'POST', path: `/v1.0/iot-03/devices/${r.remote}/commands`, body: { commands }, alt: `/v1.0/devices/${r.remote}/commands` }]
  }
  // IR-koodikirjaston rajat: lämpö 18–30 kaikissa tiloissa (myös puhalluksessa mukana), kuivaus vain auto-puhalluksella.
  const scene = { power: s.power ? 1 : 0, mode: Number(s.mode) || 0, temp: Math.max(18, temp), wind: Number(s.mode) === 4 ? 0 : Number(s.wind) || 0 }
  const sceneReq = { method: 'POST', path: `/v2.0/infrareds/${r.hub}/air-conditioners/${r.remote}/scenes/command`, body: scene }
  if (route === 'B') return [sceneReq]
  const key = { category_id: Number(r.category_id) || 5, key: s.power ? 'PowerOn' : 'PowerOff', key_id: 0 }
  const keyReq = { method: 'POST', path: `/v2.0/infrareds/${r.hub}/remotes/${r.remote}/command`, body: key, alt: `/v2.0/infrareds/${r.hub}/remotes/${r.remote}/raw/command` }
  return onlyPower || !s.power ? [keyReq] : [keyReq, sceneReq]
}

async function sendAc(route, r, state, opts) {
  if (route === 'A') return sendRouteA(r, state, opts)
  const reqs = acRequests(route, r, state, opts)
  for (let i = 0; i < reqs.length; i++) {
    const q = reqs[i]
    try {
      await call(q.method, q.path, q.body)
    } catch (err) {
      if (!q.alt) throw err
      await call(q.method, q.alt, q.body).catch(() => {
        throw err
      })
    }
    if (i < reqs.length - 1) await new Promise((res) => setTimeout(res, 600))
  }
  return []
}

// --- "testaa lämpöpumppu": reitit yksi kerrallaan, Elias vastaa kyllä/ei ----------------------------------------
/** Ei IR-kokeiluja yöllä (pumppu käynnistyisi keskellä yötä): 23.00–07.00 Suomen aikaa. */
export function isNight(d = new Date()) {
  const h = Number(new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', hour: 'numeric', hourCycle: 'h23' }).format(d))
  return h >= 23 || h < 7
}
// Ei \b: se ei toimi ä-kirjaimen jälkeen ("kyllä").
const YES = /^(kyllä|kylla|joo|juu|jep|k|yes|käynnistyi|kaynnistyi|sammui|toimi|meni)(?=$|[\s,])/i
const NO = /^(ei|e|no|nope)(?=$|[\s,])/i
let learn = null // { route, waiting: fn(answer) } kun testi on käynnissä

export const acLearnActive = () => Boolean(learn)

/** Eliaksen vastaus testin kysymykseen (Telegram/chat-pikapolku). null = ei testiä tai ei kyllä/ei-vastaus. */
export function acLearnAnswer(text) {
  if (!learn?.waiting) return null
  const t = String(text ?? '').trim().toLowerCase().replace(/[.!]+$/, '')
  const a = YES.test(t) ? 'kyllä' : NO.test(t) ? 'ei' : null
  if (!a) return null
  const w = learn.waiting
  learn.waiting = null
  w(a)
  return a === 'kyllä' ? 'Selvä — kyllä.' : 'Selvä — ei. Kokeilen seuraavaa tapaa.'
}

/** Kun reitti toimii: vika V2 ratkaistuksi ja taito ajan tasalle (muisti/viat.md, muisti/taidot.md). */
async function defaultConfirmed(route, poisOk) {
  const { logFault } = await import('./viat.mjs')
  const { saveSkill, readSkills } = await import('./taidot.mjs')
  const how = `reitti ${route}: ${AC_ROUTES[route]}`
  try {
    logFault({ id: 'V2', ratkaisu: `"testaa lämpöpumppu": Elias vahvisti, että pumppu käynnistyy JARVISin ${how}${poisOk ? ' ja sammuu samaa reittiä' : ' (sammutus ei vahvistunut)'}. Reitti tallennettu oletukseksi ~/.jarvis/ilp_tila.json` })
  } catch (err) {
    console.warn('[jarvis] ilp: viat.md ei päivittynyt:', err?.message ?? err)
  }
  try {
    const old = readSkills().find((s) => /^Lämpöpumppu \(ILP\)/.test(s.name))
    saveSkill(
      {
        nimi: 'Lämpöpumppu (ILP) IR-ohjauksella',
        milloin: 'Elias pyytää lämpöpumppua/ILP:tä tai ilmastointia päälle, pois, lämpötilaa, tilaa tai puhallusta',
        askeleet:
          '1. ir_lampopumppu (virta true/false, lampotila 16–30, tila, puhallus). laite-parametri vain jos Elias nimeää kaukosäätimen. Työkalu käyttää vahvistettua reittiä automaattisesti.\n' +
          '2. Jos vastaus on "ei löytänyt": ir_laitteet → katso kaukosäätimien oikeat nimet (Smart Life -sovelluksen nimi, esim. "Air conditioner") → kutsu uudelleen laite=<oikea nimi>.\n' +
          '3. Jos virhe puhuu luvasta tai palvelusta (permission / not subscribe / 1106 / 28841): Tuyan pilviprojektista puuttuu "IR Control Hub Open Service" — Elias valtuuttaa sen platform.tuya.com → Cloud Project → Service API.\n' +
          '4. Kerro lyhyesti mitä asetit ("ILP päällä, puhallus kova"). Pumpussa EI ole lämmitystilaa: älä valitse lämmitystä.',
        sudenkuopat:
          `IR on yksisuuntainen: JARVIS ei näe pumpun todellista tilaa. Toimiva reitti (vahvistettu ${new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki' }).format(new Date())}): ${how}. ` +
          'Tuya kuittaa myös komennot, joihin pumppu ei reagoi: scenes/command puhallustilassa pudotti lämpötilan ja Fujitsu jätti IR-viestin huomiotta (V2). Älä palaa siihen. ir_nappi "power on" ei ole sama kuin ir_lampopumppu.',
        varatie: 'Jos pumppu ei taas reagoi mutta Smart Life toimii: pyydä Eliasta sanomaan "testaa lämpöpumppu" (päivällä 7–23), se kokeilee reitit uudelleen ja tallentaa toimivan.',
        vaikutukset: 'Lämpöpumpun asetus (peruttavissa).',
      },
      { source: old ? 'testaa lämpöpumppu' : 'aloitus' },
    )
  } catch (err) {
    console.warn('[jarvis] ilp: taidot.md ei päivittynyt:', err?.message ?? err)
  }
}

/**
 * Starts the learning test in the background and returns the first reply at once (the Telegram poll loop must not
 * wait: Elias's "kyllä"/"ei" arrives through the same loop). deps for tests: notify, now, waitMs, gapMs, onConfirmed, save.
 */
export async function acLearnStart(deps = {}) {
  const now = deps.now ?? (() => new Date())
  if (isNight(now())) return 'Nyt on yö (23–07), joten lämpöpumppua ei testata — se käynnistyisi keskellä yötä. Testataan aamulla: sano "testaa lämpöpumppu" klo 7 jälkeen.'
  if (learn) return 'Lämpöpumpun testi on jo käynnissä — vastaa kyllä tai ei.'
  let list = await irRemotes()
  let r = findAc(list)
  if (!r) {
    list = await irRemotes(true)
    r = findAc(list)
  }
  if (!r) return 'Lämpöpumpun IR-kaukosäädintä ei löytynyt (ir_laitteet näyttää kaukosäätimet).'
  r = await onlineCheck(r)
  if (!r.hubOnline) return `IR-ohjain ${r.hubName} on offline, joten testiä ei voi tehdä.`
  const notify = deps.notify ?? (async (t) => (await import('./telegram.mjs')).sendTelegram(t))
  const waitMs = deps.waitMs ?? 2 * 60_000
  const gapMs = deps.gapMs ?? 3000
  const save = deps.save ?? saveAcRoute
  const onConfirmed = deps.onConfirmed ?? defaultConfirmed
  const prev = readAc() ?? {}
  const heatOk = readCfg().lampopumppu?.lammitys === true
  const base = { mode: lastMode(prev, heatOk), temp: Math.max(18, Math.min(30, Math.round(Number(prev.lampotila ?? 21)))), wind: AC_FAN[norm(prev.puhallus ?? 'auto')] ?? 0 }
  const order = Object.keys(AC_ROUTES)
  learn = { waiting: null }
  const ask = (q) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (learn) learn.waiting = null
        resolve(null)
      }, waitMs)
      learn.waiting = (a) => {
        clearTimeout(timer)
        resolve(a)
      }
      Promise.resolve(notify(q)).catch(() => {})
    })
  const pause = () => new Promise((res) => setTimeout(res, gapMs))
  const run = async () => {
    for (let i = 0; i < order.length; i++) {
      const route = order[i]
      // Kello voi ehtiä yli 23 kesken testin.
      if (isNight(now())) return notify('Kello on yli 23 — keskeytän lämpöpumpun testin. Jatketaan aamulla: "testaa lämpöpumppu".')
      try {
        await sendAc(route, r, { ...base, power: 1 }, { onlyPower: true })
      } catch (err) {
        await notify(`Tapa ${route} (${i + 1}/${order.length}) ei lähtenyt Tuyaan: ${explain(err)}. Kokeilen seuraavaa.`)
        continue
      }
      const a = await ask(`Lämpöpumpun testi ${i + 1}/${order.length} — tapa ${route}: ${AC_ROUTES[route]}.\nLähetin "päälle". Käynnistyikö pumppu? Vastaa kyllä tai ei (odotan 2 min).`)
      if (a === null) {
        await sendAc(route, r, { ...base, power: 0 }, { onlyPower: true }).catch(() => {})
        return notify('Ei vastausta 2 minuuttiin — testi keskeytetty (lähetin varmuuden vuoksi "pois" samaa tapaa). Kokeile uudelleen: "testaa lämpöpumppu".')
      }
      if (a === 'ei') {
        await pause()
        continue
      }
      save(route, { pois: null })
      await pause()
      let off = null
      try {
        await sendAc(route, r, { ...base, power: 0 }, { onlyPower: true })
        off = await ask(`Hyvä! Tapa ${route} tallennettu oletukseksi. Lähetin nyt "pois" samaa tapaa. Sammuiko pumppu? kyllä/ei`)
      } catch (err) {
        await notify(`"Pois" ei lähtenyt: ${explain(err)}`)
      }
      save(route, { pois: off === 'kyllä' })
      await Promise.resolve(onConfirmed(route, off === 'kyllä')).catch(() => {})
      return notify(
        off === 'kyllä'
          ? `Valmis: lämpöpumppu toimii nyt tavalla ${route} (päälle ja pois). Koti-sivu, puhe ja Telegram käyttävät tätä.`
          : `Päälle toimii tavalla ${route} ja se on oletus. Sammutus ei vahvistunut — sammuta tarvittaessa Smart Lifesta ja kerro, niin katsotaan pois-komento erikseen.`,
      )
    }
    return notify('Mikään kolmesta tavasta ei käynnistänyt pumppua. Pidän nykyisen oletuksen; vika V2 jää auki kehittäjälle (Smart Life toimii, joten vika on Tuyan komentoreitissä).')
  }
  void run()
    .catch((err) => notify(`Lämpöpumpun testi keskeytyi: ${err?.message ?? err}`))
    .catch(() => {})
    .finally(() => {
      learn = null
    })
  return `Aloitan lämpöpumpun testin: kokeilen ${order.length} tapaa yksi kerrallaan (ensin ${order[0]}) ja kysyn Telegramissa jokaisen jälkeen, käynnistyikö pumppu.`
}

export async function irText() {
  const list = await irRemotes(true)
  if (!list.length) return 'IR-ohjainta ei löydy Smart Life -tililtä. Lisää Nedis-IR-ohjain Smart Life -sovellukseen samalle tilille kuin valot.'
  const lines = []
  for (const r of list) {
    if (r.error) lines.push(`• ${r.hubName}: ${r.error}`)
    else if (r.empty) lines.push(`• ${r.hubName}${r.hubOnline ? '' : ' (offline)'}: ei kaukosäätimiä — lisää Smart Life -sovelluksessa`)
    else lines.push(`• ${r.name}${r.brand ? ` (${r.brand})` : ''} [${r.hubName}${r.hubOnline ? '' : ', offline'}]: ${r.keys.map((k) => k.key_name).slice(0, 25).join(', ') || 'ei nappeja'}`)
  }
  return `IR-kaukosäätimet:\n${lines.join('\n')}`
}

export function irSetProjector({ laite, nappi }) {
  const c = readCfg()
  const r = (cache.list ?? []).length ? findRemote(cache.list, laite) : null
  c.projektori = { laite: String(laite ?? 'projektori').slice(0, 60), nappi: String(nappi ?? 'virta').slice(0, 40), ...(r ? { remote: r.remote } : {}) }
  saveCfg(c)
  return `Projektorin IR-käynnistys: kaukosäädin "${c.projektori.laite}", nappi "${c.projektori.nappi}".`
}

/** UI:lle: kaukosäätimet ja napit. */
export async function irForUi() {
  const list = await irRemotes(true)
  return {
    text: list.length ? `${list.filter((r) => r.remote).length} kaukosäädintä` : 'IR-ohjainta ei löydy Smart Life -tililtä.',
    remotes: list.filter((r) => r.remote).map((r) => ({ name: r.name, online: r.hubOnline, ac: Number(r.category_id) === 5, keys: r.keys.map((k) => k.key_name).slice(0, 40) })),
    errors: list.filter((r) => r.error).map((r) => r.error),
  }
}

export function irServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const safe = (fn) => async (a) => {
    try {
      return ok(await fn(a ?? {}))
    } catch (err) {
      return ok(`IR: ${explain(err)}`)
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_ir',
    version: '1.0.0',
    instructions:
      'Infrapunaohjain (Smart Life): kaukosäätimellä ohjattavat laitteet (projektorin virta, ilmalämpöpumppu, kaiutin…). IR ei kerro laitteen tilaa: kerro mitä lähetettiin, älä väitä laitteen varmasti reagoineen.',
    tools: [
      tool('ir_laitteet', 'Listaa IR-ohjaimet, niiden kaukosäätimet ja napit.', {}, safe(irText)),
      tool(
        'ir_nappi',
        'Painaa IR-kaukosäätimen nappia: laite = kaukosäätimen nimi tai tyyppi ("projektori", "lämpöpumppu", "kaiutin"), nappi ("virta", "ääni+", "ääni-", "mykistä", "ok", "ylös"… tai opetetun napin nimi), kertaa 1–10.',
        { laite: z.string().min(2).max(60), nappi: z.string().min(1).max(40), kertaa: z.number().int().min(1).max(10).optional() },
        safe((a) => irPress(a.laite, a.nappi, a.kertaa)),
      ),
      tool(
        'ir_lampopumppu',
        'Ilmalämpöpumppu/ilmastointi IR:llä (kokeellinen): virta true/false, lampotila 16–30, tila (jäähdytys, auto, puhallus, kuivaus; Eliaksen pumpussa EI ole lämmitystä), puhallus (auto, hiljainen, keski, kova). laite = kaukosäätimen nimi (oletus lämpöpumppu).',
        {
          laite: z.string().max(60).optional(),
          virta: z.boolean().optional(),
          lampotila: z.number().min(16).max(30).optional(),
          tila: z.string().max(20).optional(),
          puhallus: z.string().max(20).optional(),
        },
        safe(async (a) => {
          const text = await irAc(a.laite, a)
          rememberAc(a, text) // Koti-laatta näyttää viimeksi asetetun
          return text
        }),
      ),
      tool(
        'ilp_opi',
        'Lämpöpumpun oppimistesti ("testaa lämpöpumppu"): lähettää "päälle" kolmea eri tapaa yksi kerrallaan ja kysyy Eliakselta Telegramissa jokaisen jälkeen, käynnistyikö pumppu; ensimmäinen "kyllä" tallentuu oletustavaksi. Ei yöllä 23–07. Käytä vain kun Elias pyytää testiä tai pumppu ei reagoi vaikka Smart Life toimii.',
        {},
        safe(() => acLearnStart()),
      ),
      tool(
        'ir_asetus',
        'Tallentaa, millä IR-kaukosäätimellä ja napilla projektori käynnistetään (jos automaattinen tunnistus ei osu): laite = kaukosäätimen nimi, nappi = napin nimi.',
        { laite: z.string().min(2).max(60), nappi: z.string().min(1).max(40) },
        safe(async (a) => {
          await irRemotes(true)
          return irSetProjector(a)
        }),
      ),
    ],
  })
}
