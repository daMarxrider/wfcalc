# 01 · Setup / Result panes

Gold and glass, as today. Every tab has the same shape:

- **Page title** with a one-line purpose.
- **Setup** (left): numbered steps in the order you decide things; rarely used options sit in
  collapsible cards that show a summary of their value.
- **Result** (right): a sticky run bar (what will run + the one button), then key numbers, tables
  and mod cards.
- **Shared context** in the header: the weapon, target and mods from Build, which every other tab uses.

Files

- `index.html`: all seven tabs, switch with the tab bar.
- `find-options.html`: every state of the Find tab. The bar at the top switches the method
  (Quick / Brute force / Parts) and the result (Done / Running / Nothing found / Error). Controls that
  only appear in some cases carry a dashed tag saying when.
- `*.png`: screenshots at 1440 px.

Not covered: Build's Incarnon, modular parts, sniper zoom fields and drag to reorder. The Stop button,
progress counters, one-click fixes and the "Did you mean" error are ideas, not current behaviour.
