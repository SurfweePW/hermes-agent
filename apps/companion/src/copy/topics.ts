/**
 * First-party Polish copy for topic organization and its shared work projections.
 *
 * Vocabulary contract:
 * - topic        -> "Temat"
 * - profile      -> "Profil"
 * - project      -> "Projekt"
 * - conversation -> "Rozmowa"
 * - decision     -> "Decyzja"
 * - file         -> "Plik"
 *
 * Proper nouns, source values and technical identifiers are never translated.
 */
export const topicsCopy = {
  filters: {
    search: 'Szukaj tematów',
    collection: 'Kolekcja',
    lifecycle: 'Cykl życia',
    verifiedStatus: 'Zweryfikowany status',
    sort: 'Sortowanie',
    sortLabel: 'Sortowanie tematów',
    recentlyUpdated: 'Ostatnio zaktualizowane',
    name: 'Nazwa',
    active: 'Aktywne filtry tematów',
    clear: 'Wyczyść filtry',
    topicChip: (query: string) => `Temat: ${query}`,
    collectionChip: (collection: string) => `Kolekcja: ${collection}`,
    lifecycleChip: (lifecycle: string) => `Cykl życia: ${lifecycle}`,
    verifiedOnly: 'Tylko zweryfikowany cykl życia',
    lifecycleOptions: {
      active: 'Aktywny',
      completed: 'Ukończony',
      archived: 'Archiwalny'
    }
  },
  coverage: {
    unknown: (loaded: number) => `Wczytano ${loaded} tematów · łączna liczba nieznana`,
    known: (loaded: number, total: number) => `Wczytano ${loaded} z ${total} tematów`,
    sourceLabel: 'Zakres źródeł tematów'
  },
  empty: {
    filteredCopy: 'Pełny przefiltrowany wynik nie zawiera pasujących tematów.',
    completeCopy: 'Rejestr organizacji zwrócił pełną pustą listę tematów.',
    incompleteCopy: 'Companion nie może uznać tego katalogu za pusty, ponieważ co najmniej jedno autoryzowane źródło jest niedostępne, niepełne lub nadal się wczytuje.',
    noMatches: 'Brak pasujących tematów',
    none: 'Brak tematów',
    loading: 'Wczytywanie zweryfikowanych tematów…',
    updateRequired: 'Wymagana aktualizacja backendu',
    unavailable: 'Zakres tematów niedostępny'
  },
  loadMore: (profile: string) => `Wczytaj więcej tematów z profilu ${profile}`,
  row: {
    nextActionUnknown: 'Następne przydatne działanie nieznane'
  },
  detail: {
    back: '← Wróć do tematów',
    kicker: (collection: string, profile: string) => `Temat · ${collection} · Profil: ${profile}`,
    readOnly: 'Szczegóły organizacji tylko do odczytu',
    tabsLabel: 'Szczegóły tematu',
    tabs: {
      overview: 'Przegląd',
      needsMe: 'Wymaga mnie',
      work: 'Praca',
      files: 'Pliki',
      sources: 'Źródła'
    },
    waiting: 'Oczekiwanie na projekcję organizacji tylko do odczytu.',
    loading: 'Wczytywanie zweryfikowanego tematu…',
    unavailable: 'Temat niedostępny',
    verifiedLifecycle: 'Zweryfikowany cykl życia',
    observed: 'zaobserwowano',
    statusAuthority: 'Źródło statusu',
    nextUsefulAction: 'Następne przydatne działanie',
    updated: 'Zaktualizowano',
    notAvailable: 'Niedostępne w tym źródle',
    linkedFiles: 'Powiązane pliki Biblioteki',
    linkedFilesCopy: 'Otwórz autoryzowany filtr powiązań Biblioteki dla tego tematu.',
    viewFiles: 'Wyświetl pliki w Bibliotece',
    openProject: 'Otwórz projekt',
    openSession: 'Otwórz rozmowę',
    loadingSources: 'Wczytywanie źródeł…',
    loadingSourcesCopy: 'Ustalanie autoryzowanych rekordów aktywnych źródeł.',
    noSources: 'Brak odwołań do źródeł organizacji',
    sourcesUnavailable: 'Źródła niedostępne'
  },
  work: {
    loading: 'Wczytywanie zweryfikowanej pracy…',
    loadingCopy: 'Ustalanie autoryzowanych powiązań organizacji i trwałych rekordów pracy.',
    unavailable: 'Praca niedostępna',
    unverifiedCopy: 'Nie udało się zweryfikować autoryzowanej projekcji.',
    noNeedsMe: 'Brak pozycji wymagających mnie',
    noLinked: 'Brak powiązanej pracy',
    incomplete: 'Niepełny zakres pracy',
    completeEmptyCopy: 'Pełna autoryzowana projekcja powiązań nie zwróciła żadnych pozycji.',
    incompleteCopy: 'Nie zgłoszono pustego wyniku, ponieważ zakres powiązań jest niepełny.',
    sourceMissing: 'Brak rekordu źródłowego',
    revision: 'wersja',
    next: 'Dalej'
  },
  collection: {
    completeEmptyCopy: 'Rejestr organizacji zwrócił pełną pustą kolekcję.',
    partialCopy: 'Dostępna jest tylko częściowa autoryzowana projekcja; nie zgłoszono pustego wyniku.',
    unsupportedCopy: 'Brak kontraktu zapytania tylko do odczytu; nie zgłoszono pustego wyniku.'
  }
} as const
