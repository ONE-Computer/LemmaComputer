"""Real auxiliary SDK calls and title threads; synthetic loopback broker only."""
import asyncio
import concurrent.futures
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import MagicMock, patch


captured = []
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with lock:
            captured.append((dict(self.headers), body))
        raw = json.dumps({
            'id': 'fixture',
            'object': 'chat.completion',
            'created': 1,
            'model': body['model'],
            'choices': [{
                'index': 0,
                'finish_reason': 'stop',
                'message': {'role': 'assistant', 'content': 'Arithmetic check'},
            }],
            'usage': {'prompt_tokens': 2, 'completion_tokens': 2, 'total_tokens': 4},
        }).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


server = ThreadingHTTPServer(('127.0.0.1', 4314), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='hermes-auxiliary-') as home:
        os.environ['HERMES_HOME'] = home
        from agent.auxiliary_client import call_llm, async_call_llm
        from agent.title_generator import maybe_auto_title
        from hermes_state import SessionDB
        from tools.approval import _human_decision
        from lemmacomputer_hermes_mcp_identity import TurnContext, bind_turn_context
        runtime = {
            'provider': 'custom',
            'model': 'lemmacomputer-balanced',
            'base_url': 'http://127.0.0.1:4314/v1',
            'api_key': 'fixture',
            'api_mode': 'chat_completions',
        }
        Path(home, 'config.yaml').write_text(
            'model:\n'
            '  provider: custom\n'
            '  default: lemmacomputer-balanced\n'
            '  base_url: http://127.0.0.1:4314/v1\n'
            '  api_key: fixture\n'
        )
        barrier = threading.Barrier(2)

        def run(index):
            model = 'lemmacomputer-lite' if index == 1 else 'lemmacomputer-pro'
            runtime_for_turn = {**runtime, 'model': model}
            identity = f'{index}'*8+'-'+f'{index}'*4+'-4'+f'{index}'*3+'-8'+f'{index}'*3+'-'+f'{index}'*12
            binding = f'fixture{index}'+'a'*32+'.signature'
            with bind_turn_context(TurnContext(binding, identity)):
                barrier.wait(timeout=10)
                args = dict(
                    provider='custom',
                    model=runtime_for_turn['model'],
                    base_url=runtime['base_url'],
                    api_key='fixture',
                    main_runtime=runtime_for_turn,
                    messages=[{'role': 'user', 'content': str(index)}],
                )
                call_llm(task='compression', **args)
                asyncio.run(async_call_llm(task='compression', **args))
                db = SessionDB(Path(home) / f'{index}.db')
                sid = f'aux-fixture-{index}'
                db.create_session(sid, 'api_server', model=runtime_for_turn['model'])
                maybe_auto_title(
                    db,
                    sid,
                    f'Check arithmetic fixture {index}',
                    main_runtime=runtime_for_turn,
                )
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline and db.get_session_title(sid) != 'Arithmetic check':
                    time.sleep(.05)
                assert db.get_session_title(sid) == 'Arithmetic check'
                db.close()
                decision = _human_decision(
                    MagicMock(),
                    command='fixture',
                    description='fixture',
                    pattern_key='fixture',
                    pattern_keys=['fixture'],
                    warnings=[],
                    session_key=sid,
                    approval_callback=None,
                    is_cli=False,
                    is_gateway=True,
                    is_ask=False,
                    smart=False,
                )
                assert decision['approved'] is False and not decision.get('pending')
                assert 'unavailable in Web Chat' in decision['message']
            return identity, binding

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            expected = dict(pool.map(run, (1, 2)))
        assert len(captured) == 6, len(captured)
        counts = {key: 0 for key in expected}
        for raw_headers, body in captured:
            headers = {key.lower(): value for key, value in raw_headers.items()}
            identity = headers['x-lemmacomputer-agent-instance-id']
            assert headers['x-lemmacomputer-ai-task-binding'] == expected[identity]
            counts[identity] += 1
            expected_model = 'lemmacomputer-lite' if identity.startswith('1') else 'lemmacomputer-pro'
            assert body['model'] == expected_model
        assert list(counts.values()) == [3, 3], counts
        for path in Path(home).rglob('*'):
            if path.is_file():
                data = path.read_bytes()
                assert all(binding.encode() not in data for binding in expected.values()), path.name
        print(json.dumps({
            'realAuxiliarySdkCalls': 6,
            'concurrentIdentities': 2,
            'backgroundTitleContextsPreserved': True,
            'nativeApprovalFailsClosedInWebChat': True,
        }))
finally:
    server.shutdown()
