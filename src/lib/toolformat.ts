/**
 * Model-facing rendering of tool results.
 *
 * Tools return structured objects; the model should see compact plain text instead of
 * pretty-printed JSON. File contents arrive raw (no \n / \" escaping), command output is
 * labeled only when it needs to be, and nothing is repeated that the model already knows.
 * Same bytes go to API models and the WebChat bridge, so both paths see identical results.
 */

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

function commandText(r: any): string {
  const out: string[] = [];
  const stdout = String(r.stdout ?? '').replace(/\s+$/, '');
  const stderr = String(r.stderr ?? '').replace(/\s+$/, '');
  if (stdout) out.push(stdout);
  if (stderr) out.push(`[stderr]\n${stderr}`);
  if (r.error) out.push(`[error] ${r.error}`);
  if (r.timedOut) out.push('[timed out]');
  else if (typeof r.exitCode === 'number' && r.exitCode !== 0) out.push(`[exit code ${r.exitCode}]`);
  return out.length ? out.join('\n') : '(no output)';
}

export function formatToolResult(name: string, ok: boolean, result: any, error?: string): string {
  if (!ok) return `Error: ${error ?? 'tool failed'}`;
  const r = result ?? {};

  switch (name) {
    case 'read_file': {
      const body = typeof r.content === 'string' ? r.content : '';
      let text = body === '' ? '(empty file)' : body;
      if (r.truncated) {
        text += `\n\n[Showing lines ${r.startLine}-${r.endLine} of ${r.totalLines}. Call read_file with offset=${r.nextOffset} to continue.]`;
      }
      return text;
    }
    case 'run_command':
    case 'git':
      return commandText(r);
    case 'write_file':
      return `Wrote ${r.bytesWritten ?? 0} bytes to ${r.path}`;
    case 'edit_file': {
      const lines = [`Applied ${r.applied ?? 0} edit(s) to ${r.path}`];
      for (const f of r.failed ?? []) lines.push(`Not applied: "${clip(String(f.old ?? ''), 60)}" (${f.reason ?? 'failed'})`);
      if ((r.applied ?? 0) === 0 && (r.failed ?? []).length) lines.push('Nothing changed. Re-read the file and retry with exact text.');
      return lines.join('\n');
    }
    case 'list_files': {
      const entries: any[] = r.entries ?? [];
      if (entries.length === 0) return '(empty)';
      return entries.map((e) => (e.type === 'dir' ? `${e.path}/` : String(e.path))).join('\n');
    }
    case 'delete_file':
      return `Deleted ${r.path}`;
    case 'move_file':
      return `Moved ${r.from} -> ${r.to}`;
    case 'update_plan':
      return 'Plan updated.';
    case 'use_skill':
      return String(r.instructions ?? '');
    case 'web_search': {
      const items: any[] = r.results ?? [];
      if (r.error) return `Search failed: ${r.error}`;
      if (items.length === 0) return 'No results.';
      return items.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${clip(String(x.snippet ?? ''), 240)}`).join('\n');
    }
    default:
      return typeof result === 'string' ? result : JSON.stringify(result ?? {});
  }
}
