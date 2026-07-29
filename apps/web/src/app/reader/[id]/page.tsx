import { notFound } from 'next/navigation';
import { docs, sources, type DocId } from '@strata/core';
import { AppShell } from '../../../components/AppShell';
import { ReaderScreen } from '../../../components/ReaderScreen';

/** screen-reader — design/handoff/README.md:27. Resolves `id` against the fixture Docs; 404s otherwise. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = docs.find((d) => d.id === (id as DocId));
  if (!doc) notFound();

  const source = sources.find((s) => s.id === doc.sourceId);
  if (!source) notFound();

  return (
    <AppShell>
      <ReaderScreen doc={doc} source={source} />
    </AppShell>
  );
}
