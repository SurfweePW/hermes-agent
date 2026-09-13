import { describe, expect, it } from 'vitest'

import { JsonRpcGatewayClient, JsonRpcGatewayError } from './json-rpc-gateway'

class ClosingWebSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING

  close(): void {
    this.readyState = WebSocket.CLOSED
  }

  send(): void {}
}

describe('JsonRpcGatewayClient connection failures', () => {
  it('surfaces a close-before-open code and reason', async () => {
    const socket = new ClosingWebSocket()

    const client = new JsonRpcGatewayClient({
      connectTimeoutMs: 0,
      socketFactory: () => socket as unknown as WebSocket
    })

    const connection = client.connect('wss://gateway.example/ws')
    socket.dispatchEvent(
      new CloseEvent('close', {
        code: 4401,
        reason: 'upgrade ticket expired'
      })
    )

    await expect(connection).rejects.toMatchObject({
      closeCode: 4401,
      closeReason: 'upgrade ticket expired',
      message: 'WebSocket connection failed'
    })
    await expect(connection).rejects.toBeInstanceOf(JsonRpcGatewayError)
  })
})
