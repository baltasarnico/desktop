interface ICoalescingEntry {
  /** The run that is currently executing for this key. */
  running: Promise<void>
  /** The single run queued behind `running`, if any. */
  queued: Promise<void> | null
  /** The most recent operation requested while a run was in flight. */
  next: (() => Promise<void>) | null
}

/**
 * A function that runs an asynchronous operation for a key, making sure that
 * at most one operation per key is in flight and at most one is queued.
 *
 * Calls made while an operation is running share a single queued run that
 * starts once the current run settles and executes the most recently
 * requested operation. Every returned promise therefore settles only after a
 * run that started after the call was made.
 */
export type CoalescingRunner<K> = (
  key: K,
  operation: () => Promise<void>
) => Promise<void>

/** Create a new, empty coalescing runner. See `CoalescingRunner`. */
export function createCoalescingRunner<K>(): CoalescingRunner<K> {
  const entries = new Map<K, ICoalescingEntry>()

  const execute = async (
    key: K,
    entry: ICoalescingEntry,
    operation: () => Promise<void>
  ) => {
    try {
      await operation()
    } finally {
      if (entry.queued === null && entries.get(key) === entry) {
        entries.delete(key)
      }
    }
  }

  return (key, operation) => {
    const existing = entries.get(key)

    if (existing === undefined) {
      const entry: ICoalescingEntry = {
        running: Promise.resolve(),
        queued: null,
        next: null,
      }
      entries.set(key, entry)
      entry.running = execute(key, entry, operation)
      return entry.running
    }

    existing.next = operation

    if (existing.queued === null) {
      const ignore = () => {}
      existing.queued = existing.running.then(ignore, ignore).then(() => {
        const next = existing.next ?? operation
        existing.next = null
        existing.queued = null
        existing.running = execute(key, existing, next)
        return existing.running
      })
    }

    return existing.queued
  }
}
