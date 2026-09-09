(() => {
  'use strict';
  const APP_ORIGIN = 'http://127.0.0.1:5173';
  const channel = location.hash.slice(1);
  if (!/^[a-f0-9-]{36}$/.test(channel) || parent === window) return;
  const EXECUTION_MS = 4_000;
  const BOOTSTRAP_MS = 90_000;
  let active = null;
  const send = (message) => parent.postMessage({ ...message, channel }, APP_ORIGIN);
  const stop = () => {
    if (!active) return;
    clearTimeout(active.timer);
    active.worker.terminate();
    active = null;
  };
  const fail = (id, error) => {
    stop();
    send({ type: 'failure', id, error: String(error).slice(0, 2_048) });
  };
  window.addEventListener('message', (event) => {
    if (event.origin !== APP_ORIGIN || event.source !== parent) return;
    const message = event.data;
    if (
      !message ||
      message.channel !== channel ||
      typeof message.id !== 'string' ||
      message.id.length > 64
    )
      return;
    if (message.type === 'cancel') {
      if (active?.id === message.id) stop();
      return;
    }
    if (message.type !== 'run') return;
    if (active) fail(active.id, 'Run replaced by a new request');
    const id = message.id;
    try {
      const worker = new Worker('/worker.js');
      active = {
        id,
        worker,
        startedAt: null,
        timer: setTimeout(
          () => fail(id, 'Python startup timed out. Try running again.'),
          BOOTSTRAP_MS,
        ),
      };
      worker.onerror = () => {
        if (active?.worker === worker)
          fail(id, 'Python worker could not start or stopped unexpectedly.');
      };
      worker.onmessageerror = () => {
        if (active?.worker === worker) fail(id, 'Python worker returned an unreadable message.');
      };
      worker.onmessage = (event) => {
        if (active?.worker !== worker || !event.data || event.data.id !== id) return;
        const reply = event.data;
        if (reply.type === 'running') {
          if (active.startedAt !== null) return;
          // The worker posts this only after runtime bootstrap, before learner code.
          active.startedAt = performance.now();
          clearTimeout(active.timer);
          active.timer = setTimeout(
            () => fail(id, 'Execution exceeded 4 seconds and was stopped.'),
            EXECUTION_MS,
          );
          send({ type: 'stage', id, stage: 'running' });
        } else if (reply.type === 'failure') {
          fail(id, typeof reply.error === 'string' ? reply.error : 'Python startup failed.');
        } else if (reply.type === 'result') {
          if (active.startedAt === null) return;
          if (
            performance.now() - active.startedAt > EXECUTION_MS ||
            reply.result?.durationMs > EXECUTION_MS
          ) {
            fail(id, 'Execution exceeded 4 seconds and was stopped.');
            return;
          }
          stop();
          send({ type: 'result', id, result: reply.result });
        }
      };
      worker.postMessage({ id, payload: message.payload });
    } catch {
      fail(id, 'Unable to create the isolated Python worker.');
    }
  });
  window.addEventListener('pagehide', stop);
  send({ type: 'ready' });
})();
