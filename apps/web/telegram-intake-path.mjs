export const telegramTokenIntakePath = "/api/channel-intake/v1/telegram";
export const channelBrokerTelegramIntakePath = "/public/v1/telegram/intake";

export const rewriteTelegramTokenIntakePath = (path) => {
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  if (pathname !== telegramTokenIntakePath) return path;
  return `${channelBrokerTelegramIntakePath}${queryIndex === -1 ? "" : path.slice(queryIndex)}`;
};
