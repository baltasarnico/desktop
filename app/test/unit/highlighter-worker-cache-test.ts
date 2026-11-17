import assert from 'node:assert'
import { describe, it, mock } from 'node:test'

class FakeWorker {
  public static instances = new Array<FakeWorker>()
  public onmessage: ((ev: { data: unknown }) => void) | null = null
  public onerror: ((ev: unknown) => void) | null = null
  public posted = 0
  public terminated = false

  public constructor() {
    FakeWorker.instances.push(this)
  }

  public postMessage() {
    this.posted++
    setImmediate(() => this.onmessage?.({ data: { 0: {} } }))
  }

  public terminate() {
    this.terminated = true
  }
}

describe('highlighter worker', () => {
  it('reuses results for identical requests and retires idle workers', async () => {
    const originalWorker = (globalThis as Record<string, unknown>).Worker
    ;(globalThis as Record<string, unknown>).Worker = FakeWorker
    try {
      const { highlight } = await import('../../src/lib/highlighter/worker')

      const first = await highlight(['const a = 1'], 'a.ts', '.ts', 4, [0])
      const second = await highlight(['const a = 1'], 'a.ts', '.ts', 4, [0])
      assert.strictEqual(second, first)
      assert.equal(FakeWorker.instances.length, 1)
      assert.equal(FakeWorker.instances[0].posted, 1)

      await highlight(['const b = 2'], 'a.ts', '.ts', 4, [0])
      assert.equal(FakeWorker.instances[0].posted, 2)

      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        // An idle worker is kept for a while...
        await highlight(['const c = 3'], 'a.ts', '.ts', 4, [0])
        mock.timers.tick(30 * 1000)
        assert.equal(FakeWorker.instances[0].terminated, false)
        // ...but terminated once it has been idle for a minute.
        mock.timers.tick(31 * 1000)
        assert.equal(FakeWorker.instances[0].terminated, true)
      } finally {
        mock.timers.reset()
      }
    } finally {
      ;(globalThis as Record<string, unknown>).Worker = originalWorker
    }
  })
})
