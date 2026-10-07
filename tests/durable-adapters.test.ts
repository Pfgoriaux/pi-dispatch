import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { putAttempt } from '../src/durable/contracts.ts';
import { readEvidence } from '../src/durable/evidence.ts';
import { runEffect } from '../src/durable/reconcile.ts';
import { openDurableStore, processStartIdentity } from '../src/durable/store.ts';
import { pilotSessionId, Supervisor, SupervisorBlockedError, type SupervisorOptions } from '../src/durable/supervisor.ts';
import { runPilotProc } from '../src/worker-proc.ts';

// Every repository, remote, store, fake Pi, and fake gh lives in this disposable workspace.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-adapters-')));
const envKeys = ['HERDR_ENV', 'PI_CODING_AGENT_DIR', 'LINKUP_API_KEY', 'PI_DISPATCH_PI_BIN', 'PI_DISPATCH_DURABLE_STORE', 'PI_SESSION_ID', 'PI_DISPATCH_DEPTH'];
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
after(() => {
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
const agent: any = { name: 'writer', description: 'test', tools: ['read', 'edit', 'write', 'bash'], systemPrompt: 'test', source: 'bundled', filePath: '' };
const identity = { batchId: 'batch-a', policyHash: 'sha256:a' };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } };

function script(name: string, body: string): string {
 const file = path.join(W, `${name}-${uid()}`);
 fs.writeFileSync(file, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
 return file;
}

/** Fake Pi: logs its spawn, echoes the requested session ID, then runs `body` after a startup delay. */
function fakePi(body: string, sessionExpr = 'sid', log = path.join(W, `spawns-${uid()}.log`)) {
 const bin = script('fake-pi', `
const fs=require('fs'),cp=require('child_process');
const args=process.argv.slice(2), sid=args[args.indexOf('--session-id')+1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,args,store:process.env.PI_DISPATCH_DURABLE_STORE??null,parent:process.env.PI_SESSION_ID??null})+'\\n');
const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
const finish=(text='done')=>{out({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop',model:'fake',usage:${JSON.stringify(usage)}}});out({type:'agent_end',messages:[]});out({type:'agent_settled'});};
const commit=(file,text)=>{fs.mkdirSync(require('path').dirname(file),{recursive:true});fs.writeFileSync(file,text);cp.execFileSync('git',['add','--',file]);cp.execFileSync('git',['commit','-q','-m','worker '+file]);};
const after=(file,then)=>{const t=setInterval(()=>{if(fs.existsSync(file)){clearInterval(t);then();}},20);};
out({type:'session',version:3,id:${sessionExpr},timestamp:new Date().toISOString(),cwd:process.cwd()});
setTimeout(()=>{${body}},300);
`);
 const spawns = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
 return { bin, spawns };
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
 git(bare, 'config', 'core.hooksPath', path.join(bare, 'hooks'));
 git(repo, 'remote', 'add', 'origin', bare);
 return { ws, repo, bare, hooks };
}

async function setup(admitted = { maxWorkers: 2, maxAttemptsPerTask: 2, budgetUsd: 10, tasks: [{ key: 't1', reserveUsd: 1 }, { key: 't2', reserveUsd: 1 }] }) {
 const w = workspace();
 const storePath = path.join(w.ws, 'store.sqlite');
 const store = await openDurableStore({ path: storePath, ...identity });
 await store.admit(admitted);
 const options = (extra: Partial<SupervisorOptions> = {}): SupervisorOptions => ({
  store, featureRoot: w.repo, featureBranch: 'feat/pilot', piExecutable: '/nonexistent', worktreesRoot: path.join(w.ws, '.worktrees'),
  sessionsRoot: path.join(w.ws, 'sessions'), branchPrefix: 'pilot/b1', allowlist: { remotes: [{ name: 'origin', url: w.bare }], bases: ['main'] }, ...extra,
 });
 return { ...w, storePath, store, options };
}

const task = (key: string, extra: object = {}) => ({ key, prompt: 'fixture', agent, model: 'fake/model', thinking: 'off', ownedPaths: ['src/'], ...extra });
const soon = (ms = 20_000) => ({ deadlineAt: Date.now() + ms });
const alive = async (pid: number, startedAt: string) => await processStartIdentity(pid) === startedAt;

test('pilot child: explicit executable, documented session flags, stripped coordinator env, one spawn', async () => {
 const dir = fs.mkdtempSync(path.join(W, 'child-'));
 const base = { cwd: dir, model: 'fake/model', thinking: 'off', sessionId: 'pd-test-1', sessionDir: path.join(dir, 's'), onSpawn: () => {} };
 const noFallback = fakePi(`process.exit(1);`);
 process.env.PI_DISPATCH_PI_BIN = noFallback.bin;
 for (const piExecutable of ['fake-pi', 'relative/pi', path.join(W, 'missing')]) {
  const refused = await runPilotProc(agent, 'x', { ...base, piExecutable });
  assert.equal(refused.status, 'error'); assert.equal(refused.launched, false); assert.match(refused.error!, /absolute Pi executable/);
 }
 assert.equal(noFallback.spawns().length, 0, 'PI_DISPATCH_PI_BIN is never used');
 // A model with fallback routes still gets exactly one spawn.
 const failed = await runPilotProc(agent, 'x', { ...base, sessionDir: path.join(dir, 's0'), model: 'anthropic/claude-opus-5-5', piExecutable: noFallback.bin });
 assert.equal(failed.status, 'error'); assert.equal(noFallback.spawns().length, 1);
 assert.equal(failed.settled, false);

 process.env.PI_DISPATCH_DURABLE_STORE = '/coordinator/store.sqlite';
 process.env.PI_SESSION_ID = 'parent-session';
 // The worker waits for its identity to be recorded, however slow `ps` is.
 const recorded = path.join(dir, 'recorded');
 const ok = fakePi(`after(${JSON.stringify(recorded)}, () => finish());`);
 const spawned: [number, string][] = [];
 const result = await runPilotProc(agent, '--looks-like-a-flag', { ...base, piExecutable: ok.bin, onSpawn: (pid, start) => { spawned.push([pid, start]); fs.writeFileSync(recorded, ''); } });
 delete process.env.PI_DISPATCH_DURABLE_STORE; delete process.env.PI_SESSION_ID;
 assert.equal(result.status, 'ok'); assert.equal(result.settled, true); assert.equal(result.sessionId, 'pd-test-1');
 assert.equal(result.usage?.cost.total, 0.25);
 const [record] = ok.spawns();
 assert.deepEqual(spawned, [[record.pid, result.spawned!.startIdentity]]);
 assert.equal(record.store, null); assert.equal(record.parent, null);
 const args: string[] = record.args;
 assert.deepEqual(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 4), ['--session-id', 'pd-test-1', '--session-dir', base.sessionDir]);
 assert.ok(!args.includes('--no-session'));
 assert.deepEqual(args.slice(-2), ['--', '--looks-like-a-flag']);
 // stdout is a file in the session directory, so the child survives a dead owner; a second spawn there is refused.
 assert.match(fs.readFileSync(path.join(base.sessionDir, 'events.log'), 'utf8'), /"type":"agent_settled"/);
 await assert.rejects(runPilotProc(agent, 'x', { ...base, piExecutable: ok.bin }), /EEXIST/);
 assert.equal(ok.spawns().length, 1);

 const wrongSession = fakePi('finish();', "'other'");
 const mismatch = await runPilotProc(agent, 'x', { ...base, sessionDir: path.join(dir, 's2'), piExecutable: wrongSession.bin });
 assert.equal(mismatch.status, 'error'); assert.match(mismatch.error!, /does not match/);
});

