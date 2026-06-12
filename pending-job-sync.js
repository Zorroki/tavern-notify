function getPendingJobs(state) {
    return Array.isArray(state?.pendingJobs) ? [...state.pendingJobs] : [];
}

function isSingleChatContext(context) {
    return Boolean(context?.chatId) && !context.groupId;
}

function isTerminalJob(job) {
    return !job || job.status === 'completed' || job.status === 'failed';
}

async function fetchPendingJobResults(pendingJobs, fetchJob, warn) {
    const results = [];

    for (const pendingJob of pendingJobs) {
        try {
            results.push({
                pendingJob,
                job: await fetchJob(pendingJob.id),
                error: null,
            });
        } catch (error) {
            warn(error);
            results.push({
                pendingJob,
                job: null,
                error,
            });
        }
    }

    return results;
}

function hasTerminalResult(results) {
    return results.some(result => !result.error && isTerminalJob(result.job));
}

export async function runPendingJobSync({
    getContext,
    getChatState,
    fetchJob,
    applyCompletedJob,
    acknowledgeJob,
    notifySuccess,
    notifyError,
    logDebug = () => {},
    warn = () => {},
} = {}) {
    const initialContext = getContext();
    if (!isSingleChatContext(initialContext)) {
        return { status: 'skipped' };
    }

    const initialPendingJobs = getPendingJobs(getChatState(false));
    if (initialPendingJobs.length === 0) {
        return { status: 'skipped' };
    }

    logDebug('Syncing pending jobs.', {
        count: initialPendingJobs.length,
    });

    const initialResults = await fetchPendingJobResults(initialPendingJobs, fetchJob, warn);
    if (!hasTerminalResult(initialResults)) {
        return { status: 'unchanged' };
    }

    if (typeof initialContext.reloadCurrentChat !== 'function') {
        warn(new Error('reloadCurrentChat is unavailable; pending job sync was skipped to avoid saving stale chat.'));
        return { status: 'skipped' };
    }

    const chatId = initialContext.chatId;
    await initialContext.reloadCurrentChat();

    const freshContext = getContext();
    if (!isSingleChatContext(freshContext) || freshContext.chatId !== chatId) {
        return { status: 'skipped' };
    }

    const freshState = getChatState(false);
    const freshPendingJobs = getPendingJobs(freshState);
    if (freshPendingJobs.length === 0) {
        return { status: 'unchanged' };
    }

    const freshResults = await fetchPendingJobResults(freshPendingJobs, fetchJob, warn);
    const remainingJobs = [];
    let changed = false;

    for (const { pendingJob, job, error } of freshResults) {
        if (error) {
            remainingJobs.push(pendingJob);
            continue;
        }

        if (!job) {
            changed = true;
            continue;
        }

        if (job.status === 'completed') {
            await applyCompletedJob(job);
            await acknowledgeJob(job.id);
            notifySuccess('后台回复已同步回当前聊天。', '酒馆后台通知');
            logDebug('Pending job completed and synced.', {
                jobId: job.id,
            });
            changed = true;
            continue;
        }

        if (job.status === 'failed') {
            const message = job.error?.message || '后台生成失败。';
            notifyError(message, '酒馆后台通知');
            await acknowledgeJob(job.id);
            logDebug('Pending job failed.', {
                jobId: job.id,
                message,
            });
            changed = true;
            continue;
        }

        remainingJobs.push(pendingJob);
    }

    if (!changed) {
        return { status: 'unchanged' };
    }

    const latestState = getChatState(false);
    if (!latestState) {
        return { status: 'skipped' };
    }

    latestState.pendingJobs = remainingJobs;
    await getContext().saveMetadata();

    return { status: 'synced' };
}
