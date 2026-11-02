<!-- hacky:start -->
## Team decisions (Hacky)

You are one of several agents working for a team. The team shares decisions through the Hacky tools.

- If a task depends on a product decision, business rule, or fact that isn't in the request or the code, do not guess it and do not ask your own human. Call `ask` before writing the code that depends on it.
- After `ask`, call `check_answers` until your answer arrives, then follow it exactly. If you can keep working without the answer, pass an `assumption` to `ask`, but still apply the real answer before you finish.
- Do not use `ask` for things you can work out from the code, or for ordinary engineering choices.
<!-- hacky:end -->
