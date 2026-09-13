import { useState } from 'react'

import { workCopy } from '../../copy/work'
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
    setMessage(workCopy.ownerSignIn.completeInBrowser)

    try {
      await bridge.ownerSignIn({ baseUrl })
      await onOwnerConnect()
      setMessage(workCopy.ownerSignIn.returned)
    } catch {
      setMessage(workCopy.ownerSignIn.connectFailed)
    } finally {setPending(false)}
  }

  const signOut = async () => {
    if (pending) {return}
    setPending(true)

    try {
      await onOwnerSignOut()
      setMessage(workCopy.ownerSignIn.credentialsCleared)
    } catch {
      setMessage(workCopy.ownerSignIn.signOutFailed)
    } finally {setPending(false)}
  }

  return <section aria-label={workCopy.ownerSignIn.ariaLabel} className="work-owner-auth">
    <p>{workCopy.ownerSignIn.boundary}</p>
    {bridge ? ownerConnected
      ? <button className="button" disabled={pending} onClick={() => void signOut()} type="button">{workCopy.ownerSignIn.signOut}</button>
      : <><button className="button primary-button" disabled={pending} onClick={() => void signIn()} type="button">{pending ? workCopy.ownerSignIn.working : workCopy.ownerSignIn.signIn}</button>
        <button className="button" disabled={pending} onClick={() => void signOut()} type="button">{workCopy.ownerSignIn.clearSaved}</button></>
      : <p>{workCopy.ownerSignIn.unavailable}</p>}
    {message && <p role="status">{message}</p>}
  </section>
}
