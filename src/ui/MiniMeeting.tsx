/**
 * Pieni vinkki-ikkuna (kokoustilan "muistilappu").
 *
 * Avataan osoitteella ?kokous=...&auto=1&mini=1 omana pienenä Edge-ikkunana,
 * jonka bridge nostaa näytön oikeaan yläkulmaan aina päällimmäiseksi. Näyttää
 * vain kokoustilan bladen (SEURAAVAKSI / VASTAUSEHDOTUS / HUOMIOT …) ja tilan.
 * Mikrofoni ja analyysi pyörivät tässä samassa sivussa kuten isossakin
 * käyttöliittymässä — vain ulkoasu on riisuttu.
 */
import { useStore } from '../store'
import { sanitisePanelHtml } from './sanitise'

const PHASE: Record<string, string> = {
  offline: 'Käynnistyy…',
  boot: 'Käynnistyy…',
  dormant: 'Valmis',
  waking: 'Kuuntelen',
  listening: 'Kuuntelen',
  thinking: 'Mietin',
  tooling: 'Työn alla',
  speaking: 'Puhun',
}

export function MiniMeeting({ onStart, onAudio, audioOn }: { onStart: () => void; onAudio: () => void; audioOn: boolean }) {
  const phase = useStore((s) => s.phase)
  const caption = useStore((s) => s.caption)
  const error = useStore((s) => s.error)
  const blade = useStore((s) => s.blades.find((b) => b.id === 'kokous-vinkit'))

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0b1016',
        color: '#e6edf3',
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        fontSize: 15,
        lineHeight: 1.45,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: '1px solid #223',
          fontSize: 12,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: '#8fb3ff',
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 8, background: phase === 'listening' ? '#3ddc84' : '#8fb3ff' }} />
        <span>JARVIS · {blade?.title ?? 'KOKOUS'}</span>
        <span style={{ marginLeft: 'auto', color: '#7a8699' }}>{PHASE[phase] ?? phase}</span>
        {phase !== 'offline' && (
          <button
            type="button"
            onClick={onAudio}
            title="Jaa puhelun ääni JARVISille (K): valitse Koko näyttö ja ruksi Jaa järjestelmän ääni"
            style={{
              font: 'inherit',
              fontSize: 11,
              letterSpacing: '.04em',
              textTransform: 'none',
              padding: '3px 8px',
              borderRadius: 6,
              border: `1px solid ${audioOn ? '#3ddc84' : '#ffd166'}`,
              background: audioOn ? 'rgba(61,220,132,.12)' : 'rgba(255,209,102,.12)',
              color: audioOn ? '#3ddc84' : '#ffd166',
              cursor: 'pointer',
            }}
          >
            {audioOn ? 'Puhelun ääni kuuluu' : 'Jaa puhelun ääni'}
          </button>
        )}
      </div>
      {phase !== 'offline' && !audioOn && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid #223', fontSize: 12, color: '#ffd166' }}>
          Puhelu kuulokkeissa? Paina "Jaa puhelun ääni", valitse Koko näyttö ja ruksi "Jaa järjestelmän ääni" — muuten JARVIS kuulee vain sinut.
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }} className="mini-tips">
        {phase === 'offline' ? (
          <button
            type="button"
            onClick={onStart}
            style={{ font: 'inherit', padding: '10px 16px', borderRadius: 8, border: '1px solid #8fb3ff', background: 'transparent', color: '#e6edf3', cursor: 'pointer' }}
          >
            Käynnistä kuuntelu
          </button>
        ) : blade?.html ? (
          <div dangerouslySetInnerHTML={{ __html: sanitisePanelHtml(blade.html) }} />
        ) : (
          <div style={{ color: '#7a8699' }}>Kuuntelen. Ensimmäiset vinkit tulevat, kun keskustelua on kertynyt noin minuutti.</div>
        )}
      </div>
      {(caption || error) && (
        <div style={{ padding: '8px 12px', borderTop: '1px solid #223', fontSize: 12, color: error ? '#ff8a80' : '#9fb0c4' }}>{error || caption}</div>
      )}
      <style>{`
        .mini-tips .hud-note { font-size: 15px; margin: 2px 0; }
        .mini-tips .hud-hot { color: #ffd166; font-weight: 600; letter-spacing: .06em; margin-top: 12px; }
        .mini-tips .hud-dim { color: #8fb3ff; font-weight: 600; letter-spacing: .06em; margin-top: 12px; }
        .mini-tips .hud-rows { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 8px; }
        .mini-tips .hud-row { display: flex; gap: 8px; align-items: flex-start; }
        .mini-tips .hud-idx { color: #ffd166; }
        .mini-tips .hud-label { font-size: 15px; }
        .mini-tips .hud-sub { color: #7a8699; font-size: 12px; margin-top: 8px; }
      `}</style>
    </div>
  )
}
