// src/github/issueClient.ts
// ─────────────────────────────────────────────────────────────────────────────
// All GitHub Issues API calls live here. Nothing else.
// Uses the shared Octokit instance from config.
// ─────────────────────────────────────────────────────────────────────────────

import { Octokit } from "@octokit/rest";
import { config } from "../config/config";

const octokit = new Octokit({ auth: config.github.token });

// ── Shared types ──────────────────────────────────────────────────────────────

export interface IssueSummary {
    number: number;
    title: string;
    body: string;
    htmlUrl: string;
    labels: string[];
    state: "open" | "closed";
}

export interface IssueComment {
    author: string;
    body: string;
    createdAt: string;
}

// ── fetchIssue ────────────────────────────────────────────────────────────────

/**
 * Fetch a single issue by number.
 * Throws an error with `status: 404` if the issue does not exist.
 */
export async function fetchIssue(
    owner: string,
    repo: string,
    issueNumber: number,
): Promise<IssueSummary> {
    const { data } = await octokit.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
    });

    return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        htmlUrl: data.html_url,
        labels: data.labels
            .map(l => (typeof l === "string" ? l : l.name ?? ""))
            .filter(Boolean),
        state: data.state as "open" | "closed",
    };
}

// ── fetchOpenIssues ───────────────────────────────────────────────────────────

/**
 * Fetch open issues for a repo, sorted by most recently updated.
 * Cap at `limit` items (default 100). Never auto-fetches beyond this.
 * User must explicitly request more.
 */
export async function fetchOpenIssues(
    owner: string,
    repo: string,
    limit = 100,
): Promise<IssueSummary[]> {
    const perPage = Math.min(limit, 100); // GitHub max per page is 100
    const { data } = await octokit.issues.listForRepo({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: perPage,
    });

    return data.map(issue => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        htmlUrl: issue.html_url,
        labels: issue.labels
            .map(l => (typeof l === "string" ? l : l.name ?? ""))
            .filter(Boolean),
        state: "open" as const,
    }));
}

// ── fetchIssueComments ────────────────────────────────────────────────────────

/**
 * Fetch up to `limit` comments on an issue (default 20).
 * Useful as context for AI analysis.
 */
export async function fetchIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    limit = 20,
): Promise<IssueComment[]> {
    const { data } = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: Math.min(limit, 100),
    });

    return data.slice(0, limit).map(comment => ({
        author: comment.user?.login ?? "unknown",
        body: comment.body ?? "",
        createdAt: comment.created_at,
    }));
}
