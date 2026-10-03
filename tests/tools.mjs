// Tool + main-process security tests. Compiles electron/ with tsc and stubs the `electron` module. Run: npm test
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('node_modules/.cache/clawcode-test/electron');
rmSync(root, { recursive: true, force: true });
execFileSync('npx', ['tsc', '-p', 'electron/tsconfig.json', '--outDir', root], { stdio: 'inherit' });
const userData = join(tmpdir(), 'claw-test-userdata-' + process.pid);
mkdirSync(userData, { recursive: true });
mkdirSync(join(root, 'node_modules/electron'), { recursive: true });
writeFileSync(join(root, 'package.json'), '{"type":"module"}');
writeFileSync(join(root, 'node_modules/electron/package.json'), '{"name":"electron","version":"0.0.0","type":"module","main":"index.js"}');
writeFileSync(join(root, 'node_modules/electron/index.js'), `
export const app = { getPath: () => ${JSON.stringify(userData)}, isPackaged: false, getAppPath: () => '.' };
export const safeStorage = { isEncryptionAvailable: () => false };
export const dialog = {}; export class BrowserWindow {} export const ipcMain = { handle() {}, on() {} }; export const shell = {};
export default { app, safeStorage, dialog, BrowserWindow, ipcMain, shell };`);

const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { TOOLS } = await imp('tools/index.js');
const Convos = await imp('conversations.js');
const Skills = await imp('skills/index.js');
const tool = (n) => TOOLS.find((t) => t.name === n);

let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra))); if (!cond) fails++; };
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };

// workspace fixtures
const ws = join(tmpdir(), 'claw-test-ws-' + process.pid), outside = join(tmpdir(), 'claw-test-out-' + process.pid);
rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
mkdirSync(ws, { recursive: true }); mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 's.txt'), 'secret'); symlinkSync(outside, join(ws, 'link'));
writeFileSync(join(ws, 'big.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${'x'.repeat(50)}`).join('\n'));
writeFileSync(join(ws, 'crlf.txt'), 'alpha  \r\nbeta\r\ngamma\r\n');
const ctx = { workspace: ws };

// read_file
const r1 = tool('read_file').run({ path: 'big.txt' }, ctx);
check('read_file truncates large files with nextOffset', r1.truncated && r1.nextOffset === r1.endLine + 1 && r1.content.length <= 60000, r1.endLine);
const r2 = tool('read_file').run({ path: 'big.txt', offset: 10, limit: 5 }, ctx);
check('read_file offset/limit window', r2.startLine === 10 && r2.endLine === 14 && r2.content.split('\n').length === 5, r2);
check('read_file offset past end errors', !!(await throws(() => tool('read_file').run({ path: 'big.txt', offset: 99999 }, ctx))));

// workspace boundary
check('.. escape blocked', /escapes/.test(await throws(() => tool('read_file').run({ path: '../x' }, ctx)) ?? ''));
check('symlink read blocked', /symlink/.test(await throws(() => tool('read_file').run({ path: 'link/s.txt' }, ctx)) ?? ''));
check('symlink write blocked', /symlink/.test(await throws(() => tool('write_file').run({ path: 'link/new/x.txt', content: 'x' }, ctx)) ?? ''));
check('nothing written outside', !existsSync(join(outside, 'new')) && readFileSync(join(outside, 's.txt'), 'utf8') === 'secret');

// edit_file fuzzy fallback (CRLF + trailing whitespace)
const e = await tool('edit_file').run({ path: 'crlf.txt', replacements: [{ old: 'alpha\nbeta', new: 'ALPHA\nBETA' }] }, ctx);
check('edit_file matches across CRLF/trailing space', e.ok !== false && /ALPHA/.test(readFileSync(join(ws, 'crlf.txt'), 'utf8')), e);

// run_command
const rc = tool('run_command');
const c1 = await rc.run({ command: 'echo hi' }, ctx);
check('run_command ok', c1.ok && c1.stdout.trim() === 'hi', c1);
const c2 = await rc.run({ command: 'exit 3' }, ctx);
check('run_command exit code', !c2.ok && c2.exitCode === 3, c2);
const t0 = Date.now(); const c3 = await rc.run({ command: 'sleep 30 & sleep 30', timeoutMs: 1500 }, ctx);
check('run_command timeout kills tree quickly', c3.timedOut && Date.now() - t0 < 4000, c3);
const c4 = await rc.run({ command: 'yes x | head -c 500000' }, ctx);
check('run_command output capped', c4.stdout.length <= 200000 && /truncated/.test(c4.stderr), c4.stdout.length);

// git tool
import { execSync } from 'node:child_process';
execSync('git init -q && git config user.email a@b && git config user.name t', { cwd: ws });
const git = tool('git');
await git.run({ subcommand: 'add', args: ['crlf.txt'] }, ctx);
check('git commit needs -m', (await git.run({ subcommand: 'commit' }, ctx)).ok === false);
check('git commit works', (await git.run({ subcommand: 'commit', args: ['-m', 'init'] }, ctx)).ok === true);
for (const [sub, args] of [['push', []], ['reset', ['--hard']], ['checkout', ['.']], ['branch', ['evil']], ['branch', ['-D', 'master']], ['log', ['-c', 'core.pager=sh']], ['add', ['../etc/passwd']]]) {
  check(`git ${sub} ${args.join(' ')} refused`, (await git.run({ subcommand: sub, args }, ctx)).ok === false);
}

// conversations: path traversal
check('convo load ../ refused', Convos.loadConversation('../../etc/passwd') === null);
check('convo delete ../ refused', Convos.deleteConversation('../../x').ok === false);
check('convo save ../ refused', Convos.saveConversation({ id: '../evil', title: 't', messages: [], createdAt: 0, updatedAt: 0 }).ok === false);
check('convo save valid id', Convos.saveConversation({ id: 'abc-123', title: 't', messages: [], createdAt: 0, updatedAt: 0 }).ok === true);

// skills: recursive delete + clone url
check('skill uninstall .. refused', (await Skills.uninstallSkill('..')).ok === false);
for (const url of ['ext::sh -c id', '--upload-pack=id', 'file:///etc', 'https://gitlab.com/a/b']) {
  check(`skill install refuses ${url}`, (await Skills.installSkill(url)).ok === false);
}

rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); rmSync(userData, { recursive: true, force: true });
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
