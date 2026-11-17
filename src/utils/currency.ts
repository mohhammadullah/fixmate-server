
// Currency minor-unit handling. Stripe expects amounts in the smallest
// currency unit (cents for USD, paisa for BDT). Most currencies use 2
// decimals; a documented set of zero- and three-decimal currencies exists.
// Amounts anywhere else in the app (booking.finalAmount, DTO output) are in
// major units.

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  "bhd",
  "jod",
  "kwd",
  "omr",
  "tnd",
]);

export const minorUnitExponent = (currency: string): number => {
  const normalized = currency.trim().toLowerCase();

  if (ZERO_DECIMAL_CURRENCIES.has(normalized)) {
    return 0;
  }

  if (THREE_DECIMAL_CURRENCIES.has(normalized)) {
    return 3;
  }

  return 2;
};

export const toMinorUnits = (amount: number, currency: string): number =>
  Math.round(amount * 10 ** minorUnitExponent(currency));

export const fromMinorUnits = (amountMinor: number, currency: string): number =>
  amountMinor / 10 ** minorUnitExponent(currency);