test('pilot child: an unrecorded identity stops the child', async () => {
 const dir = fs.mkdtempSync(path.join(W, 'child-'));
 const hang = fakePi('setInterval(()=>{},1000);');
 const result = await runPilotProc(agent, 'x', {
  cwd: dir, model: 'fake/model', thinking: 'off', sessionId: 'pd-test-2', sessionDir: path.join(dir, 's'), piExecutable: hang.bin,
  onSpawn: async () => { throw new Error('store unavailable'); },
 });
 assert.equal(result.status, 'error'); assert.match(result.error!, /not recorded: store unavailable/);
 assert.equal(result.launched, true);
 assert.equal(await alive(result.spawned!.pid, result.spawned!.startIdentity), false);
});

test('evidence: completion needs agent_settled and a session file that agrees with the event log', () => {
 const dir = fs.mkdtempSync(path.join(W, 'evidence-'));
 const sid = 'pd-ev';
 const message = (text: string, u: unknown = usage) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: u });
 const write = (file: string, lines: object[], torn = '') => fs.writeFileSync(path.join(dir, file), lines.map((l) => JSON.stringify(l)).join('\n') + '\n' + torn);
 const header = { type: 'session', version: 3, id: sid, timestamp: 't', cwd: dir };
 assert.match((readEvidence(dir, sid) as any).reason, /event log is missing/);
 write('events.log', [header, { type: 'message_end', message: message('done') }]);
 assert.deepEqual(readEvidence(dir, sid), { state: 'unsettled' });
 write('events.log', [header, { type: 'message_end', message: message('done') }, { type: 'agent_settled' }], '{"type":"tor');
 assert.match((readEvidence(dir, sid) as any).reason, /found 0/);
 write(`2026-01-01T00-00-00-000Z_${sid}.jsonl`, [header, { type: 'message', id: 'u', message: { role: 'user', content: 'x' } }]);
 assert.match((readEvidence(dir, sid) as any).reason, /0 assistant messages, event log 1/);
 write(`2026-01-01T00-00-00-000Z_${sid}.jsonl`, [header, { type: 'message', id: 'a', message: message('done') }]);
 assert.deepEqual(readEvidence(dir, sid), { state: 'settled', spentUsd: 0.25, text: 'done', problem: null });
 write(`2026-01-01T00-00-00-000Z_${sid}.jsonl`, [header, { type: 'message', id: 'a', message: message('', { ...usage, cost: undefined }) }]);
 assert.deepEqual(readEvidence(dir, sid), { state: 'settled', spentUsd: null, text: '', problem: 'blank response from child pi' });
 write(`2026-01-01T00-00-00-000Z_${sid}.jsonl`, [{ ...header, id: 'other' }]);
 assert.match((readEvidence(dir, sid) as any).reason, /another header/);
});

