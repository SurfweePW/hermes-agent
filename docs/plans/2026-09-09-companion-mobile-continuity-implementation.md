# Hermes Companion — prosty klient mobilny. Plan wdrożeniowy

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. Before implementation reload hermes-agent and the applicable area AGENTS.md. All implementation, diagnosis, audit and review work uses Sol. Do not call Astra unless Paweł explicitly requests that specific development call. Do not spawn duplicate research batches.

**Goal:** Paweł otwiera na Androidzie projekt i rozmowę utworzone w Hermes Desktop, kontynuuje tę samą rozmowę, podejmuje decyzje i przegląda pliki w jednej prostej aplikacji.

**Architecture:** Istniejący Companion pozostaje cienkim klientem wspólnego Hermes gateway. Profile, projekty, relacje i sesje pozostają w Hermes; decyzje i ich audyt w WorkStore; wykonanie w istniejącym trackerze. Mobilny klient nie tworzy drugiej historii ani własnego silnika agentów.

**Tech Stack:** Obecne React/TypeScript/Vite, @hermes/shared, Capacitor/Android, Python gateway i istniejące magazyny SQLite. Zachować wspólny frontend z istniejącą powłoką Electron; nie kopiować Electron API do Androida.

**Data:** 2026-09-09.
**Status:** plan wykonawczy przygotowany na prośbę Pawła. Dokument nie jest świadectwem wdrożenia, testów aplikacji ani zgodą na publikację lub restart usług.
**Baza odczytana:** `/Users/atlasweber/hermes-companion`, branch `feature/hermes-companion`, commit `15bb315df34945a2097876053e49aae0c77a9b69`, manifest Companion 0.4.4; czyste drzewo przed zapisaniem planu. Snapshot 0.4.3 nie jest bazą wdrożenia.

---

## 1. Co zmieniamy względem starego planu

Ten dokument zastępuje sprzeczne założenia handoffu `2026-09-06-hermes-companion-development-handoff.md`. Zachowuje jego wymagania dotyczące decyzji, organizacji, evidence, bezpieczeństwa i pełnego dostępu do źródeł.

| Wcześniej | Teraz |
|---|---|
| Needs Me jako ekran główny | Rozmowy jako ekran główny |
| Work jako osobny katalog historii | Projekty i sesje bezpośrednio w Rozmowach |
| Sesje wyłącznie do odczytu, kontynuacja poza aplikacją | Odczyt i kontynuacja tej samej sesji w Companion |
| Roster Teammates / Bot Chat / Main conversation | Czytelny wybór agenta, projektów i nazwanych sesji |
| Telegram jako wymagany klient rozmów | Telegram nie jest wymagany do żadnej podstawowej czynności |
| Natywna powłoka opcjonalna po webie | Android jest główną powierzchnią odbioru; istniejący Mac klient bez regresji |
| Decyzje i katalog konkurują z czatem | Rozmowy, Decyzje, Pliki — trzy jednoznaczne miejsca |

Nie zmieniamy nazwy produktu ani package ID. „Hermes Mobile” opisuje jego rolę, nie jest zadaniem rebrandingu.

### Korekta poziomu pewności wcześniejszego researchu

Istnienie `session.resume` i `prompt.submit` w kodzie nie dowodzi poprawnej kontynuacji produkcyjnej sesji między dwoma runtime'ami. To nadal bramka integracyjna. Preferencje dotyczące wyglądu konkurencji nie zastępują testu użyteczności na telefonie. Nie zakładamy, że istniejący owner login automatycznie autoryzuje każdy nowy rodzaj zapisu.

## 2. Obietnica i dosłowny przebieg

> Jedna aplikacja do tych samych rozmów co na komputerze — z decyzjami i plikami pod ręką.

1. Przy pierwszym uruchomieniu Paweł loguje się jako właściciel do istniejącego backendu. Bez ręcznego kopiowania tokenów w codziennym użyciu.
2. Otwiera Rozmowy i widzi rzeczywiste projekty oraz sesje z Hermes Desktop, także bez decyzji, zadań i plików.
3. Zmienia agenta, gdy chce przejść np. z Atlas do HOFFEECMO. Widok Wszystkie pomaga znaleźć sesję, gdy nie pamięta agenta.
4. Rozwija projekt i dotyka nazwy rozmowy. Od razu widzi historię i pole wiadomości — bez pośredniego ekranu metadanych.
5. Pisze wiadomość. Serwer kontynuuje wskazaną sesję z jej właściwym profilem, projektem i katalogiem roboczym.
6. Odkłada telefon. Praca trwa na serwerze. Po powrocie widzi aktualny wynik, bez ponownego wysyłania polecenia.
7. Wraca na Desktop i widzi tę samą logiczną sesję z dopisaną wiadomością i odpowiedzią.
8. Jeśli potrzebna jest decyzja, otwiera kartę w Decyzjach; z niej przechodzi jednym dotknięciem do źródłowej rozmowy lub dowodu.
9. Plik otwiera w kontekście rozmowy/decyzji albo w Plikach; może go pobrać i udostępnić przez system Androida.

