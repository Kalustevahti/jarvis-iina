/**
 * Koti-näkymä (JARVIS 2.0, 8.11.2026): laitteiden tila yhdellä pyynnöllä ja laattojen pikatoiminnot
 * suoraan ilman kielimallia (nopea, ei kuluta Claude-käyttöä).
 *
 *   koti_tila    valot, projektori, Samsung, imuri, lämpöpumppu (viimeksi asetettu — IR ei kerro tilaa), kamerat.
 *                { laite?: 'valot'|'projektori'|'samsung'|'imuri', pakota?: bool, odota?: bool }
 *   valo_aseta   kaikki valot tai nimetty valo: paalle, kirkkaus, vari, lampotila.
 *   imuri        aloita | tauko | jatka | kotiin | etsi | tila.
 *   rutiini      leffailta | hyvaa_yota | huomenta | nukkumaan (samat kuin puheella).
 *
 * Nopeus (9.11.2026): koti_tila vastaa heti välimuistista (koti_valimuisti.mjs, stale-while-revalidate) ja käynnistää
 * taustahaun. Jokaisen laitteen uusi tila työnnetään sivuille heti kun se saapuu (onHomePart → server.mjs:
 * {type:'koti_osa'}). Ensimmäinen kutsu käynnistyksen jälkeen odottaa enintään ~1,5 s. Projektori ja Samsung, jotka
 * eivät vastaa, merkitään "pois" ja tarkistetaan enintään 60 s välein (laitteen komento nollaa tämän). Imuria (hidas
 * Roborock-apuri) haetaan vain 2 min välein, imurin omien komentojen jälkeen tai kun sitä pyydetään nimeltä.
 *
 * Lämpöpumpun viimeisin asetus muistetaan tiedostossa ~/.jarvis/ilp_tila.json (rememberAc), jotta
 * laatta voi näyttää "21 °C, lämmitys" — merkitään aina "viimeksi asetettu", koska IR on yksisuuntainen.
 */
import { lightsConfigured, listLights, setLights, tuyaCall } from './valot.mjs'
import { onProjectorWake, projectorCall, projectorConfigured } from './projektori.mjs'
import { tvCall, tvConfigured } from './telkkari.mjs'
import { vacuumCall, vacuumConfigured } from './imuri.mjs'
import { irConfigured } from './ir.mjs'
import { cameraConfigured, cameraNames } from './kamera.mjs'
import { runRoutine } from './rutiinit.mjs'
import { readAc } from './ilp_tila.mjs'
import { createHomeCache, errMsg, lampFromStatus, withTimeout } from './koti_valimuisti.mjs'

export { rememberAc } from './ilp_tila.mjs'

export const HOME_TOOLS = new Set(['koti_tila', 'valo_aseta', 'imuri', 'rutiini'])

// ---------------------------------------------------------------- valot
/**
 * All lamps with as few Tuya calls as possible: the device list (60 s cache in valot.mjs, which also carries the
 * online flags) plus one batch status call per 20 lamps. If the batch endpoint is refused, each lamp is asked in
 * parallel with a short timeout instead of the old one-call-per-lamp-with-10-s-timeout.
 */
async function lightsState() {
  const list = await listLights()
  const online = list.filter((d) => d.online)
  const status = new Map()
  try {
    for (let i = 0; i < online.length; i += 20) {
      const ids = online.slice(i, i + 20).map((d) => d.id)
      const r = await tuyaCall('GET', `/v1.0/iot-03/devices/status?device_ids=${ids.join(',')}`)
      for (const row of r ?? []) status.set(row.id, Object.fromEntries((row.status ?? []).map((x) => [x.code, x.value])))
    }
  } catch {
    await Promise.all(
      online.map((d) =>
        withTimeout(tuyaCall('GET', `/v1.0/iot-03/devices/${d.id}/status`), 4000, d.name)
          .then((r) => status.set(d.id, Object.fromEntries((r ?? []).map((x) => [x.code, x.value]))))
          .catch(() => {}),
      ),
    )
  }
  return list.map((d) => (!d.online ? { nimi: d.name, online: false, paalla: false } : status.has(d.id) ? lampFromStatus(d, status.get(d.id)) : { nimi: d.name, online: true, paalla: null }))
}

