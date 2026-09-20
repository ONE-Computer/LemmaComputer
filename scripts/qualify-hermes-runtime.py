#!/usr/bin/env python3
"""Installed Hermes boundary qualification with synthetic SDK/HTTP fixtures.

Run using the candidate Hermes venv. No real provider, credential, prompt or
customer state is used. This is transport evidence, not live route promotion.
"""
import asyncio
import argparse
from contextlib import ExitStack
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
sys.dont_write_bytecode = True
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]


def qualify_history(previous_source, previous_python):
    """Check synthetic old/new/old history; never open an employee home."""
    import hermes_state
    candidate_source = str(Path(hermes_state.__file__).resolve().parent)
    program = '''
import json, sys, sqlite3
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
from hermes_state import SessionDB
from hermes_cli import __version__
phase = int(sys.argv[3])
db = SessionDB(Path(sys.argv[2]))
if phase == 0:
    db.create_session('upgrade-fixture', 'cli', model='lemmacomputer-balanced')
    db.append_message('upgrade-fixture', 'user', content='synthetic history sentinel')
else:
    rows = db.get_messages('upgrade-fixture')
    assert len(rows) == phase
    assert rows[0]['content'] == 'synthetic history sentinel'
    db.append_message('upgrade-fixture', 'assistant', content='synthetic resume')
assert db._conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
print(json.dumps({'phase': phase, 'runtime': __version__, 'messages': len(db.get_messages('upgrade-fixture')),
                 'sqlite': sqlite3.sqlite_version,
                 'journal': db._conn.execute('PRAGMA journal_mode').fetchone()[0]}))
db.close()
'''
    with tempfile.TemporaryDirectory(prefix='lemma-hermes-history-') as home:
        observations = []
        for phase, (python, source) in enumerate([
            (previous_python, previous_source), (sys.executable, candidate_source),
            (previous_python, previous_source),
        ]):
            result = subprocess.run(
                [python, '-c', program, str(source), str(Path(home)/'state.db'), str(phase)],
                env={**os.environ, 'HERMES_HOME': home}, capture_output=True, text=True,
                check=True, timeout=60,
            )
            observations.append(json.loads(result.stdout))
        print(json.dumps({'syntheticHistoryUpgradeRollback': observations,
                          'limitation': 'basic transcript only; not a backup/restore qualification for all employee data'}))