Wymagany jest dostępny backend na Mac Mini i uprawnienia. MacBook ani uruchomione okno Hermes Desktop nie mogą być warunkiem czytania zapisanych sesji. Sesje z innego backendu wymagają istniejącego autoryzowanego połączenia; nie udajemy widoczności niedostępnych źródeł.

## 3. Interfejs: celowo tylko trzy główne zakładki

### A. Rozmowy

Ekran startowy:

- nagłówek „Rozmowy”; przycisk nowej rozmowy;
- wybór agenta: Wszystkie / konkretne uprawnione profile; zapamiętanie ostatniego wyboru;
- jeden przełącznik „Projekty / Ostatnie”, domyślnie Projekty przy pierwszym użyciu;
- wyszukiwarka nazw sesji i projektów, bez osobnego centrum wyszukiwania;
- projekty rozwijane w miejscu; pod nimi nazwane sesje;
- osobna grupa „Bez projektu”; puste projekty pozostają widoczne;
- sesja: tytuł, krótki podgląd, czas i tylko potrzebny status, np. „Pracuje”;
- w widoku Wszystkie oznaczenie agenta, żeby identyczne nazwy nie były mylące;
- archiwum i dodatkowe filtry pod menu, nie stale na ekranie.

Nie wymuszamy globalnej hierarchii biznes → agent → projekt → temat → sesja. Pokazujemy prawdziwą organizację Desktopu, z agentem jako zakresem widoku. Tematy są alternatywnym sposobem organizacji decyzji, a nie nowym obowiązkowym poziomem rozmowy.

Uruchomienie zimne: lista Rozmów z ostatnim bezpiecznym zakresem. Powrót z tła: dokładnie ostatni ekran, sesja, szkic i pozycja. Deep link: wskazana sesja/decyzja/plik, nie ekran startowy. Po wyjściu z linku powrót do sensownego kontekstu.

### B. Wnętrze rozmowy

- Największy tekst w nagłówku to **tytuł sesji**, nie nazwa bota.
- Agent i projekt w drugiej linii, przycisk wstecz do listy w tym samym miejscu.
- Historia i pole wiadomości dostępne bez „Open original” lub „Continue elsewhere”.
- Bez technicznych identyfikatorów, nazw protokołów i pełnych logów domyślnie.
- Narzędzia jako zwijany status; wiadomości użytkownika i odpowiedzi dominują.
- Kompakcja i techniczne komunikaty zwinięte; żadnego ujawniania ukrytego rozumowania, sekretów czy chronionych payloadów.
- Podczas pracy: krótki status i Stop. Stop jest jawną akcją, nie efektem nawigacji.
- Czytanie starszej części nie przewija automatycznie na dół; przycisk „Nowe wiadomości”.
- Szkic przypisany do konkretnej sesji, a nie globalny dla wszystkich agentów.
- Mobilny Enter tworzy nową linię; wysyłanie przyciskiem. Skrót klawiatury fizycznej może być osobny, nie kopiować wskazówki desktopowej na telefon.
- Powiązane decyzje i pliki pod ikonami/menu w nagłówku, nie jako stały panel zajmujący połowę ekranu.

### C. Decyzje

Domyślnie pionowa lista „Do decyzji”, nie szeroka tablica wymagająca przesuwania w bok.

Karta odpowiada na pytania: czego potrzebujesz ode mnie, dlaczego, jaka jest rekomendacja i co zmieni moje kliknięcie. Zawiera dowody, komentarze i link do źródłowej sesji.

- Akcje o istniejącej semantyce: „Zatwierdź przygotowanie”, „Poproś o zmiany”, „Odłóż”, „Odrzuć”.
- Nie zamieniać `approve_preparation` w ogólne „Zatwierdź wszystko”.
- Dodatkowy widok statusów/kanban korzysta z tych samych rekordów. Na telefonie kolumny jako wybór statusu; drag-and-drop nie jest warunkiem obsługi i nie udziela zgody.
- Grupowanie po temacie, sesji lub projekcie zostaje w opcjach widoku; nie powiela decyzji ani liczników.
- Historyczne decyzje oraz przygotowanie/wyniki są dostępne, ale nie zwiększają badge'a „Do decyzji”.
- Błędy połączenia nie są decyzjami biznesowymi i nie pompują tego licznika.
- Zgody na narzędzia są wyraźnie oznaczone jako inny typ niż decyzje biznesowe; ich granice i uprawnienia pozostają oddzielne.

### D. Pliki

Prosta lista z wyszukiwaniem i opcjonalnym filtrem agent/projekt. Widoczne nazwa, typ, źródło i aktualność/wersja. Te same pliki dostępne z powiązanej rozmowy i decyzji bez kopiowania.

Bez pełnego eksploratora dysku. Bez konieczności znajomości ścieżek Maca. Tekst/Markdown/JSON i obrazy: bezpieczny podgląd; PDF i pozostałe uzgodnione formaty: przetestowany podgląd lub wyraźny systemowy fallback do oryginału. „Brak podglądu” nie może oznaczać braku możliwości pobrania.

Ustawienia są pod ikoną w nagłówku, nie czwartą zakładką. Zaawansowane zarządzanie tematami/powiązaniami zachowujemy w szczegółach, zamiast usuwać funkcjonalność pod hasłem prostoty.

### Mierzalne kryteria prostoty (cele odbioru, nie wyniki)

