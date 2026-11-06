Share one agent with someone through a browser link. A **Share** pill on each agent's composer creates a one-off public link. The guest opens it in any browser, with no Paseo app or account. They watch the conversation live and, if you allow it, send prompts to the agent.

The guest page is a static site on GitHub Pages, and the conversation travels through the Paseo relay, the same service the Paseo app uses for remote access. Nothing needs installing or configuring. The conversation is end-to-end encrypted between your daemon and the guest's browser: the key and an access secret travel in the link's `#fragment`, which browsers never send to any server, so the relay forwards only ciphertext and the page's host never sees the conversation.

## What guests see and can do

Guests get the last 200 timeline rows and live updates in a chat view: prompts, replies with formatted Markdown and highlighted code, reasoning, task lists, and a card per tool call. They also see when the agent is waiting for you to approve a tool call, but not what it asked for.

| Tool                             | Guests see                                                 | Never sent                                                  |
| -------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| Shell commands                   | Command, directory, exit code                              | Output                                                      |
| File reads                       | Path and line range                                        | Contents                                                    |
| File edits and writes            | Path; the diff only with **Include code changes** on       | Diffs of `.env` files, keys, and other secret-looking files |
| Searches                         | Query, match counts, matching file names, web result links | Matched content                                             |
| Web fetches                      | URL, status, size                                          | Page content                                                |
| Subagents, plans, worktree setup | Description, plan text, branch and setup commands          | Setup logs                                                  |
| MCP and other tools              | Name only                                                  | Inputs and outputs                                          |

Paths inside the agent's directory are shown relative to it, and your home directory as `~`. Before anything is sent, recognizable secrets are replaced with `[redacted]`: API tokens, private keys, credentials in URLs, authorization headers, and literal values assigned to names like `password` or `api_key`. This is best effort. A secret the agent quotes in its own reply, or one in an unusual format, can still reach guests, and a secret split across two streamed chunks of a reply is not caught.

- With **Let guests send prompts** on, guests can prompt the agent. A prompt can make the agent run commands on your machine, so only enable it for people you trust that far.
- Guest prompts reach the agent labelled as coming from a guest ("Guest 1", "Guest 2", numbered per connection), with a note that the guest is not the session's owner. Your own prompts are not labelled. Guests see who sent each prompt. In Paseo, a guest prompt appears with its label text, because the app does not recognize the label.
- A guest prompt sent while the agent is working joins the running turn instead of interrupting it. Providers that cannot do this (Claude, Codex, OpenCode, OMP, and Pi can) restart the turn with the prompt instead.
- Both switches are fixed for the life of a link. Stop the link and create a new one to change them.
- Up to 8 guests can join one link at a time.

## Limits

- Anyone holding the full link can join until you stop it. Stopping the link, the plugin, or the daemon disconnects every guest. After 20 failed join attempts the link stops itself.
- GitHub Pages serves the page's code, built from a tagged commit shown in the page's header. GitHub cannot read the conversation without changing that code, but a compromised or compelled host could.
- The relay sees connection metadata: when guests connect, their IP addresses, and traffic volume.
- Guests can join wherever both GitHub Pages and the Paseo relay are reachable.
