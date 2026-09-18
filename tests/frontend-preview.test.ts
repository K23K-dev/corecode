import { describe, expect, it, vi } from 'vitest';

const previewModule = '../server/frontend-preview.mjs';
const { createPreviewDocument } = (await import(previewModule)) as {
  createPreviewDocument(problem: Record<string, unknown>): Promise<string>;
};
const repositoryModule = '../server/repository.mjs';
const { readPreviewProblem } = (await import(repositoryModule)) as {
  readPreviewProblem(pool: unknown, id: unknown, version: unknown): Promise<unknown>;
};
const appModule = '../server/app.mjs';
const { createApp } = (await import(appModule)) as {
  createApp(options: Record<string, unknown>): (request: Request) => Promise<Response>;
};

const ORIGIN = 'http://127.0.0.1:5173';
const VERSION = 'a'.repeat(64);
const PROBLEM = {
  id: 'frontend-fixture',
  version: VERSION,
  extension: 'html',
  referenceCode: '<article><h1>Example card</h1><p>Useful detail.</p></article>',
  preview: { caption: 'A complete example card.' },
};

describe('public rendered examples', () => {
  it('renders the actual HTML after its first restrictive CSP', async () => {
    const document = await createPreviewDocument(PROBLEM);
    expect(document).toContain(`<body>${PROBLEM.referenceCode}</body>`);
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<script>'));
    for (const policy of [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      'img-src data:',
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ])
      expect(document).toContain(policy);
    expect(document).toContain('html, body { margin: 0; }');
    expect(document).not.toContain('document.documentElement.scrollHeight');
    expect(document).toContain('code-practice-preview');
    expect(document).toContain(`"problemVersion":"${VERSION}"`);
    expect(document).toContain("parent.postMessage({ ...identity, status, height }, '*')");
    expect(document).toContain("event.target.closest('a')");
    expect(document).toContain("document.addEventListener('submit'");
  });

  it('combines the public CSS fixture, base styling, and real target stylesheet', async () => {
    const document = await createPreviewDocument({
      ...PROBLEM,
      extension: 'css',
      referenceCode: '.card { display: flex; gap: 16px; }',
      preview: {
        caption: 'Two spaced items.',
        html: '<div class="card"><span>One</span><span>Two</span></div>',
        css: 'span { padding: 8px; }',
      },
    });
    expect(document).toContain('<div class="card"><span>One</span><span>Two</span></div>');
    expect(document).toContain('span { padding: 8px; }\n.card { display: flex; gap: 16px; }');
  });

  it('compiles DOM JavaScript and setup without ever executing them on the host', async () => {
    const key = '__previewMustNotExecuteOnHost';
    const document = await createPreviewDocument({
      ...PROBLEM,
      extension: 'js',
      entryPoint: 'mount',
      referenceCode: `globalThis.${key} = true; function mount(root) { root.textContent = 'Mounted'; }`,
      preview: {
        caption: 'Mounted result.',
        html: '<main></main>',
        setup: "candidate(document.querySelector('main'));",
      },
    });
    expect(Reflect.get(globalThis, key)).toBeUndefined();
    expect(document).toContain('<main></main>');
    expect(document).toContain('Mounted');
    expect(document).toContain('querySelector("main")');
    expect(document).not.toContain('react.production');
  });

  it.each(['jsx', 'tsx'])(
    'bundles %s with local React and deterministic setup',
    async (extension) => {
      const document = await createPreviewDocument({
        ...PROBLEM,
        extension,
        entryPoint: 'Counter',
        referenceCode: `${extension === 'tsx' ? 'type Props = { initial: number };' : ''}
        function Counter({ initial }${extension === 'tsx' ? ': Props' : ''}) {
          const [count, setCount] = React.useState(initial);
          return <button onClick={() => setCount(count + 1)}>{count}</button>;
        }`,
        preview: { caption: 'Counter starts at three.', setup: 'render({ initial: 3 });' },
      });
      expect(document).toContain('<div id="root"></div>');
      expect(document).toContain('initial:3');
      expect(document).not.toMatch(/\bimport\s+.*from\s+["']/);
      expect(document).not.toContain('https://esm.sh');
    },
  );

  it.each(['node:fs', './local-file.js', '/etc/passwd', 'https://example.com/code.js', 'pg'])(
    'rejects reference imports of %s without resolving files or fetching URLs',
    async (source) => {
      await expect(
        createPreviewDocument({
          ...PROBLEM,
          extension: 'js',
          entryPoint: 'mount',
          referenceCode: `import value from ${JSON.stringify(source)}; function mount() { return value; }`,
        }),
      ).rejects.toMatchObject({ status: 503, code: 'preview_unavailable' });
    },
  );

  it('rejects unsafe setup imports as well as reference imports', async () => {
    await expect(
      createPreviewDocument({
        ...PROBLEM,
        extension: 'js',
        entryPoint: 'mount',
        referenceCode: 'function mount() {}',
        preview: { caption: 'Bad fixture.', setup: "await import('node:fs');" },
      }),
    ).rejects.toMatchObject({ status: 503, code: 'preview_unavailable' });
  });

  it('escapes closing tags in generated scripts/styles and embeds only data image replacements', async () => {
    const document = await createPreviewDocument({
      ...PROBLEM,
      extension: 'js',
      entryPoint: 'mount',
      referenceCode:
        'function mount() { document.body.dataset.example = "</script><script>evil</script>"; }',
      preview: {
        caption: 'Escaping fixture.',
        css: '/* </style><script>evil</script> */',
        assets: { '/cat.png': 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E' },
      },
    });
    expect(document.match(/<script>/g)).toHaveLength(4); // Two real scripts plus inert CSS and string text.
    expect(document.match(/<\/script>/g)).toHaveLength(3);
    expect(document.match(/<\/style>/g)).toHaveLength(1);
    expect(document).toContain('Object.hasOwn(assets, source)');
    expect(document).toContain('data:image/svg+xml,');
  });

  it.each([
    { referenceCode: 'x'.repeat(50 * 1024 + 1) },
    { preview: { caption: 'Too large.', html: 'x'.repeat(128 * 1024) } },
    {
      preview: { caption: 'Remote asset.', assets: { '/cat.png': 'https://example.com/cat.png' } },
    },
    { extension: 'js', entryPoint: 'mount; process.exit()', referenceCode: '' },
  ])('bounds compiler inputs: %#', async (overrides) => {
    await expect(createPreviewDocument({ ...PROBLEM, ...overrides })).rejects.toMatchObject({
      status: 503,
      code: 'preview_unavailable',
    });
  });
});

describe('read-only preview endpoint', () => {
  function request(query = `problemId=${PROBLEM.id}&problemVersion=${VERSION}`, headers = {}) {
    return new Request(`${ORIGIN}/api/preview?${query}`, {
      headers: { host: '127.0.0.1:5173', ...headers },
    });
  }

  it('looks up only the current public version and never grading data', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ version: VERSION, content: PROBLEM }] });
    const executeCode = vi.fn();
    const response = await createApp({ pool: { query }, executeCode })(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ document: await createPreviewDocument(PROBLEM) });
    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain('p.active');
    expect(sql).toContain('v.version = p.current_version');
    expect(sql).not.toContain('cp_grading_specs');
    expect(values).toEqual([PROBLEM.id]);
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('does not compile absent or stale problem versions', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ version: 'b'.repeat(64), content: PROBLEM }] });
    const app = createApp({ pool: { query } });
    const missing = await app(request());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'not_found' });
    const stale = await app(request());
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'problem_changed' });
  });

  it('requires a problem identity/version before querying and keeps normal host/origin checks', async () => {
    const query = vi.fn();
    const app = createApp({ pool: { query } });
    expect((await app(request('problemId=frontend-fixture'))).status).toBe(400);
    expect((await app(request('', { host: 'evil.example' }))).status).toBe(403);
    expect((await app(request('', { origin: 'https://evil.example' }))).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('ignores forged public content in the URL and uses the stored reference', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ version: VERSION, content: PROBLEM }] });
    const response = await createApp({ pool: { query } })(
      request(
        `problemId=${PROBLEM.id}&problemVersion=${VERSION}&referenceCode=forged&gradingSpec=private`,
      ),
    );
    const result = await response.json();
    expect(result.document).toContain(PROBLEM.referenceCode);
    expect(result.document).not.toContain('forged');
    expect(result.document).not.toContain('gradingSpec');
  });

  it('uses database identity/version even when public content is inconsistent', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ version: VERSION, content: { ...PROBLEM, id: 'wrong', version: 'wrong' } }],
    });
    expect(await readPreviewProblem({ query }, PROBLEM.id, VERSION)).toMatchObject({
      id: PROBLEM.id,
      version: VERSION,
    });
  });
});
