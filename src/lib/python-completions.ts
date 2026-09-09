import {
  autocompletion,
  completeFromList,
  ifNotIn,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { globalCompletion, localCompletionSource } from '@codemirror/lang-python';
import { syntaxTree } from '@codemirror/language';

/** Keep the plugin/state installed while locking an editor for execution. */
export function pythonCompletionExtension(readOnly: boolean) {
  // Removing autocomplete while its typing debounce is queued lets that old
  // callback access a missing state field. An empty source list instead clears
  // visible/pending suggestions without tearing down the plugin beneath it.
  return autocompletion({
    override: readOnly ? [] : [pythonCompletions],
    activateOnTyping: !readOnly,
    activateOnTypingDelay: 100,
    defaultKeymap: false,
    interactionDelay: 0,
    maxRenderedOptions: 16,
  });
}

// Reuse the Python package's maintained built-ins and scope-aware name lookup.
// Plain keywords deliberately replace its block snippets: accepting a word
// should not unexpectedly insert an entire function or loop in this practice UI.
const keywordSource = ifNotIn(
  ['String', 'FormatString', 'Comment', 'PropertyName'],
  completeFromList(
    [
      'and',
      'as',
      'assert',
      'async',
      'await',
      'break',
      'case',
      'class',
      'continue',
      'def',
      'del',
      'elif',
      'else',
      'except',
      'finally',
      'for',
      'from',
      'global',
      'if',
      'import',
      'in',
      'is',
      'lambda',
      'match',
      'nonlocal',
      'not',
      'or',
      'pass',
      'raise',
      'return',
      'try',
      'type',
      'while',
      'with',
      'yield',
    ].map((label) => ({ label, type: 'keyword', detail: 'keyword' })),
  ),
);

// Adjust equally good matches, leaving CodeMirror's fuzzy scoring in charge.
// This is a small preference layer over the maintained Python completion list,
// not a second catalog of built-ins or an attempt to infer Python types.
const commonBuiltins = new Set(
  'abs all any bool dict enumerate float input int isinstance len list max min pow range reversed round set sorted str sum tuple zip'.split(
    ' ',
  ),
);
const builtinSignatures: Readonly<Record<string, string>> = {
  print: "print(*objects, sep=' ', end='\\n', file=None, flush=False)",
  len: 'len(obj, /)',
  range: 'range(stop) or range(start, stop, step=1)',
  sorted: 'sorted(iterable, /, *, key=None, reverse=False)',
  enumerate: 'enumerate(iterable, start=0)',
  zip: 'zip(*iterables, strict=False)',
  sum: 'sum(iterable, /, start=0)',
};

function rankBuiltin(option: Completion): Completion {
  const boost =
    option.label === 'print'
      ? 30
      : commonBuiltins.has(option.label)
        ? 20
        : option.type === 'type' || option.label.startsWith('__')
          ? -20
          : 0;
  const info = Object.hasOwn(builtinSignatures, option.label)
    ? builtinSignatures[option.label]
    : option.info;
  return { ...option, boost, ...(info ? { info } : {}) };
}

const methods = (type: string, labels: string): readonly Completion[] =>
  labels.split(' ').map((label) => ({
    label,
    type: 'method',
    detail: `${type} method`,
  }));

// These are a small convenience list, not an attempt at dynamic Python type
// inference. Only the syntactic literal immediately before the dot is used.
const literalMethods: Record<string, readonly Completion[]> = {
  String: methods(
    'str',
    'strip lstrip rstrip lower upper split join replace startswith endswith isalnum isdigit isspace find count',
  ),
  FormatString: methods(
    'str',
    'strip lstrip rstrip lower upper split join replace startswith endswith isalnum isdigit isspace find count',
  ),
  ArrayExpression: methods(
    'list',
    'append extend insert pop remove index count sort reverse copy clear',
  ),
  DictionaryExpression: methods(
    'dict',
    'get keys values items setdefault update pop popitem copy clear',
  ),
  SetExpression: methods(
    'set',
    'add discard remove union intersection difference update copy clear',
  ),
  TupleExpression: methods('tuple', 'count index'),
};

function memberAt(context: CompletionContext) {
  for (
    let node = syntaxTree(context.state).resolveInner(context.pos, -1);
    node;
    node = node.parent!
  ) {
    if (node.name !== 'MemberExpression') continue;
    const dot = node.getChild('.');
    const receiver = node.firstChild;
    if (!dot || !receiver || context.pos < dot.to || context.pos > node.to) continue;
    const property = dot.nextSibling;
    const from = property?.name === 'PropertyName' ? property.from : context.pos;
    if (context.pos < from) continue;
    return {
      from,
      kind: receiver.name,
      receiver: context.state.sliceDoc(receiver.from, receiver.to),
      preceding: context.state.sliceDoc(Math.max(0, receiver.from - 1), receiver.from),
    };
  }
  return null;
}

/** Local-only suggestions. This reads syntax; it never imports or runs Python. */
export async function pythonCompletions(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  if (context.state.readOnly) return null;
  const member = memberAt(context);
  if (member) {
    // Python bytes and template literals are not strings. Do not give them
    // str methods merely because this parser represents them as a String node.
    if (
      (member.kind === 'String' || member.kind === 'FormatString') &&
      (!/^(?:r|u|f|fr|rf)?['"]/i.test(member.receiver) || /[\w\xa1-\uffff]/.test(member.preceding))
    )
      return null;
    const options = Object.hasOwn(literalMethods, member.kind)
      ? literalMethods[member.kind]
      : undefined;
    return options ? { from: member.from, options, validFor: /^\w*$/ } : null;
  }

  const local = localCompletionSource(context);
  const keywords = await keywordSource(context);
  const globals = await globalCompletion(context);
  const results = [local, keywords, globals].filter((result): result is CompletionResult =>
    Boolean(result),
  );
  if (!results.length) return null;
  const from = (keywords ?? globals ?? local)!.from;
  const seen = new Set<string>();
  const options: Completion[] = [];
  for (const result of results) {
    if (result.from !== from) continue;
    for (const option of result.options) {
      if (seen.has(option.label) || (result === globals && option.type === 'keyword')) continue;
      seen.add(option.label);
      options.push(
        result === local
          ? { ...option, boost: 40, detail: 'local name' }
          : result === globals
            ? rankBuiltin(option)
            : option,
      );
    }
  }
  return { from, options, validFor: /^[\w\xa1-\uffff]*$/ };
}
