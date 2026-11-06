import { createRoot } from "react-dom/client";
import { App } from "./app";
import { useGuestSession } from "./session";
import { readInvitation } from "./timeline";

// Read once: the invitation identifies this page's session for its whole lifetime.
const invitation = readInvitation(location.hash);

function Root() {
  const { state, sendPrompt } = useGuestSession(invitation);
  return <App state={state} sendPrompt={sendPrompt} />;
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");
createRoot(container).render(<Root />);
