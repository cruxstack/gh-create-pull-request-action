import { path } from './lib/github.js';
import { assertRefName } from './lib/refname.js';
import { buildEntries } from './tree.js';
export async function run(config, { github, log, local }) {
    const repoPath = path `/repos/${config.owner}/${config.repo}`;
    const head = config.headBranch;
    const { data: repo } = await github.request('GET', repoPath);
    const base = config.baseBranch || assertRefName('default branch', repo.default_branch);
    if (head === base)
        throw new Error(`pr-head-branch '${head}' must differ from the base branch`);
    if (head === repo.default_branch)
        throw new Error(`pr-head-branch '${head}' must not be the default branch`);
    const getBranch = async (name) => {
        const ref = await github.request('GET', repoPath + path `/git/ref/heads/${name}`, { allowStatus: [404] });
        if (ref.status === 404)
            return undefined;
        const commit = await github.request('GET', repoPath + path `/git/commits/${ref.data.object.sha}`);
        return { sha: ref.data.object.sha, tree: commit.data.tree.sha };
    };
    const baseBranch = await getBranch(base);
    if (!baseBranch)
        throw new Error(`base branch '${base}' does not exist`);
    let tree = baseBranch.tree;
    if (local.changes.length) {
        const known = await github.request('GET', repoPath + path `/git/commits/${local.head}`, { allowStatus: [404, 422] });
        if (known.status !== 200)
            throw new Error(`local commit ${local.head} is not on GitHub; push it first`);
        const entries = await buildEntries(github, repoPath, baseBranch.tree, local, log);
        if (entries.length) {
            const created = await github.request('POST', `${repoPath}/git/trees`, {
                body: { base_tree: baseBranch.tree, tree: entries },
                idempotent: true,
            });
            tree = created.data.sha;
        }
    }
    log.info(`${local.changes.length} local change(s) relative to ${local.head}`);
    const headBranch = await getBranch(head);
    let pr = await findPullRequest(github, repoPath, config.owner, head, base);
    const result = (operation, sha = '') => ({
        'pr-number': pr?.number ?? '',
        'pr-url': pr?.html_url ?? '',
        'pr-operation': operation,
        'pr-head-sha': sha,
        'pr-head-branch': head,
    });
    if (tree === baseBranch.tree) {
        if (!config.closeIfEmpty || (!pr && !headBranch)) {
            log.info(`No changes relative to ${base}`);
            return result('skipped', headBranch?.sha);
        }
        if (pr) {
            await github.request('PATCH', repoPath + path `/pulls/${pr.number}`, { body: { state: 'closed' } });
            log.info(`Closed pull request #${pr.number}: no changes relative to ${base}`);
        }
        if (headBranch) {
            await github.request('DELETE', repoPath + path `/git/refs/heads/${head}`, { allowStatus: [404, 422] });
            log.info(`Deleted branch ${head}`);
        }
        return result('closed');
    }
    if (headBranch?.tree === tree) {
        if (pr) {
            await syncPullRequest(github, repoPath, pr, config);
            log.info(`Branch ${head} is already up to date`);
            return result('unchanged', headBranch.sha);
        }
        pr = await openPullRequest(github, repoPath, config, base);
        await decorate(github, repoPath, pr.number, config, log);
        return result('created', headBranch.sha);
    }
    const commit = await github.request('POST', `${repoPath}/git/commits`, {
        body: { message: config.commitMessage, tree, parents: [baseBranch.sha], ...(config.commitAuthor ? { author: config.commitAuthor } : {}) },
        idempotent: true,
    });
    const sha = commit.data.sha;
    await setBranch(github, repoPath, head, sha, headBranch !== undefined);
    log.info(`Pushed ${sha} to ${head}`);
    let operation = 'updated';
    if (pr) {
        await syncPullRequest(github, repoPath, pr, config);
    }
    else {
        pr = await openPullRequest(github, repoPath, config, base);
        operation = 'created';
    }
    await decorate(github, repoPath, pr.number, config, log);
    log.info(`${operation === 'created' ? 'Created' : 'Updated'} pull request #${pr.number}`);
    return result(operation, sha);
}
async function setBranch(github, repoPath, branch, sha, exists) {
    if (!exists) {
        const created = await github.request('POST', `${repoPath}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha }, allowStatus: [422], idempotent: true });
        if (created.status !== 422)
            return;
    }
    await github.request('PATCH', repoPath + path `/git/refs/heads/${branch}`, { body: { sha, force: true } });
}
async function findPullRequest(github, repoPath, owner, head, base) {
    const { data } = await github.request('GET', `${repoPath}/pulls`, { query: { head: `${owner}:${head}`, base, state: 'open', per_page: 1 } });
    return data[0];
}
async function openPullRequest(github, repoPath, config, base) {
    const res = await github.request('POST', `${repoPath}/pulls`, {
        body: { title: config.title, head: config.headBranch, base, body: config.body ?? '', draft: config.draft },
        allowStatus: [422],
        // GitHub allows one open PR per head and base, so a retry cannot duplicate it.
        idempotent: true,
    });
    if (res.status !== 422)
        return res.data;
    const existing = await findPullRequest(github, repoPath, config.owner, config.headBranch, base);
    if (!existing)
        throw new Error(`could not create pull request: ${res.data.message ?? 'unprocessable'}`);
    await syncPullRequest(github, repoPath, existing, config);
    return existing;
}
/** Updates only the fields that were set and differ. */
async function syncPullRequest(github, repoPath, pr, config) {
    const changes = {};
    if (pr.title !== config.title)
        changes['title'] = config.title;
    if (config.body !== undefined && (pr.body ?? '') !== config.body)
        changes['body'] = config.body;
    if (!Object.keys(changes).length)
        return;
    await github.request('PATCH', repoPath + path `/pulls/${pr.number}`, { body: changes });
}
async function decorate(github, repoPath, number, config, log) {
    const issue = repoPath + path `/issues/${number}`;
    if (config.labels.length)
        await github.request('POST', `${issue}/labels`, { body: { labels: config.labels }, idempotent: true });
    if (config.assignees.length)
        await github.request('POST', `${issue}/assignees`, { body: { assignees: config.assignees }, idempotent: true });
    if (config.reviewers.length || config.teamReviewers.length) {
        const res = await github.request('POST', repoPath + path `/pulls/${number}/requested_reviewers`, {
            body: { reviewers: config.reviewers, team_reviewers: config.teamReviewers },
            allowStatus: [422],
            idempotent: true,
        });
        if (res.status === 422)
            log.warning(`Could not request reviewers: ${res.data.message ?? 'unprocessable'}`);
    }
}
