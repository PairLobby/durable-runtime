import {afterAll, beforeAll, expect, test} from 'vitest';
import {createTestHarness} from 'wrangler';
import {PairLobbyClient} from '@pairlobby/client';

const harness = createTestHarness({workers: [{configPath: 'tests/token.wrangler.jsonc'}]});
let base: string;

beforeAll(async () => {
    base = (await harness.listen()).url.toString();
}, 60_000);

afterAll(async () => {
    await harness.close();
});

const human = {displayName: 'Ada', kind: 'human' as const};
const agent = {displayName: 'codex', kind: 'agent' as const};

test('test_a_relay_with_a_create_token_starts_rooms_only_for_its_holder_and_anyone_with_a_code_joins', async () => {
    await expect(new PairLobbyClient(base).createRoom('nope', human)).rejects.toThrow('create token');
    await expect(new PairLobbyClient(base, 'wrong-token').createRoom('nope', human)).rejects.toThrow('create token');
    const room = await new PairLobbyClient(base, 'test-create-token').createRoom('mine', human);
    const joined = await new PairLobbyClient(base).redeemInvite(room.invite.code, agent);
    expect(joined.roomId).toBe(room.roomId);
});
