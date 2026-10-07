import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, main, parseConfig, request, reviewerAgent, socketPath, writerAgent } from '../src/durable/cli.ts';
import { formatReport, openBatch, policyHash, type BatchOwner, type PilotConfig } from '../src/durable/scheduler.ts';
import { processStartIdentity } from '../src/durable/store.ts';
import { parseReview, pilotSessionId } from '../src/durable/supervisor.ts';
import { discoverAgents } from '../src/agents.ts';
import { batchesDir, registerDurableBatchTool } from '../src/tools/durable-batch.ts';

// Every repository, remote, store, fake Pi, and fake gh lives in this disposable workspace.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cli-')));
const envKeys = ['HERDR_ENV', 'PI_CODING_AGENT_DIR', 'LINKUP_API_KEY', 'PI_DISPATCH_PI_BIN', 'PI_DISPATCH_DEPTH'];
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const leftovers: number[] = [];
after(() => {
 for (const pid of leftovers) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
 for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
 fs.rmSync(W, { recursive: true, force: true });
});
process.env.HERDR_ENV = '0';
process.env.PI_CODING_AGENT_DIR = path.join(W, 'mock-config');
delete process.env.LINKUP_API_KEY;
delete process.env.PI_DISPATCH_DEPTH;
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

let n = 0;
const uid = () => `${++n}`;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } };
const ok = [[process.execPath, '-e', 'process.exit(0)']];

