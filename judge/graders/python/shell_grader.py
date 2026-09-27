"""Grades shell problems: run the learner's script in a fresh folder, then check the result."""
import io
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile


def grade_shell_case(code, case):
    with tempfile.TemporaryDirectory(prefix='linux-', dir='/work') as directory:
        root = Path(directory)
        create_files(root, case)
        # Names the spec's `before` (setup) and `verify` (check) code can use.
        names = {'root': root, 'Path': Path, 'tarfile': tarfile, 'io': io, 're': re}
        if case.get('before'):
            exec(case['before'], names)
        output = run_script(code, root)
        names['output'] = output
        try:
            exec(case['verify'], names)
        except AssertionError as error:
            raise AssertionError(str(error) or 'Observed output: ' + repr(output[:1800])) from error
        return output[:4000] or 'Filesystem and process checks passed'


def create_files(root, case):
    for name in case.get('directories', []):
        (root / name).mkdir(parents=True, exist_ok=True)
    for name, text in case.get('files', {}).items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)
    for name, mode in case.get('modes', {}).items():
        (root / name).chmod(mode)


def run_script(code, root):
    """Run the script with bash for up to 4 seconds. LC_ALL=C keeps sorting and formatting stable."""
    try:
        result = subprocess.run(['bash', '-c', code], cwd=root, env={**os.environ, 'LC_ALL': 'C'},
                                stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                errors='replace', timeout=4)
    except subprocess.TimeoutExpired:
        raise AssertionError('Command did not finish within 4 seconds') from None
    assert result.returncode == 0, f'Command exited {result.returncode}: {result.stderr[:1000]}'
    return result.stdout
