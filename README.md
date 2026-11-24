# VersaTiles dependency graph

How the repositories of the [versatiles-org](https://github.com/versatiles-org) organisation build on each other, and where each link is declared.

The site is published at <https://versatiles.org/dependency-graph/>. The full record is available as [`dependency-graph.json`](https://versatiles.org/dependency-graph/dependency-graph.json).

The status page is for people working on VersaTiles, in the private area of [status.versatiles.org](https://status.versatiles.org/private/dependency-status/). It shows which repositories use an outdated release of the project's own packages, in the order to update them, whether exact releases pinned in formulas, manifests, image tags and release bundles have fallen behind, whether deployments run the latest releases, and for each repository what is open, whether its checks pass and what is waiting to be released. Its old address, versatiles.org/dependency-graph/status/, forwards there.

## How it updates

The workflow in `.github/workflows/ci.yml` runs every six hours, on every push to `main` and on pull requests. It reads the public repositories, generates the graph page and its JSON (`npm run sync:deps -- --no-status`), and deploys the site. None of these files is committed, so a fresh checkout shows a placeholder until `npm run sync:deps` has run.

The status page is built by status.versatiles.org, from this repo's code: within ten minutes of a change in any public repository (through an organisation webhook), and at least every six hours. If the status snapshot can't be collected, the page shows the error.

To correct or extend the graph, edit `scripts/dependency-graph.yaml`.

## Development

```sh
npm ci
npm run dev            # preview the site
npm run sync:deps      # regenerate index.md, public/dependency-graph.json and public/status.json
npm run check          # format, lint, type-check, test and build
npm run build:status   # build the status page alone, for status.versatiles.org (see below)
```

status.versatiles.org builds the status page alone, for its private area: it runs `npm run sync:deps` and `npm run build:status` on its server. `npm run build` leaves it out of the public site and puts a forwarding page (`status-moved.md`) at its old address. `STATUS_SITE_BASE` sets the base path (default `/private/dependency-status/`) and `STATUS_SITE_OUT` the output folder (default `.vitepress/dist-status`).

`npm run check` deliberately doesn't read GitHub, so a change in another repository can't fail it.

A GitHub token is read from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.

Every run reads each repository as of its head commit, and keeps the files it reads in `.cache/github` under their git hashes. The next run fetches only what changed, and a run that completes removes what it didn't use. CI keeps the folder between runs with `actions/cache`. Nothing there can go stale, and deleting it only makes one run slower.
