/**
 * Lämpöpumpun (IR) viimeksi asetettu tila ~/.jarvis/ilp_tila.json. IR on yksisuuntainen, joten tämä on
 * "viimeksi lähetetty", ei laitteen todellinen tila. Kirjoittavat: ir.mjs (puhe/Telegram) ja server.mjs (Koti-napit).
 * Samassa tiedostossa on vahvistettu komentoreitti (reitti A/B/C, "testaa lämpöpumppu").
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// JARVIS_ILP_FILE: testit kirjoittavat väliaikaiseen tiedostoon, eivät Eliaksen oikeaan tilaan.
const AC_FILE = () => process.env.JARVIS_ILP_FILE || join(homedir(), '.jarvis', 'ilp_tila.json')
const write = (obj) => {
  try {
    const dir = dirname(AC_FILE())
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(AC_FILE(), JSON.stringify(obj))
  } catch {
    /* ok */
  }
}

/** Lämpöpumpun viimeisin onnistunut asetus (IR ei kerro todellista tilaa). */
export function readAc() {
  try {
    return existsSync(AC_FILE()) ? JSON.parse(readFileSync(AC_FILE(), 'utf8')) : null
  } catch {
    return null
  }
}

/** Lämpöpumpun komentoreitti (A/B/C, ir.mjs AC_ROUTES). "testaa lämpöpumppu" tallentaa vahvistetun; oletus A. */
export function readAcRoute() {
  const r = readAc()?.reitti
  return r === 'A' || r === 'B' || r === 'C' ? r : 'A'
}
export function saveAcRoute(reitti, { pois = null } = {}) {
  write({ virta: false, lampotila: 21, tila: 'puhallus', puhallus: 'auto', ...(readAc() ?? {}), reitti, reittiVahvistettu: Date.now(), reittiPois: pois })
}

/** Reitti A:n diagnoosi (Tuya 2008): laitteen speksi, mitä lähetettiin ja mitä pumppu hylkäsi. ~/.jarvis/ilp_diag.json */
export const AC_DIAG_FILE = () => join(dirname(AC_FILE()), 'ilp_diag.json')
export function saveAcDiag(obj) {
  try {
    writeFileSync(AC_DIAG_FILE(), JSON.stringify(obj, null, 1))
  } catch {
    /* ok */
  }
}

/** Tallentaa asetuksen vain, kun irAc kertoi lähettäneensä kaikki komennot (onnistunut vastaus päättyy IR-huomautukseen). */
export function rememberAc(args = {}, text = '') {
  if (!/IR ei kerro laitteen todellista tilaa/.test(String(text)) || /virhe:/i.test(String(text))) return
  const prev = readAc() ?? { virta: false, lampotila: 21, tila: 'puhallus', puhallus: 'auto' }
  const next = { ...prev, at: Date.now() }
  if (typeof args.virta === 'boolean') next.virta = args.virta
  else if (args.lampotila != null || args.tila || args.puhallus) next.virta = true
  if (args.lampotila != null) next.lampotila = Number(args.lampotila)
  if (args.tila) next.tila = String(args.tila)
  if (args.puhallus) next.puhallus = String(args.puhallus)
  write(next)
}
