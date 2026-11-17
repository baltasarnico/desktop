import assert from 'node:assert'
import { describe, it, TestContext } from 'node:test'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { exec } from 'dugite'
import { loadDisplayDiff } from '../../../src/lib/assisted-commit/selection-display'
import { getStatusOrThrow } from '../../helpers/status'
import { setupEmptyRepository } from '../../helpers/repositories'
import { createTempDirectory } from '../../helpers/temp'
import { Repository } from '../../../src/models/repository'
import { DiffType } from '../../../src/models/diff'

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

async function setup(t: TestContext) {
  const repository = await setupEmptyRepository(t)
  const file = join(repository.path, 'file.txt')
  await writeFile(file, 'one\n')
  await exec(['add', '.'], repository.path)
  await exec(['commit', '-m', 'init'], repository.path)
  await writeFile(file, 'one\ntwo\n')
  return { repository, file }
}

async function selectedFile(repository: Repository) {
  const status = await getStatusOrThrow(repository)
  const file = status.workingDirectory.files.find(f => f.path === 'file.txt')
  assert.ok(file)
  return file
}

describe('loadDisplayDiff', () => {
  it('reuses the diff while nothing changed', async t => {
    const { repository } = await setup(t)
    const first = await loadDisplayDiff(
      repository,
      await selectedFile(repository),
      false
    )
    assert.equal(first.kind, DiffType.Text)

    const file = await selectedFile(repository)
    let second = first
    const spawns = await countGitSpawns(t, async () => {
      second = await loadDisplayDiff(repository, file, false)
    })
    assert.strictEqual(spawns, 0)
    assert.strictEqual(second, first)
  })

  it('reloads when the file changes', async t => {
    const { repository, file } = await setup(t)
    await loadDisplayDiff(repository, await selectedFile(repository), false)
    await writeFile(file, 'one\ntwo\nthree\n')
    const diff = await loadDisplayDiff(
      repository,
      await selectedFile(repository),
      false
    )
    assert.ok(diff.kind === DiffType.Text)
    assert.ok(diff.text.includes('+three'))
  })

  it('reloads when the index or HEAD change', async t => {
    const { repository } = await setup(t)
    const file = await selectedFile(repository)
    await loadDisplayDiff(repository, file, false)

    await exec(['add', 'file.txt'], repository.path)
    assert.ok(
      (await countGitSpawns(t, () =>
        loadDisplayDiff(repository, file, false)
      )) > 0
    )

    await exec(['commit', '-m', 'second'], repository.path)
    assert.ok(
      (await countGitSpawns(t, () =>
        loadDisplayDiff(repository, file, false)
      )) > 0
    )
  })

  it('reloads when whitespace visibility changes', async t => {
    const { repository } = await setup(t)
    const file = await selectedFile(repository)
    await loadDisplayDiff(repository, file, false)
    assert.ok(
      (await countGitSpawns(t, () => loadDisplayDiff(repository, file, true))) >
        0
    )
  })
})
