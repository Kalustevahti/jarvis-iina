/**
 * Selainapuri: pitää käyttäjän Chromen auki Playwright-laajennusta varten.
 *
 * JARVISin selain (JARVIS_BROWSER_MODE=chrome) on Playwright MCP --extension:
 * se ohjaa Eliaksen omaa Chromea "Playwright MCP Bridge" -laajennuksen kautta.
 * Jos Chrome ei ole käynnissä, työkalu jää odottamaan eikä mitään tapahdu.
 * Tämä moduuli käynnistää Chromen itse ennen ensimmäistä selaintyökalua.
 *
 * Chrome käynnistetään explorer.exe:n kautta (kuten kone_avaa): prosessi syntyy
 * käyttäjän työpöytäistuntoon eikä JARVISin prosessipuuhun, joten JARVISin
 * uudelleenkäynnistys ei sulje Eliaksen selainta.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const IS_WIN = process.platform === 'win32'

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Path of chrome.exe, or null when Chrome is not installed in a standard location. */
export function chromePath() {
  return CHROME_PATHS.find((p) => existsSync(p)) ?? null
}

/** Whether the Playwright extension token is configured (asetukset\playwright_token.txt). */
export function extensionTokenSet() {
  return Boolean(String(process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN ?? '').trim())
}

/** true = chrome.exe is running, false = not running, null = could not check. */
export function chromeRunning() {
  if (!IS_WIN) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH', '/FO', 'CSV'], { windowsHide: true, timeout: 8000 }, (err, out) => {
      if (err) return resolve(null)
      resolve(/"chrome\.exe"/i.test(String(out)))
    })
  })
}

let starting = null

/**
 * Makes sure Chrome is running. Starts it when it is not and waits until the
 * process appears, plus a short moment for extensions to load.
 * Returns { running, started, reason }.
 */
export function ensureChrome({ waitMs = 15_000 } = {}) {
  if (starting) return starting
  starting = (async () => {
    try {
      if (!IS_WIN) return { running: false, started: false, reason: 'ei Windows' }
      const now = await chromeRunning()
      if (now === true) return { running: true, started: false }
      if (now === null) return { running: false, started: false, reason: 'prosessilistaa ei saatu' }
      const exe = chromePath()
      if (!exe) return { running: false, started: false, reason: 'Chromea ei löytynyt' }
      spawn('explorer.exe', [exe], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      const until = Date.now() + waitMs
      while (Date.now() < until) {
        await sleep(1000)
        if ((await chromeRunning()) === true) {
          await sleep(4000) // extensions (Playwright bridge) need a moment after the window opens
          console.log('[jarvis] selain: Chrome käynnistetty selaintyökalua varten')
          return { running: true, started: true }
        }
      }
      return { running: false, started: true, reason: 'Chrome ei käynnistynyt 15 sekunnissa' }
    } finally {
      starting = null
    }
  })()
  return starting
}

/** One-line status for the startup banner. */
export function browserInfo() {
  if (!extensionTokenSet()) {
    return 'selain: Playwright-token puuttuu (asetukset\\playwright_token.txt) — jokainen yhteys pitää hyväksyä Chromessa käsin'
  }
  return 'selain: Playwright-token asetettu — JARVIS yhdistää ja avaa Chromen itse'
}
