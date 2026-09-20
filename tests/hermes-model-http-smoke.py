"""Real Hermes agent/SDK request smoke using a synthetic loopback provider.

Invoked by qualify-hermes-runtime.py; never uses a credentialed model.
"""
import json, os, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

with tempfile.TemporaryDirectory(prefix='hermes-real-agent-') as home:
    os.environ['HERMES_HOME'] = home
    os.environ['HERMES_DISABLE_BACKGROUND_REVIEW'] = '1'
    from run_agent import AIAgent
    from lemmacomputer_hermes_mcp_identity import bind_turn_context, TurnContext, model_request_overrides
    captured = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            if self.path != '/v1/chat/completions':
                self.send_error(404)
                return
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            captured.append((dict(self.headers), body))
            reply = {'id':'fixture-chat', 'object':'chat.completion', 'created':1,
                     'model':'lemmacomputer-balanced', 'choices':[{'index':0,'finish_reason':'stop',
                     'message':{'role':'assistant','content':'Fixture completed.'}}],
                     'usage':{'prompt_tokens':1,'completion_tokens':2,'total_tokens':3}}
            if body.get('stream'):
                chunks = [
                    {'id':'fixture-chat','object':'chat.completion.chunk','created':1,'model':'lemmacomputer-balanced',
                     'choices':[{'index':0,'delta':{'role':'assistant','content':'Fixture completed.'},'finish_reason':None}]},
                    {'id':'fixture-chat','object':'chat.completion.chunk','created':1,'model':'lemmacomputer-balanced',
                     'choices':[{'index':0,'delta':{},'finish_reason':'stop'}], 'usage':reply['usage']},
                ]
                raw = (''.join('data: '+json.dumps(c)+'\n\n' for c in chunks)+'data: [DONE]\n\n').encode()
            else:
                raw = json.dumps(reply).encode()
            self.send_response(200); self.send_header('Content-Type','text/event-stream' if body.get('stream') else 'application/json')
            self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
    server = ThreadingHTTPServer(('127.0.0.1',0), Handler)
    thread = threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    identity = '11111111-1111-4111-8111-111111111111'
    binding = 'fixture' + 'a'*32 + '.signature'
    try:
        for native in (False, True):
            expected_identity = '22222222-2222-4222-8222-222222222222' if native else identity
            context = None if native else TurnContext(binding, identity)
            if native:
                os.environ['LEMMACOMPUTER_AGENT_INSTANCE_ID'] = expected_identity
            offset = len(captured)
            with bind_turn_context(context):
                agent = AIAgent(base_url=f'http://127.0.0.1:{server.server_port}/v1',api_key='fixture',provider='custom',
                    api_mode='chat_completions',model='lemmacomputer-balanced',max_iterations=2,enabled_toolsets=[],
                    skip_memory=True,skip_background_review=True,skip_context_files=True,quiet_mode=True,
                    reasoning_config={'enabled':False},request_overrides=None)
                result = agent.run_conversation('Return the fixture response.')
            assert result.get('final_response') == 'Fixture completed.', list(result.keys())
            assert len(captured)>offset
            for captured_headers, _ in captured[offset:]:
                headers = {k.lower():v for k,v in captured_headers.items()}
                assert headers.get('x-lemmacomputer-ai-task-binding') == (None if native else binding)
                assert headers.get('x-lemmacomputer-agent-instance-id') == expected_identity
            agent.close()
        print(json.dumps({'realAIAgent':True,'syntheticProvider':True,'requests':len(captured),
                          'governedHeadersReceived':True,'nativeIdentityExplicit':True}))
    finally:
        server.shutdown()
