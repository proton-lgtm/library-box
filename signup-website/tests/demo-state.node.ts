import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_GAMES, createDemoState, demoReducer } from "../src/lib/demo-state.ts";
import type { DemoAction, DemoState } from "../src/lib/demo-state.ts";

const preinstalled = DEMO_GAMES[0];
const downloadable = DEMO_GAMES[1];
const download: DemoAction = { type: "download", gameId: downloadable.id };
const mods = preinstalled.mods.map(({ id }) => id);
const apply: DemoAction = { type: "apply-mods", gameId: preinstalled.id, modIds: mods };

function ticks(state: DemoState, count = 10): DemoState {
  for (let i = 0; i < count; i++) state = demoReducer(state, { type: "tick" });
  return state;
}

function freeze(value: object): void {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freeze(child);
  }
}

test("six typed fixtures have unique IDs, display metadata, and valid mods", () => {
  assert.equal(DEMO_GAMES.length, 6);
  assert.equal(new Set(DEMO_GAMES.map(({ id }) => id)).size, 6);
  for (const game of DEMO_GAMES) {
    assert.ok(game.id && game.name && game.description && game.sizeLabel);
    assert.equal(game.palette.length, 3);
    assert.ok(game.palette.every((color) => /^#[0-9A-F]{6}$/i.test(color)));
    assert.ok(game.mods.length >= 2);
    assert.equal(new Set(game.mods.map(({ id }) => id)).size, game.mods.length);
    assert.ok(game.mods.every(({ id, name }) => id && name));
  }
});

test("initial state contains exactly one preinstalled game and is freshly allocated", () => {
  const state = createDemoState();
  const expected: DemoState = { jobs: [], installed: { [preinstalled.id]: { appliedModIds: [] } } };
  assert.deepEqual(state, expected);
  state.installed[preinstalled.id].appliedModIds.push("changed");
  state.jobs.push({ id: "external", gameId: preinstalled.id, kind: "game", modIds: [], status: "paused", progress: 0 });
  assert.deepEqual(createDemoState().jobs, []);
  assert.deepEqual(createDemoState().installed[preinstalled.id].appliedModIds, []);
});

test("download progresses by ten and installs only at completion", () => {
  let state = demoReducer(createDemoState(), download);
  assert.deepEqual(state.jobs[0], { id: "job-1", gameId: downloadable.id, kind: "game", modIds: [], status: "downloading", progress: 0 });
  for (let i = 1; i <= 9; i++) {
    state = ticks(state, 1);
    assert.equal(state.jobs[0].progress, i * 10);
    assert.equal(state.installed[downloadable.id], undefined);
  }
  state = ticks(state, 1);
  assert.equal(state.jobs[0].status, "completed");
  assert.equal(state.jobs[0].progress, 100);
  assert.deepEqual(state.installed[downloadable.id], { appliedModIds: [] });
  assert.strictEqual(ticks(state, 20), state);
});

test("pause freezes progress without committing, and resume continues", () => {
  let state = ticks(demoReducer(createDemoState(), download), 9);
  state = demoReducer(state, { type: "pause", jobId: "job-1" });
  assert.equal(state.jobs[0].status, "paused");
  assert.strictEqual(ticks(state, 20), state);
  assert.equal(state.jobs[0].progress, 90);
  assert.equal(state.installed[downloadable.id], undefined);
  state = ticks(demoReducer(state, { type: "resume", jobId: "job-1" }), 1);
  assert.equal(state.jobs[0].status, "completed");
  assert.ok(state.installed[downloadable.id]);
});

for (const paused of [false, true]) {
  test(`cancelling ${paused ? "paused" : "downloading"} work never commits and permits retry`, () => {
    let state = ticks(demoReducer(createDemoState(), download), 9);
    if (paused) state = demoReducer(state, { type: "pause", jobId: "job-1" });
    state = demoReducer(state, { type: "cancel", jobId: "job-1" });
    assert.equal(state.jobs[0].status, "cancelled");
    assert.equal(state.jobs[0].progress, 90);
    assert.strictEqual(ticks(state, 20), state);
    assert.equal(state.installed[downloadable.id], undefined);
    state = demoReducer(state, download);
    assert.equal(state.jobs[1].id, "job-2");
    assert.equal(state.jobs[1].progress, 0);
    assert.ok(ticks(state).installed[downloadable.id]);
  });
}

test("unknown games and already-installed downloads are ignored", () => {
  const state = createDemoState();
  for (const gameId of ["unknown", "__proto__", "constructor", preinstalled.id]) {
    assert.strictEqual(demoReducer(state, { type: "download", gameId }), state);
    if (gameId !== preinstalled.id) {
      assert.strictEqual(demoReducer(state, { type: "apply-mods", gameId, modIds: mods }), state);
    }
  }
});

test("unfinished same-game work is rejected, including paused jobs and cross-kind work", () => {
  for (const action of [download, apply]) {
    let state = demoReducer(createDemoState(), action);
    for (const paused of [false, true]) {
      if (paused) state = demoReducer(state, { type: "pause", jobId: "job-1" });
      assert.strictEqual(demoReducer(state, action), state);
      assert.strictEqual(demoReducer(state, { type: "download", gameId: action.gameId }), state);
      assert.strictEqual(demoReducer(state, { type: "apply-mods", gameId: action.gameId, modIds: DEMO_GAMES.find(({ id }) => id === action.gameId)!.mods.map(({ id }) => id) }), state);
    }
  }
});

test("mod jobs require an installed game and reject empty or invalid selections atomically", () => {
  const state = createDemoState();
  for (const modIds of [[], ["unknown"], [mods[0], "unknown"], [downloadable.mods[0].id]]) {
    assert.strictEqual(demoReducer(state, { ...apply, modIds }), state);
  }
  assert.strictEqual(demoReducer(state, { type: "apply-mods", gameId: downloadable.id, modIds: [downloadable.mods[0].id] }), state);
});

test("mods are deduplicated, applied only on completion, and accumulated without repeats", () => {
  let state = demoReducer(createDemoState(), { ...apply, modIds: [mods[0], mods[0]] });
  assert.equal(state.jobs[0].kind, "mod");
  assert.deepEqual(state.jobs[0].modIds, [mods[0]]);
  state = ticks(state, 9);
  assert.deepEqual(state.installed[preinstalled.id].appliedModIds, []);
  state = ticks(state, 1);
  assert.deepEqual(state.installed[preinstalled.id].appliedModIds, [mods[0]]);
  assert.strictEqual(demoReducer(state, { ...apply, modIds: [mods[0]] }), state);
  state = demoReducer(state, { ...apply, modIds: [mods[0], mods[1], mods[1]] });
  assert.deepEqual(state.jobs[1].modIds, [mods[1]]);
  state = ticks(state);
  assert.deepEqual(state.installed[preinstalled.id].appliedModIds, mods);
  assert.strictEqual(demoReducer(state, apply), state);
});

test("paused and cancelled mod jobs preserve previously applied mods", () => {
  let state = ticks(demoReducer(createDemoState(), { ...apply, modIds: [mods[0]] }));
  state = ticks(demoReducer(state, { ...apply, modIds: [mods[1]] }), 9);
  state = demoReducer(state, { type: "pause", jobId: "job-2" });
  assert.strictEqual(ticks(state), state);
  assert.deepEqual(state.installed[preinstalled.id].appliedModIds, [mods[0]]);
  state = demoReducer(state, { type: "cancel", jobId: "job-2" });
  assert.strictEqual(ticks(state), state);
  assert.deepEqual(state.installed[preinstalled.id].appliedModIds, [mods[0]]);
});

test("different games progress concurrently and paused jobs do not block others", () => {
  let state = demoReducer(demoReducer(createDemoState(), download), apply);
  state = demoReducer(state, { type: "pause", jobId: "job-1" });
  state = ticks(state);
  assert.equal(state.jobs[0].progress, 0);
  assert.equal(state.jobs[1].status, "completed");
  assert.deepEqual(state.installed[preinstalled.id].appliedModIds, mods);
  state = ticks(demoReducer(state, { type: "resume", jobId: "job-1" }));
  assert.ok(state.installed[downloadable.id]);
  const concurrent = ticks(demoReducer(demoReducer(createDemoState(), download), apply));
  assert.ok(concurrent.jobs.every(({ status }) => status === "completed"));
  assert.ok(concurrent.installed[downloadable.id]);
  assert.deepEqual(concurrent.installed[preinstalled.id].appliedModIds, mods);
});

test("invalid lifecycle transitions and missing job IDs are no-ops", () => {
  for (const state of [createDemoState(), demoReducer(createDemoState(), download), ticks(demoReducer(createDemoState(), download)), demoReducer(demoReducer(createDemoState(), download), { type: "cancel", jobId: "job-1" })]) {
    for (const type of ["pause", "resume", "cancel"] as const) {
      assert.strictEqual(demoReducer(state, { type, jobId: "missing" }), state);
      if (state.jobs[0]?.status === "completed" || state.jobs[0]?.status === "cancelled" || type === "resume") {
        assert.strictEqual(demoReducer(state, { type, jobId: "job-1" }), state);
      }
    }
  }
  const paused = demoReducer(demoReducer(createDemoState(), download), { type: "pause", jobId: "job-1" });
  assert.strictEqual(demoReducer(paused, { type: "pause", jobId: "job-1" }), paused);
});

test("transitions are deterministic and never mutate states, action arrays, or fixtures", () => {
  const original = createDemoState();
  const action = { ...apply, modIds: [...mods] };
  freeze(original);
  freeze(action);
  freeze(DEMO_GAMES);
  const queued = demoReducer(original, action);
  assert.notStrictEqual(queued.jobs[0].modIds, action.modIds);
  freeze(queued);
  const paused = demoReducer(queued, { type: "pause", jobId: "job-1" });
  freeze(paused);
  const resumed = demoReducer(paused, { type: "resume", jobId: "job-1" });
  freeze(resumed);
  const completed = ticks(resumed);
  assert.deepEqual(completed, ticks(demoReducer(createDemoState(), action)));
  assert.deepEqual(original, createDemoState());
  assert.deepEqual(queued.installed, original.installed);
  assert.deepEqual(queued.jobs[0].progress, 0);
  assert.deepEqual(action.modIds, mods);
});

test("reset restores a fresh initial state and restarts deterministic IDs", () => {
  const state = ticks(demoReducer(demoReducer(createDemoState(), download), apply));
  const reset = demoReducer(state, { type: "reset" });
  assert.deepEqual(reset, createDemoState());
  assert.notStrictEqual(reset, demoReducer(state, { type: "reset" }));
  reset.installed[preinstalled.id].appliedModIds.push("changed");
  assert.deepEqual(demoReducer(state, { type: "reset" }), createDemoState());
  assert.equal(demoReducer(demoReducer(state, { type: "reset" }), download).jobs[0].id, "job-1");
});
