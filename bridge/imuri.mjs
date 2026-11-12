/**
 * Imuri: Roborock Q5 Pro (+ tyhjennystelakka) — "imuroi keittiö", "imuri kotiin", "imurin tila".
 *
 *   Toteutus: python-roborock (sama kirjasto kuin Home Assistantissa) pienen apurin kautta (bridge/roborock_apuri.py).
 *   Apuri yhdistää ensisijaisesti paikallisesti kotiverkossa, muuten Roborockin MQTT-pilven kautta. Kirjautuminen kerran
 *   sähköpostikoodilla (tyokalut\asenna_imuri.bat) → ~/.jarvis/roborock.json {python, username, user_data, duid, name, huoneet}.
 *   Malli ei lue tiedostoa; se näkee vain työkalujen vastaukset.
 *
 *   Turva: vain siivouskomennot (aloita/tauko/jatka/seis/kotiin/teho/etsi/tyhjennä). Ei kartan muokkausta, ei asetuksia,
 *   ei kauko-ohjausajoa. Kokoustilassa imuria ei käynnistetä (melu) — rutiinit tarkistavat sen.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG = join(homedir(), '.jarvis', 'roborock.json')
const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'roborock_apuri.py')
const cfg = () => {
  try {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')) : null
  } catch {
    return null
  }
}
export const vacuumConfigured = () => Boolean(cfg()?.user_data && existsSync(HELPER))
const saveCfg = (c) => writeFileSync(CONFIG, JSON.stringify(c))

/** Ajaa apurin yhden komennon. Vastaus on apurin JSON. */
let inflight = Promise.resolve()
function run(cmd, args = [], { timeoutMs = 100_000 } = {}) {
  const c = cfg()
  if (!c?.user_data) return Promise.reject(new Error('Imuria ei ole yhdistetty: aja tyokalut\\asenna_imuri.bat.'))
  const py = c.python || (process.platform === 'win32' ? 'python' : 'python3')
  // Yksi apuri kerrallaan: kaksi rinnakkaista MQTT-istuntoa samalle tilille sekoittaa Roborockin pilven.
  const job = inflight.then(
    () =>
      new Promise((resolve, reject) => {
        execFile(py, ['-X', 'utf8', HELPER, cmd, ...args.map(String)], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, out, errOut) => {
          const line = String(out ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
          let j = null
          try {
            j = JSON.parse(line)
          } catch {}
          if (j && j.ok === false) return reject(new Error(j.error || 'imuri: tuntematon virhe'))
          if (j) return resolve(j)
          if (err?.killed) return reject(new Error('Imuri ei vastannut ajoissa (ei kotiverkossa tai Roborockin pilvi hidas).'))
          const tail = String(errOut ?? '').trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200)
          reject(new Error(tail || err?.message || 'imuri: ei vastausta'))
        })
      }),
  )
  inflight = job.catch(() => {})
  return job
}

