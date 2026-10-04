import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from '@mantine/core';
import AppProvider from '../components/AppProvider';
import { ProblemListProvider } from '../hooks/useProblemList';
import { theme } from '../lib/theme';
import '@mantine/core/styles.css';

export const metadata: Metadata = {
  title: 'Code Practice',
  description: 'A personal coding workbench for short, focused practice.',
};

export const viewport: Viewport = { themeColor: '#242424' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript forceColorScheme="dark" />
      </head>
      <body>
        <MantineProvider theme={theme} forceColorScheme="dark">
          <AppProvider>
            <ProblemListProvider>{children}</ProblemListProvider>
          </AppProvider>
        </MantineProvider>
      </body>
    </html>
  );
}