async def qualify():
    from hermes_cli import __version__
    from hermes_cli.sqlite_runtime import is_sqlite_wal_reset_vulnerable
    import sqlite3
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter
    import lemmacomputer_hermes_mcp_identity as h
    from tools import mcp_tool_handlers as handlers
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    assert __version__ == '0.21.3'
    assert not is_sqlite_wal_reset_vulnerable(sqlite3.sqlite_version_info), sqlite3.sqlite_version
    assert importlib.metadata.version('mcp') == '2.0.0'
    identities = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    binding_header, identity_header = 'x-lemmacomputer-ai-task-binding', 'x-lemmacomputer-agent-instance-id'
    captured = []
    gate = threading.Barrier(2)
    shared = {'extra_headers': {'fixture-header':'preserved'}}
    adapter = APIServerAdapter(PlatformConfig(enabled=True))

    def make_agent(**kwargs):
        agent = MagicMock()
        agent.model = kwargs['model']
        agent.provider = 'custom'
        agent.session_id = kwargs['session_id']
        agent.session_prompt_tokens, agent.session_completion_tokens, agent.session_total_tokens = 1, 1, 2
        agent._last_compaction_in_place = False
        def run(**_):
            gate.wait(timeout=10)
            captured.append((agent.session_id, kwargs['request_overrides'], h.capture_agent_instance_meta()))
            callback = kwargs.get('stream_delta_callback')
            if callback:
                callback('fixture response')
            callback = kwargs.get('tool_progress_callback')
            if callback:
                callback('tool.started', 'fixture-tool')
                callback('tool.completed', 'fixture-tool', is_error=True)
            return {'final_response':'fixture response', 'messages':[], 'api_calls':1, 'tools':[]}
        agent.run_conversation.side_effect = run
        return agent

    app = web.Application()
    app.router.add_post('/api/sessions/{session_id}/chat', adapter._handle_session_chat)
    app.router.add_post('/api/sessions/{session_id}/chat/stream', adapter._handle_session_chat_stream)
    with ExitStack() as mocks:
        mocks.enter_context(patch('run_agent.AIAgent', side_effect=make_agent))
        mocks.enter_context(patch('gateway.run._resolve_runtime_agent_kwargs', side_effect=lambda: {'provider':'custom','api_key':'fixture','request_overrides':shared}))
        mocks.enter_context(patch('gateway.run._resolve_gateway_model', return_value='lemmacomputer-balanced'))
        mocks.enter_context(patch('gateway.run._load_gateway_config', return_value={}))
        mocks.enter_context(patch('gateway.run.GatewayRunner._load_reasoning_config', return_value={'enabled':False}))
        mocks.enter_context(patch('gateway.run.GatewayRunner._load_fallback_model', return_value=None))
        mocks.enter_context(patch('gateway.run._checkpoint_agent_kwargs', return_value={}))
        mocks.enter_context(patch('hermes_cli.tools_config._get_platform_tools', return_value=[]))
        mocks.enter_context(patch.object(adapter, '_select_agent_runtime', side_effect=lambda runtime, model, **_: (model,None,None,None)))
        mocks.enter_context(patch.object(adapter, '_ensure_session_db', return_value=MagicMock()))
        mocks.enter_context(patch.object(adapter, '_get_existing_session_or_404', new=AsyncMock(return_value=({'id':'fixture'}, None))))
        mocks.enter_context(patch.object(adapter, '_conversation_history_for_session', new=AsyncMock(return_value=[])))
        mocks.enter_context(patch.object(adapter, '_request_route_conflict_error', return_value=None))
        async with TestClient(TestServer(app)) as client:
            for turn in range(2):
                async def request(index):
                    binding = f'fixture{index}turn{turn}' + 'a'*24 + '.signature'
                    path = f'/api/sessions/fixture-{index}/chat' + ('/stream' if index else '')
                    response = await client.post(path, json={'message':'fixture'}, headers={binding_header:binding,identity_header:identities[index]})
                    body = await response.text()
                    assert response.status == 200, (response.status, body[:200])
                    if index:
                        assert 'tool.failed' in body and 'assistant.completed' in body
                    record = next(row for row in captured if row[0] == f'fixture-{index}' and row[1]['extra_headers'].get(binding_header) == binding)
                    assert record[1]['extra_headers'] == {'fixture-header':'preserved', binding_header:binding, identity_header:identities[index]}
                    assert record[2] == {'lemmacomputer':{'agentInstanceId':identities[index]}}
                await asyncio.gather(request(0), request(1))
            for headers in ({identity_header:identities[0]}, {binding_header:'a'*32+'.b'}, {identity_header:'bad',binding_header:'a'*32+'.b'}):
                response = await client.post('/api/sessions/fixture-0/chat', json={'message':'fixture'}, headers=headers)
                assert response.status == 400
    assert shared == {'extra_headers': {'fixture-header':'preserved'}}
    assert h._TURN.get() is None

    # Exercise the installed MCP 2 client against our actual stdio bridge and
    # verify that Hermes' patched dispatch puts identity in metadata, not args.
    received = []
    async def list_tools(_):
        return web.json_response({'tools':[{'name':'web_search_exa','description':'fixture','inputSchema':{'type':'object'},'mcp_info':{'server_id':'fixture','server_name':'lemmacomputer_exa'}}]})
    async def call_tool(request):
        received.append(({key.lower():value for key,value in request.headers.items()}, await request.json()))
        return web.json_response({'content':[{'type':'text','text':'fixture result'}], 'isError':False})
    broker = web.Application()
    broker.router.add_get('/mcp-rest/tools/list', list_tools)
    broker.router.add_get('/mcp-rest/tools/signature', lambda _: web.json_response({'signature':'a'*64}))
    broker.router.add_post('/mcp-rest/tools/call', call_tool)
    runner = web.AppRunner(broker)
    await runner.setup()
    # The production bridge deliberately only accepts fixed loopback ports.
    await web.TCPSite(runner, '127.0.0.1', 4314).start()
    try:
        params = StdioServerParameters(command=sys.executable, args=[str(ROOT/'docker/workspace/lemmacomputer-connectors-stdio.py')],
            env={'PATH':os.environ.get('PATH',''), 'HOME':os.environ['HERMES_HOME'], 'LEMMACOMPUTER_CONNECTORS_BROKER':'http://127.0.0.1:4314'})
        async with stdio_client(params) as streams:
            async with ClientSession(*streams) as session:
                await session.initialize()
                listed = await session.list_tools()
                name = next(tool.name for tool in listed.tools if 'web_search_exa' in tool.name)
                server = SimpleNamespace(session=session)
                for identity in identities:
                    meta = {'lemmacomputer': {'agentInstanceId':identity}}
                    result = await handlers._call_tool_racing_stdio_death(server,'fixture',name,{},meta)
                    assert not result.is_error
                    headers, body = received[-1]
                    assert headers.get(identity_header) == identity
                    assert body.get('arguments') == {}, body
    finally:
        await runner.cleanup()
    print(json.dumps({'runtime':__version__, 'sqlite':sqlite3.sqlite_version, 'mcp':importlib.metadata.version('mcp'), 'concurrentResumedHttpTurns':len(captured),
        'partialIdentityRejected':True, 'failedToolEventPreserved':True, 'mcpBridgeCalls':len(received),
        'evidence':'synthetic installed-runtime boundaries; model execution mocked; no live provider qualification'}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous-source', type=Path)
    parser.add_argument('--previous-python')
    args = parser.parse_args()
    if bool(args.previous_source) != bool(args.previous_python):
        parser.error('--previous-source and --previous-python must be supplied together')
    with tempfile.TemporaryDirectory(prefix='lemma-hermes-qualification-') as home:
        os.environ['HERMES_HOME'] = home
        os.environ['HERMES_DISABLE_BACKGROUND_REVIEW'] = '1'
        asyncio.run(qualify())
        model_smoke = subprocess.run(
            [sys.executable, str(ROOT/'tests/hermes-model-http-smoke.py')],
            capture_output=True, text=True, check=True, timeout=90,
        )
        print(model_smoke.stdout.strip())
        if args.previous_source:
            qualify_history(args.previous_source.resolve(), args.previous_python)