test('supervisor: success records identity and spend, stays in owned paths, retains work without merging', async () => {
 const s = await setup();
 try {
  // The worker finishes only after the store shows its identity, however slow `ps` is.
  const recorded = path.join(s.ws, 'recorded');
  const pi = fakePi(`after(${JSON.stringify(recorded)}, () => { commit('src/a.txt','a\\n'); finish(); });`);
  const supervisor = new Supervisor(s.options({ piExecutable: pi.bin }));
  const running = supervisor.runAttempt(task('t1', { checks: [[process.execPath, '-e', 'process.exit(0)']] }), soon());
  let settled = false;
  running.then(() => { settled = true; }, () => { settled = true; });
  while (!settled && !(await s.store.read()).attempts.find((a) => a.key === 't1#1')?.worker) await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(recorded, '');
  const done = await running;
  assert.equal(done.status, 'succeeded'); assert.equal(done.spentUsd, 0.25);
  assert.equal(done.worker?.pid, pi.spawns()[0].pid); assert.equal(done.worker?.host, os.hostname());
  assert.equal(done.worktree, path.join(s.ws, '.worktrees', 'proj', 'pilot-b1-t1-a1'));
  assert.equal(done.branch, 'pilot/b1/t1-a1');
  assert.equal(git(s.repo, 'rev-parse', 'pilot/b1/t1-a1'), done.headSha);
  assert.ok(fs.existsSync(path.join(s.ws, 'sessions', pilotSessionId(identity.batchId, 't1#1'))));
  await assert.rejects(supervisor.runAttempt(task('t1'), soon()), /succeeded/);

  assert.equal(git(s.repo, 'rev-parse', 'HEAD'), done.baseSha, 'parent never moves');
  assert.ok(fs.existsSync(done.worktree!), 'verified worktree retained');
  assert.equal(pi.spawns().length, 1);
 } finally { await s.store.close(); }
});

test('supervisor: a worker that exits before a slow ps reads it is judged, not blocked', async () => {
 const shim = fs.mkdtempSync(path.join(W, 'slow-ps-'));
 // A `ps -p PID` that answers only once PID is gone: the worker always exits before its identity is read.
 fs.writeFileSync(path.join(shim, 'ps'), '#!/bin/sh\nfor last; do :; done\ncase " $* " in *" -p "*) while kill -0 "$last" 2>/dev/null; do sleep 0.02; done;; esac\nexec /bin/ps "$@"\n', { mode: 0o700 });
 const savedPath = process.env.PATH;
 process.env.PATH = `${shim}${path.delimiter}${savedPath}`;
 const s = await setup();
 try {
   const pi = fakePi(`commit('src/a.txt','a\\n'); finish(); process.exit(0);`);
  const done = await new Supervisor(s.options({ piExecutable: pi.bin })).runAttempt(task('t1'), soon());
  assert.equal(done.status, 'succeeded', done.reason ?? '');
  assert.equal(done.spentUsd, 0.25);
  assert.equal(done.worker, null, 'no identity was recorded for the already-exited worker');
 } finally {
  process.env.PATH = savedPath;
  await s.store.close();
 }
});

