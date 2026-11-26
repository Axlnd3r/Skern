import { HOUSE_AGENTS, HOUSE_HEADING, HOUSE_LABEL, HOUSE_NOTE, NO_ENDORSEMENT, US_NOTICE } from "@/lib/disclaimer";

/** Always-visible US-user notice and disclaimer. */
export function UsNotice() {
  return (
    <aside className="notice" role="note" aria-label="Disclaimer">
      <strong className="notice-lead">Notice.</strong> <span>{US_NOTICE}</span>
      <br />
      <span>{NO_ENDORSEMENT}</span>
    </aside>
  );
}

/** House agents are labeled and never presented as organic users. */
export function HouseAgents() {
  return (
    <section className="card house">
      <h2>{HOUSE_HEADING}</h2>
      <p className="muted">{HOUSE_NOTE}</p>
      <ul className="agents">
        {HOUSE_AGENTS.map((name) => (
          <li key={name}>
            {name} <span className="tag">{HOUSE_LABEL}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
