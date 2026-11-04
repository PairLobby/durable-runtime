import {afterAll, beforeAll, expect, test} from 'vitest';
import {createTestHarness} from 'wrangler';
import {PairLobbyClient} from '@pairlobby/client';

const harness = createTestHarness({workers: [{configPath: 'tests/gate.wrangler.jsonc'}]});
let base: string;

beforeAll(async () => {
    base = (await harness.listen()).url.toString();
}, 60_000);

afterAll(async () => {
    await harness.close();
});

const human = {displayName: 'Ada', kind: 'human' as const};
const agent = {displayName: 'codex', kind: 'agent' as const};

test('test_behind_an_access_gate_public_and_protected_rooms_are_found_and_joined_by_name_across_room_objects', async () => {
    const owner = new PairLobbyClient(base);
    const described = (await (await fetch(new URL('/v1/server', base))).json()) as {features: string[]};
    expect(described.features).toContain('local-join');

    const square = await owner.createRoom('Town Square', human, undefined, undefined, 'public');
    const hours = await owner.createRoom('office hours', human, undefined, undefined, 'protected');
    await owner.createRoom('secret', human, undefined, undefined, 'private');
    const listed = await owner.localRooms();
    expect(listed?.map((room) => [room.name, room.type, room.participantCount]).sort()).toEqual([['Town Square', 'public', 1], ['office hours', 'protected', 1]]);
    expect((await owner.localRooms('town square'))?.map((room) => room.roomId)).toEqual([square.roomId]);
    expect(await owner.localRooms('secret')).toEqual([]);

    const member = await new PairLobbyClient(base).joinOnLocalNetwork(square.roomId, agent);
    expect(member.role).toBe('member');
    expect((await owner.localRooms('town square'))?.[0]?.participantCount).toBe(2);
    expect((await new PairLobbyClient(base).joinOnLocalNetwork(hours.roomId, agent)).role).toBe('guest');

    await owner.setRoomType(square.roomId, square.controllerCredential, 'private');
    await owner.close(hours.roomId, hours.controllerCredential);
    expect(await owner.localRooms()).toEqual([]);
    await expect(new PairLobbyClient(base).joinOnLocalNetwork(square.roomId, agent)).rejects.toThrow();
});
