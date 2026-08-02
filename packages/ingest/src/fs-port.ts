/**
 * Filesystem port. ADR 0003 chose an injected port over real temp-directory fixtures because the
 * failure paths that most need testing — EACCES, a broken symlink, invalid UTF-8 — cannot be
 * produced portably on a real disk.
 *
 * The real implementation is the only place that touches `node:fs`.
 */

export interface FileEntry {
  /** Path relative to the scan root, using POSIX separators. */
  readonly path: string;
  /** True for a symlink. The walker never follows one — see `scan`. */
  readonly isSymlink: boolean;
}

export interface FileStat {
  readonly size: number;
  /** ISO-8601 UTC, from mtime. Never from a frontmatter date (ADR 0003). */
  readonly modifiedAt: string;
  /** ISO-8601 UTC, from birthtime where the platform provides it, else mtime. */
  readonly createdAt: string;
}

/**
 * Errors a port may throw. The adapter maps these to `MarkdownErrorCode`s and never surfaces the
 * underlying message — a filesystem error message can contain a path the user did not intend to
 * disclose, and a parser error can contain document content.
 */
export class PortError extends Error {
  // Declared explicitly rather than as a parameter property: Node's type-stripping runs in
  // strip-only mode and rejects the shorthand.
  readonly kind: 'unreadable' | 'invalid-encoding' | 'not-found';

  constructor(kind: 'unreadable' | 'invalid-encoding' | 'not-found') {
    super(kind);
    this.name = 'PortError';
    this.kind = kind;
  }
}

export interface FileSystemPort {
  /**
   * Lists candidate files under a root, recursively.
   *
   * Must not follow symlinks: a symlink out of the scanned root is arbitrary-file-read, and a cycle
   * hangs the walk. Symlinks are reported with `isSymlink: true` so the adapter can record why they
   * were skipped rather than dropping them silently.
   */
  scan(root: string): Promise<readonly FileEntry[]>;
  stat(root: string, relativePath: string): Promise<FileStat>;
  /** Throws `PortError('invalid-encoding')` rather than substituting replacement characters. */
  readText(root: string, relativePath: string): Promise<string>;
}

/** Node implementation. The only module in this package that imports `node:fs`. */
export function createNodeFileSystemPort(): FileSystemPort {
  return {
    async scan(root) {
      const { readdir } = await import('node:fs/promises');
      const { join, relative, sep } = await import('node:path');
      const out: FileEntry[] = [];

      const walk = async (dir: string) => {
        // Sorted, because bare readdir order is filesystem-defined and can change when an unrelated
        // sibling is added or removed. Anywhere two files contend for one identity, "first wins"
        // would otherwise resolve differently between runs — the same document flip-flopping, which
        // is exactly the failure the pipeline's collision guard exists to make deterministic.
        const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            out.push({ path: relative(root, full).split(sep).join('/'), isSymlink: true });
            continue; // never followed, in either direction
          }
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.isFile()) {
            out.push({ path: relative(root, full).split(sep).join('/'), isSymlink: false });
          }
        }
      };

      await walk(root);
      return out;
    },

    async stat(root, relativePath) {
      const { stat } = await import('node:fs/promises');
      const { join } = await import('node:path');
      try {
        const s = await stat(join(root, relativePath));
        return {
          size: s.size,
          modifiedAt: new Date(s.mtimeMs).toISOString(),
          createdAt: new Date(s.birthtimeMs || s.mtimeMs).toISOString(),
        };
      } catch {
        throw new PortError('unreadable');
      }
    },

    async readText(root, relativePath) {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      let buf: Buffer;
      try {
        buf = await readFile(join(root, relativePath));
      } catch {
        throw new PortError('unreadable');
      }
      // Decode strictly: a replacement character would silently corrupt content and its hash.
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        throw new PortError('invalid-encoding');
      }
    },
  };
}
