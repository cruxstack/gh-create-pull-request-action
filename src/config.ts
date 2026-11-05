import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Inputs } from './lib/actions.ts';
import { assertRefName, parseRepository } from './lib/refname.ts';

export const BODY_MAX = 65_536;

export interface Author {
  name: string;
  email: string;
}

export interface Config {
  token: string;
  owner: string;
  repo: string;
  workingDirectory: string;
  commitMessage: string;
  commitPaths: string[];
  commitAuthor: Author | undefined;
  headBranch: string;
  /** Empty means the repository's default branch. */
  baseBranch: string;
  title: string;
  /** Undefined when neither pr-body nor pr-body-file is set. */
  body: string | undefined;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  teamReviewers: string[];
  draft: boolean;
  closeIfEmpty: boolean;
}

function parseAuthor(value: string): Author | undefined {
  if (!value) return undefined;
  const m = /^([^<>]+?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(value);
  if (!m) throw new Error(`commit-author '${value}' must look like 'Name <email>'`);
  return { name: m[1]!, email: m[2]! };
}

/** Reads a regular file that resolves inside the workspace. */
function readWorkspaceFile(workspace: string, file: string): string {
  const root = realpathSync(workspace);
  const full = realpathSync(resolve(root, file));
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error(`pr-body-file '${file}' resolves outside the workspace`);
  }
  const info = statSync(full);
  if (!info.isFile()) throw new Error(`pr-body-file '${file}' is not a regular file`);
  if (info.size > BODY_MAX * 4) throw new Error(`pull request body exceeds ${BODY_MAX} characters`);
  return readFileSync(full, 'utf8');
}

function readBody(inputs: Inputs, cwd: string): string | undefined {
  const text = inputs.get('pr-body');
  const file = inputs.get('pr-body-file');
  if (text && file) throw new Error('set only one of pr-body and pr-body-file');
  const body = file ? readWorkspaceFile(cwd, file) : text || undefined;
  if (body !== undefined && body.length > BODY_MAX) throw new Error(`pull request body exceeds ${BODY_MAX} characters`);
  return body;
}

function names(inputs: Inputs, name: string, pattern: RegExp): string[] {
  const values = inputs.list(name, { commas: true }).map((v) => v.replace(/^@/, ''));
  for (const value of values) if (!pattern.test(value)) throw new Error(`${name} entry '${value}' is invalid`);
  return [...new Set(values)];
}

export function readConfig(inputs: Inputs, cwd: string): Config {
  const baseBranch = inputs.get('pr-base-branch');
  return {
    token: inputs.required('github-token'),
    ...parseRepository(inputs.required('github-repository')),
    workingDirectory: resolve(cwd, inputs.string('working-directory', '.')),
    commitMessage: inputs.string('commit-message', 'chore: automated update'),
    commitPaths: inputs.list('commit-paths'),
    commitAuthor: parseAuthor(inputs.get('commit-author')),
    headBranch: assertRefName('pr-head-branch', inputs.required('pr-head-branch')),
    baseBranch: baseBranch ? assertRefName('pr-base-branch', baseBranch) : '',
    title: inputs.required('pr-title'),
    body: readBody(inputs, cwd),
    labels: [...new Set(inputs.list('pr-labels', { commas: true }))],
    assignees: names(inputs, 'pr-assignees', /^[A-Za-z0-9-]+$/),
    reviewers: names(inputs, 'pr-reviewers', /^[A-Za-z0-9-]+(\[bot\])?$/),
    teamReviewers: names(inputs, 'pr-team-reviewers', /^(?:[A-Za-z0-9-]+\/)?[A-Za-z0-9._-]+$/).map((t) => t.replace(/^.*\//, '')),
    draft: inputs.boolean('pr-draft', false),
    closeIfEmpty: inputs.boolean('pr-close-if-empty', true),
  };
}
