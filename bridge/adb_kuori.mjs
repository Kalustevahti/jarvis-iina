/**
 * Pysyvä adb shell -istunto (9.11.2026): yksi pitkäikäinen `adb -s <serial> shell -T` -lapsiprosessi, jonka stdiniin
 * komennot kirjoitetaan. Uutta adb.exe:tä ei käynnistetä joka näppäimelle (Windowsilla ~300–600 ms per komento).
 *
 * Jokainen komento kääritään: `{ <komento> ; } </dev/null; echo "__JV_<id>__ $?"; echo "__JV_<id>__" >&2`.
 * Tuloste on kaikki ennen merkkiä, $? on komennon paluukoodi (≠ 0 → virhe stderr-tekstillä kuten execFilellä).
 * Yksi komento kerrallaan: kutsuja tarkistaa busy() ja käyttää muuten tavallista execFileä.
 * Puhdas moduuli (spawn annetaan), jotta sen voi testata ilman laitetta.
 */

let seq = 0

export function createShellSession({ spawn, file, args, idleMs = 300_000, log = () => {} }) {
  let child = null
  let out = ''
  let err = ''
  let cur = null
  let idleT = null
  let lastUse = 0

  const settle = (c, fn) => {
    clearTimeout(c.timer)
    cur = null
    fn()
  }

  function kill() {
    const c = child
    child = null
    if (!c) return
    try {
      c.stdin.end()
    } catch {
      /* already closed */
    }
    try {
      c.kill()
    } catch {
      /* already gone */
    }
  }

  function check() {
    if (!cur) return
    const mark = `__JV_${cur.id}__`
    const mo = out.match(new RegExp(`${mark} (\\d+)\\r?\\n`))
    const ei = err.indexOf(mark)
    const eEnd = ei < 0 ? -1 : err.indexOf('\n', ei)
    if (!mo || eEnd < 0) return
    const stdout = out.slice(0, mo.index)
    const stderr = err.slice(0, ei)
    out = out.slice(mo.index + mo[0].length)
    err = err.slice(eEnd + 1)
    const code = Number(mo[1])
    const c = cur
    settle(c, () => (code === 0 ? c.resolve(stdout) : c.reject(new Error(String(stderr.trim() || `exit ${code}`).slice(0, 200)))))
    clearTimeout(idleT)
    idleT = setTimeout(() => {
      if (!cur) kill()
    }, idleMs)
    idleT.unref?.()
  }

  function start() {
    out = ''
    err = ''
    const c = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child = c
    c.stdout.setEncoding?.('utf8')
    c.stderr.setEncoding?.('utf8')
    c.stdout.on('data', (d) => {
      if (child !== c) return
      out += String(d)
      check()
    })
    c.stderr.on('data', (d) => {
      if (child !== c) return
      err += String(d)
      check()
    })
    c.stdin.on?.('error', () => {})
    const gone = (why) => {
      const tail = err.trim().slice(-160)
      if (child === c) child = null
      // "error: closed" matches LINK_LOST in projektori.mjs: the caller decides whether the command may be re-sent.
      // Only this child's own command: a killed (hung) shell exits late, after a new one already runs the next command.
      const x = cur
      if (x && x.child === c) settle(x, () => x.reject(new Error(`error: closed (${why})${tail ? ` ${tail}` : ''}`)))
    }
    c.on('exit', (code) => gone(`adb shell päättyi, koodi ${code}`))
    c.on('error', (e) => gone(String(e?.message ?? e)))
    log('[jarvis] projektori: pysyvä adb shell auki')
  }

  return {
    busy: () => Boolean(cur),
    alive: () => Boolean(child),
    /** ms since the last command finished (Infinity when never used). */
    idleFor: () => (lastUse ? Date.now() - lastUse : Infinity),
    exec(cmd, { timeoutMs = 15_000 } = {}) {
      const line = String(cmd ?? '').replace(/[\s;]+$/, '')
      if (cur) return Promise.reject(new Error('kuori varattu'))
      if (!line || /[\r\n]/.test(line)) return Promise.reject(new Error('komento ei sovi pysyvään kuoreen'))
      if (!child) start()
      const id = ++seq
      return new Promise((resolve, reject) => {
        const c = {
          id,
          child,
          resolve: (v) => ((lastUse = Date.now()), resolve(v)),
          reject: (e) => ((lastUse = Date.now()), reject(e)),
          timer: setTimeout(() => {
            if (cur !== c) return
            // A hung command blocks the shell for good: kill it; the next exec starts a fresh one.
            settle(c, () => reject(new Error(`aikakatkaisu ${timeoutMs} ms`)))
            kill()
          }, timeoutMs),
        }
        cur = c
        try {
          child.stdin.write(`{ ${line} ; } </dev/null; echo "__JV_${id}__ $?"; echo "__JV_${id}__" >&2\n`)
        } catch (e) {
          settle(c, () => reject(new Error(`error: closed (${String(e?.message ?? e)})`)))
          kill()
        }
      })
    },
    close() {
      clearTimeout(idleT)
      kill()
    },
  }
}
