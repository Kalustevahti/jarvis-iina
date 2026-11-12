/**
 * Claude Code -istuntojen tila.
 *
 * ~/.jarvis/ilmoita.ps1 (Claude Coden hookit) kirjoittaa jokaisesta
 * istunnosta tilatiedoston kansioon ~/.jarvis/claude_status/. Tämä moduuli
 * lukee ne ja tarjoaa JARVISille työkalun "claude_tila", jolla hän voi kertoa,
 * mitä Claude Code tekee: mikä projekti on käynnissä, odottaako se lupaa,
 * valmistuiko jokin ja mitä se viimeksi sanoi.
 *
 * Lisäksi bridge tarkkailee kansiota ja pyytää JARVISia sanomaan ääneen, kun
 * jokin istunto alkaa odottaa lupaa tai valmistuu pitkän työn jälkeen.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.jarvis', 'claude_status')
/** Istunto, jota ei ole päivitetty tähän mennessä, katsotaan hylätyksi. */
const STALE_MS = 12 * 60 * 60 * 1000

export function readSessions() {
  try {
    if (!existsSync(DIR)) return []
  } catch {
    return []
  }
  const out = []
  for (const name of readdirSync(DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const p = join(DIR, name)
      const raw = JSON.parse(readFileSync(p, 'utf8'))
      const updated = Number(raw.updated ?? 0) * 1000 || statSync(p).mtimeMs
      if (Date.now() - updated > STALE_MS) continue
      out.push({
        session: String(raw.session ?? name.replace(/\.json$/, '')),
        project: String(raw.project ?? '?'),
        cwd: String(raw.cwd ?? ''),
        state: String(raw.state ?? '?'),
        detail: String(raw.detail ?? ''),
        since: Number(raw.since ?? 0) * 1000 || updated,
        updated,
      })
    } catch {
      /* rikkinäinen tiedosto ohitetaan */
    }
  }
  return out.sort((a, b) => b.updated - a.updated)
}

const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s} sekuntia sitten`
  if (s < 3600) return `${Math.round(s / 60)} minuuttia sitten`
  return `${(s / 3600).toFixed(1)} tuntia sitten`
}

export function describeSessions() {
  const list = readSessions().filter((s) => s.state !== 'suljettu')
  if (!list.length) {
    return 'Claude Codessa ei ole tällä hetkellä avoimia istuntoja (tai hookit eivät ole vielä raportoineet mitään).'
  }
  return list
    .map((s) => {
      const d = s.detail ? ` — ${s.detail.slice(0, 220)}` : ''
      return `• ${s.project}: ${s.state} (päivittyi ${ago(s.updated)}, alkoi ${ago(s.since)})${d}`
    })
    .join('\n')
}

const ok = (text) => ({ content: [{ type: 'text', text }] })

export function claudeStatusServer() {
  return createSdkMcpServer({
    name: 'jarvis_claude',
    version: '1.0.0',
    instructions:
      'Kertoo, mitä käyttäjän Claude Code -istunnot tekevät juuri nyt: mikä projekti ' +
      'on käynnissä, odottaako jokin lupaa tai vastausta, ja mikä valmistui.',
    alwaysLoad: true,
    tools: [
      tool(
        'claude_tila',
        'Lue Claude Code -istuntojen tila (projekti, tila, milloin päivittyi, viimeinen viesti). ' +
          'Käytä aina, kun käyttäjä kysyy Claudesta, Claude Codesta, projektin etenemisestä tai ' +
          'onko jokin valmis. Ei parametreja.',
        {},
        async () => ok(describeSessions()),
      ),
    ],
  })
}

/** Ensimmäinen virke tai enintään max merkkiä, puhetta varten. */
function firstSentence(text, max = 170) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const m = t.match(/^.{20,}?[.!?](\s|$)/)
  const s = m ? m[0].trim() : t
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s
}

/** Valmistumisesta raportoidaan vain, jos työ kesti vähintään tämän. */
const MIN_DONE_MS = 60_000

/**
 * Tarkkailu: kun istunto alkaa odottaa lupaa, vastausta tai valmistuu, JARVIS
 * saa lyhyen raportin sekä puhuttavaksi että puhelimeen lähetettäväksi.
 * `report({ speech, title, phone, priority })` toimittaa sen eteenpäin.
 */
export function watchClaudeStatus(report, { intervalMs = 3000 } = {}) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
  } catch {
    /* ei kansiota, ei tarkkailua */
  }
  const seen = new Map()
  // Ensimmäinen kierros vain tallentaa nykytilan, ettei vanhoja ilmoitella.
  for (const s of readSessions()) seen.set(s.session, `${s.state}|${s.updated}`)
  const timer = setInterval(() => {
    for (const s of readSessions()) {
      const key = `${s.state}|${s.updated}`
      const prev = seen.get(s.session)
      seen.set(s.session, key)
      if (prev === undefined || prev === key) continue
      if (prev.split('|')[0] === s.state) continue
      const detail = firstSentence(s.detail)
      if (s.state === 'odottaa lupaa') {
        report({
          speech: `Johtaja, Claude kysyy lupaa projektissa ${s.project}${detail ? `: ${detail}` : ''}.`,
          title: `Claude (${s.project}) kysyy lupaa`,
          phone: detail || 'Claude pyytää lupaa työkalulle.',
          priority: 'high',
        })
      } else if (s.state === 'valmis') {
        if (s.updated - s.since < MIN_DONE_MS) continue
        const mins = Math.max(1, Math.round((s.updated - s.since) / 60000))
        report({
          speech: `Johtaja, Claude sai työn valmiiksi projektissa ${s.project}, ${mins} minuuttia. ${detail}`.trim(),
          title: `Claude (${s.project}) valmis · ${mins} min`,
          phone: s.detail ? s.detail.slice(0, 320) : 'Tehtävä valmis.',
          priority: 'default',
        })
      } else if (s.state === 'odottaa vastausta') {
        report({
          speech: `Claude odottaa vastaustasi projektissa ${s.project}.`,
          title: `Claude (${s.project}) odottaa`,
          phone: detail || 'Claude odottaa vastaustasi.',
          priority: 'high',
        })
      }
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
