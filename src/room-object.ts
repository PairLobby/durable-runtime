//! One PairLobby room per Durable Object (a "cell" on Celld). The object owns the
//! room's SQLite state and its alarm; the shared kernel's `inRoom` supplies every
//! protocol behavior, so this file only adapts storage, ordering and time.

import {DurableObject} from 'cloudflare:workers';
import {hashCredential, normalizeInviteCode} from '@pairlobby/protocol';
import {RoomService, createRelay} from '@pairlobby/server-core';
import type {Relay} from '@pairlobby/server-core';

import type {RelayEnv} from './relay.js';
import {ROOM_ID_HEADER, json} from './relay.js';
import type {ListedRoom} from './room-index.js';
import {ROOM_INDEX_NAME} from './room-index.js';
import {DurableRoomStore} from './store.js';

export class PairLobbyRoom extends DurableObject<RelayEnv> {
    private readonly store: DurableRoomStore;
    private readonly service: RoomService;
    private readonly relay: Relay;
    private queue: Promise<unknown> = Promise.resolve();
    /** What the index last accepted from this room; undefined until read from storage. */
    private listed: ListedRoom | null | undefined;

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
            await this.updateIndex(roomId);
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
            // Closing can only take a room off the index, so a room that was never listed has nothing to send.
            const listed = await this.lastListed();
            if (listed) {
                await this.updateIndex(listed.roomId);
            }
        });
    }

    private async lastListed(): Promise<ListedRoom | null> {
        if (this.listed === undefined) {
            this.listed = (await this.ctx.storage.get<ListedRoom>('listed')) ?? null;
        }
        return this.listed;
    }

    /**
     * Tells the index when what this room lists has changed. The room's own change is already
     * stored, so a failure here does not fail the request: the next request to the room tries again.
     */
    private async updateIndex(roomId: string): Promise<void> {
        if (!this.env.ROOM_INDEX) {
            return;
        }
        const next = this.store.listedRoom(roomId);
        const previous = await this.lastListed();
        if (JSON.stringify(next) === JSON.stringify(previous)) {
            return;
        }
        try {
            const index = this.env.ROOM_INDEX.getByName(ROOM_INDEX_NAME);
            await (next ? index.put(next) : index.remove(roomId));
        } catch (error) {
            console.error(`room ${roomId}: the room index was not updated`, error);
            return;
        }
        await (next ? this.ctx.storage.put('listed', next) : this.ctx.storage.delete('listed'));
        this.listed = next;
    }
}
