# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It is how the version and the CHANGELOG are decided.

> This project is a **private app** (deployed to GitHub Pages, not published to npm). Changesets here drives **versioning, the changelog, and GitHub Releases** — there is no npm publish step.

## Adding a changeset

When you make a change worth recording, run:

```bash
npm run changeset
```

Pick the bump type (patch / minor / major) and write a one-line summary. This drops a markdown file in `.changeset/`. Commit it with your PR.

## How a release happens

On merge to `main`, the release workflow (`.github/workflows/release.yml`) either:

1. **Opens/updates a "Version Packages" PR** that consumes the pending changesets — bumping the version in `package.json` and writing `CHANGELOG.md`; or
2. Once that PR is merged, **tags the version** (`npx changeset tag`) and creates the **GitHub Release**.

The app itself ships via `deploy.yml` (GitHub Pages) on every push to `main`. You never bump the version or edit the changelog by hand — add a changeset and let the bot do it.
