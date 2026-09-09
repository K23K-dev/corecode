"""Trusted regression checks. Execute only in the restricted practice container."""
import json
import textwrap
import unittest
from unittest.mock import patch

import browser_grader
import entrypoint


def code(value):
    return textwrap.dedent(value).strip() + '\n'


def case(args='(3,)', expected='6', **checks):
    return {'name': 'Behavior', 'args': args, 'expected': expected, 'entryPoint': 'answer', **checks}


def native_job(spec, source, mode='submit', **options):
    return {
        'protocolVersion': 2, 'problemId': 'solution-method-regression',
        'problemVersion': 'a' * 64, 'spec': spec, 'code': code(source), 'mode': mode, **options,
    }


class BrowserMethods(unittest.TestCase):
    def run_code(self, source, cases=None, **options):
        return json.loads(browser_grader.grade_request_json(json.dumps({
            'code': code(source), 'entryPoint': 'answer', 'cases': cases or [case()], **options,
        })))

    def assert_passed(self, result):
        self.assertNotIn('error', result, result)
        self.assertTrue(result['cases'], result)
        self.assertTrue(all(row.get('passed') for row in result['cases']), result)

    def test_legacy_standalone_function(self):
        self.assert_passed(self.run_code('def answer(value): return value * 2'))

    def test_solution_method_helpers_and_recursion(self):
        self.assert_passed(self.run_code('''
            def double(value): return value * 2
            class Solution:
                def answer(self, value):
                    return self.answer(value - 1) + double(1) if value else 0
        '''))

    def test_solution_method_wins_over_standalone(self):
        self.assert_passed(self.run_code('''
            def answer(value): return -1
            class Solution:
                def answer(self, value): return value * 2
        '''))

    def test_unrelated_solution_does_not_break_legacy_function(self):
        self.assert_passed(self.run_code('''
            def answer(value): return value * 2
            class Solution:
                def __init__(self, required): raise RuntimeError('must not instantiate')
                def other(self): return None
        '''))

    def test_fresh_instance_for_each_case(self):
        self.assert_passed(self.run_code('''
            class Solution:
                def __init__(self): self.calls = 0
                def answer(self):
                    self.calls += 1
                    return self.calls
        ''', [case('()', '1'), case('()', '1')]))

    def test_custom_input_stays_ungraded(self):
        result = self.run_code('class Solution:\n    def answer(self, value): return value * 2', customArgs='(3,)')
        self.assertEqual(result['cases'][0]['actual'], '6')
        self.assertNotIn('passed', result['cases'][0])
        self.assertNotIn('expected', result['cases'][0])

    def test_custom_input_rejects_expressions(self):
        result = self.run_code('class Solution:\n    def answer(self, value): return value', customArgs='(1 + 2,)')
        self.assertIn('ValueError', result['cases'][0]['error'])

    def test_missing_method_names_both_supported_forms(self):
        for source in ['class Solution: pass', 'answer = 1']:
            result = self.run_code(source)
            self.assertIn('Solution.answer', result['error'])
            self.assertIn('standalone function named answer', result['error'])

    def test_constructor_and_method_errors_remain_feedback(self):
        for source, message in [
            ('class Solution:\n    def __init__(self): raise ValueError("init failed")\n    def answer(self, value): return 6', 'init failed'),
            ('class Solution:\n    def answer(self, value): raise SystemExit("stopped")', 'SystemExit: stopped'),
        ]:
            result = self.run_code(source)
            self.assertIn(message, result['cases'][0]['error'])
            self.assertFalse(result['cases'][0]['passed'])

    def test_behavioral_checks_are_unchanged(self):
        result = self.run_code('class Solution:\n    def answer(self, values):\n        values.reverse()\n        return values',
                               [case('([1, 2],)', '[2, 1]', check='unchanged')])
        self.assertIn('changed its input', result['cases'][0]['error'])
        result = self.run_code('class Solution:\n    def answer(self): return [[0]] * 2',
                               [case('()', '[[0], [0]]', check='independent_rows')])
        self.assertIn('separate list', result['cases'][0]['error'])
        result = self.run_code('class Solution:\n    def answer(self): return True', [case('()', '1')])
        self.assertFalse(result['cases'][0]['passed'])

    def test_request_namespaces_remain_separate(self):
        self.assert_passed(self.run_code('marker = 9\nclass Solution:\n    def answer(self, value): return value * 2'))
        self.assert_passed(self.run_code('class Solution:\n    def answer(self): return "marker" in globals()', [case('()', 'False')]))


