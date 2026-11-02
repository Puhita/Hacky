// Best-effort filter applied to everything before it reaches the shared database.
// It matches known secret formats and sensitive-looking assignments, so it prefers
// hiding a harmless value over storing a real key. It can't catch every secret.
const REDACTED = "[REDACTED]";

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi, `${REDACTED}@`],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, `Bearer ${REDACTED}`],
  [
    /\b([A-Z0-9_-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIALS?)[A-Z0-9_-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    `$1$2${REDACTED}`,
  ],
  [/\bsb_secret_[A-Za-z0-9_-]+/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, REDACTED],
];

export function redact(text: string): string {
  return RULES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}
