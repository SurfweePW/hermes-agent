/**
 * First-party Polish copy for the application shell and connection setup.
 *
 * Vocabulary contract: Rozmowa / Profil / Projekt / Temat / Pliki / Decyzje.
 * Hermes, Google, gateway, URLs, tokens, profile names and identifiers remain unchanged.
 */
export const appCopy = {
  setup: {
    kicker: 'Konfiguracja połączenia',
    title: 'Połącz z Hermes Companion',
    lede: 'Użyj prywatnego adresu bazowego HTTP(S) swojego gatewaya Hermes.',
    encryptedStorage: 'Aplikacja natywna przechowuje token zaszyfrowany w bezpiecznym magazynie urządzenia.',
    sessionStorage: 'Przeglądarka przechowuje token tylko na czas tej sesji.',
    baseUrl: 'Adres bazowy gatewaya',
    ownerConnect: 'Zaloguj się przez Google',
    connecting: 'Łączenie…',
    ownerExplanation: 'Logowanie właściciela korzysta z aplikacji natywnej i przeglądarki systemowej oraz jednorazowego biletu połączenia.',
    nativeBridgeRequired: 'Logowanie właściciela przez Google wymaga zaufanego mostu aplikacji natywnej. Konfiguracja w przeglądarce wymaga tokenu sesji.',
    sessionToken: 'Token sesji',
    savedTokenPlaceholder: 'Pozostaw puste, aby użyć zapisanego tokenu',
    savedTokenAvailable: 'Dostępny jest zapisany zaszyfrowany token. Wpisz nowy token, aby zastąpić go po udanym połączeniu.',
    useSavedToken: 'Użyj zapisanego tokenu',
    connectPrivately: 'Połącz prywatnie',
    forgetSavedToken: 'Usuń zapisany token'
  },
  attention: {
    approval: {
      once: 'Zatwierdź raz',
      session: 'Zatwierdź dla rozmowy',
      always: 'Zawsze zatwierdzaj',
      deny: 'Odmów',
      kicker: 'Twoja zgoda',
      command: 'Żądane polecenie',
      choices: 'Opcje zatwierdzenia'
    },
    activity: {
      kicker: 'Bieżąca rozmowa',
      title: 'Aktywność',
      sent: 'Wysłano wiadomość',
      replied: (name: string) => `${name} odpowiedział`,
      empty: 'Aktywność rozmowy pojawi się tutaj.',
      calmTitle: 'Domyślnie spokojnie.',
      calmDetail: 'Hermes przerywa tylko wtedy, gdy Twoja ocena zmienia dalszy przebieg.'
    }
  },
  screenTitles: {
    needs: 'Decyzje',
    work: 'Rozmowy',
    library: 'Pliki',
    settings: 'Ustawienia',
    conversation: 'Rozmowa',
    details: 'Profil',
    recovery: 'Odzyskiwanie'
  },
  navigation: {
    main: 'Główna nawigacja',
    mobile: 'Nawigacja mobilna',
    drawer: 'Menu aplikacji',
    openDrawer: 'Otwórz menu',
    closeDrawer: 'Zamknij menu',
    conversations: 'Rozmowy',
    decisions: 'Decyzje',
    files: 'Pliki',
    settings: 'Ustawienia',
    badgeLabel: (label: string, count: string) => `${label}, pozycji: ${count}`
  },
  profile: {
    companionUser: 'Profil: użytkownik Companiona',
    section: 'Profile',
    ready: 'Companion gotowy',
    count: (count: number) => `Profile: ${count}`
  },
  reconnectToVerify: 'Połącz ponownie, aby zweryfikować dane',
  project: {
    none: 'Bez projektu',
    unknown: 'Projekt nieznany'
  },
  chooseProfile: {
    title: 'Wybierz profil',
    detail: 'Otwórz profil z listy bocznej.',
    back: 'Wróć do rozmów'
  },
  settings: {
    kicker: 'Połączenie i konto',
    title: 'Ustawienia',
    detail: 'Zarządzaj logowaniem właściciela i bieżącym połączeniem z gatewayem.'
  }
} as const
