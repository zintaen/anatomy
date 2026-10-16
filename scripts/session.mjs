import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const IDLE_CAP = 10 * 60 * 1000;

export function parseMinutes(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const match = value.match(/^(?:(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hours?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?))?$/);
  if (!match || (!match[1] && !match[2])) return undefined;
  return Math.round(Number((match[1] ?? "0").replace(",", ".")) * 60 + Number(match[2] ?? 0)) || undefined;
}

export function parseTokens(text) {
  const value = String(text ?? "").trim().toLowerCase().replace(/[\s,_]/g, "").replace(/tokens?$/, "");
  if (!value) return null;
  const match = value.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!match) return undefined;
  const tokens = Math.round(Number(match[1]) * (match[2] === "m" ? 1e6 : match[2] === "k" ? 1e3 : 1));
  return tokens >= 1 && tokens <= 1e10 ? tokens : undefined;
}

function walk(dir, out = []) {
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

export function sessionFiles(sessionId, root = join(homedir(), ".claude", "projects")) {
  if (!sessionId || !/^[0-9a-f-]{8,64}$/i.test(sessionId) || !existsSync(root)) return [];
  for (const project of readdirSync(root)) {
    const main = join(root, project, `${sessionId}.jsonl`);
    if (existsSync(main)) return [main, ...walk(join(root, project, sessionId))];
  }
  return [];
}

function subagentIds(file) {
  const full = file.replace(/transcript\.jsonl$/, "transcript_full.jsonl");
  const source = existsSync(full) ? full : file;
  const out = [];
  for (const line of readFileSync(source, "utf8").split("\n")) {
    if (!line.includes("Created the following subagents:")) continue;
    try {
      const content = String(JSON.parse(line)?.content ?? "").trim();
      if (!/^(?:Created At:[^\n]*\nCompleted At:[^\n]*\n)?Created the following subagents:/.test(content)) continue;
      for (const match of content.matchAll(/"conversationId":\s*"([0-9a-f-]{8,64})"/gi)) out.push(match[1]);
    } catch {}
  }
  return out;
}

export function antigravityFiles(sessionId, root = join(homedir(), ".gemini", "antigravity", "brain")) {
  if (!sessionId || !/^[0-9a-f-]{8,64}$/i.test(sessionId) || !existsSync(root)) return [];
  const base = existsSync(join(root, "brain")) ? join(root, "brain") : root;
  const logOf = (id) => join(base, id, ".system_generated", "logs", "transcript.jsonl");
  if (!existsSync(logOf(sessionId))) return [];
  const seen = new Set([sessionId]);
  const queue = [sessionId];
  const files = [];
  for (const id of queue) {
    const file = logOf(id);
    if (!existsSync(file)) continue;
    files.push(file);
    for (const sub of subagentIds(file)) {
      if (!seen.has(sub)) {
        seen.add(sub);
        queue.push(sub);
      }
    }
  }
  return files;
}

function codexMeta(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "session_meta" && parsed.payload && typeof parsed.payload === "object") {
        const meta = parsed.payload;
        const parent =
          meta.parent_thread_id ??
          meta.source?.subagent?.thread_spawn?.parent_thread_id ??
          (meta.session_id && meta.session_id !== meta.id ? meta.session_id : null);
        return { id: meta.id ?? null, sessionId: meta.session_id ?? null, parent: parent ?? null };
      }
    } catch {}
  }
  return null;
}

