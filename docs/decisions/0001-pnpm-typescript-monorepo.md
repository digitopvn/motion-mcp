# 0001. pnpm TypeScript monorepo

## Status

Accepted.

## Context

The engine has one owning package for each external dependency: HyperFrames,
Pi, multix, OpenRouter, TypeSafe and Polar. Several apps sit on top of those
packages: the MCP server, the marketing site, and later a dashboard and a
render worker. The upstream runtimes set a floor on the Node version:

- The Pi packages (`@earendil-works/*` 0.87.1) require Node 22.19 or later.
- The HyperFrames CLI, engine and producer require Node 22 or later.
- multix requires Node 20 or later.

All of these upstream packages are ESM.

## Decision

- Use a single pnpm-workspaces monorepo with `apps/*` and `packages/*`.
- Write TypeScript as ESM, with `engines.node >= 22.19`.
- Use vitest for tests and biome for linting and formatting.
- Expose `check`, `test`, `lint`, `typecheck` and `build` as root scripts.

## Alternatives considered

| Option | Why it was not chosen |
|---|---|
| npm or Yarn workspaces | pnpm's strict `node_modules` catches undeclared dependencies across package boundaries. That matters because boundaries are the main architectural control here. |
| Bun workspaces (what HyperFrames uses) | Pi and multix are developed and tested on Node. The production render image is Node 22. |
| Turborepo or Nx on top | Unnecessary at this size. pnpm filters are enough, and a task runner can be added later without restructuring. |
| Polyrepo | The IR, compiler and pipeline change together, and cross-repo versioning would slow every schema change. |
| ESLint plus Prettier, or Jest | Biome is a single fast tool. Vitest is ESM-native and needs no transform configuration. |

## Reason

One repository keeps the schema, compiler, pipeline and server in lockstep. The
Node floor is dictated by the strictest upstream package, which is Pi.

## Trade-offs

- pnpm is stricter than npm, so upstream packages that rely on hoisting may
  need a `public-hoist-pattern` entry.
- Biome's lint rule set is smaller than ESLint's.

## Migration strategy

Packages communicate only through their public exports. Adding a task runner,
or splitting a package into its own repository, does not require changes to
package code.
