import { Console } from 'node:console';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { json } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { gradeFrontendCase, createFrontendFixture } from './frontend-grader.mjs';
import { gradeBackendCase } from './backend-grader.mjs';

const require = createRequire(import.meta.url);
const MAX_OUTPUT = 16 * 1024;
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

// Compiles and grades one frontend or backend submission in a fresh Docker sandbox.
async function gradeSubmission(request) {
  const started = performance.now();
  let stdout = '',
    browser,
    failure;
  const append = (text) => {
    if (stdout.length < MAX_OUTPUT) stdout += bounded(text, MAX_OUTPUT - stdout.length);
  };
  // Every console method prints into the result's stdout, never onto the real one with the JSON.
  const capture = new Writable({
    write(chunk, _encoding, done) {
      append(String(chunk));
      done();
    },
  });
  globalThis.console = new Console({ stdout: capture });
  const results = [];
  try {
    // The spec is trusted: the judge loads it from the database.
    const spec = request.spec;
    const backend = request.problemId.startsWith('backend-');
    const mode = request.mode;
    const tests = mode === 'example' ? spec.cases.slice(0, 1) : spec.cases;
    const compiled = await compile(request.code, spec, backend);
    // Playwright's defaults already run headless, without Chromium's own sandbox (the container
    // is the boundary), and without background networking or updates.
    if (!backend)
      browser = await chromium.launch({ executablePath: '/usr/bin/chromium', timeout: 5000 });
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
          checked = await gradeBackendCase(
            spec,
            test,
            async () => (await import(pathToFileURL(path).href)).__candidate,
          );
        } else {
          const fixture = createFrontendFixture(spec, test.variant);
          const context = await browser.newContext({
            viewport: { width: fixture.width, height: 800 },
            serviceWorkers: 'block',
          });
          await context.route('**/*', (route) => route.abort());
          const page = await context.newPage();
          page.on('console', (entry) => append(entry.text() + '\n'));
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
            checked = await page.evaluate(gradeFrontendCase, {
              ...test,
              check: spec.check,
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
  } catch (error) {
    failure = errorText(error);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return {
    cases: results,
    stdout: bounded(stdout, MAX_OUTPUT),
    durationMs: Math.round(performance.now() - started),
    ...(failure !== undefined && { error: failure }),
  };
}

// The judge sends one JSON request on stdin; the result goes to stdout.
let result;
try {
  result = await gradeSubmission(await json(process.stdin));
} catch (error) {
  result = { cases: [], stdout: '', durationMs: 0, error: errorText(error) };
}
process.stdout.write(JSON.stringify(result));
process.exit(0);
