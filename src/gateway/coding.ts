import { object } from "./config";
import type { Body } from "./protocol";

/**
 * Automatic capture replaces code blocks in speech and drops work tool calls for every client.
 * Known coding clients also omit preambles on work-tool steps, keeping only speech tool calls.
 * Speech tool names consist of the words below, and their text goes through the same code filter.
 * Recall uses the filtered human text. An assistant can opt out with `codingFilter: false`.
 *
 * A request counts as coding when either signal is present:
 *  - the client names itself in its User-Agent or attribution headers;
 *  - the request offers both a shell tool and a file-editing tool.
 */
const CLIENT_HEADERS = ["user-agent", "x-title", "http-referer", "referer", "originator"];
const CLIENT_RE = /claude-cli|claude-code|codex|opencode|kilo[ -]?code|kilocode\.ai|\bcline\b|roo[ -]?code|\baider\b|charm-crush|qwen-?code/i;

// Names are compared lowercased with separators and trailing version dates removed,
// so "Bash", "bash_20250124" and "run-terminal-cmd" line up with the lists below.
const SHELL_TOOLS = new Set(["bash", "shell", "localshell", "executecommand", "runterminalcmd", "runcommand",
  "runshellcommand", "execcommand", "exec", "terminal"]);
const EDIT_TOOLS = new Set(["edit", "multiedit", "write", "applypatch", "strreplaceeditor", "strreplacebasededittool",
  "texteditor", "writetofile", "replaceinfile", "editfile", "applydiff", "createfile", "insertcontent",
  "searchandreplace", "notebookedit", "writefile", "patch"]);
// A speech tool says something to someone: its name has one of these words, and every other word is
// one of the second set (who or where it goes). "send_patch", "sendKeys" and "commit_message" are work.
const SPEECH_WORDS = new Set(["send", "reply", "respond", "message", "messages", "msg", "notify", "notification",
  "speak", "say", "tell", "talk", "voice", "tts", "sticker", "dm"]);
const SPEECH_CONTEXT = new Set(["to", "the", "a", "user", "owner", "human", "her", "him", "them", "text", "chat", "im",
  "private", "group", "channel", "room", "friend", "contact", "partner", "wife", "husband", "audio", "image", "photo",
  "picture", "emoji", "reaction", "react", "card", "push", "bot", "final", "proactive", "weixin", "wechat", "wx",
  "telegram", "tg", "qq", "discord", "slack", "line", "whatsapp", "signal", "imessage", "sms", "feishu", "lark",
  "dingtalk", "kook", "matrix", "email", "mail", "onebot", "napcat"]);

function normalize(name: unknown): string {
  return typeof name === "string" ? name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/\d+$/, "") : "";
}

/** Every name a tool definition answers to, across Chat Completions, Messages and Responses shapes. */
function toolNames(tool: unknown): string[] {
  if (!object(tool)) return [];
  return [tool.name, tool.type, object(tool.function) ? tool.function.name : undefined].map(normalize).filter(Boolean);
}

/** Why this request looks like a coding agent, or null. */
export function codingClient(headers: Headers, body: Body): string | null {
  for (const name of CLIENT_HEADERS) {
    const match = headers.get(name)?.match(CLIENT_RE);
    if (match) return `client:${match[0].toLowerCase()}`;
  }
  return codingTools(body);
}

/**
 * The same judgment for the hook endpoints, which have no client headers: the agent id the caller
 * passes (magpie's ctx.agent, such as "claude", "codex", "opencode" or "kilo") plays the client header.
 */
export function codingAgent(agent: unknown, body: Body): string | null {
  if (agent === "claude") return "agent:claude";
  const match = typeof agent === "string" ? agent.match(CLIENT_RE) ?? agent.match(/\bkilo\b/i) : null;
  if (match) return `agent:${match[0].toLowerCase()}`;
  return codingTools(body);
}

/** Both a shell tool and a file-editing tool on offer. */
function codingTools(body: Body): string | null {
  const names = new Set((Array.isArray(body.tools) ? body.tools : []).flatMap(toolNames));
  const shell = [...names].find(name => SHELL_TOOLS.has(name));
  const edit = [...names].find(name => EDIT_TOOLS.has(name));
  return shell && edit ? `tools:${shell}+${edit}` : null;
}

/** Whether a tool call says something to someone (see the header). MCP server names are not judged. */
export function isSpeechTool(name: string): boolean {
  const tool = /^mcp__/i.test(name) ? name.slice(name.lastIndexOf("__") + 2) : name;
  const words = tool.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)
    .filter(word => word && !/^v?\d+$/.test(word));
  return words.some(word => SPEECH_WORDS.has(word)) &&
    words.every(word => SPEECH_WORDS.has(word) || SPEECH_CONTEXT.has(word));
}

/**
 * Turns fenced code blocks into [code] as text streams through, keeping only a few characters of
 * the current line. As in CommonMark, a block opens at a line of three or more ` or ~ and closes at
 * a line of the same character at least as long, or runs to the end.
 */
export class CodeFilter {
  private head = "";
  private line: "open" | "text" | "drop" | null = null;
  private fence: { char: string; length: number } | null = null;
  constructor(private readonly emit: (text: string) => void) {}

