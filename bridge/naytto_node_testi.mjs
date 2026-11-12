// JARVIS: testaa näytön kuvauksen ja ohjauksen täsmälleen JARVISin omalla koodilla → lokit\naytto_node_testi.txt
// Ei klikkaa mitään: painaa vain Shift-näppäintä, tuo Resurssienhallinnan eteen ja etsii Riot Clientin.
// "node naytto_node_testi.mjs lol" käynnistää lisäksi League of Legendsin.
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'lokit', 'naytto_node_testi.txt')
const lines = [`=== naytto_node_testi ${new Date().toISOString()} ===`]
const origWarn = console.warn
console.warn = (...a) => { lines.push(`warn: ${a.join(' ')}`); origWarn(...a) }
const step = async (name, fn) => {
  const t0 = Date.now()
  try { lines.push(`${name}: OK ${Date.now() - t0} ms — ${String(await fn()).slice(0, 300)}`) } catch (err) { lines.push(`${name}: VIRHE ${String(err?.message ?? err).slice(0, 400)}`) }
  writeFileSync(out, lines.join('\n') + '\n')
}
try {
  const K = await import('./kone.mjs')
  await step('kone_nayta', async () => { const r = await K.machineCall('kone_nayta', {}); if (!r.image) throw new Error(r.text); return `kuva ${r.image.data.length} merkkiä; ${r.text.slice(0, 80)}` })
  await step('nappain shift', () => K._ohjaus('nappain', '16'))
  await step('ikkuna explorer', () => K._ohjaus('ikkuna', 'explorer'))
  await step('riot polku', () => K.riotClientPath() ?? 'EI LÖYTYNYT')
  if (process.argv.includes('lol')) await step('League of Legends', () => K.openRiotGame(K.riotGame('lol')))
} catch (err) {
  lines.push(`tuonti epäonnistui: ${err?.stack ?? err}`)
}
writeFileSync(out, lines.join('\n') + '\n')
process.exit(0)