export function codexFiles(threadId, root = join(homedir(), ".codex")) {
  if (!threadId || !/^[0-9a-f-]{8,64}$/i.test(threadId) || !existsSync(root)) return [];
  const dirs = [join(root, "sessions"), join(root, "archived_sessions")].filter(existsSync);
  const allFiles = (dirs.length ? dirs : [root]).flatMap((dir) => walk(dir));
  const idLower = threadId.toLowerCase();
  const byId = new Map();
  const childrenOf = new Map();
  const direct = [];
  for (const file of allFiles) {
    const meta = codexMeta(file);
    const metaId = meta?.id?.toLowerCase();
    const matchesName = new RegExp(`-${idLower}(?:_[^/\\\\]+)?\\.jsonl$`, "i").test(file);
    if (metaId === idLower || (!metaId && matchesName)) {
      direct.push(file);
    }
    if (metaId) {
      if (!byId.has(metaId)) byId.set(metaId, []);
      byId.get(metaId).push(file);
      const parents = new Set([meta.parent?.toLowerCase(), meta.sessionId?.toLowerCase()].filter((p) => p && p !== metaId));
      for (const parent of parents) {
        if (!childrenOf.has(parent)) childrenOf.set(parent, new Set());
        childrenOf.get(parent).add(metaId);
      }
    }
  }
  if (!direct.length) return [];
  const seenThreads = new Set([idLower]);
  const queue = [idLower];
  const side = [];
  for (const current of queue) {
    for (const child of childrenOf.get(current) ?? []) {
      if (seenThreads.has(child)) continue;
      seenThreads.add(child);
      queue.push(child);
      for (const file of byId.get(child) ?? []) {
        if (!direct.includes(file)) side.push(file);
      }
    }
  }
  direct.sort().reverse();
  return [...direct, ...side];
}

const userRequest = (text) => {
  const match = String(text ?? "").match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return match ? match[1] : String(text ?? "");
};

function codexPartsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part?.type === "input_text" || part?.type === "text") && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function codexUsageEntry(usage, total, timestamp, file, fallbackId) {
  if (!usage || typeof usage !== "object") return null;
  const nonCachedInput = Math.max(0, (usage.input_tokens ?? 0) - (usage.cached_input_tokens ?? 0));
  const cacheWrite = Math.max(0, usage.cache_write_input_tokens ?? 0);
  const output = Math.max(0, usage.output_tokens ?? 0);
  if (!nonCachedInput && !cacheWrite && !output) return null;
  const id = `tc:${total?.total_tokens ?? fallbackId}`;
  return {
    type: "assistant",
    timestamp,
    sessionId: file,
    uuid: id,
    message: {
      id,
      usage: {
        input_tokens: nonCachedInput,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: Math.max(0, usage.cached_input_tokens ?? 0),
        output_tokens: output,
      },
    },
  };
}

function normalizeEntry(entry, file, index) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.timestamp === "string") {
    if (entry.type === "user" || entry.type === "assistant" || entry.message) return entry;
    const payload = entry.payload;
    if (entry.type === "response_item" && payload?.type === "message" && payload?.role === "user") {
      return {
        type: "user",
        timestamp: entry.timestamp,
        isSidechain: false,
        message: { role: "user", content: codexPartsText(payload.content) },
      };
    }
    if (entry.type === "event_msg" && payload?.type === "user_message") {
      return {
        type: "user",
        timestamp: entry.timestamp,
        isSidechain: false,
        message: { role: "user", content: String(payload.message ?? "") },
      };
    }
    if (entry.type === "event_msg" && payload?.type === "item_completed" && (payload.item?.type === "user_message" || payload.item?.type === "UserMessage")) {
      const text = typeof payload.item.message === "string" ? payload.item.message : codexPartsText(payload.item.content);
      return {
        type: "user",
        timestamp: entry.timestamp,
        isSidechain: false,
        message: { role: "user", content: text },
      };
    }
    if (entry.type === "event_msg" && payload?.type === "token_count") {
      return codexUsageEntry(payload.info?.last_token_usage, payload.info?.total_token_usage, entry.timestamp, file, entry.ordinal ?? index) ?? { type: "step", timestamp: entry.timestamp };
    }
    if (entry.type === "token_usage_record") {
      return codexUsageEntry(payload?.usage, payload?.thread_token_usage ?? payload?.turn_token_usage, entry.timestamp, file, payload?.response_id ?? entry.ordinal ?? index) ?? { type: "step", timestamp: entry.timestamp };
    }
    return { type: "step", timestamp: entry.timestamp };
  }
  if (typeof entry.created_at !== "string") return null;
  if (entry.type === "USER_INPUT" && (!entry.source || entry.source === "USER_EXPLICIT")) {
    return {
      type: "user",
      timestamp: entry.created_at,
      isSidechain: Boolean(entry.isSidechain),
      message: { role: "user", content: userRequest(entry.content) },
    };
  }
  if (entry.type === "PLANNER_RESPONSE" && (entry.input_tokens || entry.output_tokens)) {
    const id = String(entry.step_index ?? index);
    return {
      type: "assistant",
      timestamp: entry.created_at,
      sessionId: file,
      uuid: id,
      message: {
        id,
        usage: {
          input_tokens: entry.input_tokens ?? 0,
          cache_read_input_tokens: entry.cache_read_tokens ?? 0,
          output_tokens: entry.output_tokens ?? 0,
        },
      },
    };
  }
  return { type: "step", timestamp: entry.created_at };
}

