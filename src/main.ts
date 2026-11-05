import { runAction } from './lib/actions.ts';
import { GitHub } from './lib/github.ts';
import { collectChanges } from './changes.ts';
import { readConfig } from './config.ts';
import { run } from './run.ts';

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