- Tylko 3 główne zakładki.
- Z listy projektów do sesji: rozwinięcie projektu i dotknięcie sesji; bez dodatkowej strony „szczegóły sesji”.
- Z otwartej karty decyzji do źródłowej rozmowy: 1 dotknięcie.
- Najwyżej jeden główny przycisk akcji w danym stanie; alternatywy wyraźnie drugorzędne.
- Cele dotyku co najmniej 48 CSS px; ekran działa przy szerokości 360 CSS px i powiększonym tekście bez poziomego przewijania całej aplikacji.
- Android Back zamyka kolejno modal/klawiaturę/szczegóły i wraca do listy; nie wyrzuca użytkownika na innego agenta.
- Paweł bez instrukcji znajduje istniejącą sesję, wysyła wiadomość, wraca do decyzji i pobiera plik. Wynik rzeczywistej próby zapisujemy, nie uznajemy mockupu za test.

## 4. Źródła prawdy i kontrakt ciągłości

### Tożsamość

Klucz kontekstu: autorytatywny backend/połączenie + profil + zapisane ID sesji. Oddzielnie: ID projektu i relacja według resolvera Hermes. Oddzielnie: tymczasowy uchwyt runtime oraz identyfikator wykonania.

Kompakcja może zmienić fizyczną sesję-tip; „ta sama sesja” oznacza tę samą logiczną linię rozmowy według Hermes, nie sztuczne utrzymywanie przestarzałego ID. Nazwy są etykietami, nigdy kluczami. Nie tworzyć umownego `profile_id`, jeśli rzeczywisty protokół identyfikuje profil przez inną strukturę — typ klienta ma odzwierciedlać kontrakt.

### Czytanie i wykonywanie są różnymi operacjami

- Otwarcie listy/historii: odczyt zapisanych danych bez uruchamiania agenta, zmiany projektu, tworzenia sesji lub promptu.
- Wysłanie: jawna operacja kontynuacji, mapująca właściwą sesję na runtime odpowiedniego właściciela wykonania.
- Samo `session.resume` może mieć skutki uboczne i wymaga audytu przed użyciem przy otwarciu widoku. Nie podłączać go automatycznie do każdego tapnięcia.
- Dwa procesy mające dostęp do tego samego SQLite nie są automatycznie jednym runtime'em. Zidentyfikować proces wykonujący Desktop i Companion; zapewnić jedno wykonanie/koordynację blokady dla tej samej sesji.
- Pracująca sesja może być obserwowana na obu urządzeniach. W tej wersji, jeśli trwa tura, druga wiadomość czeka jako lokalny szkic; brak samoczynnego parallel run, fork lub ukrytego kolejkowania.
- Reconnect pobiera kanoniczną historię/status, nie wykonuje ponownie promptu ani approval.
- Przy wyniku wysłania „nieznany”: uzgodnić z serwerem. Nie wystarczy odblokować przycisk „Wyślij ponownie”.
- Jeśli obecna ścieżka nie obsługuje trwałego request ID/uzgodnienia, wdrożyć minimalne rozszerzenie w istniejącym serwisie operacji. Nie tworzyć drugiej historii jako obejścia.
- Rozłączenie klienta nie zatrzymuje pracy serwerowej. Sprawdzić reaper/orphan policy i właściciela runu, nie tylko UI.
- Przeglądanie innego projektu nie zmienia globalnego aktywnego projektu Desktopu ani `cwd` działającego zadania.

### Nowa rozmowa

Wchodzi do pełnego zakresu wydania po udowodnieniu kontynuacji. Przy otwieraniu nowego szkicu nie tworzyć zaśmiecającej pustej sesji. Przy wysłaniu powstaje jedna zapisana sesja zgodnie z kontraktem Hermes, we wskazanym profilu/projekcie lub „Bez projektu”; jest widoczna na Desktopie. W widoku Wszystkie agent musi być wybrany jawnie przed wysłaniem. Nigdy nie domyślać go z tekstu zadania.

Tworzenie/usuwanie projektów i pełny konfigurator agentów nie są konieczne do obecnego celu; pozostają na Desktopie. Zmiana nazwy/przypięcie sesji może korzystać z istniejących operacji po testach, ale nie jest warunkiem spike'u ciągłości. Usuwanie sesji nie jest częścią tej zmiany.

## 5. Stan zastany — co użyć i czego jeszcze nie obiecywać

W bazie 0.4.4 odczytano:

| Ścieżka | Potwierdzone w kodzie | Potrzebna zmiana/weryfikacja |
|---|---|---|
| `apps/companion/src/gateway/companion-client.ts` | profiles.list, session.create/list/resume, prompt.submit, session.interrupt, approval.pending/respond; companion.sessions/projects/history | Uprawnienia owner, namespace, lineage i jednorazowe wykonanie; tworzenie sesji w projekcie nie jest dowiedzione przez obecny wrapper |
| `apps/companion/src/state/companion-store.ts` | storedSessionId i runtimeSessionId oddzielne; globalny draft; Teammates/Bot Chat | Jawna selekcja sesji, per-session draft i eliminacja przypadkowego Main conversation |
| `apps/companion/src/features/directory/` | Katalog źródeł i historia, paginacja/refresh | Jedna ścieżka otwarcia rozmowy; brak zależności od work cards |
| `apps/companion/src/features/conversation/conversation.tsx` | Composer tekstowy, streaming, Stop, scroll-follow, approval | Tytuł sesji pierwszy, mobilny Enter, historia z katalogu + kontynuacja, reconnect |
| `apps/companion/src/features/work/` | Decyzje, komentarze, owner sign-in | Prostsza prezentacja i powiązanie z prawdziwą sesją |
| `apps/companion/src/features/library/` | Listowanie, preview/download, relacje | Pokrycie kolekcji, JSON fallback i faktyczny Android download/share |
| `apps/companion/src/app.tsx` i `styles/` | Needs Me / Work / Library, roster i ekran rozmowy | Nawigacja Rozmowy / Decyzje / Pliki, proste nagłówki |

