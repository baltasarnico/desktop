import { git } from './core'

/**
 * Above this combined length, paths aren't passed on the command line (to
 * stay well within command line length limits) and the whole working
 * directory is checked instead.
 */
const MaxPathsLength = 30000

/**
 * Returns a list of files with conflict markers present
 *
 * @param repositoryPath filepath to repository
 * @param paths          when given, only check these paths (for example the
 *                       conflicted files) rather than every changed file
 * @returns filepaths with their number of conflicted markers
 */
export async function getFilesWithConflictMarkers(
  repositoryPath: string,
  paths?: ReadonlyArray<string>
): Promise<Map<string, number>> {
  if (paths !== undefined && paths.length === 0) {
    return new Map()
  }

  const limitToPaths =
    paths !== undefined &&
    paths.reduce((length, path) => length + path.length + 1, 0) <=
      MaxPathsLength

  const { stdout } = await git(
    limitToPaths
      ? ['--literal-pathspecs', 'diff', '--check', '--', ...paths]
      : ['diff', '--check'],
    repositoryPath,
    'getFilesWithConflictMarkers',
    { successExitCodes: new Set([0, 2]) }
  )

  const files = new Map<string, number>()
  const matches = stdout.matchAll(/^(.+):\d+: leftover conflict marker/gm)

  for (const [, path] of matches) {
    files.set(path, (files.get(path) ?? 0) + 1)
  }

  return files
}