test('supervisor: a slow ps on a loaded host still records a live worker', async () => {
 // Each ps takes longer than the former 2 s timeout, as on a heavily loaded Mac.
 const shim = fs.mkdtempSync(path.join(W, 'slow-ps-'));
 fs.writeFileSync(path.join(shim, 'ps'), '#!/bin/sh\nsleep 2.3\nexec /bin/ps "$@"\n', { mode: 0o700 });
 const savedPath = process.env.PATH;
 process.env.PATH = `${shim}${path.delimiter}${savedPath}`;
 const s = await setup();
 try {
  const recorded = path.join(s.ws, 'recorded');
  const pi = fakePi(`after(${JSON.stringify(recorded)}, () => { commit('src/a.txt','a\\n'); finish(); });`);
  const running = new Supervisor(s.options({ piExecutable: pi.bin })).runAttempt(task('t1'), soon(60_000));
  let settled = false;
  running.then(() => { settled = true; }, () => { settled = true; });
  while (!settled && !(await s.store.read()).attempts.find((a) => a.key === 't1#1')?.worker) await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(recorded, '');
  const done = await running;
  assert.equal(done.status, 'succeeded', done.reason ?? '');
  assert.equal(done.worker?.pid, pi.spawns()[0].pid);
 } finally {
  process.env.PATH = savedPath;
  await s.store.close();
 }
});

test('supervisor: an empty ps result after child exit does not invent a live worker', async () => {
 const shim = fs.mkdtempSync(path.join(W, 'exited-ps-'));
 // A PID can disappear while ps reads it: empty stdout with exit 0 is indeterminate, not proof of life.
 fs.writeFileSync(path.join(shim, 'ps'), '#!/bin/sh\nfor last; do :; done\nif ! kill -0 "$last" 2>/dev/null; then exit 0; fi\nexec /bin/ps "$@"\n', { mode: 0o700 });
 const savedPath = process.env.PATH;
 process.env.PATH = `${shim}${path.delimiter}${savedPath}`;
 const s = await setup();
 try {
  const pi = fakePi(`commit('src/a.txt','a'); finish();`);
  const result = await new Supervisor(s.options({ piExecutable: pi.bin })).runAttempt(task('t1'), soon());
  assert.equal(result.status, 'succeeded', result.reason ?? '');
  assert.equal(result.spentUsd, 0.25);
 } finally {
  process.env.PATH = savedPath;
  await s.store.close();
 }
});

test('supervisor: surviving process-group members still block an exited child', async () => {
 const s = await setup();
 const pidFile = path.join(s.ws, 'descendant.pid');
 try {
  const pi = fakePi(`const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));commit('src/a.txt','a');finish();`);
  const result = await new Supervisor(s.options({ piExecutable: pi.bin })).runAttempt(task('t1'), soon());
  assert.equal(result.status, 'blocked');
  assert.equal(result.spentUsd, null);
  assert.match(result.reason!, /process group is still running/);
 } finally {
  if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
  await s.store.close();
 }
});

test('supervisor: no-op output is not verified; stopped admission starts nothing', async () => {
 const s = await setup();
 try {
  const pi = fakePi('finish();');
  const supervisor = new Supervisor(s.options({ piExecutable: pi.bin }));
  await assert.rejects(supervisor.runAttempt(task('t1'), { ...soon(), canStart: () => false }), /Stopped before admission/);
  assert.equal(pi.spawns().length, 0);
  assert.equal((await s.store.read()).attempts.filter(a => a.status !== 'reserved').length, 0);
  const result = await supervisor.runAttempt(task('t1'), soon());
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'worker produced no commit');
 } finally { await s.store.close(); }
});

