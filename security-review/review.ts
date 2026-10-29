/**
 * Pure logic of the security review (.github/workflows/security-review.yml and
 * security-audit.yml): the result schema Claude must answer with, the PR
 * comment for a pull request review and the issue for a whole-codebase audit.
 * The CLI around it is cli.ts.
 */

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`No value for ${placeholder} in the prompt`);
    return value;
  });
}

/** The name of the first secret whose value appears in `text`, if any. */
export function findLeakedSecret(text: string, secrets: Record<string, string | undefined>): string | null {
  for (const [name, value] of Object.entries(secrets)) {
    if (value && value.length >= 8 && text.includes(value)) return name;
  }
  return null;
}

/** The name of a repository under the reaptor organization. */
const REPO_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function assertRepo(repo: string): void {
  if (!REPO_PATTERN.test(repo))
    throw new Error(`Not a repository name: "${repo}"`);
}

/**
 * Comment markers. The workflow counts `ACTIONABLE` comments for its round
 * limit and posts `LIMIT` once when it is reached.
 */
export const MARKERS = {
  ACTIONABLE: "<!-- security-review -->",
  LIMIT: "<!-- security-review-limit -->",
  AUDIT: "<!-- security-review-audit -->",
  sha: (sha: string) => `<!-- security-review-sha: ${sha} -->`,
} as const;

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
type Severity = (typeof SEVERITIES)[number];

export const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "reviewed", "findings"],
  properties: {
    summary: { type: "string" },
    reviewed: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "severity",
          "category",
          "location",
          "description",
          "scenario",
          "fix",
        ],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: SEVERITIES },
          category: { type: "string" },
          location: { type: "string" },
          description: { type: "string" },
          scenario: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
  },
} as const;

export type SecurityFinding = {
  title: string;
  severity: Severity;
  category: string;
  location: string;
  description: string;
  scenario: string;
  fix: string;
};

export type SecurityResult = {
  summary: string;
  reviewed: string[];
  findings: SecurityFinding[];
};

export type RunStats = { costUsd: number | null; turns: number | null };

function isFinding(value: unknown): value is SecurityFinding {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    SEVERITIES.includes(f.severity as Severity) &&
    ["title", "category", "location", "description", "scenario", "fix"].every(
      (k) => typeof f[k] === "string",
    )
  );
}

function isResult(value: unknown): value is SecurityResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summary === "string" &&
    Array.isArray(v.reviewed) &&
    Array.isArray(v.findings) &&
    v.findings.every(isFinding)
  );
}

function parseJsonLoosely(text: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
}

/**
 * Pull the result out of `claude -p --output-format stream-json` output: the
 * last `result` event carries `structured_output` (from --json-schema), with
 * the plain `result` text as a fallback. Findings come back most severe first.
 */
export function extractResult(transcript: string): {
  result: SecurityResult;
  stats: RunStats;
} {
  const events = transcript
    .split("\n")
    .map((line) => parseJsonLoosely(line))
    .filter(
      (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
    );
  const final = events.filter((e) => e.type === "result").at(-1);
  if (!final)
    throw new Error(
      "The security review produced no result (see the workflow run's logs)",
    );

  const candidate =
    final.structured_output ??
    (typeof final.result === "string"
      ? parseJsonLoosely(final.result)
      : undefined);
  if (!isResult(candidate)) {
    throw new Error(
      `The security review's result is not valid (subtype: ${String(final.subtype)}; see the workflow run's logs)`,
    );
  }
  const findings = [...candidate.findings].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  return {
    result: { ...candidate, findings },
    stats: {
      costUsd:
        typeof final.total_cost_usd === "number" ? final.total_cost_usd : null,
      turns: typeof final.num_turns === "number" ? final.num_turns : null,
    },
  };
}

/**
 * Text from the model goes into a GitHub comment. Strip HTML comments so it
 * can never forge one of our markers, and keep it on one
 * line where the layout expects one.
 */
function clean(text: string, multiline = false): string {
  const stripped = text
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/<\/?details>/gi, "");
  return (multiline ? stripped : stripped.replace(/\s*\n\s*/g, " ")).trim();
}

