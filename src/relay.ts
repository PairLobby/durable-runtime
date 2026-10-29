//! The standalone, accountless PairLobby relay Worker: the same HTTP protocol as
//! `pairlobby serve`, with each room in its own Durable Object. It runs unchanged
//! on Celld and on Cloudflare; the ordinary CLI talks to it with `--server <url>`.

import {ABSOLUTE_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_RETAINED_FILE_BYTES, DEFAULT_ROOM_POLICY, PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, RedeemInviteRequest, RoomId, hashCredential, newId, normalizeInviteCode} from '@pairlobby/protocol';

import type {PairLobbyInviteDirectory} from './invite-directory.js';
import type {PairLobbyRoom} from './room-object.js';

export type RelayEnv = {
    ROOMS: DurableObjectNamespace<PairLobbyRoom>;
    INVITES: DurableObjectNamespace<PairLobbyInviteDirectory>;
    /** Comma-separated Host values to accept; unset accepts any host behind the operator's ingress. */
    PAIRLOBBY_ALLOWED_HOSTS?: string;
    /** When set, creating a room needs this token; joining with an invite code never does. */
    PAIRLOBBY_CREATE_TOKEN?: string;
};

/** The header the CLI sends with a room creation, from `PAIRLOBBY_CREATE_TOKEN` on its side. */
export const CREATE_TOKEN_HEADER = 'x-pairlobby-account-token';

/** Internal claim from the relay to a room object; any caller-supplied copy is overwritten. */
export const ROOM_ID_HEADER = 'x-pairlobby-room-id';

const JSON_HEADERS = {'content-type': 'application/json; charset=utf-8'};

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: JSON_HEADERS});
}

function error(code: string, message: string, status: number): Response {
    return json({error: {code, message}}, status);
}

/**
 * A request for another protocol version is refused first, as on every relay. A
 * browser page must not drive a relay with a person's credentials, so any
 * request carrying an Origin is refused, as on the local relay. An operator can
 * also pin the Host values its ingress forwards.
 */
function admitted(request: Request, env: RelayEnv): Response | null {
    const declared = request.headers.get(PROTOCOL_VERSION_HEADER);
    if (declared !== null && declared !== String(PROTOCOL_VERSION)) {
        return error('protocol_version_unsupported', `this server speaks protocol version ${PROTOCOL_VERSION}`, 400);
    }
    if (request.headers.get('origin') !== null) {
        return error('unauthorized', 'this origin may not call this server', 401);
    }
    const hosts = env.PAIRLOBBY_ALLOWED_HOSTS?.split(',').map((host) => host.trim()).filter(Boolean);
    const host = request.headers.get('host');
    if (hosts?.length && host !== null && !hosts.includes(host)) {
        return error('unauthorized', 'unexpected host header', 401);
    }
    return null;
}

/**
 * `GET /v1/server`, in the shape app's `describeRelay` gives every relay. Rooms here keep files under the
 * default policy, and every read is a poll: no object holds a request open, which would bill it while it waits.
 */
function describeRelay(env: RelayEnv): Record<string, unknown> {
    const policy = DEFAULT_ROOM_POLICY;
    return {
        protocol: PROTOCOL_VERSION,
        features: ['message-stages', 'files', ...(env.PAIRLOBBY_CREATE_TOKEN ? ['create-token'] : [])],
        transport: {live: 'poll'},
        limits: {
            maxParticipants: policy.maxParticipants,
            maxEventPayloadBytes: policy.maxEventPayloadBytes,
            maxRetainedEvents: policy.maxRetainedEvents,
            maxRetainedEventBytes: policy.maxRetainedEventBytes,
            maxFileBytes: Math.min(policy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, ABSOLUTE_MAX_FILE_BYTES),
            maxRetainedFileBytes: policy.maxRetainedFileBytes ?? DEFAULT_MAX_RETAINED_FILE_BYTES
        }
    };
}

async function sha256(value: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Compares digests, so the time taken says nothing about how much of the token matched. */
async function mayCreate(request: Request, env: RelayEnv): Promise<boolean> {
    if (!env.PAIRLOBBY_CREATE_TOKEN) {
        return true;
    }
    const [expected, given] = await Promise.all([sha256(env.PAIRLOBBY_CREATE_TOKEN), sha256(request.headers.get(CREATE_TOKEN_HEADER) ?? '')]);
    return expected.every((byte, index) => byte === given[index]);
}

function forward(request: Request, env: RelayEnv, roomId: string, body?: string): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete(ROOM_ID_HEADER);
    headers.delete(CREATE_TOKEN_HEADER);
    if (body !== undefined && request.method === 'POST' && new URL(request.url).pathname === '/v1/rooms') {
        headers.set(ROOM_ID_HEADER, roomId);
    }
    const init: RequestInit = {method: request.method, headers, ...(body !== undefined ? {body} : request.body ? {body: request.body} : {})};
    return env.ROOMS.getByName(roomId).fetch(new Request(request.url, init));
}

export async function handleRelay(request: Request, env: RelayEnv): Promise<Response> {
    const refused = admitted(request, env);
    if (refused) {
        return refused;
    }
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/health' && request.method === 'GET') {
        return json({service: 'pairlobby-relay', ready: true});
    }
    if (url.pathname === '/v1/server' && request.method === 'GET') {
        return json(describeRelay(env));
    }
    if (segments[0] !== 'v1') {
        return error('invalid_request', 'unknown path', 404);
    }
    // A new room gets its id here, because the id names the object that will hold it.
    if (url.pathname === '/v1/rooms' && request.method === 'POST') {
        if (!(await mayCreate(request, env))) {
            return error('unauthorized', 'this relay needs its create token to start a room; set PAIRLOBBY_CREATE_TOKEN', 401);
        }
        return forward(request, env, newId('room'), await request.text());
    }
    // A code names its room only through the directory; the room then validates it.
    if (url.pathname === '/v1/invites/redeem' && request.method === 'POST') {
        const body = await request.text();
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch {
            return error('invalid_request', 'the request body did not match the protocol schema', 400);
        }
        const input = RedeemInviteRequest.safeParse(parsed);
        const normalized = input.success ? normalizeInviteCode(input.data.code) : null;
        if (!normalized) {
            return error('invite_unknown', 'that invite code is not well formed', 404);
        }
        const roomId = await env.INVITES.getByName(await hashCredential(normalized)).lookup();
        if (!roomId) {
            return error('invite_unknown', 'that invite code is not valid', 404);
        }
        return forward(request, env, roomId, body);
    }
    // Every other room route names its room; refuse malformed ids before touching storage.
    if (segments[1] === 'rooms' && segments[2] && RoomId.safeParse(segments[2]).success) {
        return forward(request, env, segments[2]);
    }
    return error('invalid_request', 'unknown path', 404);
}
