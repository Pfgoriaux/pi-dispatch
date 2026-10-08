import test, { after } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree, removeWorktree, pruneStale, assertCleanTree, ensureExcluded } from '../src/worktree.ts';
import { runWorkerProc } from '../src/worker-proc.ts';
import extension from '../src/index.ts';
import { PROFILES } from '../src/profiles.ts';
import { recordWorkerSession } from '../src/worker.ts';

// All Git writes and fake children are confined to this disposable fixture.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-write-tier-'));
const envKeys = ['HERDR_ENV', 'PI_CODING_AGENT_DIR', 'LINKUP_API_KEY', 'PI_DISPATCH_PI_BIN', 'PI_DISPATCH_DEPTH', 'PI_WORKTREE_ROOT'];
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
after(() => {
 for (const [key, value] of savedEnv) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
 }
 fs.rmSync(root, {recursive:true, force:true});
});
process.env.HERDR_ENV = '0';
delete process.env.PI_DISPATCH_DEPTH;
process.env.PI_CODING_AGENT_DIR = path.join(root, 'mock-config');
delete process.env.LINKUP_API_KEY;
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, {recursive:true});
const tools: any[] = [];
extension({on() {}, registerTool(tool: any) { tools.push(tool); }} as any);
const dispatch = tools.find(t=>t.name==='dispatch');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
function repo() {
 const dir=fs.mkdtempSync(path.join(root,'repo-'));
 git(dir,'init','-b','feat/test'); git(dir,'config','user.name','Dispatch Test'); git(dir,'config','user.email','dispatch-test@example.invalid');
 git(dir,'config','commit.gpgsign','false'); git(dir,'config','core.hooksPath','/dev/null');
 fs.writeFileSync(path.join(dir,'.gitignore'),'.dispatch/\n'); fs.writeFileSync(path.join(dir,'shared.txt'),'base\n');
 git(dir,'add','.'); git(dir,'commit','-m','fixture'); return dir;
}
function commit(dir: string, file: string, text: string) { fs.writeFileSync(path.join(dir,file),text); git(dir,'add','--',file); git(dir,'commit','-m','fixture edit'); }
function fake(code: string) {
 const bin=path.join(root,'fake-pi-'+Math.random().toString(36).slice(2)+'.cjs');
 fs.writeFileSync(bin,'#!/usr/bin/env node\n'+code,{mode:0o700}); process.env.PI_DISPATCH_PI_BIN=bin;
}
const final = `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'fixture finished'}],stopReason:'stop',model:'fixture'}}));`;
const agent:any={name:'writer',description:'test',model:'fake/model',tools:['read','edit','write','bash'],systemPrompt:'test',source:'bundled',filePath:''};
const ctx=(cwd:string)=>({cwd,model:{provider:'fake',id:'model'},isProjectTrusted:()=>false}) as any;
const call=(cwd:string,params:any,signal?:AbortSignal)=>dispatch.execute('test', {...params,herdr:false},signal,undefined,ctx(cwd));

test('reject invalid dispatch inputs before launching workers', async()=>{
 const dir=repo();
 for(const params of [{},{agent:'nonexistent',task:'x'},{tasks:Array.from({length:9},()=>({agent:'scout',task:'x'}))},{chain:Array.from({length:9},()=>({agent:'scout',task:'x'}))},{tasks:[{agent:'scout',task:'x'}],chain:[{agent:'scout',task:'x'}]},{resume:'missing',task:'x'},{tasks:[{agent:'writer',task:'x',worktree:true,cwd:'.'}]}]) await assert.rejects(()=>call(dir,params));
});

test('writer requests without worktree isolation fail before selecting a model',async()=>{
 const dir=repo();
 recordWorkerSession('legacy-writer',path.join(root,'unused-session.jsonl'),'writer');
 for(const params of [
  {agent:'writer',task:'x'},
  {tasks:[{agent:'writer',task:'x'}]},
  {chain:[{agent:'writer',task:'x'}]},
  {resume:'legacy-writer',task:'x'},
  {tasks:[{agent:'writer',task:'x',worktree:false}]},
  {tasks:[{agent:'writer',task:'x',worktree:true},{agent:'writer',task:'x'}]},
 ]) await assert.rejects(()=>call(dir,params),/writer requires/);
 assert.equal(git(dir,'branch','--list','dispatch/*'),'');
});

