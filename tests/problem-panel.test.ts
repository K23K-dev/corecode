import {
  Children,
  createElement,
  isValidElement,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ProblemPanel, { type ProblemTab } from '../src/components/ProblemPanel';
import type { Exercise } from '../src/lib/exercises';
import type { Attempt } from '../src/lib/progress';

vi.mock('../src/components/CodeEditor', () => ({
  default: ({ code, language, readOnly }: { code: string; language: string; readOnly: boolean }) =>
    createElement('pre', { 'data-language': language, 'data-read-only': readOnly }, code),
}));

const exercise: Exercise = {
  id: 'test-normalize-text',
  title: 'Normalize text',
  deckId: 'python',
  deck: 'Python',
  language: 'Python',
  extension: 'py',
  difficulty: 'Easy',
  topic: 'Strings',
  prompt: 'Return normalized text.',
  starterCode: 'starter source only',
  referenceCode: 'reference source only',
  explanation: 'Trim whitespace, then lowercase the text.',
  examples: [{ input: "' Hello '", output: "'hello'" }],
  requirements: ['Preserve interior spaces.'],
  solutionAlternatives: [
    {
      title: 'Alternative approach',
      explanation: 'Normalize each edge explicitly.',
      code: 'alternative source only',
      complexity: 'O(n) time',
    },
  ],
};

const attempts: Attempt[] = [
  {
    id: 'oldest',
    at: '2026-09-08T10:00:00.000Z',
    code: 'old draft',
    passed: 0,
    total: 2,
    status: 'error',
    durationMs: 5,
  },
  {
    id: 'middle',
    at: '2026-09-08T11:00:00.000Z',
    code: 'middle draft',
    passed: 1,
    total: 2,
    status: 'failed',
    durationMs: 5,
  },
  {
    id: 'newest',
    at: '2026-09-08T12:00:00.000Z',
    code: 'new draft',
    passed: 2,
    total: 2,
    status: 'accepted',
    durationMs: 5,
  },
];

function panelProps(tab: ProblemTab = 'question') {
  return {
    exercise,
    solved: false,
    attempts: [] as Attempt[],
    tab,
    onTabChange: vi.fn(),
    onViewAttempt: vi.fn(),
  };
}

function renderPanel(props = panelProps()) {
  return renderToStaticMarkup(createElement(ProblemPanel, props));
}

// Read only the panel's public tab controls, without mounting an editor or starting a runner.
function tabControls(props: ReturnType<typeof panelProps>) {
  const panel = ProblemPanel(props);
  const tablist = Children.toArray(panel.props.children).find(
    (child) => isValidElement<{ role?: string }>(child) && child.props.role === 'tablist',
  ) as ReactElement<{
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    children: ReactElement<{ id: string; onClick: () => void }>[];
  }>;
  return tablist.props;
}

describe('ProblemPanel', () => {
  it('shows the question, examples, requirements, and solved status without exposing reference code', () => {
    const html = renderPanel({ ...panelProps(), solved: true });

    expect(html).toContain('aria-label="Problem description"');
    expect(html).toContain('<h1>Normalize text</h1>');
    expect(html).toContain('aria-label="Solved"');
    expect(html).toContain('difficulty-easy');
    expect(html).toContain('Strings');
    expect(html).toContain('Return normalized text.');
    expect(html).toContain('Example 1:');
    expect(html).toContain('<span>Input:</span>');
    expect(html).toContain('<span>Output:</span>');
    expect(html).toContain('&#x27; Hello &#x27;');
    expect(html).toContain('&#x27;hello&#x27;');
    expect(html).toContain('Preserve interior spaces.');
    expect(html).not.toContain('reference source only');
  });

  it('omits the solved marker and redundant language topic for an unsolved question', () => {
    const html = renderPanel({
      ...panelProps(),
      exercise: { ...exercise, topic: exercise.language },
    });

    expect(html).not.toContain('aria-label="Solved"');
    expect(html).not.toContain('topic-pill');
  });

  it('replaces vague frontend examples with the authored target preview and its requirements', () => {
    const html = renderPanel({
      ...panelProps(),
      exercise: {
        ...exercise,
        runtime: 'javascript',
        language: 'CSS',
        preview: { caption: 'Resize the preview to compare the layout.', widths: [1000, 700, 450] },
        examples: [{ input: 'Rendered product markup', output: 'A rendered card.' }],
      },
    });

    expect(html).toContain('aria-label="Target preview"');
    expect(html).toContain('aria-label="Preview width"');
    expect(html).toContain('1000px');
    expect(html).toContain('450px');
    expect(html).toContain('aria-label="Reset target preview"');
    expect(html).toContain('Resize the preview to compare the layout.');
    expect(html).toContain('Preserve interior spaces.');
    expect(html).not.toContain('Rendered product markup');
    expect(html).not.toContain('Example 1:');
    expect(html).not.toContain('reference source only');
  });

  it('keeps input/output examples for JavaScript functions without a visual target', () => {
    const html = renderPanel({
      ...panelProps(),
      exercise: { ...exercise, runtime: 'javascript', language: 'JavaScript' },
    });
    expect(html).toContain('<span>Input:</span>');
    expect(html).not.toContain('aria-label="Target preview"');
  });

  it('shows authored scenario labels and concrete file states without empty requirements', () => {
    const html = renderPanel({
      ...panelProps(),
      exercise: {
        ...exercise,
        requirements: [],
        examples: [
          {
            inputLabel: 'Before',
            input: 'draft.txt contains "Hello".',
            outputLabel: 'After',
            output: 'final.txt contains "Hello". draft.txt no longer exists.',
          },
          {
            inputLabel: 'Setup',
            input: 'app.log contains <error>.',
            outputLabel: 'Terminal output',
            output: '<error>',
          },
        ],
      },
    });

    expect(html).toContain('example-code example-scenario');
    expect(html).toContain('<span>Before:</span>');
    expect(html).toContain('<span>After:</span>');
    expect(html).toContain('final.txt contains &quot;Hello&quot;. draft.txt no longer exists.');
    expect(html).toContain('<span>Setup:</span>');
    expect(html).toContain('<span>Terminal output:</span>');
    expect(html).toContain('&lt;error&gt;');
    expect(html).not.toContain('<span>Input:</span>');
    expect(html).not.toContain('<span>Output:</span>');
    expect(html).not.toContain('Requirements:');
  });

  it('shows the reference and authored alternatives as read-only code', () => {
    const html = renderPanel(panelProps('solution'));

    expect(html).toContain('<h1>Reference solution</h1>');
    expect(html).toContain('Trim whitespace, then lowercase the text.');
    expect(html).toContain('reference source only');
    expect(html).toContain('Alternative approach');
    expect(html).toContain('alternative source only');
    expect(html).toContain('O(n) time');
    expect(html.match(/data-read-only="true"/g)).toHaveLength(2);
    expect(html.match(/data-language="Python"/g)).toHaveLength(2);
    expect(html).not.toContain('starter source only');
  });

  it('does not invent alternative solutions', () => {
    const html = renderPanel({
      ...panelProps('solution'),
      exercise: { ...exercise, solutionAlternatives: undefined },
    });

    expect(html).not.toContain('solution-alternative');
    expect(html.match(/data-read-only="true"/g)).toHaveLength(1);
  });

  it('shows the existing empty-submission message', () => {
    const html = renderPanel(panelProps('history'));

    expect(html).toContain('<h1>Your submissions</h1>');
    expect(html).toContain('No submissions yet');
    expect(html).toContain('Your last 20 submissions for this exercise will appear here.');
    expect(html).not.toContain('<small>');
    expect(html).not.toContain('submission-row');
  });

  it('shows newest submissions first with status/count labels without mutating saved order', () => {
    const html = renderPanel({ ...panelProps('history'), attempts });

    expect(html.match(/<small>3<\/small>/g)).toHaveLength(1);
    expect(html.match(/class="submission-row"/g)).toHaveLength(3);
    expect(html).toContain('Accepted');
    expect(html).toContain('Not accepted');
    expect(html).toContain('Run error');
    expect(html).toContain('2/2 passed');
    expect(html.indexOf(attempts[2].at)).toBeLessThan(html.indexOf(attempts[1].at));
    expect(html.indexOf(attempts[1].at)).toBeLessThan(html.indexOf(attempts[0].at));
    expect(attempts.map((attempt) => attempt.id)).toEqual(['oldest', 'middle', 'newest']);
  });

  it.each<ProblemTab>(['question', 'solution', 'history'])(
    'links the %s tab to the shared panel',
    (tab) => {
      const html = renderPanel(panelProps(tab));

      expect(html).toContain(
        `id="tab-${tab}" aria-controls="question-content" aria-selected="true" tabindex="0"`,
      );
      expect(html).toContain(`id="question-content" role="tabpanel" aria-labelledby="tab-${tab}"`);
      expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    },
  );

  it.each([
    ['question', 'ArrowRight', 'solution', 1],
    ['solution', 'ArrowRight', 'history', 2],
    ['history', 'ArrowRight', 'question', 0],
    ['question', 'ArrowLeft', 'history', 2],
    ['solution', 'ArrowLeft', 'question', 0],
    ['history', 'ArrowLeft', 'solution', 1],
    ['history', 'Home', 'question', 0],
    ['question', 'End', 'history', 2],
  ] as const)('moves from %s with %s to %s and focuses it', (tab, key, target, index) => {
    const props = panelProps(tab);
    const controls = tabControls(props);
    const buttons = Array.from({ length: 3 }, () => ({ focus: vi.fn() }));
    const event = {
      key,
      preventDefault: vi.fn(),
      currentTarget: { querySelectorAll: vi.fn(() => buttons) },
    };

    controls.onKeyDown(event as unknown as KeyboardEvent<HTMLDivElement>);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(props.onTabChange).toHaveBeenCalledExactlyOnceWith(target);
    expect(event.currentTarget.querySelectorAll).toHaveBeenCalledWith('[role="tab"]');
    buttons.forEach((button, buttonIndex) =>
      expect(button.focus).toHaveBeenCalledTimes(buttonIndex === index ? 1 : 0),
    );
  });

  it('leaves unrelated keys untouched', () => {
    const props = panelProps();
    const event = {
      key: 'Tab',
      preventDefault: vi.fn(),
      currentTarget: { querySelectorAll: vi.fn() },
    };

    tabControls(props).onKeyDown(event as unknown as KeyboardEvent<HTMLDivElement>);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.currentTarget.querySelectorAll).not.toHaveBeenCalled();
    expect(props.onTabChange).not.toHaveBeenCalled();
  });

  it('passes tab clicks to the controlling workspace', () => {
    const props = panelProps();
    const controls = tabControls(props);

    for (const tab of ['question', 'solution', 'history']) {
      const button = controls.children.find((child) => child.props.id === `tab-${tab}`)!;
      button.props.onClick();
      expect(props.onTabChange).toHaveBeenLastCalledWith(tab);
    }
    expect(props.onTabChange).toHaveBeenCalledTimes(3);
  });
});
