// Replaced at build time by scripts/build-guest.mjs with the commit the page was built from.
declare const __GUEST_BUILD__: string | undefined;

export const GUEST_BUILD = typeof __GUEST_BUILD__ === "string" ? __GUEST_BUILD__ : "development";
