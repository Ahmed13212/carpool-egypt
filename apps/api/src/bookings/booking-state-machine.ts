import { AppError } from '../common/app-error';

export const BOOKING_STATUSES = [
  'pending_approval',
  'awaiting_payment',
  'confirmed',
  'rejected',
  'cancelled',
  'expired',
  'completed',
  'no_show',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Statuses that hold seats in trip_segments. Leaving this set must release the seats. */
export const SEAT_HOLDING: readonly BookingStatus[] = ['pending_approval', 'awaiting_payment', 'confirmed'];
export const isSeatHolding = (s: BookingStatus) => SEAT_HOLDING.includes(s);

/**
 * Booking lifecycle. Payment/refund outcomes are deliberately NOT booking statuses: they will live in
 * separate payments/refunds tables (not implemented yet). `awaiting_payment` only occurs when the
 * `payments_enabled` platform setting is true.
 */
const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  pending_approval: ['awaiting_payment', 'confirmed', 'rejected', 'cancelled', 'expired'],
  awaiting_payment: ['confirmed', 'cancelled', 'expired'],
  confirmed: ['cancelled', 'completed', 'no_show'],
  rejected: [],
  cancelled: [],
  expired: [],
  completed: [],
  no_show: [],
};

export const canTransition = (from: BookingStatus, to: BookingStatus) => TRANSITIONS[from].includes(to);

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, 'invalid_booking_transition', `Booking cannot move from ${from} to ${to}`);
  }
}

/** Status for a brand-new booking. Instant trips skip driver approval; payments (if enabled) come first. */
export function initialStatus(bookingMode: 'instant' | 'approval', paymentsEnabled: boolean): BookingStatus {
  if (bookingMode === 'approval') return 'pending_approval';
  return paymentsEnabled ? 'awaiting_payment' : 'confirmed';
}

/** Status after the driver approves a pending_approval booking. */
export const statusAfterApproval = (paymentsEnabled: boolean): BookingStatus =>
  paymentsEnabled ? 'awaiting_payment' : 'confirmed';
