export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * The parsed JSON error body when there was one — some errors carry data
     * beyond the message (#143: the 409 "already applied" reply carries the
     * original created mapping so a retry can reconcile).
     */
    public body?: unknown,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    let body: unknown;
    try {
      body = await res.json();
      const error = (body as { error?: unknown } | null)?.error;
      if (typeof error === "string") message = error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message, body);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(url: string) => fetch(url).then((r) => handle<T>(r)),
  post: <T>(url: string, body?: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  put: <T>(url: string, body?: unknown) =>
    fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  patch: <T>(url: string, body: unknown) =>
    fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  delete: <T>(url: string) =>
    fetch(url, { method: "DELETE" }).then((r) => handle<T>(r)),
};