Obecny composer przyjmuje tekst; załączniki wejściowe i własne nagrywanie głosu nie są potwierdzone. W pierwszym zakresie pozostaje dyktowanie klawiatury systemowej, czytanie istniejących załączników i dostęp do plików. Nie pokazywać niedziałającego plusa/mikrofonu. Upload obrazów/plików można dodać jako osobny przekrój po sprawdzeniu istniejącej ścieżki Hermes — nie przedstawiać go jako już dostępnego ani nie blokować nim ciągłości tekstowej.

## 6. Kolejność wdrożenia

Każde zadanie kodowe dzielić na małe kroki: test zachowania → uruchomienie RED → minimalna zmiana → GREEN → kontrola regresji. Polecenia i oczekiwania poniżej są instrukcją wykonania, nie raportem przeprowadzonych testów. Nie zgadywać ciał funkcji ani payloadów przed odczytem bieżących definicji. Nowe pliki oznaczone „nowy” są proponowanymi artefaktami, nie istniejącymi API.

### P0. Zamrozić bazę, topologię i macierz wymagań

**Zależność:** brak. **Wynik:** wiadomo, z czego budujemy i gdzie naprawdę wykonuje się sesja.

Czytaj: `apps/companion/package.json`, `tui_gateway/methods_session.py`, `tui_gateway/methods_companion_sessions.py`, `tui_gateway/methods_companion_projects.py`, `apps/desktop/src/store/projects.ts`; bieżące instrukcje wdrożenia. Nowy: `docs/plans/companion-mobile-evidence/baseline.md`.

1. Zapisać aktualne SHA aplikacji, runtime'u i Desktopu; potwierdzić działającą topologię bez wypisywania sekretów.
2. Sprawdzić capabilities i autoryzację odczytów oraz zapisów dla owner; wskazać braki zamiast przełączać na shared token.
3. Odróżnić uruchomiony proces Desktop/gateway od isolated dashboardu używanego przez Companion.
4. Zmapować wszystkie stare kryteria do nowej macierzy; nie zaczynać od przepisania kodu.
5. Uruchomić istniejące testy bazowe w izolacji; oznaczyć zastane błędy osobno.

**Bramka:** wszystkie autorytatywne źródła i właściciele wykonania określone. Czytelny błąd źródła niedostępnego, nie fałszywa pusta lista.

### P1. Udowodnić Desktop → Companion → Desktop

**Zależność:** P0. To pierwszy kod, przed pełnym redesignem.

Modyfikuj tylko potrzebne ścieżki: `apps/companion/src/gateway/companion-client.ts`, `gateway/types.ts`, `state/companion-store.ts`, `tui_gateway/methods_session.py` i serwis submit znaleziony po symbolu `prompt.submit`. Test: istniejące `apps/companion/src/gateway/companion-client.test.ts`, `state/companion-store.test.ts`, `tests/tui_gateway/test_companion_persisted_sessions_rpc.py`; nowy `tests/tui_gateway/test_companion_session_continuity.py`.

1. Dodać test: odczyt historii nie wywołuje create/resume/submit/aktywacji projektu.
2. Dodać test: jawny submit trafia do wybranego backendu/profilu/zapisanej sesji z poprawnym `cwd`.
3. Dodać test: równoległy dostęp z drugiego klienta nie tworzy drugiego runu.
4. Dodać test utraty odpowiedzi po przyjęciu promptu: reconnect nie wysyła go drugi raz.
5. Uzupełnić minimalną koordynację serwera, jeśli istniejący transport nie spełnia tych zasad.
6. Przeprowadzić realny round-trip na izolowanej sesji testowej, bez narzędzi mających skutki zewnętrzne.
7. Powtórzyć z zamkniętym oknem Desktop, restartem klienta i linią po kompakcji.

**Bramka:** zgodna logiczna sesja, profil, projekt, cwd, historia i pojedynczy run. Bez tego nie deklarować gotowego czatu. Jeśli konieczne jest duplikowanie domeny Hermes, zatrzymać tę ścieżkę i przedstawić konkretny blocker; Dashboard wraca do oceny tylko na podstawie tego dowodu.

### P2. Nowa nawigacja i projekty

**Zależność:** P1 dla połączenia z realnym czatem; statyczny wireflow może powstać równolegle z P1.