function script(name: string, body: string): string {
 const file = path.join(W, `${name}-${uid()}`);
 fs.writeFileSync(file, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
 return file;
}

/**
 * Fake Pi. Writes JSON events to stdout and a Pi 1.0.4-format session file to --session-dir.
 * Worker behaviour per task id: ok, slow, outside (commits outside owned paths), hang, stubborn (hangs, ignores SIGTERM), gate (waits for release()).
 * Reviewer behaviour per `<id>:review`: clean (default), runaway (streams thinking forever), blank, blank-once, block, block-once, unpriced, gate.
 * Logs start and end of each spawn for concurrency checks.
 */
function fakePi(behaviour: Record<string, string>) {
 const log = path.join(W, `spawns-${uid()}.log`);
 const gates = fs.mkdtempSync(path.join(W, 'gates-'));
 const bin = script('fake-pi', `
const fs=require('fs'),cp=require('child_process'),path=require('path');
const args=process.argv.slice(2), sid=args[args.indexOf('--session-id')+1], dir=args[args.indexOf('--session-dir')+1], prompt=args[args.length-1];
const review=/CODE REVIEW/.test(prompt), kind=review?'review':'work';
const id=review?/INTENT[^\\n]*\\ndo (\\S+)/.exec(prompt)[1]:/task ([^ ]+)\\. You work/.exec(prompt)[1];
const mode=${JSON.stringify(behaviour)}[review?id+':review':id]??(review?'clean':'ok');
const read=()=>fs.existsSync(${JSON.stringify(log)})?fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').map(l=>JSON.parse(l)):[];
const earlier=read().filter(e=>e.event==='start'&&e.id===id&&e.kind===kind).length;
const log=(event)=>fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({event,id,kind,pid:process.pid,at:Date.now(),prompt})+'\\n');
log('start');
const now=()=>new Date().toISOString();
const file=path.join(dir,now().replace(/[:.]/g,'-')+'_'+sid+'.jsonl');
const entry=(o)=>fs.appendFileSync(file,JSON.stringify(o)+'\\n');
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
out({type:'session',version:3,id:sid,timestamp:now(),cwd:process.cwd()});
entry({type:'session',version:3,id:sid,timestamp:now(),cwd:process.cwd()});
entry({type:'message',id:'u1',parentId:null,timestamp:now(),message:{role:'user',content:[{type:'text',text:'task'}]}});
const finish=(text='done',usage=${JSON.stringify(usage)})=>{const message={role:'assistant',content:[{type:'text',text}],stopReason:'stop',model:'fake',usage};out({type:'message_end',message});entry({type:'message',id:'a1',parentId:'u1',timestamp:now(),message});log('end');out({type:'agent_end',messages:[]});out({type:'agent_settled'});};
const commit=(f)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,id+' '+Date.now()+'\\n');cp.execFileSync('git',['add','--',f]);cp.execFileSync('git',['commit','-q','-m','worker '+id]);};
const blocker='## [blocker] Broken '+id+'\\n- File: src/'+id+'.txt:1\\n- Problem: wrong value\\n- Fix: correct it\\n';
const gate=(then)=>{const f=path.join(${JSON.stringify(gates)},kind+'-'+id);const t=setInterval(()=>{if(fs.existsSync(f)){clearInterval(t);then();}},50);};
const reviewer={runaway:()=>setInterval(()=>out({type:'message_update',assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta:'!'}}),20),blank:()=>finish(''),'blank-once':()=>finish(earlier===0?'':'No findings.'),clean:()=>finish('No findings.'),block:()=>finish(blocker),'block-once':()=>finish(earlier===0?blocker:'No findings.'),unpriced:()=>finish('No findings.',{...${JSON.stringify(usage)},cost:undefined}),gate:()=>gate(()=>finish('No findings.'))};
const work={ok:()=>{commit('src/'+id+'.txt');finish();},slow:()=>setTimeout(()=>{commit('src/'+id+'.txt');finish();},700),outside:()=>{commit('docs/'+id+'.md');finish();},hang:()=>setInterval(()=>{},1000),stubborn:()=>{process.on('SIGTERM',()=>{});setInterval(()=>{},1000);},gate:()=>gate(()=>{commit('src/'+id+'.txt');finish();})};
setTimeout(()=>(review?reviewer:work)[mode](),300);
`);
 const events = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
 const starts = (id?: string, kind = 'work') => events().filter((e) => e.event === 'start' && e.kind === kind && (!id || e.id === id));
 const release = (id: string, kind = 'work') => fs.writeFileSync(path.join(gates, `${kind}-${id}`), '');
 return { bin, events, starts, reviews: (id?: string) => starts(id, 'review'), release };
}

/** Fake gh backed by a JSON file; PR heads follow the bare remote like GitHub. */
function fakeGh(bare: string) {
 const state = path.join(W, `gh-state-${uid()}.json`);
 const log = path.join(W, `gh-log-${uid()}`);
 const bin = script('fake-gh', `
const fs=require('fs'),cp=require('child_process');
const args=process.argv.slice(2), opt=(n)=>args[args.indexOf(n)+1];
const state=fs.existsSync(${JSON.stringify(state)})?JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')):[];
const head=(b)=>{try{return cp.execFileSync('git',['-C',${JSON.stringify(bare)},'rev-parse','--verify','refs/heads/'+b],{encoding:'utf8'}).trim()}catch{return '0'.repeat(40)}};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args[0]==='pr'&&args[1]==='list'){console.log(JSON.stringify(state.filter(p=>p.headRefName===opt('--head')).map(p=>({state:p.state??'OPEN',isDraft:p.isDraft??true,number:p.number,headRefName:p.headRefName,baseRefName:p.baseRefName,headRefOid:head(p.headRefName)}))));process.exit(0);}
if(args[0]==='pr'&&args[1]==='create'&&args.includes('--draft')){state.push({number:state.length+1,headRefName:opt('--head'),baseRefName:opt('--base')});fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(state));console.log('https://example.invalid/pull/'+state.length);process.exit(0);}
process.exit(2);
`);
 const calls = (): string[][] => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
 const prs = (): { number: number; headRefName: string; baseRefName: string }[] => fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : [];
 return { bin, calls, prs };
}

/** Workspace repo on a feature branch plus a bare allowlisted remote. */
function workspace() {
 const ws = path.join(W, `ws-${uid()}`);
 const repo = path.join(ws, 'proj');
 const bare = path.join(ws, 'remote.git');
 const hooks = path.join(ws, 'hooks');
 fs.mkdirSync(repo, { recursive: true });
 fs.mkdirSync(hooks);
 git(repo, 'init', '-q', '-b', 'main');
 for (const [key, value] of [['user.name', 'Dispatch Test'], ['user.email', 'dispatch-test@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', hooks]]) git(repo, 'config', key, value);
 fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
 git(repo, 'add', '.');
 git(repo, 'commit', '-q', '-m', 'fixture');
 git(repo, 'checkout', '-q', '-b', 'feat/pilot');
 execFileSync('git', ['init', '-q', '--bare', bare]);
 git(repo, 'remote', 'add', 'origin', bare);
 git(repo, 'push', '-q', 'origin', 'feat/pilot');
 return { ws, repo, bare };
}

type Spec = { id: string; dependencies?: string[] };
function config(w: ReturnType<typeof workspace>, tasks: Spec[], pi: string, gh: string, extra: { maxWorkers?: number; deadlineMs?: number; url?: string } = {}): PilotConfig {
 return {
  batch: { id: 'b1', tasks: tasks.map((t) => ({ id: t.id, dependencies: t.dependencies ?? [], ownedFiles: ['src/'], checks: ok, prompt: `do ${t.id}` })) },
  spend: { allowanceUsd: 10, reservations: Object.fromEntries(tasks.map((t) => [t.id, 1])) },
  limits: { maxWorkers: extra.maxWorkers ?? 3, maxAttemptsPerTask: 2, deadline: new Date(Date.now() + (extra.deadlineMs ?? 120_000)).toISOString() },
  store: path.join(w.ws, 'store.sqlite'),
  repo: { root: w.repo, baseBranch: 'feat/pilot', worktreesRoot: path.join(w.ws, '.worktrees'), sessionsRoot: path.join(w.ws, 'sessions'), branchPrefix: 'pilot/b1' },
  worker: { piExecutable: pi, model: 'fake/model', thinking: 'off' },
  publication: { remote: 'origin', url: extra.url ?? w.bare, repo: 'owner/proj', gh },
 };
}

const agents = { agent: writerAgent(), reviewer: reviewerAgent() };
const agent = agents.agent;
async function runBatch(cfg: PilotConfig, mode: 'run' | 'resume' = 'run', during?: (owner: BatchOwner) => Promise<void>) {
 const owner = await openBatch(cfg, agents);
 try {
  if (mode === 'run') await owner.create(); else await owner.attach();
  assert.deepEqual(await owner.preflight(), []);
  const running = owner.execute();
  await during?.(owner);
  const report = await running;
  return { report, effects: (await owner.store.read()).effects, attempts: (await owner.store.read()).attempts };
 } finally { await owner.close(); }
}
const byId = (report: { tasks: readonly { id: string }[] }) => Object.fromEntries(report.tasks.map((t) => [t.id, t])) as Record<string, any>;
/** Waits for an event the test guarantees; the bound only catches hangs. */
const waitFor = async (check: () => boolean, ms = 60_000) => {
 const until = Date.now() + ms;
 while (!check()) { if (Date.now() > until) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
};

test('config: missing inputs, caps, deadline, and spend fail closed', () => {
 const w = workspace();
 const valid = config(w, [{ id: 'a' }, { id: 'b', dependencies: ['a'] }], '/bin/pi', '/bin/gh');
 assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(valid))), valid);
 const broken = (mutate: (c: any) => void, pattern: RegExp) => {
  const c = JSON.parse(JSON.stringify(valid));
  mutate(c);
  assert.throws(() => parseConfig(c), (e: unknown) => e instanceof ConfigError && pattern.test(e.message));
 };
 broken((c) => { delete c.batch; }, /batch must be an object/);
 broken((c) => { c.batch.tasks = []; }, /batch.tasks must be a non-empty array/);
 broken((c) => { delete c.batch.tasks[0].checks; }, /checks must be a non-empty array/);
 broken((c) => { c.batch.tasks[0].ownedFiles = ['../x']; }, /repository-relative/);
 broken((c) => { c.batch.tasks[0].dependencies = ['b']; }, /cycle/);
 broken((c) => { c.batch.tasks[1].dependencies = ['zz']; }, /invalid dependency/);
 broken((c) => { delete c.spend; }, /spend must be an object/);
 broken((c) => { delete c.spend.reservations.b; }, /reservations.b must be a positive/);
 broken((c) => { c.spend.allowanceUsd = 1.5; }, /exceeds spend.allowanceUsd/);
 broken((c) => { delete c.limits.deadline; }, /deadline must be an absolute/);
 broken((c) => { c.limits.deadline = '2026-07-01T06:00:00'; }, /with a zone/);
 broken((c) => { c.limits.maxWorkers = 4; }, /maxWorkers must be an integer from 1 to 3/);
 broken((c) => { c.limits.maxAttemptsPerTask = 3; }, /from 1 to 2/);
 broken((c) => { delete c.publication; }, /publication must be an object/);
 broken((c) => { c.worker.model = 'fast'; }, /exact provider\/id/);
 broken((c) => { c.worker.piExecutable = 'pi'; }, /absolute path/);
 // The policy hash covers every input, so a resume with changed inputs is refused by the store.
 assert.notEqual(policyHash(valid), policyHash({ ...valid, limits: { ...valid.limits, maxWorkers: 2 } }));
 assert.match(agent.systemPrompt, /Commits on the assigned branch are authorized/);
 assert.deepEqual(agents.reviewer.tools, ['read', 'grep', 'find', 'ls'], 'the reviewer gets no edit, write, or shell tool');
 assert.doesNotMatch(agent.systemPrompt, /authorization for.*merge-back/);
});

