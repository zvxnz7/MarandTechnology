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

## Zapis produkcji

Jednorazowo można dodać do sześciu belek dla wspólnego artykułu, maszyny i daty.
Każda belka dostaje techniczny UUID i widoczny numer w sekwencji maszyny oraz
roku produkcji. Dla każdej belki zapisują się kilogramy, metry, błędy, stopy,
LOT, uwagi oraz udział metrów przypisany dziewiarzom. Udziały muszą sumować się
do długości belki. Wpisy można poprawiać i oznaczyć do sprawdzenia, dopóki nie
zostaną zsynchronizowane.

## Wysyłanie produkcji do programu głównego

1. Administrator otwiera w głównym programie **Stan bieżący** i tworzy token
   połączenia. Token jest widoczny tylko po utworzeniu.
2. Kierownik otwiera lokalne **Ustawienia**, wpisuje adres programu głównego i
   token, po czym wybiera **Zapisz listy i liczniki**.
3. W Ustawieniach wybiera **Wyślij produkcję do bazy**. W tej wersji przesyłany
   jest wyłącznie artykuł **WT 56-21 (5)**. Pozostałe artykuły pozostają w
   lokalnej kolejce.

Program główny zapisuje każdą belkę w kartotece sztuk i tworzy dzienny zapis
wartości Szt/Kg w chwili wysłania. Ponowienie wysyłki tego samego dnia aktualizuje
zapis dnia i nie dodaje drugi raz belek, które już przesłano.
Suma uwzględnia wszystkie belki zapisane w kartotece; wydania z magazynu nie są
jeszcze odejmowane, bo obecny panel nie zapisuje operacji wydania belki.

Ustawienia lokalne pozwalają również zmienić hasło kierownika. Przy belekach
oczekujących przycisk **Edytuj belkę** jest widoczny bezpośrednio przy numerze.

W kolejnym etapie główny system ma zapisywać tygodniową historię bieżących
stanów dzianin według dni kalendarzowych. Stan dnia jest ustalany w chwili
porannego wgrania danych na serwer przez kierownika, na początku porannej
zmiany. Nie należy wyliczać go wstecz z wysyłek ani z dat produkcji.

Przed pracą produkcyjną należy ustalić zatwierdzone liczniki początkowe maszyn
i lat, aby numery nowych belek kontynuowały właściwą numerację.
