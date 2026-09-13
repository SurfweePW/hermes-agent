import { describe, expect, it, vi } from 'vitest'

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

  it('surfaces a post-open close code to the close hook and pending calls', async () => {
    const socket = new ClosingWebSocket()
    const onSocketClose = vi.fn(() => false)

    const client = new JsonRpcGatewayClient({
      connectTimeoutMs: 0,
      requestTimeoutMs: 0,
      onSocketClose,
      socketFactory: () => socket as unknown as WebSocket
    })

    const connection = client.connect('wss://gateway.example/ws')
    socket.readyState = WebSocket.OPEN
    socket.dispatchEvent(new Event('open'))
    await connection
    const pending = client.request('test.pending', {})
    socket.dispatchEvent(new CloseEvent('close', { code: 4401, reason: 'owner lease expired' }))

    expect(onSocketClose).toHaveBeenCalledWith(expect.objectContaining({ code: 4401, reason: 'owner lease expired' }))
    await expect(pending).rejects.toMatchObject({
      closeCode: 4401,
      closeReason: 'owner lease expired',
      message: 'WebSocket closed'
    })
    await expect(pending).rejects.toBeInstanceOf(JsonRpcGatewayError)
  })
})
