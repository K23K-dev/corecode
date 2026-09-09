import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CodeMirror from '@uiw/react-codemirror';
import CodeEditor from '../src/components/CodeEditor';

vi.mock('@uiw/react-codemirror', () => ({ default: vi.fn(() => null) }));

describe('CodeEditor presentation', () => {
  beforeEach(() => vi.mocked(CodeMirror).mockClear());

  it.each(['Python', 'JavaScript', 'React', 'TypeScript', 'SQL', 'HTML', 'CSS', 'Bash', 'Text'])(
    'disables active-row and gutter highlights in editable and read-only %s views',
    (language) => {
      for (const readOnly of [false, true]) {
        const code = 'displayed source only';
        const onChange = vi.fn();
        renderToStaticMarkup(createElement(CodeEditor, { code, onChange, language, readOnly }));

        const props = vi.mocked(CodeMirror).mock.calls.at(-1)![0] as ComponentProps<
          typeof CodeMirror
        >;
        expect(props.basicSetup).toMatchObject({
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          allowMultipleSelections: true,
        });
        expect(props.value).toBe(code);
        expect(props.onChange).toBe(onChange);
        expect(props.editable).toBe(!readOnly);
        expect(props.readOnly).toBe(readOnly);
      }
    },
  );
});
