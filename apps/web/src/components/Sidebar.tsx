'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import styles from './Sidebar.module.css';

/**
 * comp-sidebar — design/handoff/README.md:33, Vault.dc.html:27-82.
 *
 * 248px fixed rail on desktop; full-screen fixed overlay behind a hamburger on mobile (<860px,
 * CSS media query only). Nav items: Library / Import & Sources / Agent Access — Import & Sources
 * and Agent Access are not built yet (M3/M7); the links are present per the handoff and will 404
 * until those screens land.
 *
 * Deliberately excludes the handoff's search field, folders list, and user-profile footer — none
 * of those were requested for this build pass and none are backed by a `packages/core` type
 * (there is no `User`/profile contract). See strata-ui-builder DEVIATIONS.
 */
const NAV_ITEMS = [
  { label: 'Library', href: '/' },
  { label: 'Import & Sources', href: '/import' },
  { label: 'Agent Access', href: '/agent-access' },
] as const;

export function Sidebar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const brand = (logoTileClass: string | undefined) => (
    <div className={styles.brand}>
      <div className={`serif ${logoTileClass ?? ''}`}>S</div>
      <div className={styles.productName}>Strata</div>
    </div>
  );

  return (
    <>
      <div className={styles.topBar}>
        {brand(styles.logoTile)}
        <button type="button" className={styles.hamburger} onClick={() => setOpen(true)} aria-label="Open navigation">
          ☰
        </button>
      </div>

      <nav className={`${styles.sidebar} ${open ? styles.sidebarOpen : ''}`}>
        <div className={styles.sidebarHeader}>
          {brand(styles.logoTile)}
          <button type="button" className={styles.closeButton} onClick={() => setOpen(false)} aria-label="Close navigation">
            ✕
          </button>
        </div>

        <div className={styles.navList}>
          {NAV_ITEMS.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
              >
                <span className={`${styles.navDot} ${active ? styles.navDotActive : ''}`} />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
