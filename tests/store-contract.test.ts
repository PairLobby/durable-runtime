import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, expect, test} from 'vitest';
import {createTestHarness} from 'wrangler';
import {runFileContract, runRoomContract, runRedemptionContract} from '@pairlobby/fixtures';
import type {TestableRoomStore} from '@pairlobby/fixtures';
import type {FileCallResult, StoreFixture} from './store-worker.js';
import type {DurableRoomStore} from '../src/store.js';
import {ProtocolError, newCredential, newId} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import type {ErrorCode} from '@pairlobby/protocol';

const harness = createTestHarness({workers: [{configPath: 'tests/wrangler.jsonc'}]});
let namespace: DurableObjectNamespace<StoreFixture>;
beforeAll(async () => {
    await harness.listen();
    namespace = (await harness.getWorker<{STORES: DurableObjectNamespace<StoreFixture>}>().getEnv()).STORES;
}, 60_000);
afterAll(async () => {
    await harness.close();
});
function factory(): TestableRoomStore {
    const stub = namespace.getByName(randomUUID());
    let pending: Promise<unknown> = Promise.resolve();
    // The fixture contract exposes synchronous retention injection. Queue that
    // injection and await it before the next RPC so the simulation is ordered.
    return new Proxy({} as TestableRoomStore, {
        get(_target, method: keyof TestableRoomStore) {
            if (method === 'close') {
                return () => {};
            }
            if (method === 'files') {
                return new Proxy({}, {
                    get(_files, operation: string) {
                        return async (...args: unknown[]) => {
                            await pending;
                            const result = (await stub.callFiles(operation as never, args)) as FileCallResult;
                            if (result.ok) {
                                return result.value;
                            }
                            throw new ProtocolError(result.error.code as ErrorCode, result.error.message);
                        };
                    }
                });
            }
            if (method === 'dropHistoryBefore') {
                return (...args: unknown[]) => {
                    pending = stub.call(method, args);
                };
            }
            return async (...args: unknown[]) => {
                await pending;
                const result = await stub.call(method as Exclude<keyof DurableRoomStore, 'files'>, args);
                if (!result.ok) {
                    throw new ProtocolError(result.error.code as ErrorCode, result.error.message);
                }
                return JSON.parse(result.value) as unknown;
            };
        }
    });
}
runRoomContract('room contract / Durable Object SQLite', factory);
runRedemptionContract('invite recovery / Durable Object SQLite', factory);
runFileContract('file store / Durable Object SQLite', factory);

test('SQLite storage size falls after retained data is removed', async () => {
    const sizes = await namespace.getByName(randomUUID()).storageProbe();
    expect(sizes.filled).toBeGreaterThan(sizes.before);
    expect(sizes.after).toBeLessThan(sizes.filled);
}, 10_000);

test('hidden history stays stored but is gone from reads, exports and files', async () => {
    const store = factory() as TestableRoomStore & Pick<DurableRoomStore, 'hideHistoryBefore'>;
    const service = new RoomService(store, () => 1_800_000_000_000);
    const alice = newCredential('participant');
    const room = await service.createRoom({name: 'hidden', displayName: 'alice', kind: 'human', participantCredential: alice, controllerCredential: newCredential('controller')});
    const file = await service.uploadFile(room.roomId, alice, {name: 'old.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('old')});
    const send = (text: string, attachments = [] as typeof file[]) => service.send(room.roomId, alice, {type: 'message', payload: {text, priority: 'normal', attachments}, idempotencyKey: newId('event')});
    const old = await send('old', [file]);
    const kept = await send('kept');

    await store.hideHistoryBefore(room.roomId, kept.event.seq);
    await store.hideHistoryBefore(room.roomId, 1);
    const read = await service.read(room.roomId, alice, 0, 100);
    expect(read.earliestSeq).toBe(kept.event.seq);
    expect(read.events.map((event) => event.seq)).toEqual([kept.event.seq]);
    expect(await store.eventById(room.roomId, old.event.eventId)).toBeNull();
    expect((await service.listFiles(room.roomId, alice)).files).toEqual([]);
    expect(await store.files!.usedBytes(room.roomId)).toBe(0);
    await expect(service.downloadFile(room.roomId, alice, file.fileId)).rejects.toThrow('no such file');
    const exported = await service.export(room.roomId, alice);
    expect(exported.complete).toBe(false);
    expect(exported.events.map((event) => event.eventId)).toEqual([kept.event.eventId]);
    await expect(service.read(room.roomId, alice, 1, 100)).rejects.toThrow('no longer retained');
}, 20_000);
