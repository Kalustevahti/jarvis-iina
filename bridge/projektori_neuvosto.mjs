// JARVIS: projektorin kehitysideat — sama kysymys Claudelle ja kaikille yhdistetyille tekoälyille.
// Lukee projektorilta vain tietoja (getprop, pakettilista, tila). Ei muuta mitään projektorilla eikä JARVISin muistissa.
// Tulos: lokit\projektori_neuvosto.md (raakavastaukset). Aja: tyokalut\projektori_neuvosto.bat
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'lokit', 'projektori_neuvosto.md')
const parts = [`# Projektorineuvosto ${new Date().toLocaleString('fi-FI', { timeZone: 'Europe/Helsinki' })}\n`]
const save = () => writeFileSync(out, parts.join('\n'))

function adb(args, timeoutMs = 15000) {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.jarvis', 'projektori.json'), 'utf8').replace(/^\uFEFF/, ''))
  const local = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'JARVIS', 'platform-tools', 'adb.exe')
  const bin = cfg.adb && existsSync(cfg.adb) ? cfg.adb : existsSync(local) ? local : 'adb'
  const serial = `${cfg.ip}:${cfg.port ?? 5555}`
  return new Promise((res) => execFile(bin, ['-s', serial, ...args], { timeout: timeoutMs, windowsHide: true }, (err, so, se) => res(err ? `(virhe: ${String(se || err.message).trim().slice(0, 160)})` : String(so).trim())))
}