test('cli: missing configuration and past deadlines start nothing', async () => {
 const w = workspace();
 const cli = (args: string[]) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'src/durable/cli.ts'), ...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code) => resolve({ code, stderr }));
 });
 assert.equal((await cli(['run'])).code, 64);
 const missing = await cli(['run', path.join(w.ws, 'missing.json')]);
 assert.equal(missing.code, 1); assert.match(missing.stderr, /Cannot read batch configuration/);
 const file = path.join(w.ws, 'past.json');
 const past = config(w, [{ id: 'a' }], fakePi({}).bin, '/bin/gh', { deadlineMs: -60_000 });
 fs.writeFileSync(file, JSON.stringify(past));
 const late = await cli(['run', file]);
 assert.equal(late.code, 1); assert.match(late.stderr, /Deadline must be in the future/);
 const owner = await openBatch(past, agents);
 try { assert.equal(await owner.rootId(), undefined); assert.equal((await owner.store.read()).policy, undefined); } finally { await owner.close(); }
});

test('scheduler: stacked dependencies, worker cap, PR-ready report, no merges', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'slow', b: 'slow', c: 'slow', d: 'slow' });
 const gh = fakeGh(w.bare);
 const feature = git(w.repo, 'rev-parse', 'feat/pilot');
 const cfg = config(w, [{ id: 'a' }, { id: 'b', dependencies: ['a'] }, { id: 'c' }, { id: 'd' }], pi.bin, gh.bin, { maxWorkers: 2 });
 const { report } = await runBatch(cfg);
 const tasks = byId(report);
 assert.equal(report.phase, 'finished');
 assert.deepEqual(report.tasks.map((t) => t.state), ['pr-ready', 'pr-ready', 'pr-ready', 'pr-ready']);
 // Four attempts and four clean reviews at $0.25 each.
 assert.equal(report.spentUsd, 2); assert.deepEqual(report.halted, []);
 assert.equal(pi.reviews().length, 4);
 assert.ok(report.tasks.every((t) => t.review?.status === 'done' && t.review.blocking === 0));
 // b started from a's verified head, and its draft PR is stacked on a's branch.
 assert.equal(tasks.b.baseSha, tasks.a.headSha); assert.equal(tasks.b.parent, 'a');
 assert.equal(tasks.a.baseSha, feature);
 assert.equal(git(w.repo, 'rev-parse', `${tasks.b.headSha}^`), tasks.a.headSha);
 const prs = gh.prs();
 assert.deepEqual(prs.map((p) => [p.headRefName, p.baseRefName]), [
  [tasks.a.branch, 'feat/pilot'], [tasks.b.branch, tasks.a.branch], [tasks.c.branch, 'feat/pilot'], [tasks.d.branch, 'feat/pilot'],
 ]);
 for (const t of report.tasks) assert.equal(git(w.bare, 'rev-parse', `refs/heads/${t.branch}`), t.headSha);
 assert.ok(gh.calls().filter((c) => c[1] === 'create').every((c) => c.includes('--draft')));
 assert.equal(git(w.repo, 'rev-parse', 'feat/pilot'), feature, 'nothing merged into the base branch');
 assert.equal(git(w.bare, 'rev-parse', 'refs/heads/feat/pilot'), feature);
 // Never more than two workers at once.
 const events = pi.events().sort((x, y) => x.at - y.at);
 let live = 0, peak = 0;
 for (const e of events) { live += e.event === 'start' ? 1 : -1; peak = Math.max(peak, live); }
 assert.equal(peak, 2); assert.equal(pi.starts().length, 4);
 // Reviews read the task diff from its base: b's review covers only b's commit.
 assert.match(pi.reviews('b')[0].prompt, /task\.diff/);
 const bodies = gh.calls().filter((c) => c[1] === 'create').map((c) => c[c.indexOf('--body') + 1]);
 assert.ok(bodies.every((body) => /Automatic read-only review of the diff from the base to this head: 0 validated blocking, 0 other findings\./.test(body)));
 // Workers get constraints only; the report carries no prompts or transcripts.
 assert.match(pi.starts('b')[0].prompt, /starts from the verified work of task a at [0-9a-f]{40}/);
 assert.doesNotMatch(formatReport(report), /do a|done/);
});

test('scheduler: a failed dependency blocks dependents and attempts stop at two', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'outside' });
 const gh = fakeGh(w.bare);
 const { report } = await runBatch(config(w, [{ id: 'a' }, { id: 'b', dependencies: ['a'] }, { id: 'c' }], pi.bin, gh.bin));
 const tasks = byId(report);
 assert.equal(tasks.a.state, 'failed'); assert.equal(tasks.a.attempts, 2); assert.match(tasks.a.reason, /outside owned paths/);
 assert.equal(tasks.b.state, 'blocked'); assert.match(tasks.b.reason, /dependency a is not verified/);
 assert.equal(tasks.c.state, 'pr-ready');
 assert.equal(pi.starts('a').length, 2); assert.equal(pi.starts('b').length, 0);
 assert.equal(report.spentUsd, 1, 'two failed attempts of a, plus c and its review');
});

