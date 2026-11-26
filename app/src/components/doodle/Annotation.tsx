import type { ReactNode } from "react";
import { shortNote } from "./helpers";

/**
 * A short handwritten margin note (a few words such as "your draw" or "pick a side"), with its leader arrow passed
 * as `children` (after the text) and an optional `lead` mark pushed to the other end. It repeats what the section already says, so it is decorative: hidden from assistive technology
 * and never clickable. The hand face is only for this; disclosures and instructions use the body face.
 */
export function Annotation({ text, lead, children }: { text: string; lead?: ReactNode; children?: ReactNode }) {
  return (
    <div className="note-row" aria-hidden="true">
      {lead}
      <span className="note-hand">{shortNote(text)}</span>
      {children}
    </div>
  );
}
