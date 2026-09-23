"""Grades shell exercises using disposable Linux fixtures inside the container."""
import io
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time


def grade_shell_case(code, case):
    with tempfile.TemporaryDirectory(prefix='linux-', dir='/work') as directory:
        root = Path(directory)
        for name in case.get('directories', []):
            (root/name).mkdir(parents=True, exist_ok=True)
        for name, value in case.get('files', {}).items():
            path=root/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)
        for name, value in case.get('modes', {}).items():
            (root/name).chmod(value)
        env={**os.environ, 'TERM':'xterm', 'LC_ALL':'C', 'MANPAGER':'less', 'PAGER':'less', 'LESS':'-R', 'APP_ENV':''}
        scope={'root':root,'Path':Path,'json':json,'os':os,'tarfile':tarfile,'io':io,'subprocess':subprocess,'sys':sys,'env':env}
        children=[]
        server=None
        records=[]
        try:
            if case.get('before'):
                exec(case['before'],scope)
            kind=case.get('kind')
            if kind=='http' or kind=='sockets':
                from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
                class Handler(BaseHTTPRequestHandler):
                    def respond(self):
                        data=self.rfile.read(int(self.headers.get('Content-Length',0)))
                        records.append({'method':self.command,'path':self.path,'contentType':self.headers.get('Content-Type'),'body':data.decode()})
                        self.send_response(200)
                        self.send_header('Content-Type','text/plain')
                        self.end_headers()
                        self.wfile.write(b'ok\n')
                    do_GET=respond
                    do_POST=respond
                    def log_message(self,*args): pass
                ThreadingHTTPServer.allow_reuse_address=True
                server=ThreadingHTTPServer(('127.0.0.1',3000),Handler)
                threading.Thread(target=server.serve_forever,daemon=True).start()
            if kind=='processes':
                child=subprocess.Popen(['bash','-c','exec -a "nginx: worker process" sleep 20'])
                children.append(child)
                scope['target_pid']=child.pid
            if kind=='signal':
                marker=root/'cleanup.txt'
                child=subprocess.Popen([sys.executable,'-u','-c',f'import signal,time,pathlib; signal.signal(signal.SIGTERM, lambda *a: (pathlib.Path({str(marker)!r}).write_text("cleaned"),exit(0))); print("ready",flush=True); time.sleep(20)'],stdout=subprocess.PIPE)
                child.stdout.readline()
                children.append(child)
                descriptor, path=tempfile.mkstemp(dir='/tmp',suffix='.sh')
                os.close(descriptor)
                boot=Path(path)
                boot.write_text('kill() { local args=(); for arg in "$@"; do if [[ "$arg" == 4321 ]]; then args+=("'+str(child.pid)+'"); else args+=("$arg"); fi; done; builtin kill "${args[@]}"; }\n')
                env['BASH_ENV']=str(boot)
                scope['child']=child
            if kind=='ssh':
                tools=Path(tempfile.mkdtemp(dir='/tmp',prefix='ssh-fixture-'))
                log=tools/'request.json'
                stub=tools/'ssh'
                stub.write_text('#!/usr/local/bin/python\nimport json,sys,pathlib\na=sys.argv[1:]; user=None\nif "-l" in a:\n i=a.index("-l"); user=a[i+1]; del a[i:i+2]\nassert len(a)==1,"Open a session without a remote command"\nhost=a[0]\nif "@" in host: user,host=host.split("@",1)\npathlib.Path('+repr(str(log))+').write_text(json.dumps({"host":host,"user":user}))\nprint("SSH session requested")\n')
                stub.chmod(0o755)
                env['PATH']=str(tools)+':'+env['PATH']
                boot=tools/'ssh-env.sh'
                boot.write_text('ssh() { python3 '+__import__('shlex').quote(str(stub))+' "$@"; }\n')
                env['BASH_ENV']=str(boot)
                scope['ssh_log']=log
            trailer=''
            if kind=='environment':
                descriptor, path=tempfile.mkstemp(dir='/tmp',suffix='.json')
                os.close(descriptor)
                env_file=Path(path)
                trailer='\npython3 -c '+__import__('shlex').quote('import os,json,pathlib; pathlib.Path('+repr(str(env_file))+').write_text(json.dumps(dict(os.environ)))')
                scope['env_file']=env_file
            command=['bash','--noprofile','--norc','-c',code+trailer]
            if kind in {'pager','monitor','manual','follow'}:
                import pty
                master, slave=pty.openpty()
                process=subprocess.Popen(command,cwd=root,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
                os.close(slave)
                children.append(process)
                chunks=[]
                start=time.monotonic()
                appended=False
                while time.monotonic()-start<1.3:
                    if kind=='follow' and not appended and time.monotonic()-start>.3:
                        with (root/'app.log').open('a') as handle:handle.write(case['append'])
                        appended=True
                    if select.select([master],[],[],.04)[0]:
                        try:chunks.append(os.read(master,8192))
                        except OSError:break
                    if sum(map(len,chunks))>65536:raise AssertionError('Too much terminal output')
                was_running=process.poll() is None
                if kind=='follow':
                    if was_running:os.killpg(process.pid,signal.SIGTERM)
                else:
                    if was_running:os.write(master,b'q')
                try:process.wait(timeout=1)
                except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
                os.close(master)
                output=b''.join(chunks).decode(errors='replace')
                scope['was_running']=was_running
            else:
                # Files cap stdout/stderr using RLIMIT_FSIZE; parent also caps JSON.
                with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
                    def limits():
                        import resource
                        resource.setrlimit(resource.RLIMIT_FSIZE,(65536,65536))
                    process=subprocess.Popen(command,cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=err,preexec_fn=limits,start_new_session=True)
                    children.append(process)
                    try:status=process.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid,signal.SIGKILL);process.wait()
                        raise AssertionError('Command did not finish within 4 seconds')
                    out.seek(0);err.seek(0)
                    output=out.read(65536).decode(errors='replace')
                    stderr=err.read(65536).decode(errors='replace')
                assert status==0, f'Command exited {status}: {stderr[:1000]}'
            clean=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',output).replace('\r','')
            scope.update(output=clean,records=records,time=time,re=re)
            try:
                exec(case['verify'],scope)
            except AssertionError as error:
                raise AssertionError(str(error) or ('Observed output: '+repr(clean[:1800]))) from error
            return clean[:4000] or 'Filesystem and process checks passed'
        finally:
            if server:server.shutdown();server.server_close()
            for child in children:
                if child.poll() is None:
                    child.kill();child.wait()
