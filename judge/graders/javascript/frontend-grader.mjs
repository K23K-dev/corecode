/** Grades frontend exercises in the container's Chromium page, never a host browser. */
export async function gradeFrontendCase({ id, variant, args, value, unchanged, newArray }) {
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
  const fakeClock = () => {
    let time = 0,
      sequence = 0;
    const timers = new Map();
    const add = (fn, wait, repeat, params) => {
      const key = ++sequence;
      timers.set(key, {
        fn,
        wait: Math.max(Number(wait) || 0, 1),
        at: time + Math.max(Number(wait) || 0, 1),
        repeat,
        params,
      });
      return key;
    };
    window.setTimeout = (fn, wait, ...params) => add(fn, wait, false, params);
    window.setInterval = (fn, wait, ...params) => add(fn, wait, true, params);
    window.clearTimeout = window.clearInterval = (key) => timers.delete(key);
    return {
      count: () => timers.size,
      tick: async (amount) => {
        const end = time + amount;
        let count = 0;
        while (true) {
          const next = [...timers.entries()]
            .filter(([, timer]) => timer.at <= end)
            .sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          check(++count < 100, 'Too many timer callbacks');
          const [key, timer] = next;
          time = timer.at;
          if (timer.repeat) timer.at += timer.wait;
          else timers.delete(key);
          await act(async () => timer.fn(...timer.params));
        }
        time = end;
      },
    };
  };
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
    if (id === 'frontend-js-009-run-sequentially') {
      if (variant === 2) eq(await candidate([]), []);
      else {
        const first = deferred(),
          calls = [];
        const running = candidate([
          () => {
            calls.push('first');
            return first.promise;
          },
          () => {
            calls.push('second');
            return Promise.resolve('b');
          },
        ]);
        check(running && typeof running.then === 'function', 'Return a promise of task results');
        const observed = running.then(
          (result) => ({ result }),
          (error) => ({ error }),
        );
        await Promise.resolve();
        eq(calls, ['first'], 'Do not start the next task before the first finishes');
        if (variant === 1) {
          const error = new Error('task failed');
          first.reject(error);
          const result = await observed;
          check(result.error === error, 'Propagate the original task error');
          eq(calls, ['first']);
        } else {
          first.resolve('a');
          eq((await observed).result, ['a', 'b']);
          eq(calls, ['first', 'second']);
        }
      }
    } else if (id === 'frontend-browser-001-render-list') {
      rootElement.innerHTML = '<ul><li>old</li></ul>';
      const names =
        variant === 0
          ? ['Ada', 'Lin']
          : variant === 1
            ? ['<img src=x onerror=alert(1)>', 'A & B']
            : [];
      await candidate(names, rootElement.firstChild);
      eq(
        all('li').map((element) => element.textContent),
        names,
      );
      eq(rootElement.querySelectorAll('img,script').length, 0, 'Names must be rendered as text');
      eq(rootElement.firstChild.children.length, names.length);
    } else if (id === 'frontend-browser-002-bind-toggle') {
      rootElement.innerHTML =
        '<button aria-expanded="false">Toggle</button><section hidden>Panel</section>';
      const trigger = rootElement.firstChild,
        panel = rootElement.lastChild;
      if (variant === 2) {
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
      const cleanup = candidate(trigger, panel);
      check(typeof cleanup === 'function', 'Return a listener cleanup function');
      trigger.click();
      eq(panel.hidden, variant === 2);
      eq(trigger.getAttribute('aria-expanded'), String(variant !== 2));
      if (variant === 1) {
        cleanup();
        trigger.click();
        eq(panel.hidden, false, 'Cleanup must remove the original listener');
      } else if (variant === 0) {
        trigger.click();
        eq(panel.hidden, true);
        eq(trigger.getAttribute('aria-expanded'), 'false');
      }
    } else if (id === 'frontend-browser-005-debounce') {
      const clock = fakeClock(),
        calls = [],
        receiver = { marker: 'receiver' };
      const fn = candidate(function (...items) {
        calls.push({ receiver: this.marker, items });
      }, 50);
      check(typeof fn === 'function', 'Return a callable debounced function');
      if (variant === 1) {
        fn.call(receiver, 'a', 7);
        await clock.tick(49);
        eq(calls, []);
        await clock.tick(1);
        eq(calls, [{ receiver: 'receiver', items: ['a', 7] }]);
      } else {
        fn.call(receiver, 'a');
        await clock.tick(variant === 2 ? 50 : 20);
        fn.call(receiver, 'b');
        if (variant === 0) {
          await clock.tick(49);
          eq(calls, []);
          await clock.tick(1);
          eq(
            calls.map((item) => item.items),
            [['b']],
          );
        } else {
          await clock.tick(50);
          eq(
            calls.map((item) => item.items),
            [['a'], ['b']],
          );
        }
      }
    } else if (id === 'frontend-browser-007-delegated-list-actions') {
      rootElement.innerHTML =
        '<ul><li><button data-delete-id="7"><span>Delete</span></button></li><li class="plain">Keep</li></ul>';
      const list = rootElement.firstChild,
        calls = [],
        cleanup = candidate(list, (id) => calls.push(id));
      check(typeof cleanup === 'function', 'Return a listener cleanup function');
      if (variant === 1) {
        list.insertAdjacentHTML(
          'beforeend',
          '<li><button data-delete-id="9">Delete later</button></li>',
        );
        list.lastChild.firstChild.click();
        list.querySelector('.plain').click();
        eq(calls, ['9']);
      } else {
        list.querySelector('span').click();
        eq(calls, ['7']);
        if (variant === 2) {
          cleanup();
          list.querySelector('span').click();
          eq(calls, ['7']);
        }
      }
    } else if (id === 'frontend-browser-008-vanilla-accordion') {
      rootElement.innerHTML =
        '<button data-panel-id="returns"></button><button data-panel-id="shipping"></button><section></section><section></section>';
      const buttons = all('button'),
        panels = all('section'),
        selected = variant === 0 ? 'shipping' : variant === 1 ? 'returns' : 'unknown';
      candidate(buttons, panels, selected);
      eq(
        panels.map((panel) => panel.hidden),
        variant === 0 ? [true, false] : variant === 1 ? [false, true] : [true, true],
      );
      eq(
        buttons.map((button) => button.getAttribute('aria-expanded')),
        variant === 0 ? ['false', 'true'] : variant === 1 ? ['true', 'false'] : ['false', 'false'],
      );
    } else if (id === 'frontend-browser-009-validate-required-fields') {
      rootElement.innerHTML =
        '<form><input name="name" required><input name="email" required><input name="optional"></form><p>Previous error</p>';
      const form = rootElement.firstChild,
        controls = all('[required]'),
        error = rootElement.lastChild;
      controls[0].value = variant === 2 ? 'Ada' : variant === 1 ? '  ' : '';
      controls[1].value = variant === 1 ? '\t' : 'ada@example.test';
      eq(candidate(form, error), variant === 2, 'Return validation result');
      eq(
        controls.map((control) => control.getAttribute('aria-invalid')),
        variant === 2 ? ['false', 'false'] : variant === 1 ? ['true', 'true'] : ['true', 'false'],
      );
      if (variant === 2) eq(error.textContent, '');
      else {
        check(error.textContent.trim(), 'Show an error for missing fields');
        check(document.activeElement === controls[0], 'Focus the first invalid control');
      }
    } else if (id === 'frontend-browser-010-bind-dialog') {
      rootElement.innerHTML =
        '<button id="open">Open</button><dialog><p>Ordinary content</p><button data-close-dialog><span>Close</span></button></dialog>';
      const opener = rootElement.firstChild,
        dialog = rootElement.lastChild;
      candidate(opener, dialog);
      opener.click();
      check(dialog.open, 'Open the native dialog');
      if (variant === 2) {
        dialog.querySelector('p').click();
        check(dialog.open, 'Ordinary content must not close the dialog');
      } else {
        dialog.querySelector(variant === 1 ? 'span' : 'button').click();
        check(!dialog.open, 'Close the dialog');
        check(document.activeElement === opener, 'Restore focus to the opener');
      }
    } else if (id === 'frontend-react-003-counter') {
      await mount(variant === 2 ? {} : { initialCount: variant === 0 ? 2 : -2 });
      for (let index = 0; index < (variant === 1 ? 3 : 1); index++) await click(all('button')[0]);
      check(
        new RegExp(`(?:^|\\D)${variant === 0 ? 3 : 1}(?:$|\\D)`).test(text()),
        `Unexpected displayed count: ${text()}`,
      );
    } else if (id === 'frontend-react-005-toggle-todo') {
      const initialTodos = [
          { id: 1, title: 'Ship', completed: false },
          { id: 2, title: 'Test', completed: true },
        ],
        before = JSON.stringify(initialTodos);
      await mount({ initialTodos });
      await click(button(variant === 2 ? 'Test' : 'Ship'));
      if (variant === 1) await click(button('Ship'));
      eq(
        all('button').map((element) => element.getAttribute('aria-pressed')),
        variant === 0 ? ['true', 'true'] : variant === 1 ? ['false', 'true'] : ['false', 'false'],
      );
      eq(JSON.stringify(initialTodos), before, 'Do not mutate the incoming todo objects');
    } else if (id === 'frontend-react-006-filter-products') {
      await mount({
        products: [
          { id: 1, name: 'React Book' },
          { id: 2, name: 'CSS Guide' },
          { id: 3, name: 'JavaScript' },
        ],
      });
      const query = variant === 0 ? 'REACT' : variant === 1 ? 'CSS' : 'missing';
      await input(all('input')[0], query);
      eq(
        all('li').map((item) => item.textContent),
        variant === 0 ? ['React Book'] : variant === 1 ? ['CSS Guide'] : [],
      );
      eq(all('input')[0].value, query);
      if (variant === 1) {
        await input(all('input')[0], '');
        eq(all('li').length, 3);
      }
    } else if (id === 'frontend-react-007-contact-form') {
      const request = deferred(),
        calls = [];
      globalThis.fetch = (...parameters) => {
        calls.push(parameters);
        return request.promise;
      };
      await mount({ endpoint: '/contact-fixture' });
      await input(rootElement.querySelector('[name="name"]'), 'Ada');
      await input(rootElement.querySelector('[name="email"]'), 'ada@example.test');
      const event = new Event('submit', { bubbles: true, cancelable: true });
      await act(async () => rootElement.querySelector('form').dispatchEvent(event));
      check(event.defaultPrevented, 'Prevent native form navigation');
      eq(calls.length, 1, 'Submit one request');
      eq(calls[0][0], '/contact-fixture');
      eq(calls[0][1].method.toUpperCase(), 'POST');
      eq(new Headers(calls[0][1].headers).get('content-type'), 'application/json');
      eq(JSON.parse(calls[0][1].body), { name: 'Ada', email: 'ada@example.test' });
      check(all('button')[0].disabled, 'Disable the button while sending');
      await act(async () =>
        variant === 2
          ? request.reject(new Error('Offline'))
          : request.resolve({ ok: variant === 0, status: variant === 0 ? 201 : 500 }),
      );
      eq(
        rootElement.querySelector('[role="status"]')?.textContent,
        variant === 0 ? 'Sent' : 'Try again',
      );
      check(!all('button')[0].disabled, 'Re-enable the button after the request');
    } else if (id === 'frontend-react-008-interval-counter') {
      const clock = fakeClock();
      await mount({});
      eq(text(), '0');
      await clock.tick(variant === 1 ? 3000 : 1000);
      eq(text(), variant === 1 ? '3' : '1');
      if (variant === 2) {
        await act(async () => root.unmount());
        root = null;
        eq(clock.count(), 0, 'Release interval timers on unmount');
      }
    } else if (id === 'frontend-react-009-load-user') {
      const calls = [],
        loadUser = (id, signal) => {
          const pending = deferred();
          calls.push({ id, signal, ...pending });
          return pending.promise;
        };
      await mount({ userId: 7, loadUser });
      check(/Loading/.test(text()), 'Show loading state');
      eq(calls[0].id, 7);
      if (variant === 2) {
        await act(async () => calls[0].reject(new Error('User unavailable')));
        eq(rootElement.querySelector('[role="alert"]')?.textContent, 'User unavailable');
      } else if (variant === 1) {
        await mount({ userId: 8, loadUser });
        eq(calls[1].id, 8);
        await act(async () => calls[1].resolve({ name: 'Lin' }));
        await act(async () => calls[0].resolve({ name: 'Stale Ada' }));
        eq(text(), 'Lin', 'Do not apply stale results');
      } else {
        await act(async () => calls[0].resolve({ name: 'Ada' }));
        eq(text(), 'Ada');
      }
    } else if (id === 'frontend-ui-001-tabs') {
      await mount({
        tabs: [
          { id: 'home', label: 'Home', content: 'Home content' },
          { id: 'profile', label: 'Profile', content: 'Profile content' },
          { id: 'settings', label: 'Settings', content: 'Settings content' },
        ],
      });
      const tabs = all('[role="tab"]'),
        selected = variant === 1 ? 2 : 1;
      if (variant === 2) await click(tabs[1]);
      else {
        tabs[0].focus();
        await act(async () =>
          tabs[0].dispatchEvent(
            new KeyboardEvent('keydown', {
              key: variant === 0 ? 'ArrowRight' : 'ArrowLeft',
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        check(document.activeElement === tabs[selected], 'Move keyboard focus to the selected tab');
      }
      eq(
        tabs.map((tab) => tab.getAttribute('aria-selected')),
        tabs.map((_, index) => String(index === selected)),
      );
      eq(
        tabs.map((tab) => tab.tabIndex),
        tabs.map((_, index) => (index === selected ? 0 : -1)),
      );
      const panel = rootElement.querySelector('[role="tabpanel"]');
      eq(panel.textContent, selected === 2 ? 'Settings content' : 'Profile content');
      eq(panel.getAttribute('aria-labelledby'), tabs[selected].id);
    } else if (id === 'frontend-ui-003-star-rating') {
      const changes = [];
      await mount({ max: variant === 2 ? 3 : 5, onChange: (value) => changes.push(value) });
      const buttons = all('button'),
        count = () =>
          buttons.filter((button) => button.getAttribute('aria-pressed') === 'true').length;
      eq(buttons.length, variant === 2 ? 3 : 5);
      if (variant === 1) {
        await click(buttons[1]);
        eq(count(), 2);
        await act(async () =>
          buttons[3].dispatchEvent(
            new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }),
          ),
        );
        eq(count(), 4, 'Preview hovered rating');
        await act(async () =>
          buttons[3].dispatchEvent(
            new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
          ),
        );
        eq(count(), 2, 'Restore committed rating on leave');
        eq(changes, [2]);
      } else {
        await click(buttons[2]);
        eq(count(), 3);
        eq(changes, [3]);
      }
    } else if (id === 'frontend-tsx-001-typed-user-list') {
      const calls = [],
        users =
          variant === 2
            ? []
            : [
                { id: 7, name: 'Ada' },
                { id: 12, name: 'Lin' },
              ];
      await mount({ users, onSelect: (id) => calls.push(id) });
      eq(all('li').length, users.length);
      if (variant !== 2) {
        await click(button(variant === 0 ? 'Ada' : 'Lin'));
        eq(calls, [variant === 0 ? 7 : 12]);
      } else eq(all('button').length, 0);
    } else if (id === 'frontend-react-013-window-width') {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 900,
      });
      const listeners = new Set(),
        add = window.addEventListener.bind(window),
        remove = window.removeEventListener.bind(window);
      window.addEventListener = (type, fn, options) => {
        if (type === 'resize') listeners.add(fn);
        return add(type, fn, options);
      };
      window.removeEventListener = (type, fn, options) => {
        if (type === 'resize') listeners.delete(fn);
        return remove(type, fn, options);
      };
      await mount({});
      eq(text(), '900');
      if (variant === 1)
        for (const width of [700, 420]) {
          await act(async () => {
            window.innerWidth = width;
            window.dispatchEvent(new Event('resize'));
          });
          eq(text(), String(width));
        }
      if (variant === 2) {
        check(listeners.size > 0, 'Register a resize listener');
        await act(async () => root.unmount());
        root = null;
        eq(listeners.size, 0, 'Remove resize listeners on unmount');
      }
    } else if (id === 'frontend-react-014-paginated-products') {
      const calls = [],
        loadPage = (page) => {
          const pending = deferred();
          calls.push({ page, ...pending });
          return pending.promise;
        };
      await mount({ loadPage });
      check(/Loading/.test(text()), 'Show loading state');
      eq(calls[0].page, 1);
      if (variant === 2) {
        await act(async () => calls[0].reject(new Error('offline')));
        check(
          rootElement.querySelector('[role="alert"]')?.textContent.trim(),
          'Announce request failure',
        );
      } else {
        await act(async () => calls[0].resolve({ items: [{ id: 7, name: 'Pen' }], hasNext: true }));
        eq(
          all('li').map((item) => item.textContent),
          ['Pen'],
        );
        check(button('Previous')?.disabled, 'Previous is disabled on page 1');
        check(!button('Next')?.disabled, 'Enable Next when another page exists');
        if (variant === 1) {
          await click(button('Next'));
          eq(calls[1].page, 2);
          check(/Loading/.test(text()), 'Show loading again on page change');
          await act(async () => calls[1].resolve({ items: [], hasNext: false }));
          check(/No products/.test(text()), 'Show empty state');
          check(!button('Previous')?.disabled, 'Previous remains enabled on page 2');
          check(button('Next')?.disabled, 'Disable Next on final page');
        }
      }
    } else if (id === 'frontend-ui-005-image-carousel') {
      const images = [
        { src: 'first.png', alt: 'First' },
        { src: 'second.png', alt: 'Second' },
        { src: 'third.png', alt: 'Third' },
      ];
      await mount({ images: variant === 2 ? images.slice(0, 1) : images });
      if (variant === 0) await click(button('Previous'));
      else if (variant === 1) for (let index = 0; index < 3; index++) await click(button('Next'));
      else {
        await click(button('Previous'));
        await click(button('Next'));
      }
      const shown = variant === 0 ? images[2] : images[0],
        image = all('img')[0];
      eq(image?.getAttribute('src'), shown.src);
      eq(image?.alt, shown.alt);
    } else if (id === 'frontend-html-001-semantic-product-card') {
      const article = rootElement.querySelector('article');
      check(article, 'Use an article for the product');
      if (variant === 0) {
        check(
          article.querySelector('h1,h2,h3,h4,h5,h6')?.textContent.trim(),
          'Include a product heading',
        );
        const image = article.querySelector('img');
        check(
          image?.getAttribute('src') && image.alt.trim(),
          'Provide an image with meaningful alternative text',
        );
      } else {
        const link = article.querySelector('a[href]'),
          action = article.querySelector('button');
        check(
          link?.textContent.trim() && link.getAttribute('href') !== '#',
          'Provide a real product details link',
        );
        check(
          action?.textContent.trim() && action.type === 'button',
          'Use a non-submit button for the Add action',
        );
      }
    } else if (id === 'frontend-html-002-accessible-signup-form') {
      const form = rootElement.querySelector('form'),
        email = form?.querySelector('input[type="email"]'),
        password = form?.querySelector('input[type="password"]');
      check(form && email && password, 'Provide a form with email and password inputs');
      if (variant === 0) {
        for (const control of [email, password]) {
          check(
            control.required && control.name,
            'Required fields need a submitted name and required validation',
          );
          check(
            control.labels.length && [...control.labels].some((label) => label.textContent.trim()),
            'Associate visible labels with controls',
          );
          check(!control.checkValidity(), 'Empty required inputs must be invalid');
        }
      } else if (variant === 1) {
        eq(password.minLength, 8, 'Minimum password length');
        const help = (password.getAttribute('aria-describedby') ?? '')
          .split(/\s+/)
          .map((id) => document.getElementById(id));
        check(
          help.some((element) => element?.textContent.trim()),
          'Connect accessible password help text',
        );
      } else {
        const submit = [...form.querySelectorAll('button,input')].find(
          (element) => element.type === 'submit',
        );
        check(
          submit && (submit.textContent.trim() || submit.value),
          'Include a native submit control with an accessible name',
        );
      }
    } else if (id === 'frontend-css-001-flex-toolbar') {
      const toolbar = document.querySelector('.toolbar'),
        brand = toolbar.querySelector('.brand'),
        actions = toolbar.querySelector('.actions'),
        items = [...actions.children];
      const box = toolbar.getBoundingClientRect(),
        left = brand.getBoundingClientRect(),
        right = actions.getBoundingClientRect();
      near(left.left, box.left, 'Brand should be left aligned');
      near(right.right, box.right, 'Actions should be right aligned');
      near(
        left.top + left.height / 2,
        right.top + right.height / 2,
        'Vertically center both groups',
      );
      near(
        items[1].getBoundingClientRect().left - items[0].getBoundingClientRect().right,
        12,
        'Action item gap',
      );
    } else if (id === 'frontend-css-002-responsive-product-grid') {
      const grid = document.querySelector('.product-grid'),
        cards = [...grid.children].map((element) => element.getBoundingClientRect()),
        box = grid.getBoundingClientRect();
      const columns = cards.filter((card) => Math.abs(card.top - cards[0].top) < 1).length;
      eq(columns, [4, 3, 1][variant], 'Responsive column count');
      check(
        cards.every((card) => card.width >= 219.5 && card.right <= box.right + 1),
        'Cards must be at least 220 px and fit the grid',
      );
      if (columns > 1) near(cards[1].left - cards[0].right, 16, 'Column gap');
      near(cards[columns].top - cards[0].bottom, 16, 'Row gap');
    } else if (id === 'frontend-css-003-fix-card-overflow') {
      const parent = document.querySelector('.container'),
        card = parent.querySelector('.card'),
        title = card.querySelector('.card__title');
      near(
        card.getBoundingClientRect().width,
        parent.getBoundingClientRect().width,
        'Full-width card must include padding',
      );
      near(parseFloat(getComputedStyle(card).paddingLeft), 24, 'Retain card padding');
      check(
        card.scrollWidth <= card.clientWidth + 1 && title.scrollWidth <= title.clientWidth + 1,
        'Neither the card nor title may overflow',
      );
      check(
        title.getBoundingClientRect().height > 25 &&
          getComputedStyle(title).visibility !== 'hidden',
        'Wrap the full long title rather than hiding it',
      );
    } else if (id === 'frontend-css-004-responsive-page-shell') {
      const page = document.querySelector('.page'),
        sidebar = page.children[0].getBoundingClientRect(),
        main = page.children[1].getBoundingClientRect(),
        box = page.getBoundingClientRect();
      if (variant === 0) {
        near(sidebar.width, 240, 'Sidebar width');
        near(main.left - sidebar.right, 24, 'Column gap');
        near(sidebar.top, main.top, 'Desktop columns share a row');
      } else {
        near(sidebar.left, main.left, 'Stacked column alignment');
        near(main.top - sidebar.bottom, 24, 'Stacked row gap');
        near(main.width, box.width, 'Main content fills its column');
      }
      check(main.right <= box.right + 1, 'Main content must not overflow');
    } else throw new Error('No behavioral check exists for this exercise.');
    return { passed: true, actual: 'All behavioral checks passed.' };
  } finally {
    if (root) await act(async () => root.unmount());
  }
}