Modyfikuj: `apps/companion/src/app.tsx`, `app.test.tsx`, `features/directory/work-directory.tsx`, `directory-store.ts`, ich istniejące testy, `styles/app.css`, `styles/tokens.css`. Nowe: `src/features/chats/chats-home.tsx`, `chats-home.test.tsx`, `chats-navigation.ts`, `chats-navigation.test.ts` tylko jeśli oddzielenie widoku od directory jest potrzebne.

1. Test trzech destynacji i startu w Rozmowach.
2. Test Wszystkie / agent, Projekty / Ostatnie, Bez projektu, pustego projektu.
3. Test kompletnej paginacji i wyszukiwania starszej sesji bez work card.
4. Test kliknięcia sesji: od razu historia + composer; Back przywraca filtr i scroll.
5. Test deep linków nowych i dotychczasowych — stare URL-e Work/Library nie mogą się urwać.
6. Zaimplementować jedną ścieżkę nawigacji; ukryć stare wejścia Bot Chat/Teammates dopiero po regresji ich użytecznych funkcji.
7. Sprawdzić normalny, pusty, błędny i częściowo niedostępny stan na szerokości mobilnej.

**Bramka:** prosty wireflow działa na rzeczywistych rekordach, także bez propozycji i załączników.

### P3. Czytelny, niezawodny czat

**Zależność:** P1–P2.

Modyfikuj: `features/conversation/conversation.tsx`, `conversation.test.tsx`, `message-content.tsx`, `message-content.test.tsx`, `state/companion-store.ts`. Nowy: `src/features/conversation/session-drafts.ts` i `session-drafts.test.ts`, jeśli brak istniejącej analogicznej abstrakcji.

1. Test tytułu sesji, agenta i projektu w nagłówku; brak domyślnego przejścia do Main conversation.
2. Test draftów przy A → B → A, różnych profilach i restarcie; nie wkładać prywatnych szkiców do URL/logów.
3. Test mobilnego Enter i dyktowania/IME bez przypadkowego wysłania.
4. Test scroll podczas streamu i doczytania starszych wiadomości bez utraty pozycji.
5. Test zwiniętych narzędzi/kompakcji i bezpiecznej prezentacji contentu.
6. Test Stop, stanów praca/wysłano/nieznany/błąd oraz rekoncyliacji po utracie sieci.
7. Test bezpiecznego wylogowania: brak dostępu do poprzedniej historii/szkiców dla kolejnej tożsamości; polityka lokalnego cache jawna i sprawdzona.

**Bramka:** komfort czytania i pisania na Samsungu; utrata sieci nie zmienia tożsamości rozmowy ani nie powoduje podwójnego zadania.

### P4. Nowe sesje, bez nowego modelu projektów

**Zależność:** P1, P3.

Modyfikuj: `gateway/companion-client.ts`, `gateway/types.ts`, `state/companion-store.ts`, testy; serwerowy istniejący kontrakt `session.create` i przypisania projektu po odczycie implementacji.

1. Test nowego draftu bez zapisu pustej sesji.
2. Test pierwszego wysłania w istniejącym projekcie: jedna sesja i prawidłowa relacja widoczna na Desktop.
3. Test Bez projektu oraz widoku Wszystkie wymagającego wyboru agenta.
4. Test retry przy tworzeniu: zero drugiej sesji po niepewnym wyniku.
5. Zachować konfigurację projektu i pamięci; nie zmieniać aktywnego globalnego workspace innego klienta.

**Bramka:** mobile może rozpocząć i kontynuować pracę, a Desktop widzi ją bez importu.

### P5. Decyzje i prosty widok statusów

**Zależność:** P2 i poprawne linkowanie P1. Backendowe regresje WorkStore mogą iść równolegle z P3.

Modyfikuj: `features/work/work-inbox.tsx`, `work-store.ts`, istniejące testy; `features/attention/approval-card.tsx` tylko w razie potrzebnej korekty rozróżnienia typów zgód. Zachowaj `hermes_cli/companion_work_store.py` i istniejące kontrakty.

1. Test karty: pytanie, rekomendacja, skutki akcji, dokładne dowody, źródłowa sesja.
2. Test jednego kanonicznego badge'a bez podwójnego liczenia Attention i WorkStore.
3. Test grupowania topic/session/project i statusów na tych samych rekordach.
4. Test dwóch klientów akceptujących tę samą lub przestarzałą rewizję; potwierdzenie dopiero po odczycie serwera.
5. Test komentarz ≠ zgoda, przygotowanie ≠ publikacja, timeout ≠ automatyczny retry handoffu.
6. Zachować ranking, wyjaśnienia, ręczną korektę priorytetu i odłożenia; schować rozbudowane filtry do opcji.
7. Jedna karta przygotowania HOFFEE → dokładnie jedno logiczne zadanie w izolowanym trackerze. Produkcyjny test z efektem tylko po osobnej zgodzie.

**Bramka:** uproszczenie interfejsu nie osłabia żadnej kontroli decyzji.

### P6. Pliki w kontekście

**Zależność:** P2, P5 dla dowodów decyzji.

Modyfikuj: `features/library/library.tsx`, `library-types.ts`, `library.test.tsx`, `tui_gateway/companion_library.py` gdy potrzebne. Testy: `tests/tui_gateway/test_companion_library_rpc.py`.

