import { useState } from 'react'

import { getOwnerAuthBridge } from '../../security/owner-auth'

export function OwnerSignIn({ baseUrl, ownerConnected, onOwnerConnect, onOwnerSignOut }: {
  baseUrl: string; ownerConnected: boolean; onOwnerConnect: () => Promise<void>; onOwnerSignOut: () => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const bridge = getOwnerAuthBridge()

  const signIn = async () => {
    if (!bridge || pending) {return}
    setPending(true)
    setMessage('Complete owner sign-in in the system browser. No decision has been made.')

    try {
      await bridge.ownerSignIn({ baseUrl })
      await onOwnerConnect()
      setMessage('Sign-in flow returned. Decision access is determined by the refreshed server capability below, not by the shared token or this button.')
    } catch {
      setMessage('Owner sign-in or reconnection could not be verified. Decisions remain governed by the server; no approval was submitted.')
    } finally {setPending(false)}
  }

  const signOut = async () => {
    if (pending) {return}
    setPending(true)

    try {
      await onOwnerSignOut()
      setMessage('Saved owner decision credentials were cleared and the owner connection was closed.')
    } catch {
      setMessage('Owner sign-out could not be verified. The owner connection was closed; retry clearing saved credentials.')
    } finally {setPending(false)}
  }

  return <section aria-label="Owner decision access" className="work-owner-auth">
    <p>A shared server token is not human approval. Owner sign-in is separate from runtime tool permissions.</p>
    {bridge ? ownerConnected
      ? <button className="button" disabled={pending} onClick={() => void signOut()} type="button">Sign out of decision access</button>
      : <><button className="button primary-button" disabled={pending} onClick={() => void signIn()} type="button">{pending ? 'Working…' : 'Sign in to make decisions'}</button>
        <button className="button" disabled={pending} onClick={() => void signOut()} type="button">Clear saved owner sign-in</button></>
      : <p>Native owner sign-in is unavailable in this client. Use a human-authenticated dashboard connection; no token-based approval bypass is available.</p>}
    {message && <p role="status">{message}</p>}
  </section>
}
