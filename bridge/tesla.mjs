/**
 * Tesla: "lämmitä auto", "paljonko akkua", "missä auto on", "lukitse auto" — Tessie-palvelun rajapinnan kautta.
 *
 *   Miksi Tessie eikä Teslan oma Fleet API: Fleet API vaatii kehittäjätilin, julkisen verkkotunnuksen avaimelle,
 *   allekirjoitetut komennot (virtuaaliavain + erillinen proxy) ja laskutuksen per komento. Tessie (tessie.com, tilaus)
 *   hoitaa kaiken tuon ja antaa yhden tokenin. Token tallennetaan DPAPI-salattuna ~/.jarvis/tessie.json; malli ei näe sitä.
 *   Asennus: tyokalut\asenna_tesla.bat.
 *
 *   Turva: vain nämä toiminnot (ilmasto päälle/pois, lämpötila, sulatus, tila, sijainti, lataus päälle/pois, lukitus).
 *   EI ovien avausta, EI ajoa/summonia, EI latausrajan tai nopeuden muutoksia. Lukituksen avaus ei ole käytössä.
 *   Ajastettavissa (ajastin: tesla_lammita).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG = join(homedir(), '.jarvis', 'tessie.json')
const BASE = 'https://api.tessie.com'
const cfg = () => {
  try {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')) : null
  } catch {
    return null
  }
}
export const teslaConfigured = () => Boolean(cfg()?.token)

let token = null
function accessToken() {
  if (token) return Promise.resolve(token)
  const c = cfg()
  if (!c?.token) return Promise.reject(new Error('Teslaa ei ole yhdistetty: aja tyokalut\\asenna_tesla.bat.'))
  if (process.platform !== 'win32') return Promise.resolve((token = c.token))
  return new Promise((resolve, reject) => {
    const ps = `$s = ConvertTo-SecureString '${String(c.token).replace(/'/g, '')}'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      if (err || !String(out).trim()) return reject(new Error('Tessie-tokenia ei saatu purettua (aja asenna_tesla.bat uudelleen).'))
      resolve((token = String(out).replace(/\r?\n$/, '')))
    })
  })
}

async function call(method, path, params = {}) {
  const t = await accessToken()
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]))
  const url = `${BASE}${path}${q.toString() ? `?${q}` : ''}`
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${t}`, accept: 'application/json' }, signal: AbortSignal.timeout(method === 'GET' ? 20_000 : 75_000) })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) throw new Error('Tessie ei hyväksynyt tokenia (vanhentunut?). Aja asenna_tesla.bat uudelleen.')
  if (!res.ok) throw new Error(`Tessie ${res.status}: ${String(data?.error ?? data?.message ?? JSON.stringify(data)).slice(0, 160)}`)
  return data
}

async function vin() {
  const c = cfg()
  if (c?.vin) return c.vin
  const list = await call('GET', '/vehicles', { only_active: true })
  const v = list?.results?.[0]?.vin
  if (!v) throw new Error('Tessie-tilillä ei ole autoja.')
  return v
}

const fmtState = (s) => {
  const ch = s?.charge_state ?? {}
  const cl = s?.climate_state ?? {}
  const vs = s?.vehicle_state ?? {}
  const km = (mi) => (Number.isFinite(mi) ? Math.round(mi * 1.609) : null)
  const parts = [
    `${s?.display_name || 'Tesla'}: ${s?.state === 'online' ? 'hereillä' : s?.state === 'asleep' ? 'unessa (herää komennosta)' : s?.state || '?'}`,
    Number.isFinite(ch.battery_level) ? `akku ${ch.battery_level} %${km(ch.battery_range) ? ` (~${km(ch.battery_range)} km)` : ''}` : null,
    ch.charging_state ? `lataus: ${ch.charging_state === 'Charging' ? `lataa${ch.minutes_to_full_charge ? `, valmis ${ch.minutes_to_full_charge} min` : ''}` : ch.charging_state === 'Complete' ? 'valmis' : ch.charging_state === 'Disconnected' ? 'ei kytketty' : ch.charging_state}` : null,
    Number.isFinite(cl.inside_temp) ? `sisällä ${Math.round(cl.inside_temp)} °C, ulkona ${Math.round(cl.outside_temp ?? NaN) || '?'} °C` : null,
    cl.is_climate_on ? `lämmitys PÄÄLLÄ (tavoite ${cl.driver_temp_setting ?? '?'} °C)` : 'lämmitys pois',
    vs.locked === false ? 'LUKITSEMATTA' : vs.locked ? 'lukittu' : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

export async function teslaCall(action, args = {}) {
  const v = await vin()
  const cmd = (name, params) => call('POST', `/${v}/command/${name}`, { wait_for_completion: true, ...params })
  const expect = (r, text) => {
    if (r?.result === false) throw new Error(`Auto vastasi: ${r?.reason || 'ei onnistunut'}`)
    return text
  }
  switch (action) {
    case 'tila':
      return fmtState(await call('GET', `/${v}/state`, { use_cache: true }))
    case 'lammita': {
      const temp = Number(args.lampotila)
      if (Number.isFinite(temp) && temp >= 15 && temp <= 28) await cmd('set_temperatures', { temperature: temp })
      const r = await cmd('start_climate')
      if (args.sulatus) await cmd('start_max_defrost').catch(() => {})
      return expect(r, `Auton lämmitys päällä${Number.isFinite(temp) ? ` (${temp} °C)` : ''}${args.sulatus ? ', sulatus päällä' : ''}. Lämpenee noin 10–15 min; sammuu itsestään.`)
    }
    case 'lammitys_pois':
      return expect(await cmd('stop_climate'), 'Auton lämmitys pois.')
    case 'sijainti': {
      const l = await call('GET', `/${v}/location`)
      return l?.address ? `Auto on: ${l.address}${l.saved_location ? ` (${l.saved_location})` : ''}.` : `Auto on koordinaateissa ${l?.latitude}, ${l?.longitude}.`
    }
    case 'lukitse':
      return expect(await cmd('lock'), 'Auto lukittu.')
    case 'lataus_paalle':
      return expect(await cmd('start_charging'), 'Lataus käynnistetty (jos johto on kiinni).')
    case 'lataus_pois':
      return expect(await cmd('stop_charging'), 'Lataus pysäytetty.')
    default:
      throw new Error(`Tuntematon toiminto ${action}`)
  }
}

export function teslaServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const safe = (fn) => async (a) => {
    try {
      const r = await fn(a ?? {})
      console.log(`[jarvis] tesla: ${String(r).slice(0, 120)}`)
      return ok(r)
    } catch (err) {
      console.log(`[jarvis] tesla: virhe ${String(err?.message ?? err).slice(0, 160)}`)
      return ok(`Tesla: ${err?.message ?? err}`)
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_tesla',
    version: '1.0.0',
    instructions: 'Eliaksen Tesla (Tessie): lämmitys päälle/pois, tila (akku, lataus, lämpötila, lukitus), sijainti, lukitus, lataus. Ei ovien avausta eikä ajamista.',
    tools: [
      tool(
        'tesla',
        'Tesla-auto. toiminto: tila (akku %, lataus, sisä-/ulkolämpötila, lukitus) | lammita (ilmastointi/lämmitys päälle; lampotila 15–28 °C valinnainen; sulatus=true pakkasella) | ' +
          'lammitys_pois | sijainti (osoite) | lukitse | lataus_paalle | lataus_pois. "Lämmitä auto" → lammita. Unessa oleva auto herää komennosta (10–30 s).',
        {
          toiminto: z.enum(['tila', 'lammita', 'lammitys_pois', 'sijainti', 'lukitse', 'lataus_paalle', 'lataus_pois']),
          lampotila: z.number().min(15).max(28).optional(),
          sulatus: z.boolean().optional(),
        },
        safe((a) => teslaCall(a.toiminto, a)),
      ),
    ],
  })
}
