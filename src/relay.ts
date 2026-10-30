//! The standalone, accountless PairLobby relay Worker: the same HTTP protocol as
//! `pairlobby serve`, with each room in its own Durable Object. It runs unchanged
//! on Celld and on Cloudflare; the ordinary CLI talks to it with `--server <url>`.
//!
//! Every protocol rule comes from the shared kernel (`createRelay` in server-core):
//! this Worker runs its `edge` half, which admits a request and names its room, and
//! each room's object runs `inRoom`. What is left here is routing to the objects.

import {RoomId} from '@pairlobby/protocol';
import {CREATE_TOKEN_HEADER, RoomService, createAdmission, createRelay} from '@pairlobby/server-core';
import type {Relay, RoomStore} from '@pairlobby/server-core';

import type {PairLobbyInviteDirectory} from './invite-directory.js';
import type {PairLobbyRoom} from './room-object.js';

export {CREATE_TOKEN_HEADER};

export type RelayEnv = {
    ROOMS: DurableObjectNamespace<PairLobbyRoom>;
    INVITES: DurableObjectNamespace<PairLobbyInviteDirectory>;
    /** Comma-separated Host values to accept; unset accepts any host behind the operator's ingress. */
    PAIRLOBBY_ALLOWED_HOSTS?: string;
    /** When set, creating a room needs this token; joining with an invite code never does. */
    PAIRLOBBY_CREATE_TOKEN?: string;
};

/** Internal claim from the relay to a room object: which room the request is for. Any caller-supplied copy is overwritten. */
export const ROOM_ID_HEADER = 'x-pairlobby-room-id';

const JSON_HEADERS = {'content-type': 'application/json; charset=utf-8'};

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: JSON_HEADERS});
}

/**
 * The Worker keeps no rooms; they live in their objects. Its service only describes the relay,
 * and rooms here keep files, so the description lists them. Any room operation is refused.
 */
function edgeStore(): RoomStore {
    const known: Record<string | symbol, unknown> = {files: {}};
    return new Proxy(known, {
        get: (target, property) => (property in target ? target[property] : () => Promise.reject(new Error(`the relay Worker keeps no rooms (${String(property)})`)))
    }) as unknown as RoomStore;
}

const relays = new WeakMap<RelayEnv, Relay>();

/** One kernel per environment: the settings do not change while the Worker runs. */
function edgeRelay(env: RelayEnv): Relay {
    const cached = relays.get(env);
    if (cached) {
        return cached;
    }
    const hosts = env.PAIRLOBBY_ALLOWED_HOSTS?.split(',').map((host) => host.trim()).filter(Boolean);
    const relay = createRelay({
        service: new RoomService(edgeStore()),
        // A browser page must not drive a relay with a person's credentials: any Origin is refused.
        allowedOrigins: [],
        ...(hosts?.length ? {allowedHosts: hosts} : {}),
        // Every read is a poll: no object holds a request open, which would bill it while it waits.
        transport: 'poll',
        admission: createAdmission(env.PAIRLOBBY_CREATE_TOKEN ? {createToken: env.PAIRLOBBY_CREATE_TOKEN} : {}),
        // A code names its room only through the directory; the room then checks the code itself.
        inviteRoom: (digest) => env.INVITES.getByName(digest).lookup()
    });
    relays.set(env, relay);
    return relay;
}

function forward(request: Request, env: RelayEnv, roomId: string): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set(ROOM_ID_HEADER, roomId);
    headers.delete(CREATE_TOKEN_HEADER);
    return env.ROOMS.getByName(roomId).fetch(new Request(request.url, {method: request.method, headers, ...(request.body ? {body: request.body} : {})}));
}

export async function handleRelay(request: Request, env: RelayEnv): Promise<Response> {
    // Answered before anything else, as on every relay: a load balancer probes by address.
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
        return json({service: 'pairlobby-relay', ready: true});
    }
    const routed = await edgeRelay(env).edge(request);
    if (routed instanceof Response) {
        return routed;
    }
    // Each id names an object; refuse a malformed one before it creates storage.
    if (!RoomId.safeParse(routed.roomId).success) {
        return json({error: {code: 'invalid_request', message: 'unknown path'}}, 404);
    }
    return forward(routed.request, env, routed.roomId);
}
