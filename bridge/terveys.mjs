/**
 * Terveystarkastus: testaa jokaisen JARVISin palvelun OIKEALLA pienellä kutsulla ja kertoo, mikä ei vastaa ja miksi.
 *
 *   Tarkistetaan (vain ne, jotka on asennettu): internet, VPN (NordVPN päällä/pois), Telegram, CRM, YTJ (PRH),
 *   tekoälyt (Gemini, Groq, Mistral, OpenRouter, paikallinen Ollama, GPT), Whisper, valot (Tuya), imuri (Roborock),
 *   projektori (ADB), reititin (ZTE).
 *   Jokaiselle: ✅ toimii (aika) / ⚠️ toimii osittain tai odotettu tila (esim. projektori valmiustilassa) / ❌ ei vastaa + syy + korjausvihje.
 *
 *   Milloin: Telegram /tarkista ja "toimiiko kaikki" (ilman mallia), työkalu `terveys` (mallille: "toimiiko groq?"),
 *   automaattisesti 6 min käynnistyksen jälkeen ja joka aamu ~08.10 — ilmoitus VAIN jos jokin on rikki, ja sama vika
 *   korkeintaan kerran vuorokaudessa. Viimeisin tulos: ~/.jarvis/terveys.json, loki: "[jarvis] terveys: …".
 *
 *   Tarkistus ei lähetä viestejä kenellekään eikä muuta mitään: vain lukevia kutsuja + yksi "vastaa ok" tekoälyille.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE = join(homedir(), '.jarvis', 'terveys.json')
const log = (m) => console.log(`[jarvis] terveys: ${m}`)

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return {}
  }
}
const writeState = (s) => {
  try {
    writeFileSync(STATE, JSON.stringify(s))
  } catch {}
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: ei vastausta ${Math.round(ms / 1000)} s:ssa`)), ms).unref?.())])

/** Virheteksti → lyhyt syy + korjausvihje (suomeksi). */
function hint(name, msg) {
  const m = String(msg ?? '')
  const vpn = vpnState.on ? ' Todennäköinen syy: VPN-palvelin (NordVPN). Korjaus: vaihda VPN-maaksi Suomi tai lisää node.exe split tunnelingiin.' : ''
  if (/\b401\b|unauthori[sz]ed|invalid.?api.?key|API key not valid|incorrect api key/i.test(m)) return `avain ei kelpaa (vanhentunut tai poistettu). Korjaus: aja tyokalut\\asenna_tekoalyt.bat ja anna uusi ${name}-avain.`
  if (name === 'Groq' && /\b403\b|access denied/i.test(m) && vpnState.on) return 'Groq estää VPN-osoitteet. Korjaus: NordVPN → Split tunneling → Browse apps → Documents\\JARVIS\\tyokalut\\groq\\groq-yhteys.exe (vain Groq menee VPN:n ohi).'
  if (/\b403\b|access denied|forbidden|not available in your (country|region)|unsupported.*(country|region|location)/i.test(m)) return `pääsy estetty (403).${vpnState.on ? ' Syy: palvelu estää VPN-osoitteet (NordVPN). Korjaus: node.exe NordVPN:n split tunnelingiin — tai hyväksy, että tämä tekoäly ei toimi VPN:n ollessa päällä (JARVIS käyttää silloin muita).' : ' Palvelu ei hyväksy tätä sijaintia/IP:tä.'}`
  if (/\b404\b.*(no longer available|not found for API version|is not found)/i.test(m)) return 'malli on poistunut käytöstä — JARVIS vaihtaa uusimpaan automaattisesti seuraavalla kutsulla; jos ei, kerro Claudelle.'
  if (/Missing bearer|401 Unauthorized.*openai|codex.*(login|auth)/i.test(m)) return 'GPT-kirjautuminen puuttuu tai vanhentunut. Korjaus: aja tyokalut\\asenna_gpt.bat (kirjaudu ChatGPT-tililläsi selaimessa).'
  if (/\b429\b|rate.?limit|quota|too many requests|resource.?exhausted/i.test(m)) return 'ilmaisen tason raja täynnä tälle päivälle/minuutille — palautuu itsestään.'
  if (/\b5\d\d\b|service unavailable|overloaded|bad gateway/i.test(m)) return 'palvelun oma häiriö — yleensä ohi itsestään.'
  if (/ECONNREFUSED/i.test(m)) return /127\.0\.0\.1|localhost/i.test(m) ? 'ohjelma ei ole käynnissä tällä koneella.' : 'laite ei ota yhteyttä vastaan (pois päältä, väärä IP tai VPN estää lähiverkon — tarkista NordVPN:n "Invisibility on LAN" = pois).'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return `nimipalvelu ei löydä osoitetta (netti poikki?).${vpn}`
  if (/ECONNRESET|socket hang up|ETIMEDOUT|ei vastausta|timeout|timed out|aborted/i.test(m)) return `yhteys katkesi tai aikakatkaisu.${vpn}`
  return m.slice(0, 160)
}

