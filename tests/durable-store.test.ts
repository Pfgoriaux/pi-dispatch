import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
 assertNodeVersion, DurableCompatibilityError, DURABLE_PACKAGE_VERSIONS, loadDurableRuntime,
} from '../src/durable/compat.ts';
import { attemptKey, putAttempt, putEffect, type AttemptState } from '../src/durable/contracts.ts';
import {
 DurableStoreLockedError, DurableStoreMismatchError, openDurableStore, type DurableStore, ownerLockPath, workerIdentity,
} from '../src/durable/store.ts';

// Every store lives in this disposable directory; no model provider is configured.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-durable-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;
const storePath = () => path.join(root, `store-${++counter}.sqlite`);
const identity = { batchId: 'batch-1', policyHash: 'sha256:policy-1' };
const admission = { maxWorkers: 3, maxAttemptsPerTask: 2, budgetUsd: 10, tasks: [{ key: 't1', reserveUsd: 2 }, { key: 't2', reserveUsd: 3 }] };
/** Every task record of a kind, live or terminal. */
const countTasks = (store: DurableStore, kind: string) =>
 store.harness.commit(async (tx) => (await tx.scanTasks({ kind }, 100)).items.length, store.context);
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));

test('package pins Durable and the current SDK at compatible versions', () => {
 const pkg = readJson('package.json');
 const lock = readJson('package-lock.json').packages;
 assert.equal(pkg.dependencies['@earendil-works/pi-durable'], '1.0.4');
 assert.equal(pkg.engines.node, '>=22.19.0');
 assert.equal(lock['node_modules/@earendil-works/pi-durable'].version, '1.0.4');
 for (const name of ['pi-ai', 'chord']) {
  const nested = lock[`node_modules/@earendil-works/pi-durable/node_modules/@earendil-works/${name}`]
   ?? lock[`node_modules/@earendil-works/${name}`];
  assert.equal(nested.version, '1.0.4');
 }
 for (const name of ['pi-ai', 'pi-coding-agent', 'pi-server', 'pi-tui']) {
  assert.equal(pkg.devDependencies[`@earendil-works/${name}`], '1.0.4');
  assert.equal(lock[`node_modules/@earendil-works/${name}`].version, '1.0.4');
 }
});

test('runtime resolves frozen versions and coexists with the SDK', async () => {
 const runtime = await loadDurableRuntime();
 assert.equal(await loadDurableRuntime(), runtime);
 assert.ok(Object.isFrozen(DURABLE_PACKAGE_VERSIONS) && Object.isFrozen(runtime.versions) && Object.isFrozen(runtime.entries));
 assert.deepEqual({ ...runtime.versions }, { ...DURABLE_PACKAGE_VERSIONS });
 for (const entry of Object.values(runtime.entries)) assert.ok(fs.existsSync(entry), entry);
 // npm may hoist identical dependencies; the SDK must remain importable.
 const sdk = readJson('node_modules/@earendil-works/pi-ai/package.json');
 assert.equal(sdk.version, '1.0.4');
 const tools: any[] = [];
 const extension = (await import('../src/index.ts')).default;
 extension({ on() {}, registerTool(tool: any) { tools.push(tool); } } as any);
 assert.ok(tools.some((tool) => tool.name === 'dispatch'));
});

test('compatibility rejects old Node.js and mismatched package versions', async () => {
 assertNodeVersion('22.19.0');
 assertNodeVersion('v24.1.0');
 for (const version of ['22.18.9', '20.19.0', 'unknown']) assert.throws(() => assertNodeVersion(version), DurableCompatibilityError);
 await assert.rejects(loadDurableRuntime({ nodeVersion: '22.18.0' }), DurableCompatibilityError);
 const fake = (versions: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(root, 'fake-'));
  const durable = path.join(dir, 'node_modules/@earendil-works/pi-durable');
  for (const [name, version] of Object.entries(versions)) {
   const pkgDir = name === 'pi-durable' ? durable : path.join(durable, 'node_modules/@earendil-works', name);
   fs.mkdirSync(pkgDir, { recursive: true });
   fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: `@earendil-works/${name}`, version, exports: { '.': { import: './missing.js' } } }));
  }
  return path.join(durable, 'package.json');
 };
 for (const versions of <Record<string, string>[]>[
  { 'pi-durable': '1.0.3', 'pi-ai': '1.0.4', chord: '1.0.4' },
  { 'pi-durable': '1.0.4', 'pi-ai': '1.0.3', chord: '1.0.4' },
  { 'pi-durable': '1.0.4', 'pi-ai': '1.0.4', chord: '1.1.0' },
  { 'pi-durable': '1.0.4', 'pi-ai': '1.0.4' },
 ]) await assert.rejects(loadDurableRuntime({ durablePackageJson: fake(versions) }), DurableCompatibilityError);
});

