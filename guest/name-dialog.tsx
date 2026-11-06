import { type FormEvent, useState } from "react";
import { MAX_GUEST_NAME_LENGTH } from "../shared/guest-name";

/** Asks a guest who joins for the name the agent and the other guests will see. */
export function NameDialog({
  defaultName,
  onSubmit,
}: {
  defaultName: string;
  onSubmit(name: string): void;
}) {
  const [name, setName] = useState(defaultName);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(name.trim() || defaultName);
  }
  return (
    <div className="dialog-backdrop">
      <form className="dialog" onSubmit={submit} aria-labelledby="name-title">
        <div id="name-title" className="dialog-title">
          What should others call you?
        </div>
        <div className="dialog-hint">
          Your name labels the prompts you send, for the agent and everyone on this link.
        </div>
        <input
          className="dialog-input"
          value={name}
          maxLength={MAX_GUEST_NAME_LENGTH}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.currentTarget.value)}
          aria-label="Your name"
        />
        <button className="dialog-button" type="submit">
          Join
        </button>
      </form>
    </div>
  );
}
