import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { browserCheck, browserFixture } from './browser-checks.mjs';
import { backendCheck } from './backend-checks.mjs';

const require = createRequire(import.meta.url);
const MAX_CODE = 50 * 1024,
  MAX_REQUEST = 1024 * 1024,
  MAX_OUTPUT = 16 * 1024;
const bounded = (value, limit = 4000) => String(value).slice(0, limit);
const errorText = (error) => bounded(error?.message ?? error);
const fixtureExports = {
  './db.js': ['pool', 'withDatabaseClient'],
  './auth.js': ['hashPassword', 'comparePassword', 'signToken', 'verifyToken'],
  './users.js': ['insertUser', 'findUserByEmail'],
};

async function compile(code, spec, backend) {
  const tail = backend
    ? `\nexport { ${spec.entryPoint} as __candidate };`
    : `\nimport * as __practiceReact from 'react';\nimport { createRoot as __practiceCreateRoot } from 'react-dom/client';\nglobalThis.IS_REACT_ACT_ENVIRONMENT = true;\nglobalThis.__test = { React: __practiceReact, createRoot: __practiceCreateRoot };\nglobalThis.__candidate = ${spec.entryPoint ?? 'null'};`;
  const source = spec.syntax === 'html' || spec.syntax === 'css' ? '' : code;
  const result = await build({
    stdin: {
      contents: source + tail,
      sourcefile: 'candidate.' + spec.syntax,
      loader: spec.syntax === 'tsx' ? 'tsx' : spec.syntax === 'jsx' ? 'jsx' : 'js',
      resolveDir: '/opt/runner',
    },
    bundle: true,
    write: false,
    platform: backend ? 'node' : 'browser',
    format: backend ? 'esm' : 'iife',
    target: backend ? 'node22' : 'chrome120',
    jsx: 'automatic',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'scaffold-dependencies',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (!args.importer.includes('candidate.')) return;
            if (backend && Object.hasOwn(fixtureExports, args.path))
              return { path: args.path, namespace: 'fixture' };
            if (backend && args.path === 'axios') return { path: 'axios', namespace: 'fixture' };
            if (backend && args.path === 'express')
              return { path: require.resolve('express'), external: true };
            if (
              !backend &&
              [
                'react',
                'react/jsx-runtime',
                'react/jsx-dev-runtime',
                'react-dom',
                'react-dom/client',
              ].includes(args.path)
            )
              return;
            return {
              errors: [
                {
                  text: `Import ${JSON.stringify(args.path)} is not provided in this exercise sandbox.`,
                },
              ],
            };
          });
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents:
              args.path === 'axios'
                ? 'export default globalThis.__fixtures.axios;'
                : fixtureExports[args.path]
                    .map((name) => `export const ${name} = globalThis.__fixtures.${name};`)
                    .join('\n'),
            loader: 'js',
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

/** One request per fresh outer Docker sandbox. Not an adversarial/public judge. */
export async function runRequest(request) {
  const started = performance.now();
  let stdout = '',
    browser;
  const originalConsole = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug'].map((key) => [key, console[key]]),
  );
  const append = (text) => {
    if (stdout.length < MAX_OUTPUT) stdout += bounded(text, MAX_OUTPUT - stdout.length) + '\n';
  };
  for (const key of Object.keys(originalConsole))
    console[key] = (...values) =>
      append(
        values
          .map((value) =>
            typeof value === 'string' ? value : inspect(value, { depth: 3, maxArrayLength: 30 }),
          )
          .join(' '),
      );
  const results = [];
  try {
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      request.protocolVersion !== 2
    )
      throw new Error('Runner protocol version 2 is required.');
    if (
      typeof request.problemId !== 'string' ||
      !request.problemId ||
      request.problemId.length > 200 ||
      typeof request.problemVersion !== 'string' ||
      !/^[a-f0-9]{64}$/.test(request.problemVersion)
    )
      throw new Error('A valid problem ID and version are required.');
    const spec = request.spec;
    if (
      !spec ||
      typeof spec !== 'object' ||
      Array.isArray(spec) ||
      spec.runtime !== 'javascript' ||
      !['javascript', 'jsx', 'tsx', 'html', 'css'].includes(spec.syntax) ||
      !Array.isArray(spec.cases) ||
      spec.cases.length < 1 ||
      spec.cases.length > 32 ||
      spec.cases.some(
        (test) =>
          !test ||
          typeof test !== 'object' ||
          Array.isArray(test) ||
          typeof test.name !== 'string' ||
          typeof test.input !== 'string' ||
          typeof test.expected !== 'string' ||
          !Number.isInteger(test.variant) ||
          test.variant < 0 ||
          test.variant > 31,
      )
    )
      throw new Error('A valid trusted JavaScript grading specification is required.');
    if (
      !['html', 'css'].includes(spec.syntax) &&
      (typeof spec.entryPoint !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(spec.entryPoint))
    )
      throw new Error('A valid JavaScript entry point is required.');
    if (typeof request.code !== 'string' || Buffer.byteLength(request.code, 'utf8') > MAX_CODE)
      throw new Error('Code must be text of at most 50 KiB.');
    const runtimeSpec = { ...spec, id: request.problemId };
    const backend = request.problemId.startsWith('backend-');
    const mode = request.mode ?? 'submit';
    if (!['submit', 'example', 'run'].includes(mode)) throw new Error('Unknown execution mode.');
    const tests = mode === 'example' || mode === 'run' ? spec.cases.slice(0, 1) : spec.cases;
    const compiled = await compile(request.code, runtimeSpec, backend);
    if (!backend)
      browser = await chromium.launch({
        executablePath: '/usr/bin/chromium',
        headless: true,
        chromiumSandbox: false,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-background-networking',
          '--disable-component-update',
          '--no-first-run',
        ],
        timeout: 5000,
      });
    for (let index = 0; index < tests.length; index++) {
      const test = tests[index];
      const result = {
        name: test.name,
        input: bounded(test.input),
        expected: bounded(test.expected),
      };
      try {
        let checked;
        if (backend) {
          const path = `/work/candidate-${index}.mjs`;
          await writeFile(path, compiled, { flag: 'wx', mode: 0o600 });
          checked = await backendCheck(
            runtimeSpec,
            test,
            async () => (await import(pathToFileURL(path).href)).__candidate,
          );
        } else {
          const fixture = browserFixture(runtimeSpec.id, test.variant);
          const context = await browser.newContext({
            viewport: { width: fixture.width, height: 800 },
            serviceWorkers: 'block',
          });
          await context.route('**/*', (route) => route.abort());
          const page = await context.newPage();
          page.on('console', (entry) => append(entry.text()));
          page.setDefaultTimeout(1800);
          try {
            const html =
              spec.syntax === 'html' ? `<div id="root">${request.code}</div>` : fixture.html;
            await page.setContent(
              '<!doctype html><html><head></head><body>' + html + '</body></html>',
              { waitUntil: 'domcontentloaded' },
            );
            await page.addStyleTag({
              content: 'html,body{margin:0}button{box-sizing:border-box}' + (fixture.css ?? ''),
            });
            if (spec.syntax === 'css') await page.addStyleTag({ content: request.code });
            await page.addScriptTag({ content: compiled });
            checked = await page.evaluate(browserCheck, {
              id: runtimeSpec.id,
              ...test,
              unchanged: spec.unchanged,
              newArray: spec.newArray,
            });
          } finally {
            await context.close();
          }
        }
        Object.assign(result, checked);
      } catch (error) {
        Object.assign(result, {
          passed: false,
          error: errorText(error),
        });
      }
      if (typeof result.actual === 'string') result.actual = bounded(result.actual);
      results.push(result);
    }
    return {
      cases: results,
      stdout: bounded(stdout, MAX_OUTPUT),
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      cases: results,
      stdout: bounded(stdout, MAX_OUTPUT),
      durationMs: Math.round(performance.now() - started),
      error: errorText(error),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    Object.assign(console, originalConsole);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  let bytes = 0,
    chunks = [];
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST) throw new Error('Request exceeds the 1 MiB limit.');
      chunks.push(chunk);
    }
    const request = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    const result = await runRequest(request);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ cases: [], stdout: '', durationMs: 0, error: errorText(error) }),
    );
  }
  process.exit(0);
}
