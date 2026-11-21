import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// set by the deploy itself or only inside a cloud machine's environment, not by the operator
const NOT_OPERATOR = new Set(["HOME", "USERPROFILE", "MADANI_PUBLIC_URL"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !/\.test\.ts$|fake|fixture/.test(name) ? [path] : [];
  });
}

describe("the account service's production config template", () => {
  it("lists every name the service reads", () => {
    const template = new Set(readFileSync(join(ROOT, "deploy/account/production.env.example"), "utf8").split("\n").map((line) => /^([A-Z][A-Z0-9_]+)=/.exec(line)?.[1]).filter(Boolean));
    const read = new Set<string>();
    for (const file of [...sources(join(ROOT, "apps/dashboard/server")), ...sources(join(ROOT, "apps/cloud-service/src"))]) {
      for (const match of readFileSync(file, "utf8").matchAll(/(?:env\.|env\[["'`]|required\(["'`]|choice\(["'`])([A-Z][A-Z0-9_]{3,})/g)) read.add(match[1]!);
    }
    for (const id of ["GOOGLE", "APPLE"]) for (const key of ["CLIENT_ID"]) read.add(`MADANI_AUTH_${id}_${key}`);
    const missing = [...read].filter((name) => !template.has(name) && !NOT_OPERATOR.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it("holds no values for secrets", () => {
    const filled = readFileSync(join(ROOT, "deploy/account/production.env.example"), "utf8").split("\n")
      .filter((line) => /^[A-Z][A-Z0-9_]+=\S/.test(line) && !/^(MADANI_DASHBOARD_HOST=127\.0\.0\.1|MADANI_TRUST_PROXY=1|MADANI_MAIL_PROVIDER=(?:brevo|resend))$/.test(line));
    expect(filled).toEqual([]);
  });
});
