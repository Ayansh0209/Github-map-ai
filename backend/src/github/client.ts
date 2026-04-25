import { Octokit } from "@octokit/rest";
import { config } from "../config/config";

const octokit = new Octokit({
    auth: config.github.token,
});

export interface RepoMetadata {
    defaultBranch: string;
    commitSha: string;
    sizeMB: number;
    isPrivate: boolean;
    owner: string;
    repo: string;
}

export async function fetchRepoMetadata(
    owner: string,
    repo: string
): Promise<RepoMetadata> {


    const { data } = await octokit.repos.get({ owner, repo });
    const sizeMB = data.size / 1024;

    if (data.private) {
        throw new Error("Private repositories are not supported yet");
    }

    if (sizeMB > 500) {
        throw new Error(
            `Repository too large: ${sizeMB.toFixed(0)}MB. Maximum is 500MB`
        );
    }

    // get latest commit SHA on default branch
    // this SHA is your cache key - immutable forever
    const { data: commit } = await octokit.repos.getCommit({
        owner,
        repo,
        ref: data.default_branch,
    });

    return {
        defaultBranch: data.default_branch,
        commitSha: commit.sha,
        sizeMB,
        isPrivate: data.private,
        owner,
        repo,
    };
}