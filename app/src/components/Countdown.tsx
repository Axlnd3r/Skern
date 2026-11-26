/**
 * The big number of the current phase. The inner span is keyed by the text, so every new value mounts a new node and
 * the CSS "tick" plays once per change (transform only, so nothing around it moves). A value that stays the same
 * ("Final", "Void") keeps its node and does not animate again.
 */
export function Countdown({ text }: { text: string }) {
  return (
    <p className="countdown" aria-label="Time left in this phase">
      <span key={text} className="tick">
        {text}
      </span>
    </p>
  );
}
