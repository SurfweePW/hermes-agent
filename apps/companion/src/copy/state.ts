export const stateCopy = {
  profileRoles: {
    atlas: 'Szef zespołu',
    mentor: 'Inwestycje',
    maven: 'Operacje danych',
    scout: 'Badania'
  },
  activity: {
    idle: 'Brak lokalnej aktywności.',
    disconnected: 'Połączenie przerwane.',
    approval: 'Czeka na Twoją zgodę.',
    working: 'Rozmowa w toku.',
    completed: 'Odpowiedź zakończona.'
  },
  history: {
    contextSummary: 'Podsumowanie wcześniejszego kontekstu',
    toolActivity: 'Aktywność narzędzia',
    internalEvent: 'Zdarzenie wewnętrzne',
    toolDetailsUnavailable: 'Szczegóły narzędzia są niedostępne.'
  },
  request: {
    title: 'Prośba o zgodę',
    reviewAction: 'Sprawdź tę czynność, zanim Hermes będzie kontynuować.',
    decisionNeeded: 'Hermes potrzebuje Twojej decyzji, aby kontynuować.'
  },
  errors: {
    secureCredential: 'Companion nie może uzyskać dostępu do zaszyfrowanego magazynu tokenu. Usuń zapisany token lub spróbuj ponownie.',
    draftPersistence: 'Companion nie może bezpiecznie zapisać wersji roboczej na tym urządzeniu. Będzie dostępna tylko do zamknięcia aplikacji.',
    uncertainContinuation: 'Zapisana rozmowa mogła przyjąć tę wiadomość. Spróbuj ponownie, aby uzgodnić wynik; Hermes nie wyśle jej drugi raz.',
    gatewayUnavailable: 'Companion nie może połączyć się z gatewayem. Sprawdź połączenie i spróbuj ponownie.',
    tokenRequired: 'Aby się połączyć, podaj token sesji gatewaya.',
    profileUnavailableAfterReconnect: 'Profil zapisanej rozmowy jest niedostępny po ponownym połączeniu.',
    previousContinuation: (status: string) => `Poprzednia kontynuacja zakończyła się ze statusem: ${status}.`,
    creationFailed: 'Nowa rozmowa nie powiodła się po utworzeniu.',
    creationCancelled: 'Nowa rozmowa została anulowana po utworzeniu.',
    firstMessageRejected: 'Rozmowa została utworzona, ale pierwsza wiadomość nie została przyjęta.',
    creationRefused: 'Rozmowa nie została utworzona. Spróbuj ponownie, gdy będą dostępne zasoby.',
    creationInterrupted: 'Tworzenie przerwano po trwałym powiązaniu. Połącz się ponownie, aby uzgodnić wynik.',
    creationRecovery: 'Tworzenie wymaga odzyskania. Zachowano pierwotny identyfikator prośby.',
    creationNotFound: 'Nie znaleziono operacji tworzenia. Ponowienie użyje pierwotnego identyfikatora prośby.',
    creationReconciliationUncertain: 'Nie można potwierdzić wyniku tworzenia. Zachowano pierwotny identyfikator prośby.',
    exclusiveCreationUnavailable: 'Bezpieczne, wyłączne tworzenie jest niedostępne na tym urządzeniu.',
    draftAlreadySubmitting: 'Ta wersja robocza jest już wysyłana.',
    creationRetrySave: 'Companion nie może trwale zapisać danych potrzebnych do ponowienia tworzenia.',
    draftRevisionMismatch: 'Wysłana wersja robocza nie odpowiada już danym ponowienia.',
    markCreationUncertain: 'Companion nie może oznaczyć wyniku tworzenia jako niepewnego przed wysłaniem.',
    creationOutcomeUnknown: 'Nowa rozmowa mogła zostać utworzona. Połącz się ponownie, aby uzgodnić wynik; Hermes nie utworzy jej drugi raz.',
    ownerSignOut: 'Nie udało się potwierdzić wylogowania właściciela. Połączenie zostało zamknięte.',
    notConnected: 'Companion nie jest połączony.',
    ownerRequired: 'Kontynuowanie zapisanej rozmowy wymaga uwierzytelnienia właściciela.',
    boundedMessage: 'Wpisz wiadomość o dozwolonej długości, aby kontynuować rozmowę.',
    invalidConversationTarget: 'Cel zapisanej rozmowy jest nieprawidłowy.',
    profileUnavailable: 'Profil zapisanej rozmowy jest niedostępny.',
    conversationChanged: 'Zapisana rozmowa zmieniła się przed zakończeniem operacji.',
    previousContinuationIncomplete: 'Poprzednia kontynuacja nie została zakończona. Wyślij ponownie, aby rozpocząć nową odpowiedź.',
    durableCreationUnavailable: 'Trwałe tworzenie rozmowy jest niedostępne dla tego połączenia.',
    terminalTurnFailed: 'Hermes zgłosił błąd podczas wykonywania tej tury.',
    stopFailed: 'Nie udało się zatrzymać tury. Może nadal trwać; spróbuj ponownie.',
    approvalStillPending: 'Ta prośba nadal oczekuje na decyzję.'
  },
  newConversationTitle: 'Nowa rozmowa',
  fallbackProfileName: (index: number) => `Profil Hermes ${index}`,
  fallbackProfileRole: 'Profil Hermes',
  attentionScope: 'Tylko bieżące środowisko gatewaya',
  attentionUnavailable: 'Niedostępne w tej wersji gatewaya'
} as const
