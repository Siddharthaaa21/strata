import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRecentImports, type RecentImport } from './recent-import-grouping.ts';

test('groupRecentImports groups items with the same folder into a single group', () => {
  const items: RecentImport[] = [
    {
      id: 'evt-1',
      title: 'README.md',
      folder: 'Siddharthaaa21/PorTfolio-React',
      occurredAt: '2026-09-17T10:00:00.000Z',
    },
    {
      id: 'evt-2',
      title: 'package.json',
      folder: 'Siddharthaaa21/PorTfolio-React',
      occurredAt: '2026-09-17T10:05:00.000Z',
    },
    {
      id: 'evt-3',
      title: 'architecture.md',
      folder: 'Siddharthaaa21/agentic-calendar-system',
      occurredAt: '2026-09-17T11:00:00.000Z',
    },
  ];

  const groups = groupRecentImports(items);

  assert.equal(groups.length, 2);

  const portfolioGroup = groups.find((g) => g.folder === 'Siddharthaaa21/PorTfolio-React');
  assert.ok(portfolioGroup);
  assert.equal(portfolioGroup.items.length, 2);
  assert.equal(portfolioGroup.lastOccurredAt, '2026-09-17T10:05:00.000Z');
  assert.deepEqual(
    portfolioGroup.items.map((i) => i.title),
    ['README.md', 'package.json'],
  );

  const calendarGroup = groups.find((g) => g.folder === 'Siddharthaaa21/agentic-calendar-system');
  assert.ok(calendarGroup);
  assert.equal(calendarGroup.items.length, 1);
  assert.equal(calendarGroup.lastOccurredAt, '2026-09-17T11:00:00.000Z');
});

test('groupRecentImports defaults missing folder to Other', () => {
  const items: RecentImport[] = [
    {
      id: 'evt-1',
      title: 'loose-file.md',
      occurredAt: '2026-09-17T09:00:00.000Z',
    },
  ];

  const groups = groupRecentImports(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.folder, 'Other');
  assert.equal(groups[0]?.items.length, 1);
  assert.equal(groups[0]?.items[0]?.title, 'loose-file.md');
});

test('groupRecentImports preserves externalId when provided', () => {
  const items: RecentImport[] = [
    {
      id: 'evt-1',
      title: 'Guide',
      folder: 'Docs',
      externalId: 'docs/guide.md',
      occurredAt: '2026-09-17T09:00:00.000Z',
    },
  ];

  const groups = groupRecentImports(items);
  assert.equal(groups[0]?.items[0]?.externalId, 'docs/guide.md');
});

test('groupRecentImports preserves docId when provided', () => {
  const items: RecentImport[] = [
    {
      id: 'evt-1',
      title: 'Guide',
      folder: 'Docs',
      docId: 'doc-12345',
      occurredAt: '2026-09-17T09:00:00.000Z',
    },
  ];

  const groups = groupRecentImports(items);
  assert.equal(groups[0]?.items[0]?.docId, 'doc-12345');
});

test('groupRecentImports returns empty array when given no items', () => {
  const groups = groupRecentImports([]);
  assert.deepEqual(groups, []);
});
