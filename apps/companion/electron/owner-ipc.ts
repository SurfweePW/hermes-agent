import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import { CHANNELS } from './channels'
import type { OwnerAuth } from './owner-auth'
import { ownerErrorCode } from './owner-auth'

/** Exact window AND exact main-frame document, not any window at an allowed origin. */
export function registerOwnerIpc(owner: OwnerAuth, ipc: Pick<IpcMain, 'handle'>,
  trusted: () => { contents: WebContents; url: string } | undefined): void {
  for (const method of ['ownerSignIn', 'ownerStatus', 'ownerSignOut', 'ownerWebSocketUrl'] as const) {
    ipc.handle(CHANNELS[method], async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const target = trusted()

      const allowed = () => !!target && trusted()?.contents === target.contents
        && !target.contents.isDestroyed() && event.sender === target.contents
        && event.senderFrame === target.contents.mainFrame && event.senderFrame?.url === target.url

      if (!allowed()) { return { ok: false, error: 'untrusted-renderer' } }
      const input = args[0] as { baseUrl?: unknown } | null
      const base = input?.baseUrl

      if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, 'baseUrl')
        || typeof base !== 'string') { return { ok: false, error: 'invalid-request' } }

      try {
        const value = method === 'ownerSignIn' ? await owner.ownerSignIn({ baseUrl: base })
          : method === 'ownerWebSocketUrl' ? await owner.ownerWebSocketUrl({ baseUrl: base })
            : method === 'ownerSignOut' ? owner.ownerSignOut({ baseUrl: base }) : owner.ownerStatus({ baseUrl: base })

        // A navigation while awaiting browser login must not hand a capability to the new document.
        if (!allowed()) { return { ok: false, error: 'untrusted-renderer' } }

        return { ok: true, value }
      } catch (cause) { return { ok: false, error: ownerErrorCode(cause) } }
    })
  }
}
