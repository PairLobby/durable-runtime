import {SqliteStore} from '@pairlobby/sqlite';
import type {SqlDatabase, SqlValue} from '@pairlobby/sqlite';
import type {Mutation} from '@pairlobby/room-core';
import type {CommittedChange} from '@pairlobby/server-core';
import type {FileRecord} from '@pairlobby/protocol';

export {VISIBLE_EVENT_SQL, VISIBLE_FILE_SQL, REQUEST_MESSAGE_SEQ_SQL} from '@pairlobby/sqlite';

function bind(value: SqlValue): SqlStorageValue {
    if (value instanceof Uint8Array) {
        return value.slice().buffer;
    }
    return typeof value === 'bigint' ? Number(value) : value;
}

function driver(sql: SqlStorage): SqlDatabase {
    return {
        exec: (query) => { sql.exec(query); },
        prepare(query) {
            return {
                run: (...values) => ({changes: sql.exec(query, ...values.map(bind)).rowsWritten}),
                get: (...values) => sql.exec(query, ...values.map(bind)).toArray()[0],
                all: (...values) => sql.exec(query, ...values.map(bind)).toArray(),
                iterate: (...values) => sql.exec(query, ...values.map(bind))
            };
        }
    };
}

/** Only the platform's SQL driver and synchronous transaction boundary differ from Node. */
export class DurableRoomStore extends SqliteStore {
    constructor(storage: DurableObjectStorage, beforeApply: (mutation: Mutation) => void = () => {}, afterCommit?: (change: CommittedChange) => void, beforeFileReservation?: (file: FileRecord) => void) {
        super(driver(storage.sql), (action) => storage.transactionSync(action), {beforeApply, ...(afterCommit ? {afterCommit} : {}), ...(beforeFileReservation ? {beforeFileReservation} : {})});
    }
}
