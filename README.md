# PairLobby durable runtime

[PairLobby](https://github.com/PairLobby/app) rooms on Durable Objects. This is the same accountless relay as `pairlobby serve`, written as a Worker with one Durable Object per room. It runs on [Celld](https://github.com/denoland/celld), Deno's self-hosted Durable Object runtime, and unchanged on Cloudflare. The ordinary `pairlobby` CLI talks to it with `--server <url>`; nothing in the CLI is specific to it.

It is two things:

- **A relay you can run.** `wrangler.jsonc` and `src/standalone.ts` are a complete Worker. The config uses only keys Celld accepts: no routes, account id, rate limits, email, D1 or secrets.
- **A library.** `@pairlobby/durable-runtime` on npm exports the pieces, for a Worker that wants PairLobby rooms inside something larger: `DurableRoomStore` (a `RoomStore` on Durable Object SQLite), `PairLobbyRoom`, `PairLobbyInviteDirectory` and `handleRelay`.

The room protocol, the rules and the HTTP router are not here. They come from `@pairlobby/protocol`, `@pairlobby/room-core` and `@pairlobby/server-core`, published from the [app repository](https://github.com/PairLobby/app). This repository only adapts storage, routing and time to Durable Objects.

## Run a relay

Needs Node 22 or newer.

```sh
npm install
npm run dev                       # Wrangler's local runtime
npm run dev:celld -- --port 9876  # Celld; state stays in .celld/dev across restarts
```

Then, from any device that can reach it:

```sh
pairlobby create --name my-project --server http://127.0.0.1:9876
pairlobby join <CODE> --server http://127.0.0.1:9876 --runtime codex
```

Celld bundles with esbuild and looks for it on `PATH`. `npm run dev:celld` points it at the copy installed here through `CELLD_ESBUILD`; set that yourself when you call `celld` directly.

To deploy to Cloudflare, `npx wrangler deploy` with your own account. `npm run check` bundles the Worker without deploying it.

## How it works

Each room's SQLite state and its auto-close alarm live in that room's own object. The relay Worker picks a new room's id, because the id names the object that will hold it. An invite code is claimed in a small directory object named by the code's digest, so two rooms can never hold one code and no global coordinator serializes unrelated invitations. Requests to one room run one at a time, which keeps its transitions ordered.

## Security

The relay has no accounts: whoever holds a room's credentials or an unspent invite code can use that room. It refuses any request that carries a browser `Origin`, as the local relay does. Set `PAIRLOBBY_ALLOWED_HOSTS` (comma-separated) to pin the `Host` values your ingress forwards. Traffic is whatever your ingress serves, so put TLS in front of anything beyond loopback.

## Use it as a library

```sh
npm install @pairlobby/durable-runtime
```

```ts
import {handleRelay, PairLobbyInviteDirectory, PairLobbyRoom} from '@pairlobby/durable-runtime';
import type {RelayEnv} from '@pairlobby/durable-runtime';

export {PairLobbyInviteDirectory, PairLobbyRoom};

export default {
    fetch(request: Request, env: RelayEnv): Promise<Response> {
        return handleRelay(request, env);
    }
} satisfies ExportedHandler<RelayEnv>;
```

Bind `ROOMS` to `PairLobbyRoom` and `INVITES` to `PairLobbyInviteDirectory`, both as SQLite classes, as `wrangler.jsonc` here does. To keep rooms in your own object instead, construct `new DurableRoomStore(ctx.storage)` and hand it to `RoomService` from `@pairlobby/server-core`.

The `@pairlobby/*` dependencies are pinned to one exact version, because those packages are released together and pin each other the same way.

## Tests

```sh
npm test            # builds, then runs both suites in Wrangler's local runtime
npm run test:celld  # the relay under `celld dev`; skipped without CELLD_BIN or celld on PATH
```

`tests/store-contract.test.ts` runs the shared room contract and the invite crash-recovery contract from `@pairlobby/fixtures` against real Durable Object SQLite. They are the same suites the in-memory and Node SQLite stores pass in the app repository, so a behaviour that differs between stores fails here. `tests/relay.test.ts` drives the standalone relay with the real client.

The Celld test covers what Wrangler's runtime cannot stand in for: the relay under `celld dev`, the auto-close alarm firing on time, and room state surviving a restart.

## Not yet qualified

Multi-node Celld fleets have not been tested. A single Celld node and Cloudflare are what the tests cover.

## Versions and releases

Versioning uses [ssmver](https://github.com/hjoncour/ssmver): `ssmver.toml` holds the version and keeps `package.json` in step. Run `ssmver init` once per clone to install its commit hooks. A commit whose message starts with `feature:` bumps the minor version, `fix:` the patch and `release:` the major; other prefixes such as `chore:` bump nothing.

On every merge to `main`, the release workflow runs the tests and then checks that version on npm. If npm does not have it, the workflow publishes `@pairlobby/durable-runtime` with provenance and tags the merged commit `v<version>`. It needs one repository secret, `NPM_TOKEN`: an npm access token that may publish to the `@pairlobby` scope. A version with a suffix, such as `0.2.0-beta.1`, goes out under the `next` tag. Pull requests run the same tests and publish nothing.

This package has its own version. It does not follow the app repository's number; the `@pairlobby/*` versions it was built against are in `package.json`.

## License

Source-available under the [Elastic License 2.0](LICENSE). You may use, copy, modify and distribute it, including inside a company and on your own relay, free of charge. Three things are not allowed: offering it to others as a hosted or managed service that gives them a substantial part of its features, getting around any license key functionality, and removing or obscuring its license and copyright notices. The [license text](LICENSE) is what governs; this paragraph is a summary.
