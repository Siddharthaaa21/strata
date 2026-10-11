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

import { revalidatePath } from 'next/cache';
import {
  importClaudeExport,
  importGitHubRepo,
  importMarkdownFiles,
  MAX_UPLOAD_BYTES,
  type ImportReport,
} from '../../lib/import-upload.ts';
import { disconnectSourceAction } from '../../lib/vault.ts';

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

export type ActionResult<T = ImportReport> =
  | { ok: true; report: T }
  | { ok: false; error: string };

export async function uploadClaudeExport(form: FormData): Promise<ActionResult<ImportReport>> {
  const file = form.get('file');
  if (!(file instanceof File)) return { ok: false, error: 'No file was selected.' };
  try {
    assertWithinBudget([file]);
    const report = await importClaudeExport(await file.text());
    return { ok: true, report };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'The Claude export could not be read as a list of conversations.';
    return { ok: false, error: msg };
  }
}

export async function uploadMarkdown(form: FormData): Promise<ActionResult<ImportReport>> {
  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) return { ok: false, error: 'No files were selected.' };
  try {
    assertWithinBudget(files);
    const markdown = files.filter((f) =>
      MARKDOWN_EXTENSIONS.some((ext) => (f.name ?? '').toLowerCase().endsWith(ext)),
    );
    if (markdown.length === 0) {
      return { ok: false, error: 'None of those files are Markdown (.md or .markdown).' };
    }
    const report = await importMarkdownFiles(
      await Promise.all(
        markdown.map(async (f) => ({
          path: relativePath(f),
          text: await f.text(),
          modifiedAt: new Date(f.lastModified).toISOString(),
        })),
      ),
    );
    return { ok: true, report };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to import Markdown files.';
    return { ok: false, error: msg };
  }
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
export async function importGitHub(
  repo: string,
): Promise<ActionResult<ImportReport & { incomplete: boolean }>> {
  if (typeof repo !== 'string' || repo.trim() === '' || repo.length > 200) {
    return { ok: false, error: 'Enter a repository as owner/repo (e.g. Siddharthaaa21/strata).' };
  }

  try {
    const report = await importGitHubRepo(repo);
    return { ok: true, report };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    const messages: Record<string, string> = {
      'repo-invalid': 'That is not a repository. Use owner/repo (e.g. Siddharthaaa21/strata), or a github.com URL.',
      'not-found': 'No such repository — or it is private and needs GITHUB_TOKEN in .env.',
      unauthorized: 'Not authorized. A private repository needs GITHUB_TOKEN with read access to Contents.',
      'rate-limited':
        'GitHub rate limit reached (60/hour without a token). Set GITHUB_TOKEN in .env for 5,000/hour.',
      network: 'Could not reach github.com.',
    };
    const msg = (code && messages[code]) || (e instanceof Error ? e.message : 'That import failed.');
    return { ok: false, error: msg };
  }
}

/**
 * Disconnects a source and soft-deletes its documents.
 */
export async function disconnectSource(
  sourceId: string,
): Promise<ActionResult<{ disconnected: string }>> {
  if (typeof sourceId !== 'string' || sourceId.trim() === '') {
    return { ok: false, error: 'Invalid source ID.' };
  }

  try {
    await disconnectSourceAction(sourceId.trim());
    revalidatePath('/import');
    revalidatePath('/');
    return { ok: true, report: { disconnected: sourceId } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to disconnect source.';
    return { ok: false, error: msg };
  }
}
