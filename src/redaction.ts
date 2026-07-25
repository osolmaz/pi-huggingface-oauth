import { MAX_ERROR_TEXT_LENGTH } from "./constants.js";

const TOKEN_PATTERN = /\b(?:hf|api)_[A-Za-z0-9_-]{8,}\b/gu;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/giu;
const SECRET_FIELD_PATTERN = /((?:access_token|refresh_token|device_code)\s*[:=]\s*["']?)[^\s,"'}]+/giu;

function replaceControls(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
  }).join("");
}

export function redactForError(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  redacted = redacted.replace(TOKEN_PATTERN, "[redacted]");
  redacted = redacted.replace(BEARER_PATTERN, "Bearer [redacted]");
  redacted = redacted.replace(SECRET_FIELD_PATTERN, "$1[redacted]");
  redacted = replaceControls(redacted).replace(/\s+/gu, " ").trim();
  return redacted.slice(0, MAX_ERROR_TEXT_LENGTH);
}
