/** Minimal Result type for flows that should not throw across UI boundaries. */

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Wrap a promise into a Result, never throwing. */
export async function attempt<T, E = Error>(p: Promise<T>): Promise<Result<T, E>> {
  try {
    return ok(await p);
  } catch (e) {
    return err(e as E);
  }
}
