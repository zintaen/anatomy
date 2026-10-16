import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describe, fromThisSession, measure, parseMinutes, parseTokens } from "./session.mjs";

const at = (minute) => new Date(Date.UTC(2026, 9, 12, 10, 0) + minute * 60000).toISOString();
const user = (minute, text) => ({ type: "user", timestamp: at(minute), message: { role: "user", content: text } });
const reply = (minute, id, input, output, extra = {}) => ({ type: "assistant", timestamp: at(minute), message: { id, usage: { input_tokens: input, cache_creation_input_tokens: 1000, cache_read_input_tokens: 999999, output_tokens: output } }, ...extra });
const lines = (entries) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

function session() {
  const root = mkdtempSync(join(tmpdir(), "session-"));
  const id = "0123abcd-0000-0000-0000-000000000000";
  mkdirSync(join(root, "-work", id, "subagents"), { recursive: true });
  writeFileSync(join(root, "-work", `${id}.jsonl`), lines([
    user(0, "fix the readme"),
    reply(1, "m0", 50, 50),
    user(5, "/anatomy explain how a token bucket works, interactive"),
    reply(6, "m1", 100, 200),
    reply(6, "m1", 100, 400),
    reply(8, "m2", 10, 20),
    reply(70, "m3", 10, 20),
    user(80, "publish this figure to the community gallery"),
    reply(81, "m4", 5000, 5000),
  ]));
  writeFileSync(join(root, "-work", id, "subagents", "agent-1.jsonl"), lines([reply(7, "s1", 300, 300, { isSidechain: true, agentId: "a1" })]));
  return { root, id };
}