test('supervisor: owned paths, checks, retries, and retained dirty worktrees', async () => {
 const s = await setup();
 try {
  const outside = fakePi(`commit('docs/x.md','x'); finish();`);
  const first = await new Supervisor(s.options({ piExecutable: outside.bin })).runAttempt(task('t1'), soon());
  assert.equal(first.status, 'failed'); assert.match(first.reason!, /outside owned paths: docs\/x.md/); assert.equal(first.spentUsd, 0.25);

  const failingCheck = fakePi(`commit('src/b.txt','b'); finish();`);
  const second = await new Supervisor(s.options({ piExecutable: failingCheck.bin }))
   .runAttempt(task('t1', { checks: [[process.execPath, '-e', 'process.exit(3)']] }), soon());
  assert.equal(second.status, 'failed'); assert.match(second.reason!, /check failed/);
  await assert.rejects(new Supervisor(s.options({ piExecutable: failingCheck.bin })).runAttempt(task('t1'), soon()), /used all 2 attempts/);

  const dirty = fakePi(`fs.writeFileSync('src-uncommitted.txt','valuable'); finish();`);
  const kept = await new Supervisor(s.options({ piExecutable: dirty.bin })).runAttempt(task('t2'), soon());
  assert.equal(kept.status, 'failed'); assert.match(kept.reason!, /uncommitted edits/);
  assert.equal(fs.readFileSync(path.join(kept.worktree!, 'src-uncommitted.txt'), 'utf8'), 'valuable');
  assert.ok(fs.existsSync(kept.worktree!));
 } finally { await s.store.close(); }
});

