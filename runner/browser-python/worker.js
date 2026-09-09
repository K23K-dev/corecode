'use strict';

let started = false;
self.onmessage = async (event) => {
  if (started) return;
  started = true;
  const { id, payload } = event.data ?? {};
  const send = self.postMessage.bind(self);
  const now = performance.now.bind(performance);
  if (typeof id !== 'string' || id.length > 64) return;
  try {
    if (
      !payload ||
      typeof payload.code !== 'string' ||
      payload.code.length > 32_768 ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(payload.entryPoint)
    )
      throw new Error('Invalid Python run request.');
    if (!Array.isArray(payload.cases) || payload.cases.length > 32)
      throw new Error('Too many test cases.');
    if (JSON.stringify(payload).length > 196_608) throw new Error('Run input is too large.');
    importScripts('/pyodide/pyodide.js');
    const pyodide = await loadPyodide({
      indexURL: `${self.location.origin}/pyodide/`,
      packageBaseUrl: `${self.location.origin}/pyodide/`,
      jsglobals: Object.freeze(Object.create(null)),
      stdin: () => null,
      stdout: () => {},
      stderr: () => {},
    });
    const response = await fetch('/grader.py', { credentials: 'omit' });
    if (!response.ok) throw new Error('The local grader is unavailable.');
    pyodide.runPython(await response.text());
    let output = '';
    let truncated = false;
    const decoder = new TextDecoder();
    const capture = (bytes) => {
      if (output.length < 8_192) {
        const text = decoder.decode(bytes, { stream: true });
        const remaining = 8_192 - output.length;
        output += text.slice(0, remaining);
        truncated ||= text.length > remaining;
      } else {
        truncated = true;
      }
      return bytes.length;
    };
    pyodide.setStdout({ write: capture });
    pyodide.setStderr({ write: capture });
    pyodide.globals.set('_request_json', JSON.stringify(payload));
    send({ type: 'running', id });
    const begin = now();
    const result = JSON.parse(pyodide.runPython('grade_request_json(_request_json)'));
    result.stdout = output + (truncated ? '\n[Output truncated]' : '');
    result.durationMs = Math.max(0, Math.round(now() - begin));
    send({ type: 'result', id, result });
  } catch (error) {
    send({ type: 'failure', id, error: String(error?.message ?? error).slice(0, 2_048) });
  }
};
