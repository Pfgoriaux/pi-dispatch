import test, { after } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree, removeWorktree, pruneStale, assertCleanTree, ensureGitignore } from '../src/worktree.ts';
import { mergeWorktreeBranches } from '../src/merge.ts';
import { runWorkerProc } from '../src/worker-proc.ts';
import extension from '../src/index.ts';

// All Git writes and fake children are confined to this disposable fixture.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-write-tier-'));
const envKeys = ['HERDR_ENV', 'PI_CODING_AGENT_DIR', 'LINKUP_API_KEY', 'PI_DISPATCH_PI_BIN', 'PI_DISPATCH_DEPTH'];
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
after(() => {
 for (const [key, value] of savedEnv) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
 }
 fs.rmSync(root, {recursive:true, force:true});
});
process.env.HERDR_ENV = '0';
process.env.PI_CODING_AGENT_DIR = path.join(root, 'mock-config');
delete process.env.LINKUP_API_KEY;
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, {recursive:true});
const tools: any[] = [];
extension({on() {}, registerTool(tool: any) { tools.push(tool); }} as any);
const dispatch = tools.find(t=>t.name==='dispatch');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
function repo() {
 const dir=fs.mkdtempSync(path.join(root,'repo-'));
 git(dir,'init','-b','main'); git(dir,'config','user.name','Dispatch Test'); git(dir,'config','user.email','dispatch-test@example.invalid');
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
const agent:any={name:'writer',description:'test',tools:['read','edit','write','bash'],systemPrompt:'test',source:'bundled',filePath:''};
const ctx=(cwd:string)=>({cwd,isProjectTrusted:()=>false}) as any;
const call=(cwd:string,params:any,signal?:AbortSignal)=>dispatch.execute('test', {...params,herdr:false},signal,undefined,ctx(cwd));

test('reject invalid dispatch inputs before launching workers', async()=>{
 const dir=repo();
 for(const params of [{},{agent:'nonexistent',task:'x'},{tasks:Array.from({length:9},()=>({agent:'scout',task:'x'}))},{chain:Array.from({length:9},()=>({agent:'scout',task:'x'}))},{tasks:[{agent:'scout',task:'x'}],chain:[{agent:'scout',task:'x'}]},{resume:'missing',task:'x'},{tasks:[{agent:'writer',task:'x',worktree:true,cwd:'.'}]}]) await assert.rejects(()=>call(dir,params));
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
test('real parallel branches merge disjoint edits; cleanup leaves clean parent',async()=>{
 const dir=repo(), a=await createWorktree(dir,'run','a'), b=await createWorktree(dir,'run','b');
 commit(a.path,'a.txt','alpha\n'); commit(b.path,'b.txt','beta\n');
 const result=await mergeWorktreeBranches(dir,[a.branch,b.branch]); assert.deepEqual(result.failed,[]); assert.equal(result.merged.length,2);
 for(const w of [a,b]) await removeWorktree(dir,w.path,{branch:w.branch});
 assert.equal(git(dir,'status','--porcelain'),''); assert.equal(fs.readFileSync(path.join(dir,'a.txt'),'utf8'),'alpha\n'); assert.equal(fs.readFileSync(path.join(dir,'b.txt'),'utf8'),'beta\n');
 assert.equal(git(dir,'worktree','list','--porcelain').split('worktree ').length-1,1);
});
test('first-use gitignore bookkeeping completes and parent ends clean',async()=>{
 const dir=repo(); git(dir,'rm','.gitignore'); git(dir,'commit','-m','remove ignore'); ensureGitignore(dir);
 const w=await createWorktree(dir,'run','a'); commit(w.path,'a.txt','alpha'); const result=await mergeWorktreeBranches(dir,[w.branch]);
 assert.equal(result.merged.length,1); await removeWorktree(dir,w.path,{branch:w.branch}); assert.equal(git(dir,'status','--porcelain'),'');
});
async function conflicted() {
 const dir=repo(), w=await createWorktree(dir,'run','a'); commit(w.path,'shared.txt','worker\n'); commit(dir,'shared.txt','parent\n'); return {dir,w};
}
test('conflict resolution uses real git with simulated merge worker',async()=>{
 const {dir,w}=await conflicted(); fake(`require('fs').writeFileSync('shared.txt','parent\\nworker\\n');`+final);
 const result=await mergeWorktreeBranches(dir,[w.branch]); assert.deepEqual(result.failed,[]); assert.equal(result.merged.length,1);
 assert.equal(fs.readFileSync(path.join(dir,'shared.txt'),'utf8'),'parent\nworker\n'); assert.equal(git(dir,'status','--porcelain'),'');
 await removeWorktree(dir,w.path,{branch:w.branch});
});
test('unresolved conflict markers abort merge and preserve parent',async()=>{
 const {dir,w}=await conflicted(), head=git(dir,'rev-parse','HEAD'); fake(final);
 const result=await mergeWorktreeBranches(dir,[w.branch]); assert.equal(result.merged.length,0); assert.match(result.failed[0].error,/markers remain/);
 assert.equal(git(dir,'rev-parse','HEAD'),head); assert.equal(git(dir,'status','--porcelain'),''); await removeWorktree(dir,w.path,{deleteBranch:false});
});
test('pre-aborted merge performs no commits',async()=>{
 const dir=repo(), w=await createWorktree(dir,'run','a'); commit(w.path,'a.txt','a'); const head=git(dir,'rev-parse','HEAD');
 const result=await mergeWorktreeBranches(dir,[w.branch],{signal:AbortSignal.abort()}); assert.equal(result.merged.length,0); assert.equal(git(dir,'rev-parse','HEAD'),head); await removeWorktree(dir,w.path,{deleteBranch:false});
});
test('failed writer committed branch is kept but not merged',async()=>{
 const dir=repo(),head=git(dir,'rev-parse','HEAD');
 fake(`const fs=require('fs'),cp=require('child_process'); fs.writeFileSync('broken.txt','broken'); cp.execFileSync('git',['add','broken.txt']); cp.execFileSync('git',['commit','-m','broken fixture']); process.exit(1);`);
 const result=await call(dir,{tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false});
 assert.equal(result.details.items[0].status,'error'); const kept=git(dir,'branch','--list','dispatch/*').trim(); assert.equal(git(dir,'show',`${kept}:broken.txt`),'broken'); assert.equal(git(dir,'rev-parse','HEAD'),head); assert.ok(!fs.existsSync(path.join(dir,'broken.txt')));
 assert.match(git(dir,'branch','--list','dispatch/*'),/dispatch\//); assert.equal(git(dir,'worktree','list','--porcelain').split('worktree ').length-1,1);
});
test('SAFETY: successful writer without commit must not lose its edits',async()=>{
 const dir=repo(); git(dir,'config','status.showUntrackedFiles','no');
 fake(`require('fs').writeFileSync('valuable.txt','uncommitted work');`+final);
 const result=await call(dir,{tasks:[{agent:'writer',task:'fixture',model:'fake/model',worktree:true}],aggregate:false});
 assert.equal(result.details.items[0].status, 'error');
 assert.equal(result.details.merges.merged.length, 0);
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
