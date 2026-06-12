import assert from 'node:assert/strict';
import test from 'node:test';

import { runPendingJobSync } from '../pending-job-sync.js';

function createNoopDependencies(overrides = {}) {
    return {
        applyCompletedJob() {
            throw new Error('applyCompletedJob should not be called');
        },
        acknowledgeJob() {
            throw new Error('acknowledgeJob should not be called');
        },
        notifySuccess() {},
        notifyError() {},
        logDebug() {},
        warn() {},
        ...overrides,
    };
}

test('runPendingJobSync 处理已消失的旧任务前会先重新加载聊天，避免保存旧聊天', async () => {
    const events = [];
    const context = {
        chatId: 'chat-1',
        groupId: null,
        async reloadCurrentChat() {
            events.push('reload');
            currentState = {
                version: 'fresh',
                pendingJobs: [],
            };
        },
        async saveMetadata() {
            events.push(`save-${currentState.version}`);
        },
    };
    let currentState = {
        version: 'stale',
        pendingJobs: [{ id: 'job-old', createdAt: '2026-06-12T00:00:00.000Z', mainApi: 'openai' }],
    };

    const result = await runPendingJobSync(createNoopDependencies({
        getContext: () => context,
        getChatState: () => currentState,
        async fetchJob(jobId) {
            events.push(`fetch-${jobId}-${currentState.version}`);
            return null;
        },
    }));

    assert.equal(result.status, 'unchanged');
    assert.deepEqual(events, [
        'fetch-job-old-stale',
        'reload',
    ]);
});

test('runPendingJobSync 只会在重新加载后的新聊天上写入已完成任务', async () => {
    const events = [];
    const completedJob = {
        id: 'job-done',
        status: 'completed',
    };
    const context = {
        chatId: 'chat-1',
        groupId: null,
        async reloadCurrentChat() {
            events.push('reload');
            currentState = {
                version: 'fresh',
                pendingJobs: [{ id: 'job-done', createdAt: '2026-06-12T00:00:00.000Z', mainApi: 'openai' }],
            };
        },
        async saveMetadata() {
            events.push(`save-${currentState.version}`);
        },
    };
    let currentState = {
        version: 'stale',
        pendingJobs: [{ id: 'job-done', createdAt: '2026-06-12T00:00:00.000Z', mainApi: 'openai' }],
    };

    const result = await runPendingJobSync(createNoopDependencies({
        getContext: () => context,
        getChatState: () => currentState,
        async fetchJob(jobId) {
            events.push(`fetch-${jobId}-${currentState.version}`);
            return completedJob;
        },
        async applyCompletedJob(job) {
            events.push(`apply-${job.id}-${currentState.version}`);
        },
        async acknowledgeJob(jobId) {
            events.push(`ack-${jobId}`);
        },
        notifySuccess() {
            events.push('success');
        },
    }));

    assert.equal(result.status, 'synced');
    assert.deepEqual(currentState.pendingJobs, []);
    assert.deepEqual(events, [
        'fetch-job-done-stale',
        'reload',
        'fetch-job-done-fresh',
        'apply-job-done-fresh',
        'ack-job-done',
        'success',
        'save-fresh',
    ]);
});

test('runPendingJobSync 遇到仍在运行的任务时不重新加载也不保存聊天', async () => {
    const events = [];
    const context = {
        chatId: 'chat-1',
        groupId: null,
        async reloadCurrentChat() {
            events.push('reload');
        },
        async saveMetadata() {
            events.push('save');
        },
    };
    const currentState = {
        version: 'current',
        pendingJobs: [{ id: 'job-running', createdAt: '2026-06-12T00:00:00.000Z', mainApi: 'openai' }],
    };

    const result = await runPendingJobSync(createNoopDependencies({
        getContext: () => context,
        getChatState: () => currentState,
        async fetchJob(jobId) {
            events.push(`fetch-${jobId}`);
            return { id: jobId, status: 'running' };
        },
    }));

    assert.equal(result.status, 'unchanged');
    assert.deepEqual(events, ['fetch-job-running']);
});
