// A tiny async mutex. The keeper account has one nonce sequence: the round loop (openRound, freezeAll,
// postCandles) and the reveal relay both send from it, so every send goes through one shared lock.
export class Mutex {
  // Never rejects (see `run`), so chaining with a single `then` is enough.
  private tail: Promise<void> = Promise.resolve();

  /** Runs `fn` after every earlier `run` has finished (fulfilled or rejected). A rejection does not poison the lock. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
