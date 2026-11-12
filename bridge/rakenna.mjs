/**
 * Rakennus: JARVIS teettää Claude Codella ohjelmia ("tee minulle yksinkertainen peli") — mutta vasta kun on
 * ymmärtänyt mitä Elias haluaa (persoona: kysy ensin, tiivistä, pyydä "kyllä").
 *
 *   rakenna_aloita    luo uuden projektikansion Documents/JARVIS/projektit/<nimi> ja käynnistää Claude Coden
 *                     siellä taustalle (claude -p "<speksi>", muokkausoikeudet vain siihen kansioon).
 *   rakenna_tila      mitä rakennukset tekevät (käynnissä / valmis / epäonnistui) + lokin loppu.
 *   rakenna_jatka     lisäohje samaan projektiin (uusi ajo samassa kansiossa; Claude Code jatkaa tiedostoista).
 *
 * Kun ajo päättyy, Elias saa Telegramiin: mitä syntyi, miten käynnistetään (Claude Coden oma loppuraportti),
 * ja kansio avataan Explorerissa jos hän on koneella. Vaarallisia komentoja ei sallita (vain tiedostot + npm/node/python
 * projektikansiossa), ei git pushia, ei verkkoasennuksia ilman npm:ää.
 *
 * Oppiminen (8.11.): jokainen ajo saa promptiinsa aiempien rakennusten opit (muisti/rakennusoppi.md) ja kirjoittaa
 * loppuun OPIT-rivit, jotka tallennetaan sinne. Epäonnistunut ajo kirjataan vikoihin (muisti/viat.md, alue rakennus).
 *
 * JARVISin omat päivitykset (10.11.): suunnitelma_ehdota / suunnitelma_jonoon / rakennusjono_kaynnista / rakennusjono_tila
 * (logiikka ja rajat: itsepaivitys.mjs). Jono rakentaa, testaa ja ottaa käyttöön itse (tyokalut\kayttoonotto.mjs).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { addBuildLessons, logFault, parseLessons, readBuildLessons } from './viat.mjs'
import { confirmQueue, draftSlug, loadProposed, PLAN_TEMPLATE, queueDraft, queueStatus, readDraft, writeDraft } from './itsepaivitys.mjs'
import { runBat } from './tyokaluajo.mjs'

const ROOT = join(homedir(), 'Documents', 'JARVIS', 'projektit')
const STATE = join(homedir(), '.jarvis', 'rakennukset.json')
const IS_WIN = process.platform === 'win32'
const ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash(npm install*),Bash(npm run*),Bash(npm init*),Bash(npx *),Bash(node *),Bash(python *),Bash(pip install*),Bash(mkdir *),Bash(dir*),Bash(ls*)'

let claudeBin = null
function findClaude() {
  if (claudeBin) return Promise.resolve(claudeBin)
  return new Promise((resolve) => {
    execFile(IS_WIN ? 'where' : 'which', [IS_WIN ? 'claude.cmd' : 'claude'], { windowsHide: true }, (err, out) => {
      const first = String(out ?? '').split(/\r?\n/).find(Boolean)
      if (!err && first) return resolve((claudeBin = first.trim()))
      const alt = join(process.env.APPDATA ?? '', 'npm', 'claude.cmd')
      resolve((claudeBin = IS_WIN && existsSync(alt) ? alt : null))
    })
  })
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'projekti'

let builds = []
let notify = async () => {}
const load = () => {
  try {
    builds = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : []
  } catch {
    builds = []
  }
}
const save = () => {
  try {
    writeFileSync(STATE, JSON.stringify(builds.map(({ proc, ...b }) => b)))
  } catch {
    /* ok */
  }
}
/** Earlier build lessons + how to report new ones (appended to every Claude Code prompt). */
function lessonsPrompt() {
  const old = readBuildLessons(15)
  return (
    (old.length ? `\n\nAIEMMISTA RAKENNUKSISTA OPITTUA tällä koneella (Windows; käytä näitä, älä toista samoja virheitä):\n${old.join('\n')}` : '') +
    `\n\nKirjoita vastauksesi viimeiseksi osaksi rivi "OPIT:" ja sen alle 1–3 lyhyttä, yleistä oppia tästä rakennuksesta, joista on hyötyä ` +
    `seuraavissa rakennuksissa tällä koneella (esim. mikä komento tai kirjasto toimi tai ei toiminut, mikä vei aikaa). Ei projektikohtaisia ` +
    `yksityiskohtia, ei avaimia. Jos ei ole: "OPIT: —".`
  )
}