1. Zamrozić listę dozwolonych kolekcji/typów/rozmiarów jako manifest odbioru, bez pełnego home.
2. Test plików z poziomu sesji/projektu/decyzji i globalnej listy, bez duplikacji tożsamości.
3. Naprawić bezpieczny JSON preview lub jawnie pozostawić uzgodniony fallback; nie ukrywać wcześniejszej luki.
4. Test oryginalnych pobranych bajtów, autoryzacji, traversal/symlink/race i niebezpiecznego HTML.
5. Test „wersja oceniana” kontra „najnowsza”: nigdy podmiana dowodu w starej decyzji.
6. Fizyczny test download/open/share dla każdej pozycji manifestu; brak telefonu blokuje tylko tę część odbioru.

**Bramka:** można znaleźć i użyć rezultatu bez ścieżki Maca; każdy obiecany typ ma dowód lub konkretny opis ograniczenia.

### P7. Powrót z tła, uprawnienia, zgodność i odzyskiwanie

**Zależność:** P3–P6; testy bezpieczeństwa od początku.

Modyfikuj tylko potrzebne: `gateway/connection.ts`, `security/owner-auth.ts`, `security/secret-store.ts`, `features/directory/directory-refresh.ts`, testy bezpieczeństwa Androida. Czytaj istniejące `android/app/src/main/java/com/hermes/companion/GatewayTokenPlugin.java` przed zmianą.

1. Test token persistence i revocation również dla otwartego streamu/downloadu.
2. Test Android background/foreground, reconnect oraz brak skoku fokusu.
3. Test 30-sekundowej docelowej świeżości katalogu przy zdrowym połączeniu i jawnego refresh.
4. Test nieaktualnego backendu: „Wymagana aktualizacja”, bez fallbacku do pustej sesji.
5. Test backup/restore decyzji, powiązań i retained evidence; historia/projekty według istniejącej strategii Hermes.
6. Test idempotentnych powiadomień. Nie dodawać Firebase/płatnej infrastruktury push do tego zakresu. Brak push po ubiciu aplikacji jawnie odróżnić od kontynuacji pracy serwerowej; Telegram nie jest potrzebny do odczytu lub decyzji.
7. Regresja istniejącej powłoki Mac Companion i Hermes Desktop, w tym bezpieczeństwo wspólnego gateway.

### P8. Odbiór i wydanie

**Zależność:** wszystkie powyższe bramki.

1. Zamrozić jeden końcowy commit/kandydat, klient i backend kompatybilne.
2. Uruchomić pełne wymagane testy i buildy; zebrać surowe wyniki z tego kandydata.
3. W izolacji przeprowadzić wszystkie przypadki macierzy poniżej.
4. Canary na istniejącej architekturze, po ponownej weryfikacji runbooka i aktywnych sesji; nie nadpisywać nowszego core starym branchem.
5. Dopiero w uprawnionym oknie wdrożyć zmiany; nie restartować głównego gateway tylko dla wygody. Jeśli to faktycznie konieczne, jawna bramka operacyjna z ochroną działających sesji.
6. Zainstalować aktualizację bez utraty logowania i danych; przetestować Samsung oraz zgodność MacBook.
7. Przeprowadzić próbę Pawła bez instrukcji. Poprawić tarcia UX, nie tłumaczyć ich instrukcją obsługi.
8. Wydać APK, zgodny backend, opis zmian, listę dowodów, znane ograniczenia i rollback. Nie publikować aplikacji w sklepie w ramach tego planu.

## 7. Macierz nowego odbioru — wszystkie wiersze początkowo PENDING

Nowe ID `MC-*` nie zastępują dowodów starych kryteriów. PASS wymaga ścieżki testu/dowodu i identyfikacji końcowego artefaktu.