/** Projektorin tilateksti → { tila: 'pois'|'valmiustila'|'paalla', sovellus, toisto } */
export function parseProjector(text) {
  const t = String(text ?? '')
  const tila = /ei vastaa|ei verkossa/i.test(t) ? 'pois' : /valmiustilassa/i.test(t) ? 'valmiustila' : /on päällä/i.test(t) ? 'paalla' : 'tuntematon'
  const sovellus = t.match(/auki: ([^,.\n]+)/)?.[1]?.trim() ?? ''
  const toisto = t.match(/Toisto: ([^\n]+)/)?.[1]?.trim() ?? ''
  const aani = Number(t.match(/ääni (\d+) %/)?.[1] ?? NaN)
  return { tila, sovellus, toisto, aani: Number.isFinite(aani) ? aani : null }
}

/** Imurin tilateksti → { tila, akku, siivoaa, virhe } */
export function parseVacuum(text) {
  const t = String(text ?? '')
  const head = t.split(' · ')[0] ?? ''
  const tila = head.replace(/^[^:]*:\s*/, '').split(' — ')[0].trim()
  const akku = Number(t.match(/akku (\d+) %/)?.[1] ?? NaN)
  return {
    tila: tila || 'tuntematon',
    akku: Number.isFinite(akku) ? akku : null,
    siivoaa: /siivo|imuroi|cleaning/i.test(tila) || /tämä siivous/.test(t),
    virhe: head.includes(' — ') ? head.split(' — ').slice(1).join(' — ') : '',
  }
}

const tvState = async () => {
  const t = String(await tvCall('tila', {}))
  return { tila: /ei vastaa/i.test(t) ? 'pois' : /valmiustilassa/i.test(t) ? 'valmiustila' : /päällä/i.test(t) ? 'paalla' : 'tuntematon' }
}

const home = createHomeCache({
  devices: {
    valot: { on: lightsConfigured, ms: 8000, ttl: 4000, fn: async () => ({ lista: await lightsState() }) },
    projektori: {
      on: projectorConfigured,
      ms: 15_000,
      ttl: 4000,
      fn: async () => {
        const r = await projectorCall('projektori_tila', {})
        return parseProjector(r?.text ?? r)
      },
      offline: (s) => s.tila === 'pois' || Boolean(s.virhe),
    },
    samsung: { on: tvConfigured, ms: 10_000, ttl: 4000, fn: tvState, offline: (s) => s.tila === 'pois' || Boolean(s.virhe) },
    // Roborockin apuri on hidas ja ajetaan yksi kerrallaan: tila välimuistiin 2 min (imurin napin jälkeen haetaan heti).
    imuri: { on: vacuumConfigured, ms: 25_000, ttl: 120_000, fn: async () => parseVacuum(await vacuumCall('tila')) },
  },
})

/** Every device update as it arrives: { laite, tila, at } (server.mjs pushes these to the open pages). */
export const onHomePart = (fn) => home.onUpdate(fn)

// Projector waking up (also from voice or a routine): the Viihde page shows "Herätetään… ~20 s"; afterwards a fresh read.
onProjectorWake((on) => {
  home.patch('projektori', { heraa: on })
  if (!on) {
    home.clearBackoff('projektori')
    void home.refresh('projektori', { force: true })
  }
})

const ROUTINE_NAMES = { leffailta: 'Leffailta', hyvaa_yota: 'Hyvää yötä', nukkumaan: 'Nukkumaan', huomenta: 'Huomenta' }
const routinesRunning = new Set()
/**
 * A routine from the page answers at once ("Leffailta käynnissä…") and pushes its result as a koti_osa
 * { laite: 'rutiini', tila: { nimi, valmis, ok, teksti } } — the 9.11. leffailta held one request open for 74 s.
 * huomenta only reads the calendar and returns its text as before.
 */
