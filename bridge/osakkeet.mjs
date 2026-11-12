/**
 * Osakeseuranta.
 *
 * Asetukset ~/.jarvis/osakkeet.json, esim.
 * {
 *   "tarkistus_min": 5,
 *   "paivaraportti": "23:05",
 *   "seuranta": [
 *     { "symboli": "NVDA", "nimi": "Nvidia", "ylaraja": 150, "alaraja": 120, "muutos_pct": 3 },
 *     { "symboli": "AAPL", "muutos_pct": 2 }
 *   ]
 * }
 *
 * Kurssit haetaan Yahoo Financen julkisesta chart-rajapinnasta (ei avainta,
 * Yhdysvaltain pörssit reaaliaikaisia tai lähes). Hälytykset:
 *   - hinta ylittää ylärajan / alittaa alarajan (kerran päivässä per raja)
 *   - päivän muutos ylittää muutos_pct (kerran päivässä per symboli)
 *   - päiväraportti kaikista seuratuista kerran päivässä kellonaikaan
 *     paivaraportti (Suomen aikaa)
 * Tarkistus tehdään vain Yhdysvaltain kaupankäyntiaikaan (ma–pe 16:30–23:00
 * Suomen aikaa), muuten harvemmin.
 *
 * Työkalut JARVISille:
 *   osakekurssi(symbolit)   — kerro kurssit
 *   osakeseuranta(...)      — lisää/poista/listaa seurattavat (kirjoittaa vain
 *                             omaa asetustiedostoaan)
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.jarvis')
const CONFIG = join(DIR, 'osakkeet.json')
const STATE = join(DIR, 'osakkeet_tila.json')
const SYMBOL = /^[A-Z0-9.\-^=]{1,12}$/

function loadJson(p, fallback) {
  try {
    if (!existsSync(p)) return fallback
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}
function saveJson(p, obj) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2))
}
export const loadConfig = () => {
  const c = loadJson(CONFIG, {})
  return {
    tarkistus_min: Number(c.tarkistus_min) > 0 ? Number(c.tarkistus_min) : 5,
    paivaraportti: typeof c.paivaraportti === 'string' ? c.paivaraportti : '23:05',
    seuranta: Array.isArray(c.seuranta) ? c.seuranta.filter((s) => SYMBOL.test(String(s?.symboli ?? ''))) : [],
  }
}
export const stocksConfigured = () => loadConfig().seuranta.length > 0

/** Yksi kurssi Yahoo Financesta. */
export async function fetchQuote(symbol) {
  const sym = String(symbol).toUpperCase().trim()
  if (!SYMBOL.test(sym)) throw new Error(`symboli ei kelpaa: ${symbol}`)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (JARVIS osakeseuranta)', accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`kurssipalvelu vastasi ${res.status} (${sym})`)
  const data = await res.json()
  const meta = data?.chart?.result?.[0]?.meta
  if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error(`ei kurssia symbolille ${sym}`)
  const price = meta.regularMarketPrice
  const prev = typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : meta.previousClose
  const change = typeof prev === 'number' && prev > 0 ? ((price - prev) / prev) * 100 : null
  return {
    symbol: sym,
    name: meta.longName ?? meta.shortName ?? sym,
    price,
    prevClose: prev ?? null,
    changePct: change,
    currency: meta.currency ?? 'USD',
    marketState: meta.marketState ?? '',
    time: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
  }
}

const fmtPrice = (q) => `${q.price.toLocaleString('fi-FI', { maximumFractionDigits: 2 })} ${q.currency === 'USD' ? '$' : q.currency}`
const fmtPct = (p) => (p == null ? '' : `${p >= 0 ? '+' : ''}${p.toLocaleString('fi-FI', { maximumFractionDigits: 1 })} %`)

export function describeQuote(q) {
  const pct = fmtPct(q.changePct)
  return `${q.name} (${q.symbol}): ${fmtPrice(q)}${pct ? ` (${pct} tänään)` : ''}`
}