| ID | Warunek | Dowód / zakaz |
|---|---|---|
| MC-01 | Zgodność baz i topologii | Potwierdzony backend/profil/właściciel runu; brak zgadywania po nazwie |
| MC-02 | Logowanie i restart | Owner login i natywne przechowanie credentials; brak tokenów w logach |
| MC-03 | 3 zakładki i sensowny start | Rozmowy/Decyzje/Pliki, powrót z tła bez resetu |
| MC-04 | Wszystkie profile i projekty dostępne zgodnie z prawami | Różne identyczne nazwy nie są scalane |
| MC-05 | Puste/niepowiązane projekty i sesje | Widoczne bez work card; zapisany rekord odróżniony od lokalnego draftu |
| MC-06 | Paginacja/archiwum/search | Starsze rekordy osiągalne; truthful counts/has_more, brak cichego ucięcia |
| MC-07 | Membership i renames z Desktop | Ten sam resolver projektu; brak frontendowych heurystyk |
| MC-08 | Odczyt bez wykonania | Zero create/resume/prompt/aktywacji przy przeglądaniu historii |
| MC-09 | Round-trip Desktop → Android → Desktop | Ta sama logiczna sesja, właściwy profil/projekt/cwd i obie wiadomości |
| MC-10 | Kompakcja/lineage | Aktualny tip bez drugiej logicznej rozmowy |
| MC-11 | Desktop zamknięty | Zapisana historia dostępna; wykonanie zgodnie z hostem, nie oknem klienta |
| MC-12 | Jednoczesne dwa urządzenia | Jeden run; druga wiadomość nie uruchamia równoległej tury |
| MC-13 | Niepewny submit i reconnect | Uzgodnienie z serwerem, brak ślepego retry i duplikacji |
| MC-14 | Rozłączenie telefonu | Praca serwerowa trwa; brak niejawnego Stop lub approval |
| MC-15 | Stop | Jawna akcja na prawidłowym runie z potwierdzonym wynikiem |
| MC-16 | Nowa sesja w projekcie / bez | Jedna zapisana sesja widoczna na Desktopie; agent wybrany jawnie |
| MC-17 | Drafty i zmiana sesji | A → B → A zachowuje poprawny tekst bez przecieku między profilami |
| MC-18 | Mobilna klawiatura/scroll | Enter newline, IME poprawne, brak skoku podczas czytania starszych treści |
| MC-19 | Bezpieczna prezentacja | Tool/compaction collapsed; brak sekretów i aktywnego HTML w origin aplikacji |
| MC-20 | Decyzje i typy zgód | Jedna karta/count; preparation i tool approval oddzielne |
| MC-21 | Rewizje i ponowienia decyzji | Stare zgody odrzucone, jedna decyzja i jedno logiczne przekazanie do trackera |
| MC-22 | Rankingi/grupowanie/odłożenia | Zachowane priorytety i wyjaśnienia; bez inflacji i zmiany fokusu |
| MC-23 | Tematy i bindings | Zachowane uprawnione operacje i relacje; zmiana nie uruchamia pracy |
| MC-24 | Kontekstowe deep linki | Decyzja ↔ sesja ↔ plik; stare linki działają lub dają uczciwy fallback |
| MC-25 | Library coverage | Każda kolekcja/typ w zamrożonym manifeście ma dowód preview/fallback/download/share |
| MC-26 | Retained evidence | Dokładna oceniana wersja, nie podmieniona przez Latest |
| MC-27 | Revocation i izolacja | Złe profile, agent token i wylogowanie nie dają dostępu do danych/streamu/cache |
| MC-28 | Stary/niedostępny backend | Uczciwy partial/update-required; brak fałszywego zera i utraty wyboru |
| MC-29 | Backup/restore i powiadomienia | Spójny restore oraz brak zduplikowanych próśb o decyzję |
| MC-30 | Android aktualizacja i użyteczność | Fizyczny Samsung; login, Back, keyboard, restart, network i share |
| MC-31 | Desktop/Mac regresja | Dotychczasowe create/resume/project grouping i Companion Mac bez regresji |
| MC-32 | Final suites i bezpieczeństwo odbioru | Testy na jednym kandydacie, zero nieautoryzowanych skutków zewnętrznych |

### Zachowanie dotychczasowych 36 wymagań

Uwaga: stary handoff i plik `hermes-companion-release-evidence/AC-MATRIX.md` mają **różne znaczenia tych samych numerów AC**. Nie łączyć ich po samym numerze. P0 tworzy dwa namespace'y: `H6-AC-*` (handoff z 6 września) oraz `R-AC-*` (release-evidence).

Mapowanie H6:

| Handoff | Nowa bramka |
|---|---|
| H6-AC-01–03 | MC-05, MC-16 |
| H6-AC-04 | MC-08, MC-11 |
| H6-AC-05 | MC-01, MC-04, MC-27 |
| H6-AC-06–07 | MC-06 |
| H6-AC-08 | MC-06, MC-19 |
| H6-AC-09–10 | MC-07, MC-10 |
| H6-AC-11 | MC-05, MC-07 |
| H6-AC-12 | MC-28 |
| H6-AC-13 | MC-08; zakaz mutacji przy odczycie pozostaje |
| H6-AC-14 | MC-09, MC-24; read-only-only jako limit zastąpione kontynuacją |
| H6-AC-15–17 | MC-23, MC-24, MC-28; zachować 30 s refresh i semantykę filtrów |
| H6-AC-18–22 | MC-22 |
| H6-AC-23–26 | MC-20, MC-21 |
| H6-AC-27–28 | MC-19, MC-27 |
| H6-AC-29–30 | MC-25, MC-26 |
| H6-AC-31–32 | MC-14, MC-30 |
| H6-AC-33–34 | MC-29 |
| H6-AC-35–36 | MC-31, MC-32 |

Mapowanie release-evidence:

| Release matrix | Nowa bramka |
|---|---|
| R-AC-01–02 | MC-02, MC-27, MC-30 |
| R-AC-03–07 | MC-04, MC-05, MC-23, MC-24 |
| R-AC-08–10 | MC-06, MC-08, MC-09, MC-24 |
| R-AC-11–14 | MC-23, MC-24 |
| R-AC-15–17 | MC-28, MC-30; zachować 30 s refresh |
| R-AC-18–22 | MC-20, MC-22 |
| R-AC-23–26 | MC-21 |
| R-AC-27–30 | MC-25, MC-26, MC-27 |
| R-AC-31–32 | MC-14, MC-30 |
| R-AC-33–34 | MC-29 |
| R-AC-35–36 | MC-31, MC-32 |

Mapowanie jest śladem wymagań, nie dowodem PASS. W wykonawczym ledgerze każdy stary wiersz rozwinąć osobno i podpiąć konkretny test; nie oznaczać grupy PASS na podstawie jednego happy path.