// --- VPN-tila (NordVPN: NordLynx/OpenVPN-sovitin "Up") -------------------------------------------------
let vpnState = { on: false, name: '' }
function detectVpn() {
  if (process.platform !== 'win32') return Promise.resolve({ on: false, name: '' })
  const ps =
    "$a = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'NordLynx|Nord|TAP-Windows|WireGuard|OpenVPN' -or $_.Name -match 'Nord') } | Select-Object -First 1; " +
    "if ($a) { $a.Name + ' (' + $a.InterfaceDescription + ')' }"
  return new Promise((resolve) =>
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      const name = String(out ?? '').trim()
      resolve({ on: Boolean(name), name })
    }),
  )
}

// --- yksittäiset tarkistukset ---------------------------------------------------------------------------
async function fetchOk(url, opts = {}, timeoutMs = 12_000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok && !(opts.okStatuses ?? []).includes(res.status)) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 100)}`)
  return res
}

function telegramToken() {
  try {
    const t = readFileSync(join(homedir(), '.jarvis', 'telegram.txt'), 'utf8').split(/\r?\n/)[0].trim()
    return /^\d+:[A-Za-z0-9_-]{20,}$/.test(t) ? t : ''
  } catch {
    return ''
  }
}

/** Palauttaa listan { nimi, run: async () => lisätieto | { warn } } — vain asennetut palvelut. */
async function checks() {
  const list = []
  const add = (nimi, run, timeoutMs = 30_000) => list.push({ nimi, run, timeoutMs })

  add('Internet', async () => {
    await fetchOk('https://www.google.com/generate_204', { okStatuses: [204] }, 8_000)
    return ''
  }, 10_000)

  if (telegramToken())
    add('Telegram', async () => {
      const r = await fetchOk(`https://api.telegram.org/bot${telegramToken()}/getMe`)
      const j = await r.json()
      if (!j.ok) throw new Error(j.description || 'getMe epäonnistui')
      return `@${j.result?.username ?? 'botti'}`
    })

  try {
    const crm = await import('./crm.mjs')
    if (crm.crmConfigured())
      add('CRM', async () => {
        const orgs = await crm.allOrganizations({ fresh: true })
        return `${orgs.length} yritystä`
      }, 30_000)
  } catch {}

  add('YTJ (PRH)', async () => {
    const ytj = await import('./ytj.mjs')
    const c = await ytj.companyById('0112038-9') // Nokia Oyj — aina olemassa
    if (!c) throw new Error('ei tulosta')
    return ''
  }, 20_000)

  try {
    const ai = await import('./tekoalyt.mjs')
    if (typeof ai.pingProvider === 'function') {
      const avail = await ai.availableProviders()
      for (const p of avail) add(ai.providerName?.(p) ?? p, async () => ai.pingProvider(p, p === 'ollama' ? { timeoutMs: 110_000 } : {}), p === 'gpt' || p === 'ollama' ? 120_000 : 45_000) // paikallinen malli latautuu muistiin ensimmäisellä kerralla (jopa 1–2 min)
      const missing = (ai.knownProviders?.() ?? []).filter((p) => !avail.includes(p) && p !== 'gpt')
      if (missing.length) list.push({ nimi: 'Tekoälyt ilman avainta', info: missing.map((p) => ai.providerName?.(p) ?? p).join(', ') })
    }
  } catch {}

  if (process.env.JARVIS_STT_URL)
    add('Puheentunnistus (Whisper)', async () => {
      const base = process.env.JARVIS_STT_URL.replace(/\/inference$/, '/')
      await fetchOk(base, { okStatuses: [404, 405] }, 5_000)
      return ''
    }, 8_000)

  try {
    const v = await import('./valot.mjs')
    if (v.lightsConfigured())
      add('Valot (Tuya)', async () => {
        const l = await v.listLights(true)
        const on = l.filter((x) => x.online).length
        if (!l.length) return { warn: 'yhteys ok, mutta lamppuja ei löytynyt tililtä' }
        return on === l.length ? `${l.length} lamppua online` : { warn: `${on}/${l.length} lamppua online (offline = katkaisija pois)` }
      })
  } catch {}

  try {
    const im = await import('./imuri.mjs')
    if (im.vacuumConfigured())
      add('Imuri (Roborock)', async () => {
        const t = await im.vacuumCall('tila')
        return t.split(' · ').slice(0, 2).join(' · ')
      }, 100_000)
  } catch {}

  try {
    const pr = await import('./projektori.mjs')
    if (pr.projectorConfigured())
      add('Projektori', async () => {
        const r = await pr.projectorCall('projektori_tila')
        if (r.error) {
          if (/valmiustila|ei vastaa verkossa|sammuksissa/i.test(r.text)) return { warn: 'syvässä valmiustilassa (normaali kun se on kiinni) — herää "projektori päälle" -komennolla' }
          throw new Error(r.text)
        }
        return r.text.split('\n')[0].slice(0, 80)
      }, 60_000)
  } catch {}

  try {
    const md = await import('./modeemi.mjs')
    if (md.routerConfigured())
      add('Reititin (ZTE)', async () => {
        const t = await md.routerStatus()
        return (t.split('\n').find((l) => /^Signaali/.test(l)) ?? '').replace('Signaali: ', '')
      })
  } catch {}

  try {
    const ts = await import('./tesla.mjs')
    if (ts.teslaConfigured())
      add('Tesla (Tessie)', async () => {
        const t = await ts.teslaCall('tila')
        return t.split(' · ').slice(0, 2).join(' · ')
      }, 40_000)
  } catch {}

  return list
}

