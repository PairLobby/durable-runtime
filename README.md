# PairLobby durable runtime

The [PairLobby](https://github.com/PairLobby/app) relay as a Worker, with one Durable Object per room. It runs on [Celld](https://github.com/denoland/celld) and on Cloudflare, and the ordinary `pairlobby` CLI talks to it with `--server <url>`.

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

Without `PAIRLOBBY_CREATE_TOKEN`, anyone who finds the address can start rooms and upload files on your account. On a custom domain, set `PAIRLOBBY_ALLOWED_HOSTS` (comma-separated) to the host names it answers on. The relay has no accounts and refuses requests that carry a browser `Origin`. Rooms, history and files are limited only by each room's policy and your Cloudflare plan. Files are stored in the room's object in 1 MiB pieces.

You may run it for yourself and your team; the license does not allow offering it to others as a hosted service.

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

Put TLS in front of anything beyond loopback.

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

Bind `ROOMS` to `PairLobbyRoom` and `INVITES` to `PairLobbyInviteDirectory` as SQLite classes, as `wrangler.jsonc` does. [`examples/custom-worker`](examples/custom-worker) adds rules of its own in front of the relay. `DurableRoomStore` is also exported, for keeping rooms in your own object; its `hideHistoryBefore` hides a room's oldest history without deleting it, as the hosted service does for a full free workspace.

## Tests

```sh
npm test            # Wrangler's local runtime
npm run test:celld  # under `celld dev`; skipped when celld is not installed
```

Multi-node Celld fleets are not tested.

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