/** Helsingin aika osina. */
function helsinkiNow() {
  const parts = new Intl.DateTimeFormat('fi-FI', {
    timeZone: 'Europe/Helsinki', hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = (t) => parts.find((p) => p.type === t)?.value ?? ''
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  const wd = get('weekday').toLowerCase()
  const weekend = wd.startsWith('la') || wd.startsWith('su')
  return { hour, minute, weekend, day: `${get('year')}-${get('month')}-${get('day')}` }
}
const usMarketOpen = ({ hour, minute, weekend }) => !weekend && (hour > 16 || (hour === 16 && minute >= 30)) && hour < 23

/**
 * Tarkkailu. `notify({ title, body, priority })` lähettää hälytyksen
 * (puhelin + puhe hoidetaan server.mjs:ssä).
 */
export function watchStocks(notify) {
  let timer = null
  let stopped = false
  const tick = async () => {
    if (stopped) return
    const cfg = loadConfig()
    const now = helsinkiNow()
    const state = loadJson(STATE, {})
    if (state.day !== now.day) {
      // Uusi päivä: hälytysmuisti tyhjäksi.
      state.day = now.day
      state.fired = {}
      state.reportDone = false
    }
    const open = usMarketOpen(now)
    const [rh, rm] = cfg.paivaraportti.split(':').map(Number)
    const reportDue = !state.reportDone && !now.weekend && (now.hour > rh || (now.hour === rh && now.minute >= rm))
    if ((open || reportDue) && cfg.seuranta.length) {
      const quotes = []
      for (const s of cfg.seuranta) {
        try {
          const q = await fetchQuote(s.symboli)
          quotes.push({ s, q })
        } catch (err) {
          console.warn(`[jarvis] osakkeet: ${err?.message ?? err}`)
        }
      }
      const alerts = []
      for (const { s, q } of quotes) {
        const fired = (state.fired[q.symbol] ??= {})
        if (typeof s.ylaraja === 'number' && q.price >= s.ylaraja && !fired.yla) {
          fired.yla = true
          alerts.push(`📈 ${describeQuote(q)} — yläraja ${s.ylaraja} ylitetty.`)
        }
        if (typeof s.alaraja === 'number' && q.price <= s.alaraja && !fired.ala) {
          fired.ala = true
          alerts.push(`📉 ${describeQuote(q)} — alaraja ${s.alaraja} alitettu.`)
        }
        const limit = typeof s.muutos_pct === 'number' ? s.muutos_pct : null
        if (limit != null && q.changePct != null && Math.abs(q.changePct) >= limit && !fired.pct) {
          fired.pct = true
          alerts.push(`${q.changePct >= 0 ? '📈' : '📉'} ${describeQuote(q)} — liikkuu yli ${limit} % tänään.`)
        }
      }
      if (alerts.length) {
        await notify({ title: 'Osakehälytys', body: alerts.join('\n'), priority: 'high', speech: alerts.map((a) => a.replace(/^[^\w]+/, '')).join(' ') })
      }
      if (reportDue && quotes.length) {
        state.reportDone = true
        const lines = quotes.map(({ q }) => `• ${describeQuote(q)}`)
        await notify({ title: 'Päivän osakeraportti', body: lines.join('\n'), priority: 'default', speech: null })
      }
      saveJson(STATE, state)
    }
    const minutes = open ? cfg.tarkistus_min : 20
    timer = setTimeout(tick, minutes * 60_000)
    timer.unref?.()
  }
  timer = setTimeout(tick, 15_000)
  timer.unref?.()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

const ok = (text) => ({ content: [{ type: 'text', text }] })

export function stocksServer() {
  return createSdkMcpServer({
    name: 'jarvis_osakkeet',
    version: '1.0.0',
    instructions: 'Osakekurssit ja osakeseurannan hallinta. Kurssit Yhdysvaltain pörsseistä, ilman avainta.',
    alwaysLoad: true,
    tools: [
      tool(
        'osakekurssi',
        'Hae osakkeiden tämänhetkiset kurssit ja päivän muutos. Ilman parametria kertoo kaikki seuratut. ' +
          'Käytä, kun käyttäjä kysyy osakkeesta, kurssista tai pörssistä.',
        { symbolit: z.array(z.string()).optional().describe('Tickerit, esim. ["NVDA","AAPL"]. Tyhjä = seuratut.') },
        async (args) => {
          const syms = (args.symbolit?.length ? args.symbolit : loadConfig().seuranta.map((s) => s.symboli)).map((x) => String(x).toUpperCase())
          if (!syms.length) return ok('Seurannassa ei ole vielä yhtään osaketta.')
          const out = []
          for (const s of syms) {
            try {
              out.push(describeQuote(await fetchQuote(s)))
            } catch (err) {
              out.push(`${s}: ${err?.message ?? err}`)
            }
          }
          return ok(out.join('\n'))
        },
      ),
      tool(
        'osakeseuranta',
        'Lisää, poista tai listaa seurattavia osakkeita ja hälytysrajoja. Hälytykset tulevat puhelimeen ja ääneen.',
        {
          toiminto: z.enum(['lisaa', 'poista', 'listaa']),
          symboli: z.string().optional().describe('Ticker, esim. NVDA'),
          nimi: z.string().optional(),
          ylaraja: z.number().optional().describe('Hälytä, kun hinta nousee tähän tai yli'),
          alaraja: z.number().optional().describe('Hälytä, kun hinta laskee tähän tai alle'),
          muutos_pct: z.number().optional().describe('Hälytä, kun päivän muutos ylittää tämän prosentin'),
        },
        async (args) => {
          const cfg = loadConfig()
          if (args.toiminto === 'listaa') {
            if (!cfg.seuranta.length) return ok('Seurannassa ei ole osakkeita.')
            return ok(cfg.seuranta.map((s) => `${s.symboli}${s.nimi ? ` (${s.nimi})` : ''}: ${[s.ylaraja != null ? `yläraja ${s.ylaraja}` : '', s.alaraja != null ? `alaraja ${s.alaraja}` : '', s.muutos_pct != null ? `muutos ${s.muutos_pct} %` : ''].filter(Boolean).join(', ') || 'vain päiväraportti'}`).join('\n'))
          }
          const sym = String(args.symboli ?? '').toUpperCase().trim()
          if (!SYMBOL.test(sym)) return ok('Anna kelvollinen ticker, esim. NVDA.')
          if (args.toiminto === 'poista') {
            cfg.seuranta = cfg.seuranta.filter((s) => s.symboli !== sym)
            saveJson(CONFIG, cfg)
            return ok(`${sym} poistettu seurannasta.`)
          }
          let q
          try {
            q = await fetchQuote(sym)
          } catch (err) {
            return ok(`Symbolia ${sym} ei löydy: ${err?.message ?? err}`)
          }
          const entry = { ...(cfg.seuranta.find((s) => s.symboli === sym) ?? {}), symboli: sym, nimi: args.nimi ?? q.name }
          if (args.ylaraja != null) entry.ylaraja = args.ylaraja
          if (args.alaraja != null) entry.alaraja = args.alaraja
          if (args.muutos_pct != null) entry.muutos_pct = args.muutos_pct
          if (entry.ylaraja == null && entry.alaraja == null && entry.muutos_pct == null) entry.muutos_pct = 3
          cfg.seuranta = [...cfg.seuranta.filter((s) => s.symboli !== sym), entry]
          saveJson(CONFIG, cfg)
          return ok(`Seurataan: ${describeQuote(q)}. Hälytys: ${[entry.ylaraja != null ? `yläraja ${entry.ylaraja}` : '', entry.alaraja != null ? `alaraja ${entry.alaraja}` : '', entry.muutos_pct != null ? `muutos yli ${entry.muutos_pct} %` : ''].filter(Boolean).join(', ')}.`)
        },
      ),
    ],
  })
}
