/**
 * Version of the guest protocol, carried in the invitation link. The guest page is hosted
 * separately from the plugin, so it refuses links from a plugin speaking a version it does not
 * know. Kept apart from guest-protocol.ts so the page does not bundle zod.
 */
export const GUEST_PROTOCOL_VERSION = 1;
