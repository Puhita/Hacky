#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { defaultCredentialsFile, fileStorage } from "./credentials.js";
import { createServer } from "./tools.js";

const { HACKY_SUPABASE_URL, HACKY_SUPABASE_PUBLISHABLE_KEY, HACKY_TEAM_ID, HACKY_CREDENTIALS_FILE } = process.env;

if (!HACKY_SUPABASE_URL || !HACKY_SUPABASE_PUBLISHABLE_KEY || !HACKY_TEAM_ID) {
  console.error("Set HACKY_SUPABASE_URL, HACKY_SUPABASE_PUBLISHABLE_KEY and HACKY_TEAM_ID.");
  process.exit(1);
}

const supabase = createClient(HACKY_SUPABASE_URL, HACKY_SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: fileStorage(HACKY_CREDENTIALS_FILE || defaultCredentialsFile()),
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const reminderSeconds = Number(process.env.HACKY_PROGRESS_REMINDER_SECONDS);
const { server, endSession } = createServer(supabase, HACKY_TEAM_ID, {
  ...(reminderSeconds > 0 && { progressReminderMs: reminderSeconds * 1000 }),
});
await server.connect(new StdioServerTransport());

// Claude Code ends a chat by closing the server's stdin. Marking the session closed lets the
// person's next chat take it over without waiting for it to look idle.
process.stdin.once("end", () => {
  void endSession().finally(() => process.exit(0));
});
