import assert from 'node:assert'
import { describe, it, TestContext } from 'node:test'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { exec } from 'dugite'
import { warmUntrackedCache } from '../../../src/lib/git/status'
import { getStatusOrThrow } from '../../helpers/status'
import { setupEmptyRepository } from '../../helpers/repositories'

/** Whether the index carries Git's untracked cache extension. */
async function hasUntrackedCache(gitDir: string) {
  const index = await readFile(join(gitDir, 'index'))
  return index.includes(Buffer.from('UNTR'))
}

async function setup(t: TestContext) {
  const repository = await setupEmptyRepository(t)
  for (const dir of ['a', 'b', 'c']) {
    await mkdir(join(repository.path, dir))
    await writeFile(join(repository.path, dir, 'tracked.txt'), 'x\n')
  }
  await exec(['add', '.'], repository.path)
  await exec(['commit', '-m', 'init'], repository.path)
  await writeFile(join(repository.path, 'b', 'untracked.txt'), 'y\n')
  return repository
}

describe('warmUntrackedCache', () => {
  it('writes the untracked cache that read-only status then uses', async t => {
    const repository = await setup(t)
    const gitDir = join(repository.path, '.git')

    // Desktop's own status never writes the cache
    await getStatusOrThrow(repository)
    assert.equal(await hasUntrackedCache(gitDir), false)

    await warmUntrackedCache(repository)
    assert.equal(await hasUntrackedCache(gitDir), true)

    // Status results are unaffected, including new untracked files
    await writeFile(join(repository.path, 'c', 'new.txt'), 'z\n')
    const status = await getStatusOrThrow(repository)
    const paths = status.workingDirectory.files.map(f => f.path).sort()
    assert.deepEqual(paths, ['b/untracked.txt', 'c/new.txt'])
  })

  it('respects core.untrackedCache=false', async t => {
    const repository = await setup(t)
    await exec(['config', 'core.untrackedCache', 'false'], repository.path)

    await warmUntrackedCache(repository)

    assert.equal(await hasUntrackedCache(join(repository.path, '.git')), false)
  })
})
