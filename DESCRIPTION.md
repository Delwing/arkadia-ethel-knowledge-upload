# Wiedza Uploader

Plugin do Arkadia Web Client, ktory wysyla wiedze postaci z lokalnej bazy
klienta na strone [ethel.pl](https://ethel.pl).

## Co robi

- Czyta zapisane postepy wiedzy (per postac) z lokalnej bazy klienta.
- Loguje sie do ethel.pl przez OAuth (Authorization Code + PKCE) - haslo
  zostaje na stronie, plugin dostaje tylko token z uprawnieniem
  `update_own_wiedza`.
- Wysyla wpisy wybranej postaci i pokazuje podsumowanie: ile wpisow zostalo
  dopasowanych oraz liste niedopasowanych.
- Opcjonalny auto-upload: po wlaczeniu dla wybranej postaci plugin wysyla
  wiedze sam, gdy tylko sie zmieni (z 5-sekundowym opoznieniem i pominieciem
  wysylki, gdy nic sie nie zmienilo).
- Ciche odswiezanie tokenu - dopoki sesja na ethel.pl zyje, nie trzeba
  logowac sie ponownie.

## Instalacja

1. W menedzerze pluginow Arkadia Web Client dodaj adres:
   `https://delwing.github.io/arkadia-ethel-knowledge-upload/plugin.js`
2. Otworz menu `⋮` -> **Wiedza - Ethel.pl**.
3. Kliknij **Zaloguj** i przejdz przez logowanie na ethel.pl.
4. Wybierz postac i kliknij **Wyslij wiedze**, albo zaznacz
   **Wysylaj automatycznie wiedze tej postaci**.

## Uwagi

- Token trzymany jest w `localStorage` przegladarki, wiec po odswiezeniu
  klienta nie trzeba logowac sie od nowa (**Wyloguj** go usuwa).
- Wysylane sa wylacznie nazwy znanych wpisow wiedzy wybranej postaci.
- Okno logowania otwiera sie w popupie - warto odblokowac popupy dla klienta.

Autor: Dargoth
