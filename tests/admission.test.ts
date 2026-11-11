import {afterAll, beforeAll, expect, test} from 'vitest';
import {createTestHarness} from 'wrangler';
import {PairLobbyClient} from '@pairlobby/client';
import {hashCredential, newCredential} from '@pairlobby/protocol';

const harness = createTestHarness({workers: [{configPath: 'wrangler.jsonc', vars: {
    PAIRLOBBY_LIMIT_CREATE_PER_MIN_IP: '1',
    PAIRLOBBY_ROOM_MAX_PARTICIPANTS: '3',
    PAIRLOBBY_ROOM_MAX_FILE_MB: '1',
    PAIRLOBBY_RECEIPT_MODE: 'watermark'
}}]});
let base: string;
beforeAll(async () => { base = (await harness.listen()).url.toString(); }, 60_000);
afterAll(async () => { await harness.close(); });

test('shared policy settings reach each room and admission survives object eviction without trusting caller address headers', async () => {
    const client = new PairLobbyClient(base);
    const created = await client.createRoom('limited', {displayName: 'owner', kind: 'human'});
    expect(await client.describe()).toMatchObject({limits: {maxParticipants: 3, maxFileBytes: 1024 * 1024}, receiptMode: 'watermark'});
    expect(created.room).toMatchObject({receiptMode: 'watermark'});
    const worker = harness.getWorker();
    await worker.evictDurableObject('INVITES', {name: `admission:${await hashCredential('create:address:unknown')}`});
    const response = await worker.fetch('https://relay.test/v1/rooms', {method: 'POST', headers: {'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9'}, body: JSON.stringify({name: 'still limited', displayName: 'owner', kind: 'human', controllerCredential: newCredential('controller'), participantCredential: newCredential('participant')})});
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({error: {code: 'rate_limited', retryAfterMs: expect.any(Number)}});
});
