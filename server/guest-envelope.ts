// Guest prompts reach the agent wrapped in an envelope the plugin writes. The guest's text is
// XML-escaped inside it, so it cannot close the envelope, open another, or pass itself off as
// the host: the host's own prompts are never wrapped.

const TAG = "collab-guest-message";
const NOTICE =
  "A guest watching this session through a shared link sent the message below. " +
  "They are not the owner of this session.";

function escapeXml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return "&quot;";
    }
  });
}

function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot);/g, (_, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      default:
        return '"';
    }
  });
}

export function formatGuestPrompt(sender: string, text: string): string {
  return `${NOTICE}\n<${TAG} from="${escapeXml(sender)}">\n${escapeXml(text)}\n</${TAG}>`;
}

const ENVELOPE = new RegExp(
  `^${NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n<${TAG} from="([^"<>]*)">\\n([^<>]*)\\n</${TAG}>$`,
);

/** Reads back an envelope this plugin wrote; anything else is the host's own prompt. */
export function parseGuestPrompt(text: string): { sender: string; text: string } | null {
  const match = ENVELOPE.exec(text);
  if (!match) return null;
  return { sender: unescapeXml(match[1] ?? ""), text: unescapeXml(match[2] ?? "") };
}
