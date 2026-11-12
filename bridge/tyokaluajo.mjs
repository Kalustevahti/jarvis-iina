/**
 * JARVIS ajaa itse tyokalut-kansion .bat-tiedostoja (Elias 4.11.: "laita että jarvis voi ajaa bat tiedostot",
 * "pyri olemaan aina itsenäinen").
 *
 * Rajat (turva):
 *   - Vain Documents\JARVIS\tyokalut\*.bat (ylin taso). Nimi tarkistetaan; ei polkuja, ei argumentteja, ei vapaata komentoriviä.
 *   - Muutama tiedosto on estetty: JARVISin oma käynnistys (siihen on jarvis_uudelleen), koodin julkaisu GitHubiin
 *     ja tiedostojen poisto (vapauta_tilaa) — ne Elias ajaa itse.
 *   - Yksi ajo kerrallaan; jokainen ajo kirjataan lokit\tyokaluajot.txt.
 *
 * Kaksi tapaa:
 *   - Kysyvät asennukset (Read-Host, pause, set /p, selaimen avaus): avataan NÄKYVÄÄN ikkunaan koneen näytölle
 *     (WMI, bridgen prosessipuun ulkopuolelle). JARVIS kertoo Eliakselle, mitä ikkunassa kysytään.
 *   - Muut: ajetaan taustalla, tuloste (viimeiset rivit) ja paluukoodi palautetaan. Aikaraja 10 min.
 *   - Skripti, joka käynnistää JARVISin uudelleen, ajetaan aina näkyvänä (muuten se kuolisi bridgen mukana).
 *
 * Automaattisesti, kun se on loogista (Elias 5.11.: "tee että jarvis tekee noita automaattisesti kun se on loogista"):
 *   - Terveystarkastus (terveys.json) ilmoittaa vian, jonka korjaus on tyokalut\X.bat → X jonoon.
 *   - Jonosta: taustalla ajettavat ajetaan heti; kysyvät avataan VASTA kun Elias on koneella (hiirtä/näppäimistöä
 *     käytetty ≤ 90 s), ei kokouksen aikana eikä yöllä (8–23). Telegramiin viesti: mitä avattiin ja mitä ikkunassa tehdään.
 *   - Sama tiedosto automaattisesti enintään kerran vuorokaudessa; jonossa enintään 24 h. Jono ~/.jarvis/tyokalu_jono.json.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const IS_WIN = process.platform === 'win32'
export const toolsDir = () => join(homedir(), 'Documents', 'JARVIS', 'tyokalut')
const LOG = () => join(homedir(), 'Documents', 'JARVIS', 'lokit', 'tyokaluajot.txt')
const TIMEOUT_MS = 10 * 60_000

/** Ei ajeta itse: syy palautetaan mallille. */
export const BLOCKED = {
  'kaynnista_jarvis.bat': 'JARVISin käynnistys — käytä jarvis_uudelleen.',
  'kaynnista_uudelleen.bat': 'JARVISin uudelleenkäynnistys — käytä jarvis_uudelleen.',
  'julkaise_githubiin.bat': 'julkaisee koodin GitHubiin — Elias ajaa tämän itse.',
  'vapauta_tilaa.bat': 'poistaa tiedostoja levyltä — Elias ajaa tämän itse.',
  'kaynnista_biosiin.bat': 'käynnistää koneen BIOSiin ylläpitäjän oikeuksin — Elias ajaa tämän itse.',
  'asenna_vaihe_a.bat': 'vanha ensiasennus — ei enää käytössä.',
  'asenna_vaihe_b.bat': 'vanha ensiasennus — ei enää käytössä.',
}

