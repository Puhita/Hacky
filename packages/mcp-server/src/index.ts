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

await createServer(supabase, HACKY_TEAM_ID).connect(new StdioServerTransport());
