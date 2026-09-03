/**
 * Shared types.
 */

/**
 * `events.status`, an ActiveRecord enum stored as an integer.
 *
 * Rails: `enum :status, { pending: 0, processed: 1, failed: 2 }, default: :pending`
 */
export const EVENT_STATUS = {
  pending: 0,
  processed: 1,
  failed: 2,
} as const;

export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];

/**
 * A `Company` row flattened for the UI or for JSON.
 *
 * BigInt does not survive `JSON.stringify`, and React refuses to render it, so
 * ids cross that boundary as strings.
 */
export interface CompanySummary {
  id: string;
  name: string;
  fluidShop: string;
  fluidCompanyId: string;
  active: boolean;
  dropletInstallationUuid: string | null;
}
