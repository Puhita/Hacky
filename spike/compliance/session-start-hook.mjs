// SessionStart hook: logs that it fired, and its stdout is added to the session's context.
import { appendFileSync } from "node:fs";

appendFileSync(process.env.HACKY_SPIKE_LOG, JSON.stringify({ at: Date.now(), hook: "SessionStart" }) + "\n");
console.log(
  "Hacky is active for this team. If this task depends on a decision or fact that isn't in the request or the code, call the Hacky `ask` tool instead of guessing or asking your human, then call `check_answers` until the answer arrives.",
);
