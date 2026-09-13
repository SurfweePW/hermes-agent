import type { TeammateStatus } from '../features/roster/roster'

export const rosterCopy = {
  status: {
    idle: 'Brak aktywności',
    working: 'Pracuje',
    completed: 'Zakończono',
    blocked: 'Zablokowany',
    'needs-approval': 'Wymaga zgody'
  } satisfies Record<TeammateStatus, string>,
  details: {
    back: '← Wróć',
    openConversation: 'Otwórz rozmowę',
    history: 'Historia rozmów',
    recent: 'Ostatnie rozmowy',
    openHint: 'Kliknij rozmowę, aby ją otworzyć',
    loading: 'Wczytywanie rozmów…',
    emptyTitle: 'Brak rozmów',
    empty: 'Brak zapisanych rozmów dla tego profilu.',
    untitled: 'Nazwa rozmowy niedostępna',
    noPreview: 'Podgląd niedostępny',
    open: (title: string) => `Otwórz rozmowę: ${title}`,
    pin: (title: string) => `Przypnij rozmowę: ${title}`,
    unpin: (title: string) => `Odepnij rozmowę: ${title}`,
    pinTitle: 'Przypnij rozmowę',
    unpinTitle: 'Odepnij rozmowę',
    lastActivityUnknown: 'Brak danych o ostatniej aktywności',
    hoursAgo: (hours: number) => hours === 1 ? '1 godzinę temu' : `${hours} godz. temu`
  }
} as const