let device = ''
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.jarvis', 'projektori.json'), 'utf8').replace(/^\uFEFF/, ''))
  const bin = cfg.adb && existsSync(cfg.adb) ? cfg.adb : 'adb'
  await new Promise((r) => execFile(bin, ['connect', `${cfg.ip}:${cfg.port ?? 5555}`], { timeout: 8000, windowsHide: true }, () => r()))
  const props = {}
  for (const p of ['ro.product.model', 'ro.product.brand', 'ro.product.name', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.display.id', 'ro.product.cpu.abi', 'ro.hardware'])
    props[p] = await adb(['shell', 'getprop', p])
  const size = await adb(['shell', 'wm', 'size'])
  const pkgs = (await adb(['shell', 'pm', 'list', 'packages', '-3'])).replace(/package:/g, '').split(/\s+/).filter(Boolean).sort()
  const sys = (await adb(['shell', 'pm', 'list', 'packages', '-s'])).replace(/package:/g, '').split(/\s+/).filter((p) => /xgimi|cec|hdmi|keystone|focus|tv\.|android\.tv|launcher|settings|bluetooth|media/i.test(p)).sort()
  const focus = (await adb(['shell', 'dumpsys', 'window', '|', 'grep', '-m1', 'mCurrentFocus'])).slice(0, 200)
  device =
    `Laite: ${props['ro.product.brand']} ${props['ro.product.model']} (${props['ro.product.name']}), Android ${props['ro.build.version.release']} (SDK ${props['ro.build.version.sdk']}), build ${props['ro.build.display.id']}, ${props['ro.product.cpu.abi']}, ${size}.\n` +
    `Käyttäjän asentamat sovellukset: ${pkgs.join(', ') || '(ei saatu)'}\n` +
    `Järjestelmän olennaiset paketit: ${sys.join(', ') || '(ei saatu)'}\n` +
    `Nyt edessä: ${focus}`
} catch (err) {
  device = `(projektorin tietoja ei saatu: ${err?.message ?? err})`
}
parts.push('## Laitetiedot (ADB, vain luku)\n' + device + '\n')
save()

const learnFile = join(root, 'muisti', 'projektorioppi.md')
const learned = existsSync(learnFile) ? readFileSync(learnFile, 'utf8').slice(0, 2500) : ''

const PROMPT = `Olen JARVIS, suomenkielinen tekoälyavustaja Windows-pelikoneella (Node + Claude Agent SDK). Ohjaan kotiverkossa XGIMI-projektoria ADB:llä (adb connect ip:5555, adb shell input/am/pm/settings/screencap/uiautomator dump). Käyttäjä puhuu minulle äänellä tai Telegramissa.

PROJEKTORI:
${device}

MITÄ OSAAN NYT (työkalut): projektori_tila (päällä/sovellus), projektori_virta (pois = keyevent 223; päälle vain jos projektori on hereillä — syvästä valmiustilasta ei herää verkon yli, koska wifi sammuu; Wake-on-LAN ei toimi), projektori_avaa (sovellus nimellä, puuttuvan APK:n asennus laitteen muistista), projektori_netflix ja projektori_disney (yksi kutsu: avaa, profiili, haku, toisto), projektori_haku (Netflix/YouTube), projektori_spotify (soittolista + Play-napin painallus ja tarkistus), projektori_linkki (http/intent), projektori_nappain (keyevent), projektori_kirjoita (teksti), projektori_lue (uiautomator dump tekstinä), projektori_valitse (napauta tekstiä), projektori_napauta (koordinaatti), projektori_nayta ja projektori_kuva (screencap), projektori_odota (odota tekstiä ruudulle), projektori_ruutu (pimeä = screen_brightness 0, ei aina himmennä XGIMIn valonlähdettä), projektori_asetukset (asetusnäkymät), projektori_sovellukset, projektori_muista (oppi muistiin). Rutiinit: "leffailta" (projektori + Netflix + valot pois + koneen näyttö kiinni), "nukkumaan" (kaikki pois), ajastin ("sammuta telkkari 30 min päästä").
MUUT LAITTEET SAMASSA JÄRJESTELMÄSSÄ: Tuya-älyvalot, Spotify Connect, Samsung Tizen -telkkari (eri laite), Roborock-imuri, Windows-PC (näytön ohjaus), puhelin (Telegram, Siri-pikakomento).

OPITTUA TÄSTÄ PROJEKTORISTA:
${learned}

KYSYMYS: Mitä uusia tai parempia projektoritoimintoja kannattaisi rakentaa? Ota huomioon juuri tämä käyttöjärjestelmä (Android TV -versio, XGIMIn oma käyttöliittymä, rajoitukset ilman roottia) ja laite (projektori: valonlähde, tarkennus/keystone, ääni, HDMI, Bluetooth, valmiustila). Vastaa suomeksi, enintään ~450 sanaa, otsikoilla:
1. Parhaat 5–8 uutta toimintoa (mitä käyttäjä sanoo → mitä JARVIS tekee → miten teknisesti ADB:llä; mainitse tarkat komennot/intentit jos tiedät)
2. Nykyisten toimintojen parannukset (luotettavuus, nopeus)
3. Mitä EI kannata tai voi tehdä tällä laitteella (ja miksi)
4. Riskit (laitteen asetukset, turvallisuus, kuluminen)
Älä keksi komentoja: jos et ole varma, että komento toimii Android TV:ssä tai XGIMIssä, sano "tarkistettava".`

parts.push('## Prompti (sama kaikille)\n' + PROMPT + '\n')
save()

async function claude() {
  let text = ''
  const s = query({ prompt: PROMPT, options: { systemPrompt: 'Vastaa suomeksi, kriittisesti ja konkreettisesti. Älä keksi komentoja.', model: 'claude-opus-5', effort: 'medium', maxTurns: 1, settingSources: [], mcpServers: {}, tools: [], permissionMode: 'default', canUseTool: async () => ({ behavior: 'deny', message: 'Ei työkaluja.' }), cwd: homedir() } })
  for await (const m of s) if (m.type === 'result' && m.subtype === 'success' && !m.is_error) text = String(m.result ?? '')
  return text
}
const [mine, council] = await Promise.all([
  claude().catch((e) => `(virhe: ${e?.message ?? e})`),
  import('./tekoalyt.mjs').then(({ askCouncil, providerName }) => askCouncil('neuvosto', PROMPT, { system: 'Vastaa suomeksi, kriittisesti ja konkreettisesti. Älä keksi komentoja; sano "tarkistettava" jos et ole varma.', max: 6, timeoutMs: 180_000 }).then((r) => (r.results ?? []).map((x) => ({ name: providerName(x.provider), text: x.text, error: x.error })))).catch((e) => [{ name: 'muut tekoälyt', error: String(e?.message ?? e) }]),
])
parts.push(`=== VASTAUS: Claude ===\n${mine}\n`)
for (const a of council) parts.push(`=== VASTAUS: ${a.name} ===\n${a.text || `(ei vastausta: ${a.error ?? 'tyhjä'})`}\n`)
parts.push(`(valmis ${new Date().toLocaleTimeString('fi-FI', { timeZone: 'Europe/Helsinki' })})`)
save()
process.exit(0)
