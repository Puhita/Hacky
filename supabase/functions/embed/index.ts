// Turns text into a 384-dimension gte-small embedding, for signed-in users only. The caller
// is checked here because the publishable key ships in the extension and the platform's JWT
// check let a request carrying only that key through.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MAX_TEXT_LENGTH = 4000;
const session = new Supabase.ai.Session("gte-small");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function isSignedIn(request: Request): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const apikey = request.headers.get("apikey");
  if (!authorization || !apikey) return false;
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey },
  });
  return response.ok;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  if (!(await isSignedIn(request))) return json({ error: "Sign in first." }, 401);

  let text: unknown;
  try {
    ({ text } = await request.json());
  } catch {
    return json({ error: "Send JSON with a text field." }, 400);
  }
  if (typeof text !== "string" || text.trim() === "") return json({ error: "text must be a non-empty string." }, 400);

  const embedding = await session.run(text.slice(0, MAX_TEXT_LENGTH), { mean_pool: true, normalize: true });
  return json({ embedding });
});
