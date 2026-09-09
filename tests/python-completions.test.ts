import { CompletionContext, completionStatus, startCompletion } from '@codemirror/autocomplete';
import { python } from '@codemirror/lang-python';
import { EditorState, StateEffect, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { pythonCompletionExtension, pythonCompletions } from '../src/lib/python-completions';

async function suggest(source: string, explicit = false, readOnly = false) {
  const pos = source.indexOf('|');
  const doc = source.replace('|', '');
  const state = EditorState.create({
    doc,
    extensions: [python(), EditorState.readOnly.of(readOnly)],
  });
  return pythonCompletions(new CompletionContext(state, pos < 0 ? doc.length : pos, explicit));
}

describe('local Python autocomplete', () => {
  it('suggests print while typing pri, using the existing Python builtin source', async () => {
    const result = await suggest('def answer():\n    pri');
    expect(
      result?.options.some((option) => option.label === 'print' && option.type === 'function'),
    ).toBe(true);
    expect(result?.from).toBe('def answer():\n    '.length);
  });

  it.each(['p', 'pri', 'prn'])(
    'prioritizes print for %s without replacing CodeMirror fuzzy filtering',
    async (query) => {
      const result = (await suggest(query))!;
      const print = result.options.find((option) => option.label === 'print')!;
      expect(print.type).toBe('function');
      expect(print.boost).toBe(30);
      expect(print.apply).toBeUndefined();
      expect(result.from).toBe(0);
      // No prefiltering: the renderer must still match a non-prefix like prn.
      expect(result.filter).not.toBe(false);
      expect(result.options.some((option) => option.label === 'len')).toBe(true);
    },
  );

  it('ranks common builtins above keywords and obscure exceptions for equally good matches', async () => {
    const options = (await suggest('p'))!.options;
    const boost = (label: string) => options.find((option) => option.label === label)!.boost ?? 0;

    expect(boost('print')).toBeGreaterThan(boost('pow'));
    expect(boost('pow')).toBeGreaterThan(boost('pass'));
    expect(boost('pass')).toBeGreaterThan(boost('PendingDeprecationWarning'));
    expect(boost('len')).toBeGreaterThan(boost('__loader__'));
    // Less common entries remain available when explicitly sought.
    expect(options.some((option) => option.label === 'ProcessLookupError')).toBe(true);
    expect(options.some((option) => option.label === 'property')).toBe(true);
  });

  it('prefers locals without duplicate or misleading builtin completions when names are shadowed', async () => {
    const result = (await suggest('def answer(prices, print):\n    len = prices\n    pri'))!;
    const print = result.options.filter((option) => option.label === 'print');
    const prices = result.options.find((option) => option.label === 'prices')!;
    const len = result.options.find((option) => option.label === 'len')!;
    const pow = result.options.find((option) => option.label === 'pow')!;

    expect(print).toHaveLength(1);
    expect(print[0]).toMatchObject({ type: 'variable', detail: 'local name', boost: 40 });
    expect(print[0].info).toBeUndefined();
    expect(len).toMatchObject({ type: 'variable', detail: 'local name', boost: 40 });
    expect(len.info).toBeUndefined();
    expect(prices.boost).toBeGreaterThan(pow.boost!);
    expect(new Set(result.options.map((option) => option.label)).size).toBe(result.options.length);
  });

  it('provides concise builtin signatures as optional information without changing inserted text', async () => {
    const options = (await suggest('', true))!.options;
    for (const label of ['print', 'len', 'range', 'sorted', 'enumerate', 'zip', 'sum']) {
      const option = options.find((item) => item.label === label)!;
      expect(option.info).toEqual(expect.stringContaining(`${label}(`));
      expect(option.detail).toBeUndefined();
      expect(option.apply).toBeUndefined();
    }
    expect(options.find((option) => option.label === 'print')?.info).toContain("end='\\n'");
  });

  it('has plain keywords without inserting block snippets', async () => {
    const options = (await suggest('ret'))!.options;
    for (const label of ['return', 'yield', 'else', 'await', 'def', 'for']) {
      const option = options.find((item) => item.label === label);
      expect(option?.type).toBe('keyword');
      expect(option?.apply).toBeUndefined();
    }
    expect(new Set(options.map((option) => option.label)).size).toBe(options.length);
  });

  it('offers parameters, assignments, and function names from the current scope', async () => {
    const result = await suggest('def normalize_text(text):\n    cleaned = text.strip()\n    cle');
    for (const label of ['normalize_text', 'text', 'cleaned']) {
      expect(result?.options.find((option) => option.label === label)?.detail).toBe('local name');
    }
  });

  it('does not pull private locals from a sibling function', async () => {
    const result = await suggest('def other():\n    private_name = 1\ndef answer(value):\n    pri');
    expect(result?.options.map((option) => option.label)).not.toContain('private_name');
    expect(result?.options.map((option) => option.label)).toContain('value');
  });

  it('supports explicit completion at an empty cursor without popping up on whitespace', async () => {
    expect(await suggest('def answer():\n    ')).toBeNull();
    expect(
      (await suggest('def answer():\n    ', true))?.options.map((option) => option.label),
    ).toContain('print');
  });

  it.each(['# pri', 'value = "pri', 'value = "pri|nt"', 'f"pri|nt"', '"""pri|nt"""'])(
    'does not suggest inside strings or comments: %s',
    async (source) => {
      expect(await suggest(source, true)).toBeNull();
    },
  );

  it.each([
    ["'hello'.up", 'upper', 'str method'],
    ["r'hello'.st", 'strip', 'str method'],
    ['[].ap', 'append', 'list method'],
    ['[1, 2].', 'extend', 'list method'],
    ['{}.ge', 'get', 'dict method'],
    ['{1}.ad', 'add', 'set method'],
    ['(1,).co', 'count', 'tuple method'],
  ])('offers only known literal members for %s', async (source, label, detail) => {
    const result = await suggest(source);
    expect(result?.options.find((option) => option.label === label)?.detail).toBe(detail);
    expect(result?.options.map((option) => option.label)).not.toContain('print');
    expect(result?.from).toBe(source.lastIndexOf('.') + 1);
  });

  it.each([
    'text.st',
    'unknown.',
    'custom().ap',
    "'hello'.strip().lo",
    'b"bytes".up',
    't"template".up',
  ])('does not guess dynamic types or unsupported literal kinds: %s', async (source) => {
    expect(await suggest(source, true)).toBeNull();
  });

  it('suppresses completions in read-only solutions', async () => {
    expect(await suggest('pri', true, true)).toBeNull();
  });

  it('retains completion state across execution locks while clearing pending suggestions', () => {
    const extensions = (readOnly: boolean) => [
      python(),
      EditorState.readOnly.of(readOnly),
      pythonCompletionExtension(readOnly),
    ];
    let state = EditorState.create({
      doc: 'pri',
      selection: { anchor: 3 },
      extensions: extensions(false),
    });
    // Exercise the state-machine contract without a DOM. Real queued timer and
    // keyboard behavior are covered by the browser transition regression test.
    const view = {
      get state() {
        return state;
      },
      dispatch(spec: TransactionSpec) {
        state = state.update(spec).state;
      },
    } as EditorView;
    expect(startCompletion(view)).toBe(true);
    expect(completionStatus(state)).toBe('pending');
    state = state.update({ effects: StateEffect.reconfigure.of(extensions(true)) }).state;
    expect(completionStatus(state)).toBeNull();
    // startCompletion returns false if its field was removed. Keeping it here
    // protects already-queued plugin work, but the empty sources stay inactive.
    expect(startCompletion(view)).toBe(true);
    expect(completionStatus(state)).toBeNull();
    state = state.update({ effects: StateEffect.reconfigure.of(extensions(false)) }).state;
    expect(startCompletion(view)).toBe(true);
    expect(completionStatus(state)).toBe('pending');
  });
});
