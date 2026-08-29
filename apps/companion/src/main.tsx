import './styles/tokens.css'
import './styles/app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Hermes Companion root element was not found')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
