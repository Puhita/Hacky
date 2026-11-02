// The progress digest wording and cadence, with no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HackyApi, PulseMember } from "./api.js";
import { describeDigest, SidebarController } from "./controller.js";

const member = (overrides: Partial<PulseMember>): PulseMember => ({
  name: "Orlin",
  me: false,
  chats: 0,
  focus: [],
  updates: 0,
  latest: [],
  ...overrides,
});

test("the digest names each teammate who logged progress, and leaves out the person and quiet teammates", () => {
  assert.equal(describeDigest([member({}), member({ me: true, name: "Ann", updates: 4, latest: ["x"] })]), null);
  assert.equal(
    describeDigest([
      member({ updates: 1, latest: ["Finished login"] }),
      member({ name: "Maria", updates: 3, latest: ["Wired payments", "older"] }),
      member({ name: "Quiet" }),
    ]),
    'Team progress. Orlin: 1 update, latest "Finished login". Maria: 3 updates, latest "Wired payments".',
  );
});

function controller(options: { minutes: number; pulse: PulseMember[]; savedAt?: number }) {
  const notified: string[] = [];
  const saved: number[] = [];
  const pulseCalls: Date[] = [];
  const api = {
    pulse: async (_team: string, since: Date) => {
      pulseCalls.push(since);
      return options.pulse;
    },
  } as unknown as HackyApi;
  const instance = new SidebarController({
    api,
    supabaseUrl: "",
    publishableKey: "",
    workspaceDir: () => null,
    loadTeamId: () => "team-1",
    saveTeamId: () => {},
    post: () => {},
    digestMinutes: () => options.minutes,
    loadDigestAt: () => options.savedAt,
    saveDigestAt: (at) => saved.push(at),
    notify: (message) => notified.push(message),
  });
  return { instance, notified, saved, pulseCalls };
}

test("a digest is sent once the cadence has passed, covering the time since the last one", async () => {
  const lastAt = Date.now() - 31 * 60_000;
  const { instance, notified, saved, pulseCalls } = controller({
    minutes: 30,
    savedAt: lastAt,
    pulse: [member({ updates: 2, latest: ["Added tests"] })],
  });
  await instance.digest();
  instance.dispose();
  assert.deepEqual(notified, ['Team progress. Orlin: 2 updates, latest "Added tests".']);
  assert.equal(pulseCalls[0].getTime(), lastAt);
  assert.equal(saved.length, 1);
});

test("no digest before the cadence has passed, when it is off, or when nobody logged anything", async () => {
  const early = controller({ minutes: 30, savedAt: Date.now() - 5 * 60_000, pulse: [member({ updates: 1, latest: ["x"] })] });
  await early.instance.digest();
  const off = controller({ minutes: 0, savedAt: Date.now() - 999 * 60_000, pulse: [member({ updates: 1, latest: ["x"] })] });
  await off.instance.digest();
  const quiet = controller({ minutes: 30, savedAt: Date.now() - 60 * 60_000, pulse: [member({})] });
  await quiet.instance.digest();
  for (const { instance } of [early, off, quiet]) instance.dispose();
  assert.deepEqual([early.notified, off.notified, quiet.notified], [[], [], []]);
  assert.equal(early.pulseCalls.length + off.pulseCalls.length, 0);
  assert.equal(quiet.saved.length, 1, "a quiet period still starts the next one");
});
