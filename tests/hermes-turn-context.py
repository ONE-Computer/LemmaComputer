"""Boundary regressions; no Hermes installation or provider credential required."""
import asyncio
import concurrent.futures
import importlib.util
import os
from pathlib import Path
import threading
import unittest
import sys
import subprocess
import tempfile
from types import SimpleNamespace
sys.dont_write_bytecode = True
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('identity', Path(__file__).resolve().parents[1] / 'docker/workspace/lemmacomputer_hermes_mcp_identity.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'
BH = 'x-lemmacomputer-ai-task-binding'
IH = 'x-lemmacomputer-agent-instance-id'

def context(identity, turn):
    return h.parse_turn_context({IH: identity, BH: 'fixture' + str(turn) + 'a'*24 + '.signature'})

class TurnContextTests(unittest.TestCase):
    def test_process_cleanup_never_claims_another_home_or_unknown_owner(self):
        with tempfile.TemporaryDirectory() as home:
            child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                                     env={**os.environ, 'HERMES_HOME': home})
            try:
                self.assertTrue(h.gateway_process_matches_home(child.pid, home))
                self.assertFalse(h.gateway_process_matches_home(child.pid, home + '-other'))
                self.assertFalse(h.gateway_process_matches_home(999999999, home))
                self.assertIsNone(child.poll())
            finally:
                child.terminate()
                child.wait(timeout=5)

    def test_auxiliary_headers_are_request_local_and_cannot_leave_broker(self):
        shared = {'model':'lemmacomputer-balanced', 'extra_headers':{BH:'stale', IH:'stale', 'keep':'yes'}}
        with h.bind_turn_context(context(A, 0)):
            for port in (4314, 4316):
                result = h.auxiliary_request_overrides(SimpleNamespace(base_url=f'http://127.0.0.1:{port}/v1/'), shared)
                self.assertEqual(result['extra_headers'][IH], A)
                self.assertEqual(result['extra_headers'][BH], context(A, 0).binding)
                self.assertEqual(result['extra_headers']['keep'], 'yes')
            for url in ('https://example.com/v1', 'http://127.0.0.1:9999/v1', 'http://user@127.0.0.1:4314/v1'):
                with self.assertRaises(ValueError):
                    h.auxiliary_request_overrides(SimpleNamespace(base_url=url), shared)
            self.assertTrue(h.native_approval_unavailable())
        self.assertFalse(h.native_approval_unavailable())
        self.assertEqual(shared['extra_headers'][BH], 'stale')

    def test_rejects_incomplete_or_malformed_browser_context(self):
        for headers in ({IH:A}, {BH:'a'*32+'.b'}, {IH:'invalid', BH:'a'*32+'.b'},
                        {IH:A, BH:'short.x'}, {IH:A, BH:'a'*4096+'.b'},
                        {IH:A, BH:'a'*32+'.bad space'}):
            with self.subTest(headers=list(headers)), self.assertRaises(ValueError):
                h.parse_turn_context(headers)

    def test_concurrent_resumed_turns_do_not_mutate_config_or_leak_identity(self):
        shared = {'extra_headers': {'keep':'yes', BH:'stale', IH:'stale'}}
        barrier = threading.Barrier(2)
        def run(identity):
            for turn in range(3):
                ctx = context(identity, turn)
                with h.bind_turn_context(ctx):
                    barrier.wait(timeout=5)
                    headers = h.model_request_overrides(shared)['extra_headers']
                    self.assertEqual(headers, {'keep':'yes', BH:ctx.binding, IH:identity})
                    self.assertEqual(h.capture_agent_instance_meta(), {'lemmacomputer':{'agentInstanceId':identity}})
                    barrier.wait(timeout=5)
                self.assertIsNone(h._TURN.get())
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(run, identity) for identity in (A,B)]
            for future in futures:
                future.result(timeout=10)
        self.assertEqual(shared, {'extra_headers': {'keep':'yes', BH:'stale', IH:'stale'}})

    def test_explicit_api_context_masks_native_environment_and_stale_headers(self):
        with patch.dict(os.environ, {'LEMMACOMPUTER_AGENT_INSTANCE_ID':A}):
            self.assertEqual(h.capture_agent_instance_meta()['lemmacomputer']['agentInstanceId'], A)
            with h.bind_turn_context(h.parse_turn_context({})):
                self.assertIsNone(h.capture_agent_instance_meta())
                self.assertEqual(h.model_request_overrides({'extra_headers':{IH.upper():A, BH:'stale'}}), {'extra_headers':{}})
            self.assertEqual(h.capture_agent_instance_meta()['lemmacomputer']['agentInstanceId'], A)

    def test_nested_exception_and_cancellation_restore_context(self):
        outer, inner = context(A,0), context(B,1)
        with h.bind_turn_context(outer):
            with self.assertRaises(RuntimeError):
                with h.bind_turn_context(inner):
                    raise RuntimeError('fixture')
            self.assertEqual(h._TURN.get(), outer)
            async def cancel():
                try:
                    with h.bind_turn_context(inner):
                        raise asyncio.CancelledError()
                except asyncio.CancelledError:
                    self.assertEqual(h._TURN.get(), outer)
            asyncio.run(cancel())
        self.assertIsNone(h._TURN.get())

    def test_bad_override_types_fail(self):
        for value in ([], 'bad', {'extra_headers':[]}):
            with self.assertRaises(TypeError):
                h.model_request_overrides(value)

    def test_failed_tools_keep_failure_status(self):
        self.assertEqual(h.tool_activity_event('tool.completed',True),'tool.failed')
        self.assertEqual(h.tool_activity_event('tool.completed',False),'tool.completed')
        self.assertEqual(h.tool_activity_event('tool.failed'),'tool.failed')

if __name__ == '__main__':
    unittest.main()
