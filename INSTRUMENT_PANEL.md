# CheckMyARM Instrument Panel

## Purpose

The CheckMyARM Instrument Panel presents the current assessment state and provides controls to operate the assessment.

It should feel like the control panel of professional equipment rather than a conventional website dashboard.

The Instrument Panel remains visually and spatially stable. The workspace beneath it changes.

This document is the source of truth for the Instrument Panel's design decisions. It records agreed decisions, not exploratory discussion.

---

## Core Mental Model

- The Instrument Panel reports and controls.
- The workspace investigates and gathers evidence.
- Actions perform work.
- View selectors change what the workspace displays.
- The assessment remains the artifact.
- The experience should reduce the stress of uncertainty.

---

## Overall Architecture

The page has two major regions:

1. A persistent Instrument Panel at the top.
2. A large, interchangeable workspace beneath it.

The Instrument Panel contains:

- Left panel: actions
- Center panel: confidence and evidence instrumentation
- Right panel: suitability instrumentation
- Bottom row: workspace view selectors

The workspace beneath the Instrument Panel contains the data and interaction surface for the currently selected view.

The workspace must not duplicate the view selectors.

---

## Left Panel: Actions

### Purpose

The left panel contains controls that perform work or change assessment state.

### Typical contents

- Review Findings
- Dynamic next-step actions such as Verify Acrobat
- Add or refine Use Case
- Load assessment
- Save assessment
- Export or report actions
- Scanner control

### Rules

- Do not place workspace navigation here.
- Dynamic recommended actions may use the existing monospaced visual language.
- Utility actions may use a calmer, more permanent button style.
- The panel should remain relatively narrow.
- The Scanner control belongs at the bottom of this panel as a permanent control/status combination.

---

## Scanner Control

The Scanner control is both a status indicator and an available action.

The left side of the control always reads:

`Scanner`

The right side changes based on state and includes an LED plus action/status text.

Examples:

- Inactive / no scan: `○ SCAN NOW`
- Running: `● RUNNING...`
- Completed: green LED + `RESCAN`

### Rules

- The control remains in a consistent position at the bottom of the left panel.
- The green completed state communicates that scan evidence is present.
- Clicking the available action should perform the appropriate scanner operation.
- Do not duplicate scanner status elsewhere unless layout constraints later require it.

---

## Center Panel: Confidence and Evidence

### Purpose

The center panel shows how much evidence supports the current recommendation.

It contains:

- Confidence gauge
- Evidence-source meters

### Confidence Gauge

The confidence gauge should resemble a traditional analog instrument.

Requirements:

- Use a continuous or visually continuous colored arc.
- Do not construct the main gauge arc from separate LED blocks.
- The portion of the arc behind the needle should appear brightly illuminated.
- The remaining portion should remain visibly present but dim.
- The needle is the primary positional indicator.
- The qualitative confidence label and numeric percentage remain visible.
- The gauge should provide four mutually reinforcing indicators:
  - needle position
  - illuminated arc extent
  - qualitative label
  - numeric percentage

### Evidence Meters

Evidence meters remain horizontal segmented meters.

Requirements:

- Preserve the segmented LED-like visual language.
- Give each evidence row slightly more vertical separation.
- Do not compress the rows into ordinary progress bars.
- Each row should read as a distinct instrument.
- Labels and current evidence status remain directly associated with each meter.

---

## Right Panel: ARM Suitability

### Purpose

The right panel presents the current suitability recommendation.

It contains:

- Vertical suitability meter
- Suitability category labels
- Current recommendation text

### Rules

- Preserve the vertical segmented meter.
- Category labels should wrap naturally where needed.
- Multi-word labels should not be forced into overly wide single lines.
- The current recommendation should be visually centered and balanced.
- `Probably a Good Fit` should wrap to two lines when that improves alignment.
- The panel should remain compact but not cramped.

---

## Bottom Row: Workspace View Selectors

### Purpose

The bottom row of the Instrument Panel selects which workspace is displayed immediately below it.

This row is part of the Instrument Panel, not part of the workspace.

### Required views

- Applications
- Devices
- Use Case
- Detected Apps
- Detected Devices
- Why
- Unknowns
- More Info

