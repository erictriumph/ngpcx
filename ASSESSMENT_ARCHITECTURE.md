# CheckMyARM Assessment Architecture

> This document describes the intended long-term assessment architecture for CheckMyARM.
>
> It represents the architectural direction of the product rather than the current implementation. Implementation may evolve incrementally toward this model.

---

# Purpose

The purpose of CheckMyARM is not simply to generate a recommendation.

Its purpose is to reduce the stress of uncertainty surrounding a Windows on ARM purchase by progressively understanding the user's desired computing environment and determining how well that environment is supported.

Every step of the assessment should reduce uncertainty while simplifying the work required in the next step.

---

# Core Design Principles

## Reduce the Stress of Uncertainty

Every screen should:

- establish what is already known
- clearly identify what remains uncertain
- provide an obvious next step to reduce that uncertainty

The product should never exaggerate confidence.

---

## One Question Per Workspace

Each workspace exists to answer one primary question.

If a workspace attempts to answer multiple fundamentally different questions, it should probably be divided.

---

## Progressive Reduction

The assessment is intentionally structured as a funnel.

Each stage reduces uncertainty while reducing the workload of the stage that follows.

Users should never be asked to solve the entire problem at once.

---

## Assisted, Not Automated

CheckMyARM assists decision making.

It should make intelligent suggestions whenever possible without pretending certainty.

The user remains the final authority.

---

## Early Value

Useful recommendations should appear as early as possible.

Confidence should increase naturally as additional evidence is collected.

The assessment should never require perfection before delivering value.

---

# Assessment Philosophy

The assessment progressively narrows a large problem into a small one.

```
Everything we know
        ↓
Observed Environment
        ↓
Likely User Needs
        ↓
Things That Actually Matter
        ↓
Compatibility Knowledge
        ↓
Confidence
        ↓
Suitability Recommendation
```

Each stage exists primarily to simplify the next stage.

---

# Major Phases

## Assessment

Purpose:

Discover and understand the user's desired computing environment.

Assessment contains two workspaces.

### Observed Environment

Primary Question

> What did we observe?

Responsibilities

- Run scanner
- Display discovered applications
- Display discovered devices
- Categorize discovered items
- Allow category corrections
- Capture observations

This workspace is intentionally objective.

Its purpose is observation and classification, not determining importance.

---

### Understanding

Primary Question

> What does the user likely need?

Responsibilities

- Gather intended workloads
- Gather priorities
- Gather replacement vs augmentation intent
- Gather mobility requirements
- Infer likely important software and hardware

The goal is to simplify later curation.

---

## Curation

Purpose

Determine what actually matters for this assessment.

Curation contains two workspaces.

### Applications

Primary Question

> Which software actually matters?

Responsibilities

- Display categorized applications
- Allow inclusion/exclusion
- Allow priority
- Allow manual additions
- Allow notes

Compatibility is intentionally excluded from this workspace.

---

### Devices

Primary Question

> Which hardware actually matters?

Responsibilities

- Display categorized devices
- Allow inclusion/exclusion
- Allow priority
- Allow manual additions
- Allow notes

Again, this workspace is about importance, not compatibility.

---

## Compatibility

Primary Question

> Will these important things work?
>
> How well?
>
> Native or emulated?

Purpose

Evaluate compatibility only for curated applications and devices.

Responsibilities

- Display only important items
- Surface unknown compatibility
- Surface known compatibility
- Collect additional research
- Incorporate community evidence
- Reduce remaining uncertainty

Compatibility becomes the primary driver of Suitability.

---

# Confidence

Confidence answers:

> How completely do we understand the desired computing environment and its compatibility?

Confidence is not earned by completing steps.

Confidence reflects trustworthy evidence.

Examples

Early Scan

- Low confidence
- Early recommendation possible

Scan + Understanding

- Better targeting
- Better confidence

Completed Curation

- Strong understanding of desired environment

Completed Compatibility

- High confidence recommendation

---

# Suitability

Suitability answers one question.

> Is Windows on ARM a good fit?

Suitability depends primarily on compatibility information for the software and hardware that actually matter.

Without compatibility information, no meaningful suitability recommendation can be made.

---

# Workspace Relationships

Observed Environment helps Understanding.

Understanding helps Applications and Devices.

Applications and Devices simplify Compatibility.

Compatibility determines Suitability.

Each workspace exists to reduce the work required by the next.

---

# Long-Term Vision

As compatibility knowledge grows:

- more compatibility becomes immediately known
- fewer items require research
- recommendations arrive earlier
- confidence increases faster
- user effort decreases

The workflow remains the same.

The amount of work required continues to shrink.
