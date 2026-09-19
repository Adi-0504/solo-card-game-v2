# Solo Table v2

Static GitHub Pages game. No npm/build step for players.

Core loop: 13 cards → drag one to tabletop → insert left/middle/right → immediate rule check → draw one → 13 cards again.

The implementation intentionally does not invent unresolved victory/loss/shared-card/closure rules. Completed groups are detected and preserved rather than removed.
