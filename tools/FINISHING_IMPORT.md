# Import paczki wykańczania

Import korzysta z ekranu administratora **Import danych** i przyjmuje prywatny plik `marand_finishing_import.json`. Paczka nie jest wysyłana do GitHuba. Najpierw jest sprawdzana bez zmian w bazie; dopiero po potwierdzeniu aplikacja wykonuje sprawdzoną kopię i zapisuje dane.

## Przygotowanie historii z zeszytu

Skrypt `pack-finishing-import.py` odczytuje arkusze **WRZESIEŃ** i **PAŹDZIERNIK** z `PRZYJĘCIE TOWARU 2026.xlsx`. Przyjmuje sam skoroszyt albo ZIP zawierający ten skoroszyt. Pomija koszty. Kolumnę `PM` zachowuje jako numer źródłowej wysyłki, a wiersze z tym samym `PM` grupuje pod jednym zleceniem i LOT wykończalni zachowuje jako osobną partię.

Skrypt wymaga Pythona 3 i biblioteki `openpyxl`:

```powershell
python -m pip install openpyxl
python .\tools\pack-finishing-import.py "C:\Users\PC\Desktop\KONSALNET\wykonczenie.zip" --out "C:\Users\PC\Desktop\marand_finishing_import.json"
```

Jeśli archiwum jest już rozpakowane, zamiast ZIP można podać ścieżkę do `PRZYJĘCIE TOWARU 2026.xlsx`.

## Receptury

Skrypt może dołączyć receptury z osobnego pliku JSON przez `--recipes recipes.json`. Plik może zawierać samą listę albo obiekt z polem `recipes`. Każdy wpis ma pola:

```json
{
  "source_key": "recipe-wt-140-grafit",
  "name": "WT 140 07-04 GRAFIT 175 cm",
  "finishing_plant_name": "An-Farb",
  "raw_symbol": "WT 140",
  "recipe_text": "Treść receptury",
  "target_color": "Grafit",
  "target_stiffening": "",
  "target_width_cm": 175,
  "target_grammage": 140,
  "notes": ""
}
```

Skrypt nie zgaduje treści receptur z parametrów w zeszycie. Jeśli nie podano pliku receptur, przygotowuje paczkę historii z pustą biblioteką.

## Wczytanie do aplikacji

1. Zaktualizuj serwer do wydania zawierającego import wykańczania.
2. Zaloguj się jako administrator i otwórz **Import danych**.
3. Wskaż `marand_finishing_import.json` i wybierz **Sprawdź paczkę**.
4. Przejrzyj zakres miesięcy, liczbę zleceń, partii, przyjęć, receptur i konflikty.
5. Zaznacz potwierdzenie i wybierz import. Baza dostanie kopię przed zapisem.

Import przyjmuje sumę metrów i kg z zeszytu. Gdy zeszyt nie podaje kg dla każdej belki osobno, nie tworzy fikcyjnych wag ani etykiet jednostkowych. Ten sam okres można zaimportować tylko raz; import można cofnąć z ekranu **Import danych**, dopóki nie wykonano późniejszego importu.
