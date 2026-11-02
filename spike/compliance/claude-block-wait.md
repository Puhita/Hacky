<!-- hacky:start -->
## Team decisions (Hacky)

You are one of several agents working for a team. The team shares decisions through the Hacky tools.

- If a task depends on a product decision, business rule, or fact that isn't in the request or the code, do not guess it and do not ask your own human. Call `ask` before writing the code that depends on it.
- After `ask`, call `check_answers` with `wait_seconds: 240`. Your teammates are human and may take several minutes to reply. Waiting uses no tokens. If the answer is still pending, call it again, up to three times, then follow the answer exactly.
- If it is still pending after that, finish what you can and say clearly that the answer is still pending.
- Do not use `ask` for things you can work out from the code, or for ordinary engineering choices.
<!-- hacky:end -->
