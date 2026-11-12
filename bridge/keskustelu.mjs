/**
 * Yhteinen keskustelu: Telegram (ja ntfy) sekä JARVIS-sovelluksen chat.
 *
 * Jokainen kanava pitää oman Claude-istuntonsa (eri työkalut), mutta keskustelu on sama:
 * kun Elias kirjoittaa sovellukseen, JARVIS kertoo mitä Telegramissa on sillä välin puhuttu,
 * ja päinvastoin. Tallennus ~/.jarvis/puhelin_historia.json (vanha tiedosto, nyt kanavakentällä),
 * 60 viimeisintä viestiparia, 3 vrk.
 *
 * Tilat (8.11.2026): Työ-tila (kanava 'tyo', KalustoVahti) on oma keskustelunsa. Koti-sovellus ('sovellus') ja
 * Telegram jakavat yhden keskustelun; Työ-tilan viestit eivät näy niissä eivätkä niiden viestit Työ-tilassa.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logChat } from './tunne.mjs'

const DIR = join(homedir(), '.jarvis')
export const HISTORY_FILE = join(DIR, 'puhelin_historia.json')
const KEEP = 60

/** Keskusteluryhmä: Työ-tila erikseen, Koti-sovellus + Telegram yhdessä. */
export const chatGroup = (channel) => (channel === 'tyo' ? 'tyo' : 'koti')
const MAX_AGE = 3 * 86400_000

export function loadTurns() {
  try {
    const h = existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) : []
    return Array.isArray(h)
      ? h
          .filter((x) => x && Date.now() - new Date(x.at).getTime() < MAX_AGE)
          .map((x) => ({ channel: 'telegram', ...x }))
          .slice(-KEEP)
      : []
  } catch {
    return []
  }
}

/** Kirjaa yhden viestiparin. channel: 'telegram' | 'sovellus' | 'tyo'. */
export function recordTurn({ channel, user, jarvis }) {
  try {
    const entry = { at: new Date().toISOString(), channel, user: String(user ?? '').slice(0, 2000), jarvis: String(jarvis ?? '').slice(0, 4000) }
    const h = [...loadTurns(), entry].slice(-KEEP)
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
    writeFileSync(HISTORY_FILE, JSON.stringify(h))
    // Koko keskustelu talteen oppimista varten (muisti/keskustelut/PVM.jsonl, 90 pv).
    logChat({ at: entry.at, channel, user, jarvis })
    return entry
  } catch {
    return null
  }
}

const fmt = (t) =>
  new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(t))

const NAME = { telegram: 'Telegramissa', sovellus: 'JARVIS-sovelluksessa', tyo: 'Työ-tilassa' }

/**
 * Mitä toisessa kanavassa on puhuttu sen jälkeen, kun tämä kanava viimeksi puhui.
 * Palauttaa valmiin järjestelmähuomautuksen (tai tyhjän), joka liitetään käyttäjän viestin perään.
 */
export function crossChannelNote(channel, { since = 0, max = 6 } = {}) {
  const turns = loadTurns()
  let lastOwn = since
  for (const t of turns) if (t.channel === channel) lastOwn = Math.max(lastOwn, new Date(t.at).getTime())
  const other = turns.filter((t) => t.channel !== channel && chatGroup(t.channel) === chatGroup(channel) && new Date(t.at).getTime() > lastOwn).slice(-max)
  if (!other.length) return ''
  const lines = other.map((t) => `[${fmt(t.at)} ${NAME[t.channel] ?? t.channel}] Elias: ${t.user.slice(0, 300)} | JARVIS: ${t.jarvis.slice(0, 400)}`)
  return `\n\n[Järjestelmä: sama keskustelu jatkuu eri kanavassa. Sillä välin puhuttu:\n${lines.join('\n')}\nJatka luontevasti näistä, jos Elias viittaa niihin.]`
}

/** Istunnon aloitukseen: viimeisimmät viestit saman ryhmän kanavista (Työ-tila erikseen). */
export function historyBlock(max = 16, { channel = 'sovellus' } = {}) {
  const h = groupTurns(channel).slice(-max)
  if (!h.length) return ''
  return (
    (chatGroup(channel) === 'tyo'
      ? `\n\nVIIMEISIMMÄT VIESTIT TYÖ-TILASSA (jatka näistä luontevasti, käyttäjä voi viitata niihin — `
      : `\n\nVIIMEISIMMÄT VIESTIT (Telegram ja JARVIS-sovellus ovat SAMA keskustelu; jatka näistä luontevasti, käyttäjä voi viitata niihin — `) +
    `"se yritys mistä puhuttiin", "lisää ykkönen"):\n` +
    h.map((x) => `[${fmt(x.at)} ${NAME[x.channel] ?? x.channel}] Käyttäjä: ${String(x.user).slice(0, 400)}\n[${fmt(x.at)}] JARVIS: ${String(x.jarvis).slice(0, 900)}`).join('\n')
  )
}

/** Saman keskusteluryhmän viestit (historia-pyyntö ja istunnon alku). */
export const groupTurns = (channel) => loadTurns().filter((t) => chatGroup(t.channel) === chatGroup(channel))

/** Järjestelmähuomautukset pois ennen tallennusta. */
export const stripNotes = (text) => {
  const t = String(text ?? '')
  const i = t.indexOf('[Järjestelmä:')
  return (i >= 0 ? t.slice(0, i) : t).trim()
}
