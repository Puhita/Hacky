import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "./redact.js";

const SECRETS = [
  "sb_secret_abcdefghijklmnop123456",
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
  "ghp_abcdefghijklmnopqrstuvwxyz123456",
  "github_pat_abcdefghijklmnopqrstuvwxyz_123",
  "AKIAIOSFODNN7EXAMPLE",
  "xoxb-1234567890-abcdefghij",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456",
];

for (const secret of SECRETS) {
  test(`removes ${secret.slice(0, 8)}...`, () => {
    const result = redact(`the value is ${secret} right here`);
    assert.ok(!result.includes(secret), result);
    assert.match(result, /^the value is \[REDACTED\] right here$/);
  });
}

test("removes .env style assignments and keeps the names", () => {
  const env = 'SUPABASE_SECRET_KEY=hunter2\nDB_PASSWORD="two words"\napi_key: abc123\nPORT=3000';
  const result = redact(env);
  for (const value of ["hunter2", "two words", "abc123"]) assert.ok(!result.includes(value), result);
  assert.match(result, /SUPABASE_SECRET_KEY=\[REDACTED\]/);
  assert.match(result, /PORT=3000/);
});

test("removes passwords from connection strings", () => {
  const result = redact("postgres://admin:hunter2@db.example.com:5432/app");
  assert.ok(!result.includes("hunter2"), result);
  assert.match(result, /db\.example\.com/);
});

test("removes bearer tokens and private keys", () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----";
  assert.equal(redact(`before ${key} after`), "before [REDACTED] after");
  assert.equal(redact("Bearer abcdefghijklmnop1234"), "Bearer [REDACTED]");
});

test("leaves ordinary text alone", () => {
  const text = "Fixed the token refresh bug in src/auth.ts and raised the discount to 17% (see PR #12).";
  assert.equal(redact(text), text);
});
