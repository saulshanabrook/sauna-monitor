# Linked chart cursor offset

- **Status:** Fixed and deployed to production as Worker version `4196a311-6d01-4c61-a5d3-c4227d11bd16` after visual approval.
- **Smallest repro:** Load the dashboard at a 390 px viewport and hover the first chart.
- **Probe:** Compare the canvas backing width, displayed width, cursor x-coordinate, and rendered rule position.
- **Environment:** Chrome, local Wrangler remote preview at `http://localhost:8792/`.
- **Expected:** The vertical rule renders at the hovered x-coordinate, subject only to nearest-timestamp snapping.
- **Observed:** Vega creates a 528 px canvas that CSS displays at 366 px. The rule is displaced left by the same `366 / 528` scale factor.
- **Alternative hypothesis:** Five-minute nearest-point selection creates the offset. This predicts stepwise rather than proportional displacement and does not explain the canvas scale ratio.
- **Cause:** `max-width: 100%` changed the canvas layout width, hiding the scale from Vega's pointer-coordinate normalization.
- **Fix:** Preserve the canvas layout dimensions and fit it with a CSS transform, then ask the Vega view to resize before refitting whenever its container width changes.
- **Verification:** At a 390 px viewport, the 528 px canvas renders at 366 px with a detectable `0.693182` transform; a cursor at x=220 renders the linked rule at approximately x=220. A live 1440 px -> 390 px -> 1440 px resize updates the native canvas from 1177 px -> 528 px -> 1177 px and keeps the displayed canvas equal to its container at every step. The preview console has no warnings or errors.
- **Regression:** The frontend test now exercises both mobile-to-desktop and desktop-to-mobile resizing through the mocked Vega view in addition to rejecting the old `max-width` CSS.
