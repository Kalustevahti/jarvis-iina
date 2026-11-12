"""JARVIS: Roborock-imurin apuri (python-roborock). Kutsutaan bridge/imuri.mjs:stä, vastaus JSON:ina stdoutiin.

Käyttö:
  python roborock_apuri.py login <sähköposti> [koodi]   kirjautuminen (koodi sähköpostiin; ilman koodia kysyy sen) → ~/.jarvis/roborock.json
  python roborock_apuri.py pyyda <sähköposti>           vaihe 1 ilman kysymyksiä: lähettää koodin sähköpostiin
  python roborock_apuri.py laitteet               tilin imurit
  python roborock_apuri.py tila                   tila + akku + kulutusosat
  python roborock_apuri.py huoneet                huoneet (segment id + nimi)
  python roborock_apuri.py aloita [id ...]        koko koti tai huoneet
  python roborock_apuri.py tauko | jatka | seis | kotiin | etsi | tyhjenna
  python roborock_apuri.py teho <quiet|balanced|turbo|max|max_plus>

Yhteys: python-roborock yhdistää ensisijaisesti paikallisesti (LAN), muuten Roborockin MQTT-pilven kautta.
Kirjautumistiedot (rriot-token) ovat JSON:ina ~/.jarvis/roborock.json — malli ei lue tiedostoa, vain tämä apuri.
"""

from __future__ import annotations

import asyncio
import json
import logging
import pathlib
import sys
import time

logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
for noisy in ("roborock", "aiomqtt", "paho"):
    logging.getLogger(noisy).setLevel(logging.ERROR)

CFG_DIR = pathlib.Path.home() / ".jarvis"
CFG = CFG_DIR / "roborock.json"
CACHE = CFG_DIR / "roborock_cache.pkl"
# Roborock sitoo sähköpostikoodin pyytäjän laitetunnisteeseen (header_clientid). Kirjasto arpoo sen joka kerta,
# joten vaihe 1 (pyyda) tallentaa sen tähän ja vaihe 2 (login koodilla) käyttää samaa. Poistetaan onnistuneen kirjautumisen jälkeen.
LOGIN_STATE = CFG_DIR / "roborock_kirjautuminen.json"

FAN = {"quiet": 101, "hiljainen": 101, "balanced": 102, "normaali": 102, "turbo": 103, "max": 104, "maksimi": 104, "max_plus": 108, "gentle": 105}
STATE_FI = {
    "starting": "käynnistyy", "charger_disconnected": "irti laturista", "idle": "valmiustilassa", "remote_control_active": "kauko-ohjaus",
    "cleaning": "siivoaa", "returning_home": "palaa telakkaan", "manual_mode": "manuaalitila", "charging": "latautuu telakassa",
    "charging_problem": "latausongelma", "paused": "tauolla", "spot_cleaning": "pistesiivous", "error": "VIRHE", "shutting_down": "sammuu",
    "updating": "päivittyy", "docking": "telakoituu", "going_to_target": "menee kohteeseen", "zoned_cleaning": "siivoaa aluetta",
    "segment_cleaning": "siivoaa huoneita", "emptying_the_bin": "tyhjentää säiliötä", "mapping": "kartoittaa", "charging_complete": "ladattu, telakassa",
    "device_offline": "ei verkossa", "locked": "lukittu",
}