test("time and tokens cover the figure's request up to the publish request", () => {
  const { root, id } = session();
  try {
    const result = fromThisSession({ prompt: "/anatomy explain how a token bucket works, interactive", env: { CLAUDE_CODE_SESSION_ID: id }, root });
    assert.equal(result.tokens, 1100 + 400 + 1030 + 1030 + 1600);
    assert.equal(result.minutes, 3 + 10);
    assert.equal(result.from, at(5));
    assert.equal(result.to, at(80));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Antigravity session logs and spawned subagents are measured with cache reads excluded", () => {
  const root = mkdtempSync(join(tmpdir(), "ag-session-"));
  const id = "9d87af63-630e-42ed-8404-af8cbbb7b817";
  const sub = "392d4fbf-0095-4e51-90c2-ff002d49f757";
  try {
    mkdirSync(join(root, "brain", id, ".system_generated", "logs"), { recursive: true });
    mkdirSync(join(root, "brain", sub, ".system_generated", "logs"), { recursive: true });
    const agUser = (step, minute, text) => ({
      step_index: step,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: at(minute),
      content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>`,
    });
    const agReply = (step, minute, input, output, cache = 999999) => ({
      step_index: step,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: at(minute),
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cache,
    });
    writeFileSync(join(root, "brain", id, ".system_generated", "logs", "transcript.jsonl"), lines([
      agUser(0, 0, "check git status"),
      agReply(1, 1, 50, 50),
      agUser(2, 5, "/anatomy explain how a token bucket works, interactive"),
      agReply(3, 6, 1100, 400),
      {
        step_index: 4,
        source: "MODEL",
        type: "GENERIC",
        created_at: at(6),
        content: `Created At: ${at(6)}\nCompleted At: ${at(6)}\nCreated the following subagents:\n{\n  "conversationId": "${sub}"\n}`,
      },
      {
        step_index: 5,
        source: "MODEL",
        type: "GENERIC",
        created_at: at(7),
        content: `Created At: ${at(7)}\nCompleted At: ${at(7)}\n\nThe command exited with code 0.\nOutput:\nCreated the following subagents:\n{\n  "conversationId": "00000000-0000-0000-0000-000000000000"\n}`,
      },
      agReply(6, 8, 1010, 20),
      agReply(7, 70, 1010, 20),
      agUser(8, 80, "publish this figure to the community gallery"),
      agReply(9, 81, 5000, 5000),
    ]));
    writeFileSync(join(root, "brain", sub, ".system_generated", "logs", "transcript.jsonl"), lines([
      agUser(0, 6, "research the token bucket parts"),
      agReply(1, 7, 1300, 300),
    ]));
    const result = fromThisSession({
      prompt: "/anatomy explain how a token bucket works, interactive",
      env: { ANTIGRAVITY_CONVERSATION_ID: id, ANTIGRAVITY_APP_DATA_DIR: root },
    });
    assert.equal(result.tokens, 1500 + 1030 + 1030 + 1600);
    assert.equal(result.minutes, 3 + 10);
    assert.equal(result.from, at(5));
    assert.equal(result.to, at(80));

    const withoutPrompt = fromThisSession({
      env: { ANTIGRAVITY_CONVERSATION_ID: id, ANTIGRAVITY_APP_DATA_DIR: root },
    });
    assert.deepEqual(withoutPrompt, result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex rollout logs and spawned subagent threads are measured with cached_input_tokens excluded", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-session-"));
  const id = "5973b6c0-94b8-487b-a530-2aeb6098ae0e";
  const sub = "88a1c2d0-1111-4222-9333-444455556666";
  try {
    const dayDir = join(root, "sessions", "2026", "10", "12");
    mkdirSync(dayDir, { recursive: true });
    const codexUser = (minute, text) => ({
      timestamp: at(minute),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    const codexTokenCount = (minute, totalTokens, input, cached, output, cacheWrite = 0) => ({
      timestamp: at(minute),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: totalTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: cacheWrite,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: totalTokens,
          },
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            cache_write_input_tokens: cacheWrite,
            output_tokens: output,
            reasoning_output_tokens: 50,
            total_tokens: input + output,
          },
        },
      },
    });
    writeFileSync(
      join(dayDir, `rollout-2026-10-12T10-00-00-${id}.jsonl`),
      lines([
        {
          timestamp: at(0),
          type: "session_meta",
          payload: { id, session_id: id, timestamp: at(0), cwd: "/tmp", originator: "codex_cli_rs", cli_version: "0.42.0", source: "cli" },
        },
        codexUser(0, "fix typo"),
        codexTokenCount(1, 100, 80, 30, 50),
        codexUser(5, "/anatomy explain how a token bucket works, interactive"),
        codexTokenCount(6, 2500, 5100, 4000, 400),
        codexTokenCount(6, 2500, 5100, 4000, 400),
        codexTokenCount(8, 3530, 2010, 1000, 20),
        codexTokenCount(70, 4560, 2010, 1000, 20),
        codexUser(80, "publish this figure to the community gallery"),
        codexTokenCount(81, 15000, 6000, 1000, 5000),
      ]),
    );
    writeFileSync(
      join(dayDir, `rollout-2026-10-12T10-06-00-${sub}.jsonl`),
      lines([
        {
          timestamp: at(6),
          type: "session_meta",
          payload: {
            id: sub,
            session_id: id,
            parent_thread_id: id,
            timestamp: at(6),
            cwd: "/tmp",
            originator: "codex_cli_rs",
            cli_version: "0.42.0",
            source: { subagent: { thread_spawn: { parent_thread_id: id, depth: 1 } } },
          },
        },
        codexTokenCount(7, 1600, 3300, 2000, 300),
        {
          timestamp: at(7),
          type: "token_usage_record",
          payload: {
            thread_id: sub,
            turn_id: "t1",
            session_id: id,
            root_turn_id: "rt1",
            response_id: "resp_1",
            usage: { input_tokens: 3300, cached_input_tokens: 2000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 50, total_tokens: 3600 },
            turn_token_usage: { input_tokens: 3300, cached_input_tokens: 2000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 50, total_tokens: 1600 },
            thread_token_usage: { input_tokens: 3300, cached_input_tokens: 2000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 50, total_tokens: 1600 },
          },
        },
      ]),
    );
    const result = fromThisSession({
      prompt: "/anatomy explain how a token bucket works, interactive",
      env: { CODEX_THREAD_ID: id, CODEX_HOME: root },
    });
    assert.equal(result.tokens, 1500 + 1030 + 1030 + 1600);
    assert.equal(result.minutes, 3 + 10);
    assert.equal(result.from, at(5));
    assert.equal(result.to, at(80));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no session, no numbers", () => {
  assert.equal(fromThisSession({ env: {} }), null);
  assert.equal(measure([]), null);
});

test("hand-given values are read like the gallery reads them", () => {
  assert.equal(parseMinutes("1h30m"), 90);
  assert.equal(parseMinutes("45"), 45);
  assert.equal(parseMinutes("soon"), undefined);
  assert.equal(parseTokens("1.2M"), 1200000);
  assert.equal(parseTokens("450k"), 450000);
  assert.equal(parseTokens("lots"), undefined);
  assert.equal(describe({ minutes: 95, tokens: 1240000 }), "about 1 h 35 min and 1.2M tokens");
});
