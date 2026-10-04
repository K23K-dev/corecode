/**
 * Grades frontend exercises in the container's Chromium page, never a host browser.
 * A spec's `check` is a function expression that uses the helpers below by name.
 */
export async function gradeFrontendCase({
  check: source,
  variant,
  args,
  value,
  unchanged,
  newArray,
}) {
  const candidate = globalThis.__candidate;
  const { React, createRoot } = globalThis.__test;
  const eq = (actual, expected, message = 'Unexpected result') => {
    const normalize = (item) =>
      Array.isArray(item)
        ? item.map(normalize)
        : item && typeof item === 'object'
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, normalize(item[key])]),
            )
          : item;
    if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected)))
      throw new Error(
        `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      );
  };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const near = (actual, expected, message) =>
    check(
      Math.abs(actual - expected) <= 1.5,
      `${message}: expected ${expected}, received ${actual}`,
    );
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const rootElement = document.getElementById('root');
  let root;
  const act = React.act;
  const mount = async (props) => {
    root ??= createRoot(rootElement);
    await act(async () => root.render(React.createElement(candidate, props)));
  };
  const unmount = async () => {
    if (root) await act(async () => root.unmount());
    root = null;
  };
  const click = async (element) => {
    check(element, 'Expected a clickable control');
    await act(async () =>
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
  };
  const input = async (element, text) => {
    check(element, 'Expected an input control');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const text = () => rootElement.textContent.trim();
  const all = (selector) => [...rootElement.querySelectorAll(selector)];
  const button = (label) => all('button').find((element) => element.textContent.trim() === label);
  try {
    if (args) {
      check(typeof candidate === 'function', 'The requested function is missing');
      const before = JSON.stringify(args);
      const actual = await candidate(...args);
      eq(actual, value);
      if (unchanged) eq(JSON.stringify(args), before, 'Input was mutated');
      if (newArray) check(actual !== args[0], 'Return a new array, not the input array');
      return { actual: JSON.stringify(actual), passed: true };
    }
    if (!source) throw new Error('No behavioral check exists for this exercise.');
    const helpers = {
      candidate,
      variant,
      eq,
      check,
      near,
      deferred,
      rootElement,
      act,
      mount,
      unmount,
      click,
      input,
      text,
      all,
      button,
    };
    // Bind the spec's check to the helpers above, then run it.
    const bind = new Function(...Object.keys(helpers), `return (${source});`);
    await bind(...Object.values(helpers))();
    return { passed: true, actual: 'All behavioral checks passed.' };
  } finally {
    if (root) await act(async () => root.unmount());
  }
}

// Layout exercises describe their page in the spec; every other exercise renders into #root.
export function createFrontendFixture(spec, variant) {
  if (!spec.fixture) return { width: 900, html: '<div id="root"></div>' };
  return new Function(`return (${spec.fixture});`)()(variant);
}
