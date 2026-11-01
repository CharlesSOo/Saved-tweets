// Spawning the model CLI (pi by default, `BOOKMARK_SYNC_CLI=claude` for Claude Code).
const useClaude = () => process.env.BOOKMARK_SYNC_CLI === "claude";

export interface CliOptions {
  system: string;
  prompt: string;
  /** Read-only file tools rooted at `cwd`; omitted = no tools. */
  readOnlyTools?: boolean;
  cwd?: string;
}

export function cliCommand({ system, prompt, readOnlyTools }: CliOptions, mode: "text" | "json" = "text"): string[] {
  const model = process.env.BOOKMARK_SYNC_MODEL;
  const cmd = useClaude()
    ? ["claude", "-p", "--output-format", "text", "--system-prompt", system,
       ...(readOnlyTools ? ["--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Bash,Edit,Write"] : ["--tools", ""])]
    : ["pi", "-p", "--no-session", "--mode", mode, "--system-prompt", system,
       ...(readOnlyTools ? ["--tools", "read,grep,find,ls"] : ["--no-tools"])];
  if (model) cmd.push("--model", model);
  cmd.push(prompt);
  return cmd;
}

/** Runs the CLI to completion and returns trimmed stdout. */
export async function runCli(opts: CliOptions, timeoutMs: number): Promise<string> {
  const cmd = cliCommand(opts);
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (proc.signalCode) throw new Error(`${cmd[0]} timed out after ${timeoutMs / 1000}s`);
    if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.trim().slice(0, 500)}`);
    const text = out.trim();
    if (!text) throw new Error(`${cmd[0]} returned no output`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the CLI and yields answer text as it is generated. pi: `--mode json` events, text deltas only
 * (separate assistant messages joined by a blank line). claude: plain stdout chunks.
 */
export async function* streamCli(opts: CliOptions, timeoutMs: number): AsyncGenerator<string> {
  const json = !useClaude();
  const cmd = cliCommand(opts, json ? "json" : "text");
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const errText = new Response(proc.stderr).text();
  const decoder = new TextDecoder();
  let buf = "";
  let emitted = false;
  let newMessage = false;
  try {
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      if (!json) { yield text; continue; }
      buf += text;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev: { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "message_start") newMessage = true;
        const d = ev.assistantMessageEvent;
        if (ev.type === "message_update" && d?.type === "text_delta" && d.delta) {
          if (newMessage && emitted) yield "\n\n";
          newMessage = false;
          emitted = true;
          yield d.delta;
        }
      }
    }
    const code = await proc.exited;
    if (proc.signalCode) throw new Error(`${cmd[0]} timed out after ${timeoutMs / 1000}s`);
    if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${(await errText).trim().slice(0, 500)}`);
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) proc.kill();
  }
}
