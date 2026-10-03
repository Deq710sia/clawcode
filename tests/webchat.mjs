// WebChat bridge + tool-format tests (pure modules; no browser or network). Run: npm test
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';

const out = 'node_modules/.cache/clawcode-test/webchat';
mkdirSync(out, { recursive: true });
await build({
  entryPoints: { toolprotocol: 'electron/webchat/toolprotocol.ts', continuation: 'electron/webchat/continuation.ts', dommd: 'electron/webchat/drivers/dom-markdown.ts', toolformat: 'src/lib/toolformat.ts' },
  bundle: true, format: 'esm', platform: 'node', outdir: out, logLevel: 'error',
});
const load = (n) => import(pathToFileURL(process.cwd() + `/${out}/${n}.js`).href);
const TP = await load('toolprotocol'), C = await load('continuation'), { domToMarkdown } = await load('dommd'), { formatToolResult } = await load('toolformat');

let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '\n      got: ' + JSON.stringify(extra))); if (!cond) fails++; };
const md = (html) => { const { document } = parseHTML(`<html><body><div id="r">${html}</div></body></html>`); return domToMarkdown(document.getElementById('r')); };

// ---------- tool result formatting ----------
const src = Array.from({ length: 150 }, (_, i) => `  const value${i} = compute("item-${i}", { retries: 3, label: "value-${i}" }); // "q1" "q2" "q3" "q4" "q5" "q6" "q7" "q8"`).join('\n');
const readRes = { path: 'a.ts', content: src, size: src.length, totalLines: 150, startLine: 1, endLine: 150, truncated: false };
const oldFmt = JSON.stringify(readRes, null, 2), newFmt = formatToolResult('read_file', true, readRes);
check('read_file result is raw text, byte-for-byte', newFmt === src, newFmt.slice(0, 60));
check('read_file result is >10% smaller than pretty JSON', newFmt.length < oldFmt.length * 0.9, { old: oldFmt.length, new: newFmt.length });
check('truncated read_file tells the model how to continue', /offset=61\b/.test(formatToolResult('read_file', true, { content: 'x', truncated: true, startLine: 1, endLine: 60, totalLines: 200, nextOffset: 61 })));
check('run_command: plain stdout only on success', formatToolResult('run_command', true, { ok: true, exitCode: 0, stdout: 'hi\n', stderr: '' }) === 'hi');
check('run_command: stderr + exit code shown on failure', formatToolResult('run_command', true, { ok: false, exitCode: 2, stdout: '', stderr: 'boom' }) === '[stderr]\nboom\n[exit code 2]');
check('run_command: timeout flagged', /\[timed out\]/.test(formatToolResult('run_command', true, { exitCode: null, timedOut: true, stdout: 'x', stderr: '' })));
check('edit_file drops the diff, reports failures', (() => { const t = formatToolResult('edit_file', true, { path: 'a', applied: 1, failed: [{ old: 'zzz', reason: 'not found' }], diff: 'x'.repeat(5000) }); return t.length < 200 && /Not applied: "zzz"/.test(t); })());
check('errors are plain text', formatToolResult('read_file', false, undefined, 'File not found: x') === 'Error: File not found: x');

// ---------- tool protocol prompt ----------
const tools = [{ type: 'function', function: { name: 'git', description: 'Safe git.', parameters: { type: 'object', properties: { subcommand: { type: 'string', enum: ['status', 'diff', 'commit'] }, args: { type: 'array', items: { type: 'string' }, description: 'Arguments after the subcommand.' } }, required: ['subcommand'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } }, required: ['path'] } } }];
const m1 = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'fix the bug' }];
const p1 = TP.buildPrompt(m1, tools);
check('signature exposes enum values', /subcommand: "status"\|"diff"\|"commit"/.test(p1), p1.slice(p1.indexOf('Available tools')));
check('signature exposes param descriptions', /Arguments after the subcommand/.test(p1));
check('contradictory "always end with text" rule is gone', !/Never end a turn with just tool calls/.test(p1) && !/CRITICAL/.test(p1));
check('system prompt and user turn present', /SYS/.test(p1) && /\[User\]\nfix the bug/.test(p1));