class NativeMethods(unittest.TestCase):
    def run_code(self, source, cases=None, mode='submit', **options):
        spec = {'runtime': 'python', 'entryPoint': 'answer', 'cases': cases or [case()]}
        return entrypoint.run(native_job(spec, source, mode, **options))

    def assert_passed(self, result):
        self.assertTrue(result['cases'], result)
        self.assertTrue(all(row.get('passed') for row in result['cases']), result)

    def test_legacy_standalone_and_solution_methods(self):
        for source in ['def answer(value): return value * 2',
                       'class Solution:\n    def answer(self, value): return value * 2']:
            self.assert_passed(self.run_code(source))

    def test_solution_method_wins_over_standalone(self):
        self.assert_passed(self.run_code('''
            def answer(value): return -1
            class Solution:
                def answer(self, value): return value * 2
        '''))

    def test_helpers_and_self_recursion(self):
        self.assert_passed(self.run_code('''
            def double(value): return value * 2
            class Solution:
                def answer(self, value):
                    return self.answer(value - 1) + double(1) if value else 0
        '''))

    def test_scenarios_use_methods_and_share_one_instance_within_a_case(self):
        scenario = {'name': 'Stateful method calls', 'expected': '1 then 2',
                    'code': 'assert solution.answer() == 1\nassert solution.answer() == 2'}
        self.assert_passed(self.run_code('''
            class Solution:
                def __init__(self): self.calls = 0
                def answer(self):
                    self.calls += 1
                    return self.calls
        ''', [scenario, scenario]))

    def test_existing_structures_and_helpers_remain_module_members(self):
        scenario = {'name': 'Unwrapped classes', 'expected': 'Node, list and helper preserved', 'code': '''
node = solution.Node(7)
assert solution.Container(node).value() == 7
assert solution.helper(4) == 8
assert solution.answer(3) == 6
'''}
        self.assert_passed(self.run_code('''
            class Node:
                def __init__(self, value): self.value = value
            class Container:
                def __init__(self, node): self.node = node
                def value(self): return self.node.value
            def helper(value): return value * 2
            class Solution:
                def answer(self, value): return helper(value)
        ''', [scenario]))

    def test_existing_class_scenarios_need_no_solution(self):
        scenario = {'name': 'Legacy structure', 'expected': '7', 'code': 'assert solution.Node(7).value == 7'}
        self.assert_passed(self.run_code('class Node:\n    def __init__(self, value): self.value = value', [scenario]))

    def test_unrelated_solution_is_not_instantiated(self):
        self.assert_passed(self.run_code('''
            def answer(value): return value * 2
            class Solution:
                def __init__(self, required): raise RuntimeError('must not instantiate')
                def other(self): return None
        '''))

    def test_fresh_solution_and_module_per_case(self):
        self.assert_passed(self.run_code('''
            calls = 0
            class Solution:
                def __init__(self): self.calls = 0
                def answer(self):
                    global calls
                    calls += 1
                    self.calls += 1
                    return calls, self.calls
        ''', [case('()', '(1, 1)'), case('()', '(1, 1)')]))

    def test_example_and_custom_modes(self):
        source = 'class Solution:\n    def answer(self, value): return value * 2'
        result = self.run_code(source, [case(), case('(4,)', '8')], mode='example')
        self.assertEqual(len(result['cases']), 1)
        self.assert_passed(result)
        result = self.run_code(source, mode='custom', customArgs='(3,)')
        self.assertEqual(result['cases'][0]['actual'], '6')
        self.assertIsNone(result['cases'][0]['passed'])
        self.assertEqual(result['cases'][0]['expected'], '')
        with self.assertRaisesRegex(ValueError, 'tuple'):
            self.run_code(source, mode='custom', customArgs='3')

    def test_missing_method_errors_for_literals_scenarios_and_custom(self):
        source = 'class Solution: pass'
        for cases in [[case()], [{'name': 'Missing function', 'expected': '6', 'code': 'solution.answer(3)'}]]:
            result = self.run_code(source, cases)
            self.assertIn('Solution.answer', result['cases'][0]['error'])
        with self.assertRaisesRegex(ValueError, 'Solution.answer'):
            self.run_code(source, mode='custom', customArgs='(3,)')

    def test_constructor_and_method_errors_remain_feedback(self):
        for source, message in [
            ('class Solution:\n    def __init__(self): raise ValueError("init failed")\n    def answer(self, value): return 6', 'init failed'),
            ('class Solution:\n    def answer(self, value): raise SystemExit("stopped")', 'SystemExit: stopped'),
        ]:
            result = self.run_code(source)
            self.assertIn(message, result['cases'][0]['error'])
            self.assertFalse(result['cases'][0]['passed'])

    def test_behavioral_checks_and_stdout_remain_intact(self):
        result = self.run_code('class Solution:\n    def answer(self, values):\n        print("running")\n        values.reverse()\n        return values',
                               [case('([1, 2],)', '[2, 1]', unchangedArgs=True)])
        self.assertIn('modified', result['cases'][0]['error'])
        self.assertEqual(result['stdout'], 'running\n')
        result = self.run_code('class Solution:\n    def answer(self): return [[0]] * 2',
                               [case('()', '[[0], [0]]', independentRows=True)])
        self.assertIn('same list', result['cases'][0]['error'])