### Interaction model

These controls are illuminated latching pushbutton selectors.

Requirements:

- Exactly one selector is active at a time.
- The selected button appears physically pressed in.
- The selected button also illuminates.
- Selecting another button causes the previously selected button to pop back out.
- The interaction should resemble industrial, laboratory, avionics, or equipment-panel mode selectors.
- They are not ordinary links, tabs, or action buttons.
- Selecting a view changes only the workspace beneath the Instrument Panel.

### Visual rules

- Use a modest 3D pushbutton appearance.
- Inactive selectors should appear raised.
- The active selector should appear depressed and illuminated.
- Two-word labels should wrap to two lines where useful.
- Keep button widths compact and dashboard-like rather than stretching them into wide web buttons.
- Keep the row visually shallow so the Instrument Panel does not consume unnecessary vertical space.
- Preserve clear keyboard focus and accessible selected-state semantics.

---

## Workspace Beneath the Instrument Panel

### Purpose

The workspace displays and edits evidence for the selected view.

### Rules

- Remove the large workspace-selector buttons currently displayed above the workspace data.
- Do not repeat Applications, Devices, Use Case, Detected Apps, or Detected Devices as navigation tiles inside the workspace.
- Do not repeat Why, Unknowns, or More Info as a separate expandable strip inside the workspace.
- The selected view's content should begin immediately beneath the Instrument Panel.
- Interaction in the workspace should primarily involve evidence review, selection, confirmation, notes, overrides, and related assessment work.
- The workspace should occupy most of the vertical page below the Instrument Panel.

---

## Proportions and Responsiveness

This is a laptop- and desktop-first interface.

Primary target:

- Approximately 1000-1300 CSS pixels of available width
- Usable on smaller laptops
- Usable at 125-150% display scaling

Rules:

- Do not design exclusively for very wide desktop monitors.
- Do not optimize for phones in this iteration.
- Keep the Instrument Panel in a broad horizontal arrangement at practical laptop widths.
- Reflow deliberately at narrower widths rather than simply squeezing controls.
- The left action panel stays narrow.
- The center instrumentation receives most of the width.
- The suitability panel remains compact.
- The overall existing page width is sufficient; improve use of that width rather than making the page permanently wider.

---

## Visual Language

The interface should feel engineered rather than assembled.

Preferred references:

- professional lab equipment
- avionics software
- industrial control panels
- instrument clusters

Avoid:

- generic analytics dashboard styling
- ordinary Bootstrap-style tab rows
- oversized web navigation tiles
- decorative skeuomorphism such as fake screws or excessive chrome
- visual effects that compromise readability

The physical-control metaphor should communicate behavior:

- command buttons initiate actions
- latching pushbuttons select views
- instruments report state

---

## Frozen Decisions

### 2026-07-22

#### Instrument Panel terminology

Use `Instrument Panel` as the primary design term instead of `dashboard`.

#### Persistent panel and changing workspace

The Instrument Panel remains static while the workspace beneath it changes.

#### Left panel responsibility

The left panel is for actions, including the Scanner control.

#### Bottom row responsibility

The bottom row is for all workspace view selectors.

#### Selector behavior

View selectors are illuminated latching pushbuttons. Exactly one is active at a time.

#### Workspace responsibility

The lower workspace is for data and evidence interaction only. It does not contain duplicate navigation tiles.

#### Confidence gauge

The confidence gauge uses a continuous analog arc, with the completed portion brightly illuminated and the remainder dim.

#### Evidence meters

Evidence meters remain segmented, with slightly greater vertical spacing.

#### Suitability labels

Suitability labels may wrap, including `Probably a Good Fit`, to preserve balance and avoid excessive width.

#### Width strategy

The current overall width is sufficient. Improve proportions and breakpoint behavior rather than designing only for very wide monitors.

---

## Change Discipline

Future design discussion should not automatically alter this specification.

Update this file only when a decision has been explicitly accepted.

When a decision changes:

1. Update the relevant normative section.
2. Add a dated note under Frozen Decisions.
3. State whether the new decision supersedes an earlier one.
