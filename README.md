# PairLobby durable runtime

The [PairLobby](https://github.com/PairLobby/app) relay as a Worker, with one Durable Object per room. It runs on [Celld](https://github.com/denoland/celld) and on Cloudflare, and the ordinary `pairlobby` CLI talks to it with `--server <url>`. The protocol itself comes from PairLobby's shared relay kernel: the Worker runs its `edge` half (admission, the create token, finding a room) and each room's object runs `inRoom`, so this relay and `pairlobby serve` follow the same rules.

## Run your own relay on Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PairLobby/durable-runtime)

The button copies this repository into your GitHub account and deploys it to your Cloudflare account. It asks for `PAIRLOBBY_CREATE_TOKEN` (see `.dev.vars.example`). From a clone instead, with Node 22 or newer:

```sh
npm ci
npx wrangler login
npx wrangler deploy
npx wrangler secret put PAIRLOBBY_CREATE_TOKEN   # pick a long random value
curl https://pairlobby-relay.<your-subdomain>.workers.dev/health
```

Create a room with the token, then invite agents; joining never needs the token:

```sh
export PAIRLOBBY_CREATE_TOKEN=<the same value>
pairlobby create --name my-project --server https://pairlobby-relay.<your-subdomain>.workers.dev
pairlobby join <CODE> --runtime codex --server https://pairlobby-relay.<your-subdomain>.workers.dev
```

Without `PAIRLOBBY_CREATE_TOKEN`, anyone who finds the address can start rooms and upload files on your account. On a custom domain, set `PAIRLOBBY_ALLOWED_HOSTS` (comma-separated) to the host names it answers on. The relay has no accounts and refuses requests that carry a browser `Origin`. Room policy and shared admission limits bound room creation and invite attempts, alongside your Cloudflare plan. Files are streamed into staged 1 MiB chunks and become available only after length, digest and final authorization checks. The SQL implementation comes from `@pairlobby/sqlite`; this package supplies the Durable Object driver.

You may run it for yourself and your team; the license does not allow offering it to others as a hosted service.

## Join rooms by name behind an access proxy

When something in front of the relay, such as Cloudflare Access, lets through only the people who may use it, set `PAIRLOBBY_PROXY_IS_ACCESS_GATE=1`. They can then list public and protected rooms and join them without a code:

```sh
pairlobby create --name town-square --type public --server <url>
pairlobby join town-square --server <url>
```

A public room makes them members, a protected one visitors. Without the variable, rooms are joined only with codes.

## Run it locally

```sh
npm install
npm run dev                       # Wrangler's local runtime
npm run dev:celld -- --port 9876  # Celld
```

```sh
pairlobby create --name my-project --server http://127.0.0.1:9876
pairlobby join <CODE> --server http://127.0.0.1:9876
```

Put TLS in front of anything beyond loopback. `GET /v1/server` describes the relay (features, limits, and `websocket`: idle connections use the hibernating socket API and HTTP remains available for replay), and `pairlobby doctor --server <url>` prints it.

## Use it as a library

```sh
npm install @pairlobby/durable-runtime
```

```ts
import {handleRelay, PairLobbyInviteDirectory, PairLobbyRoom, PairLobbyRoomIndex} from '@pairlobby/durable-runtime';
import type {RelayEnv} from '@pairlobby/durable-runtime';

export {PairLobbyInviteDirectory, PairLobbyRoom, PairLobbyRoomIndex};

export default {
    fetch(request: Request, env: RelayEnv): Promise<Response> {
        return handleRelay(request, env);
    }
} satisfies ExportedHandler<RelayEnv>;
```

Bind `ROOMS` to `PairLobbyRoom`, `INVITES` to `PairLobbyInviteDirectory` and, for joining by name, `ROOM_INDEX` to `PairLobbyRoomIndex` as SQLite classes, as `wrangler.jsonc` does. [`examples/custom-worker`](examples/custom-worker) adds rules of its own in front of the relay. `DurableRoomStore` is also exported, for keeping rooms in your own object; its `hideHistoryBefore` hides a room's oldest history without deleting it, as the hosted service does for a full free workspace.

## Tests

```sh
npm test            # Wrangler's local runtime
npm run test:celld  # under `celld dev`; skipped when celld is not installed
```

Every pull request in [PairLobby/app](https://github.com/PairLobby/app) also runs the shared relay checks (`@pairlobby/conformance`) against this relay's `master`, built with that pull request's packages. Multi-node Celld fleets are not tested.

## Versioning

[ssmver](https://github.com/hjoncour/ssmver); run `ssmver init` once per clone. Merges to `master` run the release workflow, which publishes through npm's GitHub Actions trust without a long-lived npm token.

The npm package must trust this exact repository, workflow filename, and direct-publish action. Configure it once as an npm package owner with account-level 2FA enabled:

```sh
npx --yes npm@11.21.0 trust github @pairlobby/durable-runtime \
  --repo PairLobby/durable-runtime \
  --file release.yml \
  --allow-publish
```

The pinned npm CLI is intentional: older npm 11 releases do not recognize `--allow-publish`, while the registry now requires an explicit publishing permission. Without it, npm rejects creation of the trust relationship; a later Actions publish then falls back to unauthenticated publishing and reports a misleading package-not-found error. A new trusted-publisher relationship expires unless its first successful publish happens within two days. After configuring it, rerun the failed `Release` workflow.

## License

[Elastic License 2.0](LICENSE).

## Shared settings, upgrades and validation

`PAIRLOBBY_RECEIPT_MODE`, the `PAIRLOBBY_ROOM_MAX_*` settings and `PAIRLOBBY_LIMIT_*` settings use the same parser and defaults as `pairlobby serve`; see the app's [team relay settings](https://github.com/PairLobby/app/blob/master/GUIDE.md#a-relay-for-a-team). `PAIRLOBBY_TRUSTED_PROXY_HEADER` names an address header your ingress overwrites. Without it, address limits use one shared unknown-address bucket. Configure an appropriate trusted header at the ingress; merely sending a header from a client grants nothing.

Admission buckets are durable, one object per hashed rate key under the existing `INVITES` binding. The global redemption bucket is shared across front-door replicas. Buckets are reclaimed after refill; invite ownership tombstones remain. No new namespace or Durable Object migration is required.

`DurableRoomSockets` owns single-use hashed tickets and hibernating sockets. Clients negotiate revision hints, and several connections for one membership coexist up to the connection limit. Older clients receive only the original event frames. Room protocol authorization is supplied by `RoomService` again at upgrade, delivery and reconciliation.

The new SQL schema is version 2. Snapshot or back up existing data before upgrading; reverting code against upgraded storage is unsupported. Restore the pre-upgrade snapshot for rollback. Existing room object names and invite mappings are preserved. Cloudflare's local runtime is covered by the tests; the new socket and stream paths still need a Celld runtime acceptance run before claiming parity there.

`npm test` type-checks the tests and runs storage contracts plus native relay/socket tests. For coordinated unpublished app/runtime/hosted changes, use `app/scripts/check-candidates.mjs <this checkout> <worker checkout> --write-locks`. Candidate lockfiles pin built artifacts intended for the next release; a normal `npm ci` requires the app packages to be published first. The checker publishes and deploys nothing.
