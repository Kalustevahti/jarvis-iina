// JARVIS: tekoälyt samalla koodilla kuin JARVIS (bridge/tekoalyt.mjs) → lokit/tekoaly_node_testi.txt. Ajetaan tyokalut\tekoaly_node_testi.bat.
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const ai = await import('./bridge/tekoalyt.mjs')
const out = join(homedir(), 'Documents', 'JARVIS', 'lokit', 'tekoaly_node_testi.txt')
writeFileSync(out, `Tekoälytesti (JARVISin koodi) ${new Date().toLocaleString('fi-FI')}\n`)
const L = (s) => { appendFileSync(out, s + '\n'); console.log(s) }
L(`groq-yhteys.exe: ${ai.GROQ_EXE} (olemassa: ${existsSync(ai.GROQ_EXE)}${existsSync(ai.GROQ_EXE) ? `, ${statSync(ai.GROQ_EXE).size} t` : ''})`)
L(`Käytettävissä: ${(await ai.availableProviders()).join(', ')}`)
for (const p of ['groq', 'gemini', 'gpt']) {
  const t0 = Date.now()
  try {
    const r = await ai.pingProvider(p)
    L(`${p}: OK (${Math.round((Date.now() - t0) / 100) / 10} s) ${r}`)
  } catch (err) {
    L(`${p}: VIRHE (${Math.round((Date.now() - t0) / 100) / 10} s): ${String(err?.message ?? err).slice(0, 600)}`)
  }
}
L('Valmis.')
process.exit(0)
