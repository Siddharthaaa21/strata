export interface RecentImportItem {
  readonly id: string;
  readonly title: string;
  readonly docId?: string;
  readonly externalId?: string;
  readonly occurredAt: string;
}

export interface RecentImportFolderGroup {
  readonly folder: string;
  readonly lastOccurredAt: string;
  readonly items: readonly RecentImportItem[];
}

export interface RecentImport {
  readonly id: string;
  readonly title: string;
  readonly docId?: string;
  readonly folder?: string;
  readonly externalId?: string;
  readonly occurredAt: string;
}

/**
 * Groups recent import events by folder for clean, uncluttered display.
 */
export function groupRecentImports(recent: readonly RecentImport[]): RecentImportFolderGroup[] {
  const groupMap = new Map<string, { lastOccurredAt: string; items: RecentImportItem[] }>();
  for (const item of recent) {
    const folder = item.folder || 'Other';
    const existing = groupMap.get(folder);
    const itemData: RecentImportItem = {
      id: item.id,
      title: item.title,
      ...(item.docId ? { docId: item.docId } : {}),
      ...(item.externalId ? { externalId: item.externalId } : {}),
      occurredAt: item.occurredAt,
    };
    if (existing) {
      existing.items.push(itemData);
      if (new Date(item.occurredAt) > new Date(existing.lastOccurredAt)) {
        existing.lastOccurredAt = item.occurredAt;
      }
    } else {
      groupMap.set(folder, {
        lastOccurredAt: item.occurredAt,
        items: [itemData],
      });
    }
  }

  return [...groupMap.entries()].map(([folder, g]) => ({
    folder,
    lastOccurredAt: g.lastOccurredAt,
    items: g.items,
  }));
}
