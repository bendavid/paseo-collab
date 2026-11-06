Share one agent with someone through a browser link. A **Collab** pill on each agent's composer creates a one-off public link. The guest opens it in any browser, with no Paseo app or account. They watch the conversation live and, if you allow it, send prompts to the agent.

The guest page is a static site on GitHub Pages, and the conversation travels through the Paseo relay, the same service the Paseo app uses for remote access. Nothing needs installing or configuring. The conversation is end-to-end encrypted between your daemon and the guest's browser: the key and an access secret travel in the link's `#fragment`, which browsers never send to any server, so the relay forwards only ciphertext and the page's host never sees the conversation.

## What guests see and can do

Guests get the whole conversation from its start, then live updates, in a chat view: prompts, replies with formatted Markdown and highlighted code, reasoning, task lists, and a card per tool call. They also see when the agent is waiting for you to approve a tool call, but not what it asked for.

Tool cards carry everything the timeline records: commands and their output, file contents the agent reads, diffs of the changes it makes, search matches, fetched web pages, and the inputs and outputs of MCP and other tools. Nothing is filtered or redacted, including secret files such as `.env` and any credentials that appear in output, so share a link only with people who may see all of it. Paths inside the agent's directory are shown relative to it, and your home directory as `~`. A field longer than 1 MiB is cut to fit the relay's message size; command output keeps its end.

- With **Let guests send prompts** on, guests can prompt the agent. A prompt can make the agent run commands on your machine, so only enable it for people you trust that far.
- When guests join, they are asked for a name, prefilled with "Guest 1", "Guest 2", and so on. Names are unique on a link (a repeated name gets a number), "Host" and "You" are reserved, and a guest who reconnects in the same browser tab keeps their name. Names are chosen by the guests themselves, so they identify, not authenticate.
- Guest prompts reach the agent labelled with the guest's name, with a note that the guest is not the session's owner. Your own prompts are not labelled. Guests see who sent each prompt. In Paseo, a guest prompt appears with its label text, because the app does not recognize the label.
- A guest prompt sent while the agent is working joins the running turn instead of interrupting it. Providers that cannot do this (Claude, Codex, OpenCode, OMP, and Pi can) restart the turn with the prompt instead.
- The prompt switch is fixed for the life of a link. Stop the link and create a new one to change it.
- Everyone on the link sees who is connected. In Paseo, the **Collab** pill turns into a green badge while a link is live and shows how many guests are connected (for example "Collab · 2"); its popover lists them by name.
- Up to 8 guests can join one link at a time.

## Limits

- Anyone holding the full link can join until you stop it. Stopping the link, the plugin, or the daemon disconnects every guest. After 20 failed join attempts the link stops itself.
- GitHub Pages serves the page's code, built from a tagged commit shown in the page's header. GitHub cannot read the conversation without changing that code, but a compromised or compelled host could.
- The relay sees connection metadata: when guests connect, their IP addresses, and traffic volume.
- Guests can join wherever both GitHub Pages and the Paseo relay are reachable.
