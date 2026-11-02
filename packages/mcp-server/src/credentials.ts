import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const defaultCredentialsFile = () => join(homedir(), ".hacky", "credentials.json");

const RENAME_ATTEMPTS = 5;

function readAll(file: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

// Several server processes can share this file, so each write replaces it atomically.
// Windows can briefly refuse the rename while another process has the file open.
async function writeAll(file: string, values: Record<string, string>): Promise<void> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(values), { mode: 0o600 });
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temporary, file);
      return;
    } catch (error) {
      if (attempt === RENAME_ATTEMPTS) {
        rmSync(temporary, { force: true });
        throw error;
      }
      await sleep(50 * attempt);
    }
  }
}

// Supabase auth storage backed by a user-level file outside the repo. Reads always hit
// the file, so a process picks up refresh tokens rotated by any other process.
export function fileStorage(file: string) {
  return {
    getItem: async (key: string) => readAll(file)[key] ?? null,
    setItem: async (key: string, value: string) => {
      await writeAll(file, { ...readAll(file), [key]: value });
    },
    removeItem: async (key: string) => {
      const { [key]: _removed, ...rest } = readAll(file);
      await writeAll(file, rest);
    },
  };
}
