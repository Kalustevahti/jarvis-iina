/** HUD icon set (stroke icons from the approved prototype, 24×24 viewBox). */
const P: Record<string, string> = {
  home: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-5h4v5',
  air: 'M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h7',
  tv: 'M3 5h18v12H3zM8 21h8M12 17v4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  core: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
  case: 'M3 7h18v13H3zM9 7V4h6v3M3 12h18',
  target: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
  meet: 'M4 5h16v10H8l-4 4z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3M5 11a7 7 0 0 0 14 0M12 18v3',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  snow: 'M12 2v20M3.5 7l17 10M20.5 7l-17 10M9 4l3 2 3-2M9 20l3-2 3 2',
  fan: 'M12 12c0-4 1-8 4-8s2 5-4 8zM12 12c4 0 8 1 8 4s-5 2-8-4zM12 12c0 4-1 8-4 8s-2-5 4-8zM12 12c-4 0-8-1-8-4s5-2 8 4z',
  drop: 'M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z',
  auto: 'M4 12a8 8 0 0 1 14-5M20 12a8 8 0 0 1-14 5M18 3v4h-4M6 21v-4h4',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  prev: 'M18 5L8 12l10 7zM6 5v14',
  next: 'M6 5l10 7-10 7zM18 5v14',
  vol: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  cam: 'M3 7h4l2-3h6l2 3h4v12H3zM12 10a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  bot: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M7 9h10M12 13a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  back: 'M15 5l-7 7 7 7',
  menu: 'M4 6h16M4 12h16M4 18h16',
  send: 'M4 12l16-8-6 16-2-6z',
  search: 'M10 4a6 6 0 1 0 0 12a6 6 0 1 0 0-12M15 15l5 5',
  moon: 'M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z',
  film: 'M3 5h18v14H3zM3 9h18M3 15h18M7 5v14M17 5v14',
  door: 'M6 3h12v18H6zM14 12h.5M3 21h18',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4M10 7.5l4.5 2.6-2 .5-1 1.9z',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  key: 'M4 7h16v10H4zM7 10h1M10 10h1M13 10h1M16 10h1M8 14h8',
}

export function Ic({ n, cls = 'i' }: { n: string; cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 24 24" aria-hidden="true">
      <path d={P[n] ?? P.core} />
    </svg>
  )
}
