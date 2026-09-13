/**
 * First-party Polish copy for the canonical file Library surface.
 *
 * Vocabulary contract:
 * - Library / files -> "Pliki"
 * - profile         -> "Profil"
 * - project         -> "Projekt"
 * - topic           -> "Temat"
 * - session         -> "Rozmowa"
 *
 * Gateway values, file names, collection names, identifiers, MIME types and
 * artifact contents are never translated.
 */
export const libraryCopy = {
  errors: {
    request: 'Żądanie dotyczące plików nie powiodło się. Spróbuj ponownie.',
    integrityUnavailable: 'Nie udało się zweryfikować integralności oryginalnego artefaktu.',
    integrityFailed: 'Oryginalny artefakt nie przeszedł weryfikacji integralności.',
    invalidChunk: 'Pliki zwróciły nieprawidłowy fragment zawartości.',
    changed: 'Artefakt zmienił się podczas przesyłania. Spróbuj ponownie.',
    incompleteArtifact: 'Pliki zwróciły niekompletny artefakt.',
    noProgress: 'Przesyłanie pliku nie postępuje.',
    transferLimit: 'Przesyłanie pliku przekroczyło limit bezpieczeństwa.',
    invalidCursor: 'Pliki zwróciły nieprawidłowy kursor stronicowania.',
    duplicateArtifacts: 'Pliki zwróciły zduplikowane artefakty na różnych stronach.',
    incompleteResults: 'Pliki zwróciły niekompletny zestaw wyników.',
    unavailableReference: 'Wskazany artefakt w plikach jest niedostępny.',
    relationship: 'Nie udało się zweryfikować wskazanego powiązania pliku. Przypinanie jest wyłączone.',
    unsafeHtml: 'Podgląd HTML nie spełnia wymagań statycznego sandboxa.',
    invalidPdf: 'Podgląd PDF nie zawierał zweryfikowanych danych PDF.',
    safePreviewUnavailable: 'Bezpieczny podgląd tego artefaktu jest niedostępny.'
  },
  common: {
    dateUnavailable: 'Data niedostępna',
    latest: 'Najnowsza',
    currentCollection: 'Bieżąca kolekcja',
    reviewedVersion: 'Wersja zatwierdzona',
    retainedVersion: 'Wersja zachowana',
    unavailable: 'Niedostępne'
  },
  detail: {
    back: '← Wróć do plików',
    loading: 'Wczytywanie szczegółów artefaktu…',
    return: 'Wróć do plików',
    missingVersion: (version: string) => `Wskazana zachowana wersja ${version} jest niedostępna.`,
    canonical: 'Kanoniczny artefakt w plikach',
    availability: 'Dostępność',
    backend: 'Backend',
    artifactId: 'ID artefaktu',
    version: 'Wersja',
    origin: 'Pochodzenie',
    versionOrigin: 'Pochodzenie wersji',
    noData: 'Brak danych.',
    versionLabel: 'Wersja',
    loadPreview: 'Wczytaj bezpieczny podgląd',
    loadingPreview: 'Wczytywanie podglądu…',
    download: 'Pobierz oryginał',
    downloading: 'Pobieranie…',
    markReviewed: 'Oznacz podglądaną wersję jako zatwierdzoną',
    markingReviewed: 'Oznaczanie jako zatwierdzona…',
    latestLive: 'Najnowsza wersja bieżąca',
    reviewed: 'Zatwierdzona wersja kanoniczna',
    preview: 'Bezpieczny podgląd',
    jsonFallback: 'JSON jest wyświetlany jako nieaktywny zwykły tekst; osadzona zawartość nie jest wykonywana.',
    imageAlt: (filename: string) => `Podgląd ${filename}`,
    staticTitle: (filename: string) => `Statyczny podgląd ${filename}`,
    pdfTitle: (filename: string) => `Podgląd PDF ${filename}`
  },
  chrome: {
    kicker: 'Autoryzowane materiały',
    title: 'Pliki',
    lede: 'Przeszukuj skonfigurowane kanoniczne kolekcje wyników. Ścieżki urządzenia i dowolne przeglądanie plików nie są udostępniane.',
    refresh: 'Odśwież pliki'
  },
  filters: {
    search: 'Szukaj nazw i metadanych',
    type: 'Typ',
    allTypes: 'Wszystkie typy',
    unsupportedPreview: 'Nieobsługiwany podgląd',
    typeLabels: { markdown: 'Markdown', text: 'Tekst', image: 'Obraz', pdf: 'PDF', html: 'HTML' },
    date: 'Data',
    anyDate: 'Dowolna data',
    last7Days: 'Ostatnie 7 dni',
    last30Days: 'Ostatnie 30 dni',
    collection: 'Kolekcja',
    allCollections: 'Wszystkie kolekcje',
    status: 'Status',
    allStatuses: 'Wszystkie statusy',
    reviewed: 'Zatwierdzone',
    live: 'Bieżące',
    profile: 'Profil',
    allProfiles: 'Wszystkie profile',
    allAuthorizedProfiles: 'Wszystkie autoryzowane profile',
    unconfigured: 'nieskonfigurowany',
    project: 'Projekt',
    projectId: 'ID projektu',
    topic: 'Temat',
    topicId: 'ID tematu',
    session: 'Rozmowa',
    sessionId: 'ID rozmowy',
    active: 'Aktywne filtry',
    clear: 'Wyczyść filtry'
  },
  list: {
    loading: 'Wczytywanie pełnej listy plików…',
    unavailable: 'Pliki niedostępne',
    retry: 'Spróbuj ponownie',
    unconfigured: 'Pliki nie są skonfigurowane',
    noCollections: 'Dla tego profilu nie skonfigurowano żadnych autoryzowanych kolekcji.',
    partial: 'Zakres plików jest częściowy',
    partialFallback: 'Co najmniej jedna skonfigurowana kolekcja jest niedostępna. Wyniki są niekompletne.',
    noArtifacts: 'Nie znaleziono artefaktów',
    noMatches: 'Żadne artefakty w dostępnych kolekcjach nie pasują do tych filtrów.',
    empty: 'Skonfigurowane pliki są puste.',
    completeCount: (count: number) => `${count} artefaktów na wszystkich dostępnych stronach.`,
    partialCount: (count: number) => `Znaleziono ${count} artefaktów w dostępnych kolekcjach; nie jest to pełna liczba.`,
    collection: 'Kolekcja:',
    profile: 'Profil:',
    currentVersion: 'Wersja bieżąca'
    ,type: 'Typ:',
    updated: 'Zaktualizowano:'
  }
} as const
