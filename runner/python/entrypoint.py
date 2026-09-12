"""Trusted behavioral harness. Run only inside the restricted practice container."""
import ast
import contextlib
import io
import json
import re
import sys
import time
import types

MAX_REQUEST_BYTES = 1024 * 1024
MAX_CODE_BYTES = 50 * 1024


def _request_spec(job):
    """Protocol v2 receives its trusted grading specification from the server."""
    if not isinstance(job, dict) or job.get('protocolVersion') != 2:
        raise ValueError('Runner protocol version 2 is required.')
    if (not isinstance(job.get('problemId'), str) or not job['problemId']
            or len(job['problemId']) > 200):
        raise ValueError('A problem ID is required.')
    if (not isinstance(job.get('problemVersion'), str)
            or not re.fullmatch(r'[a-f0-9]{64}', job['problemVersion'])):
        raise ValueError('A valid problem version is required.')
    spec = job.get('spec')
    if not isinstance(spec, dict) or spec.get('runtime') not in ('python', 'sql', 'shell'):
        raise ValueError('A trusted native grading specification is required.')
    cases = spec.get('cases')
    if not isinstance(cases, list) or not 1 <= len(cases) <= 32:
        raise ValueError('The grading specification must contain 1 to 32 cases.')
    for case in cases:
        if (not isinstance(case, dict) or not isinstance(case.get('name'), str)
                or not isinstance(case.get('expected'), str)):
            raise ValueError('The grading specification contains an invalid case.')
        if spec['runtime'] == 'python':
            if 'code' in case:
                valid = isinstance(case['code'], str)
            else:
                valid = (isinstance(case.get('args'), str)
                         and isinstance(case.get('entryPoint'), str))
            if not valid:
                raise ValueError('The Python grading case is incomplete.')
        elif spec['runtime'] == 'sql':
            if not isinstance(case.get('setup'), str) or not isinstance(case.get('rows'), list):
                raise ValueError('The SQL grading case is incomplete.')
        elif not isinstance(case.get('verify'), str):
            raise ValueError('The shell grading case is incomplete.')
    if not isinstance(job.get('code'), str) or len(job['code'].encode('utf-8')) > MAX_CODE_BYTES:
        raise ValueError('Code must be text of at most 50 KiB.')
    if job.get('mode', 'example') not in ('example', 'run', 'submit'):
        raise ValueError('Unknown execution mode.')
    return spec


class BoundedOutput(io.StringIO):
    def write(self, value):
        remaining = max(0, 8192 - self.tell())
        super().write(value[:remaining])
        return len(value)


def exact(actual, expected):
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, (list, tuple)):
        return len(actual) == len(expected) and all(exact(a, b) for a, b in zip(actual, expected))
    if isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(exact(actual[k], expected[k]) for k in expected)
    if isinstance(expected, float):
        import math
        return math.isclose(actual, expected, rel_tol=1e-7, abs_tol=1e-9)
    return actual == expected


def _scientific_helpers():
    """Fresh case-local assertions; keep heavy dependencies lazy and out of module globals."""
    import numpy as np
    import pandas as pd
    import torch

    torch.set_num_threads(1)

    def assert_array(actual, expected, *, rtol=1e-6, atol=1e-8, dtype=None):
        assert isinstance(actual, np.ndarray), "Return a NumPy array"
        expected = np.asarray(expected)
        assert actual.shape == expected.shape, "Array shape differs"
        if dtype is not None:
            assert actual.dtype == np.dtype(dtype), "Array dtype differs"
        if expected.dtype.kind in "biufc":
            np.testing.assert_allclose(actual, expected, rtol=rtol, atol=atol, equal_nan=True)
        else:
            np.testing.assert_array_equal(actual, expected)

    def assert_frame(actual, expected, *, check_dtype=False):
        assert isinstance(actual, pd.DataFrame), "Return a pandas DataFrame"
        pd.testing.assert_frame_equal(actual, expected, check_dtype=check_dtype,
                                      check_names=False, check_exact=False, rtol=1e-6, atol=1e-8)

    def assert_series(actual, expected, *, check_dtype=False):
        assert isinstance(actual, pd.Series), "Return a pandas Series"
        pd.testing.assert_series_equal(actual, expected, check_dtype=check_dtype,
                                       check_names=False, check_exact=False, rtol=1e-6, atol=1e-8)

    def assert_tensor(actual, expected, *, rtol=1e-5, atol=1e-6):
        assert isinstance(actual, torch.Tensor), "Return a PyTorch tensor"
        torch.testing.assert_close(actual, expected, rtol=rtol, atol=atol, check_dtype=False)

    def assert_raises(exception, function, *args, **kwargs):
        try:
            function(*args, **kwargs)
        except exception:
            return
        raise AssertionError("Expected " + exception.__name__)

    return {
        'np': np, 'pd': pd, 'torch': torch,
        'assert_array': assert_array, 'assert_frame': assert_frame,
        'assert_series': assert_series, 'assert_tensor': assert_tensor,
        'assert_raises': assert_raises,
    }


