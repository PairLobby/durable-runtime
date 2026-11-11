//! Maps an invite code to its room when each room lives in its own Durable Object.
//! One directory object per code digest: claiming a code is atomic within that
//! object, so two rooms can never hold the same code, and no global coordinator
//! serializes unrelated invitations.

import {DurableObject} from 'cloudflare:workers';
import {takeTokens} from '@pairlobby/server-core';
import type {BucketState, RateDecision, RateLimit} from '@pairlobby/server-core';

type Entry = {roomId: string; expiresAt: number | null};
type StoredBucket = {state: BucketState; fullAt: number};

export class PairLobbyInviteDirectory extends DurableObject {
    /** Separate objects named admission:<digest> hold one rate key each; room traffic never passes through them. */
    async take(cost: number, limit: RateLimit): Promise<RateDecision> {
        return this.ctx.storage.transaction(async (transaction) => {
            const previous = await transaction.get<StoredBucket>('bucket');
            const {state, fullAt, decision} = takeTokens(previous?.state, cost, limit, Date.now());
            await transaction.put('bucket', {state, fullAt});
            await transaction.setAlarm(Math.max(Date.now() + 1000, fullAt));
            return decision;
        });
    }

    override async alarm(): Promise<void> {
        await this.ctx.storage.transaction(async (transaction) => {
            const bucket = await transaction.get<StoredBucket>('bucket');
            if (!bucket || bucket.fullAt <= Date.now()) {
                await transaction.delete('bucket');
            } else {
                await transaction.setAlarm(bucket.fullAt);
            }
        });
    }
    /** Claims this code for `roomId`. False when another room already holds it. */
    async reserve(roomId: string, expiresAt: number | null): Promise<boolean> {
        const existing = await this.ctx.storage.get<Entry>('entry');
        if (existing && existing.roomId !== roomId) {
            return false;
        }
        await this.ctx.storage.put('entry', {roomId, expiresAt});
        return true;
    }

    /**
     * The room holding this code. The entry outlives expiry as a tombstone so a
     * code is never handed to a second room; the room itself decides validity.
     */
    async lookup(): Promise<string | null> {
        return (await this.ctx.storage.get<Entry>('entry'))?.roomId ?? null;
    }
}
