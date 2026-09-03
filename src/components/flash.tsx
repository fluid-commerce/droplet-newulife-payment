/**
 * Flash message.
 *
 * Rails put these in the session; here the page that redirects puts `notice` or
 * `alert` in the query string, which survives a redirect without needing a
 * session write.
 */
export function Flash({
  notice,
  alert,
}: {
  notice?: string;
  alert?: string;
}) {
  if (!notice && !alert) return null;

  return (
    <div className="flex flex-col gap-2 pb-4">
      {notice ? <span className="text-green-600">{notice}</span> : null}
      {alert ? <span className="text-red-600">{alert}</span> : null}
    </div>
  );
}
