import { runAction } from './lib/actions.js';
import { GitHub } from './lib/github.js';
import { collectChanges } from './changes.js';
import { readConfig } from './config.js';
import { run } from './run.js';
await runAction(async (rt) => {
    const config = readConfig(rt.inputs, process.cwd());
    rt.mask(config.token);
    const local = await collectChanges(config.workingDirectory, config.commitPaths, rt.log);
    const github = new GitHub({
        token: config.token,
        userAgent: 'cruxstack/gh-create-pull-request-action',
        apiUrl: rt.env['GITHUB_API_URL'],
        log: rt.log,
    });
    return run(config, { github, log: rt.log, local });
});
