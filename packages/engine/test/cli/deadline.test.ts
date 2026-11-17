import { expect, test } from "vitest";
import { withDeadline } from "../../src/cli/deadline.ts";

test("work that never ends calls onLate once its time is up", async () => {
  const late = new Promise<string>((resolve) => {
    void withDeadline(
      () => new Promise<never>(() => undefined),
      10,
      () => resolve("late"),
    );
  });
  expect(await late).toBe("late");
});

test("work that ends in time gives its result, and onLate is never called", async () => {
  let lateCalls = 0;
  expect(
    await withDeadline(
      async () => 7,
      10,
      () => lateCalls++,
    ),
  ).toBe(7);
  await new Promise((r) => setTimeout(r, 30));
  expect(lateCalls).toBe(0);
});

test("work that fails in time passes its error on, and onLate is never called", async () => {
  let lateCalls = 0;
  const failing = () => Promise.reject(new Error("closing failed"));
  await expect(withDeadline(failing, 10, () => lateCalls++)).rejects.toThrow("closing failed");
  await new Promise((r) => setTimeout(r, 30));
  expect(lateCalls).toBe(0);
});
