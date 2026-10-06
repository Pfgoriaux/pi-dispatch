import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, parseConfig, request, socketPath, writerAgent } from '../src/durable/cli.ts';
import { formatReport, openBatch, policyHash, type BatchOwner, type PilotConfig } from '../src/durable/scheduler.ts';
import { processStartIdentity } from '../src/durable/store.ts';

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
 * Fake Pi. Behaviour per task id (parsed from the prompt): ok, slow, outside (commits outside owned paths), hang.
 * Logs start and end of each spawn for concurrency checks.
 */
function fakePi(behaviour: Record<string, string>) {
 const log = path.join(W, `spawns-${uid()}.log`);
 const bin = script('fake-pi', `
const fs=require('fs'),cp=require('child_process'),path=require('path');
const args=process.argv.slice(2), sid=args[args.indexOf('--session-id')+1], prompt=args[args.length-1];
const id=/task ([^ ]+)\\. You work/.exec(prompt)[1], mode=${JSON.stringify(behaviour)}[id]??'ok';
const log=(event)=>fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({event,id,pid:process.pid,at:Date.now(),prompt})+'\\n');
log('start');
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
const finish=()=>{log('end');out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',model:'fake',usage:${JSON.stringify(usage)}}});out({type:'agent_end',messages:[]});out({type:'agent_settled'});};
const commit=(file)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,id+' '+Date.now()+'\\n');cp.execFileSync('git',['add','--',file]);cp.execFileSync('git',['commit','-q','-m','worker '+id]);};
out({type:'session',version:3,id:sid,timestamp:new Date().toISOString(),cwd:process.cwd()});
setTimeout(()=>{
 if(mode==='hang') return setInterval(()=>{},1000);
 if(mode==='outside'){commit('docs/'+id+'.md');return finish();}
 setTimeout(()=>{commit('src/'+id+'.txt');finish();}, mode==='slow'?700:0);
},300);
`);
 const events = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
 const starts = (id?: string) => events().filter((e) => e.event === 'start' && (!id || e.id === id));
 return { bin, events, starts };
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
if(args[0]==='pr'&&args[1]==='list'){console.log(JSON.stringify(state.filter(p=>p.headRefName===opt('--head')&&p.baseRefName===opt('--base')).map(p=>({number:p.number,headRefName:p.headRefName,baseRefName:p.baseRefName,headRefOid:head(p.headRefName)}))));process.exit(0);}
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

const agent = writerAgent();
async function runBatch(cfg: PilotConfig, mode: 'run' | 'resume' = 'run', during?: (owner: BatchOwner) => Promise<void>) {
 const owner = await openBatch(cfg, { agent });
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
const waitFor = async (check: () => boolean, ms = 15_000) => {
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
 const owner = await openBatch(past, { agent });
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
 assert.equal(report.spentUsd, 1); assert.deepEqual(report.halted, []);
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
 assert.equal(report.spentUsd, 0.75);
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
 assert.equal(before.a.state, 'verified'); assert.equal(before.b.state, 'pending');
 assert.equal(pi.starts('b').length, 0);
 const second = await runBatch(cfg, 'resume');
 const after = byId(second.report);
 assert.deepEqual([after.a.state, after.b.state], ['pr-ready', 'pr-ready']);
 assert.equal(after.b.baseSha, before.a.headSha);
 assert.deepEqual([pi.starts('a').length, pi.starts('b').length], [1, 1]);
 // A changed configuration is a different policy and cannot reopen the store.
 await assert.rejects(openBatch({ ...cfg, spend: { ...cfg.spend, allowanceUsd: 11 } }, { agent }), /does not match/);
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
 assert.equal(tasks.b.state, 'verified'); assert.match(tasks.b.reason, /parent a has no draft pull request/);
 assert.deepEqual(effects.map((e) => [e.kind, e.status]), [['push', 'unresolved']]);
 assert.deepEqual(gh.calls(), []);
 const owner = await openBatch(cfg, { agent });
 try {
  await owner.attach();
  const refused = await owner.preflight();
  assert.match(refused.join('\n'), /push.*unresolved/);
 } finally { await owner.close(); }
 assert.equal(pi.starts().length, 2);
});

/** Run the CLI in its own process; resolves once its first worker has started. */
function owner(file: string) {
 const child = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'src/durable/cli.ts'), 'run', file], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
 let stdout = '', stderr = '';
 child.stdout.on('data', (chunk) => { stdout += chunk; });
 child.stderr.on('data', (chunk) => { stderr += chunk; });
 const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
 return { child, exited, output: () => ({ stdout, stderr }) };
}

test('cli: status and stop over the owner socket; a killed owner blocks resume', async () => {
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
 assert.match(run.output().stdout, /verified +a .*\n.*pending +b/);
 assert.equal(await request(sock, { op: 'status' }), undefined, 'no owner after exit');

 // Crash: the owner dies while its worker keeps running; resume must not start anything.
 const w2 = workspace();
 const cfg2 = config(w2, [{ id: 'h' }], pi.bin, gh.bin);
 const file2 = path.join(w2.ws, 'batch.json');
 fs.writeFileSync(file2, JSON.stringify(cfg2));
 const crash = owner(file2);
 await waitFor(() => pi.starts('h').length === 1, 30_000);
 const worker = pi.starts('h')[0].pid as number;
 leftovers.push(worker);
 await waitFor(() => fs.existsSync(socketPath(cfg2.store)));
 crash.child.kill('SIGKILL');
 await crash.exited;
 const resumed = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'src/durable/cli.ts'), 'resume', file2], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
 let stderr = '';
 resumed.stderr.on('data', (chunk) => { stderr += chunk; });
 const code = await new Promise((resolve) => resumed.on('exit', resolve));
 assert.equal(code, 2);
 assert.match(stderr, /h#1 is blocked: worker identity is alive/);
 assert.equal(pi.starts('h').length, 1);
 process.kill(worker, 'SIGKILL');
 fs.rmSync(socketPath(cfg2.store), { force: true }); // left by the killed owner
});
