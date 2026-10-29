/**
 * CLI for the security review, called step by step from
 * .github/workflows/security-review.yml and security-audit.yml. All logic lives
 * in review.ts; this file only does I/O. A transcript is the action's
 * execution file turned into one JSON event per line.
 *
 *   prompt <pr|audit> <out>   render pr-prompt.md / audit-prompt.md
 *   schema                    print the result JSON schema (for --json-schema)
 *   comment <transcript> <out>
 *                             render the PR comment (only written when there are
 *                             findings); prints "<findings> <status description>"
 *   audit-issue <transcript> <title-out> <body-out>
 *                             render the audit issue; prints "<findings>"
 *   limit-comment <max-rounds> <out>
 *                             render the one-off "review paused" comment
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertRepo,
  extractResult,
  findLeakedSecret,
  renderAuditIssue,
  renderAuditTitle,
  renderComment,
  renderLimitComment,
  renderPrompt,
  RESULT_SCHEMA,
  statusDescription,
} from "./review";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function arg(index: number, name: string): string {
  const value = process.argv[index];
  if (!value) throw new Error(`Missing argument <${name}>`);
  return value;
}

function readTranscript(file: string) {
  return extractResult(existsSync(file) ? readFileSync(file, "utf8") : "");
}

function refuseLeaks(text: string): void {
  const leaked = findLeakedSecret(text, {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    GH_TOKEN: process.env.SEC_GH_TOKEN,
  });
  if (leaked)
    throw new Error(
      `Refusing to post: the text contains the value of ${leaked}`,
    );
}

function main(): void {
  const command = process.argv[2];
  switch (command) {
    case "prompt": {
      const kind = arg(3, "pr|audit");
      if (kind !== "pr" && kind !== "audit")
        throw new Error(`Unknown prompt "${kind}"`);
      const repo = env("SEC_REPO");
      assertRepo(repo);
      const template = readFileSync(
        path.join(__dirname, `${kind}-prompt.md`),
        "utf8",
      );
      const vars: Record<string, string> = {
        REPO: `reaptor/${repo}`,
        HEAD_SHA: env("HEAD_SHA"),
        CONTEXT_DIR: env("SEC_CONTEXT_DIR"),
      };
      if (kind === "pr") vars.PR_NUMBER = env("PR");
      writeFileSync(arg(4, "out"), renderPrompt(template, vars));
      return;
    }

    case "schema":
      process.stdout.write(JSON.stringify(RESULT_SCHEMA));
      return;

    case "comment": {
      const { result, stats } = readTranscript(arg(3, "transcript"));
      if (result.findings.length > 0) {
        const body = renderComment({
          result,
          stats,
          headSha: env("HEAD_SHA"),
          runUrl: env("SEC_RUN_URL"),
        });
        refuseLeaks(body);
        writeFileSync(arg(4, "out"), body);
      }
      console.log(`${result.findings.length} ${statusDescription(result)}`);
      return;
    }

    case "audit-issue": {
      const { result, stats } = readTranscript(arg(3, "transcript"));
      const input = {
        result,
        stats,
        repo: `reaptor/${env("SEC_REPO")}`,
        sha: env("HEAD_SHA"),
        runUrl: env("SEC_RUN_URL"),
        date: new Date().toLocaleDateString("sv-SE", {
          timeZone: "Europe/Stockholm",
        }),
      };
      const title = renderAuditTitle(input);
      const body = renderAuditIssue(input);
      refuseLeaks(title + body);
      writeFileSync(arg(4, "title-out"), title);
      writeFileSync(arg(5, "body-out"), body);
      console.log(result.findings.length);
      return;
    }

    case "limit-comment": {
      const repo = env("SEC_REPO");
      assertRepo(repo);
      writeFileSync(
        arg(4, "out"),
        renderLimitComment(repo, env("PR"), Number(arg(3, "max-rounds"))),
      );
      return;
    }

    default:
      throw new Error(`Unknown command "${command ?? ""}"`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
