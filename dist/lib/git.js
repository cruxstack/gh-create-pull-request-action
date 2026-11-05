// Git runner: argv only (never a shell), hardened config, no credential or remote access.
import { execFile } from 'node:child_process';
export class GitError extends Error {
    code;
    stderr;
    constructor(args, code, stderr) {
        super(`git ${args.join(' ')} failed${code === null ? '' : ` with ${code}`}: ${stderr.trim() || 'no output'}`);
        this.name = 'GitError';
        this.code = code;
        this.stderr = stderr;
    }
}
const HARDENING = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'color.ui=false', '-c', 'diff.external='];
export class Git {
    cwd;
    #env;
    constructor(cwd, env = process.env) {
        this.cwd = cwd;
        this.#env = {
            ...env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_PAGER: 'cat',
            LC_ALL: 'C',
        };
    }
    run(args, okCodes = [0]) {
        return new Promise((resolve, reject) => {
            execFile('git', [...HARDENING, ...args], { cwd: this.cwd, env: this.#env, encoding: 'buffer', maxBuffer: 1024 ** 3, windowsHide: true }, (error, stdout, stderr) => {
                const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
                const errText = stderr.toString('utf8');
                if (code === null || !okCodes.includes(code))
                    reject(new GitError(args, code, errText || (error?.message ?? '')));
                else
                    resolve({ code, stdout, stderr: errText });
            });
        });
    }
    async text(args) {
        return (await this.run(args)).stdout.toString('utf8').trim();
    }
    /** Whether the object exists locally. */
    async has(rev) {
        return (await this.run(['cat-file', '-e', `${rev}^{commit}`], [0, 1, 128])).code === 0;
    }
}
/** Splits NUL-terminated output. */
export function splitNul(output) {
    const parts = output.toString('utf8').split('\0');
    if (parts.at(-1) === '')
        parts.pop();
    return parts;
}
