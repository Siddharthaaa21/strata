import type { Metadata } from 'next';
import '@strata/tokens/tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Strata',
  description: 'AI engineering workspace — a searchable knowledge base for humans and agents',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Matches design/handoff/Vault.dc.html:11-12. Loaded via <link> rather than next/font so
            the build does not depend on network access; revisit in M0 if FOUT matters. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