class ScientificHelpers(unittest.TestCase):
    def run_scenarios(self, scenarios, source='def answer(value): return value'):
        spec = {
            'runtime': 'python',
            'scientific': True,
            'cases': [
                {'name': name, 'expected': 'Scientific assertion contract', 'code': code(scenario)}
                for name, scenario in scenarios
            ],
        }
        result = entrypoint.run(native_job(spec, source))
        self.assertEqual(len(result['cases']), len(scenarios), result)
        return result['cases']

    def test_helpers_defaults_and_thread_limit_are_fresh_for_every_case(self):
        scenario = '''
            assert torch.get_num_threads() == 1
            defaults = [
                (assert_array, {'rtol': 1e-6, 'atol': 1e-8, 'dtype': None}),
                (assert_frame, {'check_dtype': False}),
                (assert_series, {'check_dtype': False}),
                (assert_tensor, {'rtol': 1e-5, 'atol': 1e-6}),
                (assert_raises, None),
            ]
            for helper, expected in defaults:
                assert not hasattr(helper, '_regression_marker')
                assert helper.__kwdefaults__ == expected
                helper._regression_marker = True
                if helper.__kwdefaults__ is not None:
                    helper.__kwdefaults__.clear()
        '''
        source = '''
            import torch
            torch.set_num_threads(2)
            assert torch.get_num_threads() == 2
        '''
        for result in self.run_scenarios([('First case', scenario), ('Fresh case', scenario)], source):
            with self.subTest(case=result['name']):
                self.assertTrue(result['passed'], result)

    def test_helpers_accept_supported_types_tolerances_and_defaults(self):
        scenarios = [
            ('NumPy arrays', '''
                assert_array(solution.answer(np.array([1.0000005, np.nan])), [1., np.nan])
                assert_array(np.array([1e-9]), [0.])
                assert_array(np.array([1], dtype=np.int32), [1.], dtype='int32')
                assert_array(np.array(['a', 'b']), ['a', 'b'])
                assert_array(np.empty((0, 2)), np.empty((0, 2)))
                assert_array(np.array([1.1]), [1.], rtol=.2, atol=0)
            '''),
            ('pandas frames', '''
                actual = pd.DataFrame({'value': [1.0000005, np.nan]})
                expected = pd.DataFrame({'value': [1., np.nan]})
                actual.index.name, expected.index.name = 'actual', 'expected'
                actual.columns.name, expected.columns.name = 'actual', 'expected'
                assert_frame(solution.answer(actual), expected)
                assert_frame(pd.DataFrame({'value': [1]}, dtype=np.int32),
                             pd.DataFrame({'value': [1.]}, dtype=np.float64))
                assert_frame(actual, actual.copy(), check_dtype=True)
            '''),
            ('pandas series', '''
                actual = pd.Series([1.0000005, np.nan], name='actual')
                expected = pd.Series([1., np.nan], name='expected')
                actual.index.name, expected.index.name = 'actual', 'expected'
                assert_series(solution.answer(actual), expected)
                assert_series(pd.Series([1], dtype=np.int32), pd.Series([1.], dtype=np.float64))
                assert_series(actual, actual.copy(), check_dtype=True)
            '''),
            ('PyTorch tensors', '''
                actual = torch.tensor([1.000005, 1e-7], dtype=torch.float32)
                expected = torch.tensor([1., 0.], dtype=torch.float64)
                assert_tensor(solution.answer(actual), expected)
                assert_tensor(torch.tensor([1.1]), torch.tensor([1.]), rtol=.2, atol=0)
            '''),
            ('Expected exceptions with arguments', '''
                class ExpectedError(ValueError):
                    pass
                def fail(value, *, label):
                    assert value == 3 and label == 'checked'
                    raise ExpectedError('matched')
                assert_raises(ValueError, fail, 3, label='checked')
            '''),
        ]
        for result in self.run_scenarios(scenarios):
            with self.subTest(case=result['name']):
                self.assertTrue(result['passed'], result)

    def test_helpers_reject_genuinely_wrong_results(self):
        scenarios = [
            ('Array type', 'assert_array([1], [1])'),
            ('Array shape', 'assert_array(np.array([[1, 2]]), [1, 2])'),
            ('Array values', 'assert_array(np.array([2.]), [1.])'),
            ('Array dtype', "assert_array(np.array([1], dtype=np.int32), [1], dtype='float64')"),
            ('Array strings', "assert_array(np.array(['wrong']), ['expected'])"),
            ('Array strict tolerance', 'assert_array(np.array([1.0000005]), [1.], rtol=0, atol=0)'),
            ('Frame type', "assert_frame(pd.Series([1]), pd.DataFrame({'value': [1]}))"),
            ('Frame shape', "assert_frame(pd.DataFrame({'value': [1, 2]}), pd.DataFrame({'value': [1]}))"),
            ('Frame values', "assert_frame(pd.DataFrame({'value': [2.]}), pd.DataFrame({'value': [1.]}))"),
            ('Frame dtype', "assert_frame(pd.DataFrame({'value': [1]}, dtype=np.int32), pd.DataFrame({'value': [1.]}, dtype=np.float64), check_dtype=True)"),
            ('Series type', 'assert_series(np.array([1]), pd.Series([1]))'),
            ('Series shape', 'assert_series(pd.Series([1, 2]), pd.Series([1]))'),
            ('Series values', 'assert_series(pd.Series([2.]), pd.Series([1.]))'),
            ('Series dtype', 'assert_series(pd.Series([1], dtype=np.int32), pd.Series([1.], dtype=np.float64), check_dtype=True)'),
            ('Tensor type', 'assert_tensor(np.array([1.]), torch.tensor([1.]))'),
            ('Tensor shape', 'assert_tensor(torch.tensor([[1.]]), torch.tensor([1.]))'),
            ('Tensor values', 'assert_tensor(torch.tensor([2.]), torch.tensor([1.]))'),
            ('Tensor strict tolerance', 'assert_tensor(torch.tensor([1.000005]), torch.tensor([1.]), rtol=0, atol=0)'),
            ('Tensor NaN default', "assert_tensor(torch.tensor([float('nan')]), torch.tensor([float('nan')]))"),
            ('Missing exception', 'assert_raises(ValueError, lambda: None)'),
            ('Wrong exception', '''
                def fail():
                    raise TypeError('wrong exception remains visible')
                assert_raises(ValueError, fail)
            '''),
        ]
        for result in self.run_scenarios(scenarios):
            with self.subTest(case=result['name']):
                self.assertFalse(result['passed'], result)
                expected_error = 'TypeError: wrong exception remains visible' if result['name'] == 'Wrong exception' else 'AssertionError:'
                self.assertTrue(result.get('error', '').startswith(expected_error), result)


