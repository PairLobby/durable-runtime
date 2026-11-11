import {ClientStateFrame, ProtocolError, hashCredential, newCredential, newId} from '@pairlobby/protocol';
import type {RoomEvent, RoomSnapshot} from '@pairlobby/protocol';
import {assertConnectedParticipant} from '@pairlobby/server-core';
import type {ConnectionAuthorization, RoomConnections, RoomService} from '@pairlobby/server-core';

type SocketIdentity = {roomId: string; participantId: string; connectionId: string; sync: boolean};
type TicketRow = {participant_id: string; connection_id: string; sync: number};
type TicketRequest = {sync?: boolean; connectionId?: string};
export type DurableSocketsOptions = {authorize?: (roomId: string, participantId: string) => Promise<void>};

const CONNECTIONS_PER_PARTICIPANT = 4;

/** Hibernating transport shared by the standalone room and hosted workspace. Room authorization stays in server-core. */
export class DurableRoomSockets implements RoomConnections {
    constructor(private readonly ctx: DurableObjectState, private readonly service: RoomService, private readonly options: DurableSocketsOptions = {}) {
        ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_tickets(digest TEXT PRIMARY KEY,room_id TEXT NOT NULL,participant_id TEXT NOT NULL,connection_id TEXT NOT NULL,sync INTEGER NOT NULL,expires INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS relay_tickets_expiry ON relay_tickets(expires);`);
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }

    async ticket(roomId: string, participantId: string, expiresAt: number, request: Request): Promise<string> {
        await this.options.authorize?.(roomId, participantId);
        const text = await request.text();
        const input = (text ? JSON.parse(text) : {}) as TicketRequest;
        if (!input || typeof input !== 'object' || (input.sync !== undefined && typeof input.sync !== 'boolean') || (input.connectionId !== undefined && (typeof input.connectionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.connectionId)))) {
            throw new ProtocolError('invalid_request', 'invalid connection options');
        }
        const ticket = newCredential('connect');
        const digest = await hashCredential(ticket);
        this.ctx.storage.sql.exec('DELETE FROM relay_tickets WHERE expires<=?', Date.now());
        const count = this.ctx.storage.sql.exec<{n: number}>('SELECT count(*) AS n FROM relay_tickets WHERE room_id=? AND participant_id=?', roomId, participantId).one().n;
        if (count >= CONNECTIONS_PER_PARTICIPANT) {
            throw new ProtocolError('rate_limited', 'too many pending connections; retry shortly', {retryAfterMs: 30_000});
        }
        this.ctx.storage.sql.exec('INSERT INTO relay_tickets VALUES(?,?,?,?,?,?)', digest, roomId, participantId, input.connectionId ?? newId('session'), input.sync ? 1 : 0, expiresAt);
        return ticket;
    }

    async connect(roomId: string, request: Request, authorize: ConnectionAuthorization): Promise<Response> {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
            throw new ProtocolError('invalid_request', 'WebSocket upgrade required');
        }
        const digest = await hashCredential(new URL(request.url).searchParams.get('ticket') ?? '');
        const row = this.ctx.storage.sql.exec<TicketRow>('SELECT participant_id,connection_id,sync FROM relay_tickets WHERE digest=? AND room_id=? AND expires>?', digest, roomId, Date.now()).toArray()[0];
        if (!row) {
            throw new ProtocolError('unauthorized', 'connection ticket is invalid or expired');
        }
        this.ctx.storage.sql.exec('DELETE FROM relay_tickets WHERE digest=?', digest);
        const snapshot = await authorize(row.participant_id);
        await this.options.authorize?.(roomId, row.participant_id);
        if (snapshot.lifecycle !== 'open') {
            throw new ProtocolError('room_closed', 'this room is closed to live connections; its retained history is available over HTTP');
        }
        const existing = this.ctx.getWebSockets(roomId).filter((socket) => socket.readyState === WebSocket.OPEN && this.identity(socket)?.participantId === row.participant_id);
        for (const socket of existing) {
            if (this.identity(socket)?.connectionId === row.connection_id) {
                socket.close(1000, 'Connection replaced');
            }
        }
        if (existing.filter((socket) => socket.readyState === WebSocket.OPEN).length >= CONNECTIONS_PER_PARTICIPANT) {
            throw new ProtocolError('rate_limited', 'this participant already has four live connections', {retryAfterMs: 1000});
        }
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [roomId]);
        pair[1].serializeAttachment({roomId, participantId: row.participant_id, connectionId: row.connection_id, sync: row.sync === 1} satisfies SocketIdentity);
        pair[1].send(JSON.stringify({type: 'hello', snapshot, watermarkSeq: snapshot.latestSeq}));
        return new Response(null, {status: 101, webSocket: pair[0]});
    }

    async broadcast(roomId: string, event?: RoomEvent): Promise<void> {
        const sockets = this.ctx.getWebSockets(roomId);
        if (!sockets.length) {
            return;
        }
        let snapshot: RoomSnapshot;
        try {
            snapshot = await this.service.connectionAudience(roomId);
        } catch {
            for (const socket of sockets) {
                socket.close(1008, 'Room access ended');
            }
            return;
        }
        for (const socket of sockets) {
            const identity = this.identity(socket);
            try {
                if (!identity) {
                    throw new Error('missing socket identity');
                }
                assertConnectedParticipant(snapshot, identity.participantId);
                await this.options.authorize?.(roomId, identity.participantId);
                if (event) {
                    socket.send(JSON.stringify({type: 'event', event}));
                }
                if (identity.sync) {
                    this.state(socket, snapshot);
                }
                if (snapshot.lifecycle !== 'open') {
                    socket.close(1008, 'Room closed');
                }
            } catch {
                socket.close(1008, 'Room access ended');
            }
        }
    }

    async message(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
        const identity = this.identity(socket);
        try {
            if (!identity?.sync || typeof message !== 'string' || message.length > 256) {
                throw new Error('unsupported socket message');
            }
            ClientStateFrame.parse(JSON.parse(message));
            const snapshot = await this.service.connectedSnapshot(identity.roomId, identity.participantId);
            await this.options.authorize?.(identity.roomId, identity.participantId);
            this.state(socket, snapshot);
            if (snapshot.lifecycle !== 'open') {
                socket.close(1008, 'Room closed');
            }
        } catch {
            socket.close(1008, 'Reconnect through the authenticated HTTP API');
        }
    }

    private identity(socket: WebSocket): SocketIdentity | null {
        const value = socket.deserializeAttachment() as Partial<SocketIdentity> | null;
        return value?.roomId && value.participantId ? value as SocketIdentity : null;
    }

    private state(socket: WebSocket, snapshot: RoomSnapshot): void {
        socket.send(JSON.stringify({type: 'state', roomId: snapshot.roomId, stateRevision: snapshot.stateRevision ?? 0, latestSeq: snapshot.latestSeq, earliestSeq: snapshot.earliestSeq}));
    }
}
