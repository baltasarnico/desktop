import assert from 'node:assert'
import { describe, it, TestContext } from 'node:test'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { exec } from 'dugite'
import { getRecentBranches } from '../../../src/lib/git/reflog'
import { getAllTags } from '../../../src/lib/git/tag'
import { getStashes } from '../../../src/lib/git/stash'
import { createDesktopStashMessage } from '../../../src/lib/git/stash'
import { setupEmptyRepository } from '../../helpers/repositories'
import { createTempDirectory } from '../../helpers/temp'
import { Repository } from '../../../src/models/repository'

async function countGitSpawns(
  t: TestContext,
  operation: () => Promise<unknown>
): Promise<number> {
  const trace = join(await createTempDirectory(t), 'trace.jsonl')
  process.env.GIT_TRACE2_EVENT = trace
  try {
    await operation()
  } finally {
    delete process.env.GIT_TRACE2_EVENT
  }
  const contents = await readFile(trace, 'utf8').catch(() => '')
  return contents.split('\n').filter(l => l.includes('"event":"start"')).length
}

async function run(repository: Repository, args: string[]) {
  const result = await exec(args, repository.path)
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}

async function setup(t: TestContext) {
  const repository = await setupEmptyRepository(t)
  await writeFile(join(repository.path, 'file.txt'), 'one\n')
  await run(repository, ['add', '.'])
  await run(repository, ['commit', '-m', 'init'])
  return repository
}

describe('fingerprint cached Git reads', () => {
  it('reuses recent branches until HEAD moves', async t => {
    const repository = await setup(t)
    await run(repository, ['checkout', '-q', '-b', 'feature'])
    assert.deepEqual(await getRecentBranches(repository, 5), ['feature'])

    assert.equal(
      await countGitSpawns(t, () => getRecentBranches(repository, 5)),
      0
    )

    await run(repository, ['checkout', '-q', '-b', 'other'])
    assert.deepEqual(await getRecentBranches(repository, 5), [
      'other',
      'feature',
    ])
  })

  it('reuses tags until a tag is added or removed', async t => {
    const repository = await setup(t)
    const head = await run(repository, ['rev-parse', 'HEAD'])
    await run(repository, ['tag', 'v1'])
    assert.deepEqual([...(await getAllTags(repository))], [['v1', head]])

    assert.equal(await countGitSpawns(t, () => getAllTags(repository)), 0)

    // Tags with slashes live in nested directories
    await run(repository, ['tag', 'release/v2'])
    assert.ok((await getAllTags(repository)).has('release/v2'))

    await run(repository, ['tag', '-d', 'release/v2'])
    assert.equal((await getAllTags(repository)).has('release/v2'), false)

    await run(repository, ['pack-refs', '--all'])
    await run(repository, ['tag', '-d', 'v1'])
    assert.equal((await getAllTags(repository)).size, 0)
  })

  it('returns a copy of the cached tags', async t => {
    const repository = await setup(t)
    await run(repository, ['tag', 'v1'])
    const first = await getAllTags(repository)
    first.clear()
    assert.equal((await getAllTags(repository)).size, 1)
  })

  it('reuses stash entries until the stash changes', async t => {
    const repository = await setup(t)
    const branch = await run(repository, ['rev-parse', '--abbrev-ref', 'HEAD'])
    assert.equal((await getStashes(repository)).stashEntryCount, 0)
    assert.equal(await countGitSpawns(t, () => getStashes(repository)), 0)

    await writeFile(join(repository.path, 'file.txt'), 'two\n')
    await run(repository, [
      'stash',
      'push',
      '-m',
      createDesktopStashMessage(branch),
    ])
    const stashes = await getStashes(repository)
    assert.equal(stashes.desktopEntries.length, 1)

    await run(repository, ['stash', 'drop'])
    assert.equal((await getStashes(repository)).desktopEntries.length, 0)
  })
})
