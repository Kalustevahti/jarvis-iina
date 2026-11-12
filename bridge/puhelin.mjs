/**
 * Puhelinilmoitukset (ntfy).
 *
 * Yksi kapea työkalu: JARVIS voi lähettää lyhyen viestin käyttäjän omaan
 * ntfy-kanavaan, jota iPhonen ntfy-sovellus kuuntelee. Kanavan nimi luetaan
 * ~/.jarvis/ntfy.txt -tiedostosta (yksi rivi, esim. "jarvis-elias-8f3k2"),
 * tai ympäristömuuttujasta JARVIS_NTFY_TOPIC. Palvelin on oletuksena ntfy.sh;
 * oman palvelimen saa muuttujalla JARVIS_NTFY_SERVER.
 *
 * Työkalu ei voi lähettää mihinkään muuhun kanavaan, joten sivulle piilotettu
 * ohje ei saa JARVISia viestittelemään vieraille. Viestit rajataan lyhyiksi.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { sendTelegram, telegramAvailable } from './telegram.mjs'

const SERVER = (process.env.JARVIS_NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/+$/, '')

function topic() {
  if (process.env.JARVIS_NTFY_TOPIC) return process.env.JARVIS_NTFY_TOPIC.trim()
  const p = join(homedir(), '.jarvis', 'ntfy.txt')
  try {
    if (existsSync(p)) return readFileSync(p, 'utf8').split(/\r?\n/)[0].trim()
  } catch {
    /* ei kanavaa */
  }
  return ''
}

export const phoneAvailable = () => Boolean(topic()) || telegramAvailable()

/** Lähettää viestin. Käytetään myös bridgen omiin ilmoituksiin. */
export async function notifyPhone({ title, body, priority = 'default', tags = 'robot', kanava }) {
  // Ilmoitukset menevät VAIN Telegramiin (Eliaksen toive 2.11.). ntfy-sovellukseen lähetetään vain, jos
  // Telegramia ei ole asetettu, tai jos JARVIS_NTFY_ILMOITUKSET=1 (molemmat).
  if (telegramAvailable()) {
    // Telegram-chat on jo JARVIS-botin kanssa: ei "JARVIS:"-etuliitettä viesteihin.
    const clean = String(title ?? '').replace(/^\s*JARVIS\s*[:\-–—]?\s*/i, '').trim()
    await sendTelegram(String(body ?? '').slice(0, 12000), { title: clean || undefined, kanava })
    if (process.env.JARVIS_NTFY_ILMOITUKSET !== '1') return
  }
  const t = topic()
  if (!t) throw new Error('Telegramia tai ntfy-kanavaa ei ole asetettu')
  const res = await fetch(`${SERVER}/${encodeURIComponent(t)}`, {
    method: 'POST',
    headers: {
      // Otsikot ovat ASCII-kenttiä; UTF-8 ilmoitetaan RFC 2047 -koodauksella.
      Title: `=?UTF-8?B?${Buffer.from(String(title ?? 'JARVIS')).toString('base64')}?=`,
      Priority: String(priority),
      Tags: String(tags),
    },
    body: String(body ?? '').slice(0, 1000),
  })
  if (!res.ok) throw new Error(`ntfy vastasi ${res.status}`)
}

const ok = (text) => ({ content: [{ type: 'text', text }] })

export function phoneServer() {
  return createSdkMcpServer({
    name: 'jarvis_puhelin',
    version: '1.0.0',
    instructions:
      'Lähettää lyhyen ilmoituksen käyttäjän omaan puhelimeen. Käytä, kun käyttäjä ' +
      'pyytää ilmoittamaan puhelimeen tai kun pyydetty pitkä tehtävä valmistuu ja ' +
      'käyttäjä on pyytänyt siitä ilmoitusta.',
    alwaysLoad: true,
    tools: [
      tool(
        'ilmoita_puhelimeen',
        'Lähettää viestin käyttäjän puhelimeen (Telegram). Vain käyttäjän omaan chattiin. ' +
          'Käytä, kun käyttäjä pyytää ("ilmoita puhelimeen", "lähetä puhelimeeni") tai ' +
          'kun hän on pyytänyt ilmoitusta tehtävän valmistumisesta. Pidä viesti lyhyenä.',
        {
          viesti: z.string().min(1).max(500).describe('Viestin sisältö suomeksi, korkeintaan pari lausetta.'),
          otsikko: z.string().max(80).optional().describe('Lyhyt otsikko. Oletus "JARVIS".'),
          kiireellinen: z.boolean().optional().describe('true, jos asia on kiireellinen (puhelin hälyttää voimakkaammin).'),
        },
        async (args) => {
          if (!phoneAvailable()) {
            return ok('Puhelinilmoituksia ei ole otettu käyttöön (Telegram puuttuu). Kerro käyttäjälle.')
          }
          try {
            await notifyPhone({
              title: args.otsikko || 'JARVIS',
              body: args.viesti,
              priority: args.kiireellinen ? 'high' : 'default',
              tags: args.kiireellinen ? 'rotating_light' : 'robot',
            })
            return ok('Ilmoitus lähetetty puhelimeen.')
          } catch (err) {
            return ok(`Ilmoitus ei mennyt läpi: ${err?.message ?? err}`)
          }
        },
      ),
    ],
  })
}
