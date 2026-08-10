/**
 * Test helpers for bun:test + Prisma compatibility.
 */

/**
 * Assert that an async function rejects. Works around bun:test's
 * rejects.toThrow() not always handling Prisma promise rejections correctly.
 */
export async function expectReject<T>(
  fn: () => Promise<T>,
  errorClass?: new (...args: any[]) => Error,
): Promise<void> {
  let error: unknown = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  if (!error) {
    throw new Error("Expected function to reject, but it resolved successfully");
  }
  if (errorClass && !(error instanceof errorClass)) {
    throw new Error(`Expected ${errorClass.name}, got ${error.constructor.name}: ${(error as Error).message}`);
  }
}