test('scheduler: the deadline cancels running work and blocks the rest', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'hang' });
 const gh = fakeGh(w.bare);
 const { report, attempts } = await runBatch(config(w, [{ id: 'a' }, { id: 'b', dependencies: ['a'] }], pi.bin, gh.bin, { deadlineMs: 4000 }));
 const tasks = byId(report);
 assert.equal(tasks.a.state, 'failed'); assert.equal(tasks.a.reason, 'deadline exceeded'); assert.equal(tasks.a.attempts, 1);
 assert.equal(tasks.b.state, 'blocked');
 assert.equal(report.spentUsd, null, 'a killed worker has unknown spend');
 assert.match(report.halted.join('\n'), /a#1 has unknown spend/);
 const worker = attempts.find((a) => a.key === 'a#1')!.worker!;
 assert.notEqual(await processStartIdentity(worker.pid), worker.startedAt);
 assert.deepEqual(gh.calls(), []);
});

test('restart: a drained stop resumes from the store without duplicate spawns', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'slow' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }, { id: 'b', dependencies: ['a'] }], pi.bin, gh.bin);
 const first = await runBatch(cfg, 'run', async (owner) => {
  await waitFor(() => pi.starts('a').length === 1);
  await owner.stop();
 });
 const before = byId(first.report);
 assert.equal(first.report.phase, 'running');
 // a's attempt finished, but its review waits for the resume.
 assert.equal(before.a.state, 'pending'); assert.equal(before.b.state, 'pending');
 assert.equal(pi.reviews('a').length, 0);
 assert.equal(pi.starts('b').length, 0);
 const second = await runBatch(cfg, 'resume');
 const after = byId(second.report);
 assert.deepEqual([after.a.state, after.b.state], ['pr-ready', 'pr-ready']);
 assert.equal(after.b.baseSha, first.attempts.find((x) => x.key === 'a#1')!.headSha);
 assert.deepEqual([pi.starts('a').length, pi.starts('b').length], [1, 1]);
 assert.deepEqual([pi.reviews('a').length, pi.reviews('b').length], [1, 1]);
 // A changed configuration is a different policy and cannot reopen the store.
 await assert.rejects(openBatch({ ...cfg, spend: { ...cfg.spend, allowanceUsd: 11 } }, agents), /does not match/);
});

test('offline publication keeps verified work, reports it, and refuses an ambiguous resume', async () => {
 const w = workspace();
 const offline = path.join(w.ws, 'offline.git');
 git(w.repo, 'remote', 'set-url', 'origin', offline);
 const pi = fakePi({});
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }, { id: 'b', dependencies: ['a'] }], pi.bin, gh.bin, { url: offline });
 const { report, effects } = await runBatch(cfg);
 const tasks = byId(report);
 assert.equal(tasks.a.state, 'verified'); assert.match(tasks.a.reason, /publication blocked: push/);
 assert.equal(tasks.b.state, 'verified'); assert.match(tasks.b.reason, /not published yet/);
 assert.deepEqual(effects.map((e) => [e.kind, e.status]), [['push', 'unresolved']]);
 assert.deepEqual(gh.calls(), []);
 const owner = await openBatch(cfg, agents);
 try {
  await owner.attach();
  const refused = await owner.preflight();
  assert.match(refused.join('\n'), /push.*unresolved/);
 } finally { await owner.close(); }
 assert.equal(pi.starts().length, 2);
});

test('publication: transient failed push stays resumable without repeating workers', async () => {
 const w = workspace();
 const pi = fakePi({});
 const gh = fakeGh(w.bare);
 const hook = path.join(git(w.repo, 'config', 'core.hooksPath'), 'pre-push');
 fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
 const cfg = config(w, [{ id: 'a' }, { id: 'b' }], pi.bin, gh.bin);
 const first = await runBatch(cfg);
 assert.equal(first.report.phase, 'running', formatReport(first.report));
 assert.match(byId(first.report).a.reason, /publication blocked/);
 fs.rmSync(hook);
 const resumed = await runBatch(cfg, 'resume');
 assert.deepEqual(resumed.report.tasks.map(t => t.state), ['pr-ready', 'pr-ready']);
 assert.equal(pi.starts().length, 2);
 assert.equal(gh.prs().length, 2);
});

test('IPC client refuses symlinked private directory', async () => {
 const dir = path.join(W, `ipc-${uid()}`);
 const link = path.join(W, `ipc-link-${uid()}`);
 fs.mkdirSync(dir, { mode: 0o700 });
 fs.symlinkSync(dir, link);
 await assert.rejects(request(path.join(link, 'owner.sock'), { op: 'stop', cancel: true }), /private directory/);
});

/** Run the CLI in its own process. */
function owner(file: string, mode: 'run' | 'resume' = 'run', env: NodeJS.ProcessEnv = {}) {
 const child = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'src/durable/cli.ts'), mode, file], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
 let stdout = '', stderr = '';
 child.stdout.on('data', (chunk) => { stdout += chunk; });
 child.stderr.on('data', (chunk) => { stderr += chunk; });
 const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
 return { child, exited, output: () => ({ stdout, stderr }) };
}

test('cli: terminal hangup cancels its owned worker', async () => {
 const w = workspace();
 const pi = fakePi({ h: 'hang' });
 const cfg = config(w, [{ id: 'h' }], pi.bin, fakeGh(w.bare).bin);
 const file = path.join(w.ws, 'hangup.json');
 fs.writeFileSync(file, JSON.stringify(cfg));
 const run = owner(file);
 await waitFor(() => pi.starts('h').length === 1, 30_000);
 const pid = pi.starts('h')[0].pid;
 leftovers.push(pid);
 const identity = await processStartIdentity(pid);
 run.child.kill('SIGHUP');
 await run.exited;
 assert.notEqual(await processStartIdentity(pid), identity);
});

