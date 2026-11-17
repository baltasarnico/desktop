import { createHash } from 'crypto'
import { ITokens, IHighlightRequest } from './types'
import { encodePathAsUrl } from '../../lib/path'

const highlightWorkers = new Array<Worker>()
const maxIdlingWorkers = 2
const workerMaxRunDuration = 5 * 1000

/** Idle workers are terminated after this long to free their memory. */
const workerMaxIdleDuration = 60 * 1000
const idleWorkerTimeouts = new Map<Worker, number>()

/**
 * Recent highlighting results. Re-selecting a file, or a refresh that
 * produces an identical diff, would otherwise tokenize the same contents
 * again.
 */
const maxCachedResults = 20
const cachedResults = new Map<string, ITokens>()

function getCacheKey(
  contentLines: ReadonlyArray<string>,
  basename: string,
  extension: string,
  tabSize: number,
  lines: ReadonlyArray<number>
) {
  const hash = createHash('sha1')
  hash.update(JSON.stringify([basename, extension, tabSize, lines]))
  for (const line of contentLines) {
    hash.update(line)
    hash.update('\n')
  }
  return hash.digest('hex')
}

function takeIdleWorker(): Worker | undefined {
  const worker = highlightWorkers.shift()
  if (worker !== undefined) {
    window.clearTimeout(idleWorkerTimeouts.get(worker))
    idleWorkerTimeouts.delete(worker)
  }
  return worker
}

function releaseWorker(worker: Worker) {
  if (highlightWorkers.length >= maxIdlingWorkers) {
    worker.terminate()
    return
  }

  highlightWorkers.push(worker)
  idleWorkerTimeouts.set(
    worker,
    window.setTimeout(() => {
      idleWorkerTimeouts.delete(worker)
      const index = highlightWorkers.indexOf(worker)
      if (index !== -1) {
        highlightWorkers.splice(index, 1)
        worker.terminate()
      }
    }, workerMaxIdleDuration)
  )
}
const workerUri = encodePathAsUrl(__dirname, 'highlighter.js')

/**
 * Request an automatic detection of the language and highlight
 * the contents provided.
 *
 * @param contents  The actual contents which is to be used for
 *                  highlighting.
 * @param basename  The file basename of the path in question as returned
 *                  by node's basename() function (i.e. without a leading dot).
 * @param extension The file extension of the path in question as returned
 *                  by node's extname() function (i.e. with a leading dot).
 * @param tabSize   The width of a tab character. Defaults to 4. Used by the
 *                  stream to count columns. See CodeMirror's StringStream
 *                  class for more details.
 * @param lines     An optional filter of lines which needs to be tokenized.
 *
 *                  If undefined or empty all lines will be tokenized
 *                  and returned. By passing an explicit set of lines we can
 *                  both minimize the size of the response object (which needs
 *                  to be serialized over the IPC boundary) and, for stateless
 *                  modes we can significantly speed up the highlight process.
 */
export function highlight(
  contentLines: ReadonlyArray<string>,
  basename: string,
  extension: string,
  tabSize: number,
  lines: Array<number>
): Promise<ITokens> {
  // Bail early if there's no content to highlight or if we don't
  // need any lines from this file.
  if (!contentLines.length || !lines.length) {
    return Promise.resolve({})
  }

  const cacheKey = getCacheKey(
    contentLines,
    basename,
    extension,
    tabSize,
    lines
  )
  const cached = cachedResults.get(cacheKey)
  if (cached !== undefined) {
    // Move to the end to keep the most recently used results
    cachedResults.delete(cacheKey)
    cachedResults.set(cacheKey, cached)
    return Promise.resolve(cached)
  }

  // Get an idle worker or create a new one if none exist.
  const worker = takeIdleWorker() ?? new Worker(workerUri)

  return new Promise<ITokens>((resolve, reject) => {
    let timeout: null | number = null

    const clearTimeout = () => {
      if (timeout) {
        window.clearTimeout(timeout)
        timeout = null
      }
    }

    worker.onerror = ev => {
      clearTimeout()
      worker.terminate()
      reject(ev.error || new Error(ev.message))
    }

    worker.onmessage = ev => {
      clearTimeout()
      releaseWorker(worker)
      const tokens = ev.data as ITokens
      cachedResults.set(cacheKey, tokens)
      if (cachedResults.size > maxCachedResults) {
        const oldest = cachedResults.keys().next().value
        if (oldest !== undefined) {
          cachedResults.delete(oldest)
        }
      }
      resolve(tokens)
    }

    const request: IHighlightRequest = {
      contentLines,
      basename,
      extension,
      tabSize,
      lines,
      addModeClass: true,
    }

    worker.postMessage(request)

    timeout = window.setTimeout(() => {
      worker.terminate()
      reject(new Error('timed out'))
    }, workerMaxRunDuration)
  })
}
