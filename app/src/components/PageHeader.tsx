import { Star, Underline } from "./doodle";
import { WalletButton } from "./WalletButton";

/** Title mark (hand-drawn underline and a small star) and the wallet control, shared by every screen. */
export function PageHeader() {
  return (
    <header className="top">
      <h1 className="site-title">
        Consensus Path
        <Underline className="site-title-line" />
        <Star className="site-title-star" size={20} rotate={12} />
      </h1>
      <WalletButton />
    </header>
  );
}
