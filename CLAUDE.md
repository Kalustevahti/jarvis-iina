# CLAUDE.md – ohje Claude Codelle

Tämä on JARVIS: suomenkielinen puheavustaja. Käyttäjä on Iina. Hän ajaa tätä Macilla.

## Rakenne
- `src/` React 19 + Vite + TypeScript + Three.js (käyttöliittymä). `src/ui/Desk.tsx` on pääsovellus.
- `bridge/` Node ESM: `server.mjs` (WebSocket 127.0.0.1:8787, järjestelmäprompti, työkalurekisteri) + yksi moduuli per ominaisuus.
- `bridge/ps/*.ps1` Windows-only PowerShell-apurit. `scripts/start.mjs` käynnistää sillan ja Viten (`npm start`; `-- --writes` sallii oikeat toiminnot).
- Asetukset/salaisuudet `~/.jarvis/` (ei repossa). Muisti `muisti/` (ei repossa, luodaan ajossa).

## Säännöt
1. Lue tiedosto ennen kuin muutat sitä. Älä arvaa.
2. Pienet muutokset; aja `node --check <tiedosto>` ja tarvittaessa `npm run build`.
3. Käyttäjälle näkyvät tekstit suomeksi, koodi ja kommentit englanniksi. Vastaa käyttäjälle suomeksi.
4. Älä lisää työkaluja, jotka ajavat vapaata komentoriviä. Komennot kiinteitä.
5. Älä koskaan kirjoita salaisuuksia repoon. Älä tulosta tokeneita lokiin.
6. Virta (sammutus/lepotila), viestien lähetys ja CRM-kirjaukset vaativat käyttäjän vahvistuksen; älä heikennä tätä (`turva.mjs`, `decideTool`).
7. Mac-portaus: lisää `process.platform === 'darwin'` -haara; Windows-haaraa ei poisteta.
8. Mainitse etukäteen uusi API-avain, maksullinen palvelu tai turvariski.
9. Testit: `node --test bridge/jarvis.test.mjs` (kun `npm install` on tehty).

## Tila
Macilla ajamaton. Katso `docs/02_MAC_PORTTAUS.md` ja `docs/03_PERSONALISOINTI.md`.