class NativeProtocol(unittest.TestCase):
    def test_invalid_protocol_and_specs_are_rejected_before_candidate_code(self):
        spec = {'runtime': 'python', 'entryPoint': 'answer', 'cases': [case()]}
        valid = native_job(spec, 'raise RuntimeError("must never execute")')
        invalid = [None, [], {}, {key: value for key, value in valid.items() if key != 'protocolVersion'}]
        invalid.extend({**valid, 'protocolVersion': version} for version in [None, 1, '2', 3])
        invalid.extend({**valid, 'problemVersion': version} for version in [None, '', 'A' * 64, 'short'])
        invalid.extend({**valid, 'problemId': value} for value in [None, '', 'x' * 201])
        invalid.extend({**valid, 'spec': value} for value in [None, [], {}, {**spec, 'runtime': 'javascript'}])
        invalid.extend({**valid, 'spec': {**spec, 'cases': cases}} for cases in [
            None, {}, [], [case()] * 33, [None], [{}], [{**case(), 'expected': None}],
            [{**case(), 'args': None}], [{'name': 'Incomplete', 'expected': '6', 'code': 4}],
        ])
        invalid.extend([
            {**valid, 'spec': {'runtime': 'sql', 'cases': [case()]}},
            {**valid, 'spec': {'runtime': 'shell', 'cases': [case()]}},
            {**valid, 'code': None},
            {**valid, 'code': 'x' * (50 * 1024 + 1)},
            {**valid, 'mode': 'unrecognized'},
        ])
        with patch.object(entrypoint, 'solution_module') as candidate:
            for index, job in enumerate(invalid):
                with self.subTest(request=index), self.assertRaises(ValueError):
                    entrypoint.run(job)
            candidate.assert_not_called()

    def test_each_request_uses_its_own_supplied_cases(self):
        source = 'def answer(value): return value * 2'
        for expected, passed in [('6', True), ('7', False), ('6', True)]:
            spec = {'runtime': 'python', 'entryPoint': 'answer', 'cases': [case(expected=expected)]}
            result = entrypoint.run(native_job(spec, source))
            self.assertEqual(result['cases'][0]['passed'], passed, result)


if __name__ == '__main__':
    unittest.main(verbosity=2)
