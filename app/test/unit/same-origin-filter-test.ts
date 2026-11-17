import assert from 'node:assert'
import { describe, it } from 'node:test'
import { WebRequest } from 'electron'
import { installSameOriginFilter } from '../../src/main-process/same-origin-filter'
import { OrderedWebRequest } from '../../src/main-process/ordered-webrequest'

type Listener = (details: any, callback?: (response: any) => void) => void

function createWebRequest() {
  const listeners = new Map<string, Listener | null>()
  const filters = new Map<string, unknown>()
  const subscribe =
    (event: string) => (filter: unknown, listener: Listener | null) => {
      filters.set(event, filter)
      listeners.set(event, listener)
    }
  const webRequest = {
    onBeforeRedirect: subscribe('onBeforeRedirect'),
    onBeforeRequest: subscribe('onBeforeRequest'),
    onBeforeSendHeaders: subscribe('onBeforeSendHeaders'),
    onCompleted: subscribe('onCompleted'),
    onErrorOccurred: subscribe('onErrorOccurred'),
    onHeadersReceived: subscribe('onHeadersReceived'),
    onResponseStarted: subscribe('onResponseStarted'),
    onSendHeaders: subscribe('onSendHeaders'),
  } as unknown as WebRequest

  const call = (event: string, details: object) =>
    new Promise<any>(resolve => {
      const listener = listeners.get(event)
      assert.ok(listener, `no listener for ${event}`)
      listener(details, resolve)
      if (listener.length < 2) {
        resolve(undefined)
      }
    })

  return { ordered: new OrderedWebRequest(webRequest), filters, call }
}

const headers = { Authorization: 'token secret', Accept: '*/*' }

describe('same origin filter', () => {
  it('only subscribes to network requests', () => {
    const { ordered, filters } = createWebRequest()
    installSameOriginFilter(ordered)
    for (const event of ['onBeforeRequest', 'onBeforeSendHeaders']) {
      assert.deepStrictEqual(filters.get(event), {
        urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'],
      })
    }
  })

  it('strips credentials on cross-origin redirects', async () => {
    const { ordered, call } = createWebRequest()
    installSameOriginFilter(ordered)
    await call('onBeforeRequest', { id: 1, url: 'https://api.github.com/x' })
    const response = await call('onBeforeSendHeaders', {
      id: 1,
      url: 'https://elsewhere.example/x',
      requestHeaders: headers,
    })
    assert.deepStrictEqual(response.requestHeaders, { Accept: '*/*' })
  })

  it('forgets requests that failed', async () => {
    const { ordered, call } = createWebRequest()
    installSameOriginFilter(ordered)
    await call('onBeforeRequest', { id: 1, url: 'https://api.github.com/x' })
    await call('onErrorOccurred', { id: 1, url: 'https://api.github.com/x' })

    // The same id must not be treated as a redirect of the failed request.
    await call('onBeforeRequest', { id: 1, url: 'https://elsewhere.example/' })
    const response = await call('onBeforeSendHeaders', {
      id: 1,
      url: 'https://elsewhere.example/',
      requestHeaders: headers,
    })
    assert.deepStrictEqual(response.requestHeaders, headers)
  })
})