test('cli: status and stop over the owner socket', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'slow', h: 'hang' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }, { id: 'b', dependencies: ['a'] }], pi.bin, gh.bin);
 const file = path.join(w.ws, 'batch.json');
 fs.writeFileSync(file, JSON.stringify(cfg));
 const sock = socketPath(cfg.store);
 const run = owner(file);
 await waitFor(() => pi.starts('a').length === 1, 30_000);
 await waitFor(() => fs.existsSync(sock));
 const live = await request(sock, { op: 'status' });
 assert.equal(live?.ok, true); assert.equal((live?.owner as any).pid, run.child.pid);
 assert.equal((fs.statSync(sock).mode & 0o077), 0);
 assert.equal((await request(sock, { op: 'stop', cancel: false }))?.stopping, true);
 assert.equal(await run.exited, 0);
 assert.match(run.output().stdout, /pending +a .*\n.*pending +b/);
 assert.equal(await request(sock, { op: 'status' }), undefined, 'no owner after exit');
});

test('review: validated blocking findings get one fix attempt from the reviewed head', async () => {
 const w = workspace();
 const pi = fakePi({ 'a:review': 'block-once' });
 const gh = fakeGh(w.bare);
 const { report, attempts } = await runBatch(config(w, [{ id: 'a' }], pi.bin, gh.bin));
 const a = byId(report).a;
 assert.equal(a.state, 'pr-ready'); assert.equal(a.attempts, 2);
 assert.deepEqual(a.review, { status: 'done', blocking: 0, other: 0 });
 assert.deepEqual([pi.starts('a').length, pi.reviews('a').length], [2, 2]);
 const [first, fix] = attempts.filter((x) => x.taskKey === 'a');
 assert.deepEqual([first.review?.blocking, fix.baseSha], [1, first.headSha], 'the fix starts from the reviewed head');
 assert.equal(a.headSha, fix.headSha); assert.equal(a.baseSha, first.baseSha);
 assert.match(pi.starts('a')[1].prompt, /starts from your previous verified commit [0-9a-f]{40}[\s\S]*## \[blocker\] Broken a/);
 assert.equal(report.spentUsd, 1);
 assert.equal(gh.prs().length, 1);
});

test('review: findings that survive the fix stay on the verified task and in the PR body', async () => {
 const w = workspace();
 const pi = fakePi({ 'a:review': 'block' });
 const gh = fakeGh(w.bare);
 const { report } = await runBatch(config(w, [{ id: 'a' }], pi.bin, gh.bin));
 const a = byId(report).a;
 assert.equal(a.state, 'verified'); assert.equal(a.pr?.number, 1); assert.match(a.reason, /1 unresolved blocking review finding$/);
 assert.deepEqual([a.attempts, pi.starts('a').length, pi.reviews('a').length], [2, 2, 2], 'one fix attempt, never a third');
 const body = gh.calls().find((c) => c[1] === 'create')!;
 assert.match(body[body.indexOf('--body') + 1], /1 validated blocking, 0 other findings[\s\S]*## \[blocker\] Broken a/);
 assert.match(formatReport(report), /review 1 blocking, 0 other/);
 assert.doesNotMatch(formatReport(report), /Broken a/, 'the morning report carries counts, not reviewer text');
});

test('review: unknown review spend halts publication; a tight budget skips the review', async () => {
 const w = workspace();
 const pi = fakePi({ 'a:review': 'unpriced' });
 const gh = fakeGh(w.bare);
 const { report } = await runBatch(config(w, [{ id: 'a' }], pi.bin, gh.bin));
 assert.equal(report.spentUsd, null);
 assert.match(report.halted.join('\n'), /review of a#1 has unknown spend/);
 assert.equal(byId(report).a.state, 'verified'); assert.deepEqual(gh.prs(), []);

 const w2 = workspace();
 const tight = config(w2, [{ id: 'a' }], pi.bin, fakeGh(w2.bare).bin);
 const capped = { ...tight, spend: { allowanceUsd: 1, reservations: { a: 1 } } };
 // The review never fits the allowance: the task is never published, on the first run or on resume.
 for (const mode of ['run', 'resume'] as const) {
  const { report: skipped } = await runBatch(capped, mode);
  assert.equal(skipped.phase, 'running', formatReport(skipped));
  assert.deepEqual(byId(skipped).a.review, { status: 'skipped', blocking: 0, other: 0 });
  assert.equal(byId(skipped).a.state, 'verified'); assert.match(byId(skipped).a.reason, /^review pending: review would exceed the budget/);
 }
 assert.deepEqual([pi.starts('a').length, pi.reviews('a').length], [2, 1], 'one worker per batch; only the first batch\'s unpriced review spawned');
});

test('review: a budget-skipped review pauses the batch; resume reviews the same head and publishes once', async () => {
 const w = workspace();
 const pi = fakePi({ b: 'gate' });
 const gh = fakeGh(w.bare);
 // a's review needs 1 more on top of a's spend and b's reservation (2.25 > 2) until b finishes.
 const cfg = { ...config(w, [{ id: 'a' }, { id: 'b' }], pi.bin, gh.bin), spend: { allowanceUsd: 2, reservations: { a: 1, b: 1 } } };
 const first = await runBatch(cfg, 'run', async (owner) => {
  const skipped = async () => (await owner.store.read()).attempts.find((x) => x.key === 'a#1')?.review?.status === 'skipped';
  while (!await skipped()) await new Promise((r) => setTimeout(r, 25));
  pi.release('b');
 });
 assert.equal(first.report.phase, 'running', formatReport(first.report));
 const a1 = byId(first.report).a;
 assert.equal(a1.state, 'verified'); assert.match(a1.reason, /^review pending: review would exceed the budget/);
 assert.deepEqual([gh.prs().length, pi.reviews().length], [0, 0], 'nothing is published or reviewed before resume');
 // On resume both reviews claim together; one may not fit beside the other's reservation and pause again.
 let resumed = await runBatch(cfg, 'resume');
 for (let extra = 0; resumed.report.phase !== 'finished' && extra < 2; extra++) {
  assert.ok(gh.prs().length === 0 && resumed.report.tasks.every((t) => t.state !== 'pr-ready'), 'nothing publishes while a review is pending');
  resumed = await runBatch(cfg, 'resume');
 }
 assert.deepEqual(resumed.report.tasks.map((t) => t.state), ['pr-ready', 'pr-ready'], formatReport(resumed.report));
 assert.equal(byId(resumed.report).a.headSha, a1.headSha, 'the same head is reviewed');
 assert.deepEqual([pi.starts('a').length, pi.starts('b').length, pi.reviews('a').length, pi.reviews('b').length, gh.prs().length], [1, 1, 1, 1, 2]);
 assert.equal(resumed.report.spentUsd, 1);
});

test('review: a blocker counts only when it cites a changed file', () => {
 const text = '## [blocker] A\n- File: `src/a.ts:3`\n## [blocker] B\n- File: docs/x.md:1\n## [minor] C\n- File: src/a.ts:9\n';
 assert.deepEqual(parseReview(text, ['src/a.ts']), { blocking: 1, other: 2, findings: text.trim() });
 assert.deepEqual(parseReview('No findings.', ['src/a.ts']), { blocking: 0, other: 0, findings: null });
});

/** Resolves once `run` answers status with a report `ready` accepts; fails at once, with its stderr, if it exits. */
async function liveReport(run: ReturnType<typeof owner>, cfg: PilotConfig, ready: (report: any) => boolean = () => true) {
 let exited = false;
 run.exited.then(() => { exited = true; });
 for (;;) {
  if (exited) throw new Error(`owner exited before it was ready: ${run.output().stderr}`);
  const live = await request(socketPath(cfg.store), { op: 'status' }).catch(() => undefined);
  if (live?.ok && ready(live.report)) return live.report as any;
  await new Promise((r) => setTimeout(r, 25));
 }
}

/**
 * Start an owner, wait until its store records the worker of the first `kind`
 * spawn of `id`, then SIGKILL the owner. Killing before that commit would leave
 * an unrecorded worker, which recovery rightly blocks. Returns the worker PID.
 */
async function crashOwner(file: string, cfg: PilotConfig, pi: ReturnType<typeof fakePi>, id: string, kind = 'work') {
 const run = owner(file);
 await waitFor(() => pi.starts(id, kind).length === 1, 60_000);
 const worker = pi.starts(id, kind)[0].pid as number;
 leftovers.push(worker);
 await liveReport(run, cfg, (report) => report.tasks.some((t: any) => t.id === id && t.worker === worker));
 run.child.kill('SIGKILL');
 await run.exited;
 fs.rmSync(socketPath(cfg.store), { force: true }); // left by the killed owner
 return worker;
}

function batchFile(w: ReturnType<typeof workspace>, cfg: PilotConfig) {
 const file = path.join(w.ws, `batch-${uid()}.json`);
 fs.writeFileSync(file, JSON.stringify(cfg));
 return file;
}

async function exitOf(pid: number, identity: string | null | undefined) {
 const until = Date.now() + 30_000;
 while (await processStartIdentity(pid) === identity) {
  if (Date.now() > until) throw new Error('worker did not exit');
  await new Promise((r) => setTimeout(r, 50));
 }
}

test('recovery: SIGKILL while the worker runs; resume waits for it and publishes once', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'gate' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }], pi.bin, gh.bin);
 const file = batchFile(w, cfg);
 const worker = await crashOwner(file, cfg, pi, 'a');
 assert.ok(await processStartIdentity(worker), 'the worker outlives its owner');
 const resumed = owner(file, 'resume');
 const live = await liveReport(resumed, cfg);
 assert.deepEqual([live.tasks[0].state, live.tasks[0].worker], ['running', worker]);
 pi.release('a');
 assert.equal(await resumed.exited, 0, resumed.output().stderr);
 assert.match(resumed.output().stdout, /pr-ready +a \(1 attempt, \$0\.50\)/);
 assert.deepEqual([pi.starts('a').length, pi.reviews('a').length, gh.prs().length], [1, 1, 1]);
});

