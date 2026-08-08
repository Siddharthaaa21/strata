import { notFound } from 'next/navigation';
import type { DocId } from '@strata/core';
import { AppShell } from '../../../components/AppShell';
import { ReaderScreen } from '../../../components/ReaderScreen';
import { requireVault } from '../../../lib/vault';

/**
 * screen-reader — design/handoff/README.md:27.
 *
 * `store.get` re-checks scope and throws NotFound for both a missing document and one in another
 * workspace, so this renders a 404 either way. That indistinguishability is deliberate: a
 * distinguishable error would tell a visitor which document ids exist.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { docs, sources, scope } = await requireVault();

  let doc;
  try {
    doc = await docs.get(scope, id as DocId);
  } catch {
    notFound();
  }

  const source = (await sources.list(scope)).find((s) => s.id === doc.sourceId);
  if (!source) notFound();

  // Same folder first, then anything else. There is no relatedness model yet — this is proximity,
  // not similarity, and it is labelled as such rather than implying semantic relation.
  const all = await docs.list(scope, { limit: 50 });
  const others = all.filter((d) => d.id !== doc.id);
  const related = [
    ...others.filter((d) => d.folder === doc.folder.value),
    ...others.filter((d) => d.folder !== doc.folder.value),
  ]
    .slice(0, 3)
    .map((d) => ({ id: d.id, title: d.title }));

  return (
    <AppShell>
      <ReaderScreen doc={doc} source={source} related={related} />
    </AppShell>
  );
}
