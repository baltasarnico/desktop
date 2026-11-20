import assert from 'node:assert'
import { describe, it, TestContext } from 'node:test'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { exec } from 'dugite'
import { Repository } from '../../../src/models/repository'
import { IRemote } from '../../../src/models/remote'
import { fetch, fetchMultiple } from '../../../src/lib/git/fetch'
import { pull } from '../../../src/lib/git/pull'
import { GitStore } from '../../../src/lib/stores/git-store'
import { TestStatsStore } from '../../helpers/test-stats-store'
import { shell } from '../../helpers/test-app-shell'
import { createTempDirectory } from '../../helpers/temp'

async function run(cwd: string, args: string[]) {
  const result = await exec(args, cwd)
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}

/** A bare remote with a `main` (its default) and an `other` branch. */
async function createRemote(t: TestContext, name: string) {
  const root = await createTempDirectory(t)
  const bare = join(root, `${name}.git`)
  const seed = join(root, 'seed')
  await run(root, ['init', '-q', '--bare', '-b', 'main', bare])
  await run(root, ['init', '-q', '-b', 'main', seed])
  await run(seed, ['commit', '-q', '--allow-empty', '-m', `${name} one`])
  await run(seed, ['push', '-q', bare, 'HEAD:main', 'HEAD:other'])
  return { bare, seed }
}

async function commitTo(remote: { bare: string; seed: string }, ref: string) {
  await run(remote.seed, ['commit', '-q', '--allow-empty', '-m', 'more'])
  await run(remote.seed, ['push', '-q', remote.bare, `HEAD:${ref}`])
  return run(remote.seed, ['rev-parse', 'HEAD'])
}

/** A clone of `origin` that also has `upstream` as a remote. */
async function setup(t: TestContext) {
  const origin = await createRemote(t, 'origin')
  const upstream = await createRemote(t, 'upstream')
  const path = join(await createTempDirectory(t), 'work')
  await run(origin.seed, ['clone', '-q', origin.bare, path])
  await run(path, ['remote', 'add', 'upstream', upstream.bare])
  const repository = new Repository(path, -1, null, false)
  const remotes: ReadonlyArray<IRemote> = [
    { name: 'origin', url: origin.bare },
    { name: 'upstream', url: upstream.bare },
  ]
  return { origin, upstream, repository, remotes }
}

const remoteHEAD = (repository: Repository, remote: string) =>
  exec(
    ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`],
    repository.path
  ).then(r => r.stdout.trim())

async function countDesktopGitProcesses(
  t: TestContext,
  command: string,
  operation: () => Promise<unknown>
) {
  const trace = join(await createTempDirectory(t), 'trace.jsonl')
  process.env.GIT_TRACE2_EVENT = trace
  try {
    await operation()
  } finally {
    delete process.env.GIT_TRACE2_EVENT
  }
  return (
    (await readFile(trace, 'utf8').catch(() => ''))
      .split('\n')
      .filter(l => l.includes('"event":"start"'))
      .map(l => JSON.parse(l))
      // Only count processes Desktop started; `fetch --multiple` runs its own
      // child process per remote (in parallel), whose session ids are nested.
      .filter(e => !String(e.sid).includes('/'))
      .filter(e => (e.argv as ReadonlyArray<string>).includes(command)).length
  )
}

describe('fetching with fewer network round trips', () => {
  it('fetches several remotes in one process', async t => {
    const { origin, upstream, repository, remotes } = await setup(t)
    const originTip = await commitTo(origin, 'main')
    const upstreamTip = await commitTo(upstream, 'feature')

    await fetchMultiple(repository, remotes)

    assert.equal(
      await run(repository.path, ['rev-parse', 'origin/main']),
      originTip
    )
    assert.equal(
      await run(repository.path, ['rev-parse', 'upstream/feature']),
      upstreamTip
    )
    assert.equal(
      await remoteHEAD(repository, 'upstream'),
      'refs/remotes/upstream/main'
    )
  })

  it('keeps the remote HEAD current without a separate set-head', async t => {
    const { origin, repository, remotes } = await setup(t)
    await run(repository.path, [
      'update-ref',
      '--no-deref',
      '-d',
      'refs/remotes/origin/HEAD',
    ])

    await fetch(repository, remotes[0])
    assert.equal(
      await remoteHEAD(repository, 'origin'),
      'refs/remotes/origin/main'
    )

    // The remote changes its default branch
    await run(origin.bare, ['symbolic-ref', 'HEAD', 'refs/heads/other'])
    await fetch(repository, remotes[0])
    assert.equal(
      await remoteHEAD(repository, 'origin'),
      'refs/remotes/origin/other'
    )

    await run(origin.bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await pull(repository, remotes[0])
    assert.equal(
      await remoteHEAD(repository, 'origin'),
      'refs/remotes/origin/main'
    )
  })

  it('makes a single network operation for a fork with an upstream', async t => {
    const { repository, remotes } = await setup(t)
    const gitStore = new GitStore(repository, shell, new TestStatsStore())

    const fetches = await countDesktopGitProcesses(t, 'fetch', () =>
      gitStore.fetchRemotes(remotes, false)
    )
    const setHeads = await countDesktopGitProcesses(t, 'set-head', () =>
      gitStore.fetchRemotes(remotes, false)
    )

    assert.equal(fetches, 1)
    assert.equal(setHeads, 0)
  })

  it('falls back to fetching remotes one by one', async t => {
    const { origin, repository } = await setup(t)
    const originTip = await commitTo(origin, 'main')
    const gitStore = new GitStore(repository, shell, new TestStatsStore())

    await gitStore.fetchRemotes(
      [
        { name: 'origin', url: origin.bare },
        { name: 'missing', url: '/does/not/exist.git' },
      ],
      false
    )

    // origin is still fetched even though the combined fetch failed
    assert.equal(
      await run(repository.path, ['rev-parse', 'origin/main']),
      originTip
    )
  })
})
