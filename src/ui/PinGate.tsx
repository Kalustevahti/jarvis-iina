/**
 * PIN-portti (9.11.2026): koko käyttöliittymä (myös localhost, kokousikkuna, harjoitus, puhelin) näkyy vasta,
 * kun bridge on hyväksynyt tämän laitteen tunnisteen tai PIN:n. Ennen sitä sivulla ei ole muuta kuin tämä ruutu.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { authState, submitPin, watchAuth, type AuthState } from '../lib/bridge'
import { usingBridge, warm } from '../lib/brain'
import './pin.css'

export function PinGate({ children }: { children: ReactNode }) {
  const [a, setA] = useState<AuthState>(authState)
  const [unlocked, setUnlocked] = useState(!usingBridge)
  useEffect(() => watchAuth(setA), [])
  useEffect(() => {
    if (a.tila === 'ok') setUnlocked(true)
    // Logged out while the page was open (/laitteet pois or Kirjaudu ulos): start clean at the PIN screen.
    else if (unlocked && a.tila === 'pin') window.location.reload()
  }, [a.tila, unlocked])
  // Drive the connection until logged in (the app itself is not mounted yet).
  useEffect(() => {
    if (!usingBridge) return
    let stop = false
    let t = 0
    const tryNow = () => {
      if (stop) return
      warm().catch(() => {
        if (!stop) t = window.setTimeout(tryNow, 3000)
      })
    }
    tryNow()
    return () => {
      stop = true
      window.clearTimeout(t)
    }
  }, [])
  return unlocked ? <>{children}</> : <PinScreen a={a} />
}

function PinScreen({ a }: { a: AuthState }) {
  const [d, setD] = useState('')
  const [shake, setShake] = useState(0)
  const [lockLeft, setLockLeft] = useState(0)
  const ready = a.tila === 'pin' && !(a.syy === 'lukittu' && lockLeft > 0) && a.syy !== 'ei_pinia'

  useEffect(() => {
    if (a.tila === 'pin' && (a.syy === 'vaara' || a.syy === 'lukittu')) {
      setD('')
      setShake((n) => n + 1)
      try {
        navigator.vibrate?.(120)
      } catch {
        /* ok */
      }
    }
    if (a.syy === 'lukittu' && a.lukittuMs) setLockLeft(Math.ceil(a.lukittuMs / 1000))
  }, [a])
  useEffect(() => {
    if (lockLeft <= 0) return
    const t = window.setTimeout(() => setLockLeft((s) => s - 1), 1000)
    return () => window.clearTimeout(t)
  }, [lockLeft])

  const press = (k: string) => {
    if (!ready) return
    if (k === '⌫') return setD((x) => x.slice(0, -1))
    if (k === 'OK') {
      if (d.length >= 4) submitPin(d)
      return
    }
    setD((x) => (x.length < 8 ? x + k : x))
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key)
      else if (e.key === 'Backspace') press('⌫')
      else if (e.key === 'Enter') press('OK')
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  const msg =
    a.tila === 'yhdistaa'
      ? 'YHDISTETÄÄN JARVISIIN…'
      : a.tila === 'tarkistaa'
        ? 'TARKISTETAAN…'
        : a.syy === 'ei_pinia'
          ? 'PIN-ASETUS PUUTTUU — PÄÄSY ESTETTY'
          : a.syy === 'lukittu' && lockLeft > 0
            ? `LUKITTU 15 MIN · ${Math.floor(lockLeft / 60)}:${String(lockLeft % 60).padStart(2, '0')}`
            : a.syy === 'vaara'
              ? `VÄÄRÄ PIN${a.jaljella ? ` · ${a.jaljella} YRITYSTÄ JÄLJELLÄ` : ''}`
              : a.syy === 'ulos'
                ? 'KIRJAUDUTTU ULOS · SYÖTÄ PIN'
                : 'SYÖTÄ PIN'
  const bad = a.syy === 'vaara' || a.syy === 'lukittu' || a.syy === 'ei_pinia'
  return (
    <div className="pg-root" role="dialog" aria-label="JARVIS-tunnistautuminen">
      <div className="pg-box">
        <div className="pg-core" aria-hidden="true" />
        <div className="pg-brand">JARVIS</div>
        <div className="pg-sub">TUNNISTAUTUMINEN</div>
        <div key={shake} className={`pg-dots${shake ? ' shake' : ''}`} aria-label={`${d.length} numeroa syötetty`}>
          {Array.from({ length: Math.max(4, d.length) }, (_, i) => (
            <i key={i} className={i < d.length ? 'on' : ''} />
          ))}
        </div>
        <div className={`pg-msg${bad ? ' bad' : ''}`} aria-live="polite">
          {msg}
        </div>
        {a.syy === 'ei_pinia' ? <p className="pg-note">Aja koneella tyokalut\vaihda_pin.bat ja lataa sivu uudelleen.</p> : null}
        <div className="pg-pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'].map((k) => (
            <button key={k} className={k === 'OK' ? 'ok' : k === '⌫' ? 'bs' : ''} disabled={!ready || (k === 'OK' && d.length < 4)} onClick={() => press(k)} aria-label={k === '⌫' ? 'Poista' : k === 'OK' ? 'Kirjaudu' : k}>
              {k}
            </button>
          ))}
        </div>
        <div className="pg-foot">4–8 NUMEROA · LAITE MUISTETAAN 30 PV</div>
      </div>
    </div>
  )
}
