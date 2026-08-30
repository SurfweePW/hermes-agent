import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(`${root}/${path}`, 'utf8')

const pluginPath = 'android/app/src/main/java/com/hermes/companion/GatewayTokenPlugin.java'
const storePath = 'android/app/src/main/java/com/hermes/companion/KeystoreTokenStore.java'

describe('Android native security contract', () => {
  it('uses a non-exportable Android Keystore AES/GCM key with no plaintext fallback', () => {
    const store = read(storePath)

    expect(store).toContain('AndroidKeyStore')
    expect(store).toContain('KeyProperties.KEY_ALGORITHM_AES')
    expect(store).toContain('KeyProperties.BLOCK_MODE_GCM')
    expect(store).toContain('setUserAuthenticationRequired(false)')
    expect(store).toMatch(/SharedPreferences/)
    expect(store).not.toMatch(/putString\([^,]+,\s*token\b/)
  })

  it('exposes only get, set and reset after checking the bundled-app origin', () => {
    const plugin = read(pluginPath)
    const methods = [...plugin.matchAll(/@PluginMethod\s+public void (\w+)\(/g)].map((match) => match[1])

    expect(methods).toEqual(['get', 'set', 'reset'])
    expect(plugin).toContain('isTrustedBundledOrigin')
    expect(plugin).toContain('call.reject(GENERIC_ERROR)')
    expect(plugin).not.toMatch(/call\.reject\([^\n]*(exception|getMessage|token)/i)
  })

  it('keeps release cleartext disabled and isolates the honest limitation to debug', () => {
    const mainManifest = read('android/app/src/main/AndroidManifest.xml')
    const debugManifest = read('android/app/src/debug/AndroidManifest.xml')
    const debugPolicy = read('android/app/src/debug/res/xml/network_security_config.xml')

    expect(mainManifest).toContain('android:usesCleartextTraffic="false"')
    expect(mainManifest).toContain('android:allowBackup="false"')
    expect(mainManifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"')
    expect(read('android/app/src/main/res/xml/file_paths.xml')).not.toContain('<external-path')
    expect(read('android/app/src/main/res/xml/data_extraction_rules.xml')).toContain('<exclude domain="sharedpref" path="." />')
    expect(debugManifest).toContain('android:usesCleartextTraffic="true"')
    expect(debugManifest).toContain('@xml/network_security_config')
    expect(debugPolicy).toContain('runtime-configured')
    expect(debugPolicy).toContain('cannot express')
  })

  it('does not embed a server URL or broaden navigation in Capacitor config', () => {
    const config = read('capacitor.config.ts')

    expect(config).toContain("appId: 'com.hermes.companion'")
    expect(config).toContain("webDir: 'dist/web'")
    expect(config).not.toMatch(/allowNavigation|server\s*:\s*\{[^}]*url\s*:/s)
  })
})
