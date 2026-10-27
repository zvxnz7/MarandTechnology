#!/usr/bin/env python3
"""Build a private finishing-history JSON package from the 2026 intake workbook."""

import argparse
import hashlib
import io
import json
import re
import unicodedata
import zipfile
from datetime import date, datetime
from pathlib import Path

try:
    import openpyxl
except ImportError as error:
    raise SystemExit("Brak openpyxl. Zainstaluj go poleceniem: python -m pip install openpyxl") from error


FORMAT = "marand-finishing-import-v1"
TARGET_SCHEMA = 11
PERIODS = {"WRZESIEN": "2026-09", "PAZDZIERNIK": "2026-10"}


def plain(value):
    if value is None:
        return ""
    return str(value).strip()


def normalized(value):
    value = unicodedata.normalize("NFKD", plain(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", value).strip().upper()


def empty(value):
    return not plain(value) or plain(value) in {"-", "—", "#N/A", "#DIV/0!", "#VALUE!"}


def scalar(value):
    if empty(value):
        return None
    if isinstance(value, (int, float)):
        return value if value == value else None
    text = plain(value).replace(" ", "").replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def count(value):
    number = scalar(value)
    if number is None:
        return 0
    return max(0, int(round(number)))


def total_meters(value):
    if isinstance(value, str) and "+" in value:
        parts = [scalar(part) for part in re.split(r"[+;\n]+", value)]
        if parts and all(part is not None for part in parts):
            return round(sum(parts), 2)
    return scalar(value) or 0


def iso_date(value):
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = plain(value)
    for pattern in ("%d.%m.%Y", "%d.%m.%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, pattern).date().isoformat()
        except ValueError:
            pass
    return ""


def workbook_bytes(source):
    path = Path(source)
    if path.suffix.lower() == ".xlsx":
        return path.read_bytes(), path.name
    if path.suffix.lower() != ".zip":
        raise ValueError("Źródło musi być plikiem .zip z zeszytem albo samym plikiem .xlsx.")
    with zipfile.ZipFile(path) as archive:
        entries = [item for item in archive.infolist() if item.filename.lower().endswith(".xlsx") and "PRZYJ" in item.filename.upper()]
        if len(entries) != 1:
            raise ValueError(f"W ZIP znaleziono {len(entries)} skoroszytów zeszytu przyjęć; oczekiwano jednego.")
        return archive.read(entries[0]), Path(entries[0].filename).name


def order_key(period, pm, dispatch, symbol, trade_symbol, client, row_number):
    key = "|".join([period, normalized(pm), iso_date(dispatch), normalized(symbol), normalized(trade_symbol), normalized(client)])
    if not normalized(pm):
        key += f"|row-{row_number}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]


def process_row(row, period, row_number, orders, current):
    values = list(row)
    values += [None] * max(0, 26 - len(values))
    dispatch, plant, raw_symbol, client, trade_symbol, pm, status_value, received_date, lot = values[:9]
    sent_pieces, sent_kg, yarn_lot = values[9:12]
    raw_received, finished_pieces, finished_kg, finished_meters = values[12:16]
    target_color, target_stiffening, target_width, target_grammage = values[16:20]
    actual_color, actual_stiffening, actual_width, actual_grammage, rubbing, notes = values[20:26]
    symbol_text = plain(raw_symbol) or (current.get("raw_symbol", "") if current else "")
    pm_text = plain(pm)

    if pm_text:
        candidate = order_key(period, pm_text, dispatch, symbol_text, trade_symbol or (current or {}).get("trade_symbol", ""), client or (current or {}).get("client_name", ""), row_number)
        order = orders.get(candidate)
        if order is None:
            order = {
                "source_key": f"intake-{candidate}", "period": period,
                "source_shipment_no": pm_text, "source_shipment_date": iso_date(dispatch),
                "raw_symbol": symbol_text, "client_name": plain(client), "trade_symbol": plain(trade_symbol),
                "finishing_plant_name": plain(plant), "status": "sent", "batches": [],
                "target_color": plain(target_color), "target_stiffening": plain(target_stiffening),
                "target_width_cm": scalar(target_width), "target_grammage": scalar(target_grammage),
                "notes": "", "_statuses": [], "_batches": {},
            }
            orders[candidate] = order
        current = order
    elif current is None or (symbol_text and normalized(symbol_text) != normalized(current.get("raw_symbol"))):
        candidate = order_key(period, "", dispatch, symbol_text, trade_symbol, client, row_number)
        current = {
            "source_key": f"intake-{candidate}", "period": period,
            "source_shipment_no": "", "source_shipment_date": iso_date(dispatch),
            "raw_symbol": symbol_text, "client_name": plain(client), "trade_symbol": plain(trade_symbol),
            "finishing_plant_name": plain(plant), "status": "sent", "batches": [],
            "target_color": plain(target_color), "target_stiffening": plain(target_stiffening),
            "target_width_cm": scalar(target_width), "target_grammage": scalar(target_grammage),
            "notes": "", "_statuses": [], "_batches": {},
        }
        orders[candidate] = current

    for field, value in (("client_name", client), ("trade_symbol", trade_symbol), ("finishing_plant_name", plant), ("source_shipment_date", iso_date(dispatch))):
        if not current.get(field) and value:
            current[field] = plain(value) if field != "source_shipment_date" else value
    if pm_text and not current.get("source_shipment_no"):
        current["source_shipment_no"] = pm_text
    if not current.get("raw_symbol"):
        current["raw_symbol"] = symbol_text

    status = normalized(status_value)
    if "SPRZEDAZ SUR" in status or "SPRZEDAZ SUROWEJ" in status:
        current["_statuses"].append("raw_sale")
        mapped_status = "raw_sale"
    elif status == "TAK":
        current["_statuses"].append("received")
        mapped_status = "received"
    else:
        current["_statuses"].append("sent")
        mapped_status = "sent"
        if status and status != "NIE":
            current["notes"] = (current["notes"] + f"Status źródłowy: {plain(status_value)}. ").strip()

    lot_key = plain(lot) or f"wiersz-{row_number}"
    batch_key = normalized(lot_key)
    batch = current["_batches"].get(batch_key)
    if batch is None:
        batch = {
            "source_key": f"{current['source_key']}-batch-{hashlib.sha256(batch_key.encode()).hexdigest()[:12]}",
            "finishing_lot": plain(lot), "sent_at": iso_date(dispatch) or current.get("source_shipment_date") or f"{period}-01",
            "sent_pieces": count(sent_pieces), "raw_weight_kg": scalar(sent_kg) or 0,
            "yarn_lot": plain(yarn_lot), "closed": mapped_status == "received", "notes": "", "receipts": [],
        }
        current["_batches"][batch_key] = batch
        current["batches"].append(batch)
    else:
        batch["sent_pieces"] = batch["sent_pieces"] or count(sent_pieces)
        batch["raw_weight_kg"] = batch["raw_weight_kg"] or scalar(sent_kg) or 0
        batch["yarn_lot"] = batch["yarn_lot"] or plain(yarn_lot)
        batch["closed"] = batch["closed"] or mapped_status == "received"

    raw_notes = "" if empty(notes) else plain(notes)
    has_receipt = bool(iso_date(received_date) or any(not empty(value) for value in (raw_received, finished_pieces, finished_kg, finished_meters)))
    if has_receipt and iso_date(received_date):
        rubbing_text = normalized(rubbing)
        receipt = {
            "source_key": f"{batch['source_key']}-return-{row_number}", "received_at": iso_date(received_date),
            "raw_pieces_received": count(raw_received), "finished_pieces": count(finished_pieces),
            "finished_weight_kg": scalar(finished_kg) or 0, "finished_meters": total_meters(finished_meters),
            "actual_color": "" if empty(actual_color) else plain(actual_color),
            "actual_stiffening": "" if empty(actual_stiffening) else plain(actual_stiffening),
            "actual_width_cm": scalar(actual_width), "actual_grammage": scalar(actual_grammage),
            "rubbing_status": "ok" if rubbing_text in {"OK", "TAK"} else "not_ok" if rubbing_text in {"NIE OK", "NIEOK"} else "",
            "notes": raw_notes, "returned_bales": [],
        }
        batch["receipts"].append(receipt)
        batch["closed"] = batch["closed"] or mapped_status == "received"
    elif raw_notes:
        batch["notes"] = (batch["notes"] + raw_notes).strip()
    return current


def build(source, recipe_file=None):
    content, workbook_name = workbook_bytes(source)
    workbook = openpyxl.load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    wanted = {normalized(name): period for name, period in PERIODS.items()}
    orders = {}
    for sheet in workbook.worksheets:
        key = normalized(sheet.title)
        if key not in wanted:
            continue
        period = wanted[key]
        current = None
        for row_number, row in enumerate(sheet.iter_rows(min_row=4, values_only=True), start=4):
            values = list(row)
            if len(values) < 16 or all(empty(value) for value in values[:16]):
                continue
            if not empty(values[2] if len(values) > 2 else None):
                current = process_row(values, period, row_number, orders, current)
    workbook.close()

    for order in orders.values():
        statuses = set(order.pop("_statuses"))
        batches = order.pop("_batches")
        if statuses == {"raw_sale"}:
            order["status"] = "raw_sale"
        elif "received" in statuses and "sent" in statuses:
            order["status"] = "partial"
        elif "received" in statuses:
            order["status"] = "received"
        else:
            order["status"] = "sent"
        if "raw_sale" in statuses and len(statuses) > 1:
            order["notes"] = (order["notes"] + " W danych źródłowych są również wiersze sprzedaży surowej.").strip()

    recipes = []
    if recipe_file:
        recipes = json.loads(Path(recipe_file).read_text(encoding="utf-8"))
        if isinstance(recipes, dict):
            recipes = recipes.get("recipes", [])
        if not isinstance(recipes, list):
            raise ValueError("Plik receptur musi być listą JSON albo zawierać pole recipes z listą.")

    return {
        "format": FORMAT, "target_schema_user_version": TARGET_SCHEMA,
        "source_name": workbook_name, "periods": ["2026-09", "2026-10"],
        "recipes": recipes, "orders": list(orders.values()),
    }


def main():
    parser = argparse.ArgumentParser(description="Tworzy prywatną paczkę importu przyjęć za wrzesień i październik 2026.")
    parser.add_argument("source", help="wykonczenie.zip albo wyeksportowany skoroszyt .xlsx")
    parser.add_argument("--recipes", help="opcjonalny prywatny plik JSON z recepturami")
    parser.add_argument("--out", default="marand_finishing_import.json", help="plik wyjściowy JSON; domyślnie marand_finishing_import.json")
    args = parser.parse_args()
    package = build(args.source, args.recipes)
    output = Path(args.out)
    output.write_text(json.dumps(package, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Utworzono {output} · okresy IX–X 2026 · {len(package['orders'])} zleceń · {len(package['recipes'])} receptur · {output.stat().st_size} bajtów")


if __name__ == "__main__":
    main()
