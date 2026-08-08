'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import styles from './Sidebar.module.css';

/**
 * comp-sidebar — design/handoff/README.md:33, Vault.dc.html:27-82.
 *
 * 248px fixed rail on desktop; full-screen fixed overlay behind a hamburger on mobile (<860px,
 * CSS media query only). Nav items: Library / Import & Sources / Agent Access.
 *
 * **Agent Access 404s, and will until M7 increment 3.** The link is present because the handoff
 * draws it; the screen has no design at all, and inventing one under a deadline is how a
 * credential-management UI ends up wrong in ways that matter. Kept visible rather than hidden so
 * the gap is obvious to anyone using the app instead of discovered later — but a nav item that
 * dead-ends is a real rough edge, not a subtle one, and it is the first thing anyone clicking
 * around will hit. Revoking agent access meanwhile is `npm run member -- remove` and
 * `npm run agent:create`, which do work.
 *
 * The search field is BACK (Vault.dc.html:52). It was deferred in M2 on the reasonable grounds that
 * nothing backed it yet, and then never picked up when M4 built the search it was waiting for — so
 * the Library shipped without the second half of its own stated purpose ("Browse/search all
 * ingested docs", README:15) for five milestones. The deferral was recorded inside an
 * already-checked milestone bullet, which is not a place anything gets read again.
 *
 * Still deliberately excluded: the folders list and the user-profile footer. The folder pills on
 * the Library already provide folder filtering, so the sidebar list is a duplicate affordance
 * rather than a missing capability; the profile footer needs a `User` contract that does not exist
 * and whose handoff copy ("Priya Shah", "4 agents connected") is placeholder. Both are tracked as
 * real items now rather than as a note in a closed bullet.
 */
const NAV_ITEMS = [
  { label: 'Library', href: '/' },
  { label: 'Import & Sources', href: '/import' },
  { label: 'Agent Access', href: '/agent-access' },
] as const;

export function Sidebar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const query = useSearchParams()?.get('q') ?? '';

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

        {/*
          Vault.dc.html:52. Absent since M2, when it was deferred because no `packages/core` type
          backed it yet — true then, and never picked up again once M4 built the search it needed.

          A plain GET form, not a controlled input: it navigates to `/?q=…`, so the SERVER runs the
          ranked query across the whole vault. A client-side filter over the loaded page would have
          searched one clamped page of 50 and reported "no results" for documents that are in
          Strata — the same class of error as the doc count and the folder pills, and the worst of
          the three, because the user would believe the answer.

          It also works with JavaScript disabled and makes a search a real URL that can be linked
          and reloaded, which a controlled input would have to reimplement.
        */}
        <form className={styles.search} action="/" method="get" role="search">
          <span className={styles.searchIcon} aria-hidden="true">⌕</span>
          <input
            className={styles.searchInput}
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Search…"
            aria-label="Search documents"
          />
        </form>

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