test('default writer selects Kimi; GLM and precise remain explicit choices',async()=>{
 const dir=repo();
 fake(`const args=process.argv.slice(2); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({model:args[args.indexOf('--model')+1],thinking:args[args.indexOf('--thinking')+1]})}],stopReason:'stop'}}));`);
 for(const [model,expected] of [
  [undefined,PROFILES.long.model],
  ['aperture/neuralwatt/glm-5.3','aperture/neuralwatt/glm-5.3'],
  ['precise',PROFILES.precise.model],
 ]) {
  const result=await call(dir,{tasks:[{agent:'writer',task:'fixture',model,worktree:true}],aggregate:false});
  assert.equal(result.details.items[0].status,'ok');
  assert.deepEqual(JSON.parse(result.details.items[0].text),{model:expected,thinking:'high'});
 }
});
test('reject traversal and symlink cwd escapes', async()=>{
 const dir=repo(); fs.symlinkSync(root,path.join(dir,'escape'));
 for(const cwd of ['..','escape','missing']) await assert.rejects(()=>call(dir,{tasks:[{agent:'scout',task:'x',cwd}]}));
});
test('reject worktree dispatch from non-repo or repo subdirectory',async()=>{
 const dir=repo(); fs.mkdirSync(path.join(dir,'sub'));
 for(const cwd of [root,path.join(dir,'sub')]) await assert.rejects(()=>call(cwd,{tasks:[{agent:'writer',task:'x',worktree:true}]}));
});
test('dirty repo rejected without changing files or HEAD',async()=>{
 const dir=repo(), head=git(dir,'rev-parse','HEAD'); fs.writeFileSync(path.join(dir,'shared.txt'),'local edit\n');
 await assert.rejects(()=>createWorktree(dir,'run','one'),/clean working tree/);
 assert.equal(git(dir,'rev-parse','HEAD'),head); assert.equal(fs.readFileSync(path.join(dir,'shared.txt'),'utf8'),'local edit\n');
});
test('clean-tree checks include untracked files even when user config hides them',async()=>{
 const dir=repo(); git(dir,'config','status.showUntrackedFiles','no');
 fs.writeFileSync(path.join(dir,'hidden.txt'),'uncommitted');
 await assert.rejects(()=>assertCleanTree(dir),/clean working tree/);
});
test('unsafe worktree path components rejected',async()=>{
 const dir=repo(); for(const id of ['..','../escape','a/b','a\\b','']) await assert.rejects(()=>createWorktree(dir,'run',id));
});
test('first-use excludes leave tracked files and parent clean',async()=>{
 const dir=repo(); git(dir,'rm','.gitignore'); git(dir,'commit','-m','remove ignore');
 ensureExcluded(dir); ensureExcluded(dir);
 const w=await createWorktree(dir,'run','a'); commit(w.path,'a.txt','alpha');
 assert.equal(git(dir,'status','--porcelain'),'');
 assert.equal(fs.existsSync(path.join(dir,'.gitignore')),false);
 assert.equal(fs.readFileSync(path.join(dir,'.git/info/exclude'),'utf8').split('.dispatch/').length,2);
});
test('repos inside the workspace get mirrored central worktrees and no gitignore edit',async()=>{
 const ws=path.join(fs.realpathSync(root),'ws'), central=path.join(ws,'.worktrees'), app=path.join(ws,'products','app');
 fs.mkdirSync(app,{recursive:true}); process.env.PI_WORKTREE_ROOT=central;
 try {
  git(app,'init','-b','main'); git(app,'config','user.name','Dispatch Test'); git(app,'config','user.email','dispatch-test@example.invalid');
  git(app,'config','commit.gpgsign','false'); fs.writeFileSync(path.join(app,'f.txt'),'x\n'); git(app,'add','.'); git(app,'commit','-m','fixture');
  ensureExcluded(app); assert.equal(fs.existsSync(path.join(app,'.gitignore')),false);
  const w=await createWorktree(app,'run','a');
  assert.equal(w.path,path.join(central,'products','app','dispatch-run-a'));
  const nested=await createWorktree(w.path,'run','b');
  assert.equal(nested.path,path.join(central,'products','app','dispatch-run-b'));
  for(const x of [nested,w]) await removeWorktree(app,x.path,{branch:x.branch});
 } finally { delete process.env.PI_WORKTREE_ROOT; }
});
test('failed writer committed branch is kept but not merged',async()=>{
 const dir=repo(),head=git(dir,'rev-parse','HEAD');
 fake(`const fs=require('fs'),cp=require('child_process'); fs.writeFileSync('broken.txt','broken'); cp.execFileSync('git',['add','broken.txt']); cp.execFileSync('git',['commit','-m','broken fixture']); process.exit(1);`);
 const result=await call(dir,{tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false});
 assert.equal(result.details.items[0].status,'error'); const kept=git(dir,'branch','--list','--format=%(refname:short)','dispatch/*').trim(); assert.equal(git(dir,'show',`${kept}:broken.txt`),'broken'); assert.equal(git(dir,'rev-parse','HEAD'),head); assert.ok(!fs.existsSync(path.join(dir,'broken.txt')));
 assert.match(git(dir,'branch','--list','dispatch/*'),/dispatch\//); assert.equal(git(dir,'worktree','list','--porcelain').split('worktree ').length-1,2);
});
test('SAFETY: successful writer without commit must not lose its edits',async()=>{
 const dir=repo(); git(dir,'config','status.showUntrackedFiles','no');
 fake(`require('fs').writeFileSync('valuable.txt','uncommitted work');`+final);
 const result=await call(dir,{tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false});
 assert.equal(result.details.items[0].status, 'error');
 assert.equal(result.details.worktrees[0].status, "error");
 assert.match(result.content[0].text, /not ready/);
 const kept = fs.readdirSync(path.join(dir, '.dispatch/worktrees'));
 assert.equal(kept.length, 1);
 assert.equal(fs.readFileSync(path.join(dir, '.dispatch/worktrees', kept[0], 'valuable.txt'), 'utf8'), 'uncommitted work');
});
test('SAFETY: interrupted worktree cleanup preserves uncommitted edits',async()=>{
 const dir=repo(), w=await createWorktree(dir,'run','a'); fs.writeFileSync(path.join(w.path,'valuable.txt'),'uncommitted work');
 await removeWorktree(dir,w.path,{deleteBranch:false,branch:w.branch});
 let saved=false; try {saved=git(dir,'show',`${w.branch}:valuable.txt`)==='uncommitted work';} catch {}
 assert.ok(fs.existsSync(path.join(w.path,'valuable.txt'))||saved,'retaining branch did not retain uncommitted work');
});
test('SAFETY: stale GC does not delete a locked active worktree',async()=>{
 const dir=repo(), w=await createWorktree(dir,'run','a'); git(dir,'worktree','lock',w.path); fs.writeFileSync(path.join(w.path,'valuable.txt'),'active work');
 const old=new Date(Date.now()-48*3600_000); fs.utimesSync(w.path,old,old); await pruneStale(dir);
 assert.ok(fs.existsSync(path.join(w.path,'valuable.txt')),'active locked worktree was deleted by age-based GC');
});
test('SAFETY: clean-tree validation fails closed outside a repository',async()=>{
 await assert.rejects(()=>assertCleanTree(root), 'git status failure must not be treated as clean');
});
test('child blank output and invalid binary fail; recursion depth refused',async()=>{
 fake(''); assert.equal((await runWorkerProc(agent,'fixture',{cwd:root})).status,'error');
 process.env.PI_DISPATCH_PI_BIN=path.join(root,'nonexistent'); assert.equal((await runWorkerProc(agent,'fixture',{cwd:root})).status,'error');
 process.env.PI_DISPATCH_DEPTH='2'; assert.match((await runWorkerProc(agent,'fixture',{cwd:root})).error!,/depth limit/); delete process.env.PI_DISPATCH_DEPTH;
});
test('SAFETY: unexpected child signal cannot produce success',async()=>{
 fake(final+`setTimeout(()=>process.kill(process.pid,'SIGTERM'),20);`);
 const result=await runWorkerProc(agent,'fixture',{cwd:root}); assert.equal(result.status,'error','SIGTERM was interpreted as exit code zero');
});
test('SAFETY: UTF-8 survives split child stdout chunks',async()=>{
 fake(`const line=Buffer.from(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'a😀b'}],stopReason:'stop'}})+'\\n'); const i=line.indexOf(Buffer.from('😀'))+1; process.stdout.write(line.subarray(0,i)); setTimeout(()=>process.stdout.write(line.subarray(i)),100);`);
 const result=await runWorkerProc(agent,'fixture',{cwd:root}); assert.equal(result.text,'a😀b');
});
for (const detached of [false, true]) test(`SAFETY: abort terminates worker descendants (detached=${detached})`,async()=>{
 const pidfile=path.join(root,'descendant-'+Math.random().toString(36).slice(2)+'.pid');
 fake(`const cp=require('child_process'),fs=require('fs'); const p=cp.spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore',detached:${detached}}); fs.writeFileSync(${JSON.stringify(pidfile)},String(p.pid)); setInterval(()=>{},1000);`);
 const controller=new AbortController(); const promise=runWorkerProc(agent,'fixture',{cwd:root,signal:controller.signal});
 for(let i=0;i<100&&!fs.existsSync(pidfile);i++) await new Promise(r=>setTimeout(r,20));
 assert.ok(fs.existsSync(pidfile)); const pid=Number(fs.readFileSync(pidfile,'utf8')); controller.abort(); const result=await promise; assert.equal(result.status,'aborted');
 let alive=false;
 for (let i=0; i<20; i++) {
  try { alive=!execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim().startsWith('Z'); } catch { alive=false; }
  if (!alive) break;
  await new Promise(r=>setTimeout(r,25));
 }
 if(alive) {try {process.kill(pid,'SIGKILL');} catch {}}
 assert.equal(alive,false,'owned descendant remained alive after cancellation (test cleaned it up)');
});
test('ACCOUNTING: dispatch cache costs are currency, not token counts',async()=>{
 const dir=repo();
 const usage={input:10,output:5,cacheRead:100,cacheWrite:50,totalTokens:165,cost:{input:0.01,output:0.02,cacheRead:0.003,cacheWrite:0.004,total:0.037}};
 fake(`console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'No changes requested'}],stopReason:'stop',usage:${JSON.stringify(usage)}}}));`);
 const result=await call(dir,{tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false});
 assert.equal(result.usage.cost.cacheRead,usage.cost.cacheRead);
 assert.equal(result.usage.cost.cacheWrite,usage.cost.cacheWrite);
});

test('writer commits are returned with durable references, never integrated or removed', async()=>{
 const dir=repo(), head=git(dir,'rev-parse','HEAD');
 fake(`const fs=require('fs'),cp=require('child_process'); fs.writeFileSync('done.txt','ok'); cp.execFileSync('git',['add','--','done.txt']); cp.execFileSync('git',['commit','-m','worker edit']);`+final);
 const result=await call(root,{target:path.relative(root,dir),tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false});
 const entry=result.details.worktrees[0];
 assert.equal(result.details.items[0].status,'ok');
 assert.equal(git(dir,'rev-parse','HEAD'),head);
 assert.equal(entry.baseCommit,head);
 assert.equal(entry.commits,1);
 assert.equal(entry.head,git(dir,'rev-parse',entry.branch));
 assert.ok(fs.existsSync(entry.path));
 assert.equal(git(entry.path,'show','HEAD:done.txt'),'ok');
 assert.equal(git(dir,'status','--porcelain'),'');
 assert.match(result.content[0].text,/not merged/);
 for(const value of [entry.branch,entry.path,entry.head,'1 commit']) assert.ok(result.content[0].text.includes(value));
});

test('target and chain boundaries fail before creating branches', async()=>{
 const dir=repo();
 const tasks=[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}];
 await assert.rejects(()=>call(root,{target:dir,chain:tasks}),/chain worktrees/);
 await assert.rejects(()=>call(root,{target:dir,agent:'scout',task:'fixture'}),/target requires/);
 await assert.rejects(()=>call(dir,{target:'..',tasks}),/outside/);
 git(dir,'branch','-m','main');
 for(const params of [{tasks},{target:'.',tasks}]) await assert.rejects(()=>call(dir,params),/feature branch/);
 git(dir,'checkout','--detach');
 await assert.rejects(()=>call(root,{target:dir,tasks}),/detached/);
 assert.equal(git(dir,'branch','--list','dispatch/*'),'');
});

