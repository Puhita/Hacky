// Sign in with GitHub through the controller, with GitHub and the team database faked.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HackyApi } from "./api.js";
import { SidebarController, type SidebarState } from "./controller.js";
import { readAccount, type GithubFetch } from "./github.js";

// Nobody is logged in to Hacky, so a refresh touches nothing but the message it shows.
const api = { currentUser: async () => null, subscribe: () => () => {} } as unknown as HackyApi;

function setup(extra: Partial<ConstructorParameters<typeof SidebarController>[0]>) {
  const dir = mkdtempSync(join(tmpdir(), "hacky-ghc-"));
  const states: SidebarState[] = [];
  const opened: string[] = [];
  const controller = new SidebarController({
    api,
    supabaseUrl: "https://x.supabase.co",
    publishableKey: "k",
    workspaceDir: () => null,
    loadTeamId: () => undefined,
    saveTeamId: () => {},
    post: (state) => states.push(state),
    githubTokenFile: join(dir, "github-token"),
    openExternal: (url) => opened.push(url),
    ...extra,
  });
  return { dir, states, opened, controller, file: join(dir, "github-token"), done: () => (controller.dispose(), rmSync(dir, { recursive: true, force: true })) };
}

test("the device flow opens GitHub, waits for approval and saves the account on this computer", async () => {
  let polls = 0;
  const fake: GithubFetch = async (url) => {
    const body = url.endsWith("/login/device/code")
      ? { device_code: "dev1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }
      : url.endsWith("/login/oauth/access_token")
        ? ++polls === 1
          ? { error: "authorization_pending" }
          : { access_token: "gho_abc" }
        : { login: "ana" };
    return { ok: true, status: 200, json: async () => body };
  };
  const { controller, opened, states, file, done } = setup({ githubClientId: "client1", githubFetch: fake });
  try {
    await controller.handle({ type: "githubSignIn" });
    assert.deepEqual(opened, ["https://github.com/login/device"]);
    // The first answer is "pending", the second the token: two 5-second waits.
    const deadline = Date.now() + 20_000;
    while (!readAccount(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(readAccount(file), { token: "gho_abc", login: "ana", via: "signin" });
    assert.match(states.at(-1)?.notice ?? "", /Signed in to GitHub as ana/);
  } finally {
    done();
  }
});

test("cancelling stops the wait without saving anything", async () => {
  const fake: GithubFetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith("/login/device/code") ? { device_code: "d", user_code: "U-1", verification_uri: "https://github.com/login/device", interval: 5 } : { access_token: "gho_late" }),
  });
  const { controller, file, done } = setup({ githubClientId: "client1", githubFetch: fake });
  try {
    await controller.handle({ type: "githubSignIn" });
    await controller.handle({ type: "githubCancelSignIn" });
    await new Promise((resolve) => setTimeout(resolve, 5_600));
    assert.equal(readAccount(file), null);
  } finally {
    done();
  }
});

test("a host with its own GitHub sign-in uses it, and signing out removes the account", async () => {
  const { controller, file, states, done } = setup({ githubSignIn: async () => ({ token: "gho_vs", login: "bo" }) });
  try {
    await controller.handle({ type: "githubSignIn" });
    assert.deepEqual(readAccount(file), { token: "gho_vs", login: "bo", via: "signin" });
    assert.match(states.at(-1)?.notice ?? "", /as bo/);
    await controller.handle({ type: "removeGithubToken" });
    assert.equal(readAccount(file), null);
  } finally {
    done();
  }
});

test("without a client ID or a host sign-in, the person is told to use a token", async () => {
  const { controller, states, done } = setup({});
  try {
    await controller.handle({ type: "githubSignIn" });
    assert.match(states.at(-1)?.error ?? "", /Use a token instead/);
  } finally {
    done();
  }
});
