import CodeMirror from '@uiw/react-codemirror';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { sql, SQLite } from '@codemirror/lang-sql';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { EditorView, keymap } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import { useMemo } from 'react';
import { EditorState, Prec } from '@codemirror/state';
import { MAX_CODE_BYTES, MAX_CODE_CHARACTERS } from '../schemas/progress';
import {
  acceptCompletion,
  closeCompletion,
  completionKeymap,
  autocompletion,
} from '@codemirror/autocomplete';

// The VS Code dark theme supplies the colors; this sets the 16px code font and 24px lines.
const font = EditorView.theme({
  '&': { fontSize: '16px' },
  '.cm-scroller': { fontFamily: 'var(--mantine-font-family-monospace)', lineHeight: '24px' },
  '&.cm-focused': { outline: 'none' },
});
const pythonExtensions = [
  python(),
  indentUnit.of('    '),
  EditorView.contentAttributes.of({ 'aria-label': 'Python solution editor', spellcheck: 'false' }),
];
const textExtensions = [
  EditorView.contentAttributes.of({ 'aria-label': 'Solution editor', spellcheck: 'false' }),
];
const languages = {
  JavaScript: javascript(),
  React: javascript({ jsx: true }),
  TypeScript: javascript({ jsx: true, typescript: true }),
  SQL: sql({ dialect: SQLite }),
  HTML: html(),
  CSS: css(),
};
const editingKeys = Prec.highest(
  keymap.of([
    {
      key: 'Escape',
      run: (view) => {
        const closed = closeCompletion(view);
        // This runs before CodeMirror's own Escape handling, so re-enable its Escape-then-Tab exit.
        view.setTabFocusMode(2_000);
        return closed;
      },
    },
    { key: 'Tab', run: acceptCompletion },
    // The page handles Ctrl+(Shift+)Enter: skip the editor's newline but let the event through.
    { key: 'Mod-Enter', run: () => true, shift: () => true },
    ...completionKeymap.filter((binding) => binding.key !== 'Escape'),
  ]),
);

const basicSetup = {
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  completionKeymap: false,
  allowMultipleSelections: true,
  tabSize: 4,
};

export default function CodeEditor({
  code,
  onChange,
  language,
  onLimit,
  readOnly = false,
}: {
  code: string;
  onChange?: (code: string) => void;
  language: string;
  onLimit?: () => void;
  readOnly?: boolean;
}) {
  const extensions = useMemo(
    () => [
      font,
      ...(language === 'Python'
        ? pythonExtensions
        : [
            ...textExtensions,
            ...(language in languages ? [languages[language as keyof typeof languages]] : []),
          ]),
      // Keep completion mounted while a run makes the editor read-only; its timers still use it.
      autocompletion({
        activateOnTyping: !readOnly,
        defaultKeymap: false,
        ...(readOnly ? { override: [] } : {}),
      }),
      ...(!readOnly ? [editingKeys] : []),
      EditorState.changeFilter.of((transaction) => {
        if (!transaction.docChanged || readOnly) return true;
        const next = transaction.newDoc;
        if (
          next.length <= MAX_CODE_CHARACTERS &&
          new TextEncoder().encode(next.toString()).byteLength <= MAX_CODE_BYTES
        )
          return true;
        queueMicrotask(() => onLimit?.());
        return false;
      }),
    ],
    [language, onLimit, readOnly],
  );
  return (
    // Fill the space the page gives the editor; `height` sizes the inner editor, `style` its wrapper.
    <CodeMirror
      value={code}
      onChange={onChange}
      height="100%"
      style={{ height: '100%' }}
      theme={vscodeDark}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
      indentWithTab
      basicSetup={basicSetup}
    />
  );
}