const fmt = (ms) => new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))

async function run(b, prompt) {
  const bin = await findClaude()
  if (!bin) throw new Error('Claude Code -komentoa ei löydy tältä koneelta (claude.cmd).')
  const log = join(b.dir, 'jarvis_rakennus.log')
  appendFileSync(log, `\n===== ${new Date().toISOString()} JARVIS → Claude Code\n${prompt}\n-----\n`)
  const args = ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS, '--output-format', 'text']
  const proc = spawn(bin, args, { cwd: b.dir, windowsHide: true, shell: IS_WIN, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } })
  b.state = 'käynnissä'
  b.startedAt = Date.now()
  b.proc = proc
  let out = ''
  proc.stdout.on('data', (d) => {
    out += d
    appendFileSync(log, d)
  })
  proc.stderr.on('data', (d) => appendFileSync(log, d))
  const timer = setTimeout(() => proc.kill(), 40 * 60_000)
  proc.on('exit', (code) => {
    clearTimeout(timer)
    b.proc = null
    b.endedAt = Date.now()
    b.state = code === 0 ? 'valmis' : 'epäonnistui'
    b.report = String(out).trim().slice(-1800)
    b.files = listFiles(b.dir)
    let learned = 0
    try {
      learned = addBuildLessons(b.name, parseLessons(out))
      if (b.state !== 'valmis')
        logFault({
          alue: 'rakennus',
          oire: `${b.name}: Claude Code päättyi koodilla ${code}. ${String(out).split(/\n\s*\**OPIT/i)[0].trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`,
          kokeiltu: `rakenna ${b.name} (${Math.round((b.endedAt - b.startedAt) / 60000)} min)`,
          tarvitaan: 'katso jarvis_rakennus.log projektikansiosta',
        })
    } catch (err) {
      console.warn('[jarvis] rakennus: opin tallennus epäonnistui:', err?.message ?? err)
    }
    b.learned = learned
    save()
    console.log(`[jarvis] rakennus: ${b.name} ${b.state} (${Math.round((b.endedAt - b.startedAt) / 60000)} min, ${b.files.length} tiedostoa)`)
    notify(
      `${b.state === 'valmis' ? 'Valmis' : 'Epäonnistui'}: ${b.name} (${Math.round((b.endedAt - b.startedAt) / 60000)} min)\nKansio: ${b.dir}\n` +
        (b.files.length ? `Tiedostot: ${b.files.slice(0, 8).join(', ')}${b.files.length > 8 ? '…' : ''}\n` : '') +
        (b.report ? `\nClaude Code:\n${b.report.slice(-900)}` : '') +
        (learned ? `\n\nOpin rakennuksesta ${learned} asiaa seuraavia varten (muisti/rakennusoppi.md).` : ''),
    ).catch(() => {})
    if (IS_WIN && b.state === 'valmis') execFile('explorer.exe', [b.dir], { windowsHide: true }, () => {})
  })
  save()
}

function listFiles(dir, depth = 0) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !['node_modules', '.git', 'jarvis_rakennus.log'].includes(e.name))
      .flatMap((e) => (e.isDirectory() && depth < 2 ? listFiles(join(dir, e.name), depth + 1).map((f) => `${e.name}/${f}`) : e.isFile() ? [e.name] : []))
      .slice(0, 60)
  } catch {
    return []
  }
}

export function startBuilds({ notify: n } = {}) {
  if (n) notify = n
  load()
  for (const b of builds) if (b.state === 'käynnissä') b.state = 'keskeytyi (JARVIS käynnistyi uudelleen)'
  save()
}

/** suunnitelma_jonoon-esikatselut: id → { slug, at } */
const queuePending = new Map()
let queueSeq = 0