function findingSections(findings: SecurityFinding[]): string[] {
  return findings.flatMap((f, i) => [
    `### ${i + 1}. [${f.severity}] ${clean(f.title)}`,
    "",
    `**Where:** \`${clean(f.location).replace(/`/g, "")}\` · **Category:** ${clean(f.category)}`,
    "",
    clean(f.description, true),
    "",
    `**Attack scenario:** ${clean(f.scenario, true)}`,
    "",
    `**Fix:** ${clean(f.fix, true)}`,
    "",
  ]);
}

function reviewedDetails(reviewed: string[]): string[] {
  if (reviewed.length === 0) return [];
  return [
    "<details><summary>What was reviewed</summary>",
    "",
    ...reviewed.map((r) => `- ${clean(r)}`),
    "",
    "</details>",
    "",
  ];
}

function footer(kind: string, runUrl: string, stats: RunStats): string {
  const cost = stats.costUsd === null ? "" : `, $${stats.costUsd.toFixed(2)}`;
  const turns = stats.turns === null ? "" : `, ${stats.turns} turns`;
  return `<sub>${kind} [run](${runUrl})${turns}${cost}</sub>`;
}

export type CommentInput = {
  result: SecurityResult;
  stats: RunStats;
  headSha: string;
  /** The workflow run that did the review, as a link to its logs. */
  runUrl: string;
};

/** The PR comment for a review with findings; a review without findings posts nothing. */
export function renderComment(input: CommentInput): string {
  const { result, headSha } = input;
  const n = result.findings.length;
  if (n === 0) throw new Error("A review without findings is not commented");
  return [
    `🤖 **Security review found ${n} problem${n === 1 ? "" : "s"}** in this PR (commit ${headSha.slice(0, 7)})`,
    "",
    clean(result.summary, true),
    "",
    ...findingSections(result.findings),
    "---",
    "",
    "**For Claude Code:** fix each numbered finding on this PR's branch (or explain in a reply why it is not a problem), " +
      "then push — the security review runs again on the new commit. " +
      "On a `claude/` branch Claude is started on this comment automatically; elsewhere, mention `@claude` to have it fixed. " +
      "These findings come from an automated read-only code review; check each one against the code before changing behaviour.",
    "",
    ...reviewedDetails(result.reviewed),
    footer("Security review", input.runUrl, input.stats),
    "",
    MARKERS.ACTIONABLE,
    MARKERS.sha(headSha),
  ].join("\n");
}

/** The commit status description, at most 140 characters (GitHub's limit). */
export function statusDescription(result: SecurityResult): string {
  const n = result.findings.length;
  if (n === 0) return "No security problems found";
  return `${n} security finding${n === 1 ? "" : "s"}, see the PR comment`;
}

/** Posted once when a PR reaches `maxRounds` comments with findings. */
export function renderLimitComment(
  repo: string,
  pr: string,
  maxRounds: number,
): string {
  return [
    `🤖 **Security review paused**: this PR has had ${maxRounds} rounds of security findings, so it is no longer reviewed on every push.`,
    "",
    `Run it by hand to review it again: \`gh workflow run security-review.yml -R reaptor/${repo} -f pr=${pr}\``,
    "",
    MARKERS.LIMIT,
  ].join("\n");
}

export type AuditInput = {
  result: SecurityResult;
  stats: RunStats;
  /** `owner/name` of the audited repository. */
  repo: string;
  sha: string;
  runUrl: string;
  date: string;
};

export function renderAuditTitle(input: AuditInput): string {
  return `Säkerhetsgranskning av ${input.repo}: ${input.result.findings.length} fynd (${input.date})`;
}

/**
 * The issue for a whole-codebase audit. It is filed without the `claude`
 * label, so nothing runs until someone with write access replies with
 * `@claude`; that reply says what to do with the findings.
 */
export function renderAuditIssue(input: AuditInput): string {
  const { result, sha } = input;
  const short = sha.slice(0, 7);
  return [
    `🤖 **Security audit of ${input.repo}** at commit ${short}: the whole codebase, read by Claude.`,
    "",
    clean(result.summary, true),
    "",
    ...(result.findings.length > 0
      ? findingSections(result.findings)
      : ["No security problems found.", ""]),
    "---",
    "",
    "These findings come from an automated read-only code review; check each one against the code before changing behaviour. " +
      "Reply to this issue with `@claude` and what to do, for example fix them all in one PR, fix only some, or split them into their own issues.",
    "",
    ...reviewedDetails(result.reviewed),
    footer("Security audit", input.runUrl, input.stats),
    "",
    MARKERS.AUDIT,
  ].join("\n");
}