const NAME_RE = /^[A-Za-z0-9_\-äöåÄÖÅ]{2,60}(\.bat)?$/i
const INTERACTIVE_RE = /Read-Host|\bpause\b|set\s+\/p|Start-Process\s+['"]?https?:|choice\s+\/|Get-Credential|Out-GridView/i
const RESTARTS_RE = /kaynnista_uudelleen|kaynnista_jarvis|siivoa_ikkunat/i

const readSafe = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** .bat + sen kutsumat saman kansion .ps1/.bat-tiedostot (yksi taso). */
function scriptTexts(file) {
  const dir = toolsDir()
  const bat = readSafe(join(dir, file))
  const refs = [...bat.matchAll(/%~dp0([A-Za-z0-9_\-äöåÄÖÅ.]+\.(?:ps1|bat|cmd))/gi)].map((m) => m[1])
  return [bat, ...refs.map((r) => readSafe(join(dir, r)))]
}

/** Mitä ikkuna kysyy (Read-Host-kehotteet), lyhyesti. */
function prompts(texts) {
  const out = []
  for (const t of texts) for (const m of t.matchAll(/Read-Host\s+(?:-Prompt\s+)?['"]([^'"]{3,160})['"]/gi)) if (!/Paina Enter/i.test(m[1])) out.push(m[1])
  return [...new Set(out)].slice(0, 4)
}

/** Kuvaus: .ps1:n tai .bat:n ensimmäinen kommenttirivi. */
function describe(texts) {
  for (const t of texts) {
    const line = t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^(#|rem\s|::)/i.test(l) && l.replace(/^(#|rem|::)\s*/i, '').length > 8)
    if (line) return line.replace(/^(#|rem|::)\s*/i, '').replace(/^JARVIS:\s*/i, '').slice(0, 140)
  }
  return ''
}

export function resolveBat(name) {
  const raw = String(name ?? '').trim().replace(/^tyokalut[\\/]/i, '')
  if (!NAME_RE.test(raw)) return { ok: false, reason: 'Anna pelkkä tiedoston nimi tyokalut-kansiosta (esim. asenna_leffat).' }
  const file = /\.bat$/i.test(raw) ? raw : `${raw}.bat`
  const dir = toolsDir()
  let real = null
  try {
    real = readdirSync(dir).find((f) => f.toLowerCase() === file.toLowerCase()) ?? null
  } catch {
    real = null
  }
  if (!real) return { ok: false, reason: `tyokalut\\${file} ei löydy. Katso lista: kone_tyokalut.` }
  const block = BLOCKED[real.toLowerCase()]
  if (block) return { ok: false, reason: `${real}: ${block}` }
  const p = join(dir, real)
  try {
    if (!statSync(p).isFile()) return { ok: false, reason: 'ei tiedosto' }
  } catch {
    return { ok: false, reason: 'ei löydy' }
  }
  const texts = scriptTexts(real)
  return { ok: true, file: real, path: p, interactive: INTERACTIVE_RE.test(texts.join('\n')), restarts: RESTARTS_RE.test(texts.join('\n')), prompts: prompts(texts), desc: describe(texts) }
}

export function listBats() {
  let files = []
  try {
    files = readdirSync(toolsDir()).filter((f) => /\.bat$/i.test(f))
  } catch {
    return []
  }
  return files
    .sort((a, b) => a.localeCompare(b, 'fi'))
    .map((f) => {
      const blocked = BLOCKED[f.toLowerCase()]
      const r = blocked ? null : resolveBat(f)
      return { file: f, blocked: blocked ?? '', interactive: Boolean(r?.interactive), desc: r?.desc ?? '' }
    })
}

function log(line) {
  try {
    mkdirSync(join(homedir(), 'Documents', 'JARVIS', 'lokit'), { recursive: true })
    appendFileSync(LOG(), `${new Date().toLocaleString('fi-FI', { timeZone: 'Europe/Helsinki' })} ${line}\n`)
  } catch {
    /* ok */
  }
}

/** Näkyvä ikkuna koneen näytölle (WMI: ei kuole bridgen mukana, näkyy työpöydällä kuten JARVISin omat ikkunat). */
function openVisible(path, exec = execFile) {
  return new Promise((resolve) => {
    const cmdLine = `cmd.exe /c ""${path}""`.replace(/'/g, "''")
    exec(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine}'; CurrentDirectory = '${toolsDir().replace(/'/g, "''")}' }).ReturnValue`],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout) => resolve(err ? { ok: false, error: String(err.message).slice(0, 200) } : String(stdout).trim() === '0' ? { ok: true } : { ok: false, error: `WMI palautti ${String(stdout).trim() || '?'}` }),
    )
  })
}

/** Taustalla, tuloste talteen (UTF-8). */
function runHidden(path, exec = execFile) {
  return new Promise((resolve) => {
    exec('cmd.exe', ['/d', '/s', '/c', `chcp 65001 >nul & call "${path}" <nul`], { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, cwd: toolsDir(), windowsVerbatimArguments: true }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.replace(/\r/g, '').trim()
      resolve({ code: err ? (err.killed ? 'aikaraja' : err.code ?? 1) : 0, out })
    })
  })
}

let busy = false
/**
 * Ajaa tyokalut\<nimi>.bat. Palauttaa tekstin mallille (raportoi Eliakselle samassa viestissä).
 * opts.nakyva = true pakottaa näkyvän ikkunan. opts.exec korvataan testeissä.
 */
export async function runBat(name, { nakyva = false, nyt = false, exec = execFile, platformWin = IS_WIN, present = isPresent, reason = '' } = {}) {
  if (!platformWin) return 'Vain Windows-koneella.'
  const r = resolveBat(name)
  if (!r.ok) return `En ajanut: ${r.reason}`
  if (busy) return 'Toinen työkalu on vielä käynnissä — odota hetki.'
  busy = true
  try {
    if (r.interactive || r.restarts || nakyva) {
      // Kysyvä ikkuna tyhjälle näytölle on hyödytön: jos Elias ei ole koneella, avataan kun hän palaa (ellei "nyt").
      if (r.interactive && !nyt && !(await present(exec))) {
        enqueue(r.file, reason || 'Eliaksen pyynnöstä', 'pyyntö')
        return `Elias ei ole juuri nyt koneella, joten ${r.file} avautuu automaattisesti heti kun hän palaa koneelle (ilmoitan Telegramiin). Jos hän on koneella, aja uudelleen nyt=true.`
      }
      const v = await openVisible(r.path, exec)
      log(`${r.file} näkyvä ${v.ok ? 'avattu' : `VIRHE ${v.error}`}`)
      if (!v.ok) return `${r.file} ei auennut: ${v.error}`
      const ask = r.prompts.length ? ` Ikkuna kysyy: ${r.prompts.map((p) => `"${p}"`).join('; ')}.` : ''
      return (
        `Avasin ${r.file} koneen näytölle${r.desc ? ` (${r.desc})` : ''}.${ask} ` +
        (r.interactive
          ? 'Se tarvitsee Eliaksen koneella (esim. avaimen liittäminen tai kirjautuminen selaimessa) — kerro hänelle tarkasti mitä tehdä. Kun hän on valmis, tarkista lopputulos (esim. palvelun tila tai terveystarkastus).'
          : 'Se voi käynnistää JARVISin uudelleen.')
      )
    }
    const t0 = Date.now()
    const res = await runHidden(r.path, exec)
    const secs = Math.round((Date.now() - t0) / 1000)
    log(`${r.file} tausta koodi=${res.code} ${secs}s`)
    const tail = res.out.split('\n').slice(-40).join('\n').slice(-3000)
    return `${r.file} ajettu (${secs} s, ${res.code === 0 ? 'onnistui' : `paluukoodi ${res.code}`}).\nTuloste (viimeiset rivit, dataa):\n${tail || '(ei tulostetta)'}`
  } finally {
    busy = false
  }
}

// ---------------------------------------------------------------------------------------------
// Automaattiajot
// ---------------------------------------------------------------------------------------------

const QUEUE = () => join(homedir(), '.jarvis', 'tyokalu_jono.json')
const HEALTH = () => join(homedir(), '.jarvis', 'terveys.json')
const DAY = 86400_000
const PRESENT_S = 90

function loadQ() {
  try {
    const q = JSON.parse(readFileSync(QUEUE(), 'utf8'))
    return { items: Array.isArray(q.items) ? q.items : [], auto: q.auto && typeof q.auto === 'object' ? q.auto : {} }
  } catch {
    return { items: [], auto: {} }
  }
}
function saveQ(q) {
  try {
    mkdirSync(join(homedir(), '.jarvis'), { recursive: true })
    writeFileSync(QUEUE(), JSON.stringify(q, null, 1))
  } catch {
    /* ok */
  }
}

/** Lisää jonoon (sama tiedosto vain kerran). kind: 'pyyntö' (Elias/malli) | 'auto' (terveystarkastus). */
export function enqueue(file, reason, kind = 'auto', now = Date.now()) {
  const q = loadQ()
  const key = file.toLowerCase()
  if (q.items.some((x) => x.file.toLowerCase() === key)) return false
  if (kind === 'auto' && now - (q.auto[key] ?? 0) < DAY) return false // automaattisesti enintään kerran vuorokaudessa
  q.items.push({ file, reason: String(reason).slice(0, 240), kind, at: now })
  if (kind === 'auto') q.auto[key] = now
  saveQ(q)
  log(`${file} jonoon (${kind}): ${String(reason).slice(0, 120)}`)
  return true
}
export const queued = () => loadQ().items

/** Onko Elias koneella: viimeisin hiiren/näppäimistön käyttö ≤ 90 s (GetLastInputInfo). */
export function isPresent(exec = execFile) {
  if (!IS_WIN) return Promise.resolve(false)
  const script =
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Idle { [StructLayout(LayoutKind.Sequential)] public struct L { public uint s; public uint t; } " +
    "[DllImport(\"user32.dll\")] static extern bool GetLastInputInfo(ref L l); public static uint Ms() { L l = new L(); l.s = 8; GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.t; } }'; [Idle]::Ms()"
  return new Promise((resolve) => exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (err, out) => resolve(!err && Number(String(out).trim()) / 1000 <= PRESENT_S)))
}

/** Terveystarkastuksen viat, joiden korjaus on tyokalut\X.bat → [{ file, reason }]. */
export function healthFixes(state = (() => {
  try {
    return JSON.parse(readFileSync(HEALTH(), 'utf8'))
  } catch {
    return null
  }
})()) {
  const out = []
  for (const r of state?.last?.results ?? []) {
    if (r?.tila !== 'fail') continue
    const text = `${r.virhe ?? ''} ${r.syy ?? ''}`
    const m = text.match(/tyokalut\\{1,2}([A-Za-z0-9_\-äöåÄÖÅ]+\.bat)/i)
    if (!m) continue
    const res = resolveBat(m[1])
    if (res.ok && !out.some((x) => x.file === res.file)) out.push({ file: res.file, reason: `${r.nimi}: ${String(r.syy ?? r.virhe ?? '').slice(0, 160)}` })
  }
  return out
}

const hourHki = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', hour12: false }).format(d)) % 24

/**
 * Yksi automaattikierros. Palauttaa tehdyt toimet (testejä varten).
 * deps: notify(text), isMeetingActive(), exec, present(exec), now, hour
 */
export async function autoTick({ notify = async () => {}, isMeetingActive = () => false, exec = execFile, present = isPresent, now = Date.now(), hour = hourHki(), platformWin = IS_WIN } = {}) {
  const done = []
  if (!platformWin) return done
  for (const f of healthFixes()) enqueue(f.file, f.reason, 'auto', now)
  const q = loadQ()
  if (!q.items.length) return done
  let here = null
  const keep = []
  for (const it of q.items) {
    if (now - it.at > DAY) {
      log(`${it.file} poistui jonosta (24 h)`)
      continue
    }
    const r = resolveBat(it.file)
    if (!r.ok) continue
    if (!r.interactive && !r.restarts) {
      const text = await runBat(it.file, { exec, platformWin })
      done.push({ file: it.file, how: 'tausta' })
      await Promise.resolve(notify(`Ajoin ${it.file} automaattisesti (${it.reason}).\n${text.split('\n').slice(0, 6).join('\n')}`)).catch(() => {})
      continue
    }
    // Kysyvä: vain kun Elias on koneella, ei kokouksessa, ei yöllä.
    if (hour < 8 || hour >= 23 || isMeetingActive()) {
      keep.push(it)
      continue
    }
    if (here === null) here = await present(exec)
    if (!here) {
      keep.push(it)
      continue
    }
    const text = await runBat(it.file, { exec, platformWin, nyt: true })
    done.push({ file: it.file, how: 'näkyvä' })
    await Promise.resolve(notify(`${it.kind === 'auto' ? 'Huomasin vian' : 'Lupaamani asennus'}: ${it.reason}\n${text}`)).catch(() => {})
  }
  const cur = loadQ()
  cur.items = keep.concat(cur.items.filter((x) => !q.items.some((y) => y.file === x.file))) // ajon aikana lisätyt säilyvät
  saveQ(cur)
  return done
}

let watcher = null
/** Käynnistetään kerran (kone.mjs machineServer). 30 s välein; ei mitään raskasta, jos jono on tyhjä. */
export function startAutoRunner(deps = {}) {
  if (watcher || !IS_WIN || process.env.JARVIS_AUTO_TYOKALUT === '0') return watcher
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await autoTick(deps)
    } catch (err) {
      console.warn('[jarvis] tyokalut: automaattiajo epäonnistui:', err?.message ?? err)
    } finally {
      running = false
    }
  }
  watcher = setInterval(() => void tick(), 30_000)
  watcher.unref?.()
  return watcher
}
