import { randomInt, randomUUID } from "crypto";

/** Setup passcodes the Matter specification forbids: all one digit, and the two obvious sequences. */
const FORBIDDEN_PASSCODES = new Set([...Array.from({ length: 10 }, (_, digit) => Number(String(digit).repeat(8))), 12345678, 87654321]);

/** A random Matter setup passcode (1–99999998, 27 bits), never a forbidden one. */
export function generatePasscode(random: (min: number, max: number) => number = randomInt): number {
  let passcode = 0;
  do { passcode = random(1, 99999999); } while (FORBIDDEN_PASSCODES.has(passcode));
  return passcode;
}

export function isValidPasscode(passcode: number): boolean {
  return Number.isInteger(passcode) && passcode >= 1 && passcode <= 99999998 && !FORBIDDEN_PASSCODES.has(passcode);
}

/** The 12-bit discriminator a controller uses to find this bridge among commissionable devices. */
export function generateDiscriminator(random: (min: number, max: number) => number = randomInt): number { return random(0, 4096); }
export function isValidDiscriminator(discriminator: number): boolean { return Number.isInteger(discriminator) && discriminator >= 0 && discriminator <= 4095; }

/** The matter.js node id; it names the node's storage, so a new one is a new bridge to every controller. */
export function generateNodeId(): string { return `casambi-${randomUUID()}`; }
export function isValidNodeId(id: string): boolean { return /^casambi-[0-9a-f-]{36}$/.test(id); }

/** Matter labels are at most 32 characters; whitespace is collapsed and an empty name falls back. */
export function matterLabel(name: string, fallback: string): string {
  return (name.trim().replace(/\s+/g, " ") || fallback).slice(0, 32).trim();
}

/** Who a fabric belongs to, by its root vendor id; Google Home is the one this bridge is for. */
const VENDORS: Record<number, string> = { 0x6006: "Google Home", 0x1349: "Apple Home", 0x1217: "Amazon Alexa", 0x110a: "SmartThings" };
export function fabricOwner(vendorId: number, label: string): string {
  return VENDORS[vendorId] ?? (label || `Vendor 0x${vendorId.toString(16).toUpperCase().padStart(4, "0")}`);
}
