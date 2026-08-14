import { assert } from "chai";
import { mapWithConcurrency } from "../src/modules/asyncPool";

describe("async concurrency pool", function () {
  it("limits active work while preserving result order", async function () {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return value * 2;
      },
    );

    assert.deepEqual(results, [2, 4, 6, 8, 10]);
    assert.equal(maximumActive, 2);
  });

  it("rejects invalid concurrency limits", async function () {
    let error: unknown;
    try {
      await mapWithConcurrency([1], 0, async (value) => value);
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
  });
});
