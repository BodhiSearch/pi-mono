/**
 * Core e2e suite for cli-acp-client.
 *
 * One CLI process is booted in `beforeAll` (with /host + OAuth /login
 * + /model selection) and shared across every test in this file. That
 * keeps the BodhiApp NAPI + Keycloak + browser dance to a single
 * up-front cost while letting each test exercise an isolated slash
 * command path. Within a test we use `test.step` for state-evolving
 * scenarios (e.g. add → list → remove) so a failure log pinpoints
 * which cycle broke without us having to over-fragment into separate
 * tests.
 *
 * State considerations:
 *   - sessions, volumes, kv (requestedMcps, lastModelId) accumulate
 *     across tests in the same harness. Tests that mutate state are
 *     responsible for naming their fixtures uniquely (volume mount
 *     names, MCP urls) so two tests never alias.
 *   - tests that need a clean state (none today) should split into a
 *     separate spec file with its own beforeAll.
 *
 * Skipped paths (covered by the unit tests in `src/`):
 *   - argument-parsing edge cases for /volume, /feature, /mcp, /session,
 *   - error branches that don't exercise the wire (validation, etc.).
 */

import { test } from '@playwright/test';
import { bootAndAuth } from './tests/utils/boot-and-auth';
import type { CliHarness } from './tests/utils/cli-harness';
import type { TestState } from './tests/global-setup';

let harness: CliHarness;
let state: TestState;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const booted = await bootAndAuth(browser);
  harness = booted.harness;
  state = booted.state;
});

test.afterAll(async () => {
  if (!harness) return;
  try {
    harness.send('/quit');
    await harness.stop();
  } finally {
    harness.cleanup();
  }
});

test('host + models + prompt round-trip', async () => {
  await test.step('/models lists the registered model', async () => {
    harness.send('/models');
    await harness.waitForFresh(new RegExp(state.modelId.replace(/[/.]/g, '\\$&')), 30_000);
    await harness.waitForIdle(30_000);
  });

  await test.step('a plain prompt streams a reply', async () => {
    // Sentinel keeps the assistant text identifiable. Streaming chunks
    // share a renderId so only the FIRST is tagged `[bot]` and the
    // rest are `[stream]`. Bash-tool stdout lines also use `[stream]`,
    // but they're prefixed with `[in_progress]`/`[completed]`/etc. or
    // begin with a JSON `{` — we exclude those via a lookahead that
    // demands the next char be alphanumeric.
    harness.send(
      'Without using any tools, reply with exactly this single token and nothing else: PONG-SENTINEL.'
    );
    await harness.waitForFresh(/^\[(?:bot|stream)\] (?=[A-Za-z]).*PONG-SENTINEL/, 120_000);
    await harness.waitForIdle(60_000);
  });
});

test('/info builtin renders session stats and bypasses model gate', async () => {
  harness.send('/info');
  // `/info` is a builtin — it bypasses the LLM and emits a deterministic
  // multi-line markdown block. We pin on the bolded `**Session**`
  // header (only the builtin emits this) and the active model id.
  // waitForFresh ignores historical lines from earlier tests.
  await harness.waitForFresh(/\*\*Session\*\*/, 30_000);
  await harness.waitForFresh(new RegExp(state.modelId.replace(/[/.]/g, '\\$&')), 30_000);
  await harness.waitForIdle(15_000);
});

test('/feature list and toggle', async () => {
  await test.step('list emits known feature keys', async () => {
    harness.send('/feature list');
    // The list output contains one line per feature key. `bashEnabled`
    // is the canonical key the bash tool gates on.
    await harness.waitForFresh(/bashEnabled/, 30_000);
    await harness.waitForIdle(10_000);
  });

  await test.step('set bashEnabled off and read back', async () => {
    harness.send('/feature bashEnabled off');
    await harness.waitForFresh(/Feature 'bashEnabled' set to off/, 30_000);
    await harness.waitForIdle(10_000);
    harness.send('/feature list');
    await harness.waitForFresh(/bashEnabled\s+off/, 30_000);
    await harness.waitForIdle(10_000);
  });

  await test.step('restore bashEnabled to on so later bash tests work', async () => {
    harness.send('/feature bashEnabled on');
    await harness.waitForFresh(/Feature 'bashEnabled' set to on/, 30_000);
    await harness.waitForIdle(10_000);
  });
});
