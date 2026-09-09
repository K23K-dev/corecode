import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { sql, SQLite } from '@codemirror/lang-sql';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { EditorView, keymap } from '@codemirror/view';
import {
  HighlightStyle,
  syntaxHighlighting,
  indentUnit,
  StreamLanguage,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { useMemo } from 'react';
import { EditorState, Prec } from '@codemirror/state';
import {
  acceptCompletion,
  closeCompletion,
  completionKeymap,
  autocompletion,
} from '@codemirror/autocomplete';
import { pythonCompletionExtension } from '../lib/python-completions';

// Small, fixed symbol shapes replace the completion library's text/emoji icons.
const symbolMask = (path: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`)}")`;
const completionSymbols = {
  variable: symbolMask('M4 4h16v16H4z M8 9l4-2 4 2-4 2-4-2z M8 12l4 2 4-2'),
  function: symbolMask('M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z M3 7.5l9 4.5 9-4.5 M12 12v9'),
  keyword: symbolMask('M14 3a5 5 0 1 1-3 9L4 19H1v-3l7-7a5 5 0 0 1 6-6Z M16 6h.01'),
  type: symbolMask('M5 3h5v5H5z M14 16h5v5h-5z M7.5 8v10h6.5 M10 5.5h6.5V16'),
};

const theme = EditorView.theme(
  {
    '&': {
      fontSize: 'var(--editor-font-size)',
      backgroundColor: '#252525',
      color: '#d4d4d4',
      height: '100%',
    },
    '.cm-scroller': {
      fontFamily: 'var(--code-font)',
      lineHeight: 'var(--editor-line-height)',
      overflow: 'auto',
    },
    '.cm-content': { padding: '8px 0', caretColor: '#f5f5f5' },
    '.cm-line': { padding: '0 18px 0 12px' },
    '.cm-gutters': {
      backgroundColor: '#252525',
      color: '#858585',
      border: 'none',
      padding: '0 8px 0 16px',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#f5f5f5' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: '#494949 !important',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-tooltip': { backgroundColor: '#252526', border: '1px solid #454545' },
    '.cm-tooltip-autocomplete': {
      fontFamily: 'var(--code-font)',
      fontSize: '16px',
      width: 'min(430px, calc(100vw - 24px))',
      maxWidth: 'calc(100vw - 24px)',
      borderRadius: '0',
      boxShadow: '0 2px 8px #0005',
    },
    '.cm-tooltip-autocomplete > ul': {
      fontFamily: 'inherit',
      maxHeight: '288px',
      minWidth: '0',
      maxWidth: '100%',
      padding: '0',
    },
    '.cm-tooltip-autocomplete > ul > li': {
      display: 'flex',
      alignItems: 'center',
      boxSizing: 'border-box',
      padding: '0 5px',
      minHeight: '24px',
      lineHeight: '24px',
      color: '#d4d4d4',
    },
    '.cm-tooltip-autocomplete > ul > li:hover': { backgroundColor: '#2a2d2e' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected="true"]': {
      backgroundColor: '#04395e',
      color: '#fff',
    },
    '.cm-completionLabel': {
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    '.cm-completionMatchedText': {
      color: '#4fc1ff',
      textDecoration: 'none',
      fontWeight: '600',
    },
    '.cm-completionDetail': { display: 'none' },
    '.cm-completionIcon': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 16px',
      width: '16px',
      height: '16px',
      padding: '0',
      marginRight: '6px',
      opacity: '1',
      color: '#75beff',
    },
    '.cm-completionIcon::after': {
      content: '""',
      display: 'block',
      width: '16px',
      height: '16px',
      backgroundColor: 'currentColor',
      maskImage: completionSymbols.variable,
      maskRepeat: 'no-repeat',
      maskPosition: 'center',
      maskSize: 'contain',
    },
    '.cm-completionIcon-function, .cm-completionIcon-method': { color: '#c586f4' },
    '.cm-completionIcon-function::after, .cm-completionIcon-method::after': {
      maskImage: completionSymbols.function,
    },
    '.cm-completionIcon-keyword': { color: '#dcb67a' },
    '.cm-completionIcon-keyword::after': { maskImage: completionSymbols.keyword },
    '.cm-completionIcon-class, .cm-completionIcon-type': { color: '#e8ab53' },
    '.cm-completionIcon-class::after, .cm-completionIcon-type::after': {
      maskImage: completionSymbols.type,
    },
    '.cm-tooltip.cm-completionInfo': {
      fontFamily: 'var(--code-font)',
      fontSize: '14px',
      lineHeight: '21px',
      maxWidth: 'min(400px, calc(100vw - 24px))',
      padding: '8px 10px',
      overflowWrap: 'anywhere',
    },
    // When there is no room beside the list, put the signature underneath it.
    '.cm-completionInfo.cm-completionInfo-left-narrow, .cm-completionInfo.cm-completionInfo-right-narrow':
      {
        position: 'static',
        width: '100%',
        maxWidth: '100%',
        borderWidth: '1px 0 0',
      },
    '.cm-searchMatch': { backgroundColor: '#574c2c' },
  },
  { dark: true },
);
const highlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.keyword, tags.bool, tags.null], color: '#c586c0' },
    {
      tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
      color: '#dcdcaa',
    },
    { tag: [tags.typeName, tags.className], color: '#4ec9b0' },
    { tag: tags.string, color: '#ce9178' },
    { tag: tags.number, color: '#b5cea8' },
    { tag: tags.comment, color: '#6a9955' },
    { tag: tags.operator, color: '#d4d4d4' },
  ]),
);
const pythonExtensions = [
  python(),
  indentUnit.of('    '),
  highlighting,
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
  Bash: StreamLanguage.define(shell),
};
const completionKeys = Prec.highest(
  keymap.of([
    {
      key: 'Escape',
      run: (view) => {
        const closed = closeCompletion(view);
        // The completion keymap handles Escape before the editor's usual escape
        // hatch. Keep Escape, then Tab available even when a popup was dismissed.
        view.setTabFocusMode(2_000);
        return closed;
      },
    },
    { key: 'Tab', run: acceptCompletion },
    ...completionKeymap.filter((binding) => binding.key !== 'Escape'),
  ]),
);

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
      ...(language === 'Python'
        ? pythonExtensions
        : [
            ...textExtensions,
            ...(language in languages
              ? [languages[language as keyof typeof languages], highlighting]
              : []),
          ]),
      ...(language === 'Python'
        ? [pythonCompletionExtension(readOnly), ...(!readOnly ? [completionKeys] : [])]
        : []),
      // Keep completion state mounted while a run temporarily makes the editor
      // read-only: pending completion timers still reference that state field.
      ...(language !== 'Python'
        ? [
            autocompletion({ activateOnTyping: !readOnly, ...(readOnly ? { override: [] } : {}) }),
            ...(!readOnly ? [completionKeys] : []),
          ]
        : []),
      EditorState.changeFilter.of((transaction) => {
        if (!transaction.docChanged || readOnly) return true;
        const next = transaction.newDoc;
        if (
          next.length <= 32_768 &&
          new TextEncoder().encode(next.toString()).byteLength <= 50 * 1024
        )
          return true;
        queueMicrotask(() => onLimit?.());
        return false;
      }),
    ],
    [language, onLimit, readOnly],
  );
  return (
    <CodeMirror
      value={code}
      onChange={onChange}
      height="100%"
      theme={theme}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
      indentWithTab
      basicSetup={{
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
        completionKeymap: false,
        allowMultipleSelections: true,
        tabSize: 4,
      }}
    />
  );
}
