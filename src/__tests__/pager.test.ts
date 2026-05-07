import { withPager } from '../utils/pager';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

const mockedSpawn = spawn as MockedFunction<typeof spawn>;

// Helper: generate lines via process.stdout.write (not console.log, which Jest intercepts)
function writeLines(count: number): void {
  for (let i = 0; i < count; i++) {
    process.stdout.write(`line ${i}\n`);
  }
}

describe('withPager', () => {
  const originalWrite = process.stdout.write;
  const originalIsTTY = process.stdout.isTTY;
  const originalRows = process.stdout.rows;

  afterEach(() => {
    process.stdout.write = originalWrite;
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true });
    delete process.env.RVR_PAGER;
    delete process.env.PAGER;
    vi.clearAllMocks();
  });

  it('writes short output directly without spawning a pager', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });

    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    await withPager(() => {
      process.stdout.write('line 1\n');
      process.stdout.write('line 2\n');
    });

    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(written.join('')).toContain('line 1');
    expect(written.join('')).toContain('line 2');
  });

  it('spawns a pager when output exceeds terminal height', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 10, configurable: true });

    const stdinStream = new EventEmitter() as EventEmitter & { end: Mock };
    stdinStream.end = vi.fn();

    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdinStream };
    child.stdin = stdinStream;

    mockedSpawn.mockReturnValue(child as any);

    const promise = withPager(() => writeLines(20));

    // Yield microtask so withPager gets past `await fn()` and spawns the pager
    await Promise.resolve();

    // Simulate pager closing
    child.emit('close', 0);

    await promise;

    expect(mockedSpawn).toHaveBeenCalledWith('less', ['-FRX'], {
      stdio: ['pipe', process.stdout, process.stderr],
    });
    expect(stdinStream.end).toHaveBeenCalled();
    const writtenBuffer = stdinStream.end.mock.calls[0][0] as string;
    expect(writtenBuffer).toContain('line 0');
    expect(writtenBuffer).toContain('line 19');
  });

  it('skips paging entirely when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    await withPager(() => writeLines(100));

    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(written.join('')).toContain('line 0');
    expect(written.join('')).toContain('line 99');
  });

  it('respects RVR_PAGER env var', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 5, configurable: true });
    process.env.RVR_PAGER = 'more -s';

    const stdinStream = new EventEmitter() as EventEmitter & { end: Mock };
    stdinStream.end = vi.fn();

    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdinStream };
    child.stdin = stdinStream;

    mockedSpawn.mockReturnValue(child as any);

    const promise = withPager(() => writeLines(20));

    await Promise.resolve();
    child.emit('close', 0);
    await promise;

    expect(mockedSpawn).toHaveBeenCalledWith('more', ['-s'], expect.any(Object));
  });

  it('respects PAGER env var when RVR_PAGER is not set', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 5, configurable: true });
    process.env.PAGER = 'bat --paging=always';

    const stdinStream = new EventEmitter() as EventEmitter & { end: Mock };
    stdinStream.end = vi.fn();

    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdinStream };
    child.stdin = stdinStream;

    mockedSpawn.mockReturnValue(child as any);

    const promise = withPager(() => writeLines(20));

    await Promise.resolve();
    child.emit('close', 0);
    await promise;

    expect(mockedSpawn).toHaveBeenCalledWith('bat', ['--paging=always'], expect.any(Object));
  });

  it('falls back to direct output when pager spawn fails', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 5, configurable: true });

    const written: string[] = [];
    // We need to let withPager's monkey-patch work, then capture the fallback output.
    // Replace write BEFORE withPager so it saves our mock as "original", and the
    // fallback write goes through our mock.
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    const stdinStream = new EventEmitter() as EventEmitter & { end: Mock };
    stdinStream.end = vi.fn();

    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdinStream };
    child.stdin = stdinStream;

    mockedSpawn.mockReturnValue(child as any);

    const promise = withPager(() => writeLines(20));

    // Yield microtask so withPager gets past `await fn()` and spawns the pager
    await Promise.resolve();

    // Simulate pager not found
    child.emit('error', new Error('ENOENT'));
    await promise;

    expect(written.join('')).toContain('line 0');
    expect(written.join('')).toContain('line 19');
  });

  it('restores stdout.write even if fn throws', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const writeBefore = process.stdout.write;

    await expect(withPager(() => {
      throw new Error('test error');
    })).rejects.toThrow('test error');

    expect(process.stdout.write).toBe(writeBefore);
  });
});
