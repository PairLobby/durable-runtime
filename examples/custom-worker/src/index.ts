//! A relay with two rules of its own: a page at `/` that says what this is, and at
//! most ten new rooms a minute from one address. Everything else is the stock relay.

import {handleRelay, PairLobbyInviteDirectory, PairLobbyRoom} from '@pairlobby/durable-runtime';
import type {RelayEnv} from '@pairlobby/durable-runtime';

export {PairLobbyInviteDirectory, PairLobbyRoom};

type Env = RelayEnv & {CREATES: RateLimit};

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/' && request.method === 'GET') {
            return new Response(`A PairLobby relay. Join a room with:\n\npairlobby join <invite-code> --server ${url.origin}\n`, {headers: {'content-type': 'text/plain; charset=utf-8'}});
        }
        if (url.pathname === '/v1/rooms' && request.method === 'POST') {
            const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
            if (!(await env.CREATES.limit({key: address})).success) {
                return Response.json({error: {code: 'quota_exceeded', message: 'too many new rooms from this address; wait a minute'}}, {status: 429});
            }
        }
        return handleRelay(request, env);
    }
} satisfies ExportedHandler<Env>;