class SolutionView:
    """Expose Solution methods to existing trusted scenarios without replacing module helpers/classes."""
    def __init__(self, module):
        self._module = module
        self._instance = None

    def __getattr__(self, name):
        solution = self._module.__dict__.get('Solution')
        if name != 'Solution' and isinstance(solution, type) and callable(getattr(solution, name, None)):
            if self._instance is None:
                self._instance = solution()
            method = getattr(self._instance, name, None)
            if not callable(method):
                raise ValueError('Define a callable method named Solution.' + name + '.')
            return method
        try:
            return getattr(self._module, name)
        except AttributeError:
            if isinstance(solution, type):
                raise ValueError('Define a callable method named Solution.' + name
                                 + ', or a standalone function named ' + name + '.') from None
            raise


def solution_module(code):
    module = types.ModuleType('solution')
    sys.modules['solution'] = module
    exec(compile(code, 'solution.py', 'exec'), module.__dict__)
    return SolutionView(module)


def entry_point(module, name):
    function = getattr(module, name, None)
    if not callable(function):
        raise ValueError('Define a callable method named Solution.' + name
                         + ', or a standalone function named ' + name + '.')
    return function


def python_case(code, case, dependencies):
    module = solution_module(code)
    scope = {'solution': module, 'exact': exact, **dependencies}
    if dependencies:
        scope.update(_scientific_helpers())
    if 'code' in case:
        exec(compile(case['code'], 'behavior_test.py', 'exec'), scope)
        return repr(scope.get('actual', 'Behavior checks passed'))[:4000]
    args = ast.literal_eval(case['args'])
    expected = ast.literal_eval(case['expected'])
    import copy
    original = copy.deepcopy(args)
    actual = entry_point(module, case['entryPoint'])(*args)
    assert exact(actual, expected), f'Returned {actual!r}'
    if case.get('unchangedArgs'):
        assert exact(args, original), 'Input arguments were modified'
    if case.get('independentRows'):
        independent = type(actual) is list and all(type(row) is list for row in actual)
        assert independent and len({id(row) for row in actual}) == len(actual), 'Rows share the same list'
    return repr(expected)[:4000]


def sql_case(code, case):
    import sqlite3
    with contextlib.closing(sqlite3.connect(':memory:')) as connection:
        connection.executescript(case['setup'])
        connection.execute('PRAGMA query_only=ON')
        connection.set_authorizer(lambda action, *_: sqlite3.SQLITE_DENY if action in {
            sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_PRAGMA
        } else sqlite3.SQLITE_OK)
        ticks = [0]
        def limit():
            ticks[0] += 1
            return int(ticks[0] > 10000)
        connection.set_progress_handler(limit, 1000)
        cursor = connection.execute(code)
        rows = cursor.fetchmany(1001)
        assert len(rows) <= 1000, 'Query returned too many rows'
        expected = case['rows']
        assert len(rows) == len(expected), f'Returned {rows!r}'
        import math
        def equal(a, b):
            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                return math.isclose(a, b, rel_tol=1e-7, abs_tol=1e-8)
            return a == b
        assert all(len(a) == len(b) and all(equal(x,y) for x,y in zip(a,b)) for a,b in zip(rows,expected)), f'Returned {rows!r}'
        if case.get('columns'):
            assert [item[0] for item in cursor.description] == case['columns'], 'Check the output column aliases'
        return json.dumps(rows)[:4000]


def run(job):
    started = time.perf_counter()
    spec = _request_spec(job)
    code = job['code']
    dependencies = {}
    if spec.get('scientific') or job['problemId'].startswith(('numpy-', 'pandas-', 'ml-', 'dl-', 'llm-')):
        import numpy as np
        import pandas as pd
        import torch
        torch.set_num_threads(1)
        dependencies = {'np': np, 'pd': pd, 'torch': torch}
    cases = spec['cases'] if job.get('mode') == 'submit' else spec['cases'][:1]
    output = BoundedOutput()
    results = []
    for case in cases:
        result = {'name': case['name'], 'input': case.get('input', case.get('args', '')), 'expected': case['expected'], 'passed': False, 'actual': ''}
        try:
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                if spec['runtime'] == 'sql':
                    result['actual'] = sql_case(code, case)
                elif spec['runtime'] == 'shell':
                    from shell_harness import shell_case
                    result['actual'] = shell_case(code, case)
                else:
                    result['actual'] = python_case(code, case, dependencies)
            result['passed'] = True
        except BaseException as error:
            result['error'] = (type(error).__name__ + ': ' + str(error))[:4000]
            result['actual'] = str(error)[:4000] or 'Behavior check did not pass'
        results.append(result)
    return {'cases': results, 'stdout': output.getvalue(), 'durationMs': round((time.perf_counter() - started)*1000)}


if __name__ == '__main__':
    try:
        payload = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(payload) > MAX_REQUEST_BYTES:
            raise ValueError('Request exceeds the 1 MiB limit.')
        job = json.loads(payload.decode('utf-8'))
        result = run(job)
    except BaseException as error:
        result = {'cases': [], 'stdout': '', 'durationMs': 0, 'error': f'{type(error).__name__}: {error}'[:4000]}
    print(json.dumps(result, allow_nan=False))
