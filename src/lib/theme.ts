import type { MantineThemeOverride } from '@mantine/core';

// Mantine's dark theme with the app's accent color and code font.
export const theme: MantineThemeOverride = {
  primaryColor: 'teal',
  fontFamilyMonospace: "Consolas, 'Cascadia Code', monospace",
};

// The Mantine color for each difficulty, easiest first.
export const DIFFICULTY_COLORS: Record<string, string> = {
  Easy: 'teal',
  Medium: 'yellow',
  Hard: 'red',
};
export const DIFFICULTIES = Object.keys(DIFFICULTY_COLORS);
