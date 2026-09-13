import { stateCopy } from './state'

/**
 * First-party Polish copy for the conversation, session and chat surfaces.
 *
 * Vocabulary contract:
 * - conversation / session / chat -> "Rozmowa"
 * - profile concept              -> "Profil"
 * - project                      -> "Projekt"
 * - runtime approval             -> "Prośba"
 *
 * Only first-party chrome, status and accessibility strings live here. User and
 * agent content, titles, names, model names and paths are never translated.
 */
export const conversationCopy = {
  fallbackSessionTitle: 'Nazwa rozmowy niedostępna',
  fallbackProjectLabel: 'Projekt nieznany',
  presence: {
    connected: 'Połączono',
    disconnected: 'Rozłączono'
  },
  state: {
    working: 'Pracuje…',
    waiting: 'Czeka na Ciebie',
    completed: (time: string) => `Zakończone · ${time}`,
    error: 'Błąd',
    unknown: 'Stan nieznany',
    updated: (time: string) => `Zaktualizowano ${time}`
  },
  technical: {
    profile: 'Profil',
    project: 'Projekt',
    connection: 'Połączenie'
  },
  backToSessions: (name: string) => `Wróć do rozmów: ${name}`,
  empty: (name: string) => `Rozpocznij rozmowę z ${name}.`,
  composer: {
    hint: 'Enter dodaje nową linię · Ctrl/Cmd+Enter wysyła',
    label: (name: string) => `Wiadomość do ${name}`,
    placeholder: (name: string) => `Wiadomość do ${name}…`,
    send: 'Wyślij wiadomość'
  },
  turn: {
    sendingTitle: 'Wysyłanie wiadomości…',
    sendingDetail: 'Czekamy, aż Hermes ją przyjmie…',
    workingTitle: (name: string) => `${name} pracuje`,
    workingDetail: 'Tura trwa…',
    stoppingTitle: (name: string) => `Zatrzymywanie: ${name}…`,
    stoppingDetail: 'Czekamy, aż bieżąca tura się zatrzyma…',
    stop: 'Zatrzymaj',
    stopping: 'Zatrzymywanie…'
  },
  statusRow: {
    tool: 'Narzędzie',
    internal: 'Wewnętrzne',
    compression: stateCopy.history.contextSummary,
    toolState: {
      complete: 'Zakończone',
      progress: 'W toku',
      running: 'Uruchomione'
    }
  },
  transcript: {
    newMessages: '↓ Nowe wiadomości'
  },
  notices: {
    uncertain: 'Połączenie zamknięto po przyjęciu tury. Wynik po stronie serwera nie jest jeszcze znany.',
    interrupted: 'Turę przerwano. Możesz wysłać nową wiadomość, gdy będziesz gotowy.'
  },
  messageContent: {
    contextSummaryLabel: 'Podsumowanie wcześniejszego kontekstu',
    contextSummaryHeading: 'Podsumowanie wcześniejszego kontekstu',
    contextSummaryDetail: 'Starsze szczegóły rozmowy są ukryte, aby zachować czytelność.',
    showDetails: 'Pokaż szczegóły',
    hideDetails: 'Ukryj szczegóły',
    showMore: 'Pokaż więcej',
    showLess: 'Pokaż mniej',
    imageAttachment: 'Załącznik obrazu',
    codeBlock: 'Blok kodu'
  }
} as const
