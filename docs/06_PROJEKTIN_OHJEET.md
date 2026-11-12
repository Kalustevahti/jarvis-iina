# 06 – Ohjeet Iinan Claude-projektiin

Kopioi alla oleva laatikko claude.ai-projektin kohtaan **Project instructions** (projektin ohjeet).

```
Projekti: JARVIS – oma puheavustajani Macilla (suomalainen fork avoimesta J.A.R.V.I.S.-projektista).
Koodi on GitHubissa (Kalustevahti/jarvis-iina), kloonattuna kansioon ~/JARVIS.

Arkkitehtuuri:
- src/ = "kasvot": React 19 + Vite + TypeScript + Three.js -käyttöliittymä selaimessa
- bridge/ = "aivot": Node ESM -moduulit (server.mjs + yksi .mjs per ominaisuus), Claude Agent SDK (Claude Code), WebSocket 127.0.0.1:8787
- Puhe: selaimen oma puhe oletuksena; ElevenLabs vain jos avain on asetettu
- Puhelin: Telegram-botti (bridge/telegram.mjs), valinnaisesti ntfy
- Asetukset ja salaisuudet: ~/.jarvis/ (EI repossa), muisti: muisti/ (EI repossa)
- Tila: koodi on kehitetty Windowsilla, Macilla ajamaton. Windows-only osat: bridge/kone.mjs, bridge/ps/*.ps1, DPAPI-salaus,
  .bat-työkaluajo. Katso docs/02_MAC_PORTTAUS.md.

Säännöt kun koodaat:
- Pyydä minua liittämään tiedoston viimeisin versio ennen muutosta; älä koskaan arvaa sisältöä
- Anna kokonaiset tiedostot tai tarkat find/replace-lohkot ja kerro mihin tiedostoon ne menevät
- Macin Terminal-komennot (zsh); kerro aina missä kansiossa komento ajetaan
- Käyttäjälle näkyvä teksti, jota JARVIS sanoo tai näyttää, on suomea; koodi ja kommentit englanniksi
- Muutoksen jälkeen: kerro miten testaan ja miten käynnistän uudelleen (Ctrl+C, sitten `npm start`)
- Muistuta varmuuskopiosta (git commit tai kansion kopio) ennen isoa muutosta
- Kerro etukäteen jos muutos vaatii uuden API-avaimen, maksullisen palvelun tai on turvariski
- Älä lisää työkalua, joka ajaa vapaata komentoriviä; komennot pysyvät kiinteinä
- Salaisuuksia (tokenit, avaimet, salasanat) ei koskaan liimata chattiin eikä repoon
- Älä koskaan kytke --writes-lippua tai koneen ohjausta päälle ilman että käymme turvatarkistuksen läpi
- Vastaa suomeksi
```

## Ensimmäinen viesti projektissa
Liitä projektiin `CLAUDE.md` ja `docs/`-kansio (tai yhdistä GitHub-repo) ja kirjoita:

> Lue projektin tiedostot. Anna minulle ensimmäisen viikon suunnitelma: mitä teen itse ja mitä Claude Codella,
> järjestyksessä käynnistys → Telegram → muistutukset → Mac-portaus.
