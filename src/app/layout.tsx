import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import PracticeProvider from '../components/PracticeProvider';
import '../styles/globals.css';
import '@fontsource/geist/latin-700.css';
import '../styles/library.css';
import '../styles/workspace.css';

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
        <PracticeProvider>{children}</PracticeProvider>
      </body>
    </html>
  );
}
