import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  assertRepo,
  extractResult,
  MARKERS,
  renderAuditIssue,
  renderAuditTitle,
  renderComment,
  renderLimitComment,
  renderPrompt,
  RESULT_SCHEMA,
  statusDescription,
  type SecurityFinding,
  type SecurityResult,
} from "../security-review/review";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function resultEvent(extra: Record<string, unknown>): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    num_turns: 12,
    total_cost_usd: 0.5,
    ...extra,
  });
}

const low: SecurityFinding = {
  title: "Verbose error message",
  severity: "low",
  category: "Information disclosure",
  location: "src/app/api/x/route.ts:10",
  description: "The stack trace is returned to the client.",
  scenario: "An attacker learns file paths.",
  fix: "Return a generic message.",
};

const critical: SecurityFinding = {
  title: "Server action takes the organization id from the client",
  severity: "critical",
  category: "Authorization",
  location: "src/app/(authenticated)/customers/actions.ts:42",
  description:
    "`deleteCustomer(organizationId, id)` trusts its first argument.",
  scenario: "Any logged-in user deletes another tenant's customers.",
  fix: "Use `context.organizationId` from `getUserContext()`.",
};

const result: SecurityResult = {
  summary: "Adds a customer delete action.",
  reviewed: ["customers/actions.ts"],
  findings: [low, critical],
};

describe("assertRepo", () => {
  it("accepts plain repo names and rejects anything else", () => {
    expect(() => assertRepo("kontera")).not.toThrow();
    expect(() => assertRepo("arnold")).not.toThrow();
    for (const bad of ["", "reaptor/kontera", "../x", "Kontera", "-x"]) {
      expect(() => assertRepo(bad)).toThrow();
    }
  });
});

describe("prompts", () => {
  it.each([
    [
      "pr-prompt.md",
      {
        REPO: "reaptor/kontera",
        PR_NUMBER: "12",
        HEAD_SHA: SHA,
        CONTEXT_DIR: "sec-out/context",
      },
    ],
    [
      "audit-prompt.md",
      { REPO: "reaptor/arnold", HEAD_SHA: SHA, CONTEXT_DIR: "sec-out/context" },
    ],
  ])("fills every placeholder of %s", (file, vars) => {
    const template = readFileSync(
      path.join(__dirname, "../security-review", file),
      "utf8",
    );
    const prompt = renderPrompt(template, vars);
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).toContain(SHA);
  });

  it("uses only severities the schema allows", () => {
    expect(
      RESULT_SCHEMA.properties.findings.items.properties.severity.enum,
    ).toEqual(["critical", "high", "medium", "low"]);
  });
});

describe("extractResult", () => {
  it("reads structured_output from the last result event and sorts findings by severity", () => {
    const transcript = [
      JSON.stringify({ type: "system" }),
      "not json",
      resultEvent({ structured_output: result }),
    ].join("\n");
    const extracted = extractResult(transcript);
    expect(extracted.result.findings.map((f) => f.severity)).toEqual([
      "critical",
      "low",
    ]);
    expect(extracted.stats).toEqual({ costUsd: 0.5, turns: 12 });
  });

  it("falls back to JSON in the result text", () => {
    const transcript = resultEvent({
      result:
        "```json\n" + JSON.stringify({ ...result, findings: [] }) + "\n```",
    });
    expect(extractResult(transcript).result.findings).toEqual([]);
  });

  it("throws without a usable result", () => {
    expect(() => extractResult("")).toThrow();
    expect(() =>
      extractResult(
        resultEvent({ subtype: "error_max_budget_usd", result: "" }),
      ),
    ).toThrow("error_max_budget_usd");
    const badSeverity = {
      ...result,
      findings: [{ ...low, severity: "urgent" }],
    };
    expect(() =>
      extractResult(resultEvent({ structured_output: badSeverity })),
    ).toThrow();
  });
});

describe("renderComment", () => {
  const input = {
    result: extractResult(resultEvent({ structured_output: result })).result,
    stats: { costUsd: 0.5, turns: 12 },
    headSha: SHA,
    runUrl: "https://github.com/reaptor/kontera/actions/runs/42",
  };

  it("renders numbered findings with the actionable and sha markers", () => {
    const body = renderComment(input);
    expect(
      body.startsWith(
        "🤖 **Security review found 2 problems** in this PR (commit 0123456)",
      ),
    ).toBe(true);
    expect(body).toContain(
      "### 1. [critical] Server action takes the organization id from the client",
    );
    expect(body).toContain(
      "**Where:** `src/app/(authenticated)/customers/actions.ts:42`",
    );
    expect(body).toContain("### 2. [low] Verbose error message");
    expect(body).toContain(MARKERS.ACTIONABLE);
    expect(body).toContain(MARKERS.sha(SHA));
    expect(body).toContain(
      "<sub>Security review [run](https://github.com/reaptor/kontera/actions/runs/42), 12 turns, $0.50</sub>",
    );
  });

  it("strips HTML comments from the model's text so it cannot forge markers", () => {
    const forged = {
      ...input,
      result: {
        ...result,
        summary: "ok <!-- security-review --> <!-- security-review-limit -->",
        findings: [critical],
      },
    };
    const body = renderComment(forged);
    expect(body.split(MARKERS.ACTIONABLE)).toHaveLength(2);
    expect(body).not.toContain(MARKERS.LIMIT);
  });

  it("refuses a review without findings", () => {
    expect(() =>
      renderComment({ ...input, result: { ...result, findings: [] } }),
    ).toThrow();
  });
});

describe("statusDescription", () => {
  it("summarizes the outcome within GitHub's limit", () => {
    expect(statusDescription({ ...result, findings: [] })).toBe(
      "No security problems found",
    );
    expect(statusDescription({ ...result, findings: [critical] })).toBe(
      "1 security finding, see the PR comment",
    );
    expect(statusDescription(result).length).toBeLessThanOrEqual(140);
  });
});

describe("renderLimitComment", () => {
  it("says how to run it by hand and carries the limit marker", () => {
    const body = renderLimitComment("arnold", "7", 3);
    expect(body.startsWith("🤖 **Security review paused**")).toBe(true);
    expect(body).toContain("gh workflow run security-review.yml -R reaptor/arnold -f pr=7");
    expect(body).toContain(MARKERS.LIMIT);
    expect(body).not.toContain(MARKERS.ACTIONABLE);
  });
});

describe("renderAuditIssue", () => {
  const input = {
    result: { ...result, findings: [critical] },
    stats: { costUsd: 7.25, turns: 140 },
    repo: "reaptor/kontera",
    sha: SHA,
    runUrl: "https://github.com/reaptor/kontera/actions/runs/43",
    date: "2026-10-26",
  };

  it("titles the issue in Swedish with the count and date", () => {
    expect(renderAuditTitle(input)).toBe(
      "Säkerhetsgranskning av reaptor/kontera: 1 fynd (2026-10-26)",
    );
  });

  it("lists the findings with the audit marker and asks for an @claude reply", () => {
    const body = renderAuditIssue(input);
    expect(body).toContain(
      "**Security audit of reaptor/kontera** at commit 0123456",
    );
    expect(body).toContain("### 1. [critical]");
    expect(body).toContain(MARKERS.AUDIT);
    expect(body).toContain("Reply to this issue with `@claude` and what to do");
  });
});