test('recovery: a worker that finished while its owner was dead is judged from its session files', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'gate' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }, { id: 'b', dependencies: ['a'] }], pi.bin, gh.bin);
 const file = batchFile(w, cfg);
 const worker = await crashOwner(file, cfg, pi, 'a');
 const identity = await processStartIdentity(worker);
 pi.release('a');
 await exitOf(worker, identity);
 const resumed = owner(file, 'resume');
 assert.equal(await resumed.exited, 0, resumed.output().stderr);
 assert.match(resumed.output().stdout, /pr-ready +a [\s\S]*pr-ready +b/);
 assert.deepEqual([pi.starts('a').length, pi.starts('b').length, gh.prs().length], [1, 1, 2]);
 assert.match(resumed.output().stdout, /Spend reported by workers: \$1\.00/);
});

test('recovery: missing or inconsistent session evidence keeps the attempt blocked', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'gate' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }], pi.bin, gh.bin);
 const file = batchFile(w, cfg);
 const worker = await crashOwner(file, cfg, pi, 'a');
 const identity = await processStartIdentity(worker);
 pi.release('a');
 await exitOf(worker, identity);
 const dir = path.join(cfg.repo.sessionsRoot, pilotSessionId(cfg.batch.id, 'a#1'));
 for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) fs.rmSync(path.join(dir, name));
 const resumed = owner(file, 'resume');
 assert.equal(await resumed.exited, 0, resumed.output().stderr);
 assert.match(resumed.output().stdout, /blocked +a .*expected one Pi session file/);
 assert.match(resumed.output().stdout, /a#1 has unknown spend/);
 const again = owner(file, 'resume');
 assert.equal(await again.exited, 2);
 assert.match(again.output().stderr, /a#1 is blocked/);
 assert.deepEqual([pi.starts('a').length, pi.reviews('a').length, gh.prs().length], [1, 0, 0]);
});

test('recovery: an adopted worker that ignores SIGTERM is killed at the deadline with unknown spend', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'stubborn' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }], pi.bin, gh.bin, { deadlineMs: 12_000 });
 const file = batchFile(w, cfg);
 const worker = await crashOwner(file, cfg, pi, 'a');
 const identity = await processStartIdentity(worker);
 const resumed = owner(file, 'resume');
 assert.equal(await resumed.exited, 0, resumed.output().stderr);
 assert.notEqual(await processStartIdentity(worker), identity);
 assert.match(resumed.output().stdout, /failed +a \(1 attempt, unknown\).*deadline exceeded/);
 assert.deepEqual([pi.starts('a').length, gh.prs().length], [1, 0]);
});

