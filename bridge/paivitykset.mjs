/**
 * Päivitykset: "mitä päivityksiä sinuun on tehty?" → oikea vastaus eikä arvaus.
 *
 *   1. Muutosloki muisti/paivitykset.md (uusin ensin): jokainen Claude Code -istunto kirjaa sinne mitä muutti ja miksi.
 *   2. Tiedostojen muutosajat: bridge/*.mjs, src/ ja tyokalut/ — myös ne muutokset, joita kukaan ei kirjannut lokiin.
 *      Jokaisesta kerrotaan, onko muutos jo käytössä (tehty ennen tätä käynnistystä) vai odottaako se uudelleenkäynnistystä.
 *
 *   Vain luku. Ei koodin sisältöä mallille, vain tiedoston nimi, aika ja otsikkorivi.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(homedir(), 'Documents', 'JARVIS')
export const CHANGELOG = join(ROOT, 'muisti', 'paivitykset.md')
const DIRS = [
  [join(ROOT, 'jarvis', 'bridge'), 'bridge'],
  [join(ROOT, 'jarvis', 'src'), 'src'],
  [join(ROOT, 'jarvis', 'src', 'ui'), 'src/ui'],
  [join(ROOT, 'jarvis', 'src', 'lib'), 'src/lib'],
  [join(ROOT, 'tyokalut'), 'tyokalut'],
]
const STARTED = Date.now() - process.uptime() * 1000

const fmt = (ms) =>
  new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))

/** Tiedoston otsikkorivi: .mjs/.ts-tiedoston ensimmäinen kommenttirivi, .ps1:n ensimmäinen #-rivi. */
function headline(path) {
  try {
    const head = readFileSync(path, 'utf8').replace(/^﻿/, '').slice(0, 1200)
    const js = head.match(/\/\*\*?\s*\n?\s*\*?\s*([^\n*][^\n]{5,160})/)
    const ps = head.match(/^#\s*(.{5,160})$/m)
    return String((js ?? ps)?.[1] ?? '').trim()
  } catch {
    return ''
  }
}

export function changedFiles(days = 2) {
  const since = Date.now() - days * 86400_000
  const out = []
  for (const [dir, label] of DIRS) {
    let names = []
    try {
      names = existsSync(dir) ? readdirSync(dir) : []
    } catch {
      continue
    }
    for (const n of names) {
      if (!/\.(mjs|js|ts|tsx|ps1|bat|py|css)$/i.test(n)) continue
      const p = join(dir, n)
      try {
        const st = statSync(p)
        if (st.isFile() && st.mtimeMs >= since) out.push({ file: `${label}/${n}`, at: st.mtimeMs, live: st.mtimeMs <= STARTED || /^tyokalut/.test(label), head: headline(p) })
      } catch {
        /* ok */
      }
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

/** Muutoslokin osiot, jotka ovat aikaikkunan sisällä (otsikko "## 4.11.2026 …" tai "## 2026-11-04 …"). */
function changelogText(days) {
  if (!existsSync(CHANGELOG)) return ''
  const text = readFileSync(CHANGELOG, 'utf8').replace(/^﻿/, '')
  const since = Date.now() - days * 86400_000
  const parts = text.split(/\n(?=## )/)
  const keep = parts.filter((p) => {
    const iso = p.match(/^## (\d{4})-(\d{2})-(\d{2})/)
    const fi = p.match(/^## (\d{1,2})\.(\d{1,2})\.(\d{4})/)
    const d = iso ? new Date(`${iso[1]}-${iso[2]}-${iso[3]}T23:59:59`) : fi ? new Date(`${fi[3]}-${fi[2].padStart(2, '0')}-${fi[1].padStart(2, '0')}T23:59:59`) : null
    return d && d.getTime() >= since
  })
  return keep.join('\n').slice(0, 9000)
}

export function updatesText({ paivat = 2 } = {}) {
  const days = Math.max(1, Math.min(30, Number(paivat) || 2))
  const log = changelogText(days)
  const files = changedFiles(days)
  const pending = files.filter((f) => !f.live)
  const L = [`JARVIS käynnistyi ${fmt(STARTED)}.`]
  L.push(log ? `MUUTOSLOKI (muisti/paivitykset.md, ${days} pv):\n${log}` : `Muutoslokissa ei merkintöjä ${days} päivältä.`)
  if (files.length) {
    L.push(
      `MUUTETUT TIEDOSTOT (${days} pv, uusin ensin; * = odottaa uudelleenkäynnistystä):\n` +
        files.slice(0, 40).map((f) => `${f.live ? ' ' : '*'} ${fmt(f.at)}  ${f.file}${f.head ? ` — ${f.head.slice(0, 110)}` : ''}`).join('\n'),
    )
  } else L.push('Tiedostoja ei ole muutettu tällä aikavälillä.')
  if (pending.length) L.push(`${pending.length} muutosta ei ole vielä käytössä: sano "uudelleen", niin ne tulevat voimaan.`)
  return L.join('\n\n')
}

export function updatesServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  return createSdkMcpServer({
    name: 'jarvis_paivitykset',
    version: '1.0.0',
    instructions: 'Mitä JARVISiin on päivitetty: muutosloki + muutettujen tiedostojen ajat. Käytä aina, kun Elias kysyy päivityksistä, uusista ominaisuuksista tai muutoksista.',
    tools: [
      tool(
        'jarvis_paivitykset',
        'Mitä päivityksiä JARVISiin on tehty: muutosloki (mitä ja miksi) ja muutetut tiedostot ajan kanssa, myös onko muutos jo käytössä vai odottaako uudelleenkäynnistystä. ' +
          'paivat = aikaväli (oletus 2). Kerro Eliakselle TIIVIISTI ominaisuuksina (mitä hän voi nyt tehdä), ei tiedostoina: enintään noin 6 riviä, yksi ominaisuus per rivi, uusin ensin.',
        { paivat: z.number().int().min(1).max(30).optional() },
        async (a) => {
          try {
            return ok(updatesText(a ?? {}))
          } catch (err) {
            return { ...ok(`Päivitykset: ${err?.message ?? err}`), isError: true }
          }
        },
      ),
    ],
  })
}