test('a thrown spawn does not strand a slow sibling or remove either worktree', async()=>{
 const dir=repo();
 fake(`console.log(JSON.stringify({type:'agent_start'})); setTimeout(()=>{${final}},300);`);
 const result=await call(dir,{tasks:[
  {agent:'writer',task:'invalid\u0000argument',model:'fake/model',worktree:true},
  {agent:'writer',task:'slow',model:'fake/model',worktree:true},
 ],aggregate:false});
 assert.deepEqual(result.details.items.map((r:any)=>r.status),['error','ok']);
 assert.equal(result.details.worktrees.length,2);
 for(const entry of result.details.worktrees) assert.ok(fs.existsSync(entry.path));
});

test('spawn diagnostics return codes without leaking paths or stderr secrets', async()=>{
 process.env.PI_DISPATCH_PI_BIN=path.join(root,'missing-private-binary');
 const missing=await runWorkerProc(agent,'fixture',{cwd:root});
 assert.match(missing.error!,/ENOENT/);
 assert.ok(!missing.error!.includes(root));
 fake(`console.error('password=very-private ERR_MODULE_NOT_FOUND'); process.exit(3);`);
 const failed=await runWorkerProc(agent,'fixture',{cwd:root});
 assert.match(failed.error!,/ERR_MODULE_NOT_FOUND/);
 assert.ok(!failed.error!.includes('very-private'));
 fake(`process.stderr.write('private ENOENT\\nERR_MODULE_'); setTimeout(()=>{process.stderr.write('NOT_FOUND private');process.exit(3)},50);`);
 const split=await runWorkerProc(agent,'fixture',{cwd:root});
 assert.match(split.error!,/ERR_MODULE_NOT_FOUND/);
 assert.ok(!split.error!.includes('private'));
 assert.ok(!('startupFailure' in missing));
});

