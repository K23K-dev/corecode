'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Group, NativeSelect, Paper, Text, Title } from '@mantine/core';
import { RotateCcw } from 'lucide-react';
import type { Problem } from '../schemas/catalog';

/** A standalone page that renders the authored solution and reports its height. */
function previewDocument(problem: Problem): string {
  const preview = problem.preview!;
  const assets = JSON.stringify(preview.assets ?? {});
  const css = `html, body { margin: 0; }\n${preview.css ?? ''}\n${problem.extension === 'css' ? problem.referenceCode : ''}`;
  const body = problem.extension === 'html' ? problem.referenceCode : (preview.html ?? '');
  const solution =
    problem.extension === 'js'
      ? `${problem.referenceCode}\nconst candidate = ${problem.entryPoint};\n${preview.setup ?? 'candidate();'}`
      : '';
  const script = `
    document.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
    }, true);
    document.addEventListener('submit', (event) => event.preventDefault(), true);
    const assets = ${assets};
    const replaceImages = () => {
      for (const image of document.querySelectorAll('img[src]')) {
        const source = image.getAttribute('src');
        if (Object.hasOwn(assets, source) && source !== assets[source]) image.src = assets[source];
      }
    };
    new MutationObserver(replaceImages).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src'],
    });
    replaceImages();
    new ResizeObserver(() => {
      // The layout height, not the viewport, so short pages can shrink the frame.
      parent.postMessage({ previewHeight: document.documentElement.offsetHeight }, '*');
    }).observe(document.documentElement);
    ${solution}`;
  // Keep authored text from closing the style or script element early.
  const safe = (text: string) => text.replace(/<\//g, '<\\/');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${safe(css)}</style></head><body>${body}<script type="module">${safe(script)}</script></body></html>`;
}

/** Displays the authored target, never the learner's editor contents. */
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
            {/* Scripts run in an opaque origin: no access to this page, cookies, or storage. */}
            <iframe
              key={reset}
              ref={frame}
              title="Target preview"
              sandbox="allow-scripts"
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
