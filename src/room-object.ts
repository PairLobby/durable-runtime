//! One PairLobby room per Durable Object (a "cell" on Celld). The object owns the
//! room's SQLite state and its alarm; the shared kernel's `inRoom` supplies every
//! protocol behavior, so this file only adapts storage, ordering and time.

import {DurableObject} from 'cloudflare:workers';
import {DEFAULT_ROOM_POLICY, hashCredential, normalizeInviteCode} from '@pairlobby/protocol';
import {RoomService, createRelay, relayPolicySettings} from '@pairlobby/server-core';
import type {CommittedChange, Relay} from '@pairlobby/server-core';

import type {RelayEnv} from './relay.js';
import {ROOM_ID_HEADER, json} from './relay.js';
import type {ListedRoom} from './room-index.js';
import {ROOM_INDEX_NAME} from './room-index.js';
import {DurableRoomStore} from './store.js';
import {DurableRoomSockets} from './sockets.js';

export class PairLobbyRoom extends DurableObject<RelayEnv> {
    private readonly store: DurableRoomStore;
    private readonly service: RoomService;
    private readonly relay: Relay;
    private readonly sockets: DurableRoomSockets;
    private readonly changes: CommittedChange[] = [];
    private queue: Promise<unknown> = Promise.resolve();
    /** What the index last accepted from this room; undefined until read from storage. */
    private listed: ListedRoom | null | undefined;

    constructor(ctx: DurableObjectState, env: RelayEnv) {
        super(ctx, env);
        this.store = new DurableRoomStore(ctx.storage, undefined, (change) => this.changes.push(change));
        const settings = relayPolicySettings(env);
        this.service = new RoomService(this.store, () => Date.now(), {
            // Codes are global across rooms, so each one is claimed in the directory first.
            reserve: async (code, roomId, expiresAt) => env.INVITES.getByName(await hashCredential(normalizeInviteCode(code)!)).reserve(roomId, expiresAt)
        }, {...DEFAULT_ROOM_POLICY, ...settings.roomLimits}, {receiptMode: settings.receiptMode ?? 'both'});
        // The relay Worker ran the kernel's edge: origins, hosts, the create token and the room's id.
        this.sockets = new DurableRoomSockets(ctx, this.service);
        this.relay = createRelay({service: this.service, connections: this.sockets, executor: {run: (_roomId, _write, action) => this.serial(action), idle: () => this.queue.then(() => {})}});
    }

    /** Requests interleave at every await; one at a time keeps room transitions ordered. */
    private serial<T>(action: () => Promise<T>): Promise<T> {
        const result = this.queue.then(action);
        this.queue = result.catch(() => {});
        return result;
    }

    override fetch(request: Request): Promise<Response> {
        const handle = async () => {
            const roomId = request.headers.get(ROOM_ID_HEADER);
            if (!roomId) {
                return json({error: {code: 'invalid_request', message: 'room requests must come through the relay'}}, 400);
            }
            const response = await this.relay.inRoom(request, roomId);
            await this.serial(async () => {
                await this.flushChanges();
                await this.scheduleAutoClose();
                await this.updateIndex(roomId);
            });
            return response;
        };
        return handle();
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
        await this.relay.tick('auto-close');
        await this.serial(async () => {
            await this.flushChanges();
            await this.scheduleAutoClose();
            // Closing can only take a room off the index, so a room that was never listed has nothing to send.
            const listed = await this.lastListed();
            if (listed) {
                await this.updateIndex(listed.roomId);
            }
        });
    }

    override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
        return this.serial(async () => {
            await this.sockets.message(socket, message);
            await this.flushChanges();
            await this.scheduleAutoClose();
        });
    }

    override webSocketClose(socket: WebSocket): void {
        socket.close();
    }

    private async flushChanges(): Promise<void> {
        while (this.changes.length) {
            const batch = this.changes.splice(0);
            for (const change of batch) {
                await this.sockets.broadcast(change.roomId, change.event);
            }
        }
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
