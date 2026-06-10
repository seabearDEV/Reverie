import fs from 'fs';

/**
 * Append-only JSONL log with an incremental tail cache.
 *
 * Shared machinery for audit.jsonl, telemetry.jsonl, and miss-paths.jsonl —
 * each is an append-only file of one JSON record per line that grows
 * monotonically. Re-reading the whole file on every load costs O(file-size)
 * per invocation, which dominated the reverie_audit tool's cost in v1.11.1
 * manual testing — bulk-batch parallel calls froze the MCP server while
 * queued audit reads serialized through the event loop.
 *
 * The cache holds the parsed entries plus the byte offset of the last
 * successful read. Subsequent reads stat the file: if the size grew, we
 * pread() just the new tail and parse only the new lines. If the size
 * shrank (rotation, truncation, or test cleanup), we drop the cache and
 * re-read from offset 0. If the current path differs from the cached one
 * (tests swap RVR_DATA_DIR), the cache resets. A trailing partial line
 * (an in-flight append whose newline hasn't landed yet) is left unread —
 * the offset only advances past the last complete line, so the partial
 * line is picked up whole on a later refresh. Malformed lines are
 * silently skipped.
 */
export interface JsonlLog<T> {
  /**
   * Append one record as a JSON line. Sync writes use appendFileSync
   * (best-effort, errors swallowed); async writes resolve when the OS
   * write completes and are tracked for flush().
   */
  append(record: T, sync?: boolean): Promise<void>;
  /** Refresh the cache and return a defensive copy in file order. */
  load(): T[];
  /**
   * Refresh the cache and return the live internal array (no copy).
   * Callers must not mutate it — use load() when mutation safety matters.
   */
  view(): readonly T[];
  /**
   * Return only entries appended since the last cache-reading call
   * (load, view, or a previous tail). Used by follow mode to stream new
   * entries without re-scanning the whole log.
   */
  tail(): T[];
  /** Await all pending async appends issued through this log. */
  flush(): Promise<void>;
  /** Reset the in-memory cache. Used by tests that swap RVR_DATA_DIR. */
  clearCache(): void;
}

export function createJsonlLog<T>(getPath: () => string): JsonlLog<T> {
  let cachedEntries: T[] = [];
  let cachedSize = 0;
  let cachedPath = '';

  // Self-evicting on settle — in the long-lived MCP server this set must
  // not grow with call count.
  const pendingWrites = new Set<Promise<void>>();

  function pushLine(line: string): void {
    if (!line.trim()) return;
    try {
      cachedEntries.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed lines
    }
  }

  /**
   * Refresh the in-memory cache from disk. Reads only new tail bytes
   * since the last call.
   */
  function refresh(): void {
    const filePath = getPath();

    if (filePath !== cachedPath) {
      cachedEntries = [];
      cachedSize = 0;
      cachedPath = filePath;
    }

    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      cachedEntries = [];
      cachedSize = 0;
      return;
    }

    if (size < cachedSize) {
      cachedEntries = [];
      cachedSize = 0;
    }

    if (size === cachedSize) {
      return;
    }

    const toRead = size - cachedSize;
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      return;
    }
    try {
      const buffer = Buffer.alloc(toRead);
      let total = 0;
      while (total < toRead) {
        const n = fs.readSync(fd, buffer, total, toRead - total, cachedSize + total);
        if (n <= 0) break;
        total += n;
      }
      const text = buffer.toString('utf8', 0, total);
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        return;
      }
      const completeText = text.slice(0, lastNewline + 1);
      const completeBytes = Buffer.byteLength(completeText, 'utf8');
      const lines = completeText.split('\n');
      for (const line of lines) {
        pushLine(line);
      }
      cachedSize += completeBytes;
    } finally {
      fs.closeSync(fd);
    }
  }

  return {
    append(record: T, sync = false): Promise<void> {
      const line = JSON.stringify(record) + '\n';
      if (sync) {
        try { fs.appendFileSync(getPath(), line, { mode: 0o600 }); } catch { /* best-effort */ }
        return Promise.resolve();
      }
      const p = new Promise<void>((resolve) => {
        fs.appendFile(getPath(), line, { mode: 0o600 }, () => resolve());
      });
      pendingWrites.add(p);
      void p.finally(() => pendingWrites.delete(p));
      return p;
    },

    load(): T[] {
      refresh();
      return cachedEntries.slice();
    },

    view(): readonly T[] {
      refresh();
      return cachedEntries;
    },

    tail(): T[] {
      const prevCount = cachedEntries.length;
      refresh();
      if (cachedEntries.length <= prevCount) return [];
      return cachedEntries.slice(prevCount);
    },

    async flush(): Promise<void> {
      await Promise.all([...pendingWrites]);
    },

    clearCache(): void {
      cachedEntries = [];
      cachedSize = 0;
      cachedPath = '';
    },
  };
}