test('silent startup is bounded, but healthy slow children are not timed out', async(t)=>{
 const previous=process.env.PI_DISPATCH_STARTUP_TIMEOUT_MS;
 t.after(()=>{if(previous===undefined) delete process.env.PI_DISPATCH_STARTUP_TIMEOUT_MS; else process.env.PI_DISPATCH_STARTUP_TIMEOUT_MS=previous;});
 process.env.PI_DISPATCH_STARTUP_TIMEOUT_MS='1000';
 fake(`setInterval(()=>{},1000);`);
 const timed=await runWorkerProc(agent,'fixture',{cwd:root,modelOverride:'anthropic/claude-opus-5-5'});
 assert.equal(timed.status,'error'); assert.match(timed.error!,/did not start/); assert.equal(timed.attempts,1);
 fake(`console.log(JSON.stringify({type:'agent_start'})); setTimeout(()=>{${final}},1500);`);
 assert.equal((await runWorkerProc(agent,'fixture',{cwd:root})).status,'ok');
});

for(const detached of [false,true]) test(`changed worker branch is not ready and reports the real commit (detached=${detached})`,async()=>{
 const dir=repo(),base=git(dir,'rev-parse','HEAD');
 fake(`const fs=require('fs'),cp=require('child_process'); cp.execFileSync('git',${JSON.stringify(detached?['checkout','--detach']:['switch','-c','worker-other'])}); fs.writeFileSync('rescue.txt','valuable'); cp.execFileSync('git',['add','--','rescue.txt']); cp.execFileSync('git',['commit','-m','preserve me']);`+final);
 const result=await call(dir,{tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false});
 const entry=result.details.worktrees[0];
 assert.equal(result.details.items[0].status,'error');
 assert.equal(entry.status,'error');
 assert.notEqual(entry.head,base);
 assert.equal(git(entry.path,'rev-parse','HEAD'),entry.head);
 assert.equal(git(dir,'show',`${entry.head}:rescue.txt`),'valuable');
 assert.match(result.content[0].text,/not ready/);
 assert.match(result.content[0].text,/preserve the reported HEAD/);
 assert.ok(fs.existsSync(entry.path));
});

