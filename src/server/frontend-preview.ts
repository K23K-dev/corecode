import { createRequire } from 'node:module';
import { build } from 'esbuild';
import type { Exercise } from '../shared/exercises.ts';
import { MAX_CODE_BYTES, RequestError } from './validation.ts';

type Preview = NonNullable<Exercise['preview']>;
type ScriptExtension = 'js' | 'jsx' | 'tsx';

// Keep Node's file resolver: Next rewrites direct require.resolve calls to bundle module IDs.
const resolveRuntimeFile: NodeJS.RequireResolve = Reflect.get(
  createRequire(import.meta.url),
  'resolve',
);
const MAX_PREVIEW_BYTES = 128 * 1024;
const EXTENSIONS = new Set(['html', 'css', 'js', 'jsx', 'tsx']);
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function unavailable(): RequestError {
  return new RequestError(
    'The rendered example is unavailable for this problem.',
    503,
    'preview_unavailable',
  );
}

function checkedPreview(problem: Exercise): Preview {
  const preview = problem?.preview;
  if (!preview || !EXTENSIONS.has(problem.extension)) {
    throw new RequestError(
      'This problem does not have a rendered example.',
      404,
      'preview_not_found',
    );
  }
  if (
    typeof preview !== 'object' ||
    Array.isArray(preview) ||
    typeof preview.caption !== 'string' ||
    !preview.caption.trim() ||
    (['html', 'css', 'setup'] as const).some(
      (key) => preview[key] !== undefined && typeof preview[key] !== 'string',
    ) ||
    typeof problem.referenceCode !== 'string' ||
    Buffer.byteLength(problem.referenceCode) > MAX_CODE_BYTES ||
    Buffer.byteLength(JSON.stringify(preview)) > MAX_PREVIEW_BYTES ||
    (preview.assets !== undefined &&
      (!preview.assets ||
        typeof preview.assets !== 'object' ||
        Array.isArray(preview.assets) ||
        Object.values(preview.assets).some(
          (value) =>
            typeof value !== 'string' ||
            !/^data:image\/(?:svg\+xml|png|jpeg|gif|webp)[;,]/i.test(value),
        )))
  )
    throw unavailable();
  return preview;
}

// The HTML parser recognizes closing tags even inside JavaScript strings/comments.
function scriptText(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

function styleText(value: string): string {
  return value.replace(/<\/style/gi, '\\3c /style');
}

function json(value: object): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function frameRuntime(problem: Exercise, preview: Preview): string {
  return `(() => {
    const identity = ${json({ type: 'code-practice-preview', problemId: problem.id, problemVersion: problem.version })};
    const assets = ${json(preview.assets ?? {})};
    let status;
    let queued = false;
    const report = () => {
      if (queued || !status) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const body = document.body;
        if (!body) return;
        const height = Math.ceil(Math.max(body.getBoundingClientRect().height,
          ...Array.from(body.children, (child) => child.getBoundingClientRect().bottom)));
        parent.postMessage({ ...identity, status, height }, '*');
      });
    };
    window.__cpPreviewReady = () => { if (status !== 'error') status = 'ready'; report(); };
    window.__cpPreviewError = () => { status = 'error'; report(); };
    addEventListener('error', (event) => {
      if (event instanceof ErrorEvent) window.__cpPreviewError();
    });
    addEventListener('unhandledrejection', window.__cpPreviewError);
    // Links and forms remain interactive examples without navigating this frame.
    document.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
    }, true);
    document.addEventListener('submit', (event) => event.preventDefault(), true);
    const replaceImages = () => {
      for (const image of document.querySelectorAll('img[src]')) {
        const source = image.getAttribute('src');
        if (Object.hasOwn(assets, source) && source !== assets[source]) image.setAttribute('src', assets[source]);
      }
    };
    const mutations = new MutationObserver(() => { replaceImages(); report(); });
    mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    document.addEventListener('DOMContentLoaded', () => {
      replaceImages();
      new ResizeObserver(report).observe(document.body);
      ${['html', 'css'].includes(problem.extension) ? 'window.__cpPreviewReady();' : ''}
    });
  })();`;
}

async function compileExample(problem: Exercise, preview: Preview): Promise<string> {
  if (!/^[A-Za-z_$][\w$]{0,127}$/.test(problem.entryPoint ?? '')) throw unavailable();
  const react = problem.extension === 'jsx' || problem.extension === 'tsx';
  const entry = `
    ${react ? "import React from 'react'; import { createRoot } from 'react-dom/client';" : ''}
    import { __previewCandidate as candidate } from 'preview:reference';
    ${
      react
        ? `let root;
    function render(props = {}, Component = candidate) {
      root ??= createRoot(document.getElementById('root'), {
        onUncaughtError: window.__cpPreviewError,
      });
      root.render(React.createElement(Component, props));
    }`
        : ''
    }
    (async () => { ${preview.setup ?? (react ? 'render();' : 'candidate();')} })()
      .then(() => requestAnimationFrame(window.__cpPreviewReady))
      .catch(window.__cpPreviewError);
  `;
  const allowedImports = new Set(['react', 'react-dom/client', 'react/jsx-runtime']);
  try {
    const result = await build({
      stdin: { contents: entry, sourcefile: 'preview-entry.tsx', loader: 'tsx' },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      jsx: 'automatic',
      inject: react ? ['preview:react'] : [],
      define: { 'process.env.NODE_ENV': '"production"' },
      minify: true,
      legalComments: 'none',
      logLevel: 'silent',
      tsconfigRaw: {},
      plugins: [
        {
          name: 'public-preview-only',
          setup(bundle) {
            bundle.onResolve({ filter: /.*/ }, (args) => {
              // Only compiler-owned React dependencies may use the normal file resolver.
              if (args.namespace === 'file') return;
              if (args.path === 'preview:reference' || args.path === 'preview:react') {
                return { path: args.path, namespace: 'preview' };
              }
              if (allowedImports.has(args.path)) return { path: resolveRuntimeFile(args.path) };
              return { errors: [{ text: 'Rendered examples may import only React.' }] };
            });
            bundle.onLoad({ filter: /.*/, namespace: 'preview' }, (args) => ({
              contents:
                args.path === 'preview:react'
                  ? "import * as React from 'react'; export { React };"
                  : `${problem.referenceCode}\nexport { ${problem.entryPoint} as __previewCandidate };`,
              // checkedPreview accepts these script loaders; HTML/CSS never reach compilation.
              loader: args.path === 'preview:react' ? 'js' : (problem.extension as ScriptExtension),
            }));
          },
        },
      ],
    });
    return result.outputFiles[0].text;
  } catch {
    // Build errors can include host paths or source snippets. They are not an API response.
    throw unavailable();
  }
}

/** Compile public reference content for an opaque sandboxed browser frame, never execute it here. */
export async function createPreviewDocument(problem: Exercise): Promise<string> {
  const preview = checkedPreview(problem);
  const isScript = !['html', 'css'].includes(problem.extension);
  const html =
    problem.extension === 'html'
      ? problem.referenceCode
      : (preview.html ??
        (['jsx', 'tsx'].includes(problem.extension) ? '<div id="root"></div>' : ''));
  const css = `${preview.css ?? ''}\n${problem.extension === 'css' ? problem.referenceCode : ''}`;
  const compiled = isScript ? await compileExample(problem, preview) : '';
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html, body { margin: 0; }\n${styleText(css)}</style><script>${scriptText(frameRuntime(problem, preview))}</script></head><body>${html}${compiled ? `<script>${scriptText(compiled)}</script>` : ''}</body></html>`;
}
