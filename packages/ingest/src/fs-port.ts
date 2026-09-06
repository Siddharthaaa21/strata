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

/**
 * Directories never walked, by name, at any depth.
 *
 * Not a nicety. Pointing the ingest at a project root — the obvious thing to do, and the thing the
 * CLI's own usage line invites — walked **1,233** Markdown files in this repository where 77 are the
 * project's own. The other 1,156 were vendored package READMEs and changelogs, and every one of them
 * would have landed in the vault as a document, drowning the content the vault exists to hold.
 *
 * Matched on the directory NAME rather than a path prefix, because a nested `packages/x/node_modules`
 * is the normal shape of a workspace install, not an edge case.
 *
 * A dotfile rule is deliberately NOT used in its place: `.claude/` holds this project's own
 * documentation, and a blanket "skip anything starting with a dot" would silently drop exactly the
 * files somebody went looking for.
 */
export const IGNORED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'coverage',
  '.venv',
  '__pycache__',
];

/** Node implementation. The only module in this package that imports `node:fs`. */
export function createNodeFileSystemPort(
  ignoredDirectories: readonly string[] = IGNORED_DIRECTORIES,
): FileSystemPort {
  return {
    async scan(root) {
      const ignored = new Set(ignoredDirectories);
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
            // Skipped silently, unlike a symlink. A symlink is reported because a user who put one
            // there expects its target imported; nobody expects `node_modules` in their knowledge
            // base, and reporting 1,156 of them as skipped would bury the failures that matter.
            if (ignored.has(entry.name)) continue;
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

/** One uploaded file: its path relative to the chosen root, and its decoded text. */
export interface MemoryFile {
  readonly path: string;
  readonly text: string;
  /** ISO-8601 UTC. Browsers expose `File.lastModified`; nothing exposes a birth time. */
  readonly modifiedAt: string;
}

/**
 * A port over files already in memory, for uploads.
 *
 * Exists so the web app ingests through **`scanMarkdown` itself** rather than through a second
 * implementation that happens to agree with it. Everything the adapter guarantees — identity,
 * canonicalization, frontmatter rules, the failure taxonomy, the NUL check — applies to an upload
 * because it is literally the same code, and a browser-only path would be a second thing to review
 * where the one nobody reviews is the one that ships a bug.
 *
 * `createdAt` falls back to `modifiedAt`: a browser has no birth time to offer, and inventing one
 * would put a fabricated timestamp on a document whose recency drives ranking (ADR 0004).
 *
 * Symlinks cannot occur — an upload is bytes, not a tree — so every entry reports `isSymlink: false`
 * truthfully rather than defensively.
 */
export function createMemoryFileSystemPort(files: readonly MemoryFile[]): FileSystemPort {
  const byPath = new Map(files.map((f) => [f.path, f]));

  return {
    async scan() {
      // Sorted for the same reason the node port sorts: wherever two files contend for one
      // identity, "first wins" must be deterministic rather than dependent on enumeration order.
      return [...byPath.keys()].sort().map((path) => ({ path, isSymlink: false }));
    },
    async stat(_root, path) {
      const file = byPath.get(path);
      if (file === undefined) throw new PortError('unreadable');
      return {
        size: Buffer.byteLength(file.text, 'utf8'),
        modifiedAt: file.modifiedAt,
        createdAt: file.modifiedAt,
      };
    },
    async readText(_root, path) {
      const file = byPath.get(path);
      if (file === undefined) throw new PortError('unreadable');
      return file.text;
    },
  };
}
