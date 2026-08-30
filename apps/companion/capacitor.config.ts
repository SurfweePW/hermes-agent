import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.hermes.companion',
  appName: 'Hermes Companion',
  webDir: 'dist/web',
  android: {
    // Cleartext and mixed content stay disabled by default. The debug activity
    // relaxes WebView mixed-content handling only for private dogfood builds.
    allowMixedContent: false,
    backgroundColor: '#f5f3ed'
  }
}

export default config
