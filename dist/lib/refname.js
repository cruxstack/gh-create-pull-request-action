// Branch and tag name validation following `git check-ref-format`.
export function refNameProblem(name) {
    if (!name)
        return 'is empty';
    if (name.length > 255)
        return 'is longer than 255 characters';
    if (name === '@')
        return "is '@'";
    if (name.startsWith('/') || name.endsWith('/') || name.includes('//'))
        return "has an empty '/' component";
    if (name.endsWith('.'))
        return "ends with '.'";
    if (name.includes('..'))
        return "contains '..'";
    if (name.includes('@{'))
        return "contains '@{'";
    if (/[\x00-\x20\x7f~^:?*[\\]/.test(name))
        return 'contains a forbidden character';
    for (const part of name.split('/')) {
        if (part.startsWith('.'))
            return "has a component starting with '.'";
        if (part.endsWith('.lock'))
            return "has a component ending with '.lock'";
    }
    if (name.startsWith('-'))
        return "starts with '-'";
    return undefined;
}
export function assertRefName(kind, name) {
    const problem = refNameProblem(name);
    if (problem)
        throw new Error(`${kind} '${name}' ${problem}`);
    return name;
}
export const isCommitSha = (value) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
export function parseRepository(value) {
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(value);
    if (!match || match[2] === '.' || match[2] === '..')
        throw new Error(`repository '${value}' must be 'owner/name'`);
    return { owner: match[1], repo: match[2] };
}
