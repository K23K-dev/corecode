import Link from 'next/link';
import type { ReactNode } from 'react';
import { Anchor, Group } from '@mantine/core';
import { Code2 } from 'lucide-react';

// The header on every screen: the brand links home, followed by the page's own navigation.
export default function TopBar({ children }: { children?: ReactNode }) {
  return (
    <Group component="header" h={56} px="md" bg="dark.8" justify="space-between" wrap="nowrap">
      <Anchor
        component={Link}
        href="/"
        c="bright"
        fw={700}
        underline="never"
        aria-label="Code Practice library"
      >
        <Group gap={8} wrap="nowrap">
          <Code2 size={21} />
          Code Practice
        </Group>
      </Anchor>
      {children}
    </Group>
  );
}