test('admission is transactional, idempotent, and starts no generation', async () => {
 const file = storePath();
 const store = await openDurableStore({ path: file, ...identity });
 try {
  assert.equal(store.recovery.halted, false);
  await assert.rejects(store.admit({ ...admission, budgetUsd: 4 }), RangeError);
  await assert.rejects(store.admit({ ...admission, tasks: [{ key: 't1', reserveUsd: Number.NaN }] }), RangeError);
  assert.equal((await store.read()).policy, undefined);
  const first = await store.admit(admission);
  assert.equal(first.status, 'admitted');
  assert.deepEqual(await store.admit(admission), { status: 'duplicate', taskId: first.taskId });
  await assert.rejects(store.admit({ ...admission, maxWorkers: 2 }), DurableStoreMismatchError);
  const snapshot = await store.read();
  assert.equal(snapshot.policy?.reservedUsd, 5);
  assert.deepEqual(snapshot.attempts.map((a) => [a.key, a.status, a.reservedUsd, a.spentUsd]), [['t1#1', 'reserved', 2, 0], ['t2#1', 'reserved', 3, 0]]);
  const generation = store.runtime.durable.GenerationTask.definition.name;
  assert.equal(await countTasks(store, generation), 0);
  const inspection = await store.harness.inspect(store.context);
  assert.equal(inspection.scheduling, 'paused');
  assert.deepEqual(inspection.tasks.map((t) => t.record.kind), ['pi-dispatch.admission']);
  assert.equal(inspection.submissions.length, 0);
 } finally { await store.close(); }
 const reopened = await openDurableStore({ path: file, ...identity });
 try { assert.equal((await reopened.admit(admission)).status, 'duplicate'); } finally { await reopened.close(); }
});

test('records cannot be written before admission', async () => {
 const store = await openDurableStore({ path: storePath(), ...identity });
 try {
  const attempt: AttemptState = { key: 'x#1', taskKey: 'x', attempt: 1, status: 'reserved', reservedUsd: 0, spentUsd: 0, worker: null, worktree: null, branch: null, baseSha: null, headSha: null, pr: null, reason: null };
  await assert.rejects(store.harness.commit((tx) => putAttempt(store.contracts, tx, attempt), store.context), /before batch admission/);
  assert.equal((await store.read()).policy, undefined);
 } finally { await store.close(); }
});

test('one owner per store; mismatched identity or version is rejected and releases the lock', async () => {
 const file = storePath();
 const store = await openDurableStore({ path: file, ...identity });
 await assert.rejects(openDurableStore({ path: file, ...identity }), DurableStoreLockedError);
 await store.admit(admission);
 await store.close();
 await store.close();
 await assert.rejects(openDurableStore({ path: file, batchId: 'batch-2', policyHash: identity.policyHash }), DurableStoreMismatchError);
 await assert.rejects(openDurableStore({ path: file, batchId: identity.batchId, policyHash: 'sha256:other' }), DurableStoreMismatchError);
 const reopened = await openDurableStore({ path: file, ...identity });
 await reopened.harness.commit(async (tx) => { (await tx.doc(reopened.contracts.PolicyDoc)).durableVersion = '1.0.3'; }, reopened.context);
 await reopened.close();
 await assert.rejects(openDurableStore({ path: file, ...identity }), /does not match/);
 assert.ok(fs.existsSync(ownerLockPath(file)));
});

