# Lokalny panel dziewiarza

Panel działa na komputerze produkcyjnym bez internetu i VPN. Dane zapisuje w
`%LOCALAPPDATA%\Marand\Produkcja\production.sqlite3`, poza katalogiem programu,
więc aktualizacja plików programu nie usuwa bazy.

## Uruchomienie

1. Wystarczy Node.js 24.15 lub nowszy w systemie. Jeśli uruchamiasz panel na komputerze z Codexem, skrypt startowy spróbuje użyć jego lokalnego runtime, gdy Node nie jest dodany do `PATH`.
2. Uruchom `START_DZIEWIARNIA.cmd`.
3. Panel otworzy się w przeglądarce pod adresem `http://127.0.0.1:8766`.
4. W zakładce **Ustawienia** wpisz aktywne artykuły oraz dziewiarzy.

Panel nasłuchuje wyłącznie na komputerze lokalnym. Nie wymaga pakietów npm.
Co sześć godzin tworzy sprawdzoną kopię bazy w podfolderze `kopie` i zachowuje
20 najnowszych kopii.

## Biblioteka artykułów i dziewiarzy

Po skonfigurowaniu połączenia z programem głównym panel pobiera zatwierdzone
technologie i aktywnych dziewiarzy z centralnych bibliotek. Kierownik wyszukuje
artykuł w zakładce **Ustawienia** i dodaje go do lokalnej listy produkcyjnej;
dziewiarz nadal widzi tylko wybrane pozycje. Lokalna kopia biblioteki jest
zachowywana przy braku połączenia, a odświeżenie nie zmienia identyfikatorów
artykułów, belek ani przypisań do maszyn. Do czasu odbioru synchronizacji
pozostaje dostępne przejściowe ręczne dodawanie artykułów.
Biblioteki są pobierane jeden raz podczas uruchamiania panelu. Wyszukiwanie
artykułów korzysta wyłącznie z zapisanej kopii lokalnej. Po zmianie tokenu lub
gdy program główny był niedostępny podczas startu, uruchom panel ponownie,
aby wykonać następną próbę synchronizacji.

## Zapis produkcji

Jednorazowo można dodać do sześciu belek dla wspólnego artykułu, maszyny i daty.
Każda belka dostaje techniczny UUID i widoczny numer w sekwencji maszyny oraz
roku produkcji. Dla każdej belki zapisują się kilogramy, metry, błędy, stopy,
LOT, uwagi oraz udział metrów przypisany dziewiarzom. Udziały muszą sumować się
do długości belki. Wpisy można poprawiać i oznaczyć do sprawdzenia, dopóki nie
zostaną wysłane.

## Produkcja dzienna i wysyłanie do programu głównego

Zakładka **Produkcja** zawiera formularz przyjęcia belek i bieżącą listę belek.
Zakładka **Produkcja dzienna** zawiera raporty, archiwum oraz zwijane połączenie
z programem głównym. Na etapie projektowania zakładka nie jest jeszcze
zabezpieczona hasłem kierownika.

1. Administrator otwiera w głównym programie **Stan bieżący** i tworzy token
   połączenia. Token jest widoczny tylko po utworzeniu.
2. Adres `http://192.168.1.14:8765` jest zapisywany automatycznie. Token wpisuje
   się w zwijanej sekcji **Połączenie z programem głównym**; przycisk **Sprawdź i zapisz token**
   potwierdzi go bez wysyłania produkcji. Wygenerowanie nowego tokenu w programie
   głównym unieważnia poprzedni.
   Ten sam token służy do pobrania bibliotek; wyszukiwanie działa na zapisanej
   lokalnie kopii, jeśli serwer jest chwilowo niedostępny.
3. Doba produkcyjna trwa w czasie Europe/Warsaw od 06:00 do 06:00 następnego
   dnia. Raport jest nazwany datą rozpoczęcia doby i wybiera belki według czasu
   ich przyjęcia w panelu. Wygenerowane belki znikają z bieżącej listy i są
   dostępne w zwijanym raporcie. Lista pokazuje wszystkie belki, bez limitu.
4. Raporty z ostatnich 30 dni pokazują liczbę sztuk, łączną masę i status
   wysyłki. W niewysłanym raporcie można poprawiać wartości bezpośrednio w tabeli,
   dopisać belkę przez zwykły formularz albo usunąć ją z raportu, co przywróci ją
   do bieżącej listy. Numer porządkowy 1 oznacza najwcześniej przyjętą belkę;
   najnowsze belki są wyświetlane na górze.
5. Zatwierdzenie zapisuje wysyłaną wersję; status „Wysłany” z datą i godziną
   pojawia się po potwierdzeniu serwera. Błąd można ponowić bez powielania wpisów.
6. Po wysłaniu raportu jego dane są tylko do odczytu w panelu lokalnym. Korekty
   wysłanych danych wykonuje się w programie głównym.

Program główny zapisuje każdą belkę w kartotece sztuk i tworzy dzienny zapis
wartości Szt/Kg w chwili wysłania. Ponowienie wysyłki tego samego dnia aktualizuje
zapis dnia i nie dodaje drugi raz belek, które już przesłano.
Suma uwzględnia wszystkie belki zapisane w kartotece; wydania z magazynu nie są
jeszcze odejmowane, bo obecny panel nie zapisuje operacji wydania belki.

Przy belkach oczekujących przycisk **Edytuj belkę** jest widoczny bezpośrednio
przy numerze.
Przycisk **Skopiuj ostatnią belkę** w formularzu przenosi dane z najnowszego
wpisu, także gdy belka znajduje się już w raporcie dziennym.

W kolejnym etapie główny system ma zapisywać tygodniową historię bieżących
stanów dzianin według dni kalendarzowych. Stan dnia jest ustalany w chwili
porannego wgrania danych na serwer przez kierownika, na początku porannej
zmiany. Nie należy wyliczać go wstecz z wysyłek ani z dat produkcji.

Przed pracą produkcyjną należy ustalić zatwierdzone liczniki początkowe maszyn
i lat, aby numery nowych belek kontynuowały właściwą numerację.
