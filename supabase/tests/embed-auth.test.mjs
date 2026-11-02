// Proves only signed-in users can call the embedding function.
// Run with: node --env-file=.env --test supabase/tests/embed-auth.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, options);
const endpoint = `${SUPABASE_URL}/functions/v1/embed`;
const body = JSON.stringify({ text: "hello" });
const baseHeaders = { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" };

let userId;
let accessToken;

before(async () => {
  const email = `hacky-test-embed-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("hex");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  userId = data.user.id;
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, options);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  accessToken = signedIn.data.session.access_token;
});

after(async () => {
  await admin.auth.admin.deleteUser(userId);
});

const post = (headers, payload = body) => fetch(endpoint, { method: "POST", headers, body: payload });

test("the publishable key alone is refused", async () => {
  assert.equal((await post(baseHeaders)).status, 401);
});

test("the publishable key as a bearer token is refused", async () => {
  const response = await post({ ...baseHeaders, Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}` });
  assert.equal(response.status, 401);
});

test("a made-up token is refused", async () => {
  assert.equal((await post({ ...baseHeaders, Authorization: "Bearer not-a-real-token" })).status, 401);
});

test("no credentials at all are refused", async () => {
  assert.equal((await post({ "Content-Type": "application/json" })).status, 401);
});

test("a signed-in user gets a 384-dimension embedding", async () => {
  const response = await post({ ...baseHeaders, Authorization: `Bearer ${accessToken}` });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).embedding.length, 384);
});

test("bad input is rejected for a signed-in user", async () => {
  const response = await post({ ...baseHeaders, Authorization: `Bearer ${accessToken}` }, JSON.stringify({ text: "  " }));
  assert.equal(response.status, 400);
});
