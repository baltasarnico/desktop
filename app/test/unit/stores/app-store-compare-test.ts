import assert from 'node:assert/strict'
import { after, before, describe, it, mock, TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { join } from 'path'
import { readFile } from 'fs/promises'
import type { AppStore } from '../../../src/lib/stores/app-store'
import { ComparisonMode, HistoryTabMode } from '../../../src/lib/app-state'
import type { ITestStores } from '../../helpers/app-store-test-harness'
import type { TestStatsDatabase } from '../../helpers/databases/test-stats-database'
import { createTempDirectory } from '../../helpers/temp'

/** The Git subcommands Desktop spawned while running `operation`. */
async function gitCommands(
  t: TestContext,
  operation: () => Promise<unknown>
): Promise<ReadonlyArray<string>> {
  const trace = join(await createTempDirectory(t), 'trace.jsonl')
  process.env.GIT_TRACE2_EVENT = trace
  try {
    await operation()
  } finally {
    delete process.env.GIT_TRACE2_EVENT
  }
  const contents = await readFile(trace, 'utf8').catch(() => '')
  return contents
    .split('\n')
    .filter(l => l.includes('"event":"start"'))
    .map(l => {
      const argv: ReadonlyArray<string> = JSON.parse(l).argv
      return argv.slice(1).find(a => !a.startsWith('-')) ?? ''
    })
}

describe('AppStore branch comparison and repository memory', () => {
  let appStore: AppStore
  let statsDb: TestStatsDatabase
  let stores: ITestStores

  before(async () => {
    mock.module('../../../src/ui/main-process-proxy', {
      namedExports: {
        ...(await import('../../../src/ui/main-process-proxy')),
        getAppMenu: () => {},
        updateAccounts: () => {},
        updatePreferredAppMenuItemLabels: () => {},
      },
    })
    const { AppStore } = await import('../../../src/lib/stores/app-store')
    const { createTestStores } = await import(
      '../../helpers/app-store-test-harness'
    )
    stores = createTestStores()
    const { AliveStore } = await import('../../../src/lib/stores/alive-store')
    mock.method(AliveStore.prototype, 'setEnabled', () => {})
    const { CopilotStore } = await import(
      '../../../src/lib/stores/copilot-store'
    )
    const { NotificationsStore } = await import(
      '../../../src/lib/stores/notifications-store'
    )
    const { PullRequestCoordinator } = await import(
      '../../../src/lib/stores/pull-request-coordinator'
    )
    const { StatsStore } = await import('../../../src/lib/stats')
    const { TestStatsDatabase } = await import(
      '../../helpers/databases/test-stats-database'
    )
    const { TestActivityMonitor } = await import(
      '../../helpers/test-activity-monitor'
    )
    const { fakePost } = await import('../../fake-stats-post')
    // Let short timers (such as the minimum merge check duration) run but
    // keep long-running background timers from being scheduled.
    const realSetTimeout = window.setTimeout.bind(window)
    mock.method(window, 'setTimeout', (fn: () => void, ms?: number) =>
      (ms ?? 0) <= 1000 ? realSetTimeout(fn, ms) : 0
    )
    mock.method(window, 'requestAnimationFrame', () => 0)
    mock.method(window, 'addEventListener', () => {})
    statsDb = new TestStatsDatabase()
    await statsDb.reset()
    const stats = new StatsStore(statsDb, new TestActivityMonitor(), fakePost)
    const coordinator = new PullRequestCoordinator(
      stores.pullRequestStore,
      stores.repositoriesStore
    )
    appStore = new AppStore(
      stores.gitHubUserStore,
      stores.cloningRepositoriesStore,
      stores.issuesStore,
      stats,
      stores.signInStore,
      stores.accountsStore,
      stores.repositoriesStore,
      coordinator,
      stores.repositoryStateCache,
      stores.apiRepositoriesStore,
      new NotificationsStore(
        stores.accountsStore,
        new AliveStore(stores.accountsStore),
        coordinator,
        stats,
        stores.repositoriesStore
      ),
      new CopilotStore(stores.accountsStore)
    )
    mock.method(appStore, '_showPopup', async () => {})
    mock.method(appStore, '_selectRepository', async () => null)
  })

  after(async () => {
    stores.repositoriesStore['emitter'].dispose()
    stores.accountsStore['emitter'].dispose()
    await setImmediate()
    statsDb?.close()
    mock.restoreAll()
  })

  async function setupComparison(t: TestContext) {
    const { setupEmptyRepository } = await import('../../helpers/repositories')
    const { makeCommit, switchTo } = await import(
      '../../helpers/repository-scaffolding'
    )
    const local = await setupEmptyRepository(t)
    await makeCommit(local, { entries: [{ path: 'a.txt', contents: 'a' }] })
    const { exec } = await import('dugite')
    const defaultBranch = (
      await exec(['rev-parse', '--abbrev-ref', 'HEAD'], local.path)
    ).stdout.trim()
    await switchTo(local, 'feature')
    await makeCommit(local, { entries: [{ path: 'b.txt', contents: 'b' }] })
    await switchTo(local, defaultBranch)
    await makeCommit(local, { entries: [{ path: 'c.txt', contents: 'c' }] })

    const repository = await stores.repositoriesStore.addRepository(
      local.path,
      local.resolvedGitDir
    )
    await appStore._refreshRepository(repository)

    const gitStore = appStore['gitStoreCache'].get(repository)
    const feature = gitStore.allBranches.find(b => b.name === 'feature')
    assert.ok(feature)

    await appStore._executeCompare(repository, {
      kind: HistoryTabMode.Compare,
      branch: feature,
      comparisonMode: ComparisonMode.Behind,
    })

    return { local, repository, feature, defaultBranch }
  }

  it('does not reload the comparison when neither branch moved', async t => {
    const { repository } = await setupComparison(t)
    const { compareState } = stores.repositoryStateCache.get(repository)
    assert.equal(compareState.formState.kind, HistoryTabMode.Compare)
    assert.equal(compareState.commitSHAs.length, 1)

    const commands = await gitCommands(t, () =>
      appStore._initializeCompare(repository)
    )
    assert.deepEqual(commands, [])
  })

  it('reloads the comparison when the compared branch moved', async t => {
    const { local, repository, defaultBranch } = await setupComparison(t)
    const { makeCommit, switchTo } = await import(
      '../../helpers/repository-scaffolding'
    )
    await switchTo(local, 'feature')
    await makeCommit(local, { entries: [{ path: 'd.txt', contents: 'd' }] })
    await switchTo(local, defaultBranch)
    await appStore['gitStoreCache'].get(repository).loadBranches()

    const commands = await gitCommands(t, () =>
      appStore._initializeCompare(repository)
    )
    assert.ok(commands.includes('rev-list'), commands.join(','))
    const { compareState } = stores.repositoryStateCache.get(repository)
    assert.equal(compareState.commitSHAs.length, 2)
  })

  it('reuses the merge check for unchanged branches', async t => {
    const { repository, feature } = await setupComparison(t)
    const commands = await gitCommands(t, () =>
      appStore._executeCompare(repository, {
        kind: HistoryTabMode.Compare,
        branch: feature,
        comparisonMode: ComparisonMode.Behind,
      })
    )
    assert.ok(!commands.includes('merge-tree'), commands.join(','))
    const { compareState } = stores.repositoryStateCache.get(repository)
    assert.ok(compareState.mergeStatus !== null)
    assert.notEqual(compareState.mergeStatus.kind, 'Loading')
  })

  it('releases the Git store and state of a removed repository', async t => {
    const { repository } = await setupComparison(t)
    assert.ok(appStore['gitStoreCache'].has(repository))
    assert.ok(stores.repositoryStateCache.has(repository))

    await appStore._removeRepository(repository, false)

    assert.equal(appStore['gitStoreCache'].has(repository), false)
    assert.equal(stores.repositoryStateCache.has(repository), false)
  })

  it('prunes a large commit lookup down to the commits on display', async t => {
    const { repository } = await setupComparison(t)
    const gitStore = appStore['gitStoreCache'].get(repository)
    const { compareState } = stores.repositoryStateCache.get(repository)
    const [displayed] = compareState.commitSHAs
    const displayedCommit = gitStore.commitLookup.get(displayed)
    assert.ok(displayedCommit)

    for (let i = 0; i < 6000; i++) {
      gitStore.commitLookup.set(`fake-${i}`, displayedCommit)
    }

    appStore['pruneCommitLookup'](repository)

    assert.ok(gitStore.commitLookup.size < 100)
    assert.strictEqual(gitStore.commitLookup.get(displayed), displayedCommit)
  })

  it('keeps small commit lookups as they are', async t => {
    const { repository } = await setupComparison(t)
    const gitStore = appStore['gitStoreCache'].get(repository)
    const before = gitStore.commitLookup.size
    appStore['pruneCommitLookup'](repository)
    assert.equal(gitStore.commitLookup.size, before)
  })

  it('returns the same repositories array while nothing changed', async () => {
    const first = appStore.getState().repositories
    assert.strictEqual(appStore.getState().repositories, first)
  })

  it('only replaces the indicator lookup when an indicator changes', () => {
    const before = appStore.getState().localRepositoryStateLookup
    const state = { changedFilesCount: 2, aheadBehind: { ahead: 1, behind: 0 } }
    appStore['setLocalRepositoryState'](9999, state)
    const changed = appStore.getState().localRepositoryStateLookup
    assert.notStrictEqual(changed, before)
    assert.deepEqual(changed.get(9999), state)

    appStore['setLocalRepositoryState'](9999, { ...state })
    assert.strictEqual(appStore.getState().localRepositoryStateLookup, changed)

    appStore['setLocalRepositoryState'](9999, null)
    assert.equal(
      appStore.getState().localRepositoryStateLookup.has(9999),
      false
    )
  })

  it('only re-renders for Git store updates of the selected repository', async t => {
    const { repository } = await setupComparison(t)
    const gitStore = appStore['gitStoreCache'].get(repository)
    const emitUpdate = t.mock.method(appStore, 'emitUpdate' as never, () => {})
    const previous = appStore['selectedRepository']
    t.after(() => (appStore['selectedRepository'] = previous))

    appStore['selectedRepository'] = null
    appStore['onGitStoreUpdated'](repository, gitStore)
    assert.equal(emitUpdate.mock.callCount(), 0)

    appStore['selectedRepository'] = repository
    appStore['onGitStoreUpdated'](repository, gitStore)
    assert.equal(emitUpdate.mock.callCount(), 1)
  })
})
