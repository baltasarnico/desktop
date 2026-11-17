import { readFile, readdir, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { Repository } from '../../models/repository'

/**
 * Results of Git commands that only depend on a handful of files in the Git
 * directory, keyed by command and repository. See `cachedByFingerprint`.
 */
const cache = new Map<
  string,
  { readonly fingerprint: string; value: unknown }
>()

async function statFingerprint(path: string): Promise<string> {
  try {
    const s = await stat(path, { bigint: true })
    return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  } catch {
    return 'missing'
  }
}

/**
 * Fingerprint a directory tree by the stat of every directory in it. Creating,
 * replacing (Git writes refs through a lock file which is renamed into place)
 * or deleting a file changes the modification time of its directory.
 */
async function directoryTreeFingerprint(path: string): Promise<string> {
  const parts = [await statFingerprint(path)]
  try {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        parts.push(await directoryTreeFingerprint(join(path, entry.name)))
      }
    }
  } catch {
    // Missing directories are covered by the 'missing' stat above.
  }
  return parts.join(',')
}

/**
 * The directories that hold a repository's own metadata (HEAD and its reflog)
 * and its shared metadata (refs, packed-refs, reflogs of refs), which differ
 * for linked worktrees.
 *
 * Returns null when the repository uses a ref storage backend other than
 * plain files (reftable), in which case nothing can be fingerprinted.
 */
async function getGitDirectories(
  repository: Repository
): Promise<{ readonly gitDir: string; readonly commonDir: string } | null> {
  const gitDir = repository.resolvedGitDir
  const commonDir = await readFile(join(gitDir, 'commondir'), 'utf8').then(
    dir => resolve(gitDir, dir.trim()),
    () => gitDir
  )

  if ((await statFingerprint(join(commonDir, 'reftable'))) !== 'missing') {
    return null
  }

  return { gitDir, commonDir }
}

/**
 * Run `compute` unless the files it depends on haven't changed since the
 * last time it ran for the same key, in which case its previous result is
 * returned. `getInputs` returns the fingerprints of those files, or null if
 * the result can't be cached.
 */
async function cachedByFingerprint<T>(
  key: string,
  getInputs: () => Promise<ReadonlyArray<string> | null>,
  compute: () => Promise<T>
): Promise<T> {
  const inputs = await getInputs()
  if (inputs === null) {
    cache.delete(key)
    return compute()
  }

  const fingerprint = inputs.join('\0')
  const cached = cache.get(key)
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    // The cache only ever stores values produced by `compute` for this key.
    return cached.value as T
  }

  const value = await compute()
  cache.set(key, { fingerprint, value })
  return value
}

/** Cache a result which depends on the repository's HEAD reflog. */
export function cachedByHeadReflog<T>(
  repository: Repository,
  name: string,
  compute: () => Promise<T>
): Promise<T> {
  return cachedByFingerprint(
    `${name}:${repository.path}`,
    async () => {
      const dirs = await getGitDirectories(repository)
      if (dirs === null) {
        return null
      }
      const reflog = await statFingerprint(join(dirs.gitDir, 'logs', 'HEAD'))
      // Without a reflog (unborn branch, reflogs disabled) we can't tell
      // whether anything changed.
      return reflog === 'missing' ? null : [reflog]
    },
    compute
  )
}

/** Cache a result which depends on the repository's tags. */
export function cachedByTags<T>(
  repository: Repository,
  name: string,
  compute: () => Promise<T>
): Promise<T> {
  return cachedByFingerprint(
    `${name}:${repository.path}`,
    async () => {
      const dirs = await getGitDirectories(repository)
      if (dirs === null) {
        return null
      }
      return [
        await statFingerprint(join(dirs.commonDir, 'packed-refs')),
        await directoryTreeFingerprint(join(dirs.commonDir, 'refs', 'tags')),
      ]
    },
    compute
  )
}

/** Cache a result which depends on the repository's stash reflog. */
export function cachedByStash<T>(
  repository: Repository,
  name: string,
  compute: () => Promise<T>
): Promise<T> {
  return cachedByFingerprint(
    `${name}:${repository.path}`,
    async () => {
      const dirs = await getGitDirectories(repository)
      if (dirs === null) {
        return null
      }
      return Promise.all([
        statFingerprint(join(dirs.commonDir, 'logs', 'refs', 'stash')),
        statFingerprint(join(dirs.commonDir, 'refs', 'stash')),
        statFingerprint(join(dirs.commonDir, 'packed-refs')),
      ])
    },
    compute
  )
}
