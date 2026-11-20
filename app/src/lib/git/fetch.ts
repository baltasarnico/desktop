import { git, IGitStringExecutionOptions } from './core'
import { Repository } from '../../models/repository'
import { IFetchProgress } from '../../models/progress'
import { FetchProgressParser, executionOptionsWithProgress } from '../progress'
import { IRemote } from '../../models/remote'
import { ITrackingBranch } from '../../models/branch'
import { envForRemoteOperation } from './environment'

/**
 * Configuration that makes a fetch from (or pull with) the given remotes keep
 * `refs/remotes/<remote>/HEAD` pointing at the remote's default branch.
 *
 * Git learns the remote's HEAD while fetching anyway, so this replaces running
 * `git remote set-head -a` afterwards, which connects to the remote a second
 * time.
 */
export function followRemoteHEADArgs(
  remotes: ReadonlyArray<string>
): ReadonlyArray<string> {
  return remotes.flatMap(remote => [
    '-c',
    `remote.${remote}.followRemoteHEAD=always`,
  ])
}

async function getFetchArgs(
  remotes: ReadonlyArray<string>,
  progressCallback: ((progress: IFetchProgress) => void) | undefined
) {
  return [
    ...followRemoteHEADArgs(remotes),
    'fetch',
    ...(progressCallback ? ['--progress'] : []),
    '--prune',
    '--recurse-submodules=on-demand',
    // Fetch several remotes in one go, connecting to them in parallel rather
    // than one after the other.
    ...(remotes.length > 1 ? ['--multiple', `--jobs=${remotes.length}`] : []),
    '--',
    ...remotes,
  ]
}

/**
 * Fetch from the given remote.
 *
 * @param repository - The repository to fetch into
 *
 * @param account    - The account to use when authenticating with the remote
 *
 * @param remote     - The remote to fetch from
 *
 * @param progressCallback - An optional function which will be invoked
 *                           with information about the current progress
 *                           of the fetch operation. When provided this enables
 *                           the '--progress' command line flag for
 *                           'git fetch'.
 * @param isBackgroundTask  - Whether the fetch is being performed as a
 *                            background task as opposed to being user initiated
 */
export async function fetch(
  repository: Repository,
  remote: IRemote,
  progressCallback?: (progress: IFetchProgress) => void,
  isBackgroundTask = false
): Promise<void> {
  let opts: IGitStringExecutionOptions = {
    successExitCodes: new Set([0]),
    env: await envForRemoteOperation(remote.url),
  }

  if (progressCallback) {
    const title = `Fetching ${remote.name}`
    const kind = 'fetch'

    opts = await executionOptionsWithProgress(
      { ...opts, trackLFSProgress: true, isBackgroundTask },
      new FetchProgressParser(),
      progress => {
        // In addition to progress output from the remote end and from
        // git itself, the stderr output from pull contains information
        // about ref updates. We don't need to bring those into the progress
        // stream so we'll just punt on anything we don't know about for now.
        if (progress.kind === 'context') {
          if (!progress.text.startsWith('remote: Counting objects')) {
            return
          }
        }

        const description =
          progress.kind === 'progress' ? progress.details.text : progress.text
        const value = progress.percent

        progressCallback({
          kind,
          title,
          description,
          value,
          remote: remote.name,
        })
      }
    )

    // Initial progress
    progressCallback({ kind, title, value: 0, remote: remote.name })
  }

  const args = await getFetchArgs([remote.name], progressCallback)

  await git(args, repository.path, 'fetch', opts)
}

/**
 * Fetch from several remotes at once, in a single parallel Git process.
 *
 * All remotes must share the same remote operation environment (see
 * `canFetchTogether`) as the process can only have one.
 */
export async function fetchMultiple(
  repository: Repository,
  remotes: ReadonlyArray<IRemote>,
  progressCallback?: (progress: IFetchProgress) => void,
  isBackgroundTask = false
): Promise<void> {
  if (remotes.length === 0) {
    return
  }

  let opts: IGitStringExecutionOptions = {
    successExitCodes: new Set([0]),
    env: await envForRemoteOperation(remotes[0].url),
  }
  const remoteNames = remotes.map(r => r.name)

  if (progressCallback) {
    const title = `Fetching ${remoteNames.join(', ')}`
    const kind = 'fetch'
    const remote = remoteNames.join(', ')

    opts = await executionOptionsWithProgress(
      { ...opts, trackLFSProgress: true, isBackgroundTask },
      new FetchProgressParser(),
      progress => {
        if (progress.kind === 'context') {
          if (!progress.text.startsWith('remote: Counting objects')) {
            return
          }
        }

        const description =
          progress.kind === 'progress' ? progress.details.text : progress.text

        progressCallback({
          kind,
          title,
          description,
          value: progress.percent,
          remote,
        })
      }
    )

    progressCallback({ kind, title, value: 0, remote })
  }

  const args = await getFetchArgs(remoteNames, progressCallback)

  await git(args, repository.path, 'fetch', opts)
}

/**
 * Whether the remotes can be fetched by a single Git process, which requires
 * them to need the same environment (e.g. proxy settings).
 */
export async function canFetchTogether(
  remotes: ReadonlyArray<IRemote>
): Promise<boolean> {
  const environments = await Promise.all(
    remotes.map(async r => JSON.stringify(await envForRemoteOperation(r.url)))
  )
  return new Set(environments).size <= 1
}

/** Fetch a given refspec from the given remote. */
export async function fetchRefspec(
  repository: Repository,
  remote: IRemote,
  refspec: string
): Promise<void> {
  await git(
    ['fetch', '--', remote.name, refspec],
    repository.path,
    'fetchRefspec',
    {
      successExitCodes: new Set([0, 128]),
      env: await envForRemoteOperation(remote.url),
    }
  )
}

/** Fast-forward tracking branches. */
export async function fastForwardBranches(
  repository: Repository,
  branches: ReadonlyArray<ITrackingBranch>
): Promise<void> {
  if (branches.length === 0) {
    return
  }

  const refPairs = branches.map(branch => `${branch.upstreamRef}:${branch.ref}`)

  await git(
    [
      'fetch',
      '.',
      // Make sure we don't try to update branches that can't be fast-forwarded
      // even if the user disabled this via the git config option
      // `fetch.showForcedUpdates`
      '--show-forced-updates',
      // Prevent `git fetch` from touching the `FETCH_HEAD`
      '--no-write-fetch-head',
      // Take branch refs from stdin to circumvent shell max line length
      // limitations (mainly on Windows)
      '--stdin',
    ],
    repository.path,
    'fastForwardBranches',
    {
      // Fetch exits with an exit code of 1 if one or more refs failed to update
      // which is what we expect will happen
      successExitCodes: new Set([0, 1]),
      env: {
        // This will make sure the reflog entries are correct after
        // fast-forwarding the branches.
        GIT_REFLOG_ACTION: 'pull',
      },
      stdin: refPairs.join('\n'),
    }
  )
}
