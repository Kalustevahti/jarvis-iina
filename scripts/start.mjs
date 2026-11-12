/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []

function run(name, command, args, colour, env) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

/**
 * Newest modification time under the given files/directories (0 if none exist).
 *
 * The build is skipped when dist/ is newer than everything it is made from, so a normal "uudelleen" restart
 * serves the existing build at once and only a real UI change pays for a rebuild. .env.local is an input too:
 * its VITE_* values are baked into the bundle.
 */
function newest(paths) {
  let max = 0
  const walk = (p) => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f))
    else if (st.mtimeMs > max) max = st.mtimeMs
  }
  paths.forEach(walk)
  return max
}
const BUILD_INPUTS = ['src', 'public', 'index.html', 'vite.config.ts', 'package.json', 'package-lock.json', '.env', '.env.local', 'tsconfig.json', 'tsconfig.app.json']

/** Runs `vite build`; resolves true on success. Output is tagged like the other children. */
function build() {
  return new Promise((resolve) => {
    const label = paint('build', '33')
    const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { env: process.env, shell: false })
    child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
    child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
    child.on('error', (err) => {
      console.error(`  [jarvis] käyttöliittymän rakennus ei käynnistynyt: ${err.message}`)
      resolve(false)
    })
    child.on('exit', (code) => resolve(code === 0))
  })
}

/**
 * The face. Production by default (9.11.2026): a built, minified bundle served by `vite preview` — the phone
 * loads a handful of files instead of hundreds of dev modules, React runs in production mode, and nothing reloads
 * the page when a file changes. JARVIS_DEV=1 keeps the old dev server with hot reload. If the build fails, the
 * dev server starts instead, so JARVIS always comes up.
 */
async function startFace() {
  const vite = 'node_modules/vite/bin/vite.js'
  if (process.env.JARVIS_DEV === '1') {
    console.log('  [jarvis] JARVIS_DEV=1: kehitystila (Vite dev server, muutokset näkyvät heti).')
    return run('face', process.execPath, [vite], '35', {})
  }
  const builtAt = existsSync('dist/index.html') ? statSync('dist/index.html').mtimeMs : 0
  const changedAt = newest(BUILD_INPUTS)
  if (!builtAt || changedAt > builtAt) {
    console.log(`  [jarvis] käyttöliittymä on muuttunut — rakennetaan tuotantoversio (vite build)…`)
    const t0 = Date.now()
    const ok = await build()
    if (stopping) return
    if (!ok) {
      console.error('  [jarvis] VIRHE: käyttöliittymän rakennus epäonnistui (loki yllä) — käynnistetään kehitystila, jotta JARVIS toimii.')
      return run('face', process.execPath, [vite], '35', {})
    }
    console.log(`  [jarvis] tuotantoversio rakennettu ${((Date.now() - t0) / 1000).toFixed(1)} s:ssa.`)
  } else console.log('  [jarvis] käyttöliittymä ennallaan — käytetään valmista tuotantoversiota (dist/).')
  return run('face', process.execPath, [vite, 'preview'], '35', {})
}

vendorWasm()

console.log('\nJ.A.R.V.I.S. starting — the brain and the face.\n')
run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
void startFace()

console.log(
  '\nWhen it says the server is ready, open the URL it prints in Chrome. Ctrl-C stops everything.\n',
)
