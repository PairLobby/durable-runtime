//! One PairLobby room per Durable Object (a "cell" on Celld). The object owns the
//! room's SQLite state and its alarm; the shared kernel's `inRoom` supplies every
//! protocol behavior, so this file only adapts storage, ordering and time.

import {DurableObject} from 'cloudflare:workers';
import {hashCredential, normalizeInviteCode} from '@pairlobby/protocol';
import {RoomService, createRelay} from '@pairlobby/server-core';
import type {Relay} from '@pairlobby/server-core';

import {DurableRoomStore} from './store.js';
import type {RelayEnv} from './relay.js';
import {ROOM_ID_HEADER, json} from './relay.js';

export class PairLobbyRoom extends DurableObject<RelayEnv> {
    private readonly store: DurableRoomStore;
    private readonly service: RoomService;
    private readonly relay: Relay;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(ctx: DurableObjectState, env: RelayEnv) {
        super(ctx, env);
        this.store = new DurableRoomStore(ctx.storage);
        this.service = new RoomService(this.store, () => Date.now(), {
            // Codes are global across rooms, so each one is claimed in the directory first.
            reserve: async (code, roomId, expiresAt) => env.INVITES.getByName(await hashCredential(normalizeInviteCode(code)!)).reserve(roomId, expiresAt)
        });
        // The relay Worker ran the kernel's edge: origins, hosts, the create token and the room's id.
        this.relay = createRelay({service: this.service});
    }

    /** Requests interleave at every await; one at a time keeps room transitions ordered. */
    private serial<T>(action: () => Promise<T>): Promise<T> {
        const result = this.queue.then(action);
        this.queue = result.catch(() => {});
        return result;
    }

    override fetch(request: Request): Promise<Response> {
        return this.serial(async () => {
            const roomId = request.headers.get(ROOM_ID_HEADER);
            if (!roomId) {
                return json({error: {code: 'invalid_request', message: 'room requests must come through the relay'}}, 400);
            }
            const response = await this.relay.inRoom(request, roomId);
            await this.scheduleAutoClose();
            return response;
        });
    }

    /** One alarm per room, aimed at its auto-close deadline. */
    private async scheduleAutoClose(): Promise<void> {
        const next = await this.store.nextAutoCloseAt();
        const current = await this.ctx.storage.getAlarm();
        if (next === null) {
            if (current !== null) {
                await this.ctx.storage.deleteAlarm();
            }
            return;
        }
        if (current === null || current !== next) {
            await this.ctx.storage.setAlarm(Math.max(Date.now(), next));
        }
    }

    override async alarm(): Promise<void> {
        await this.serial(async () => {
            await this.relay.tick('auto-close');
            await this.scheduleAutoClose();
        });
    }
}
