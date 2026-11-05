import { path } from './lib/github.js';
export const INLINE_MAX = 1024 * 1024;
export const INLINE_TOTAL_MAX = 8 * 1024 * 1024;
export const BLOB_MAX = 100 * 1024 * 1024;
const CONCURRENCY = 8;
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Returns the text when it can be sent inline without changing a byte. */
export function inlineText(data) {
    if (data.length > INLINE_MAX || data.includes(0))
        return undefined;
    try {
        return utf8.decode(data);
    }
    catch {
        return undefined;
    }
}
/** Paths that exist as files (not directories) in the base tree, walking only directories that matter. */
export async function existingFiles(github, repoPath, baseTree, paths) {
    const wanted = new Set(paths);
    const dirs = new Set();
    for (const p of paths) {
        const segments = p.split('/');
        for (let i = 1; i < segments.length; i++)
            dirs.add(segments.slice(0, i).join('/'));
    }
    const found = new Set();
    let level = [{ dir: '', sha: baseTree }];
    while (level.length) {
        const next = [];
        await mapLimit(level, CONCURRENCY, async ({ dir, sha }) => {
            const { data } = await github.request('GET', repoPath + path `/git/trees/${sha}`);
            if (data.truncated)
                throw new Error(`base tree '${dir || '/'}' is too large to inspect`);
            for (const entry of data.tree) {
                const full = dir ? `${dir}/${entry.path}` : entry.path;
                if (entry.type === 'tree') {
                    if (dirs.has(full))
                        next.push({ dir: full, sha: entry.sha });
                }
                else if (wanted.has(full)) {
                    found.add(full);
                }
            }
        });
        level = next;
    }
    return found;
}
export async function buildEntries(github, repoPath, baseTree, local, log) {
    const deletions = local.changes.filter((c) => c.mode === null).map((c) => c.path);
    // Deleting a path the base lacks would fail tree creation, so only existing files are deleted.
    const present = deletions.length ? await existingFiles(github, repoPath, baseTree, deletions) : new Set();
    for (const p of deletions)
        if (!present.has(p))
            log.info(`'${p}' is already absent on the base branch`);
    let inlineBytes = 0;
    const entries = await mapLimit(local.changes, CONCURRENCY, async (change) => {
        if (change.mode === null || change.sha === null) {
            return present.has(change.path) ? { path: change.path, mode: '100644', type: 'blob', sha: null } : undefined;
        }
        const data = await local.read(change.sha);
        if (data.length > BLOB_MAX)
            throw new Error(`'${change.path}' is larger than GitHub's ${BLOB_MAX / 1024 / 1024} MiB file limit`);
        const text = change.mode === '120000' ? undefined : inlineText(data);
        if (text !== undefined && inlineBytes + data.length <= INLINE_TOTAL_MAX) {
            inlineBytes += data.length;
            return { path: change.path, mode: change.mode, type: 'blob', content: text };
        }
        const { data: blob } = await github.request('POST', `${repoPath}/git/blobs`, {
            body: { content: data.toString('base64'), encoding: 'base64' },
            idempotent: true,
        });
        if (change.sha.length === blob.sha.length && blob.sha !== change.sha) {
            throw new Error(`uploaded '${change.path}' as ${blob.sha}, expected ${change.sha}`);
        }
        return { path: change.path, mode: change.mode, type: 'blob', sha: blob.sha };
    });
    return entries.filter((e) => e !== undefined);
}
