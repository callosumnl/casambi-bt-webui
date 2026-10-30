import { randomInt } from "crypto";

/** Setup codes HomeKit refuses: all one digit, and the two obvious sequences. */
const DISALLOWED_PINCODES = new Set([...Array.from({ length: 10 }, (_, digit) => String(digit).repeat(8)), "12345678", "87654321"]);
const SETUP_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A random HomeKit setup code in its `123-45-678` form. */
export function generatePincode(random: (max: number) => number = randomInt): string {
  let digits = "";
  do { digits = Array.from({ length: 8 }, () => String(random(10))).join(""); } while (DISALLOWED_PINCODES.has(digits));
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

export function isValidPincode(pincode: string): boolean {
  return /^\d{3}-\d{2}-\d{3}$/.test(pincode) && !DISALLOWED_PINCODES.has(pincode.replace(/-/g, ""));
}

/**
 * The bridge's HAP device id, which looks like a MAC address. Controllers remember pairings by it, so a new one
 * makes the bridge a new accessory in Apple Home.
 */
export function generateUsername(random: (max: number) => number = randomInt): string {
  return Array.from({ length: 6 }, () => random(256).toString(16).padStart(2, "0").toUpperCase()).join(":");
}

export function isValidUsername(username: string): boolean { return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(username); }

/** Four characters that the setup QR code carries, so an iPhone can match the code to the advertised bridge. */
export function generateSetupId(random: (max: number) => number = randomInt): string {
  return Array.from({ length: 4 }, () => SETUP_ID_ALPHABET[random(SETUP_ID_ALPHABET.length)]).join("");
}

export function isValidSetupId(setupId: string): boolean { return /^[0-9A-Z]{4}$/.test(setupId); }

/** Letters and digits, including accented Latin letters (À–ɏ). */
const ALNUM = "A-Za-z0-9À-ɏ";

/**
 * HomeKit names must start and end with a letter or digit and may contain letters, digits, spaces, apostrophes,
 * hyphens, commas, and periods in between. Anything else is dropped; an empty result falls back to `fallback`.
 */
export function sanitizeName(name: string, fallback: string): string {
  const trimEnd = new RegExp(`[^${ALNUM}]+$`);
  const cleaned = name.normalize("NFC").replace(new RegExp(`[^${ALNUM} '’,.-]`, "g"), " ").replace(/\s+/g, " ")
    .replace(new RegExp(`^[^${ALNUM}]+`), "").replace(trimEnd, "").slice(0, 64).replace(trimEnd, "");
  return cleaned || fallback;
}
