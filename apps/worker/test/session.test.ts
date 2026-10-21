import { describe, expect, it } from 'vitest';
import { sessionPhase, shouldRun } from '../src/session';

const ist = (hhmm: string, date = '2026-10-21') => Date.parse(`${date}T${hhmm}:00+05:30`);

describe('session clock', () => {
  it('maps times to NSE phases (post-Aug-2026 closing auction)', () => {
    expect(sessionPhase(ist('08:59'))).toBe('closed');
    expect(sessionPhase(ist('09:05'))).toBe('pre_open');
    expect(sessionPhase(ist('09:15'))).toBe('open');
    expect(sessionPhase(ist('15:14'))).toBe('open');
    expect(sessionPhase(ist('15:15'))).toBe('closing_auction');
    expect(sessionPhase(ist('15:34'))).toBe('closing_auction');
    expect(sessionPhase(ist('15:36'))).toBe('fo_only');
    expect(sessionPhase(ist('15:40'))).toBe('closed');
  });

  it('weekends are closed and the worker idles', () => {
    expect(sessionPhase(ist('11:00', '2026-10-24'))).toBe('closed'); // Saturday
    expect(shouldRun(ist('11:00', '2026-10-25'))).toBe(false); // Sunday
  });

  it('worker runs from 08:45 to 15:50 on weekdays', () => {
    expect(shouldRun(ist('08:44'))).toBe(false);
    expect(shouldRun(ist('08:45'))).toBe(true);
    expect(shouldRun(ist('15:49'))).toBe(true);
    expect(shouldRun(ist('15:50'))).toBe(false);
  });
});