async function startAttempt(storeFile: string, worker: AttemptState['worker'], key: string) {
 const store = await openDurableStore({ path: storeFile, ...identity });
 try {
  await store.harness.commit(async (tx) => {
   await putAttempt(store.contracts, tx, { key, taskKey: key.split('#')[0], attempt: 2, status: 'running', reservedUsd: 1, spentUsd: 0, worker, worktree: '/tmp/wt', branch: 'b', baseSha: 'a'.repeat(40), headSha: null, pr: null, reason: null });
  }, store.context);
 } finally { await store.close(); }
}

test('SIGKILLed owner: lock is released and recovery fails closed', async () => {
 const file = storePath();
 const script = path.join(root, `owner-${counter}.mts`);
 const storeUrl = pathToFileURL(path.join(repoRoot, 'src/durable/store.ts')).href;
 const contractsUrl = pathToFileURL(path.join(repoRoot, 'src/durable/contracts.ts')).href;
 fs.writeFileSync(script, `
import { openDurableStore, workerIdentity } from ${JSON.stringify(storeUrl)};
import { putAttempt, putEffect } from ${JSON.stringify(contractsUrl)};
const store = await openDurableStore({ path: ${JSON.stringify(file)}, ...${JSON.stringify(identity)} });
await store.admit(${JSON.stringify(admission)});
const worker = await workerIdentity(process.pid);
await store.harness.commit(async (tx) => {
 await putAttempt(store.contracts, tx, { key: 't1#1', taskKey: 't1', attempt: 1, status: 'running', reservedUsd: 2, spentUsd: 0, worker, worktree: '/tmp/wt-t1', branch: 'dispatch/t1', baseSha: '${'a'.repeat(40)}', headSha: null, pr: null, reason: null });
 await putEffect(store.contracts, tx, { key: 't1#1:push', attemptKey: 't1#1', kind: 'push', status: 'intended', target: 'origin/dispatch/t1', sha: '${'b'.repeat(40)}', pr: null });
}, store.context);
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);
 const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
 let stderr = '';
 child.stderr.on('data', (chunk) => { stderr += chunk; });
 const exited = new Promise((resolve) => child.once('exit', resolve));
 await new Promise<void>((resolve, reject) => {
  child.stdout.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
  child.once('exit', (code) => reject(new Error(`owner exited early (${code}): ${stderr}`)));
 });
 await assert.rejects(openDurableStore({ path: file, ...identity }), DurableStoreLockedError);
 child.kill('SIGKILL');
 await exited;
 const store = await openDurableStore({ path: file, ...identity });
 try {
  assert.deepEqual(store.recovery, { interrupted: ['t1#1'], blocked: [], unresolvedEffects: ['t1#1:push'], unknownSpend: ['t1#1'], halted: true });
  const { attempts, effects } = await store.read();
  const attempt = attempts.find((a) => a.key === 't1#1')!;
  assert.equal(attempt.worker?.pid, child.pid);
  assert.equal(attempt.worktree, '/tmp/wt-t1');
  assert.equal(effects[0].status, 'unresolved');
  assert.equal(effects[0].sha, 'b'.repeat(40));
  assert.equal((await store.recover()).halted, true);
 } finally { await store.close(); }
 // A live worker, a missing identity, and a foreign host all block instead of retrying.
 const self = await workerIdentity(process.pid);
 await startAttempt(file, self, 't2#2');
 await startAttempt(file, null, 't3#2');
 await startAttempt(file, { ...self, host: `${self.host}.elsewhere` }, 't4#2');
 const again = await openDurableStore({ path: file, ...identity });
 try {
  assert.deepEqual(again.recovery.blocked, ['t2#2', 't3#2', 't4#2']);
  assert.deepEqual(again.recovery.unknownSpend, ['t1#1', 't2#2', 't3#2', 't4#2']);
  const generation = again.runtime.durable.GenerationTask.definition.name;
  assert.equal(await countTasks(again, generation), 0);
 } finally { await again.close(); }
 assert.equal(attemptKey('t2', 2), 't2#2');
});
