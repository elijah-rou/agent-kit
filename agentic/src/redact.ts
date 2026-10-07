// Strips secrets from command text before it leaves the machine (design L2 step 3, slice 2).
// Each secret becomes a typed placeholder, `<redacted:kind>`, so a classifier still sees
// the command's shape. Rules run in order; generic rules skip text already redacted.

export type SecretKind =
  | "private-key"
  | "url-credentials"
  | "auth-header"
  | "bearer"
  | "github-token"
  | "typesafe-key"
  | "slack-token"
  | "aws-access-key"
  | "env-assignment"
  | "flag-value"
  | "high-entropy";

export interface Redaction {
  readonly text: string;
  readonly counts: Readonly<Partial<Record<SecretKind, number>>>;
}

export const placeholder = (kind: SecretKind): string => `<redacted:${kind}>`;

// Skips placeholders and shell variable references such as "$GITHUB_TOKEN", which are not secrets.
const NOT_REDACTED = `(?!["']?(?:<redacted:|\\$[A-Za-z_{]))`;
// A shell word value: double-quoted, single-quoted, or bare up to whitespace or a shell operator.
const VALUE = `${NOT_REDACTED}(?:"[^"]*"|'[^']*'|[^\\s"'|;&<>()]+)`;

// Underscore-separated names with a secret-like part: TOKEN, API_KEY, AWS_SECRET_ACCESS_KEY, db_pass.
const SECRET_NAME =
  "(?:[A-Za-z0-9]+_)*(?:KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH)(?:_[A-Za-z0-9]+)*";

const SECRET_FLAG =
  "--(?:token|password|passwd|pass|secret|api-key|apikey|access-token|auth-token|client-secret|private-token|key)";

// Commands whose `-p` flag takes a password rather than a path or port.
const PASSWORD_P_COMMANDS = "(?:sshpass|mysql|mysqldump|mysqladmin|mariadb)";

type Rule = {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
  // Builds the replacement from the match groups; defaults to the bare placeholder.
  readonly replace?: (kind: SecretKind, ...groups: string[]) => string;
};

const keepPrefix = (kind: SecretKind, prefix: string): string => `${prefix}${placeholder(kind)}`;

const RULES: readonly Rule[] = [
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    // scheme://user:pass@host or scheme://token@host. Plain `user@` is kept when short.
    kind: "url-credentials",
    pattern: /([a-z][a-z0-9+.-]*:\/\/)((?!<redacted:)[^\s/@"']*:[^\s/@"']*|[^\s/@:"']{16,})@/gi,
    replace: (kind, scheme) => `${scheme}${placeholder(kind)}@`,
  },
  {
    // Header values that carry credentials, up to the end of the quoted header or the word.
    kind: "auth-header",
    pattern:
      /((?:Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|Private-Token|X-GitHub-Token)\s*:\s*(?:(?:Bearer|Basic|token)\s+)?)(?!<redacted:|\$[A-Za-z_{]|(?:Bearer|Basic|token)\s)[^\s"']+/gi,
    replace: keepPrefix,
  },
  {
    kind: "bearer",
    pattern: /(\bBearer\s+)(?!<redacted:)[A-Za-z0-9._~+/=-]{8,}/g,
    replace: keepPrefix,
  },
  {
    kind: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  { kind: "typesafe-key", pattern: /\bapikey_[A-Za-z0-9_-]{8,}/g },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g },
  {
    kind: "flag-value",
    pattern: new RegExp(`(${SECRET_FLAG}(?:=|\\s+))${VALUE}`, "gi"),
    replace: keepPrefix,
  },
  {
    // `-u user:password` for curl-like clients.
    kind: "flag-value",
    pattern: /(\s(?:-u|--user)\s+[^\s:"']+:)(?!<redacted:)[^\s"']+/g,
    replace: keepPrefix,
  },
  {
    // `-p value` and `-pvalue` for commands that take a password with -p.
    kind: "flag-value",
    pattern: new RegExp(`(\\b${PASSWORD_P_COMMANDS}\\b[^|;&\\n]*?\\s-p\\s*)${VALUE}`, "g"),
    replace: keepPrefix,
  },
  {
    // NAME=value where NAME looks like a secret, with optional `export`.
    kind: "env-assignment",
    pattern: new RegExp(`(\\b${SECRET_NAME}\\s*=\\s*)${VALUE}`, "gi"),
    replace: keepPrefix,
  },
];

// Long mixed-case strings with digits, such as API secrets and base64 blobs. Requiring
// upper case, lower case, and digits keeps hex SHAs, paths, and words intact.
const ENTROPY_CANDIDATE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{24,}(?![A-Za-z0-9+/=_-])/g;
const MIN_ENTROPY_BITS = 3.5;

const shannonEntropy = (s: string): number => {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

const looksHighEntropy = (s: string): boolean =>
  /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s) && shannonEntropy(s) >= MIN_ENTROPY_BITS;

export function redact(text: string): Redaction {
  const counts: Partial<Record<SecretKind, number>> = {};
  const bump = (kind: SecretKind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };

  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      bump(rule.kind);
      // replace() passes (match, ...groups, offset, input); the offset is the first number.
      const offsetIndex = args.findIndex((a) => typeof a === "number");
      const groups = args.slice(1, offsetIndex) as string[];
      return rule.replace ? rule.replace(rule.kind, ...groups) : placeholder(rule.kind);
    });
  }
  out = out.replace(ENTROPY_CANDIDATE, (match) => {
    if (!looksHighEntropy(match)) return match;
    bump("high-entropy");
    return placeholder("high-entropy");
  });
  return { text: out, counts };
}
