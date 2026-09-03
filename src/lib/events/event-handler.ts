/**
 * Event Handler System
 *
 * Port of app/services/event_handler.rb. A registry mapping a webhook's
 * `resource.event` identifier — optionally namespaced by version — to the
 * function that handles it.
 *
 * The Rails version enqueued an ActiveJob (Solid Queue) and answered 202 before
 * doing the work. These handlers run inline in the route instead. Why:
 *
 *  - The work is a handful of database writes plus a few Fluid API calls, well
 *    inside Fluid's webhook timeout, and Fluid retries a non-2xx.
 *  - A standalone Next droplet on Cloud Run has no always-on worker, so a queue
 *    would mean standing up Solid Queue's replacement (a second service and a
 *    Redis) to defer a few hundred milliseconds of work.
 *  - Running inline means the response reflects the outcome, so a failed
 *    install surfaces as a retryable 500 rather than a 202 followed by silence.
 *
 * If a handler ever becomes slow, the escape hatch is Next's `after()` — ack
 * first, work in the background — as droplet-zonos-tax-and-duties does for its
 * non-lifecycle events. That is a per-event decision, not a global one.
 */

export type EventHandler = (payload: unknown) => Promise<void>;

const eventHandlers = new Map<string, EventHandler>();

function keyFor(eventType: string, version?: string): string {
  return version ? `${version}.${eventType}` : eventType;
}

export function registerHandler(
  eventType: string,
  handler: EventHandler,
  version?: string,
): void {
  eventHandlers.set(keyFor(eventType, version), handler);
}

export function hasHandler(eventType: string, version?: string): boolean {
  return (
    eventHandlers.has(keyFor(eventType, version)) ||
    eventHandlers.has(eventType)
  );
}

/**
 * Routes an event to its handler.
 *
 * Returns false when no handler is registered — the caller answers 204 in that
 * case, as Rails did. A handler that throws propagates: the route records the
 * failure and answers 500 so Fluid retries.
 */
export async function routeEvent(
  eventType: string,
  payload: unknown,
  version?: string,
): Promise<boolean> {
  const key = keyFor(eventType, version);
  const handler = eventHandlers.get(key) ?? eventHandlers.get(eventType);

  if (!handler) {
    console.warn(`[EventHandler] No handler found for event type: ${key}`);
    return false;
  }

  await handler(payload);
  console.log(`[EventHandler] Successfully handled event: ${key}`);
  return true;
}

export function getRegisteredEvents(): string[] {
  return Array.from(eventHandlers.keys());
}

/** Test seam. Not used by the app. */
export function resetHandlers(): void {
  eventHandlers.clear();
}
