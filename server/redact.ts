// Best-effort secret scrubbing for text that leaves the daemon. It catches well-known token
// shapes and literal credential assignments; it cannot recognize every secret, which is why
// command output and file contents are never sent at all.

const REDACTED = "[redacted]";

/** Token shapes specific enough to scrub anywhere, including conversation text. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** Credentials in URLs: scheme://user:password@host */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
/** Authorization headers and bearer tokens. */
const AUTH_HEADER = /\b(authorization\s*[:=]\s*(?:bearer|basic|token)?\s*)[^\s'"]+/gi;
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
/**
 * `password = "hunter22"`, `API_KEY=abc123...`, `--token abc...`. Only literal values are
 * scrubbed: quoted strings, or long unquoted runs without call syntax.
 */
const ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?[A-Za-z0-9_-]*["']?\s*(?:[:=]|\s)\s*)(?:"[^"\s]{6,}"|'[^'\s]{6,}'|[A-Za-z0-9_\-+/=.]{12,})/gi;

/** Scrubs well-known token shapes. Safe for prose and code. */
export function redactTokens(text: string): string {
  let result = text;
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
  return result.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
}

/** Scrubs token shapes plus literal credential assignments. For commands and diffs. */
export function redactSecrets(text: string): string {
  return redactTokens(text)
    .replace(AUTH_HEADER, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(ASSIGNMENT, `$1${REDACTED}`);
}

const SENSITIVE_NAMES = [
  /^\.env(?:\..*)?$/i,
  /^\.?netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i,
  /^(?:htpasswd|shadow|kubeconfig)$/i,
];
/** `secrets.yaml`, `prod-credentials.json`, `client_secret.json`, but not `token-bucket.ts`. */
const SENSITIVE_STEM = /(?:^|[._-])(?:secrets?|credentials?|passwords?|tokens?)$/i;
const SENSITIVE_DIRECTORIES = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.config\/gh)\//i;

/** Files whose changes are never shown to guests, whatever the link allows. */
export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (SENSITIVE_DIRECTORIES.test(normalized)) return true;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name)) || SENSITIVE_STEM.test(stem);
}