def out(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def load_cfg() -> dict:
    try:
        return json.loads(CFG.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        raise SystemExit(json.dumps({"ok": False, "error": "Imuria ei ole yhdistetty: aja tyokalut\\asenna_imuri.bat."}, ensure_ascii=False))


def save_cfg(cfg: dict) -> None:
    CFG_DIR.mkdir(parents=True, exist_ok=True)
    CFG.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")


async def request_code(email: str) -> None:
    """Vaihe 1 (ei kysy mitään): pyytää kirjautumiskoodin sähköpostiin."""
    from roborock.web_api import RoborockApiClient

    api = RoborockApiClient(username=email)
    await api.request_code_v4()  # v4 = nykyinen sovelluksen kirjautuminen; kirjasto palaa v1:een itse, jos maata ei löydy
    CFG_DIR.mkdir(parents=True, exist_ok=True)
    LOGIN_STATE.write_text(json.dumps({"email": email, "device_identifier": api._device_identifier, "base_url": await api.base_url, "at": time.time()}), encoding="utf-8")
    out({"ok": True, "sent": email})


async def login(email: str, code: str | None = None) -> None:
    from roborock.web_api import RoborockApiClient

    api = RoborockApiClient(username=email)
    if code is not None:
        # Sama laitetunniste kuin koodia pyydettäessä (vaihe 1), muuten Roborock hylkää koodin.
        try:
            st = json.loads(LOGIN_STATE.read_text(encoding="utf-8"))
            if st.get("email", "").lower() == email.lower() and time.time() - float(st.get("at", 0)) < 20 * 60:
                api._device_identifier = st["device_identifier"]
            else:
                raise RuntimeError("Koodi on yli 15 min vanha tai pyydetty toiselle osoitteelle — aja imuri_vaihe1.bat uudelleen.")
        except FileNotFoundError:
            raise RuntimeError("Koodia ei ole pyydetty tällä koneella — aja ensin imuri_vaihe1.bat.")
    if code is None:
        sys.stderr.write("Lähetetään kirjautumiskoodi sähköpostiin...\n")
        await api.request_code_v4()
        sys.stderr.write(f"Koodi lähetetty osoitteeseen {email}.\nSyötä sähköpostiin tullut koodi: ")
        sys.stderr.flush()
        code = sys.stdin.readline().strip()
    from roborock.exceptions import RoborockInvalidCode

    try:
        user_data = await api.code_login_v4(code)
    except RoborockInvalidCode:
        # Vanha (v1) koodi? Kokeillaan kerran vanhalla rajapinnalla ennen kuin luovutetaan.
        user_data = await api.code_login(code)
    base_url = await api.base_url
    old = {}
    try:
        old = json.loads(CFG.read_text(encoding="utf-8-sig"))
    except Exception:
        pass
    cfg = {**old, "username": email, "user_data": user_data.as_dict(), "base_url": base_url}
    save_cfg(cfg)
    try:
        LOGIN_STATE.unlink()
    except FileNotFoundError:
        pass
    # Haetaan laitteet heti ja talletetaan tiedostoon, jotta asennusskripti voi valita imurin ilman stdout-kaappausta.
    devices = await list_devices(cfg)
    save_cfg({**cfg, "devices": devices})
    out({"ok": True, "devices": devices})


def user_params(cfg: dict):
    from roborock.data import UserData
    from roborock.devices.device_manager import UserParams

    return UserParams(username=cfg["username"], user_data=UserData.from_dict(cfg["user_data"]), base_url=cfg.get("base_url"))


async def list_devices(cfg: dict) -> list[dict]:
    from roborock.devices.device_manager import create_device_manager

    mgr = await create_device_manager(user_params(cfg), prefer_cache=False)
    try:
        devs = await mgr.get_devices()
        return [
            {"duid": d.duid, "name": d.name, "model": d.product.model, "v1": d.v1_properties is not None, "online": bool(d.device_info.online)}
            for d in devs
        ]
    finally:
        await mgr.close()


async def with_device(cfg: dict):
    """Avaa yhteyden valittuun imuriin. Palauttaa (manager, device)."""
    from roborock.devices.device_manager import create_device_manager
    from roborock.devices.file_cache import FileCache

    cache = FileCache(CACHE)
    mgr = await create_device_manager(user_params(cfg), cache=cache)
    devs = await mgr.get_devices()
    want = cfg.get("duid")
    dev = next((d for d in devs if d.duid == want), None) if want else None
    if dev is None:
        dev = next((d for d in devs if d.v1_properties is not None), None)
    if dev is None:
        await mgr.close()
        raise RuntimeError("Tililtä ei löytynyt tuettua imuria (v1).")
    if dev.v1_properties is None:
        await mgr.close()
        raise RuntimeError(f"Imuri {dev.name} ({dev.product.model}) ei käytä v1-protokollaa; tämä apuri ei tue sitä vielä.")
    # Odotetaan yhteyttä hetki (paikallinen tai MQTT).
    for _ in range(40):
        if dev.is_connected:
            break
        await asyncio.sleep(0.25)
    return mgr, dev, cache


def hours(sec):
    return None if sec is None else round(sec / 3600, 1)


async def status(dev) -> dict:
    v1 = dev.v1_properties
    await v1.status.refresh()
    st = v1.status
    cons = None
    try:
        await v1.consumables.refresh()
        c = v1.consumables
        cons = {
            "paaharja_h": hours(c.main_brush_time_left),
            "sivuharja_h": hours(c.side_brush_time_left),
            "suodatin_h": hours(c.filter_time_left),
            "anturit_h": hours(c.sensor_time_left),
            "polysailio_tyhjennyksia_jaljella": c.dust_collection_time_left,
        }
    except Exception as err:  # kulutusosat eivät ole kriittisiä
        cons = {"virhe": str(err)[:120]}
    state = getattr(st.state, "name", None) or str(st.state)
    err = getattr(st.error_code, "name", None) or (str(st.error_code) if st.error_code else None)
    last = None
    try:
        await v1.clean_summary.refresh()
        rec = v1.clean_summary.last_clean_record
        if rec is not None:
            last = {"alku": rec.begin, "kesto_min": round((rec.duration or 0) / 60), "ala_m2": round((rec.area or 0) / 1_000_000, 1)}
    except Exception:
        pass
    return {
        "nimi": dev.name,
        "malli": dev.product.model,
        "yhteys": "paikallinen" if dev.is_local_connected else ("pilvi" if dev.is_connected else "ei yhteyttä"),
        "tila": state,
        "tila_fi": STATE_FI.get(state, state),
        "akku": st.battery,
        "virhe": None if err in (None, "none") else err,
        "teho": st.fan_speed_name,
        "siivoaa": bool(st.in_cleaning),
        "siivous_min": round((st.clean_time or 0) / 60),
        "siivous_m2": round((st.clean_area or 0) / 1_000_000, 1),
        "kulutusosat": cons,
        "viimeisin": last,
    }


async def rooms(dev) -> list[dict]:
    v1 = dev.v1_properties
    await v1.rooms.refresh()
    return [{"id": r.segment_id, "nimi": r.name} for r in (v1.rooms.rooms or [])]


async def main(argv: list[str]) -> None:
    if not argv:
        raise SystemExit(__doc__)
    cmd, *args = argv
    if cmd == "login":
        if not args:
            raise SystemExit("login <sähköposti> [koodi]")
        await login(args[0], args[1] if len(args) > 1 else None)
        return
    if cmd == "pyyda":
        if not args:
            raise SystemExit("pyyda <sähköposti>")
        await request_code(args[0])
        return
    cfg = load_cfg()
    if cmd == "laitteet":
        out({"ok": True, "devices": await list_devices(cfg)})
        return
    try:
        mgr, dev, cache = await with_device(cfg)
    except (EOFError, __import__("pickle").UnpicklingError):
        # Välimuisti (roborock_cache.pkl) jäi tyhjäksi/rikki (esim. kaksi ajoa yhtä aikaa) → poistetaan ja yritetään kerran uudelleen.
        try:
            CACHE.unlink()
        except FileNotFoundError:
            pass
        mgr, dev, cache = await with_device(cfg)
    try:
        from roborock import RoborockCommand

        send = dev.v1_properties.command.send
        if cmd == "tila":
            out({"ok": True, **(await status(dev))})
        elif cmd == "huoneet":
            out({"ok": True, "huoneet": await rooms(dev)})
        elif cmd == "aloita":
            ids = [int(a) for a in args if a.strip().lstrip("-").isdigit()]
            if ids:
                await send(RoborockCommand.APP_SEGMENT_CLEAN, {"segments": ids, "repeat": 1})
            else:
                await send(RoborockCommand.APP_START)
            await asyncio.sleep(2)
            out({"ok": True, "huoneet": ids, **(await status(dev))})
        elif cmd == "tauko":
            await send(RoborockCommand.APP_PAUSE)
            out({"ok": True})
        elif cmd == "jatka":
            # Huonesiivouksen jatko on oma komentonsa; koko kodin siivous jatkuu app_startilla.
            await dev.v1_properties.status.refresh()
            st = dev.v1_properties.status
            if getattr(st.in_cleaning, "value", st.in_cleaning) == 3:
                await send(RoborockCommand.RESUME_SEGMENT_CLEAN)
            else:
                await send(RoborockCommand.APP_START)
            out({"ok": True})
        elif cmd == "seis":
            await send(RoborockCommand.APP_STOP)
            out({"ok": True})
        elif cmd == "kotiin":
            await send(RoborockCommand.APP_CHARGE)
            out({"ok": True})
        elif cmd == "etsi":
            await send(RoborockCommand.FIND_ME)
            out({"ok": True})
        elif cmd == "tyhjenna":
            await send(RoborockCommand.APP_START_COLLECT_DUST)
            out({"ok": True})
        elif cmd == "teho":
            key = (args[0] if args else "").lower()
            code = FAN.get(key) or (int(key) if key.isdigit() else None)
            if not code:
                raise RuntimeError("teho: quiet | balanced | turbo | max | max_plus")
            await send(RoborockCommand.SET_CUSTOM_MODE, [code])
            await asyncio.sleep(1)
            await dev.v1_properties.status.refresh()
            out({"ok": True, "teho": dev.v1_properties.status.fan_speed_name})
        else:
            raise RuntimeError(f"Tuntematon komento {cmd}")
    finally:
        try:
            await cache.flush()
        except Exception:
            pass
        await mgr.close()


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    t0 = time.time()
    # Windowsin oletussilmukka (Proactor) ei tue add_reader/add_writer-kutsuja, joita MQTT (aiomqtt/paho) tarvitsee → NotImplementedError.
    if sys.platform == "win32" and hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(asyncio.wait_for(main(sys.argv[1:]), timeout=90))
    except SystemExit:
        raise
    except Exception as e:  # kaikki virheet JSON:ina, jotta Node osaa näyttää ne
        out({"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}", "s": round(time.time() - t0, 1)})
        sys.exit(1)