/** Roborockin virhekoodit suomeksi + mitä tehdä (python-roborock RoborockErrorCode -nimet). */
const ERROR_FI = {
  bumper_stuck: 'puskuri on jumissa — painele etupuskuria kevyesti joka kohdasta, irrota mahdollinen johto tai matto ja paina virtanappia',
  vertical_bumper_pressed: 'puskuri painuu ylhäältä — imuri on luultavasti jumissa huonekalun alla, siirrä se vapaalle lattialle',
  lidar_blocked: 'laseranturin (päällä oleva torni) edessä on jotain tai torni on jumissa — poista este ja pyöritä tornia kevyesti',
  laser_sensor_fault: 'laseranturi ei pyöri — tarkista ettei tornin päällä tai ympärillä ole mitään',
  wheels_suspended: 'pyörät ovat ilmassa — nosta imuri tasaiselle lattialle',
  wheels_jammed: 'pyörä on jumissa — irrota hiukset tai roska pyörästä',
  robot_trapped: 'imuri on jumissa — siirrä se vapaalle lattialle ja jatka',
  robot_tilted: 'imuri on kallellaan — nosta se tasaiselle lattialle',
  cliff_sensor_error: 'putoamisanturit ovat likaiset tai imuri on kynnyksellä — pyyhi pohjan anturit kuivalla liinalla',
  optical_flow_sensor_dirt: 'pohjan optinen anturi on likainen — pyyhi se kuivalla liinalla',
  main_brush_jammed: 'pääharja on jumissa — irrota harja ja poista hiukset',
  side_brush_jammed: 'sivuharja on jumissa — irrota hiukset sivuharjasta',
  side_brush_error: 'sivuharja ei pyöri — irrota hiukset sivuharjasta',
  fan_error: 'imuri ei saa imua — tyhjennä pölysäiliö ja puhdista suodatin',
  filter_blocked: 'suodatin on tukossa — puhdista tai vaihda suodatin',
  no_dustbin: 'pölysäiliö puuttuu tai on väärin paikallaan — paina säiliö kunnolla paikalleen',
  low_battery: 'akku on liian vähissä — anna latautua telakassa',
  charging_error: 'lataus ei onnistu — pyyhi latauskontaktit imurista ja telakasta',
  battery_error: 'akkuvirhe — anna latautua; jos toistuu, katso Roborock-sovellus',
  wall_sensor_dirty: 'seinäanturi on likainen — pyyhi imurin oikea kylki',
  return_to_dock_fail: 'imuri ei löydä telakkaan — siirrä se lähelle telakkaa tai nosta telakkaan',
  dock_locator_error: 'telakka ei löydy — tarkista että telakassa on virta ja sen edessä on tilaa',
  nogo_zone_detected: 'imuri on kielletyllä alueella — siirrä se pois alueelta',
  invisible_wall_detected: 'imuri on näkymättömän seinän takana — siirrä se toiselle puolelle',
  cannot_cross_carpet: 'imuri ei pääse maton yli — siirrä matto tai imuri',
  internal_error: 'sisäinen virhe — sammuta imuri virtanapista hetkeksi ja käynnistä uudelleen',
}
export const errorFi = (code) => {
  const k = String(code ?? '').toLowerCase()
  return ERROR_FI[k] ?? (k ? `virhe ${k} (katso Roborock-sovellus)` : '')
}

