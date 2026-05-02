// backend/src/github/issueClient.ts

import { Octokit } from "@octokit/rest";
import { config } from "../config/config";

const octokit = new Octokit({ auth: config.github.token });

export interface GitHubIssue {
    number: number;
    title: string;
    body: string;
    htmlUrl: string;
    labels: string[];
    state: string;
}

export interface IssueComment {
    author: string;
    body: string;
    createdAt: string;
}

export interface LinkedPR {
    number: number;
    title: string;
    state: string;        // "open" | "closed"
    merged: boolean;
    changedFiles: string[]; // file paths changed in this PR
    htmlUrl: string;
}

// Fetch a single issue
export async function fetchIssue(
    owner: string,
    repo: string,
    issueNumber: number
): Promise<GitHubIssue> {
    const { data } = await octokit.issues.get({
        owner, repo, issue_number: issueNumber
    });
    return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        htmlUrl: data.html_url,
        labels: data.labels
            .map((l) => (typeof l === "string" ? l : l.name ?? ""))
            .filter(Boolean),
        state: data.state,
    };
}

// Fetch open issues list (summary only)
export async function fetchOpenIssues(
    owner: string,
    repo: string,
    limit = 100
): Promise<GitHubIssue[]> {
    const { data } = await octokit.issues.listForRepo({
        owner, repo,
        state: "open",
        per_page: Math.min(limit, 100),
        sort: "updated",
        direction: "desc",
    });
    return data
        .filter((i) => !i.pull_request) // exclude PRs from issue list
        .map((i) => ({
            number: i.number,
            title: i.title,
            body: i.body ?? "",
            htmlUrl: i.html_url,
            labels: i.labels
                .map((l) => (typeof l === "string" ? l : l.name ?? ""))
                .filter(Boolean),
            state: i.state,
        }));
}

// Fetch comments on an issue
export async function fetchIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    limit = 10
): Promise<IssueComment[]> {
    try {
        const { data } = await octokit.issues.listComments({
            owner, repo,
            issue_number: issueNumber,
            per_page: Math.min(limit, 30),
        });
        return data.map((c) => ({
            author: c.user?.login ?? "unknown",
            body: c.body ?? "",
            createdAt: c.created_at,
        }));
    } catch {
        return [];
    }
}

// Fetch PRs that reference this issue and their changed files
// This is the most valuable data â€” if a PR exists, we know exactly
// which files need to change without any AI guessing
export async function fetchLinkedPRs(
    owner: string,
    repo: string,
    issueNumber: number
): Promise<LinkedPR[]> {
    try {
        // Search for PRs that mention this issue number
        const { data } = await octokit.search.issuesAndPullRequests({
            q: `repo:${owner}/${repo} is:pr #${issueNumber} in:body`,
            per_page: 5,
        });

        const prs: LinkedPR[] = [];

        for (const item of data.items.slice(0, 3)) {
            if (!item.pull_request) continue;

            try {
                // Get PR details including merge status
                const { data: prData } = await octokit.pulls.get({
                    owner, repo,
                    pull_number: item.number,
                });

                // Get files changed in this PR
                const { data: filesData } = await octokit.pulls.listFiles({
                    owner, repo,
                    pull_number: item.number,
                    per_page: 30,
                });

                prs.push({
                    number: item.number,
                    title: item.title,
                    state: prData.state,
                    merged: prData.merged ?? false,
                    changedFiles: filesData.map((f) => f.filename),
                    htmlUrl: item.html_url,
                });
            } catch {
                // Skip this PR if we can't fetch details
                continue;
            }
        }

        return prs;
    } catch {
        return [];
    }
}
// Fetch raw file content from GitHub using native fetch
export async function fetchRawFile(
    owner: string,
    repo: string,
    commitSha: string,
    fileId: string
): Promise<string> {
    try {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${fileId}`;
        const response = await fetch(url, {
            headers: {
                Authorization: `token ${config.github.token}`,
            },
        });
        
        if (!response.ok) {
            console.log(`[issueClient] Failed to fetch ${fileId}: ${response.statusText}`);
            return "";
        }
        
        const content = await response.text();
        const lines = content.split("\n").length;
        console.log(`[issueClient] fetched ${fileId} — ${lines} lines`);
        return content;
    } catch (err) {
        console.error(`[issueClient] Error fetching ${fileId}:`, err);
        return "";
    }
}


