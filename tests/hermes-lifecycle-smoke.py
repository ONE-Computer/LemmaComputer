"""Launch real API gateway and Desktop backend in distinct synthetic homes."""
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        return sock.getsockname()[1]

def stop(process):
    if process.poll() is None:
        os.killpg(process.pid,signal.SIGTERM)
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL)
            process.wait(timeout=5)

def healthy(port):
    try:
        with urlopen(f'http://127.0.0.1:{port}/health',timeout=1) as response:
            return response.status==200
    except Exception: return False

with tempfile.TemporaryDirectory(prefix='hermes-lifecycle-') as root:
    root=Path(root)
    homes=[root/'cli',root/'desktop']
    for home in homes:
        home.mkdir()
        (home/'config.yaml').write_text('model:\n  provider: custom\n  default: lemmacomputer-balanced\n  base_url: http://127.0.0.1:4314/v1\n  api_key: fixture\nplatform_toolsets:\n  api_server: []\n  cli: []\n')
    port=free_port()
    base={**os.environ,'HOME':str(root),'HERMES_DISABLE_BACKGROUND_REVIEW':'1','OPENAI_API_KEY':'fixture'}
    gateway_env={**base,'HERMES_HOME':str(homes[0]),'API_SERVER_ENABLED':'true',
        'API_SERVER_HOST':'127.0.0.1','API_SERVER_PORT':str(port),'API_SERVER_KEY':'fixture-'+'x'*40}
    with (root/'gateway.log').open('w') as log:
        gateway=subprocess.Popen([sys.executable,'-m','hermes_cli.main','gateway','run'],
            env=gateway_env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            deadline=time.monotonic()+60
            while time.monotonic()<deadline and gateway.poll() is None and not healthy(port): time.sleep(.1)
            assert healthy(port), 'API gateway did not become healthy'
            for attempt in range(2):
                log_path=root/f'desktop-{attempt}.log'
                with log_path.open('w') as desktop_log:
                    desktop=subprocess.Popen([sys.executable,'-m','hermes_cli.main','serve','--host','127.0.0.1','--port','0'],
                        env={**base,'HERMES_HOME':str(homes[1]),'HERMES_DESKTOP':'1'},
                        stdout=desktop_log,stderr=subprocess.STDOUT,start_new_session=True)
                    try:
                        deadline=time.monotonic()+60
                        ready=False
                        while time.monotonic()<deadline and desktop.poll() is None:
                            ready=bool(re.search(r'HERMES_BACKEND_READY port=\d+',log_path.read_text()))
                            if ready: break
                            time.sleep(.1)
                        assert ready, 'Desktop backend did not become ready: '+log_path.read_text()[-1500:]
                        assert gateway.poll() is None and healthy(port), 'Desktop killed the API gateway'
                    finally: stop(desktop)
                assert gateway.poll() is None and healthy(port), 'Desktop shutdown affected the API gateway'
            print(json.dumps({'realApiGateway':True,'realDesktopBackendStarts':2,
                'separateHomesPreserved':True,'apiHealthAfterDesktopStartAndStop':True}))
        finally: stop(gateway)
