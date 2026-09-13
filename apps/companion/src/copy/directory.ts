import type { DirectoryStatus } from '../features/directory/directory-store'

export const directoryCopy = {
  store: {
    sessionsFailure: (needsUpdate: boolean) => needsUpdate ? 'Rozmowy wymagają aktualizacji backendu.' : 'Nie udało się zweryfikować rozmów.',
    projectsFailure: (needsUpdate: boolean) => needsUpdate ? 'Projekty wymagają aktualizacji backendu.' : 'Nie udało się zweryfikować projektów.',
    unauthorized: 'Ten profil nie jest autoryzowany w bieżącym połączeniu.',
    topicsUpdateRequired: 'Tematy wymagają aktualizacji backendu.',
    topicsUnverified: 'Nie udało się zweryfikować tematów.',
    projectMembershipUnverified: 'Nie udało się w pełni zweryfikować rozmów należących do projektu.',
    sourceNotFound: 'Nie znaleziono rekordu źródłowego.',
    liveSourceUnverified: 'Nie udało się zweryfikować rekordu źródłowego.',
    browsingUpdateRequired: 'Pełne przeglądanie wymaga aktualizacji backendu.',
    reconnectSource: 'Połącz ponownie, aby zweryfikować to źródło.',
    reconnectTopics: 'Połącz ponownie, aby zweryfikować tematy.',
    reconnectDetails: 'Połącz ponownie, aby zweryfikować szczegóły.',
    relationshipsUnverified: 'Nie udało się zweryfikować części autoryzowanych powiązań lub zapisów źródłowych.',
    entityWorkFailure: (needsUpdate: boolean) => needsUpdate
      ? 'Autoryzowana praca i zadania wymagające uwagi wymagają aktualizacji backendu.'
      : 'Nie udało się zweryfikować autoryzowanej pracy i zadań wymagających uwagi.',
    topicRelationshipsUnverified: 'Nie udało się zweryfikować części autoryzowanych powiązań tematów.',
    projectDetailsFailure: (needsUpdate: boolean) => needsUpdate ? 'Szczegóły projektu wymagają aktualizacji backendu.' : 'Nie udało się zweryfikować szczegółów projektu.',
    sessionHistoryFailure: (needsUpdate: boolean) => needsUpdate ? 'Historia rozmowy wymaga aktualizacji backendu.' : 'Nie udało się zweryfikować historii rozmowy.',
    topicDetailsFailure: (needsUpdate: boolean) => needsUpdate ? 'Szczegóły tematu wymagają aktualizacji backendu.' : 'Nie udało się zweryfikować szczegółów tematu.',
    olderHistoryUnverified: 'Nie udało się zweryfikować starszej historii rozmowy.',
    completeProjectMembershipUnverified: 'Nie udało się zweryfikować pełnego przypisania rozmów do projektu.',
    exactSessionUnresolved: 'Nie udało się ustalić dokładnego zapisu rozmowy.',
    organizationProjectionRequired: 'Powiązania tematów wymagają autoryzowanego zapisu organizacji.',
    sourceChanged: {
      projectDetails: 'Źródło zmieniło się podczas wczytywania szczegółów projektu.',
      sessionHistory: 'Źródło zmieniło się podczas wczytywania historii rozmowy.',
      topicDetails: 'Źródło zmieniło się podczas wczytywania szczegółów tematu.',
      projectMembership: 'Źródło zmieniło się podczas wczytywania przypisania rozmów do projektu.'
    }
  },
  status: {
    idle: 'Bezczynne',
    loading: 'Wczytywanie',
    ready: 'Gotowe',
    unsupported: 'Wymagana aktualizacja backendu',
    error: 'Błąd',
    offline: 'Offline'
  } satisfies Record<DirectoryStatus, string>,
  projectType: {
    desktop_project: 'Projekt desktopowy',
    business_project: 'Projekt biznesowy',
    discovered_repository: 'Wykryte repozytorium',
    unknown: 'Nieznany typ projektu'
  },
  freshnessUnknown: 'Aktualność nieznana',
  profileFallback: 'Profil',
  countUnknown: (noun: string) => `Liczba (${noun}) nieznana`,
  chrome: {
    recentConversations: 'Ostatnie rozmowy',
    kicker: 'Katalogi źródeł',
    title: 'Praca',
    lede: 'Przeglądaj zapisane rekordy źródłowe, także puste i niepowiązane. Samo przeglądanie nie aktywuje projektu ani nie wznawia rozmowy.',
    refresh: 'Odśwież źródła',
    tabsLabel: 'Katalogi pracy',
    topics: 'Tematy',
    projects: 'Projekty',
    sessions: 'Rozmowy'
  },
  coverage: {
    notConfigured: 'Zakres źródeł nie jest skonfigurowany',
    noProfiles: 'Nie zgłoszono żadnych autoryzowanych profili źródłowych.',
    label: 'Zakres źródeł',
    complete: 'Pełny zakres źródła',
    sessions: 'Rozmowy',
    projects: 'Projekty',
    fresh: 'Aktualność',
    genericWarning: 'Nie udało się w pełni zweryfikować tego źródła.',
    completeLabel: 'Pełny',
    incompleteLabel: 'Niepełny',
    noWarnings: 'Źródło nie zgłosiło ostrzeżeń.'
  },
  filters: {
    searchTitles: 'Szukaj nazw',
    source: 'Źródło',
    profile: 'Profil',
    origin: 'Pochodzenie',
    topic: 'Temat',
    project: 'Projekt',
    type: 'Typ',
    from: 'Od',
    fromDate: 'Data od',
    to: 'Do',
    toDate: 'Data do',
    visibility: 'Widoczność',
    allEligible: 'Wszystkie dostępne',
    current: 'Bieżące',
    hidden: 'Ukryte',
    archived: 'Archiwalne',
    sort: 'Sortowanie',
    recentActivity: 'Ostatnia aktywność',
    name: 'Nazwa',
    groupBy: 'Grupuj według',
    noGrouping: 'Bez grupowania',
    sourceBackend: 'Backend źródłowy',
    active: 'Aktywne filtry',
    clear: 'Wyczyść filtry',
    noValues: 'Brak zgłoszonych wartości',
    unknownOrigin: 'Nieznane pochodzenie',
    results: 'Wyniki katalogu'
  },
  empty: {
    waiting: 'Czekamy na autoryzowane API źródeł.',
    incomplete: 'Co najmniej jedno źródło nie może zweryfikować tego katalogu, dlatego wynik nie jest potwierdzoną pustą listą.',
    filtered: 'Wyczyść co najmniej jeden filtr, aby przywrócić dostępne rekordy.',
    complete: 'Każde skonfigurowane źródło zwróciło pełną pustą listę.',
    loading: 'Wczytywanie zweryfikowanych rekordów źródłowych…',
    updateRequired: 'Wymagana aktualizacja backendu',
    unavailable: 'Zakres źródeł niedostępny',
    noMatches: 'Brak pasujących pozycji',
    none: 'Brak dostępnych rekordów'
  },
  loadOlder: (profile: string) => `Wczytaj starsze dane z profilu ${profile}`,
  badges: {
    archived: 'Archiwum',
    hidden: 'Ukryta'
  },
  sourceDetail: {
    authorizedNamespace: (backend: string) => `Autoryzowana przestrzeń nazw · ${backend}`,
    project: (type: string, archived: boolean) => `${type} · ${archived ? 'archiwalny' : 'bieżący'}`,
    history: (messages: number, complete: boolean) => `${messages} wczytanych wiadomości · ${complete ? 'pełna historia rozmowy' : 'częściowa historia rozmowy'}`
  },
  row: {
    sessions: 'rozmów',
    linkedWork: 'powiązanych zadań',
    messages: 'wiadomości',
    items: 'pozycji',
    untitled: 'Nazwa rozmowy niedostępna',
    projectUnknown: 'Nie zgłoszono przypisania do projektu',
    unknown: 'Nieznane'
  },
  entityStatus: {
    active: 'Aktywny',
    archived: 'Archiwalny',
    completed: 'Ukończona',
    idle: 'Bezczynna',
    interrupted: 'Przerwana',
    queued: 'W kolejce',
    running: 'W toku',
    streaming: 'W toku'
  },
  history: {
    roles: {
      user: 'Ty',
      assistant: 'Asystent',
      system: 'System'
    }
  },
  detailLoading: {
    waiting: 'Oczekiwanie na zapisaną projekcję źródła tylko do odczytu.',
    loading: 'Wczytywanie zweryfikowanych szczegółów…',
    updateRequired: 'Wymagana aktualizacja backendu',
    unavailable: 'Szczegóły niedostępne'
  },
  details: {
    readOnly: 'Szczegóły źródła tylko do odczytu',
    membershipCoverage: 'Zakres przypisania',
    historyCoverage: 'Zakres historii',
    overview: 'Przegląd',
    sessions: 'Rozmowy',
    topics: 'Tematy',
    decisions: 'Decyzje',
    work: 'Praca',
    files: 'Pliki',
    history: 'Historia',
    linkedWork: 'Powiązana praca',
    sources: 'Źródła',
    backProjects: '← Wróć do projektów',
    backSessions: '← Wróć do rozmów',
    lastActivity: 'Ostatnia aktywność',
    status: 'Status',
    project: 'Projekt',
    messages: 'Wiadomości',
    origin: 'Pochodzenie',
    unknownStatus: 'Status nieznany'
  }
} as const