test('supervisor: deadline is enforced without a client; unknown spend halts the batch', async () => {
 const s = await setup();
 try {
  const hang = fakePi('setInterval(()=>{},1000);');
  const supervisor = new Supervisor(s.options({ piExecutable: hang.bin }));
  const started = Date.now();
  const timedOut = await supervisor.runAttempt(task('t1'), { deadlineAt: Date.now() + 5000 });
  assert.ok(Date.now() - started < 20_000);
  assert.equal(timedOut.status, 'failed'); assert.equal(timedOut.reason, 'deadline exceeded'); assert.equal(timedOut.spentUsd, null);
  assert.equal(await alive(timedOut.worker!.pid, timedOut.worker!.startedAt), false);
  await assert.rejects(supervisor.runAttempt(task('t2'), soon()), /halted: t1#1 has unknown spend/);
  assert.equal(hang.spawns().length, 1);
  await assert.rejects(supervisor.runAttempt(task('t2'), { deadlineAt: Date.now() - 1 }), SupervisorBlockedError);
 } finally { await s.store.close(); }

 const c = await setup();
 try {
  const hang = fakePi('setInterval(()=>{},1000);');
  const controller = new AbortController();
  const running = new Supervisor(c.options({ piExecutable: hang.bin })).runAttempt(task('t1'), { ...soon(), signal: controller.signal });
  const waitUntil = Date.now() + 60_000; // hang guard; the spawn always happens
  while (hang.spawns().length === 0 && Date.now() < waitUntil) await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort();
  const cancelled = await running;
  assert.equal(cancelled.reason, 'cancelled'); assert.equal(cancelled.spentUsd, null);
  assert.equal(await alive(cancelled.worker!.pid, cancelled.worker!.startedAt), false);
 } finally { await c.store.close(); }
});

test('supervisor: spawn gaps fail closed', async () => {
 const s = await setup();
 const pi = fakePi('finish();');
 // Evidence of an earlier spawn (its session directory) blocks a second one.
 fs.mkdirSync(path.join(s.ws, 'sessions', pilotSessionId(identity.batchId, 't1#1')), { recursive: true });
 await assert.rejects(new Supervisor(s.options({ piExecutable: pi.bin })).runAttempt(task('t1'), soon()), /refusing a second spawn/);
 const blocked = (await s.store.read()).attempts.find((a) => a.key === 't1#1')!;
 assert.equal(blocked.status, 'blocked'); assert.equal(blocked.spentUsd, 0); assert.equal(pi.spawns().length, 0);
 // A crash after the intent commit and before the identity commit: running with no worker.
 await s.store.harness.commit((tx) => putAttempt(s.store.contracts, tx, { ...blocked, key: 't2#1', taskKey: 't2', status: 'running', worker: null, reason: null }), s.store.context);
 await s.store.close();
 const reopened = await openDurableStore({ path: s.storePath, ...identity });
 try {
  assert.deepEqual(reopened.recovery.blocked, ['t1#1', 't2#1']);
  await assert.rejects(new Supervisor({ ...s.options({ piExecutable: pi.bin }), store: reopened }).runAttempt(task('t2'), soon()), /halted/);
  assert.equal(pi.spawns().length, 0);
 } finally { await reopened.close(); }
});

test('supervisor: unknown pricing and check mutations cannot verify an attempt', async () => {
 for (const reported of [undefined, { ...usage, cost: undefined }, { ...usage, cost: { ...usage.cost, total: 0 } }]) {
  const s = await setup();
  try {
   const pi = fakePi(`out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop',usage:${JSON.stringify(reported) ?? 'undefined'}}});out({type:'agent_settled'});`);
   const supervisor = new Supervisor(s.options({ piExecutable: pi.bin }));
   const done = await supervisor.runAttempt(task('t1'), soon());
   assert.equal(done.spentUsd, null);
   await assert.rejects(supervisor.runAttempt(task('t2'), soon()), /unknown spend/);
  } finally { await s.store.close(); }
 }
 const s = await setup();
 try {
  const pi = fakePi(`commit('src/a.txt','a'); finish();`);
  const done = await new Supervisor(s.options({ piExecutable: pi.bin })).runAttempt(task('t1', {
   checks: [[process.execPath, '-e', "require('fs').writeFileSync('unchecked.txt','changed')"]],
  }), soon());
  assert.equal(done.status, 'failed');
  assert.match(done.reason!, /check mutated/);
  assert.ok(fs.existsSync(path.join(done.worktree!, 'unchecked.txt')));
 } finally { await s.store.close(); }
});

/** Fake gh backed by a JSON file; PR heads follow the bare remote like GitHub. */
function fakeGh(bare: string, afterCreate = '') {
 const state = path.join(W, `gh-state-${uid()}.json`);
 const log = path.join(W, `gh-log-${uid()}`);
 const bin = script('fake-gh', `
const fs=require('fs'),cp=require('child_process');
const args=process.argv.slice(2), opt=(n)=>args[args.indexOf(n)+1];
const state=fs.existsSync(${JSON.stringify(state)})?JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')):[];
const head=(b)=>{try{return cp.execFileSync('git',['-C',${JSON.stringify(bare)},'rev-parse','--verify','refs/heads/'+b],{encoding:'utf8'}).trim()}catch{return '0'.repeat(40)}};
fs.appendFileSync(${JSON.stringify(log)}, args[1]+'\\n');
if(args[0]==='pr'&&args[1]==='list'){console.log(JSON.stringify(state.filter(p=>p.headRefName===opt('--head')).map(p=>({state:p.state??'OPEN',isDraft:p.isDraft??true,number:p.number,headRefName:p.headRefName,baseRefName:p.baseRefName,headRefOid:p.headRefOid??head(p.headRefName)}))));process.exit(0);}
if(args[0]==='pr'&&args[1]==='create'&&args.includes('--draft')){state.push({number:state.length+1,headRefName:opt('--head'),baseRefName:opt('--base')});fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(state));${afterCreate};console.log('https://example.invalid/pull/'+state.length);process.exit(0);}
process.exit(2);
`);
 const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
 return { bin, state, calls };
}

const request = (bare: string) => ({ headSha: git(path.join(path.dirname(bare), 'proj'), 'rev-parse', 'HEAD'), remote: 'origin', url: bare, repo: 'owner/proj', base: 'main', title: 'Pilot', body: 'Draft' });

test('publication: closed, merged, retargeted and non-draft PRs block without creation', async () => {
 for (const override of [{ state: 'CLOSED' }, { state: 'MERGED' }, { isDraft: false }, { baseRefName: 'other' }]) {
  const s = await setup();
  try {
   const gh = fakeGh(s.bare);
   fs.writeFileSync(gh.state, JSON.stringify([{ number: 1, headRefName: 'feat/pilot', baseRefName: 'main', ...override }]));
   const result = await new Supervisor(s.options({ gh: gh.bin })).publish(request(s.bare));
   assert.equal(result.pullRequest?.status, 'blocked');
   assert.equal(gh.calls().filter(c => c === 'create').length, 0);
  } finally { await s.store.close(); }
 }
});

test('publication: uncertain PR create is never replayed from an empty listing', async () => {
 const s = await setup();
 try {
  let creates = 0;
  const intent = { key: 'create-once', attemptKey: 't1#1', kind: 'pull-request' as const, status: 'intended' as const, target: '{}', sha: 'a'.repeat(40), pr: null };
  const ops = { observe: async () => ({ state: 'absent' as const }), apply: async () => { creates++; throw new Error('connection lost'); } };
  assert.equal((await runEffect(s.store, intent, ops)).status, 'blocked');
  assert.equal((await runEffect(s.store, intent, ops)).status, 'blocked');
  assert.equal(creates, 1);
 } finally { await s.store.close(); }
});

test('publication: protected and unlisted targets are rejected before any effect', async () => {
 const s = await setup();
 try {
  const gh = fakeGh(s.bare);
  for (const featureBranch of ['main', 'master', 'production']) assert.throws(() => new Supervisor(s.options({ featureBranch })), /protected/);
  const supervisor = new Supervisor(s.options({ gh: gh.bin }));
  await assert.rejects(supervisor.publish({ ...request(s.bare), base: 'release' }), /not allowlisted/);
  await assert.rejects(supervisor.publish({ ...request(s.bare), remote: 'upstream' }), /not allowlisted/);
  await assert.rejects(supervisor.publish({ ...request(s.bare), url: path.join(W, 'elsewhere.git') }), /not allowlisted/);
  git(s.repo, 'remote', 'set-url', 'origin', path.join(W, 'retargeted.git'));
  await assert.rejects(supervisor.publish(request(s.bare)), /points at/);
  git(s.repo, 'remote', 'set-url', 'origin', s.bare);
  git(s.repo, 'config', 'remote.origin.pushurl', path.join(W, 'unapproved.git'));
  await assert.rejects(supervisor.publish(request(s.bare)), /unapproved/);
  git(s.repo, 'config', '--unset-all', 'remote.origin.pushurl');
  assert.throws(() => new Supervisor(s.options({ allowlist: { remotes: [{ name: 'origin', url: s.bare }], bases: ['main', 'feat/pilot'] } })), /protected/);
  assert.equal((await s.store.read()).effects.length, 0);
  assert.deepEqual(gh.calls(), []);
  assert.equal(git(s.bare, 'for-each-ref'), '');

  // Normal publication is idempotent and opens one draft PR whose head matches the pushed SHA.
  const sha = git(s.repo, 'rev-parse', 'HEAD');
  await assert.rejects(supervisor.publish({ ...request(s.bare), headSha: 'f'.repeat(40) }), /moved from verified head/);
  assert.equal((await s.store.read()).effects.length, 0);
  const first = await supervisor.publish(request(s.bare));
  assert.equal(first.push.status, 'applied');
  assert.deepEqual(first.pullRequest?.effect.pr, { repo: 'owner/proj', number: 1, headSha: sha });
  const again = await supervisor.publish(request(s.bare));
  assert.equal(again.pullRequest?.status, 'applied');
  assert.equal(gh.calls().filter((c) => c === 'create').length, 1);
  // A PR whose head differs from the recorded SHA blocks.
  const mismatch = fakeGh(s.bare);
  fs.writeFileSync(mismatch.state, JSON.stringify([{ number: 7, headRefName: 'feat/pilot', baseRefName: 'main', headRefOid: 'f'.repeat(40) }]));
  fs.writeFileSync(path.join(s.repo, 'shared.txt'), 'next\n'); git(s.repo, 'commit', '-q', '-am', 'next');
  const blocked = await new Supervisor(s.options({ gh: mismatch.bin })).publish(request(s.bare));
  assert.equal(blocked.push.status, 'applied'); assert.equal(blocked.pullRequest?.status, 'blocked');
  assert.match((blocked.pullRequest as any).reason, /#7 head/);
 } finally { await s.store.close(); }
});

/** Run `publish` in a separate process that the fixture kills mid-effect. */
async function crashingPublish(s: Awaited<ReturnType<typeof setup>>, gh: string, pidFile: string) {
 const file = path.join(W, `coordinator-${uid()}.mts`);
 const options = { ...s.options({ gh }), store: undefined };
 fs.writeFileSync(file, `
import fs from 'node:fs';
import { openDurableStore } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src/durable/store.ts')).href)};
import { Supervisor } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src/durable/supervisor.ts')).href)};
const store = await openDurableStore({ path: ${JSON.stringify(s.storePath)}, ...${JSON.stringify(identity)} });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
await new Supervisor({ ...${JSON.stringify(options)}, store }).publish(${JSON.stringify(request(s.bare))});
process.stdout.write('survived\\n');
`);
 const child = spawn(process.execPath, ['--import', 'tsx', file], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
 let stdout = '';
 child.stdout.on('data', (chunk) => { stdout += chunk; });
 const signal = await new Promise((resolve) => child.once('exit', (_code, sig) => resolve(sig)));
 assert.equal(signal, 'SIGKILL'); assert.equal(stdout, '');
}

test('publication crash windows reconcile from remote and PR identities', async () => {
 const s = await setup();
 await s.store.close();
 const sha = git(s.repo, 'rev-parse', 'HEAD');
 const pidFile = path.join(W, `coordinator-${uid()}.pid`);
 const kill = `process.kill(Number(fs.readFileSync(${JSON.stringify(pidFile)},'utf8')),'SIGKILL')`;

 // 1. Killed after the push reached the remote, before it was recorded.
 const receive = path.join(s.bare, 'hooks', 'post-receive');
 fs.writeFileSync(receive, `#!/bin/sh\nkill -9 "$(cat ${JSON.stringify(pidFile)})"\n`, { mode: 0o700 });
 const gh = fakeGh(s.bare);
 await crashingPublish(s, gh.bin, pidFile);
 fs.rmSync(receive);
 assert.equal(git(s.bare, 'rev-parse', 'refs/heads/feat/pilot'), sha);
 let store = await openDurableStore({ path: s.storePath, ...identity });
 assert.equal(store.recovery.unresolvedEffects.length, 1); assert.equal(store.recovery.halted, true);
 const report = await new Supervisor(s.options({ store, gh: gh.bin })).reconcile();
 assert.equal(report.applied.length, 1); assert.equal(report.halted, false);
 await store.close();

 // 2. Killed after the PR was created, before it was recorded.
 const ghCrash = fakeGh(s.bare, kill);
 await crashingPublish(s, ghCrash.bin, pidFile);
 store = await openDurableStore({ path: s.storePath, ...identity });
 assert.equal(store.recovery.halted, true);
 const prReport = await new Supervisor(s.options({ store, gh: ghCrash.bin })).reconcile();
 assert.equal(prReport.halted, false);
 const pr = (await store.read()).effects.find((e) => e.kind === 'pull-request')!;
 assert.deepEqual([pr.status, pr.pr], ['applied', { repo: 'owner/proj', number: 1, headSha: sha }]);
 await store.close();

 // 3. Killed after the intent was recorded, before the push left: reconcile proves it absent, the phase applies it.
 fs.writeFileSync(path.join(s.repo, 'shared.txt'), 'second\n'); git(s.repo, 'commit', '-q', '-am', 'second');
 const next = git(s.repo, 'rev-parse', 'HEAD');
 fs.writeFileSync(path.join(s.hooks, 'pre-push'), `#!/bin/sh\nkill -9 "$(cat ${JSON.stringify(pidFile)})"\nexit 1\n`, { mode: 0o700 });
 await crashingPublish(s, ghCrash.bin, pidFile);
 fs.rmSync(path.join(s.hooks, 'pre-push'));
 assert.equal(git(s.bare, 'rev-parse', 'refs/heads/feat/pilot'), sha);
 store = await openDurableStore({ path: s.storePath, ...identity });
 try {
  const absent = await new Supervisor(s.options({ store, gh: ghCrash.bin })).reconcile();
  assert.equal(absent.halted, true); assert.equal(absent.unresolved[0].state, 'absent');
  await assert.rejects(new Supervisor(s.options({ store })).runAttempt(task('t1'), soon()), /halted/);
  const published = await new Supervisor(s.options({ store, gh: ghCrash.bin })).publish(request(s.bare));
  assert.equal(published.push.status, 'applied'); assert.equal(published.pullRequest?.status, 'applied');
  assert.equal(git(s.bare, 'rev-parse', 'refs/heads/feat/pilot'), next);
  assert.equal(published.pullRequest?.effect.pr?.number, 1, 'existing PR adopted at the new head');
  assert.equal((await store.recover()).halted, false);
 } finally { await store.close(); }
});