test('recovery: a review interrupted by an owner crash is adopted, not repeated', async () => {
 const w = workspace();
 const pi = fakePi({ 'a:review': 'gate' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }], pi.bin, gh.bin);
 const file = batchFile(w, cfg);
 const reviewer = await crashOwner(file, cfg, pi, 'a', 'review');
 assert.ok(await processStartIdentity(reviewer), 'the reviewer outlives its owner');
 const resumed = owner(file, 'resume');
 assert.equal((await liveReport(resumed, cfg)).tasks[0].worker, reviewer);
 pi.release('a', 'review');
 assert.equal(await resumed.exited, 0, resumed.output().stderr);
 assert.match(resumed.output().stdout, /pr-ready +a .*review clean/);
 assert.deepEqual([pi.starts('a').length, pi.reviews('a').length, gh.prs().length], [1, 1, 1]);
});

/** The registered durable_batch tool and a context whose confirm answers are scripted. */
function batchTool() {
 let tool: any;
 registerDurableBatchTool({ registerTool: (t: unknown) => { tool = t; } } as any);
 const asked: string[] = [];
 const ctx = (hasUI: boolean, answer: boolean) => ({ hasUI, ui: { confirm: async (title: string, message: string) => { asked.push(`${title}\n${message}`); return answer; } } });
 const call = async (params: object, context = ctx(true, true)) => (await tool.execute('id', params, undefined, undefined, context)).content[0].text as string;
 return { call, ctx, asked };
}

test('roster: the commit-authorized durable writer is not a dispatch role', () => {
 const { byName } = discoverAgents({ cwd: W, isProjectTrusted: () => false } as any);
 assert.ok(byName.has('reviewer'));
 assert.equal(byName.has('durable-writer'), false);
 assert.equal(writerAgent().name, 'durable-writer', 'the pilot still loads it directly');
});

test('durable_batch: drafts are validated and saved privately', async () => {
 const w = workspace();
 const { call } = batchTool();
 const invalid = await call({ action: 'draft', config: { batch: { id: 'x' } } });
 assert.match(invalid, /Invalid batch configuration/);
 const cfg = config(w, [{ id: 'a' }], '/bin/pi', '/bin/gh');
 const saved = await call({ action: 'draft', config: { ...cfg, batch: { ...cfg.batch, id: `draft-${uid()}` } } });
 const file = /Draft saved: (\S+)/.exec(saved)![1];
 assert.equal(path.dirname(file), batchesDir());
 assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(batchesDir()).mode & 0o777, 0o700);
 assert.match(saved, /Tasks \(1\):\n- a; owns src\/\n  checks: ".*node" "-e" "process.exit\(0\)"\n  prompt: do a/);
 fs.writeFileSync(cfg.store, '');
 assert.match(await call({ action: 'draft', config: cfg }), /already has a store/);
 assert.match(await call({ action: 'launch', id: '../etc' }).catch((e) => String(e)), /must name a drafted batch/);
});

test('durable_batch: launch is refused without a UI, inside workers, and when the user declines', async () => {
 const w = workspace();
 const pi = fakePi({});
 const cfg = config(w, [{ id: 'a' }], pi.bin, fakeGh(w.bare).bin);
 const id = `refuse-${uid()}`;
 const { call, ctx, asked } = batchTool();
 await call({ action: 'draft', config: { ...cfg, batch: { ...cfg.batch, id } } });
 assert.match(await call({ action: 'launch', id }, ctx(false, true)), /Launch refused: this session has no interactive UI/);
 process.env.PI_DISPATCH_DEPTH = '1';
 try { assert.match(await call({ action: 'launch', id }), /Launch refused: workers cannot launch/); } finally { delete process.env.PI_DISPATCH_DEPTH; }
 assert.equal(asked.length, 0, 'refusals never ask');
 assert.match(await call({ action: 'launch', id }, ctx(true, false)), /declined by the user; nothing started/);
 assert.equal(asked.length, 1);
 assert.equal(fs.existsSync(cfg.store), false); assert.equal(pi.starts().length, 0);
});

test('durable_batch: an approved launch starts exactly one owner; status and stop use its socket', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'gate' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }], pi.bin, gh.bin);
 const id = `launch-${uid()}`;
 const { call, asked } = batchTool();
 await call({ action: 'draft', config: { ...cfg, batch: { ...cfg.batch, id } } });
 const launched = await call({ action: 'launch', id });
 assert.match(launched, /Approved\. Owner pid \d+ is running and answers status/);
 const owner = Number(/pid (\d+)/.exec(launched)![1]);
 leftovers.push(owner);
 for (const shown of [`Batch: ${id} (run), policy sha256:`, `Repository: ${w.repo}`, '- a; owns src/', `Worker: ${JSON.stringify(pi.bin)}, model fake/model`, 'Spend allowance: $10', `Deadline: ${cfg.limits.deadline}`, `Publication: draft PRs on owner/proj via origin (${w.bare}) with ${gh.bin}`, `Store: ${cfg.store}`]) {
  assert.ok(asked[0].includes(shown), shown);
 }
 assert.match(await call({ action: 'launch', id }), /already has a live owner/);
 assert.equal(asked.length, 1, 'a live owner is never asked about twice');
 await waitFor(() => pi.starts('a').length === 1, 30_000);
 assert.match(await call({ action: 'status', id }), /running +a/);
 assert.match(await call({ action: 'stop', id }), /Draining/);
 pi.release('a');
 await exitOf(owner, await processStartIdentity(owner));
 const log = fs.readFileSync(path.join(batchesDir(), `${id}.log`), 'utf8');
 assert.match(log, /Batch launch-\d+: running/);
 assert.equal(fs.statSync(path.join(batchesDir(), `${id}.log`)).mode & 0o777, 0o600);
 assert.match(await call({ action: 'status', id }), /No live owner/);
 assert.equal(pi.starts('a').length, 1);
});

