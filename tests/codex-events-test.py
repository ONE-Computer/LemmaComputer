import ast, asyncio, sys, types
from pathlib import Path
from typing import Any, AsyncIterator
N=types.SimpleNamespace
source=ast.parse(Path('docker/workspace/lemmacomputer-agent-chat.py').read_text())
node=next(n for n in source.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='_codex_vendor_events_with_client')
sys.modules['openai_codex']=N(ApprovalMode=N(deny_all='never'),Sandbox=N(read_only='read-only',danger_full_access='danger-full-access'),TextInput=str,ImageInput=str)
HOME=Path('/tmp'); EXECUTION_MODE='managed'
codex_model=lambda _: 'lemmacomputer-balanced'
system_prompt=lambda: 'fixture'
prompt_with_transcript=lambda _,s:s
prompt_with_documents=lambda s,*_:s
IMAGE_TYPES=set()
extract_sources=lambda _:[]
safe_identifier=lambda *args:':'.join(args)
safe_tool_name=lambda x:x
tool_trace_summary=lambda *args: 'Approved tool'
approval_from=lambda _:None
web_action_for_tool=lambda *args:None
notifications=[
 N(method='item/reasoning/textDelta',payload=N(delta='PRIVATE_RAW_MARKER')),
 N(method='item/completed',payload=N(item=N(type='reasoning',summary=['PRIVATE_SUMMARY_MARKER']))),
 N(method='item/agentMessage/delta',payload=N(delta='Public answer')),
 *[N(method=method,payload=N(item=N(type='mcpToolCall',id='1',tool='approved_tool',arguments={},status=N(value='completed'),result=None))) for method in ['item/started','item/completed']],
 N(method='turn/completed',payload=N(turn=N(status=N(value='completed'))))]
class Turn:
 async def stream(self):
  for n in notifications: yield n
class Thread:
 id='thread-fixture'
 async def turn(self,*args,**kw):return Turn()
class Client:
 async def thread_start(self,**kw):return Thread()
exec(compile(ast.Module(body=[node],type_ignores=[]),'adapter','exec'))
async def main():
 events=[e async for e in _codex_vendor_events_with_client(Client(),{},'fixture',[],'turn',False,'binding')]
 assert [e['kind'] for e in events]==['text','tool','tool','vendor-finish'],events
 assert [e['state'] for e in events if e['kind']=='tool']==['running','completed']
 assert 'PRIVATE_' not in str(events)
 print('passed')
asyncio.run(main())
