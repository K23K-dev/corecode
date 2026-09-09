"""Behavioral grader for personal exercises, not an adversarial grading boundary."""

import ast
import copy
import json
import reprlib


_printer = reprlib.Repr()
_printer.maxlevel = 6
_printer.maxlist = 24
_printer.maxtuple = 24
_printer.maxdict = 24
_printer.maxset = 24
_printer.maxstring = 1024
_printer.maxother = 1024


def _bounded_repr(value):
    try:
        return _printer.repr(value)[:2048]
    except BaseException:
        return '<value could not be displayed>'


def _error_text(error):
    try:
        return (type(error).__name__ + ': ' + str(error))[:2048]
    except BaseException:
        return 'Python raised an error that could not be displayed.'


def _equal(actual, expected, depth=0):
    """Compare recursively with exact types, including bool versus int."""
    if depth > 64 or type(actual) is not type(expected):
        return False
    if isinstance(expected, (list, tuple)):
        return len(actual) == len(expected) and all(
            _equal(a, b, depth + 1) for a, b in zip(actual, expected)
        )
    if isinstance(expected, dict):
        if len(actual) != len(expected):
            return False
        remaining = list(actual.items())
        for key, value in expected.items():
            for index, (other_key, other_value) in enumerate(remaining):
                if _equal(other_key, key, depth + 1) and _equal(other_value, value, depth + 1):
                    remaining.pop(index)
                    break
            else:
                return False
        return True
    if isinstance(expected, (set, frozenset)):
        if len(actual) != len(expected):
            return False
        remaining = list(actual)
        for value in expected:
            for index, other in enumerate(remaining):
                if _equal(other, value, depth + 1):
                    remaining.pop(index)
                    break
            else:
                return False
        return True
    return actual == expected


def _entry_point(namespace, name):
    solution = namespace.get('Solution')
    if isinstance(solution, type) and callable(getattr(solution, name, None)):
        # Each test gets a fresh instance; helper methods can still share its state within that test.
        def invoke(*args):
            method = getattr(solution(), name, None)
            if not callable(method):
                raise ValueError('Define a callable method named Solution.' + name + '.')
            return method(*args)
        return invoke
    function = namespace.get(name)
    if not callable(function):
        raise ValueError('Define a callable method named Solution.' + name
                         + ', or a standalone function named ' + name + '.')
    return function


def grade_request_json(request_json):
    result = {'cases': []}
    try:
        request = json.loads(request_json)
        code = request['code']
        if not isinstance(code, str) or len(code) > 32768:
            raise ValueError('Code exceeds the 32768 character limit.')
        namespace = {'__name__': '__submission__'}
        exec(compile(code, '<submission>', 'exec'), namespace)
        function = _entry_point(namespace, request['entryPoint'])
        custom = 'customArgs' in request
        cases = [{'name': 'Custom input', 'args': request['customArgs']}] if custom else request['cases']
        if not cases or len(cases) > 32:
            raise ValueError('Provide between 1 and 32 test cases.')
        for case in cases:
            row = {'name': str(case.get('name', 'Case'))[:80], 'input': str(case.get('args', ''))[:8192]}
            if not custom:
                row['expected'] = str(case.get('expected', ''))[:8192]
                row['passed'] = False
            try:
                literal = case['args']
                if not isinstance(literal, str) or len(literal) > 8192:
                    raise ValueError('Input exceeds the 8192 character limit.')
                args = ast.literal_eval(literal)
                if type(args) is not tuple:
                    raise ValueError('Inputs must be a Python literal tuple, such as ([1, 2],).')
                before = copy.deepcopy(args)
                expected = None
                if not custom:
                    expected_literal = case['expected']
                    if not isinstance(expected_literal, str) or len(expected_literal) > 8192:
                        raise ValueError('Expected output exceeds the 8192 character limit.')
                    expected = ast.literal_eval(expected_literal)
                actual = function(*args)
                row['actual'] = _bounded_repr(actual)
                if not custom:
                    row['passed'] = bool(_equal(actual, expected))
                    check = case.get('check')
                    if check == 'unchanged' and not _equal(args, before):
                        row['passed'] = False
                        row['error'] = 'The function changed its input.'
                    elif check == 'independent_rows':
                        independent = type(actual) is list and all(type(item) is list for item in actual)
                        independent = independent and len({id(item) for item in actual}) == len(actual)
                        if not independent:
                            row['passed'] = False
                            row['error'] = 'Each returned row must be a separate list.'
                    elif check not in (None, 'unchanged', 'independent_rows'):
                        raise ValueError('Unknown behavioral check.')
            except BaseException as error:
                if not custom:
                    row['passed'] = False
                row['error'] = _error_text(error)
            result['cases'].append(row)
    except BaseException as error:
        result['error'] = _error_text(error)
    return json.dumps(result)