// ---------- continuation planning ----------
// deltaStart indexes the NON-SYSTEM messages: the site has seen convo[0..k-1] plus our reply,
// so the new part begins at convo[k] (k = state.sigs.length).
const reply1 = { content: 'Let me look.', calls: [{ name: 'read_file', arguments: '{"path":"a.ts"}' }] };
const asst1 = { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'call_xyz', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] };
const tool1 = { role: 'tool', tool_call_id: 'call_xyz', name: 'read_file', content: 'FILE TEXT' };
const state1 = C.nextState(m1, tools, reply1);
const m2 = [...m1, asst1, tool1];
let plan = C.planTurn(state1, m2, tools);
check('extends previous request -> continue', plan.mode === 'continue' && plan.deltaStart === 2, plan);
const delta = TP.buildContinuationPrompt(m2, plan.deltaStart);
check('continuation sends only the new tool result', delta === '[Tool result: read_file]\nFILE TEXT', delta);
check('continuation with lone user message is verbatim', TP.buildContinuationPrompt([...m1, asst1, { role: 'user', content: 'also add tests' }], 2) === 'also add tests');
check('no state -> fresh', C.planTurn(undefined, m2, tools).mode === 'fresh');
check('system prompt changed -> fresh', C.planTurn(state1, [{ role: 'system', content: 'SYS2' }, ...m2.slice(1)], tools).mode === 'fresh');
check('tools changed -> fresh', C.planTurn(state1, m2, tools.slice(0, 1)).mode === 'fresh');
check('earlier history edited -> fresh', C.planTurn(state1, [m2[0], { role: 'user', content: 'fix a different bug' }, asst1, tool1], tools).mode === 'fresh');
check('nothing new to send -> fresh', C.planTurn(state1, [...m1, asst1], tools).mode === 'fresh');
check('new assistant turn in delta (site never saw it) -> fresh', C.planTurn(state1, [...m2, { role: 'assistant', content: 'unseen' }, { role: 'user', content: 'x' }], tools).mode === 'fresh');
check('whitespace / arg key order differences still match', C.planTurn(state1, [m1[0], m1[1], { ...asst1, content: ' Let   me look. ', tool_calls: [{ ...asst1.tool_calls[0], function: { name: 'read_file', arguments: '{ "path": "a.ts" }' } }] }, tool1], tools).mode === 'continue');
const state2 = C.nextState(m2, tools, { content: 'Done.', calls: [] });
const m3 = [...m2, { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'thanks, now tests' }];
check('multi-round chain keeps continuing', C.planTurn(state2, m3, tools).mode === 'continue' && C.planTurn(state2, m3, tools).deltaStart === 4);
check('steering: tool result + user message in one delta', (() => { const mm = [...m2.slice(0, 3), tool1, { role: 'user', content: 'actually use vitest' }]; const pl = C.planTurn(state1, mm, tools); return pl.mode === 'continue' && /\[Tool result: read_file\][\s\S]*\[User\]\nactually use vitest/.test(TP.buildContinuationPrompt(mm, pl.deltaStart)); })());
{ let msgs = [...m1], fresh = 0, cont = 0; let st; for (let r = 0; r < 12; r++) { const pl = C.planTurn(st, msgs, tools); fresh += pl.mode === 'fresh' ? TP.buildPrompt(msgs, tools).length : 0; cont += pl.mode === 'continue' ? TP.buildContinuationPrompt(msgs, pl.deltaStart).length : 0;
  const a = { role: 'assistant', content: '', tool_calls: [{ id: 'c' + r, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${r}"}` } }] };
  st = C.nextState(msgs, tools, { content: '', calls: [{ name: 'read_file', arguments: `{"path":"f${r}"}` }] });
  msgs = [...msgs, a, { role: 'tool', tool_call_id: 'c' + r, name: 'read_file', content: 'x'.repeat(3000) }]; }
  let msgs2 = [...m1], total = 0; for (let r = 0; r < 12; r++) { total += TP.buildPrompt(msgs2, tools).length; msgs2 = [...msgs2, { role: 'assistant', content: '', tool_calls: [{ id: 'c' + r, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${r}"}` } }] }, { role: 'tool', tool_call_id: 'c' + r, name: 'read_file', content: 'x'.repeat(3000) }]; }
  check('12-round agent loop: continuation sends >75% fewer characters than re-pasting', (fresh + cont) < total * 0.25, { continued: fresh + cont, repasted: total }); }

// ---------- reply parsing still intact ----------
const call = '```json\n{"tool_call": {"name": "git", "arguments": {"subcommand": "commit", "args": ["-m", "fix: a\\nb"]}}}\n```';
const parsed = TP.parseReply('Committing now.\n' + call, ['git']);
check('tool call parsed, narration kept', parsed.calls.length === 1 && JSON.parse(parsed.calls[0].arguments).args[1] === 'fix: a\nb' && parsed.content === 'Committing now.', parsed);

// ---------- DOM -> markdown ----------
check('inline formatting', md('<p>Use <strong>bold</strong>, <em>italic</em>, <code>x &lt; y</code> and <a href="https://e.com/a">a link</a>.</p>') === 'Use **bold**, *italic*, `x < y` and [a link](https://e.com/a).');
check('ChatGPT-style code block (header inside <pre>, language class)', md('<p>Run:</p><pre><div><div>bash</div><div><button>Copy code</button></div></div><div><code class="hljs language-bash"><span>npm</span> test\n</code></div></pre>') === 'Run:\n\n```bash\nnpm test\n```');
check('Claude-style code block (label + Copy outside <pre>)', md('<div class="w"><div class="hdr"><span>python</span><button>Copy</button></div><pre><code>def f():\n    return 1\n</code></pre></div>') === '```python\ndef f():\n    return 1\n```');
check('"Copy" button text never leaks', !/Copy/.test(md('<pre><div><button>Copy code</button></div><code class="language-js">a()</code></pre>')));
check('code keeps indentation and blank lines exactly', md('<pre><code class="language-py">if x:\n\n        y\n</code></pre>') === '```py\nif x:\n\n        y\n```');
check('code containing ``` uses a longer fence', md('<pre><code>```js\nx\n```</code></pre>').startsWith('````'));
check('nested lists', md('<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>') === '- one\n  - nested\n- two', md('<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>'));
check('ordered list keeps numbering', md('<ol start="3"><li>c</li><li>d</li></ol>') === '3. c\n4. d', md('<ol start="3"><li>c</li><li>d</li></ol>'));
check('headings, quote, rule', md('<h2>Title</h2><blockquote><p>q</p></blockquote><hr>') === '## Title\n\n> q\n\n---');
check('table -> GFM', md('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>x|y</td></tr></tbody></table>') === '| A | B |\n| --- | --- |\n| 1 | x\\|y |');
check('KaTeX -> TeX source', md('<p>E = <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">mc^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">mc2</span></span></p>') === 'E = $mc^2$');
check('svg / buttons / hidden UI skipped', md('<p>Hi</p><div><svg><title>icon</title></svg><button>Retry</button><span aria-hidden="true">ghost</span></div>') === 'Hi');
check('a tool-call fence survives conversion and parses', (() => { const html = '<p>Reading.</p><pre><code class="language-json">{"tool_call": {"name": "read_file", "arguments": {"path": "src/a.ts"}}}</code></pre>'; const p = TP.parseReply(md(html), ['read_file']); return p.calls.length === 1 && JSON.parse(p.calls[0].arguments).path === 'src/a.ts' && p.content === 'Reading.'; })());
check('plain-text-only bubble unchanged', md('Just some text') === 'Just some text');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