test('aborted dispatch returns the retained worktree handoff',async()=>{
 const dir=repo(),marker=path.join(root,'abort-started');
 fake(`require('fs').writeFileSync(${JSON.stringify(marker)},'started'); console.log(JSON.stringify({type:'agent_start'})); setInterval(()=>{},1000);`);
 const controller=new AbortController();
 const pending=call(dir,{tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false},controller.signal);
 for(let i=0;i<150&&!fs.existsSync(marker);i++) await new Promise(r=>setTimeout(r,20));
 controller.abort();
 const result=await pending;
 assert.equal(result.details.items[0].status,'aborted');
 assert.equal(result.details.worktrees[0].status,'aborted');
 assert.ok(fs.existsSync(result.details.worktrees[0].path));
 assert.match(result.content[0].text,/aborted — not ready/);
});

test('a linked worktree of the session repository outside the cwd is an accepted target', async()=>{
 const dir=repo(); git(dir,'checkout','-q','-b','main');
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-linked-'));
 const wt=path.join(outside,'feat-x'); git(dir,'worktree','add','-q',wt,'-b','feat/x');
 const head=git(wt,'rev-parse','HEAD');
 fake(final);
 const result=await call(dir,{target:wt,tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false});
 assert.equal(result.details.items[0].status,'ok');
 assert.equal(result.details.worktrees[0].base,'feat/x');
 assert.equal(result.details.worktrees[0].baseCommit,head);
 await assert.rejects(()=>call(dir,{target:dir,tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false}),/check out a feature branch/);
});

test('a worktree of another repository outside the cwd is refused', async()=>{
 const dir=repo(), other=repo();
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-other-'));
 const wt=path.join(outside,'feat-y'); git(other,'worktree','add','-q',wt,'-b','feat/y');
 await assert.rejects(()=>call(dir,{target:wt,tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false}),/outside the session cwd/);
});
