/**
 * Spotify Connect: "soita Darude Samsungilla", "laita se soittolista projektorille", "seuraava biisi", "tauko".
 *
 *   Spotifyn Web API (PKCE, ei client secretiä). Eliaksen oma kehittäjäsovellus (developer.spotify.com, ilmainen; Premium vaaditaan).
 *   ~/.jarvis/spotify.json { clientId, refresh (DPAPI-salattu) , devices: { alias: laitteen nimi } }. Malli ei näe tokenia.
 *   Asennus: tyokalut\asenna_spotify.bat (kirjautuminen selaimessa Eliaksen itse tekemänä).
 *
 *   Laite: samsung | projektori | kone | nimi. Jos laite ei näy Spotify Connectissa, Spotify-sovellus avataan ensin
 *   kyseisellä laitteella (Samsung: Tizen-API, projektori: ADB) ja odotetaan, että se ilmestyy (max ~20 s).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG = join(homedir(), '.jarvis', 'spotify.json')
const cfg = () => {
  try {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')) : null
  } catch {
    return null
  }
}
export const spotifyConfigured = () => Boolean(cfg()?.clientId && cfg()?.refresh)

const ps = (script, input) =>
  new Promise((resolve, reject) => {
    const p = execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (err, out) => (err ? reject(err) : resolve(String(out).replace(/\r?\n$/, ''))))
    if (input != null) p.stdin.end(input)
  })
const decrypt = (enc) =>
  process.platform !== 'win32'
    ? Promise.resolve(enc)
    : ps(`$s = ConvertTo-SecureString '${String(enc).replace(/'/g, '')}'; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`)
const encrypt = (plain) =>
  process.platform !== 'win32' ? Promise.resolve(plain) : ps('$t = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $t -AsPlainText -Force | ConvertFrom-SecureString', plain)

let access = { token: '', until: 0 }
async function accessToken() {
  if (access.token && Date.now() < access.until - 60_000) return access.token
  const c = cfg()
  if (!c?.refresh) throw new Error('Spotifyä ei ole yhdistetty: aja tyokalut\\asenna_spotify.bat.')
  const refresh = await decrypt(c.refresh)
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: c.clientId }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Spotify-kirjautuminen vanhentui (${j.error ?? res.status}). Aja asenna_spotify.bat uudelleen.`)
  access = { token: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 }
  // PKCE kierrättää refresh-tokenin: uusi talteen salattuna.
  if (j.refresh_token && j.refresh_token !== refresh) {
    try {
      writeFileSync(CONFIG, JSON.stringify({ ...cfg(), refresh: await encrypt(j.refresh_token) }, null, 1))
    } catch (err) {
      console.warn('[jarvis] spotify: uutta tokenia ei tallennettu:', err?.message ?? err)
    }
  }
  return access.token
}

async function api(method, path, body) {
  const t = await accessToken()
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return {}
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    const reason = j?.error?.reason || j?.error?.message || res.status
    if (res.status === 403 && /PREMIUM/i.test(String(reason))) throw new Error('Spotify vaatii Premiumin soiton ohjaukseen.')
    if (res.status === 404 && /device/i.test(String(reason))) throw new Error('Spotify-laitetta ei löytynyt (sovellus kiinni?).')
    throw new Error(`Spotify ${res.status}: ${String(reason).slice(0, 140)}`)
  }
  return j
}

const devices = async () => (await api('GET', '/me/player/devices')).devices ?? []

/** Laitteen valinta: alias (samsung/projektori/kone) → tallennettu nimi tai arvaus nimestä/tyypistä. */
function pickDevice(list, laite) {
  if (!laite) return list.find((d) => d.is_active) ?? null
  const q = String(laite).toLowerCase()
  const saved = cfg()?.devices?.[q]
  if (saved) {
    const d = list.find((x) => x.name === saved)
    if (d) return d
  }
  const guesses = {
    samsung: (d) => /samsung|\[tv\]/i.test(d.name) || (d.type === 'TV' && !/xgimi|horizon|projector|android/i.test(d.name)),
    projektori: (d) => /xgimi|horizon|projector|projektori|android tv|google tv/i.test(d.name),
    kone: (d) => d.type === 'Computer',
    puhelin: (d) => d.type === 'Smartphone',
  }
  const g = guesses[q]
  return (g ? list.find(g) : null) ?? list.find((d) => d.name.toLowerCase().includes(q)) ?? null
}

