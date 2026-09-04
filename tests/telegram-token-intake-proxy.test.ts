import assert from "node:assert/strict";
import test from "node:test";
import {
  channelBrokerTelegramIntakePath,
  rewriteTelegramTokenIntakePath,
  telegramTokenIntakePath,
} from "../apps/web/telegram-intake-path.mjs";

test("the Web proxy maps Telegram credential intake to the broker public route", () => {
  assert.equal(telegramTokenIntakePath, "/api/channel-intake/v1/telegram");
  assert.equal(channelBrokerTelegramIntakePath, "/public/v1/telegram/intake");
  assert.equal(
    rewriteTelegramTokenIntakePath(telegramTokenIntakePath),
    channelBrokerTelegramIntakePath,
  );
  assert.equal(
    rewriteTelegramTokenIntakePath(`${telegramTokenIntakePath}?request=credential`),
    `${channelBrokerTelegramIntakePath}?request=credential`,
  );
});

test("the Telegram intake rewrite leaves unrelated paths unchanged", () => {
  assert.equal(
    rewriteTelegramTokenIntakePath("/api/channel-intake/v1/unexpected"),
    "/api/channel-intake/v1/unexpected",
  );
});