test('recovery: a reserved slot keeps an adopted worker from starving other tasks at maxWorkers 1', async () => {
 const w = workspace();
 const pi = fakePi({ a: 'gate' });
 const gh = fakeGh(w.bare);
 // Durable order p, c, a: a takes the only slot between p's attempt and p's review, so p's review is pending at the crash.
 const cfg = config(w, [{ id: 'c', dependencies: ['p'] }, { id: 'p' }, { id: 'a' }], pi.bin, gh.bin, { maxWorkers: 1 });
 const file = batchFile(w, cfg);
 await crashOwner(file, cfg, pi, 'a');
 assert.equal(pi.reviews('p').length, 0);
 const resumed = owner(file, 'resume');
 await liveReport(resumed, cfg);
 // Give an unreserved scheduler time to hand the only slot to p's review; the assertion below does not depend on it.
 await new Promise((r) => setTimeout(r, 1500));
 pi.release('a');
 assert.equal(await resumed.exited, 0, resumed.output().stderr);
 const aEnded = pi.events().find((e) => e.event === 'end' && e.id === 'a' && e.kind === 'work').at;
 assert.ok(pi.reviews('p')[0].at > aEnded, "p's review starts only after the adopted worker freed its slot");
 assert.match(resumed.output().stdout, /Tasks: 3 pr-ready/);
 assert.deepEqual([pi.starts('a').length, pi.starts('p').length, pi.starts('c').length, pi.reviews('p').length], [1, 1, 1, 1]);
});

test('review: a failed or unstartable review pauses the batch unpublished; resume retries it for the same head', async () => {
 // Reviewer answers blank once, then reviews normally.
 const w = workspace();
 const pi = fakePi({ 'a:review': 'blank-once' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }], pi.bin, gh.bin);
 const first = await runBatch(cfg);
 assert.equal(first.report.phase, 'running'); assert.deepEqual(first.report.halted, []);
 assert.equal(byId(first.report).a.state, 'verified'); assert.match(byId(first.report).a.reason, /^review pending: blank response/);
 assert.equal(gh.prs().length, 0);
 const resumed = await runBatch(cfg, 'resume');
 assert.equal(byId(resumed.report).a.state, 'pr-ready', formatReport(resumed.report));
 assert.deepEqual([pi.starts('a').length, pi.reviews('a').length, gh.prs().length], [1, 2, 1]);
 assert.equal(resumed.report.spentUsd, 0.75, 'the failed review\'s spend is kept');

 // A review that cannot start (an earlier spawn's session directory exists) spends nothing and is retried in a new session.
 const w2 = workspace();
 const gh2 = fakeGh(w2.bare);
 const cfg2 = config(w2, [{ id: 'b' }], pi.bin, gh2.bin);
 fs.mkdirSync(path.join(cfg2.repo.sessionsRoot, pilotSessionId(cfg2.batch.id, 'b#1/review')), { recursive: true });
 const stuck = await runBatch(cfg2);
 assert.match(byId(stuck.report).b.reason, /^review pending: review did not start/); assert.equal(gh2.prs().length, 0);
 const retried = await runBatch(cfg2, 'resume');
 assert.equal(byId(retried.report).b.state, 'pr-ready', formatReport(retried.report));
 assert.deepEqual([pi.reviews('b').length, gh2.prs().length], [1, 1]);
 assert.equal(retried.report.spentUsd, 0.5);
});

test('cli: a configuration changed after approval starts nothing', async () => {
 const w = workspace();
 const pi = fakePi({});
 const cfg = config(w, [{ id: 'a' }], pi.bin, fakeGh(w.bare).bin);
 const file = batchFile(w, cfg);
 const approved = policyHash(cfg);
 fs.writeFileSync(file, JSON.stringify({ ...cfg, spend: { ...cfg.spend, allowanceUsd: 9 } }));
 const errors: string[] = [];
 const code = await main(['run', file, `--expect-hash=${approved}`], { out: () => undefined, err: (t) => errors.push(t), json: false });
 assert.equal(code, 1); assert.match(errors.join('\n'), /changed after approval; nothing started/);
 assert.equal(fs.existsSync(cfg.store), false); assert.equal(pi.starts().length, 0);
});

test('review: a runaway reviewer is stopped at its time limit and halts with unknown spend, unpublished', async () => {
 const w = workspace();
 const pi = fakePi({ 'a:review': 'runaway' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }], pi.bin, gh.bin);
 const owner = await openBatch(cfg, { ...agents, reviewTimeLimitMs: 3000 });
 let report;
 try { await owner.create(); report = await owner.execute(); } finally { await owner.close(); }
 const a = byId(report).a;
 assert.equal(a.state, 'blocked', formatReport(report)); assert.match(a.reason, /review of a#1 is failed: review exceeded its 3 s time limit/);
 assert.match(report.halted.join('\n'), /review of a#1 has unknown spend/);
 const reviewer = pi.reviews('a')[0].pid;
 assert.equal(await processStartIdentity(reviewer), null, 'the runaway reviewer is gone');
 assert.deepEqual([pi.reviews('a').length, gh.prs().length], [1, 0]);
});

test('recovery: an adopted runaway reviewer is stopped at the limit counted from its start', async () => {
 const w = workspace();
 const pi = fakePi({ 'a:review': 'runaway' });
 const gh = fakeGh(w.bare);
 const cfg = config(w, [{ id: 'a' }], pi.bin, gh.bin);
 const file = batchFile(w, cfg);
 const reviewer = await crashOwner(file, cfg, pi, 'a', 'review');
 const identity = await processStartIdentity(reviewer);
 const resumed = owner(file, 'resume', { PI_DISPATCH_DURABLE_REVIEW_LIMIT_MS: '4000' });
 assert.equal(await resumed.exited, 0, resumed.output().stderr);
 assert.notEqual(await processStartIdentity(reviewer), identity);
 assert.match(resumed.output().stdout, /blocked +a .*review exceeded its 4 s time limit/);
 assert.deepEqual([pi.starts('a').length, pi.reviews('a').length, gh.prs().length], [1, 1, 0]);
});
