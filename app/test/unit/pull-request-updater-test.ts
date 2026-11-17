import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { PullRequestUpdater } from '../../src/lib/stores/helpers/pull-request-updater'
import { PullRequestCoordinator } from '../../src/lib/stores/pull-request-coordinator'
import { RepositoryWithGitHubRepository } from '../../src/models/repository'
import { Account } from '../../src/models/account'

const minutes = (n: number) => n * 60 * 1000

function createUpdater() {
  let lastRefreshed: number | undefined = undefined
  const refreshPullRequests = mock.fn(() => {
    lastRefreshed = Date.now()
    return Promise.resolve()
  })
  const coordinator = {
    getLastRefreshed: () => lastRefreshed,
    refreshPullRequests,
  } as unknown as PullRequestCoordinator

  const updater = new PullRequestUpdater(
    {} as RepositoryWithGitHubRepository,
    {} as Account,
    coordinator
  )

  return {
    updater,
    refreshPullRequests,
    setLastRefreshed: (value: number) => (lastRefreshed = value),
  }
}

/** Let promise continuations (refresh().then(scheduleTick)) run. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

describe('PullRequestUpdater', () => {
  beforeEach(() =>
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: minutes(1000) })
  )
  afterEach(() => mock.timers.reset())

  it('does not refresh when a refresh happened recently', async () => {
    const { updater, refreshPullRequests, setLastRefreshed } = createUpdater()

    updater.start()
    // A manual refresh lands right before the scheduled tick fires
    setLastRefreshed(Date.now())
    mock.timers.tick(0)
    await flush()

    assert.equal(refreshPullRequests.mock.callCount(), 0)
    updater.stop()
  })

  it('keeps a single timer chain after skipping a tick', async () => {
    const { updater, refreshPullRequests, setLastRefreshed } = createUpdater()

    updater.start()
    setLastRefreshed(Date.now())
    mock.timers.tick(0)
    await flush()

    // Advance through three full intervals; each should refresh exactly once.
    for (let i = 1; i <= 3; i++) {
      mock.timers.tick(minutes(30))
      await flush()
      assert.equal(refreshPullRequests.mock.callCount(), i)
    }

    updater.stop()
  })
})
