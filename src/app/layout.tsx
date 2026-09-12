import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import DatabaseApp from '../DatabaseApp';
import '../styles.css';
import '@fontsource/geist/latin-700.css';
import '../library-page.css';
import '../neetcode-theme.css';

export const metadata: Metadata = {
  title: 'Code Practice',
  description: 'A personal coding workbench for short, focused practice.',
  icons: { icon: '/favicon.svg' },
};

export const viewport: Viewport = { themeColor: '#171c23' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DatabaseApp>{children}</DatabaseApp>
      </body>
    </html>
  );
}
