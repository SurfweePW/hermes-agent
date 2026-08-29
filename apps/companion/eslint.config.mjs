import globals from 'globals'

import shared from '../../eslint.config.shared.mjs'

export default [
  ...shared,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  }
]
