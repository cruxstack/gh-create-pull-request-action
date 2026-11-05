# gh-create-pull-request-action

Commits the changes in your working tree through the GitHub API and opens or updates a pull
request. Nothing is pushed with git, and the token never touches git config or disk.

- Commits are created with the Git Data API, so GitHub signs them when the token belongs to a
  GitHub App or is `GITHUB_TOKEN`.
- Re-runs that produce the same content don't create a new commit or force-push, so they don't
  restart CI on the pull request.
- Your index and working tree are left untouched; changes are read from a throwaway index.
- Small text files are sent inline with the tree; only binaries and large files are uploaded as
  separate blobs, a few at a time, and each upload is checked against its local hash.
- No runtime dependencies. The token is only ever sent to the GitHub API.

## Usage

```yaml
permissions: {}

jobs:
  update:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@<full-commit-sha> # v7
        with:
          persist-credentials: false

      - run: make generate

      - id: app-token
        uses: actions/create-github-app-token@<full-commit-sha>
        with:
          app-id: ${{ vars.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}

      - id: pr
        uses: cruxstack/gh-create-pull-request-action@<full-commit-sha> # v1.0.0
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          pr-head-branch: bot/generate
          pr-title: "chore: regenerate files"
          pr-labels: automated
```

Pin the action to a full commit SHA. Release tags are immutable.

Pull requests opened with `GITHUB_TOKEN` don't trigger other workflows. Use a GitHub App token if
the pull request needs CI.

## Inputs

| Name | Default | Description |
|---|---|---|
| `github-token` | `github.token` | Token with `contents: write` and `pull-requests: write`. |
| `github-repository` | `github.repository` | Repository to update, as `owner/name`. |
| `working-directory` | `.` | Directory inside the checked-out repository. |
| `commit-message` | `chore: automated update` | Commit message. |
| `commit-paths` | every change | Git pathspecs to include, one per line, relative to `working-directory`. |
| `commit-author` | token identity | Commit author as `Name <email>`. |
| `pr-head-branch` | | **Required.** Branch that holds the changes. It is force-updated. |
| `pr-base-branch` | default branch | Branch to merge into. |
| `pr-title` | | **Required.** Pull request title. |
| `pr-body` | | Pull request body. |
| `pr-body-file` | | Workspace file containing the pull request body. |
| `pr-labels` | | Labels to add, one per line or comma-separated. |
| `pr-assignees` | | Users to assign. |
| `pr-reviewers` | | Users to request reviews from. |
| `pr-team-reviewers` | | Team slugs to request reviews from. |
| `pr-draft` | `false` | Open new pull requests as drafts. |
| `pr-close-if-empty` | `true` | Close the pull request and delete its branch when no changes remain. |

## Outputs

| Name | Description |
|---|---|
| `pr-number` | Pull request number. |
| `pr-url` | Pull request URL. |
| `pr-operation` | `created`, `updated`, `unchanged`, `closed` or `skipped`. |
| `pr-head-sha` | Commit at the head of the pull request branch. |
| `pr-head-branch` | Pull request branch. |

## How it works

1. Changes are everything that differs from the checked-out commit (`HEAD`): staged, unstaged and
   untracked files, deletions, the executable bit and symlinks. Ignored files are skipped, and
   `commit-paths` entries that match nothing produce a warning.
2. The checked-out commit must exist on GitHub. Local commits that were never pushed fail the step
   instead of being silently dropped.
3. One commit is built on the current tip of the base branch. Changed files replace whatever the
   base has at that path; there is no merge. Deleting a file the base no longer has is a no-op.
4. The head branch is force-updated to that commit, so commits pushed to it by hand are replaced.
   It can't be the base branch or the repository's default branch.
5. When the result matches the head branch, nothing is pushed (`unchanged`). When it matches the
   base branch, the pull request is closed and the branch deleted (`closed`), or left alone with
   `pr-close-if-empty: false` (`skipped`).
6. Existing pull requests only get the title and body updated, and only when they differ.
   Labels, assignees and reviewers are added when a commit is pushed or a pull request is opened.

Limitations:

- Submodule changes are skipped with a warning.
- Git LFS objects are not uploaded; files tracked by LFS are committed as pointers.
- Setting `commit-author` may prevent GitHub from signing the commit.
- Files over 100 MiB are rejected, matching GitHub's limit.

## Development

```sh
npm ci
npm test           # builds, then runs all tests offline
npm run coverage   # tests with coverage thresholds
```

Commit `dist/` together with source changes; CI fails when it is stale.

## License

[MIT](LICENSE)

## Acknowledgements

Thanks to [peter-evans/create-pull-request](https://github.com/peter-evans/create-pull-request),
which inspired this action.
