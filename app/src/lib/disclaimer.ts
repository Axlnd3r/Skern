/** Mandatory notices shown on every screen (README section 11 and the hackathon rules). */
export const US_NOTICE =
  "Testnet demo, points only. No real money is used and nothing here can be traded for money. " +
  "This is not available for trading by US users. Not investment advice and not an offer of securities.";

export const NO_ENDORSEMENT =
  "Independent project. It claims no rights in any underlying company and is not endorsed by Base, " +
  "any partner or any issuer. Participants must be 18 or older.";

/**
 * House agents are operated by the project and must never look like organic users.
 * This is a static list of the project's own agents, NOT data read from the chain for a round, so
 * it must not be worded as per-round data. Once agents are identified on-chain they must be matched
 * by a known address list, never by `metadataURI`.
 */
export const HOUSE_HEADING = "House agents (operated by the project)";
export const HOUSE_NOTE =
  "The project runs these agents. They are labeled and are not organic users. This list is static and does not show who entered a given round.";
export const HOUSE_AGENTS = ["Momentum", "Mean Reversion", "News LLM"] as const;
export const HOUSE_LABEL = "house";