/** Avaa Spotify-sovelluksen laitteella, jotta se ilmestyy Connect-listaan. */
async function wakeDevice(laite) {
  try {
    if (laite === 'samsung') {
      const { tvCall } = await import('./telkkari.mjs')
      await tvCall('paalle').catch(() => {})
      await tvCall('avaa', { sovellus: 'spotify' })
      return true
    }
    if (laite === 'projektori') {
      const { projectorCall } = await import('./projektori.mjs')
      const r = await projectorCall('projektori_avaa', { sovellus: 'spotify' })
      return !r.error
    }
  } catch {
    /* ei onnistunut */
  }
  return false
}

async function ensureDevice(laite) {
  let list = await devices()
  let d = pickDevice(list, laite)
  if (d || !laite) return d
  if (!(await wakeDevice(String(laite).toLowerCase()))) return null
  for (let i = 0; i < 10 && !d; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    list = await devices().catch(() => [])
    d = pickDevice(list, laite)
  }
  if (d && laite) {
    // Opittu: tämä nimi = tämä alias (seuraavalla kerralla suoraan).
    const c = cfg()
    writeFileSync(CONFIG, JSON.stringify({ ...c, devices: { ...(c.devices ?? {}), [String(laite).toLowerCase()]: d.name } }, null, 1))
  }
  return d
}

const uriFrom = (s) => {
  const m = String(s ?? '').match(/(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?|spotify:)(track|playlist|album|artist|show|episode)[/:]([A-Za-z0-9]{10,40})/)
  return m ? `spotify:${m[1]}:${m[2]}` : null
}

export async function spotifyPlay({ haku, linkki, tyyppi, laite, sekoita } = {}) {
  let uri = uriFrom(linkki) || uriFrom(haku)
  let label = ''
  if (!uri) {
    const q = String(haku ?? '').trim()
    if (!q) throw new Error('Kerro mitä soitetaan (kappale, artisti, albumi tai soittolista) tai anna linkki.')
    const type = { kappale: 'track', biisi: 'track', soittolista: 'playlist', albumi: 'album', artisti: 'artist' }[tyyppi] ?? 'track,playlist,album,artist'
    const r = await api('GET', `/search?${new URLSearchParams({ q, type, limit: '5', market: 'from_token' })}`)
    const pick = (k) => (r[k]?.items ?? []).filter(Boolean)[0]
    const order = tyyppi ? [{ track: 'tracks', playlist: 'playlists', album: 'albums', artist: 'artists' }[type]] : ['tracks', 'playlists', 'albums', 'artists']
    let hit = null
    for (const k of order) if ((hit = pick(k))) break
    if (!hit) return `En löytänyt Spotifystä "${q}".`
    uri = hit.uri
    label = `${hit.name}${hit.artists?.[0]?.name ? ` – ${hit.artists[0].name}` : hit.owner?.display_name ? ` (${hit.owner.display_name})` : ''}`
  }
  const d = await ensureDevice(laite)
  if (!d) {
    const list = await devices().catch(() => [])
    return `Laitetta "${laite || 'aktiivinen'}" ei löytynyt Spotifysta. Näkyvissä: ${list.map((x) => x.name).join(', ') || 'ei mitään (avaa Spotify jollain laitteella)'}.`
  }
  const isTrack = /^spotify:(track|episode):/.test(uri)
  await api('PUT', `/me/player/play?device_id=${encodeURIComponent(d.id)}`, isTrack ? { uris: [uri] } : { context_uri: uri })
  if (sekoita != null) await api('PUT', `/me/player/shuffle?state=${sekoita ? 'true' : 'false'}&device_id=${encodeURIComponent(d.id)}`).catch(() => {})
  // Tarkistus: soiko oikeasti.
  await new Promise((r) => setTimeout(r, 1500))
  const now = await api('GET', '/me/player').catch(() => null)
  const playing = now?.is_playing && now?.device?.id === d.id
  return `${playing ? 'Soi' : 'Käynnistetty (ei vielä vahvistettu soivaksi)'}: ${label || now?.item?.name || uri} → ${d.name}.`
}

