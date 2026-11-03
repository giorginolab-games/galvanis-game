import "./styles.css";
import * as Matter from "matter-js";
import { GalvanisGame } from "./game/Game";

const game = new GalvanisGame();

game.start();

if (import.meta.env.DEV) {
  // Dev-only handle for poking at the game from the console or automated tests.
  Object.assign(window, { __galvanis: game, __matter: Matter });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.destroy();
  });
}
