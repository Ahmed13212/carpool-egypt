import {
  assertTransition,
  BOOKING_STATUSES,
  canTransition,
  initialStatus,
  isSeatHolding,
  SEAT_HOLDING,
  statusAfterApproval,
} from '../../src/bookings/booking-state-machine';

describe('booking state machine', () => {
  it('terminal states have no outgoing transitions', () => {
    for (const s of ['rejected', 'cancelled', 'expired', 'completed', 'no_show'] as const) {
      for (const t of BOOKING_STATUSES) expect(canTransition(s, t)).toBe(false);
    }
  });
  it('allows the documented happy paths', () => {
    expect(canTransition('pending_approval', 'confirmed')).toBe(true);
    expect(canTransition('pending_approval', 'awaiting_payment')).toBe(true);
    expect(canTransition('awaiting_payment', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'completed')).toBe(true);
  });
  it('forbids skipping or reversing states', () => {
    expect(canTransition('confirmed', 'pending_approval')).toBe(false);
    expect(canTransition('confirmed', 'rejected')).toBe(false);
    expect(canTransition('awaiting_payment', 'pending_approval')).toBe(false);
  });
  it('assertTransition throws a 409 coded error', () => {
    expect.assertions(2);
    try {
      assertTransition('cancelled', 'confirmed');
    } catch (e: any) {
      expect(e.getStatus()).toBe(409);
      expect(e.code).toBe('invalid_booking_transition');
    }
  });
  it('seat-holding set is exactly the non-terminal active states', () => {
    expect([...SEAT_HOLDING].sort()).toEqual(['awaiting_payment', 'confirmed', 'pending_approval']);
    expect(isSeatHolding('cancelled')).toBe(false);
    expect(isSeatHolding('completed')).toBe(false);
  });
  it('chooses the initial status from booking mode and payments flag', () => {
    expect(initialStatus('approval', false)).toBe('pending_approval');
    expect(initialStatus('approval', true)).toBe('pending_approval');
    expect(initialStatus('instant', false)).toBe('confirmed');
    expect(initialStatus('instant', true)).toBe('awaiting_payment');
    expect(statusAfterApproval(false)).toBe('confirmed');
    expect(statusAfterApproval(true)).toBe('awaiting_payment');
  });
});