export async function spotifyControl({ toiminto, arvo, laite } = {}) {
  const d = laite ? await ensureDevice(laite) : null
  const q = d ? `?device_id=${encodeURIComponent(d.id)}` : ''
  switch (toiminto) {
    case 'tauko':
      await api('PUT', `/me/player/pause${q}`)
      return 'Spotify tauolla.'
    case 'jatka':
      await api('PUT', `/me/player/play${q}`)
      return 'Spotify jatkuu.'
    case 'seuraava':
      await api('POST', `/me/player/next${q}`)
      return 'Seuraava kappale.'
    case 'edellinen':
      await api('POST', `/me/player/previous${q}`)
      return 'Edellinen kappale.'
    case 'aani': {
      const v = Math.max(0, Math.min(100, Math.round(Number(arvo))))
      if (!Number.isFinite(v)) throw new Error('Anna äänenvoimakkuus 0–100.')
      await api('PUT', `/me/player/volume?volume_percent=${v}${d ? `&device_id=${encodeURIComponent(d.id)}` : ''}`)
      return `Spotifyn äänenvoimakkuus ${v} %.`
    }
    case 'siirra': {
      if (!d) throw new Error('Kerro mihin laitteeseen siirretään.')
      await api('PUT', '/me/player', { device_ids: [d.id], play: true })
      return `Soitto siirretty: ${d.name}.`
    }
    case 'nyt': {
      const p = await api('GET', '/me/player').catch(() => null)
      if (!p?.item) return 'Spotifyssa ei soi mitään.'
      return `${p.is_playing ? 'Soi' : 'Tauolla'}: ${p.item.name} – ${p.item.artists?.map((a) => a.name).join(', ') ?? ''} (${p.device?.name ?? '?'}, ääni ${p.device?.volume_percent ?? '?'} %).`
    }
    case 'laitteet': {
      const list = await devices()
      return list.length ? `Spotify-laitteet: ${list.map((x) => `${x.name} (${x.type}${x.is_active ? ', soi' : ''})`).join(', ')}` : 'Ei Spotify-laitteita näkyvissä: avaa Spotify jollain laitteella.'
    }
    default:
      throw new Error(`Tuntematon toiminto ${toiminto}`)
  }
}

export function spotifyServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const safe = (fn) => async (a) => {
    try {
      const r = await fn(a ?? {})
      console.log(`[jarvis] spotify: ${String(r).slice(0, 120)}`)
      return ok(r)
    } catch (err) {
      console.log(`[jarvis] spotify: virhe ${String(err?.message ?? err).slice(0, 160)}`)
      return { ...ok(`Spotify: ${err?.message ?? err}`), isError: true }
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_spotify',
    version: '1.0.0',
    instructions: 'Spotify Connect: play a song/playlist/album/artist on Samsung TV, projector or PC; pause/next/volume/transfer. Opens the Spotify app on the device first if needed.',
    tools: [
      tool(
        'spotify_soita',
        'Soittaa Spotifystä ja tarkistaa että soi. haku = kappale/artisti/albumi/soittolista vapaasti ("Darude Sandstorm", "chill lista") TAI linkki = open.spotify.com / spotify:-linkki. ' +
          'tyyppi rajaa haun (kappale|soittolista|albumi|artisti). laite = samsung | projektori | kone | laitteen nimi (tyhjä = nyt soiva). Avaa tarvittaessa Spotify-sovelluksen laitteella.',
        {
          haku: z.string().max(200).optional(),
          linkki: z.string().max(300).optional(),
          tyyppi: z.enum(['kappale', 'soittolista', 'albumi', 'artisti']).optional(),
          laite: z.string().max(60).optional(),
          sekoita: z.boolean().optional(),
        },
        safe((a) => spotifyPlay(a)),
      ),
      tool(
        'spotify_ohjaa',
        'Spotifyn ohjaus: tauko | jatka | seuraava | edellinen | aani (arvo 0–100) | siirra (laite) | nyt (mitä soi) | laitteet.',
        { toiminto: z.enum(['tauko', 'jatka', 'seuraava', 'edellinen', 'aani', 'siirra', 'nyt', 'laitteet']), arvo: z.number().optional(), laite: z.string().max(60).optional() },
        safe((a) => spotifyControl(a)),
      ),
    ],
  })
}