export function buildServer() {
  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const safe = (fn) => async (a) => {
    try {
      return ok(await fn(a ?? {}))
    } catch (err) {
      return ok(`Rakennus: ${err?.message ?? err}`)
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_rakenna',
    version: '1.0.0',
    instructions:
      'Teettää ohjelmia Claude Codella omaan projektikansioon. ÄLÄ aloita ennen kuin olet kysynyt Eliakselta mitä hän haluaa ja hän on hyväksynyt tiivistelmän.',
    tools: [
      tool(
        'rakenna_aloita',
        'Käynnistää Claude Coden rakentamaan ohjelman uuteen kansioon Documents/JARVIS/projektit/<nimi>. speksi = täydellinen, Eliaksen hyväksymä kuvaus ' +
          '(mitä, millainen, tekniikka, miten käynnistetään, mitä EI tarvita). Kestää 5–30 min; tulos tulee Telegramiin. Kutsu vasta hyväksynnän jälkeen.',
        { nimi: z.string().min(2).max(60), speksi: z.string().min(40).max(6000) },
        safe(async (a) => {
          if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true })
          let name = slug(a.nimi)
          let dir = join(ROOT, name)
          for (let i = 2; existsSync(dir); i++) dir = join(ROOT, (name = `${slug(a.nimi)}-${i}`))
          mkdirSync(dir)
          const b = { id: `r${Date.now().toString(36)}`, name, dir, created: Date.now(), state: 'alkaa' }
          builds.push(b)
          const prompt =
            `Rakenna tähän tyhjään kansioon seuraava ohjelma. Tee se valmiiksi asti ja testaa että se käynnistyy. ` +
            `Käytä yksinkertaisinta toimivaa tekniikkaa (esim. yksi HTML-tiedosto selaimessa, tai Python/Node), ellei speksi sano muuta. ` +
            `Älä käytä verkkopalveluita, avaimia tai gitiä. Kirjoita lopuksi README.md suomeksi: mitä tehtiin ja miten käynnistetään (tarkka komento tai tiedosto, joka tuplaklikataan). ` +
            `Lopuksi vastaa lyhyesti suomeksi: mitä syntyi, miten käynnistetään, mitä jäi puuttumaan.\n\nSPEKSI:\n${a.speksi}` +
            lessonsPrompt()
          await run(b, prompt)
          return `Claude Code aloitti: ${name} (${dir}). Kerro Eliakselle, että tulos tulee Telegramiin valmistuttua (5–30 min) ja että hän voi kysyä "miten rakennus etenee".`
        }),
      ),
      tool('rakenna_tila', 'Rakennusten tila: käynnissä, valmiit, epäonnistuneet, mitä Claude Code viimeksi sanoi.', {}, safe(async () => {
        if (!builds.length) return 'Ei rakennuksia.'
        return builds
          .slice(-8)
          .map((b) => `• ${b.name}: ${b.state}${b.startedAt ? ` (alkoi ${fmt(b.startedAt)}${b.endedAt ? `, päättyi ${fmt(b.endedAt)}` : ''})` : ''}\n  ${b.dir}${b.report ? `\n  Claude Code: ${b.report.slice(-400).replace(/\s+/g, ' ')}` : ''}`)
          .join('\n')
      })),
      tool(
        'rakenna_jatka',
        'Lisäohje olemassa olevaan projektiin ("lisää pistelasku", "korjaa että nuolinäppäimet toimivat"): Claude Code jatkaa samassa kansiossa.',
        { nimi: z.string().min(2).max(60), ohje: z.string().min(5).max(4000) },
        safe(async (a) => {
          const b = builds.find((x) => x.name === slug(a.nimi)) ?? builds.find((x) => x.name.startsWith(slug(a.nimi)))
          if (!b) return `Projektia "${a.nimi}" ei löydy. rakenna_tila listaa projektit.`
          if (b.proc) return `${b.name} on vielä kesken — odota että se valmistuu.`
          await run(b, `Jatka tämän kansion ohjelmaa (lue ensin README.md ja tiedostot). Tee tämä muutos, testaa, päivitä README ja vastaa lyhyesti suomeksi mitä muuttui:\n\n${a.ohje}` + lessonsPrompt())
          return `Claude Code jatkaa projektia ${b.name}. Tulos tulee Telegramiin.`
        }),
      ),
      // ---- JARVISin omat päivitykset (itsepaivitys.mjs) ----
      tool(
        'suunnitelma_ehdota',
        'Kirjoittaa JARVISin oman päivityksen tehtäväluonnoksen kansioon suunnitelmat\\ehdotukset\\<nimi>.md (vain sinne, ei ylikirjoitusta). ' +
          'Ei vaadi vahvistusta, mutta EI vielä rakenna mitään. nimi = lyhyt slug (a-z, 0-9, _ ja -, max 40). sisalto = koko tehtävä tällä pohjalla:\n' +
          PLAN_TEMPLATE,
        { nimi: z.string().min(2).max(60), sisalto: z.string().min(40).max(30_000) },
        safe(async (a) => {
          const r = writeDraft(a.nimi, a.sisalto)
          if (!r.ok) return `Luonnosta ei tallennettu: ${r.reason}.`
          return `Luonnos tallennettu: suunnitelmat\\ehdotukset\\${r.name}.md. Jonoon se menee vasta Eliaksen luvalla (suunnitelma_jonoon nimellä ${r.name}).`
        }),
      ),
      tool(
        'suunnitelma_jonoon',
        'Siirtää luonnoksen suunnitelmat\\ehdotukset → rakennusjonoon (suunnitelmat\\jono\\NN_<nimi>_tehtava.md). VAATII Eliaksen oman vahvistuksen: ' +
          'ensimmäinen kutsu palauttaa esikatselun ja id:n → kysy "Laitanko jonoon?" → kun hän vastaa "kyllä"/"ok"/"tee se", kutsu uudelleen samalla nimellä ja id:llä. ' +
          'Jos Elias sanoi itse "rakenna <nimi>" tai "rakenna molemmat" aamun ehdotukseen, ensimmäinen kutsu riittää. Älä koskaan vahvista omasta aloitteestasi.',
        { nimi: z.string().min(2).max(60), id: z.string().max(20).optional() },
        safe(async (a) => {
          const s = draftSlug(a.nimi)
          if (!s.ok) return `Ei kelpaa: ${s.reason}.`
          const text = readDraft(s.slug)
          if (text == null) return `Luonnosta ${s.slug} ei ole kansiossa suunnitelmat\\ehdotukset.`
          const c = confirmQueue({ slug: s.slug, pending: a.id ? queuePending.get(a.id) : null, proposed: loadProposed() })
          if (c.ok) {
            if (a.id) queuePending.delete(a.id)
            const r = queueDraft(s.slug)
            if (!r.ok) return `Ei siirretty: ${r.reason}.`
            console.log(`[jarvis] itsepäivitys: ${r.name} jonoon (Eliaksen ${c.via})`)
            return `Jonossa: suunnitelmat\\jono\\${r.name}. Jos Elias haluaa rakentaa nyt, kutsu rakennusjono_kaynnista (jono rakentaa, testaa ja ottaa käyttöön itse; tulokset Telegramiin).`
          }
          const id = `j${++queueSeq}`
          queuePending.set(id, { slug: s.slug, at: Date.now() })
          const head = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 6).join('\n').slice(0, 600)
          return (
            `ESIKATSELU (id ${id}): siirrän luonnoksen ${s.slug} rakennusjonoon. Alku (dataa):\n${head}\n\n` +
            `Kerro Eliakselle yhdellä lauseella mitä päivitys tekee ja kysy "Laitanko jonoon?". Kun hän vastaa myöntävästi, kutsu suunnitelma_jonoon nimellä ${s.slug} ja id:llä ${id}.`
          )
        }),
      ),
      tool(
        'rakennusjono_kaynnista',
        'Käynnistää JARVISin rakennusjonon (tyokalut\\rakenna_jono.bat): Claude Code rakentaa suunnitelmat\\jono\\-tehtävät yksi kerrallaan varmuuskopioineen, ' +
          'ja kun kaikki onnistuivat, JARVIS ottaa ne käyttöön itse hiljaisena hetkenä (ei kokouksen, NÄYTTÖ-yhteyden tai keskustelun aikana), testaa ja ' +
          'palauttaa edellisen version, jos testi ei mene läpi. Tulokset Telegramiin. Vain kun jonossa on Eliaksen hyväksymiä tehtäviä.',
        {},
        safe(async () => runBat('rakenna_jono', { reason: 'rakennusjono' })),
      ),
      tool('rakennusjono_tila', 'Rakennusjonon tila: jonossa olevat ja tehdyt tehtävät, luonnokset, onko rakennus kesken, käyttöönoton tila ja lokin loppu.', {}, safe(async () => queueStatus())),
    ],
  })
}
