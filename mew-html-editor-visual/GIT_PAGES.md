# Pure GitHub / GitLab Pages editor

This mode has no application server. `git-editor.html` collects repository settings and a user token, then `public/git-platform.js` talks directly to the GitHub or GitLab REST API from the browser. The token is held in `sessionStorage`; it is not put in a URL or Pages artifact.

Editing and clicking **Save** only stage a browser-local draft in IndexedDB. Clicking **提交 PR/MR** performs the remote operation:

1. Re-read every edited file and reject the submission if its base version changed.
2. Create one temporary branch from the selected target branch.
3. Automatically choose the source repository: users with target-repository write access get a temporary branch in the original repository; outside contributors use an existing or newly created personal fork.
4. Create one Git commit containing all staged files on that temporary branch.
5. Open a GitHub pull request or GitLab merge request back to the target repository; the target repository is never written directly.

A PR/MR cannot exist without a commit, so the single commit in step 4 is an unavoidable Git object. It is created only on the temporary source branch and only when the user explicitly submits.

## Permissions

- GitHub fine-grained PAT: repository **Contents: write** and **Pull requests: write**.
- GitLab personal/project access token: `api` scope.
- Outside contributors do not need write permission on the target repository. Fork creation must be permitted by the platform/repository policy. GitHub fine-grained tokens may additionally require repository Administration write permission to create a fork; a classic PAT is often simpler for this workflow.

For private repositories, HTML text editing works through authenticated API calls. Relative images/styles in the preview use provider raw URLs, which browsers cannot attach the PAT to; those assets may therefore be absent unless they are public.

Repository HTML runs only inside a sandboxed, opaque-origin iframe, including the full-page preview. It cannot read the parent page's `sessionStorage` token. Use HTTPS for self-managed provider API URLs; plain HTTP is accepted only for localhost development.

## Deployment

- GitHub: run the included **Deploy Git editor to Pages** workflow, then enable GitHub Pages with **GitHub Actions** as the source.
- GitLab: the included `pages` job publishes the same static files as GitLab Pages.
- Pull requests and merge requests run the same syntax and model tests before merge. Pages deployment runs only from the default branch after those tests pass.

Do not place a PAT in Actions variables for this editor. Each user supplies their own token in the browser, so PR/MR authorship and permissions belong to that user.
