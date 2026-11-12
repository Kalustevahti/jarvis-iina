/**
 * NÄYTTÖ-sivu (9.11.2026, Eliaksen hyväksymä): koneen näyttö kuvavirtana PIN-kirjautuneelle selaimelle ja
 * ohjaus napautuksilla / hiirellä. Vain server.mjs:n tunnistetuille yhteyksille.
 *
 * - Kuvaus (10.11.2026): ffmpeg gdigrab → MJPEG stdoutiin → JPEG-ruudut jäsennetään (createMjpegParser).
 *   Yksi ffmpeg per virta; sammuu, kun virta loppuu. ffmpeg = JARVIS_FFMPEG tai PATH (sama kuin whisper/kamera).
 *   Auto-tila (oletus) säätää fps:n, leveyden (960–1600 px) ja laadun (q 4–10) mitatusta kuittausajasta.
 *   Jos ffmpeg puuttuu tai ei käynnisty → perustila: pysyvä PowerShell (ps/naytto.ps1, CopyFromScreen), enintään
 *   5 fps; jos sekään ei toimi, kuva.ps1 koko virtuaalinäytöstä.
 * - Ei jonoa (createFrameGate): yksi ruutu kerrallaan matkalla; kuittaamattoman aikana uusin ruutu korvaa
 *   odottavan. Samat ruudut (tiiviste) ohitetaan, paitsi 3 s välein (selaimen vahtikoira tietää virran elävän).
 * - Binääriviesti: 'JVN1' + otsakkeen pituus (u32 BE) + JSON-otsake {seq,t,w,h,…} + JPEG (encodeFrame).
 * - Fokus (ps/fokus.ps1, UI Automation, 250 ms vain virran aikana): {type:'naytto_fokus', kirjoitus, rect, salasana}.
 *   Kentän sisältöä ei koskaan lueta eikä lähetetä.
 * - Vain yksi virta kerrallaan: toinen laite ottaa ohjauksen, ensimmäinen saa "Ohjaus siirtyi toiselle laitteelle".
 * - Pysähtyy: naytto_lopeta, yhteyden sulkeutuminen, 10 min ilman syötettä (selain lähettää lopeta, kun sivu piiloutuu).
 * - Syöte: x, y = 0..1 kuvatusta näytöstä → todelliset pikselit (DPI ja monitorin paikka huomioitu). Hiiri ja
 *   näppäimet kone.mjs:n ohjaus.ps1:llä; suora kirjoitus (teksti, KEYEVENTF_UNICODE) ja näppäimet nopeasti
 *   pysyvän naytto.ps1:n kautta. Eliaksen oma suora ohjaus PIN:n jälkeen, ei mallin vahvistusta; mallin
 *   työkalujen estot pysyvät ennallaan.
 * - Loki: lokit\naytto_loki.txt (aika, laite, tyyppi — ei kirjoitettua tekstiä).
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _ohjaus, _psFile, PS_SCRIPTS_DIR } from './kone.mjs'

const LOG_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lokit', 'naytto_loki.txt')
const FFMPEG = () => process.env.JARVIS_FFMPEG ?? 'ffmpeg'
const PS_MAX_W = 1280
const PS_MAX_FPS = 5
const IDLE_MS = 10 * 60_000
const ACK_WAIT_MS = 5000
export const FPS_CHOICES = [5, 10, 15, 30]
/** Auto-tilan portaat (pienin → suurin). Fps 5/10/15/30 -valinnat käyttävät 1280 px / q 6. */
export const AUTO_LEVELS = [
  { w: 960, q: 10, fps: 8 },
  { w: 1120, q: 8, fps: 12 },
  { w: 1280, q: 7, fps: 15 },
  { w: 1440, q: 5, fps: 22 },
  { w: 1600, q: 4, fps: 30 },
]
const AUTO_START = 2

