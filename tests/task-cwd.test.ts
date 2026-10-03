import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateTaskCwd } from '../src/task-cwd.ts';

// Disposable fixture: a session repo, its linked worktree outside the repo, and an unrelated repo.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-task-cwd-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
function repo(name: string) {
	const dir = path.join(root, name);
	fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
	git(dir, 'init', '-q', '-b', 'main');
	git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
	return dir;
}
const session = repo('session');
const other = repo('other');
const worktree = path.join(root, 'worktrees', 'session-feat');
git(session, 'worktree', 'add', '-q', worktree, '-b', 'feat');
fs.mkdirSync(path.join(worktree, 'nested'));
const plain = path.join(root, 'plain');
fs.mkdirSync(plain);

test('empty cwd means the session cwd', async () => {
	assert.equal(await validateTaskCwd(undefined, session), undefined);
	assert.equal(await validateTaskCwd('  ', session), undefined);
});

test('accepts paths inside the session cwd', async () => {
	assert.equal(await validateTaskCwd('sub', session), path.join(session, 'sub'));
	assert.equal(await validateTaskCwd('.', plain), plain);
});

test('accepts a linked worktree of the session repository outside the session cwd', async () => {
	assert.equal(await validateTaskCwd(worktree, session), worktree);
	assert.equal(await validateTaskCwd(path.join(worktree, 'nested'), session), path.join(worktree, 'nested'));
});

test('accepts the main checkout from a session running in a linked worktree', async () => {
	assert.equal(await validateTaskCwd(session, worktree), session);
});

test('rejects unrelated repositories and plain directories', async () => {
	await assert.rejects(validateTaskCwd(other, session), /outside the session cwd/);
	await assert.rejects(validateTaskCwd(plain, session), /outside the session cwd/);
	await assert.rejects(validateTaskCwd(session, plain), /outside the session cwd/);
});

test('rejects a symlink inside the session that points elsewhere', async () => {
	const link = path.join(session, 'escape');
	fs.symlinkSync(other, link);
	await assert.rejects(validateTaskCwd('escape', session), /outside the session cwd/);
});

test('rejects a missing directory', async () => {
	await assert.rejects(validateTaskCwd('missing', session), /does not exist/);
});
