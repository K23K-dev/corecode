'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Group, NativeSelect, Paper, Text, Title } from '@mantine/core';
import { RotateCcw } from 'lucide-react';
import type { Problem } from '../schemas/catalog';

/**
 * Runs inside the preview page, which gets this function's source as text. So it can only use
 * browser globals, never anything else from this file.
 */
function previewScript(assets: Record<string, string>) {
  // Links and forms stay on the preview page.
  document.addEventListener(
    'click',
    (event) => {
      if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
    },
    true,
  );
  document.addEventListener('submit', (event) => event.preventDefault(), true);
  // Swap image file names for the problem's bundled images.
  for (const image of document.images) {
    const source = image.getAttribute('src') ?? '';
    if (Object.hasOwn(assets, source)) image.src = assets[source];
  }
  // Report the page's height, so the preview frame can fit it.
  new ResizeObserver(() => {
    parent.postMessage({ previewHeight: document.documentElement.offsetHeight }, '*');
  }).observe(document.documentElement);
}

// Authored text must not end the <style> or <script> element early.
const escapeEndTags = (text: string) => text.replaceAll('</', '<\\/');

// The preview page: the problem's target HTML and CSS, with the script above.
function previewDocument(problem: Problem) {
  const preview = problem.preview!;
  const css = `html, body { margin: 0; }\n${preview.css ?? ''}\n${problem.extension === 'css' ? problem.referenceCode : ''}`;
  const html = problem.extension === 'html' ? problem.referenceCode : (preview.html ?? '');
  // JavaScript problems run the reference solution, then the preview's setup code.
  const solution =
    problem.extension === 'js'
      ? `${problem.referenceCode}\nconst candidate = ${problem.entryPoint};\n${preview.setup ?? 'candidate();'}`
      : '';
  const script = `(${previewScript})(${JSON.stringify(preview.assets ?? {})});\n${solution}`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${escapeEndTags(css)}</style>
  </head>
  <body>${html}<script type="module">${escapeEndTags(script)}</script></body></html>`;
}

// Displays the authored target, never the learner's editor contents.
export default function FrontendPreview({ problem }: { problem: Problem }) {
  const canvas = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [availableWidth, setAvailableWidth] = useState(600);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(240);
  const [reset, setReset] = useState(0);
  const widths = problem.preview?.widths ?? [];
  const viewportWidth = width || availableWidth;
  const scale = Math.min(1, availableWidth / viewportWidth);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setAvailableWidth(Math.max(1, Math.floor(entry.contentRect.width)));
    });
    if (canvas.current) observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const reported = (event.data as { previewHeight?: unknown } | null)?.previewHeight;
      if (event.source === frame.current?.contentWindow && typeof reported === 'number')
        setHeight(Math.max(160, Math.min(1200, Math.ceil(reported))));
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  if (!problem.preview) return null;

  return (
    <section aria-label="Target preview">
      <Group justify="space-between" mb="xs">
        <Title order={2} size="h6">
          Target preview
        </Title>
        <Group gap="xs">
          {widths.length > 0 && (
            <NativeSelect
              size="xs"
              aria-label="Preview width"
              value={String(width)}
              onChange={(event) => setWidth(Number(event.currentTarget.value))}
              data={[
                { value: '0', label: 'Fit' },
                ...widths.map((value) => ({ value: String(value), label: `${value}px` })),
              ]}
            />
          )}
          {scale < 1 && (
            <Text fz="xs" c="dimmed">
              {Math.round(scale * 100)}%
            </Text>
          )}
          <Button
            size="compact-sm"
            variant="subtle"
            color="gray"
            leftSection={<RotateCcw size={14} />}
            aria-label="Reset target preview"
            onClick={() => setReset((value) => value + 1)}
          >
            Reset
          </Button>
        </Group>
      </Group>
      {/* The target is authored for a light page. */}
      <Paper withBorder bg="white" c="dark.9" p="md" style={{ overflow: 'hidden' }}>
        <div ref={canvas}>
          <div
            style={{ width: viewportWidth * scale, height: height * scale, marginInline: 'auto' }}
          >
            {/* Runs in an opaque origin: no access to this page, cookies, or storage. */}
            <iframe
              key={reset}
              ref={frame}
              title="Target preview"
              sandbox="allow-scripts allow-forms"
              srcDoc={previewDocument(problem)}
              style={{
                width: viewportWidth,
                height,
                border: 0,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
              }}
            />
          </div>
        </div>
      </Paper>
      <Text fz="sm" c="dimmed" mt="xs">
        {problem.preview.caption}
      </Text>
    </section>
  );
}
