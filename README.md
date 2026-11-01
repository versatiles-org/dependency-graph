# VersaTiles dependency graph

How the repositories of the [versatiles-org](https://github.com/versatiles-org) organisation build on each other, and where each link is declared.

The site is published at <https://versatiles.org/dependency-graph/>. The full record is available as [`dependency-graph.json`](https://versatiles.org/dependency-graph/dependency-graph.json).

The [status page](https://versatiles.org/dependency-graph/status/) is for people working on VersaTiles. It shows which repositories use an outdated release of the project's own packages, in the order to update them, whether exact releases pinned in formulas, manifests and image tags have fallen behind, and whether deployments run the latest releases. Its data is available as [`status.json`](https://versatiles.org/dependency-graph/status.json).

## How it updates

The workflow in `.github/workflows/ci.yml` runs every six hours, and on every push to `main`. It reads the public repositories, rebuilds the graph page, its JSON and the status snapshot, commits the graph if its data changed, and deploys the site.

The status snapshot changes with every release, so it is deployed but never committed. If it can't be collected, the graph still updates and the status page shows the error.

To correct or extend the graph, edit `scripts/dependency-graph.yaml`.

## Development

```sh
npm ci
npm run dev            # preview the site
npm run sync:deps      # regenerate index.md, public/dependency-graph.json and public/status.json
npm run deps:drift     # print the outdated versions in the terminal
npm run check          # format, lint, type-check, test and build
```

`npm run check` deliberately doesn't compare the graph with GitHub, so a change in another repository can't fail it. To run that comparison by hand, use `npm run sync:deps -- --check`.

A GitHub token is read from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.