## 8. Polecenia weryfikacyjne

Uruchamiać z właściwego worktree/venv; przed wykonaniem potwierdzić aktualne manifesty. Nowy test ciągłości dodać po jego utworzeniu.

Z `apps/companion`:

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build:web`
- `npm run android:debug` — development package, nie dowód release signing.
- `npm run android:release` — dopiero po sprawdzeniu istniejącego procesu podpisu i uprawnień, nie ujawniać sekretów.

Z repo:

- `scripts/run_tests.sh tests/tui_gateway/test_companion_persisted_sessions_rpc.py tests/tui_gateway/test_companion_library_rpc.py tests/tui_gateway/test_companion_organization_mutations_rpc.py tests/tui_gateway/test_companion_topics_rpc.py tests/tui_gateway/test_companion_attention.py`
- `scripts/run_tests.sh tests/hermes_cli/test_companion_work.py tests/hermes_cli/test_companion_organization.py tests/hermes_cli/test_companion_kanban_bridge.py tests/hermes_cli/test_companion_backup_restore.py tests/plugins/test_kanban_companion_intake.py`
- `scripts/run_tests.sh tests/tui_gateway/test_projects_rpc.py tests/tui_gateway/test_project_tree.py tests/hermes_cli/test_projects_db.py`
- Po dodaniu: `scripts/run_tests.sh tests/tui_gateway/test_companion_session_continuity.py`.

Dołączyć testy faktycznie zmienionych shared/session/run paths i Desktopu według ich bieżących manifestów. Zielone mocki nie zastępują dwóch klientów i realnego transportu. Oczekiwany wynik: czyste zakończenie, brak regresji i zapisane dowody zachowania; nie zakładać z góry liczby testów.

## 9. Wdrożenie i rollback

Dotychczasowy runbook: `/Users/atlasweber/.hermes/profiles/atlas/workspace/hermes-companion-release-evidence/DEPLOY-ROLLBACK.md`. To punkt wyjścia, nie zgoda na wykonanie historycznych komend bez weryfikacji.

- Przed wyborem bazy wdrożenia porównać aktualny core z branchem Companion; nie cofać nowszego działającego Hermesa całym starym worktree.
- Addytywne capabilities; starszy klient musi dać bezpieczny fallback. Migracje danych wyłącznie konieczne, z testem zgodności i restore.
- Rollback frontend/backend oddzielnie; zachować dane powstałe po aktualizacji. Przy niekompatybilnej migracji nie odtwarzać starego backupu na żywych danych bez jawnej decyzji.
- Canary nie może uruchomić drugiego wykonania produkcyjnej sesji tylko dlatego, że czyta tę samą bazę.
- Zmiana samego UI nie jest powodem do restartu głównego gateway.
- Po zewnętrznym zapisie/read-back: login, capabilities, rzeczywisty profil, sesja, plik, status usługi i brak naruszenia aktywnych zadań.
- Nie usuwać starego APK i rollback config do czasu odebrania aktualizacji. Klucze i podpis pozostają w dotychczasowym bezpiecznym magazynie.

## 10. Co robi Atlas, a co wymaga Pawła

Atlas po uruchomieniu realizacji: kod, izolowane testy, integracja, builds, scenariusze błędów, dokumentacja, kontrola kompatybilności i przygotowanie wdrożenia. Praca niezależna od telefonu trwa również, gdy Samsung jest offline.

Paweł: tylko logowanie/zgody systemowe lub odblokowanie urządzenia, których nie da się wykonać zdalnie, oraz krótki odbiór intuicyjności. Rzeczywiste zgody biznesowe/publikacyjne pozostają odrębne. Nie pytać ponownie o każdy pakiet zatwierdzonego zakresu.

Plan nie wymaga Notion, Telegrama, Open WebUI, nowego konta SaaS, abonamentu ani przebudowy agentów. Nie dodaje własnego terminala, edytora dokumentów, panelu administracyjnego ani kompletnego klona Desktopu.

## 11. Definition of Done

Wydanie gotowe dopiero, gdy:

- wszystkie MC i zachowane stare wymagania mają konkretne dowody lub jawnie zaakceptowane ograniczenie; brak przemianowania PENDING na PASS;
- round-trip między Desktop i Samsungiem działa na końcowym kandydacie;
- nie tworzymy drugiej sesji/historii, nie resetujemy kontekstu, nie przerywamy pracy po rozłączeniu;
- ekran jest prosty w realnym użyciu, nie tylko na makiecie;
- Decyzje i Pliki zachowują obecne reguły bezpieczeństwa i powiązania;
- pełne wymagane suites i aktualizacja klienta przechodzą, rollback jest przygotowany;
- użytkownik otrzymuje działający pakiet i krótki opis ograniczeń, nie sam raport z testów.

**Stan przy dostarczeniu tego planu:** sprawdzono bazę, ścieżki, istniejące kontrakty i sprzeczności dokumentów. Nie zmieniono kodu produktu, nie uruchomiono testów aplikacji, nie wykonano wdrożenia ani transakcji biznesowych. Następna praca wykonawcza zaczyna się od P0/P1, nie od ponownego researchu rynku.
