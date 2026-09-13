/**
 * First-party Polish copy for the durable work and decision surfaces.
 *
 * Vocabulary contract:
 * - conversation / session -> "Rozmowa"
 * - profile                -> "Profil"
 * - project                -> "Projekt"
 * - topic                  -> "Temat"
 * - library                -> "Pliki"
 * - decisions              -> "Decyzje"
 *
 * Gateway values, user and agent content, titles, names, identifiers and file
 * references are never translated.
 */
export const workCopy = {
  chrome: {
    kicker: 'Trwała praca biznesowa',
    title: 'Do decyzji',
    refresh: 'Odśwież pracę',
    lede: 'Pomysły, decyzje dotyczące przygotowania i ukierunkowana dyskusja, współdzielone między Twoimi urządzeniami. Niezależne od uprawnień narzędzi w aktywnej rozmowie.',
    viewOptions: 'Opcje widoku',
    filtersLabel: 'Filtry pracy',
    back: 'Wróć do pracy'
  },
  status: {
    unsupported: 'Ten gateway nie obsługuje trwałej skrzynki pracy. Zaktualizuj serwer, aby korzystać z decyzji biznesowych; prośby z aktywnych rozmów pozostają dostępne poniżej.',
    loading: 'Weryfikowanie trwałej pracy… Decyzje są wyłączone do czasu odświeżenia.',
    unavailable: 'Nie udało się zweryfikować pracy. Zachowano ostatni widok; połącz się ponownie i odśwież przed podjęciem decyzji.'
  },
  coverage: {
    incomplete: (incomplete: number, total: number) => `${incomplete} z ${total} źródeł pracy jest niepełnych`,
    label: 'Zakres źródeł pracy',
    incompleteStatus: (status: string) => `Niepełne (${status})`,
    complete: 'Pełne',
    lastSuccess: 'Ostatnie powodzenie',
    never: 'nigdy'
  },
  group: {
    label: 'Grupuj według',
    topic: 'Temat',
    session: 'Rozmowa',
    project: 'Projekt'
  },
  filters: {
    needsMe: 'Do decyzji',
    inProgress: 'W toku',
    ideas: 'Pomysły',
    history: 'Historia i odłożone'
  },
  summary: {
    revision: 'Rewizja',
    recommended: 'Rekomendowane',
    whyHere: 'Dlaczego tutaj:',
    nextStep: 'Następny krok:',
    tradeOff: 'Kompromis:',
    freshness: 'Świeżość oceny:',
    evidence: 'Dowody rekomendacji:',
    notAssessed: 'Nie oceniono',
    noEvidence: 'Nie dostarczono dowodów',
    benefit: 'Korzyść',
    confidence: 'Pewność',
    unassessed: 'nieoceniona',
    unknown: 'nieznana',
    activeOverride: 'Aktywne nadpisanie przeglądu',
    reviewOverride: 'Nadpisanie przeglądu',
    empty: 'Brak pracy w tym widoku. Praca ukończona, odrzucona i odłożona pozostaje w historii.'
  },
  brief: {
    about: 'O co chodzi',
    fallback: 'To ustrukturyzowana prośba o przygotowanie.',
    proposedWhy: 'Dlaczego to proponujemy',
    decisionScope: 'Zakres decyzji:',
    authorizedScope: 'Zakres autoryzowany',
    costBoundary: 'Granica kosztu i aktywacji',
    notAuthorized: 'Nie autoryzuje tego',
    files: 'Pliki wskazane w tej prośbie'
  },
  tracker: {
    observed: 'Zaobserwowano',
    blocker: 'Blokada:',
    result: 'Wynik:',
    acknowledged: 'Przekazanie do trackera potwierdzone:',
    currentEvidence: 'Bieżące dowody z trackera',
    completionEvidence: 'Dowody ukończenia',
    history: 'Historia statusów trackera',
    empty: 'Brak zapisanego statusu trackera.'
  },
  artifact: {
    markdown: 'Raport Markdown',
    pdf: 'Raport PDF',
    data: 'Plik danych',
    spreadsheetData: 'Dane arkusza',
    spreadsheet: 'Arkusz',
    image: 'Obraz',
    video: 'Wideo',
    audio: 'Audio',
    html: 'Raport HTML',
    file: 'Plik',
    unverified: 'Niezweryfikowane odwołanie do pliku',
    openSource: 'Otwórz źródło ↗',
    open: 'Otwórz w plikach',
    openLabel: (label: string) => `Otwórz ${label}`,
    openInFilesLabel: (label: string) => `Otwórz ${label} w plikach`
  },
  detail: {
    businessDecision: 'Decyzja biznesowa',
    needed: 'Czego potrzebujemy od Ciebie',
    neededFallback: 'Nie określono oczekiwanej decyzji.',
    whyNow: 'Dlaczego teraz',
    recommendation: 'Rekomendacja',
    serverRecommendation: 'Rekomendacja serwera:',
    priorityContext: 'Kontekst priorytetu:',
    clickEffect: 'Co zmieni kliknięcie',
    approveEffect: 'autoryzuje wyłącznie przygotowanie tej rewizji; nie publikuje, nie wysyła, nie wydaje pieniędzy i nie zmienia systemu produkcyjnego.',
    changesEffect: 'zapisuje żądane poprawki i nie publikuje ani nie autoryzuje wykonania.',
    reminderEffect: 'odkłada decyzję do terminu; gdy termin nadejdzie, wraca ona do decyzji.',
    openProject: 'Otwórz projekt',
    openSourceSession: 'Otwórz rozmowę źródłową',
    noSourceSession: 'Rozmowa źródłowa nie jest powiązana z tym rekordem.',
    owner: 'Właściciel',
    unassigned: 'Nieprzypisane',
    currentDecision: 'Bieżąca decyzja',
    noDecision: 'Jeszcze nie podjęto decyzji',
    snoozedUntil: 'Odłożone do',
    evidence: 'Dowody, pliki i raporty',
    noEvidence: 'Nie dostarczono plików ani odnośników pomocniczych.',
    proposedScope: 'Proponowany zakres przygotowania',
    excludedScope: 'Zakres wyłączony',
    previews: 'Podglądy i odnośniki',
    noPreviews: 'Nie dostarczono dodatkowych podglądów ani odnośników.',
    decisionHistory: 'Historia decyzji',
    noDecisions: 'Brak zapisanych decyzji.',
    scope: 'Zakres:',
    discussion: 'Ukierunkowana dyskusja',
    discussionHelp: 'Komentarze nie są zgodą. Może je dodawać tylko aktualnie zweryfikowany właściciel; połączenia przez współdzielony token i połączenia agentów pozostają tylko do odczytu.',
    discussionLabel: 'Dyskusja / żądane poprawki',
    addComment: 'Dodaj komentarz',
    decisionForRevision: (revision: number) => `Decyzja dla rewizji ${revision}`,
    saving: 'Zapisywanie i weryfikacja…',
    readOnly: 'Ta praca jest obecnie tylko do odczytu.'
  },
  decisions: {
    approve: 'Zatwierdź',
    requestChanges: 'Poproś o poprawki',
    remind: 'Przypomnij za 2 godziny',
    recommended: 'Rekomendowane',
    validation: 'Opisz potrzebne zmiany w polu dyskusji.'
  },
  priority: {
    title: 'Nadpisanie priorytetu',
    help: 'Rekomendowana kolejność pozostaje stabilna, gdy ta karta jest otwarta. Zweryfikowana kolejność zostanie zastosowana po powrocie do listy.',
    label: 'Etykieta priorytetu',
    reason: 'Powód',
    expiry: 'Wygasa (wymagane)',
    chooseFuture: 'Wybierz przyszły termin wygaśnięcia tego nadpisania.',
    chooseExpiry: 'Wybierz termin wygaśnięcia tego nadpisania.',
    set: 'Ustaw priorytet',
    restore: 'Przywróć rekomendowane',
    ownerRequired: 'Zmiany priorytetu wymagają połączenia uwierzytelnionego przez właściciela i zgodnego gatewaya.'
  },
  ownerSignIn: {
    ariaLabel: 'Dostęp właściciela do decyzji',
    boundary: 'Współdzielony token serwera nie jest zgodą człowieka. Logowanie właściciela jest niezależne od uprawnień narzędzi wykonawczych.',
    completeInBrowser: 'Dokończ logowanie właściciela w przeglądarce systemowej. Nie podjęto żadnej decyzji.',
    returned: 'Proces logowania został zakończony. Dostęp do decyzji określa odświeżona funkcja serwera poniżej, a nie współdzielony token ani ten przycisk.',
    connectFailed: 'Nie udało się zweryfikować logowania właściciela ani ponownego połączenia. Decyzjami nadal zarządza serwer; nie wysłano żadnego zatwierdzenia.',
    credentialsCleared: 'Zapisane dane uwierzytelniające właściciela do decyzji zostały usunięte, a połączenie właściciela zamknięte.',
    signOutFailed: 'Nie udało się zweryfikować wylogowania właściciela. Połączenie właściciela zamknięto; spróbuj ponownie usunąć zapisane dane uwierzytelniające.',
    signOut: 'Wyloguj z dostępu do decyzji',
    working: 'Przetwarzanie…',
    signIn: 'Zaloguj się, aby podejmować decyzje',
    clearSaved: 'Usuń zapisane logowanie właściciela',
    unavailable: 'Natywne logowanie właściciela jest niedostępne w tym kliencie. Użyj połączenia z panelem uwierzytelnionego człowieka; obejście zatwierdzania za pomocą tokenu nie jest dostępne.'
  }
} as const
