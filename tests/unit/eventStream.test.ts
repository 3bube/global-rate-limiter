import type Redis from 'ioredis';
import { EventStreamRecorder, USAGE_STREAM_KEY } from '../../src/logging/eventStream';

describe('EventStreamRecorder', () => {
  it('caps the stream with MAXLEN so a dead worker cannot grow Redis unbounded', () => {
    const xadd = jest.fn().mockResolvedValue('1-1');
    const recorder = new EventStreamRecorder({ xadd } as unknown as Redis, 5000);

    recorder.record({ clientId: 'client-a', allowed: true, checkLatencyMs: 1.5, timestamp: 123 });

    expect(xadd).toHaveBeenCalledWith(
      USAGE_STREAM_KEY,
      'MAXLEN', '~', 5000,
      '*',
      'clientId', 'client-a',
      'allowed', '1',
      'checkLatencyMs', '1.5',
      'timestamp', '123',
    );
  });

  it('swallows XADD failures instead of surfacing them to the request path', async () => {
    const xadd = jest.fn().mockRejectedValue(new Error('redis down'));
    const recorder = new EventStreamRecorder({ xadd } as unknown as Redis);

    expect(() =>
      recorder.record({ clientId: 'client-a', allowed: false, checkLatencyMs: 2, timestamp: 456 }),
    ).not.toThrow();

    // Let the rejected promise settle; an unhandled rejection would fail the test.
    await new Promise((resolve) => setImmediate(resolve));
    expect(xadd).toHaveBeenCalledTimes(1);
  });
});
