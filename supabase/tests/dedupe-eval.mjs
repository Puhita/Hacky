// Measures how well embedding similarity separates paraphrases from similar but different
// questions. Odd-numbered pairs tune the threshold; even-numbered pairs are the holdout.
// Run from the repo root: node --env-file=.env supabase/tests/dedupe-eval.mjs
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, options);
const pairs = JSON.parse(readFileSync(new URL("./dedupe-pairs.json", import.meta.url), "utf8"));

const email = `hacky-test-eval-${randomBytes(6).toString("hex")}@example.com`;
const password = randomBytes(24).toString("hex");
const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (createError) throw createError;

try {
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, options);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  const cache = new Map();
  async function embed(text) {
    if (!cache.has(text)) {
      const { data, error } = await client.functions.invoke("embed", { body: { text } });
      if (error) throw new Error(`embed failed: ${error.message}`);
      cache.set(text, data.embedding);
    }
    return cache.get(text);
  }
  const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const score = async (list) => {
    const scored = [];
    for (const [first, second] of list) scored.push({ first, second, similarity: cosine(await embed(first), await embed(second)) });
    return scored;
  };

  const paraphrases = await score(pairs.paraphrases);
  const nearMisses = await score(pairs.near_misses);
  console.log("dimensions:", cache.values().next().value.length);

  const tuning = (list) => list.filter((_, index) => index % 2 === 0);
  const holdout = (list) => list.filter((_, index) => index % 2 === 1);
  const above = (list, threshold) => list.filter((pair) => pair.similarity >= threshold).length;

  // The lowest threshold with no wrong merges on the tuning half, plus a small margin.
  const MARGIN = 0.01;
  const threshold = Math.max(...tuning(nearMisses).map((pair) => pair.similarity)) + MARGIN;
  const rounded = Math.round(threshold * 1000) / 1000;

  const line = (name, list) =>
    `${name}: min ${Math.min(...list.map((p) => p.similarity)).toFixed(3)}, max ${Math.max(...list.map((p) => p.similarity)).toFixed(3)}`;
  console.log(line("paraphrases", paraphrases));
  console.log(line("near misses", nearMisses));
  console.log(`\nthreshold from tuning half: ${rounded}`);
  console.log(`tuning: ${above(tuning(paraphrases), rounded)}/${tuning(paraphrases).length} paraphrases merged, ${above(tuning(nearMisses), rounded)}/${tuning(nearMisses).length} wrong merges`);
  console.log(`HOLDOUT: ${above(holdout(paraphrases), rounded)}/${holdout(paraphrases).length} paraphrases merged, ${above(holdout(nearMisses), rounded)}/${holdout(nearMisses).length} wrong merges`);

  // The agent judges candidates, so this threshold only has to keep true paraphrases in view.
  const candidateThreshold = Math.floor((Math.min(...tuning(paraphrases).map((pair) => pair.similarity)) - MARGIN) * 100) / 100;
  console.log(`\ncandidate threshold from tuning half: ${candidateThreshold} (lowest tuning paraphrase less ${MARGIN})`);
  console.log(`HOLDOUT shown as candidates: ${above(holdout(paraphrases), candidateThreshold)}/${holdout(paraphrases).length} paraphrases, ${above(holdout(nearMisses), candidateThreshold)}/${holdout(nearMisses).length} near misses`);

  console.log("\nhighest near misses:");
  for (const pair of [...nearMisses].sort((a, b) => b.similarity - a.similarity).slice(0, 6)) {
    console.log(`  ${pair.similarity.toFixed(3)}  ${pair.first} | ${pair.second}`);
  }
  console.log("lowest paraphrases:");
  for (const pair of [...paraphrases].sort((a, b) => a.similarity - b.similarity).slice(0, 6)) {
    console.log(`  ${pair.similarity.toFixed(3)}  ${pair.first} | ${pair.second}`);
  }

  // A signed-out caller must be refused by the function's JWT check.
  const response = await fetch(`${SUPABASE_URL}/functions/v1/embed`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  console.log(`\nsigned-out call status: ${response.status}`);
} finally {
  await admin.auth.admin.deleteUser(created.user.id);
}
