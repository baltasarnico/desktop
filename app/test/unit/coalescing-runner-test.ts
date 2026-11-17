import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createCoalescingRunner } from '../../src/lib/coalescing-runner'

function deferred() {
  let resolve = () => {}
  let reject = (_e: Error) => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createCoalescingRunner', () => {
  it('runs at most one queued operation behind the running one', async () => {
    const run = createCoalescingRunner<number>()
    const gates = [deferred(), deferred()]
    let calls = 0
    const op = () => gates[calls++].promise

    const promises = [
      run(1, op),
      run(1, op),
      run(1, op),
      run(1, op),
      run(1, op),
    ]
    assert.equal(calls, 1)

    gates[0].resolve()
    await Promise.resolve()
    await new Promise(r => setImmediate(r))
    assert.equal(calls, 2)

    gates[1].resolve()
    await Promise.all(promises)
    assert.equal(calls, 2)
  })

  it('only settles callers after a run that started after their call', async () => {
    const run = createCoalescingRunner<number>()
    const first = deferred()
    const second = deferred()
    const started: string[] = []

    const a = run(1, () => (started.push('a'), first.promise))
    let bSettled = false
    const b = run(1, () => (started.push('b'), second.promise)).then(
      () => (bSettled = true)
    )

    first.resolve()
    await a
    await new Promise(r => setImmediate(r))
    assert.equal(bSettled, false)
    assert.deepEqual(started, ['a', 'b'])

    second.resolve()
    await b
    assert.equal(bSettled, true)
  })

  it('uses the most recently requested operation for the queued run', async () => {
    const run = createCoalescingRunner<number>()
    const gate = deferred()
    const ran: string[] = []

    const a = run(1, () => (ran.push('first'), gate.promise))
    const b = run(1, async () => void ran.push('stale'))
    const c = run(1, async () => void ran.push('latest'))
    assert.strictEqual(b, c)

    gate.resolve()
    await Promise.all([a, b, c])
    assert.deepEqual(ran, ['first', 'latest'])
  })

  it('keeps keys independent', async () => {
    const run = createCoalescingRunner<number>()
    let calls = 0
    await Promise.all([
      run(1, async () => void calls++),
      run(2, async () => void calls++),
    ])
    assert.equal(calls, 2)
  })

  it('runs the queued operation even when the running one fails', async () => {
    const run = createCoalescingRunner<number>()
    const gate = deferred()
    let queuedRan = false

    const a = run(1, () => gate.promise)
    const b = run(1, async () => void (queuedRan = true))

    gate.reject(new Error('boom'))
    await assert.rejects(a, /boom/)
    await b
    assert.equal(queuedRan, true)
  })

  it('starts fresh once everything settled', async () => {
    const run = createCoalescingRunner<number>()
    let calls = 0
    await run(1, async () => void calls++)
    await run(1, async () => void calls++)
    assert.equal(calls, 2)
  })
})
