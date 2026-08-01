import assert from "node:assert/strict";
import test from "node:test";
import { formatOverviewMoney } from "../apps/web/src/format-money.js";

test("AI control plane spend formatting preserves sub-cent values", () => {
  assert.equal(formatOverviewMoney("0.000222", "USD"), "$0.000222");
  assert.equal(formatOverviewMoney("0", "USD"), "$0.00");
  assert.equal(formatOverviewMoney("173.75", "USD"), "$173.75");
});
