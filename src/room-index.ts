//! The rooms a relay lists for joining by name: open public and protected rooms. Each room
//! lives in its own object, so no query can see them all; instead each room tells this one
//! object whenever what it lists changes (its type, name, participant count, or closing),
//! and a lookup reads a single table here.

import {DurableObject} from 'cloudflare:workers';
import type {LocalRoom} from '@pairlobby/protocol';

import type {RelayEnv} from './relay.js';

/** What a room lists about itself. Past `expiresAt` it is left out without the room having to say so. */
export type ListedRoom = LocalRoom & {expiresAt: number | null};

/** The one index object a relay keeps. */
export const ROOM_INDEX_NAME = 'rooms';

/** Rooms a lookup without a name returns, newest first, as on the Node relay. */
const NEWEST_ROOMS = 50;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listed (
    room_id    TEXT PRIMARY KEY,
    name_key   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    body       TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS listed_by_name ON listed (name_key);
CREATE INDEX IF NOT EXISTS listed_by_created ON listed (created_at);
`;

export class PairLobbyRoomIndex extends DurableObject<RelayEnv> {
    constructor(ctx: DurableObjectState, env: RelayEnv) {
        super(ctx, env);
        ctx.storage.sql.exec(SCHEMA);
    }

    async put(room: ListedRoom): Promise<void> {
        const {expiresAt, ...listed} = room;
        this.ctx.storage.sql.exec('INSERT INTO listed (room_id, name_key, created_at, expires_at, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT (room_id) DO UPDATE SET name_key = excluded.name_key, created_at = excluded.created_at, expires_at = excluded.expires_at, body = excluded.body', room.roomId, room.name.toLowerCase(), room.createdAt, expiresAt, JSON.stringify(listed));
    }

    async remove(roomId: string): Promise<void> {
        this.ctx.storage.sql.exec('DELETE FROM listed WHERE room_id = ?', roomId);
    }

    /** The unexpired rooms named `name`, ignoring case, or without a name the newest ones. */
    async rooms(name?: string): Promise<LocalRoom[]> {
        const now = Date.now();
        const unexpired = 'SELECT body FROM listed WHERE (expires_at IS NULL OR expires_at > ?)';
        const cursor = name === undefined
            ? this.ctx.storage.sql.exec<{body: string}>(`${unexpired} ORDER BY created_at DESC LIMIT ?`, now, NEWEST_ROOMS)
            : this.ctx.storage.sql.exec<{body: string}>(`${unexpired} AND name_key = ?`, now, name.toLowerCase());
        return cursor.toArray().map((row) => JSON.parse(row.body) as LocalRoom);
    }
}