const fmtHours = (h) => (h == null ? null : h <= 0 ? 'VAIHDA' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} pv`)
export function statusText(s) {
  const parts = [`${s.nimi || 'Imuri'}: ${s.tila_fi || s.tila}${s.virhe ? ` — ${errorFi(s.virhe)}` : ''}`, Number.isFinite(s.akku) ? `akku ${s.akku} %` : null, s.teho ? `teho ${s.teho}` : null]
  if (s.siivoaa && s.siivous_min > 0) parts.push(`tämä siivous ${s.siivous_min} min, ${s.siivous_m2} m²`)
  else if (s.viimeisin?.alku) parts.push(`viimeksi ${new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(s.viimeisin.alku * 1000))} (${s.viimeisin.kesto_min} min, ${s.viimeisin.ala_m2} m²)`)
  parts.push(`yhteys ${s.yhteys}`)
  const k = s.kulutusosat
  const due = k && !k.virhe ? [['pääharja', k.paaharja_h], ['sivuharja', k.sivuharja_h], ['suodatin', k.suodatin_h], ['anturit', k.anturit_h]].filter(([, h]) => h != null && h < 48).map(([n, h]) => `${n} ${fmtHours(h)}`) : []
  if (due.length) parts.push(`huolto pian: ${due.join(', ')}`)
  return parts.filter(Boolean).join(' · ')
}

/** Huoneiden nimet → id:t. Nimet talletetaan configiin, jotta "keittiö" toimii ilman uutta hakua. */
async function roomIds(names) {
  const c = cfg() ?? {}
  let rooms = c.huoneet
  if (!Array.isArray(rooms) || !rooms.length) {
    rooms = (await run('huoneet')).huoneet ?? []
    if (rooms.length) saveCfg({ ...c, huoneet: rooms })
  }
  const ids = []
  const missing = []
  for (const n of names) {
    const q = String(n).toLowerCase().trim()
    const hit = rooms.find((r) => String(r.nimi).toLowerCase() === q) ?? rooms.find((r) => String(r.nimi).toLowerCase().includes(q) || q.includes(String(r.nimi).toLowerCase()))
    if (hit) ids.push(hit.id)
    else missing.push(n)
  }
  return { ids, missing, rooms }
}

export async function vacuumCall(action, args = {}) {
  switch (action) {
    case 'tila':
      return statusText(await run('tila'))
    case 'huoneet': {
      const r = (await run('huoneet')).huoneet ?? []
      if (r.length) saveCfg({ ...(cfg() ?? {}), huoneet: r })
      return r.length ? `Huoneet: ${r.map((x) => `${x.nimi} (${x.id})`).join(', ')}` : 'Kartassa ei ole nimettyjä huoneita — nimeä ne Roborock-sovelluksessa.'
    }
    case 'aloita': {
      const names = Array.isArray(args.huoneet) ? args.huoneet.filter(Boolean) : []
      let ids = []
      let note = ''
      if (names.length) {
        const r = await roomIds(names)
        if (r.missing.length) note = ` Huonetta ${r.missing.join(', ')} ei ole kartassa (huoneet: ${r.rooms.map((x) => x.nimi).join(', ')}).`
        if (!r.ids.length) return `Imurointia ei aloitettu.${note}`
        ids = r.ids
      }
      if (args.teho) await run('teho', [args.teho])
      let s
      try {
        s = await run('aloita', ids)
      } catch (err) {
        throw new Error(await explainFailure(err, 'aloittaa'))
      }
      return `${ids.length ? `Imuroi huoneet ${names.join(', ')}` : 'Imuroi koko kodin'}${args.teho ? ` teholla ${args.teho}` : ''}.${note} ${statusText(s)}`
    }
    case 'tauko':
      await run('tauko')
      return 'Imuri tauolla.'
    case 'jatka':
      try {
        await run('jatka')
      } catch (err) {
        throw new Error(await explainFailure(err, 'jatkaa'))
      }
      return 'Imuri jatkaa.'
    case 'seis':
      await run('seis')
      return 'Imurointi lopetettu (imuri jää paikalleen; "imuri kotiin" vie telakkaan).'
    case 'kotiin':
      await run('kotiin')
      return 'Imuri palaa telakkaan.'
    case 'etsi':
      await run('etsi')
      return 'Imuri antaa äänimerkin.'
    case 'tyhjenna':
      await run('tyhjenna')
      return 'Telakka tyhjentää pölysäiliön.'
    case 'teho': {
      const r = await run('teho', [args.teho])
      return `Imutehoksi ${r.teho ?? args.teho}.`
    }
    default:
      throw new Error(`Tuntematon toiminto ${action}`)
  }
}

/** Kun komento kaatuu (esim. "Param error"), katsotaan tila ja kerrotaan syy suomeksi raakavirheen sijaan. */
async function explainFailure(err, verb) {
  const raw = String(err?.message ?? err)
  try {
    const s = await run('tila', [], { timeoutMs: 45_000 })
    if (s?.virhe) return `Imuri ei voi ${verb}: ${errorFi(s.virhe)}. Korjaa ja sano sitten "imuri jatka" tai "imuroi".`
    if (verb === 'jatka' || verb === 'jatkaa') {
      if (!/paused|tauko/i.test(`${s?.tila} ${s?.tila_fi}`)) return `Imuri ei ole tauolla (${s?.tila_fi || s?.tila}) — sano "imuroi" aloittaaksesi alusta.`
    }
    return `Imuri ei voinut ${verb} (${raw.slice(0, 80)}). Tila nyt: ${statusText(s)}`
  } catch {
    return `Imuri ei voinut ${verb}: ${raw.slice(0, 120)}`
  }
}

/** Rutiineille: onko imuri liikkeellä (nukkumaan → kotiin). */
export async function vacuumBusy() {
  try {
    const s = await run('tila', [], { timeoutMs: 45_000 })
    return Boolean(s.siivoaa) || /cleaning|returning|going|zoned|segment|spot/.test(String(s.tila))
  } catch {
    return false
  }
}

export function vacuumServer({ isMeetingActive = () => false } = {}) {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const safe = (fn) => async (a) => {
    try {
      const r = await fn(a ?? {})
      console.log(`[jarvis] imuri: ${String(r).slice(0, 140)}`)
      return ok(r)
    } catch (err) {
      console.log(`[jarvis] imuri: virhe ${String(err?.message ?? err).slice(0, 160)}`)
      return { content: [{ type: 'text', text: `Imuri: ${err?.message ?? err}` }], isError: true }
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_imuri',
    version: '1.0.0',
    instructions: 'Roborock-robotti-imuri: tila, aloita (koko koti tai huoneet nimellä), tauko, jatka, seis, kotiin, teho, etsi, tyhjennä säiliö. Vastaukset kestävät 5–20 s (yhteys avataan joka kerta).',
    tools: [
      tool('imuri_tila', 'Imurin tila: mitä tekee, akku, imuteho, viimeisin siivous, kulutusosat (harjat, suodatin). "Missä imuri / mitä imuri tekee / onko imuroitu".', {}, safe(() => vacuumCall('tila'))),
      tool('imuri_huoneet', 'Listaa kartan huoneet nimineen (nimet annetaan Roborock-sovelluksessa).', {}, safe(() => vacuumCall('huoneet'))),
      tool(
        'imuri_aloita',
        'Aloittaa imuroinnin. huoneet = nimet listana ("keittiö", "olohuone"); tyhjä = koko koti. teho valinnainen: quiet | balanced | turbo | max. ' +
          'Älä käynnistä kokouksen tai puhelun aikana (melu) — kysy ensin. "Imuroi" ilman huonetta = koko koti. silti=true ohittaa kokoustilan eston, kun Elias sanoo "imuroi silti".',
        { huoneet: z.array(z.string().max(40)).max(12).optional(), teho: z.enum(['quiet', 'balanced', 'turbo', 'max', 'max_plus']).optional(), silti: z.boolean().optional() },
        safe((a) => {
          if (isMeetingActive() && !a.silti) return 'Kokoustila on päällä — en käynnistä imuria nyt (melu). Sano uudestaan kokouksen jälkeen tai "imuroi silti".'
          return vacuumCall('aloita', a)
        }),
      ),
      tool('imuri_tauko', 'Tauko (jatkuu samasta kohdasta: imuri_jatka).', {}, safe(() => vacuumCall('tauko'))),
      tool('imuri_jatka', 'Jatkaa tauolta.', {}, safe(() => vacuumCall('jatka'))),
      tool('imuri_seis', 'Lopettaa siivouksen (jää paikalleen). Yleensä parempi: imuri_kotiin.', {}, safe(() => vacuumCall('seis'))),
      tool('imuri_kotiin', 'Lopettaa ja palaa telakkaan lataamaan. "Imuri kotiin / lopeta imurointi / riittää".', {}, safe(() => vacuumCall('kotiin'))),
      tool('imuri_teho', 'Imuteho: quiet (hiljainen, yö) | balanced | turbo | max (| max_plus jos tuettu).', { teho: z.enum(['quiet', 'balanced', 'turbo', 'max', 'max_plus']) }, safe((a) => vacuumCall('teho', a))),
      tool('imuri_etsi', 'Imuri antaa äänimerkin ("missä imuri on" kun se on hukassa).', {}, safe(() => vacuumCall('etsi'))),
      tool('imuri_tyhjenna', 'Telakka tyhjentää imurin pölysäiliön (imurin pitää olla telakassa). Äänekäs ~15 s.', {}, safe(() => vacuumCall('tyhjenna'))),
    ],
  })
}
