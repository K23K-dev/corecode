import Link from 'next/link';
import type { ReactNode } from 'react';
import { Anchor, Box, Group } from '@mantine/core';
import { Code2 } from 'lucide-react';

/**
 * The header on every screen: the brand links home, followed by the page's own navigation.
 * `onHome` replaces the link's navigation, for pages that must stop work before leaving.
 */
export default function TopBar({
  onHome,
  children,
}: {
  onHome?: () => void;
  children?: ReactNode;
}) {
  return (
    <Box
      component="header"
      h={56}
      px="md"
      bg="dark.8"
      display="flex"
      style={{ alignItems: 'center', justifyContent: 'space-between' }}
    >
      <Anchor
        component={Link}
        href="/"
        c="bright"
        fw={700}
        underline="never"
        aria-label="Code Practice library"
        onClick={
          onHome &&
          ((event) => {
            event.preventDefault();
            onHome();
          })
        }
      >
        <Group gap={8} wrap="nowrap">
          <Code2 size={21} />
          Code Practice
        </Group>
      </Anchor>
      {children}
    </Box>
  );
}
