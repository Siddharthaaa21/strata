import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import styles from './AppShell.module.css';

/** Shared shell for all three handoff screens: mobile top bar + sidebar rail/overlay + main column. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      <div className={styles.body}>
        <Sidebar />
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}
