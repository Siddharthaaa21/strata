'use server';

/**
 * The upload endpoints. Its own module because `'use server'` publishes EVERY export in a file as a
 * remotely callable endpoint — helpers alongside these would be endpoints too.
 *
 * Both take a `FormData`, both re-derive the caller's `Scope` from their session inside
 * `import-upload.ts`, and neither trusts anything the browser sent about who is asking. The file
 * contents are attacker-controlled by definition — that is the entire premise of R2, and they go
 * through the same normalization and fencing as anything the CLI ingests.
 */

import {
  importClaudeExport,
  importGitHubRepo,
  importMarkdownFiles,
  MAX_UPLOAD_BYTES,
  type ImportReport,
} from '../../lib/import-upload.ts';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

/** Total upload budget, checked before anything is decoded. */
function assertWithinBudget(files: readonly File[]): void {
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_UPLOAD_BYTES) {
    throw new Error(
      `That is ${(total / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB per upload — ` +
        'split it, or use `npm run ingest` for a whole vault.',
    );
  }
}

export async function uploadClaudeExport(form: FormData): Promise<ImportReport> {
  const file = form.get('file');
  if (!(file instanceof File)) throw new Error('No file was selected.');
  assertWithinBudget([file]);

  // `scanClaudeExport` throws on a file that is not a conversations array — deliberately, because
  // the export ZIP holds four JSON files and pointing at the wrong one is the likeliest mistake.
  // That message is safe to surface: it names the expectation, never the content.
  return importClaudeExport(await file.text());
}

export async function uploadMarkdown(form: FormData): Promise<ImportReport> {
  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) throw new Error('No files were selected.');
  assertWithinBudget(files);

  // Filtered here rather than left to the adapter, which would record each one as an
  // `unsupported-type` failure. A user who drags a folder containing images and lockfiles has not
  // made two hundred mistakes; those files are simply not what this imports, and reporting them as
  // failures would bury the one real failure that mattered.
  const markdown = files.filter((f) =>
    MARKDOWN_EXTENSIONS.some((ext) => (f.name ?? '').toLowerCase().endsWith(ext)),
  );
  if (markdown.length === 0) {
    throw new Error('None of those files are Markdown (.md or .markdown).');
  }

  return importMarkdownFiles(
    await Promise.all(
      markdown.map(async (f) => ({
        // `webkitRelativePath` when a folder was chosen, so a nested layout keeps its folders and
        // the derived `folder` field means something. Falls back to the bare name for loose files.
        path: relativePath(f),
        text: await f.text(),
        modifiedAt: new Date(f.lastModified).toISOString(),
      })),
    ),
  );
}

/**
 * The path an uploaded file should be identified by.
 *
 * A browser folder pick sets `webkitRelativePath` to `<chosen folder>/a/b.md`. The leading segment
 * is the folder the user happened to select, which is not part of the document's identity — keeping
 * it would mean re-uploading the same vault from a renamed directory re-imports every file as new.
 *
 * The Import screen's own control no longer offers a folder pick (`webkitdirectory` made the input
 * folder-ONLY in Chrome, so loose files could not be selected at all — see `ConnectorAction.tsx`),
 * which means the fallback is now the path this normally takes. The branch stays because the field
 * is set by any caller that does supply a folder, and losing the leading-segment strip would
 * silently reintroduce the re-import-everything bug the moment one does.
 */
function relativePath(file: File): string {
  const declared = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (typeof declared !== 'string' || declared === '') return file.name;
  const withoutRoot = declared.split('/').slice(1).join('/');
  return withoutRoot === '' ? file.name : withoutRoot;
}

/**
 * Indexes a GitHub repository.
 *
 * The repo string is attacker-controlled like everything else a browser sends. `parseRepoRef`
 * validates it before it reaches a request path; the errors it throws carry a CODE, never GitHub's
 * own message, which can quote request URLs and — on a private repository — path names.
 */
export async function importGitHub(repo: string): Promise<ImportReport & { incomplete: boolean }> {
  if (typeof repo !== 'string' || repo.trim() === '' || repo.length > 200) {
    throw new Error('Enter a repository as owner/repo.');
  }

  try {
    return await importGitHubRepo(repo);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    // Mapped to sentences a person can act on. `rate-limited` names the fix, because hitting 60/hour
    // unauthenticated is the single likeliest failure and looks like the feature being broken.
    const messages: Record<string, string> = {
      'repo-invalid': 'That is not a repository. Use owner/repo, or a github.com URL.',
      'not-found': 'No such repository — or it is private and needs GITHUB_TOKEN in .env.',
      unauthorized: 'Not authorized. A private repository needs GITHUB_TOKEN with read access to Contents.',
      'rate-limited':
        'GitHub rate limit reached (60/hour without a token). Set GITHUB_TOKEN in .env for 5,000/hour.',
      network: 'Could not reach github.com.',
    };
    if (code && messages[code]) throw new Error(messages[code]);
    throw e instanceof Error ? new Error('That import failed.') : e;
  }
}
