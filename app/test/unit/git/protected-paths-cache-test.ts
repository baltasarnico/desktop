import assert from 'node:assert'
import { describe, it, TestContext } from 'node:test'
import { join } from 'path'
import { readFile, symlink, unlink, writeFile } from 'fs/promises'
import {
  getAssistedCommitProtectedPaths,
  getCachedAssistedCommitProtectedPaths,
} from '../../../src/lib/git/repository-operation'
import { Repository } from '../../../src/models/repository'
import { rawGit, seed } from '../../helpers/assisted-commit'
import { createTempDirectory } from '../../helpers/temp'

/** Count the Git processes Desktop spawns while running `operation`. */
async function countGitSpawns(
  t: TestContext,
  operation: () => Promise<unknown>
): Promise<number> {
  const trace = join(await createTempDirectory(t), 'trace.jsonl')
  const previous = process.env.GIT_TRACE2_EVENT
  process.env.GIT_TRACE2_EVENT = trace
  try {
    await operation()
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_TRACE2_EVENT
    } else {
      process.env.GIT_TRACE2_EVENT = previous
    }
  }
  const contents = await readFile(trace, 'utf8').catch(() => '')
  return contents.split('\n').filter(l => l.includes('"event":"start"')).length
}

describe('getCachedAssistedCommitProtectedPaths', () => {
  it('matches a fresh lookup for a plain repository', async t => {
    const repository = await seed(t, { file: 'content\n' })
    assert.deepStrictEqual(
      await getCachedAssistedCommitProtectedPaths(repository.path),
      await getAssistedCommitProtectedPaths(repository.path)
    )
  })

  it('matches a fresh lookup for a linked worktree', async t => {
    const repository = await seed(t, { file: 'content\n' })
    const worktreePath = join(await createTempDirectory(t), 'linked')
    await rawGit(repository, ['worktree', 'add', '-b', 'linked', worktreePath])
    assert.deepStrictEqual(
      await getCachedAssistedCommitProtectedPaths(worktreePath),
      await getAssistedCommitProtectedPaths(worktreePath)
    )
  })

  it('does not spawn Git again while nothing changed', async t => {
    const repository = await seed(t, { file: 'content\n' })
    const first = await getCachedAssistedCommitProtectedPaths(repository.path)
    let second: ReadonlyArray<string> = []
    const spawns = await countGitSpawns(t, async () => {
      second = await getCachedAssistedCommitProtectedPaths(repository.path)
    })
    assert.strictEqual(spawns, 0)
    assert.strictEqual(second, first)
  })

  it('refreshes when alternates are added', async t => {
    const source = await seed(t, { source: 'content\n' })
    const clonePath = join(await createTempDirectory(t), 'clone')
    await rawGit(source, ['clone', '--', source.path, clonePath])
    const clone = new Repository(clonePath, -1, null, false)

    const before = await getCachedAssistedCommitProtectedPaths(clone.path)
    await writeFile(
      join(clone.path, '.git', 'objects', 'info', 'alternates'),
      `${join(source.path, '.git', 'objects')}\n`
    )
    const after = await getCachedAssistedCommitProtectedPaths(clone.path)

    assert.notDeepStrictEqual(after, before)
    assert.deepStrictEqual(
      after,
      await getAssistedCommitProtectedPaths(clone.path)
    )
  })

  it('refreshes when a symlinked path is retargeted', async t => {
    const first = await seed(t, { first: 'content\n' })
    const second = await seed(t, { second: 'content\n' })
    const alias = join(await createTempDirectory(t), 'checkout')
    await symlink(first.path, alias, 'junction')
    const before = await getCachedAssistedCommitProtectedPaths(alias)

    await unlink(alias)
    await symlink(second.path, alias, 'junction')
    const after = await getCachedAssistedCommitProtectedPaths(alias)

    assert.notDeepStrictEqual(after, before)
    assert.deepStrictEqual(after, await getAssistedCommitProtectedPaths(alias))
  })

  it('refreshes after a fresh lookup replaced the lock paths', async t => {
    const repository = await seed(t, { file: 'content\n' })
    await getCachedAssistedCommitProtectedPaths(repository.path)
    const fresh = await getAssistedCommitProtectedPaths(repository.path)
    const spawns = await countGitSpawns(t, () =>
      getCachedAssistedCommitProtectedPaths(repository.path)
    )
    assert.ok(spawns > 0)
    assert.deepStrictEqual(
      await getCachedAssistedCommitProtectedPaths(repository.path),
      fresh
    )
  })
})
