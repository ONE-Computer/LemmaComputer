export const formatOverviewMoney = (value, currency, { compact = false } = {}) => {
  if (value === null || value === undefined || !currency) return "—";
  const amount = Number(value ?? 0);
  const maximumFractionDigits = compact ? 1 : Math.abs(amount) > 0 && Math.abs(amount) < 0.01 ? 6 : 2;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits,
  }).format(amount);
};
