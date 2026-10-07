import { describe, expect, test } from "bun:test";
import { redact, type SecretKind } from "../src/redact.ts";

// All secrets below are fake. Each case lists the secret substrings that must not survive.
type Case = { name: string; input: string; secrets: string[]; kind: SecretKind };

const GHP = "ghp" + "_Fake0Tok3nAbCdEfGhIjKlMnOpQrStUvWx12";
const GHO = "gho_Fake0Tok3nZyXwVuTsRqPoNmLkJiHgFeDc34";
const PAT = "github" + "_pat_11FAKE0000_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";
const TS_KEY = "apikey_00fakeQ7wErTyUiOp1234";
const AWS_ID = "AKIAFAKE0EXAMPLE1234";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKEKEY0Q9";
const BEARER = "eyJhbGciOiJIUzI1NiJ9.ZmFrZXBheWxvYWQ.c2lnbmF0dXJlRmFrZQ";
const ENTROPY = "Zq8Lr2Vx9Nc4Bt7Hm1Kp6Wd3Fs5Gy0Jq";

const cases: Case[] = [
  { name: "ghp token", input: `git push https://example.com/r.git && echo ${GHP}`, secrets: [GHP], kind: "github-token" },
  { name: "gho token", input: `gh auth login --with-token <<< ${GHO}`, secrets: [GHO], kind: "github-token" },
  { name: "fine-grained PAT", input: `echo ${PAT} | gh auth login --with-token`, secrets: [PAT], kind: "github-token" },
  { name: "typesafe-style key", input: `curl -d @q.json https://api.example.com?k=${TS_KEY}`, secrets: [TS_KEY], kind: "typesafe-key" },
  { name: "AWS access key id", input: `aws configure set aws_access_key_id ${AWS_ID}`, secrets: [AWS_ID], kind: "aws-access-key" },
  {
    name: "AWS secret in env assignment",
    input: `AWS_SECRET_ACCESS_KEY=${AWS_SECRET} aws s3 ls`,
    secrets: [AWS_SECRET],
    kind: "env-assignment",
  },
  {
    name: "Authorization header with token scheme",
    input: `curl -H "Authorization: token s3cretHeaderValue99" https://api.example.com/x`,
    secrets: ["s3cretHeaderValue99"],
    kind: "auth-header",
  },
  {
    name: "Authorization header with Bearer and a JWT",
    input: `curl -H 'Authorization: Bearer ${BEARER}' https://api.example.com/x`,
    secrets: [BEARER, "ZmFrZXBheWxvYWQ"],
    kind: "auth-header",
  },
  { name: "bare Bearer", input: `http POST example.com/x "Bearer ${BEARER}"`, secrets: [BEARER], kind: "bearer" },
  { name: "--token flag", input: `deploy-tool --token hunter2hunter2 --env prod`, secrets: ["hunter2hunter2"], kind: "flag-value" },
  { name: "--password= flag", input: `tool login --password='p@ss w0rd!'`, secrets: ["p@ss w0rd!"], kind: "flag-value" },
  { name: "sshpass -p", input: `sshpass -p 'Tr0ub4dor&3' ssh deploy@example.com 'git push'`, secrets: ["Tr0ub4dor&3"], kind: "flag-value" },
  { name: "mysql -pVALUE", input: `mysql -u root -pcorrecthorse db -e 'select 1'`, secrets: ["correcthorse"], kind: "flag-value" },
  { name: "curl -u user:pass", input: `curl -u alice:sup3rs3cret https://example.com/api`, secrets: ["sup3rs3cret"], kind: "flag-value" },
  { name: "TOKEN= env", input: `TOKEN=plainvalue123 ./publish.sh`, secrets: ["plainvalue123"], kind: "env-assignment" },
  { name: "export API_KEY quoted", input: `export API_KEY="quoted value here"; run`, secrets: ["quoted value here"], kind: "env-assignment" },
  { name: "lower-case db_pass", input: `db_pass=letmein99 node migrate.js`, secrets: ["letmein99"], kind: "env-assignment" },
  {
    name: "URL with user and password",
    input: `git clone https://bot:hunter2pass@example.com/org/repo.git`,
    secrets: ["hunter2pass", "bot:hunter2pass"],
    kind: "url-credentials",
  },
  {
    name: "URL with token userinfo",
    input: `git push https://x-access-token:${GHP}@github.example.com/example-org/repo.git HEAD:main`,
    secrets: [GHP],
    kind: "url-credentials",
  },
  {
    name: "private key block",
    input: `cat > k <<'EOF'\n-----BEGIN OPENSSH ${"PRIVATE"} KEY-----\nb3BlbnNzaC1rZXktdjEAAAAfakefake\n-----END OPENSSH PRIVATE KEY-----\nEOF`,
    secrets: ["b3BlbnNzaC1rZXktdjEAAAAfakefake"],
    kind: "private-key",
  },
  { name: "long high-entropy string", input: `./client --session ${ENTROPY}`, secrets: [ENTROPY], kind: "high-entropy" },
];

describe("redact", () => {
  for (const c of cases) {
    test(`strips ${c.name}`, () => {
      const { text, counts } = redact(c.input);
      for (const s of c.secrets) expect(text).not.toContain(s);
      expect(text).toContain(`<redacted:${c.kind}>`);
      expect(counts[c.kind]).toBeGreaterThanOrEqual(1);
    });
  }

  test("no fixture secret survives when all fixtures are combined", () => {
    const { text } = redact(cases.map((c) => c.input).join(" ; "));
    for (const s of cases.flatMap((c) => c.secrets)) expect(text).not.toContain(s);
  });

  test("an already-redacted value is not wrapped again", () => {
    const { text, counts } = redact(`GITHUB_TOKEN="${GHP}" gh pr merge 3`);
    expect(text).toBe(`GITHUB_TOKEN="<redacted:github-token>" gh pr merge 3`);
    expect(counts["env-assignment"]).toBeUndefined();
  });

  test("shell variable references are kept", () => {
    const input = `curl -H "Authorization: Bearer $GITHUB_TOKEN" --token "$TOKEN" https://api.example.com && API_KEY=\${KEY} x`;
    expect(redact(input).text).toBe(input);
  });

  test("an auth header keeps its scheme and loses its value", () => {
    expect(redact(`curl -H "Authorization: Bearer abc.def.ghi12345" x`).text).toBe(
      `curl -H "Authorization: Bearer <redacted:auth-header>" x`,
    );
  });

  test("redaction is idempotent", () => {
    const once = redact(cases.map((c) => c.input).join("\n")).text;
    expect(redact(once).text).toBe(once);
  });

  const benign = [
    "git push origin HEAD:main",
    "git push --dry-run origin agent/fix-123",
    "mkdir -p build/out && cp -pr src build/out",
    "git show 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    "ssh -p 2222 deploy@example.com 'git log -1'",
    "gh pr merge 42 --squash --repo example-org/widgets",
    "BYPASS=1 make test",
    "curl -s https://api.github.com/repos/example-org/widgets/pulls/7",
    "git clone git@github.com:example-org/widgets.git",
    'echo "$GITHUB_TOKEN" | wc -c',
    "cd refs/heads/feature/add-login-page-2024",
  ];
  for (const command of benign) {
    test(`leaves benign command unchanged: ${command}`, () => {
      expect(redact(command).text).toBe(command);
    });
  }
});