export function createFrontendFixture(id, variant) {
  if (id === 'frontend-css-001-flex-toolbar')
    return {
      width: variant ? 380 : 800,
      html: '<div class="toolbar"><div class="brand" style="width:100px;height:40px">Brand</div><div class="actions"><button style="width:60px;height:24px">One</button><button style="width:60px;height:24px">Two</button></div></div>',
    };
  if (id === 'frontend-css-002-responsive-product-grid')
    return {
      width: [1000, 700, 450][variant],
      html:
        '<div class="product-grid">' + '<div style="height:30px">Card</div>'.repeat(7) + '</div>',
    };
  if (id === 'frontend-css-003-fix-card-overflow')
    return {
      width: variant ? 240 : 320,
      html:
        '<div class="container"><div class="card"><h2 class="card__title">' +
        'LongUnbrokenProductName'.repeat(6) +
        '</h2></div></div>',
      css: '.card{width:100%;padding:24px}.card__title{margin:0;font:20px/24px sans-serif}',
    };
  if (id === 'frontend-css-004-responsive-page-shell')
    return {
      width: [900, 700, 390][variant],
      html: '<div class="page"><aside style="height:100px">Sidebar</aside><main style="height:160px">Main</main></div>',
    };
  return { width: 900, html: '<div id="root"></div>' };
}
