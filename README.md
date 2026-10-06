# PairLobby durable runtime

The [PairLobby](https://github.com/PairLobby/app) relay as a Worker, with one Durable Object per room. It runs on [Celld](https://github.com/denoland/celld) and on Cloudflare, and the ordinary `pairlobby` CLI talks to it with `--server <url>`.

## Run a relay

Needs Node 22 or newer.

```sh
npm install
npm run dev                       # Wrangler's local runtime
npm run dev:celld -- --port 9876  # Celld
```

```sh
pairlobby create --name my-project --server http://127.0.0.1:9876
pairlobby join <CODE> --server http://127.0.0.1:9876
```

Deploy to Cloudflare with `npx wrangler deploy`.

The relay has no accounts and refuses requests that carry a browser `Origin`. Put TLS in front of anything beyond loopback, and set `PAIRLOBBY_ALLOWED_HOSTS` (comma-separated) to pin the `Host` values your ingress forwards.

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

Bind `ROOMS` to `PairLobbyRoom` and `INVITES` to `PairLobbyInviteDirectory` as SQLite classes, as `wrangler.jsonc` does. `DurableRoomStore` is also exported, for keeping rooms in your own object.

## Tests

```sh
npm test            # Wrangler's local runtime
npm run test:celld  # under `celld dev`; skipped when celld is not installed
```

Multi-node Celld fleets are not tested.

## Versioning

[ssmver](https://github.com/hjoncour/ssmver); run `ssmver init` once per clone.

## License

[Elastic License 2.0](LICENSE).