function startRoutine(n, haku) {
  const label = ROUTINE_NAMES[n]
  if (routinesRunning.has(n)) return { text: `${label} on jo käynnissä.`, kaynnissa: true }
  routinesRunning.add(n)
  home.publish('rutiini', { nimi: n, valmis: false, teksti: `${label} käynnissä…` })
  void runRoutine(n, { haku })
    .then(
      (t) => ({ ok: !/Ei onnistunut|En sammuttanut|epäonnistui/i.test(String(t)), teksti: String(t) }),
      (e) => ({ ok: false, teksti: `Rutiini epäonnistui: ${errMsg(e)}` }),
    )
    .then((r) => {
      routinesRunning.delete(n)
      console.log(`[jarvis] rutiini ${n} valmis${r.ok ? '' : ' (virheitä)'}`)
      home.publish('rutiini', { nimi: n, valmis: true, ...r })
    })
  return { text: `${label} käynnissä…`, kaynnissa: true }
}

/** Lämpöpumppu and kamera are local reads (no network): always current. */
const localParts = () => ({
  ilp: irConfigured() ? { asennettu: true, ...(readAc() ?? { virta: null }) } : { asennettu: false },
  kamera: cameraConfigured() ? { asennettu: true, kamerat: cameraNames() } : { asennettu: false },
})
export const homeLocalPart = (laite) => localParts()[laite]

export async function homeState({ force = false, laite, odota = false } = {}) {
  const parts = await home.get({ force, laite, odota })
  return { at: Date.now(), ...parts, ...localParts() }
}

/**
 * A device command went out through the 'laite' request (server.mjs): the device answers again (clear the offline
 * backoff), and vacuum commands make the next vacuum query fresh. Returns the koti_tila device to re-check, if any.
 */
export function homeCommandSent(tyokalu) {
  const t = String(tyokalu ?? '')
  const laite = t.startsWith('projektori_') ? 'projektori' : t.startsWith('samsung_') ? 'samsung' : t === 'valo_aseta' ? 'valot' : t === 'imuri' ? 'imuri' : null
  if (laite) home.clearBackoff(laite)
  if (t === 'rutiini') ['projektori', 'samsung'].forEach((l) => home.clearBackoff(l))
  if (laite === 'imuri') home.invalidate('imuri')
  return laite
}

export async function homeCall(tyokalu, a = {}) {
  switch (tyokalu) {
    case 'koti_tila': {
      const s = await homeState({ force: !!a.pakota, laite: a.laite ? String(a.laite) : undefined, odota: !!a.odota })
      return { text: 'Kodin tila haettu.', koti: s }
    }
    case 'valo_aseta': {
      if (!lightsConfigured()) return { text: 'Valoja ei ole yhdistetty (tyokalut\\asenna_valot.bat).' }
      const opts = {}
      if (typeof a.paalle === 'boolean') opts.paalle = a.paalle
      if (a.kirkkaus != null) opts.kirkkaus = Math.max(1, Math.min(100, Number(a.kirkkaus)))
      if (a.vari) opts.vari = String(a.vari)
      if (a.lampotila != null) opts.lampotila = Number(a.lampotila)
      return { text: await setLights(a.nimi || 'kaikki', opts).catch((e) => `Ei onnistunut: ${errMsg(e)}`) }
    }
    case 'imuri': {
      if (!vacuumConfigured()) return { text: 'Imuria ei ole yhdistetty (tyokalut\\asenna_imuri.bat).' }
      const act = String(a.toiminto ?? 'tila')
      if (!['aloita', 'tauko', 'jatka', 'kotiin', 'etsi', 'tila'].includes(act)) throw new Error(`Tuntematon imurin toiminto ${act}`)
      home.invalidate('imuri')
      return { text: await vacuumCall(act, {}).catch((e) => `Ei onnistunut: ${errMsg(e)}`) }
    }
    case 'rutiini': {
      const n = String(a.nimi ?? '')
      if (!['leffailta', 'hyvaa_yota', 'huomenta', 'nukkumaan'].includes(n)) throw new Error(`Tuntematon rutiini ${n}`)
      if (n !== 'huomenta') return startRoutine(n, String(a.haku ?? ''))
      return { text: await runRoutine(n, { haku: String(a.haku ?? '') }).catch((e) => `Rutiini epäonnistui: ${errMsg(e)}`) }
    }
    default:
      throw new Error(`Tuntematon kotitoiminto ${tyokalu}`)
  }
}
