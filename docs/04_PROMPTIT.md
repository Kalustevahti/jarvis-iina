# 04 – Valmiit promptit

**A) Claude Code** (Terminal: `cd ~/JARVIS && claude`) – promptit 1–6.
**B) Claude-projektisi** (claude.ai) – liitä `06_PROJEKTIN_OHJEET.md` projektin ohjeisiin, sitten promptit 7–8.

Yleissääntö kaikkiin: *"Älä arvaa tiedostojen sisältöä, lue ne ensin. Tee pieni muutos kerrallaan. Kerro miten testaan."*

---

### 1. Personalisointi
```
Lue CLAUDE.md ja docs/03_PERSONALISOINTI.md. Tämä on Eliaksen JARVISin siivottu kopio ja nyt minun (Iina) oma versioni.
Tee seuraavaa, yksi asia kerrallaan, ja näytä diff ennen kuin kirjoitat:
1. Listaa kaikki kohdat joissa nimi "Elias" esiintyy ja ryhmittele (järjestelmäprompti, ilmoitukset, muisti, testit).
2. Ehdota korvaus minun nimelläni suomen taivutus huomioiden. Odota hyväksyntäni.
3. Tee korvaus, aja `node --check` kaikille .mjs-tiedostoille ja `npm run build`.
4. Kerro mitkä yritys-/CRM-moduulit voi kytkeä pois ja kysy mitä haluan pitää.
Älä poista tiedostoja. Älä koske ~/.jarvis-kansioon.
```

### 2. Ensikäynnistys ja diagnoosi
```
Aja `npm install`, `npm run setup` ja `npm start` ja kerro tulos. Jos jokin kaatuu, lue virhe, löydä syy koodista
ja ehdota pienintä korjausta. Mac-kohtaiset ("Vain Windows-koneella") ovat odotettuja: listaa ne, älä korjaa vielä.
Käynnistä ilman --writes.
```

### 3. Telegram-botti ja muistutukset
```
Auta minua ottamaan Telegram käyttöön. Opasta askel askeleelta:
1. BotFatherissa uusi botti → token.
2. Selvitä minun chat-id (kerro miten, esim. @userinfobot).
3. Luo ~/.jarvis/telegram.txt: rivi 1 token, rivi 2 minun chat-id (ÄLÄ tulosta tokenia chattiin tai lokiin), chmod 600.
4. Lue bridge/telegram.mjs ja vahvista omin silmin, että vain tuo chat-id voi komentaa.
5. Testaa: lähetä botille "muistuta minua 2 minuutin päästä testistä" ja varmista että muistutus tulee (ajastin.mjs).
Kerro jokaisen vaiheen jälkeen mitä tein itse ja mitä sinä.
```

### 4. Mac-portaus (koneen ohjaus)
```
Lue docs/02_MAC_PORTTAUS.md, bridge/kone.mjs ja bridge/ps/*.ps1. Portaa macOS:lle vaiheittain tässä järjestyksessä:
kone_tila → kone_kuvakaappaus (screencapture) → kone_avaa (open -a, vain sallittujen lista) → kone_lukitse → virta.
Säännöt: komennot kiinteitä, ei vapaata shell-työkalua; säilytä esikatselu+vahvistus+60 s peruutus virralle; lisää
`process.platform === 'darwin'` -haarat ja testit; kerro mitkä macOS-oikeudet (Screen Recording, Accessibility) tarvitaan.
Tee yksi vaihe, kerro testi, odota että kerron sen onnistuneen.
```

### 5. Turvatarkistus ennen käyttöönottoa
```
Tee turvakatselmointi: (1) bridge/turva.mjs ja decideTool-portti server.mjs:ssä, (2) Telegramin omistajatarkistus,
(3) mitkä tiedostot lukevat/kirjoittavat ~/.jarvis ja onko oikeudet kunnossa Macilla, (4) onko missään kovakoodattuja
salaisuuksia (grep), (5) mitä työkaluja malli voi kutsua ilman vahvistusta. Raportoi löydökset vakavuusjärjestyksessä.
Älä muuta mitään ennen kuin olen hyväksynyt.
```

### 6. Automaattinen käynnistys (vasta kun muu toimii)
```
Tee launchd LaunchAgent (~/Library/LaunchAgents/fi.jarvis.plist), joka käynnistää `npm start` (ilman --writes) kirjautuessa
ja kirjaa lokin ~/Library/Logs/jarvis.log. Näytä plist ennen kirjoitusta. Kerro miten ladataan (launchctl) ja poistetaan.
```

### 7. Claude-projektille: opi koodi
```
Käy läpi projektiin liitetty JARVIS-repo. Tee minulle yhden sivun kartta suomeksi: mitä moduuleja on, mitkä ovat
alustariippumattomia, mitkä Windows-only, ja missä järjestyksessä ottaisit ne käyttöön Macilla. Ei koodia, vain kartta.
```

### 8. Claude-projektille: yksi uusi ominaisuus kerrallaan
```
Haluan JARVISiin ominaisuuden: [kuvaile]. Lue ensin relevantit tiedostot (pyydä minua liittämään ne jos et näe niitä).
Anna valmiit tiedostot tai tarkat find/replace-lohkot, kerro mihin tiedostoon ne menevät, miten testaan ja miten
käynnistän uudelleen. Mainitse etukäteen jos tarvitaan uusi API-avain, maksullinen palvelu tai se on turvariski.
```
