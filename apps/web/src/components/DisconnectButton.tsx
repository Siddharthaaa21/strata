'use client';

import { useState, useTransition } from 'react';
import { disconnectSource } from '../app/import/actions';
import styles from './ConnectorRow.module.css';

export function DisconnectButton({
  sourceId,
  sourceName,
}: {
  sourceId?: string;
  sourceName: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!sourceId) return null;

  const handleDisconnect = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!confirm(`Are you sure you want to disconnect ${sourceName}? Its imported documents will be removed.`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await disconnectSource(sourceId);
      if (!res.ok) {
        setError(res.error);
      }
    });
  };

  return (
    <div className={styles.disconnectWrap}>
      <button
        type="button"
        className={styles.disconnectButton}
        onClick={handleDisconnect}
        disabled={isPending}
        title={`Disconnect ${sourceName}`}
      >
        {isPending ? 'Disconnecting…' : 'Disconnect'}
      </button>
      {error && <span className={styles.actionError}>{error}</span>}
    </div>
  );
}
