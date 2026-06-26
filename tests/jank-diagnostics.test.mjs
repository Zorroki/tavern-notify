import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createJankDiagnosticsRecorder,
    formatJankDiagnosticReport,
} from '../jank-diagnostics.js';

test('createJankDiagnosticsRecorder 汇总长任务、长帧和上下文快照', () => {
    let now = 1000;
    const recorder = createJankDiagnosticsRecorder({
        nowFn: () => now,
        frameJankThresholdMs: 34,
    });

    recorder.start();
    recorder.recordFrame(1016);
    recorder.recordFrame(1033);
    recorder.recordFrame(1090);
    recorder.recordLongTask({
        name: 'self',
        startTime: 1040,
        duration: 76.4,
    });
    recorder.recordContext({
        messageCount: 42,
        pendingJobCount: 2,
        scrollHeight: 5000,
        clientHeight: 720,
    });
    now = 1200;
    recorder.stop();

    const summary = recorder.getSummary();

    assert.equal(summary.running, false);
    assert.equal(summary.durationMs, 200);
    assert.equal(summary.frameIntervalCount, 2);
    assert.equal(summary.longFrameCount, 1);
    assert.equal(summary.maxFrameIntervalMs, 57);
    assert.equal(summary.longTaskCount, 1);
    assert.equal(summary.maxLongTaskDurationMs, 76.4);
    assert.deepEqual(summary.latestContext, {
        messageCount: 42,
        pendingJobCount: 2,
        scrollHeight: 5000,
        clientHeight: 720,
    });
});

test('formatJankDiagnosticReport 输出可复制的诊断摘要', () => {
    const recorder = createJankDiagnosticsRecorder({
        nowFn: () => 2000,
    });

    recorder.start();
    recorder.recordLongTask({
        name: 'script',
        startTime: 1010,
        duration: 88,
    });
    recorder.recordScroll({
        scrollTop: 360,
        scrollHeight: 2400,
        clientHeight: 700,
    });
    recorder.recordContext({
        messageCount: 18,
        pendingJobCount: 0,
    });

    const report = formatJankDiagnosticReport(recorder.getSummary(), {
        generatedAt: '2026-06-26T12:00:00.000Z',
        environment: {
            userAgent: 'UnitTest',
            viewport: '1280x720',
        },
    });

    assert.match(report, /Tavern Notify 卡顿诊断报告/);
    assert.match(report, /长任务次数: 1/);
    assert.match(report, /最大长任务: 88ms/);
    assert.match(report, /消息数量: 18/);
    assert.match(report, /pending job 数量: 0/);
    assert.match(report, /scrollTop: 360/);
    assert.match(report, /User-Agent: UnitTest/);
});
