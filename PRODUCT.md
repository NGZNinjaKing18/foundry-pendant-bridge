# Product

## Register

product

## Users

A solo DM and their players using Foundry VTT (dnd5e). The DM also runs the companion
pendant-home (RealmScreen) desktop app; the players only have Foundry. The visible surface
is the **Anti-Hammer Space** inventory panel injected into the actor sheet's Inventory tab
(player-facing) plus a read-only DM cockpit in the app. Users are mid-session or prepping:
equipping gear on a body paperdoll and packing a finite hex "bag," under time pressure at the
table. They are fluent in Foundry's own dark UI.

## Product Purpose

A finite slot/overflow inventory ("anti-hammerspace"): items have shapes and cost spaces, the
body has labelled equip slots, and carrying more than fits creates overflow. Success = the panel
disappears into the task — a player can see what's equipped, what fits where, and pack/equip fast
without reading a manual, and it looks like it belongs in Foundry rather than bolted on.

## Brand Personality

Three words: **grounded, tactile, legible.** A craftsman's tool, not a toy. It lives inside a
dark fantasy VTT, so it reads as forged/leather-and-ink dark UI — but restraint first: clarity of
state always beats decoration. Character shows in a few earned moments (primary actions, valid
drop feedback), never as texture-for-texture's-sake.

## Anti-references

- SaaS-cream / light dashboards — wrong environment; it must sit on Foundry's dark sheet.
- Over-decorated "gamer" UI: neon glows everywhere, gradient text, glassmorphism, faux-metal
  bevels. Gloss without legibility.
- Generic Bootstrap/Material card grids. Identical boxes with icon+label repeated.
- A washed-out monochrome of near-identical grays (the current drift) where nothing reads.

## Design Principles

- **State over decoration.** Every colour earns its place by signalling a state (action, valid,
  success, danger, storage), never as ornament.
- **Earned familiarity.** Standard affordances (buttons, chips, inputs, drag) behave the way a
  Foundry user expects; surprise is reserved for delight moments, not core flows.
- **One vocabulary.** A single token system drives every surface, border, ink shade, and accent
  so nothing drifts; the same chip/slot/button reads the same everywhere.
- **Legible under pressure.** Mid-combat readability is the bar: real contrast, clear hierarchy,
  no decorative low-contrast gray.
- **Native, then characterful.** Belong in Foundry's dark sheet first; add presence second.

## Accessibility & Inclusion

- Body/label text ≥ 4.5:1 contrast on its surface; state colours distinguishable by more than hue
  (icon/label/shape), since the system already pairs colour with text tags.
- Every interactive element has visible focus (`:focus-visible` ring), plus hover/active/disabled.
- Respect `prefers-reduced-motion`: state transitions degrade to instant.