let running = null
/** Ajaa kaikki tarkistukset rinnakkain. Palauttaa { results, text, failed }. */
export function runHealth() {
  if (running) return running
  running = (async () => {
    const t0 = Date.now()
    vpnState = await detectVpn()
    const list = await checks()
    const results = await Promise.all(
      list.map(async (c) => {
        if (c.info) return { nimi: c.nimi, tila: 'info', lisa: c.info }
        const s = Date.now()
        try {
          const r = await withTimeout(c.run(), c.timeoutMs, c.nimi)
          const ms = Date.now() - s
          if (r && typeof r === 'object' && r.warn) return { nimi: c.nimi, tila: 'warn', lisa: r.warn, ms }
          return { nimi: c.nimi, tila: 'ok', lisa: String(r ?? ''), ms }
        } catch (err) {
          const raw = String(err?.message ?? err)
          return { nimi: c.nimi, tila: 'fail', virhe: raw.slice(0, 200), syy: hint(c.nimi, raw), ms: Date.now() - s }
        }
      }),
    )
    const failed = results.filter((r) => r.tila === 'fail')
    const icon = { ok: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' }
    const sec = (ms) => (ms == null ? '' : ms < 1000 ? ` ${ms} ms` : ` ${(ms / 1000).toFixed(1)} s`)
    const lines = results.map((r) =>
      r.tila === 'fail' ? `❌ ${r.nimi} — ${r.syy}` : `${icon[r.tila]} ${r.nimi}${r.lisa ? ` — ${r.lisa}` : ''}${r.tila === 'ok' ? sec(r.ms) : ''}`,
    )
    const head = failed.length ? `Tarkistus: ${failed.length} palvelua ei toimi` : 'Tarkistus: kaikki toimii'
    const vpnLine = `VPN: ${vpnState.on ? `päällä (${vpnState.name})` : 'pois'}`
    const text = `${head} (${results.filter((r) => r.tila !== 'info').length} testattu, ${Math.round((Date.now() - t0) / 1000)} s)\n${vpnLine}\n\n${lines.join('\n')}${
      failed.length ? '\n\nKorjataanko? Lähetä tämä raportti Claudelle tai sano "korjaa <palvelu>".' : ''
    }`
    log(`${head} — ${results.map((r) => `${r.nimi}:${r.tila}`).join(', ')}`)
    writeState({ ...readState(), last: { at: Date.now(), vpn: vpnState, results } })
    return { results, text, failed }
  })().finally(() => setTimeout(() => (running = null), 1000))
  return running
}

export async function healthText() {
  return (await runHealth()).text
}

/** Automaattitarkistus: 6 min käynnistyksestä + joka aamu ~08.10. Ilmoittaa vain vioista, sama vika max kerran / 24 h. */
export function watchHealth({ notify, retryMs = 90_000 } = {}) {
  const auto = async (why) => {
    try {
      let { failed, text } = await runHealth()
      if (!failed.length || !notify) return
      // Hetkellinen katko (wifi, VPN:n vaihto, reititin) ei ole vika: tarkistetaan uudelleen ennen ilmoitusta.
      await new Promise((r) => setTimeout(r, retryMs))
      ;({ failed, text } = await runHealth())
      if (!failed.length) return log(`hetkellinen häiriö ohi (${why}), ei ilmoitusta`)
      const st = readState()
      const sig = failed.map((f) => `${f.nimi}:${f.syy.slice(0, 40)}`).sort().join('|')
      if (st.notified?.sig === sig && Date.now() - st.notified.at < 24 * 3600_000) return log(`sama vika jo ilmoitettu (${why})`)
      await notify(text)
      writeState({ ...readState(), notified: { sig, at: Date.now() } })
    } catch (err) {
      console.warn('[jarvis] terveys:', err?.message ?? err)
    }
  }
  setTimeout(() => void auto('käynnistys'), 6 * 60_000).unref?.()
  let lastDay = ''
  const t = setInterval(() => {
    const now = new Date()
    const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
    const [day, hm] = p.split(' ')
    if (day !== lastDay && hm >= '08:10' && hm < '09:00') {
      lastDay = day
      void auto('aamu')
    }
  }, 60_000)
  t.unref?.()
  return () => clearInterval(t)
}

export function healthServer() {
  return createSdkMcpServer({
    name: 'jarvis_terveys',
    version: '1.0.0',
    instructions: 'Terveystarkastus: testaa oikeilla kutsuilla, toimivatko JARVISin palvelut (internet, VPN, Telegram, CRM, YTJ, tekoälyt, Whisper, valot, imuri, projektori, reititin).',
    tools: [
      tool(
        'terveys',
        'Testaa kaikki palvelut nyt (10–90 s) ja palauttaa raportin: ✅ toimii / ⚠️ osittain / ❌ ei toimi + syy + korjausvihje. ' +
          'Käytä kun Elias kysyy "toimiiko X / toimiiko kaikki / miksi Groq ei vastaa", tai kun jokin työkalu epäonnistuu verkkovirheeseen. Älä arvaa — aja tämä.',
        { palvelu: z.string().max(40).optional() },
        async (a) => {
          const { results, text } = await runHealth()
          if (a?.palvelu) {
            const q = a.palvelu.toLowerCase()
            const hit = results.filter((r) => r.nimi.toLowerCase().includes(q))
            if (hit.length) return { content: [{ type: 'text', text: `${hit.map((r) => (r.tila === 'fail' ? `❌ ${r.nimi}: ${r.syy} (virhe: ${r.virhe})` : `${r.tila === 'ok' ? '✅' : '⚠️'} ${r.nimi}: ${r.lisa || 'toimii'}`)).join('\n')}\n\nKoko raportti:\n${text}` }] }
          }
          return { content: [{ type: 'text', text }] }
        },
      ),
    ],
  })
}