  push(text: string): void {
    let start = 0;
    for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
      this.feed(text.slice(start, nl));
      this.endLine(true);
      start = nl + 1;
    }
    this.feed(text.slice(start));
  }

  /** The text ends here, or a tool call comes next: an open block ends with it. */
  end(): void {
    this.endLine(false);
    this.fence = null;
  }

  private feed(piece: string): void {
    if (!piece || this.line === "open" || this.line === "drop") return;
    if (this.line === "text") { this.emit(piece); return; }
    this.head += piece;
    const rest = this.head.replace(/^[ \t]*/, "");
    const run = /^(`+|~+)/.exec(rest)?.[0] || "";
    if (this.fence) {
      // Inside a block nothing is kept; a line is held only while it could still close the block.
      const closing = run.startsWith(this.fence.char) || !rest;
      if (!closing || rest.slice(run.length).trim() || this.head.length > 256) { this.line = "drop"; this.head = ""; }
    } else if (rest.length > run.length || this.head.length > 256) {
      // The run of fence characters has ended: three or more open a block, fewer are words.
      if (run.length >= 3) this.open(run);
      else { this.line = "text"; this.emit(this.head); this.head = ""; }
    }
  }

  private open(run: string): void {
    this.fence = { char: run[0], length: run.length };
    this.line = "open"; this.head = "";
    this.emit("[code]");
  }

  private endLine(newline: boolean): void {
    if (this.fence) {
      // A held line is fence characters and spaces only: it closes if the run is long enough.
      if (this.line === null && this.head.trim().length >= this.fence.length) {
        this.fence = null;
        if (newline) this.emit("\n");
      }
    } else if (this.line === "text") {
      if (newline) this.emit("\n");
    } else if (this.line === null) {
      const run = /^(`{3,}|~{3,})$/.exec(this.head.trim())?.[0];
      if (run) this.open(run);
      else if (this.head || newline) this.emit(newline ? `${this.head}\n` : this.head);
    }
    this.head = "";
    this.line = null;
  }
}

// DSH sends background job notifications as user text, including the command and its output.
const DSH_JOB_NOTIFICATION = /^background job bash-[a-f0-9]{16} \(bash: /;

// A blank line can end an unfenced example. Continue redacting across it only if the next
// paragraph starts with recognizable syntax for the same format.
const UNFENCED_CODE = [
  {
    opening: /^(?:#![ \t]*\/\S+|set -euo pipefail[ \t]*(?:\r?\n|$))/,
    continuation: /^(?:[A-Za-z_]\w*=(?!=)|(?:printf|echo)[ \t]+["'$-]|(?:fi|done|esac)[ \t]*(?:\r?\n|$))/
  },
  {
    opening: /^(?:\*\*\* Begin Patch[ \t]*(?:\r?\n|$)|diff --git [^\r\n]+\r?\n|--- (?:a\/|\/dev\/null)[^\r\n]*\r?\n\+\+\+ )/,
    continuation: /^(?:\*\*\* (?:End Patch|(?:Add|Update|Delete) File:)|@@(?:[ \t]|\r?\n|$)|[+-]\S)/
  },
  {
    opening: /^(?:export[ \t]+)?(?:const|let|var)[ \t]+[$A-Z_a-z][$\w]*[ \t]*=[^\r\n]*;[ \t]*(?:\r?\n|$)/,
    continuation: /^(?:(?:[$A-Z_a-z][$\w]*\.)*[$A-Z_a-z][$\w]*\([^\r\n]*\);|[{}];?)[ \t]*(?:\r?\n|$)/
  },
  {
    opening: /^(?:async[ \t]+)?def[ \t]+[A-Z_a-z]\w*\([^\r\n]*\)[ \t]*:[ \t]*(?:#[^\r\n]*)?\r?\n[ \t]+\S/,
    continuation: /^[ \t]+\S/
  }
];

function replaceUnfencedCode(text: string): string {
  const paragraphs = text.split(/\r?\n(?:[ \t]*\r?\n)+/);
  const output: string[] = [];
  let previous: typeof UNFENCED_CODE[number] | undefined;
  for (const paragraph of paragraphs) {
    const start = paragraph.trimStart();
    const rule = UNFENCED_CODE.find(candidate => candidate.opening.test(start)) ??
      (previous?.continuation.test(paragraph) ? previous : undefined);
    if (!rule) output.push(paragraph);
    else if (!previous) output.push("[code]");
    previous = rule;
  }
  return output.join("\n\n");
}

/** Fenced code blocks and standalone code artifacts become [code]. */
export function replaceCode(text: string): string {
  const trimmed = text.trim();
  if (DSH_JOB_NOTIFICATION.test(trimmed)) return "[code]";
  if (!/^[ \t]*(?:`{3}|~{3})/m.test(trimmed)) return replaceUnfencedCode(trimmed);
  let out = "";
  const filter = new CodeFilter(piece => { out += piece; });
  filter.push(text);
  filter.end();
  return replaceUnfencedCode(out.trim());
}

/** Keep the text around code, and return an empty string for code alone. */
export function stripCodeContent(text: string): string {
  const said = replaceCode(text);
  return said.replaceAll("[code]", "").trim() ? said : "";
}

/** A tool call's arguments with code in every string replaced by [code]. */
export function replaceCodeIn(value: unknown): unknown {
  if (typeof value === "string") return replaceCode(value);
  if (Array.isArray(value)) return value.map(replaceCodeIn);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceCodeIn(item)]));
  return value;
}

/** The words to search memories with: no code, no placeholders. */
export function recallWords(text: string): string {
  return stripCodeContent(text).replaceAll("[code]", " ").replace(/\s+/g, " ").trim();
}

/** What a coding agent's reply said, for the record (see the header), and whether it hit the cap. */
export function codingSpeech(out: { text: string; truncated: boolean; overflow: boolean; workCalls: number;
  spoken: string; spokenTruncated: boolean }): { text: string; truncated: boolean } {
  if (out.workCalls) return { text: out.spoken, truncated: out.overflow || out.spokenTruncated };
  return { text: out.text, truncated: out.truncated };
}