export function screenLog(device, what) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} | ${String(device).slice(0, 80)} | ${what}\n`)
  } catch {
    /* logging must never stop control */
  }
}

/** Whitelisted keys → virtual key codes. */
export const SCREEN_KEYS = {
  enter: [0x0d], esc: [0x1b], tab: [0x09], backspace: [0x08], delete: [0x2e],
  'ylös': [0x26], ylos: [0x26], alas: [0x28], vasen: [0x25], oikea: [0x27],
  home: [0x24], end: [0x23],
  win: [0x5b], 'alt+tab': [0x12, 0x09], 'ctrl+c': [0x11, 0x43], 'ctrl+v': [0x11, 0x56], 'ctrl+z': [0x11, 0x5a],
}

/** Normalized 0..1 point on monitor bounds → real desktop pixel. null if invalid. */
export function toScreen(b, x, y) {
  const nx = Number(x), ny = Number(y)
  if (!b || !Number.isFinite(nx) || !Number.isFinite(ny)) return null
  const cx = Math.min(1, Math.max(0, nx)), cy = Math.min(1, Math.max(0, ny))
  return [Math.round(b.x + cx * (b.w - 1)), Math.round(b.y + cy * (b.h - 1))]
}

// ---------------------------------------------------------------- JPEG / MJPEG

/**
 * End of the JPEG that starts (SOI) at `s`: index just past EOI, -1 = not complete yet, -2 = not a JPEG.
 * Walks the marker segments, so an FF D9 inside a header (tables, EXIF) cannot end the frame early; in the
 * entropy-coded data FF is always stuffed (FF 00) or a restart marker.
 */
export function jpegEnd(buf, s) {
  let i = s + 2
  for (;;) {
    // marker segments
    for (;;) {
      if (i + 1 >= buf.length) return -1
      if (buf[i] !== 0xff) return -2
      const m = buf[i + 1]
      if (m === 0xff) {
        i++
        continue
      }
      if (m === 0xd9) return i + 2
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        i += 2
        continue
      }
      if (i + 3 >= buf.length) return -1
      const len = buf.readUInt16BE(i + 2)
      if (len < 2) return -2
      i += 2 + len
      if (m === 0xda) break
    }
    // entropy-coded data until the next real marker
    for (;;) {
      if (i + 1 >= buf.length) return -1
      if (buf[i] === 0xff) {
        const n = buf[i + 1]
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
          i += 2
          continue
        }
        if (n === 0xff) {
          i++
          continue
        }
        if (n === 0xd9) return i + 2
        break // another segment (progressive JPEG: next DHT/SOS)
      }
      i++
    }
  }
}

/** Width/height from the SOF marker, or null. */
export function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null
    const m = buf[i + 1]
    if (m === 0xff) {
      i++
      continue
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }
    if (m === 0xda || m === 0xd9) return null
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}

/** Feed stdout chunks of `-f mjpeg`; calls onFrame(Buffer) for every complete JPEG (frames may span chunks). */
export function createMjpegParser(onFrame, { maxBytes = 16 * 1024 * 1024 } = {}) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk)
    for (;;) {
      let s = -1
      for (let i = 0; i + 1 < buf.length; i++) {
        if (buf[i] === 0xff && buf[i + 1] === 0xd8) {
          s = i
          break
        }
      }
      if (s < 0) {
        // Keep a trailing 0xFF: it may be the first half of the next SOI.
        buf = buf.length && buf[buf.length - 1] === 0xff ? Buffer.from([0xff]) : Buffer.alloc(0)
        return
      }
      if (s > 0) buf = buf.subarray(s)
      const e = jpegEnd(buf, 0)
      if (e === -1) {
        if (buf.length > maxBytes) buf = Buffer.alloc(0)
        return
      }
      if (e === -2) {
        buf = buf.subarray(2) // garbage SOI: resync on the next one
        continue
      }
      const frame = Buffer.from(buf.subarray(0, e))
      buf = buf.subarray(e)
      onFrame(frame)
    }
  }
}

/** Binary frame message: 'JVN1' + header length (u32 BE) + JSON header + JPEG. */
export function encodeFrame(head, jpg) {
  const h = Buffer.from(JSON.stringify(head))
  const pre = Buffer.alloc(8)
  pre.write('JVN1', 0, 'ascii')
  pre.writeUInt32BE(h.length, 4)
  return Buffer.concat([pre, h, jpg])
}
/** Inverse of encodeFrame (tests; the browser has its own reader in src/lib/bridge.ts). */
export function decodeFrame(buf) {
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'JVN1') return null
  const len = buf.readUInt32BE(4)
  return { head: JSON.parse(buf.toString('utf8', 8, 8 + len)), jpg: buf.subarray(8 + len) }
}

/**
 * Latest frame wins, never a queue. offer() sends at once when nothing is in flight; otherwise the frame
 * replaces the one waiting (older one dropped). ack(seq) releases the next. A frame identical to the last sent
 * one is skipped (no bandwidth on a still screen), except every resendMs so the page knows the stream is alive.
 */
export function createFrameGate({ send, now = Date.now, ackWaitMs = ACK_WAIT_MS, resendMs = 3000, busy = () => false } = {}) {
  let seq = 0
  let inFlight = false
  let sentAt = 0
  let lastHash = ''
  let lastSentAt = 0
  let pending = null
  const st = { sent: 0, dropped: 0, same: 0, rtt: [], bytes: 0 }
  const doSend = (f) => {
    seq++
    inFlight = true
    sentAt = now()
    lastHash = f.hash
    lastSentAt = sentAt
    st.sent++
    st.bytes += f.jpg.length
    send(seq, f.jpg, f.meta)
  }
  const blocked = () => inFlight && now() - sentAt < ackWaitMs
  return {
    offer(jpg, meta = {}) {
      const hash = createHash('sha1').update(jpg).digest('base64')
      if (hash === lastHash && now() - lastSentAt < resendMs) {
        pending = null
        st.same++
        return 'sama'
      }
      const f = { jpg, meta, hash }
      if (blocked() || busy()) {
        if (pending) st.dropped++
        pending = f
        return 'odottaa'
      }
      pending = null
      doSend(f)
      return 'lahti'
    },
    ack(n) {
      if (!inFlight || Number(n) !== seq) return false
      inFlight = false
      st.rtt.push(now() - sentAt)
      if (st.rtt.length > 30) st.rtt.shift()
      if (pending && !busy()) {
        const f = pending
        pending = null
        doSend(f)
      }
      return true
    },
    /** Send the waiting frame if the socket has drained (called from a timer). */
    poke() {
      if (pending && !blocked() && !busy()) {
        const f = pending
        pending = null
        doSend(f)
      }
    },
    get seq() {
      return seq
    },
    get waiting() {
      return blocked()
    },
    hasPending: () => Boolean(pending),
    /** Stats since the last call (for Auto). */
    take() {
      const r = { sent: st.sent, dropped: st.dropped, same: st.same, bytes: st.bytes, rtt: st.rtt.length ? Math.round(st.rtt.reduce((a, b) => a + b, 0) / st.rtt.length) : 0 }
      st.sent = st.dropped = st.same = st.bytes = 0
      st.rtt = []
      return r
    },
  }
}

/**
 * Auto: next level index from one measuring window. capacity = frames/s the link can carry one-at-a-time.
 * Down when the link cannot carry the level's fps (or round trips are slow), up when there is clear headroom.
 */
export function autoDecide(level, s, levels = AUTO_LEVELS) {
  if (!s || s.sent < 3 || !s.rtt) return level
  const cap = 1000 / Math.max(1, s.rtt)
  if ((s.rtt > 300 || cap < levels[level].fps * 0.6) && level > 0) return level - 1
  const up = levels[level + 1]
  if (up && s.rtt < 150 && cap > up.fps * 1.3 && s.dropped <= s.sent * 0.25) return level + 1
  return level
}

/** ffmpeg gdigrab arguments for one monitor. */
export function ffmpegArgs(mon, { w, q, fps }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1']
  if (mon && mon.w > 0 && mon.h > 0) args.push('-offset_x', String(mon.x), '-offset_y', String(mon.y), '-video_size', `${mon.w}x${mon.h}`)
  const outW = Math.max(320, Math.min(w, mon?.w > 0 ? mon.w : w))
  args.push('-i', 'desktop', '-vf', `scale=${outW}:-2:flags=fast_bilinear`, '-q:v', String(q), '-f', 'mjpeg', 'pipe:1')
  return args
}

// ---------------------------------------------------------------- focus (UI Automation)

/** "FOKUS 1 x y w h s" (physical px) → page message, rect normalized to the captured monitor. Never any content. */
export function parseFocusLine(line, b) {
  const m = /^FOKUS\s+([01])(?:\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+([01]))?\s*$/.exec(String(line).trim())
  if (!m) return null
  const kirjoitus = m[1] === '1'
  let rect = null
  if (kirjoitus && m[2] != null && b && b.w > 0 && b.h > 0) {
    const x = Number(m[2]), y = Number(m[3]), w = Number(m[4]), h = Number(m[5])
    const x1 = Math.max(x, b.x), y1 = Math.max(y, b.y), x2 = Math.min(x + w, b.x + b.w), y2 = Math.min(y + h, b.y + b.h)
    if (w > 0 && h > 0 && x2 > x1 && y2 > y1) {
      const r4 = (v) => Math.round(v * 10000) / 10000
      rect = { x: r4((x1 - b.x) / b.w), y: r4((y1 - b.y) / b.h), w: r4((x2 - x1) / b.w), h: r4((y2 - y1) / b.h) }
    }
  }
  return { type: 'naytto_fokus', kirjoitus, rect, salasana: kirjoitus && m[6] === '1' }
}

function createFocusWatcher({ onLine, spawnImpl = spawn }) {
  let proc = null
  let buf = ''
  return {
    start() {
      if (proc) return
      const file = join(PS_SCRIPTS_DIR, 'fokus.ps1')
      if (!existsSync(file)) return
      try {
        proc = spawnImpl('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Vanhempi', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        proc = null
        return
      }
      const p = proc
      p.stdout?.setEncoding?.('utf8')
      p.stdout?.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) onLine(line)
        }
      })
      p.stderr?.on('data', (d) => console.warn(`[jarvis] näyttö/fokus: ${String(d).replace(/\s+/g, ' ').slice(0, 160)}`))
      const dead = () => {
        if (proc === p) proc = null
        buf = ''
      }
      p.on('exit', dead)
      p.on('error', dead)
    },
    stop() {
      const p = proc
      proc = null
      buf = ''
      try {
        p?.kill()
      } catch {
        /* gone */
      }
    },
  }
}

// ---------------------------------------------------------------- persistent PowerShell (perustila + typing)

/** Persistent capture process (ps/naytto.ps1), line protocol. */
function createCapturer() {
  let proc = null
  let buf = ''
  const waiting = []
  const start = () => {
    if (proc) return
    const file = join(PS_SCRIPTS_DIR, 'naytto.ps1')
    if (!existsSync(file)) throw new Error('bridge\\ps\\naytto.ps1 puuttuu')
    proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    // A dead process must never take the bridge down (EPIPE on write).
    proc.stdin.on('error', () => {})
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) waiting.shift()?.resolve(line)
      }
    })
    proc.stderr.on('data', (d) => console.warn(`[jarvis] näyttö: ${String(d).replace(/\s+/g, ' ').slice(0, 200)}`))
    const dead = () => {
      proc = null
      buf = ''
      while (waiting.length) waiting.shift().reject(new Error('kuvausprosessi loppui'))
    }
    proc.on('exit', dead)
    proc.on('error', dead)
  }
  const cmd = (line, ms = 10_000) =>
    new Promise((resolve, reject) => {
      try {
        start()
      } catch (err) {
        return reject(err)
      }
      const slot = { resolve, reject }
      waiting.push(slot)
      const t = setTimeout(() => {
        const i = waiting.indexOf(slot)
        if (i >= 0) waiting.splice(i, 1)
        stop()
        reject(new Error('kuvaus ei vastannut'))
      }, ms)
      slot.resolve = (v) => (clearTimeout(t), resolve(v))
      slot.reject = (e) => (clearTimeout(t), reject(e))
      try {
        proc.stdin.write(line + '\n')
      } catch (err) {
        slot.reject(err)
      }
    })
  const stop = () => {
    if (!proc) return
    const p = proc
    proc = null
    try {
      p.stdin.write('loppu\n')
    } catch {
      /* already gone */
    }
    setTimeout(() => p.kill(), 1500).unref?.()
  }
  return { cmd, stop }
}

/** fps setting from the page: 'auto' (default) or one of FPS_CHOICES. */
export function parseFps(v) {
  const n = Math.round(Number(v))
  return FPS_CHOICES.includes(n) ? n : 'auto'
}

/**
 * @param {object} o
 * @param {(text:string)=>any} [o.notify] Telegram notice when control starts
 * @param {Function} [o.spawnImpl] ffmpeg spawn (tests)
 * @param {object} [o.capturer] { cmd, stop } persistent PowerShell (tests)
 * @param {boolean} [o.focus] start the UI Automation focus watcher (default true)
 * @param {Function} [o.log] lokit\naytto_loki.txt writer (tests)
 */
export function createScreenControl({ notify = () => {}, ohjaus = _ohjaus, psFile = _psFile, spawnImpl = spawn, capturer, focus = true, focusSpawn, log = screenLog } = {}) {
  const cap = capturer ?? createCapturer()
  const file = join(tmpdir(), `jarvis_naytto_${process.pid}.jpg`)
  let fallback = false // monitor list / perustila capture via kuva.ps1
  let fails = 0
  /** ffmpeg unusable → perustila (reason shown in the page corner). Retried after 10 min. */
  let ffBroken = null // { why, at }
  /** { ws, device, fps, mon, timer, lastInput, monitors, bounds, gate, ff, level, mode, … } */
  let active = null
  const notified = new Map()
  let inputQueue = Promise.resolve()
  let queued = 0
  let typedLogAt = 0

  const sendJson = (ws, o) => {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(o))
    } catch {
      /* closed */
    }
  }

  const focusW = focus
    ? createFocusWatcher({
        spawnImpl: focusSpawn ?? spawn,
        onLine: (line) => {
          const a = active
          if (!a) return
          const msg = parseFocusLine(line, a.bounds)
          if (!msg) return
          a.focus = msg
          sendJson(a.ws, msg)
        },
      })
    : null

  async function monitors() {
    if (!fallback) {
      try {
        const line = await cap.cmd('naytot')
        if (line.startsWith('NAYTOT ')) {
          const list = line
            .slice(7)
            .split(';')
            .filter(Boolean)
            .map((s) => s.split(',').map(Number))
            .map(([i, pr, x, y, w, h]) => ({ i, primary: pr === 1, x, y, w, h }))
          if (list.length) return list
        }
      } catch (err) {
        console.warn('[jarvis] näyttö: monitorilista epäonnistui:', err?.message ?? err)
      }
      fallback = true
    }
    return [{ i: 0, primary: true, x: 0, y: 0, w: 0, h: 0, kaikki: true }]
  }

  /** Current capture settings for the active stream. */
  const settings = (a) => (a.fps === 'auto' ? AUTO_LEVELS[a.level] : { w: 1280, q: 6, fps: a.fps })

  const statusMsg = (a, extra = {}) => ({
    type: 'naytto_tila',
    tila: 'kaynnissa',
    fps: a.fps,
    naytto: a.mon,
    naytot: a.monitors.map((m) => ({ i: m.i, ensisijainen: m.primary, w: m.w, h: m.h, kaikki: Boolean(m.kaikki) })),
    perustila: a.mode === 'ps' ? `Perustila (${ffBroken?.why ?? 'näyttölista ei toimi'})` : null,
    palvelinAika: Date.now(),
    ...extra,
  })

  function makeGate(a) {
    return createFrameGate({
      busy: () => a.ws.bufferedAmount > 1_500_000,
      send: (seq, jpg, meta) => {
        if (active !== a) return
        const s = a.mode === 'ff' ? settings(a) : null
        const head = { seq, t: meta.t ?? Date.now(), w: meta.w, h: meta.h, naytto: a.mon, tila: a.mode, tavoite: s?.fps ?? Math.min(a.fps === 'auto' ? PS_MAX_FPS : a.fps, PS_MAX_FPS), kesto: meta.kesto ?? 0 }
        try {
          a.ws.send(encodeFrame(head, jpg), { binary: true })
        } catch {
          stop(a.ws, 'lähetys epäonnistui')
        }
      },
    })
  }

  // ---- ffmpeg path
  function startFfmpeg(a) {
    stopFfmpeg(a)
    const m = a.monitors.find((x) => x.i === a.mon)
    const mon = m && m.w > 0 ? m : null
    const s = settings(a)
    let p
    try {
      p = spawnImpl(FFMPEG(), ffmpegArgs(mon, s), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return ffFailed(a, null, err)
    }
    const run = { p, frames: 0, err: '', settings: s }
    a.ff = run
    if (mon) a.bounds = { x: mon.x, y: mon.y, w: mon.w, h: mon.h }
    const parse = createMjpegParser((jpg) => {
      if (active !== a || a.ff !== run) return
      run.frames++
      a.ffFails = 0
      const size = run.size ?? (run.size = jpegSize(jpg))
      a.gate.offer(jpg, { t: Date.now(), w: size?.w ?? 0, h: size?.h ?? 0 })
    })
    p.stdout?.on('data', parse)
    p.stderr?.on('data', (d) => (run.err = String(d).replace(/\s+/g, ' ').trim().slice(-200)))
    p.on('error', (err) => ffFailed(a, run, err))
    p.on('exit', (code) => {
      if (a.ff !== run) return
      a.ff = null
      if (active !== a) return
      if (!run.frames) return ffFailed(a, run, new Error(run.err || `ffmpeg loppui (${code})`))
      // Ran fine, then stopped (e.g. secure desktop/UAC): restart shortly.
      console.warn(`[jarvis] näyttö: ffmpeg pysähtyi (${code}) ${run.err}`)
      a.restartTimer = setTimeout(() => active === a && a.mode === 'ff' && startFfmpeg(a), 800)
    })
  }

  function ffFailed(a, run, err) {
    if (run && a.ff !== run && a.ff !== null) return
    if (run) a.ff = null
    const missing = /ENOENT/.test(String(err?.code ?? err?.message ?? ''))
    a.ffFails = (a.ffFails ?? 0) + 1
    console.warn('[jarvis] näyttö: ffmpeg ei toimi:', String(err?.message ?? err).slice(0, 200))
    if (active !== a) return
    if (missing || a.ffFails >= 2) {
      ffBroken = { why: missing ? 'ffmpeg puuttuu' : 'ffmpeg ei käynnisty', at: Date.now() }
      a.mode = 'ps'
      sendJson(a.ws, statusMsg(a))
      log(a.device, `perustila (${ffBroken.why})`)
      schedule(0)
      return
    }
    a.restartTimer = setTimeout(() => active === a && a.mode === 'ff' && startFfmpeg(a), 600)
  }

  function stopFfmpeg(a) {
    clearTimeout(a.restartTimer)
    const run = a.ff
    a.ff = null
    if (!run) return
    try {
      run.p.kill()
    } catch {
      /* gone */
    }
  }

  // ---- perustila (PowerShell) path
  async function capturePs(mon) {
    if (!fallback) {
      const line = await cap.cmd(`kuva ${mon} ${PS_MAX_W} ${file}`)
      if (!line.startsWith('OK ')) throw new Error(line.replace(/^VIRHE\s*/, '') || 'kuvaus epäonnistui')
      const [x, y, w, h, sw, sh] = line.slice(3).split(/\s+/).map(Number)
      return { jpg: await readFile(file), b: { x, y, w, h }, sw, sh }
    }
    // kuva.ps1 (kone_nayta): whole virtual screen, one PowerShell per frame.
    const out = await psFile('kuva.ps1', ['-Tiedosto', file, '-MaxW', String(PS_MAX_W)], 30_000)
    const [x, y, w, h, sw, sh] = String(out).trim().split(/\s+/).map(Number)
    return { jpg: await readFile(file), b: { x, y, w, h }, sw, sh }
  }

  function schedule(ms) {
    if (!active) return
    clearTimeout(active.timer)
    active.timer = setTimeout(() => void tick(), Math.max(0, ms))
  }

  /** Perustila loop (one PowerShell capture at a time, ≤ 5 fps). */
  async function tick() {
    const a = active
    if (!a || a.mode !== 'ps') return
    if (a.gate.waiting || a.busy) return schedule(60)
    const t0 = Date.now()
    let f
    try {
      a.busy = true
      f = await capturePs(a.mon)
      fails = 0
    } catch (err) {
      a.busy = false
      fails++
      console.warn('[jarvis] näyttö: kuvaus epäonnistui:', err?.message ?? err)
      if (fails >= 3 && !fallback) {
        fallback = true
        cap.stop()
        console.warn('[jarvis] näyttö: siirrytään varatapaan (kuva.ps1).')
      }
      if (fails >= 8 && active === a) {
        sendJson(a.ws, { type: 'naytto_tila', tila: 'virhe', viesti: `Näyttöä ei saatu kuvattua (${String(err?.message ?? err).slice(0, 120)}). Onko kone lukossa?` })
        return stop(a.ws, 'kuvaus epäonnistui')
      }
      return schedule(600)
    }
    a.busy = false
    if (active !== a || a.mode !== 'ps') return
    a.bounds = f.b
    a.gate.offer(f.jpg, { t: Date.now(), w: f.sw, h: f.sh, kesto: Date.now() - t0 })
    const fps = Math.min(PS_MAX_FPS, a.fps === 'auto' ? PS_MAX_FPS : a.fps)
    schedule(1000 / fps - (Date.now() - t0))
  }

  // ---- housekeeping: idle stop, drained socket, Auto
  function housekeeping(a) {
    if (active !== a) return
    if (Date.now() - a.lastInput > IDLE_MS) {
      sendJson(a.ws, { type: 'naytto_tila', tila: 'pysaytetty', viesti: 'Näyttövirta pysähtyi: 10 min ilman ohjausta.' })
      return stop(a.ws, 'aikakatkaisu 10 min')
    }
    a.gate.poke()
    if (a.mode === 'ff' && a.fps === 'auto' && Date.now() - a.autoAt >= 4000) {
      a.autoAt = Date.now()
      const s = a.gate.take()
      const next = autoDecide(a.level, s)
      if (next !== a.level && Date.now() - a.levelAt > 6000) {
        a.level = next
        a.levelAt = Date.now()
        startFfmpeg(a)
      }
    }
  }

  function begin(a) {
    if (ffBroken && Date.now() - ffBroken.at > 10 * 60_000) ffBroken = null
    a.mode = ffBroken || fallback ? 'ps' : 'ff'
    if (a.mode === 'ff') startFfmpeg(a)
    else schedule(0)
  }

  async function start(ws, device, { fps, naytto } = {}) {
    const f = parseFps(fps)
    if (active && active.ws !== ws) {
      sendJson(active.ws, { type: 'naytto_tila', tila: 'siirretty', viesti: 'Ohjaus siirtyi toiselle laitteelle.' })
      log(active.device, 'ohjaus siirtyi toiselle laitteelle')
      teardown(active)
      active = null
    }
    const list = await monitors()
    const want = Number.isInteger(Number(naytto)) && naytto !== null && naytto !== '' ? Number(naytto) : (list.find((m) => m.primary)?.i ?? 0)
    const mon = list.some((m) => m.i === want) ? want : (list.find((m) => m.primary)?.i ?? 0)
    if (active && active.ws === ws) {
      const a = active
      a.lastInput = Date.now()
      a.monitors = list
      const changed = a.mon !== mon || a.fps !== f
      a.fps = f
      if (a.mon !== mon) {
        a.mon = mon
        a.focus = null
      }
      if (changed && a.mode === 'ff') startFfmpeg(a)
      else if (a.mode === 'ff' && !a.ff) startFfmpeg(a)
      else if (a.mode === 'ps') schedule(0)
    } else {
      const a = { ws, device, fps: f, mon, timer: 0, lastInput: Date.now(), monitors: list, bounds: null, ff: null, ffFails: 0, level: AUTO_START, levelAt: 0, autoAt: Date.now(), mode: 'ff', focus: null }
      const m = list.find((x) => x.i === mon)
      if (m && m.w) a.bounds = { x: m.x, y: m.y, w: m.w, h: m.h }
      a.gate = makeGate(a)
      a.house = setInterval(() => housekeeping(a), 250)
      active = a
      log(device, `virta alkoi (${f === 'auto' ? 'auto' : `${f} fps`})`)
      const last = notified.get(device) ?? 0
      if (Date.now() - last > 10 * 60_000) {
        notified.set(device, Date.now())
        void Promise.resolve()
          .then(() => notify(`Näyttöohjaus alkoi laitteelta ${device}`))
          .catch(() => {})
      }
      begin(a)
      focusW?.start()
    }
    sendJson(ws, statusMsg(active))
  }

  function teardown(a) {
    clearTimeout(a.timer)
    clearInterval(a.house)
    stopFfmpeg(a)
  }

  function stop(ws, why = 'lopetettu') {
    if (!active || active.ws !== ws) return
    teardown(active)
    log(active.device, `virta loppui (${why})`)
    active = null
    focusW?.stop()
    cap.stop()
    void unlink(file).catch(() => {})
  }

  function ack(ws, seq) {
    if (!active || active.ws !== ws) return
    active.gate.ack(seq)
    if (active.mode === 'ps') {
      const fps = Math.min(PS_MAX_FPS, active.fps === 'auto' ? PS_MAX_FPS : active.fps)
      schedule(Math.max(0, 1000 / fps - 50))
    }
  }

  /** Typing and keys go through the persistent naytto.ps1 (no PowerShell start per key); ohjaus.ps1 as backup. */
  const fastText = async (txt) => {
    const b64 = Buffer.from(txt, 'utf8').toString('base64')
    try {
      const r = await cap.cmd(`teksti ${b64}`, 5000)
      if (r === 'OK') return
      throw new Error(r)
    } catch (err) {
      console.warn('[jarvis] näyttö: suora kirjoitus varatavalla:', err?.message ?? err)
      await ohjaus('unicode', b64)
    }
  }
  const fastKey = async (codes, times) => {
    try {
      const r = await cap.cmd(`nappain ${codes.join(',')} ${times}`, 5000)
      if (r === 'OK') return
      throw new Error(r)
    } catch (err) {
      console.warn('[jarvis] näyttö: näppäin varatavalla:', err?.message ?? err)
      for (let i = 0; i < times; i++) await ohjaus('nappain', codes.join(','))
    }
  }

  /** One control action. Returns an error text or null. */
  function input(ws, device, m) {
    if (!active || active.ws !== ws) return 'Näyttövirta ei ole tällä laitteella. Avaa NÄYTTÖ-sivu uudelleen.'
    active.lastInput = Date.now()
    const b = active.bounds ?? (() => {
      const mm = active.monitors.find((x) => x.i === active.mon)
      return mm && mm.w ? { x: mm.x, y: mm.y, w: mm.w, h: mm.h } : null
    })()
    const t = String(m.tyyppi ?? '')
    let job = null
    let what = t
    switch (t) {
      case 'klikkaa':
      case 'oikea':
      case 'tupla': {
        const p = toScreen(b, m.x, m.y)
        if (!p) return 'Virheellinen kohta.'
        job = () => ohjaus('klikkaa', p[0], p[1], t === 'oikea' ? 'oikea' : 'vasen', t === 'tupla' ? '1' : '0')
        break
      }
      case 'raahaa': {
        const p1 = toScreen(b, m.x1 ?? m.x, m.y1 ?? m.y), p2 = toScreen(b, m.x2, m.y2)
        if (!p1 || !p2) return 'Virheellinen raahaus.'
        job = () => ohjaus('raahaa', p1[0], p1[1], p2[0], p2[1])
        break
      }
      case 'vieritys': {
        const p = toScreen(b, m.x ?? 0.5, m.y ?? 0.5)
        const n = Math.max(-15, Math.min(15, Math.round(Number(m.dy) || 0)))
        if (!p || !n) return null
        job = () => ohjaus('vierita', p[0], p[1], n)
        break
      }
      case 'kirjoita': {
        const txt = String(m.teksti ?? '')
        if (!txt || txt.length > 500) return 'Teksti puuttuu tai on yli 500 merkkiä.'
        job = () => ohjaus('liita', Buffer.from(txt, 'utf8').toString('base64'), '0')
        what = `kirjoita (${txt.length} merkkiä)`
        break
      }
      case 'teksti': {
        // Live typing from the phone keyboard (batches of ~40 ms). Never logged, not even per batch.
        const txt = String(m.teksti ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        if (!txt) return null
        if (txt.length > 500) return 'Liian pitkä teksti kerralla.'
        job = () => fastText(txt)
        what = Date.now() - typedLogAt > 60_000 ? 'kirjoittaa koneelle (näppäimistö)' : ''
        if (what) typedLogAt = Date.now()
        break
      }
      case 'nappain': {
        const k = String(m.nappi ?? '').toLowerCase()
        const codes = SCREEN_KEYS[k]
        if (!codes) return `Näppäin ei ole sallittu: ${String(m.nappi).slice(0, 20)}`
        const times = Math.max(1, Math.min(50, Math.round(Number(m.kerrat) || 1)))
        job = () => fastKey(codes, times)
        what = m.kirjoitus ? '' : `nappain ${k}${times > 1 ? ` ×${times}` : ''}`
        break
      }
      default:
        return 'Tuntematon ohjaus.'
    }
    if (queued > 30) return 'Liian monta ohjausta jonossa — odota hetki.'
    if (what) log(device, what)
    queued++
    inputQueue = inputQueue
      .then(job)
      .catch((err) => {
        console.warn('[jarvis] näyttö: ohjaus epäonnistui:', err?.message ?? err)
        sendJson(ws, { type: 'naytto_tila', tila: 'kaynnissa', viesti: `Ohjaus ei onnistunut: ${String(err?.message ?? err).slice(0, 120)}` })
      })
      .finally(() => {
        queued--
        // a fresh frame right after the action (perustila; ffmpeg streams continuously)
        if (active && active.ws === ws && active.mode === 'ps' && !active.gate.waiting) schedule(120)
      })
    return null
  }

  return {
    start,
    stop,
    ack,
    input,
    onClose: (ws) => stop(ws, 'yhteys sulkeutui'),
    activeDevice: () => active?.device ?? null,
    /** tests / diagnostics */
    _state: () => (active ? { mode: active.mode, fps: active.fps, level: active.level, seq: active.gate.seq, ff: Boolean(active.ff) } : null),
  }
}