function entriesOf(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = normalizeEntry(JSON.parse(line), file, out.length);
      if (entry) out.push(entry);
    } catch {}
  }
  return out;
}

const textOf = (entry) => {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
  return "";
};

const squash = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();

export function measure(files, { prompt = "" } = {}) {
  if (!files.length) return null;
  const [main, ...side] = files;
  const mainEntries = entriesOf(main).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const asks = mainEntries.filter((entry) => entry.type === "user" && !entry.isSidechain && textOf(entry));
  const head = squash(prompt).slice(0, 48);
  const start =
    (head ? asks.find((entry) => squash(textOf(entry)).includes(head)) : null) ??
    asks.find((entry) => /\/anatomy\b|\banatomy\b/i.test(textOf(entry))) ??
    mainEntries[0];
  if (!start) return null;
  const end = asks.find((entry) => entry.timestamp > start.timestamp && /\bpublish\b/i.test(textOf(entry)) && /\b(community|gallery)\b/i.test(textOf(entry)));
  const from = start.timestamp;
  const to = end?.timestamp ?? "\uffff";
  const inWindow = (entry) => entry.timestamp >= from && entry.timestamp < to;

  const all = [...mainEntries, ...side.flatMap(entriesOf)].filter(inWindow);
  const times = [...new Set(all.map((entry) => Date.parse(entry.timestamp)).filter(Number.isFinite))].sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < times.length; i++) active += Math.min(times[i] - times[i - 1], IDLE_CAP);

  const perMessage = new Map();
  for (const entry of all) {
    const usage = entry.type === "assistant" ? entry.message?.usage : null;
    if (!usage) continue;
    const key = `${entry.sessionId ?? ""}:${entry.agentId ?? ""}:${entry.message?.id ?? entry.uuid}`;
    const spent = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
    perMessage.set(key, Math.max(perMessage.get(key) ?? 0, spent));
  }
  const tokens = [...perMessage.values()].reduce((sum, spent) => sum + spent, 0);
  if (!tokens) return null;
  const last = end?.timestamp ?? (times.length ? new Date(times.at(-1)).toISOString() : from);
  return { minutes: Math.max(1, Math.round(active / 60000)), tokens, from, to: last };
}

export function fromThisSession({ prompt, env = process.env, root } = {}) {
  const files = env.CLAUDE_CODE_SESSION_ID
    ? sessionFiles(env.CLAUDE_CODE_SESSION_ID, root)
    : env.CODEX_THREAD_ID
      ? codexFiles(env.CODEX_THREAD_ID, root ?? env.CODEX_HOME)
      : antigravityFiles(env.ANTIGRAVITY_CONVERSATION_ID, root ?? env.ANTIGRAVITY_APP_DATA_DIR);
  return measure(files, { prompt });
}

export function describe({ minutes, tokens }) {
  const time = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  const count = tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1).replace(/\.0$/, "")}M` : tokens >= 1e3 ? `${Math.round(tokens / 1e3)}k` : String(tokens);
  return `about ${time} and ${count} tokens`;
}
