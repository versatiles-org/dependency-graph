# VersaTiles dependency graph

How the repositories of the [versatiles-org](https://github.com/versatiles-org) organisation build on each other, and where each link is declared.

The site is published at <https://versatiles.org/dependency-graph/>. The full record is available as [`dependency-graph.json`](https://versatiles.org/dependency-graph/dependency-graph.json).

## How it updates

The workflow in `.github/workflows/ci.yml` runs once a day, and on every push to `main`. It reads the public repositories, rebuilds the page and the JSON, commits them if the data changed, and deploys the site.

To correct or extend the graph, edit `scripts/dependency-graph.yaml`.

## Development

```sh
npm ci
npm run dev            # preview the site
npm run sync:deps      # regenerate index.md and public/dependency-graph.json
npm run deps:drift     # report outdated versions (not committed)
npm run check          # format, lint, type-check, test and build
```

`npm run check` deliberately doesn't compare the graph with GitHub, so a change in another repository can't fail it. To run that comparison by hand, use `npm run sync:deps -- --check`.

A GitHub token is read from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.
